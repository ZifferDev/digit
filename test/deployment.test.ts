import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as yaml } from 'yaml';
import { parse as toml } from 'smol-toml';
import { parseManifest } from '../src/config';
import {
  collectFiles,
  environmentDirectory,
  interpolate,
  prepareDeployment,
  sourceFingerprint,
} from '../src/deployment';
import type { Lockfile, Project } from '../src/types';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(
  network = false,
  database = false,
): Promise<{ project: Project; lock: Lockfile }> {
  const root = await mkdtemp(join(tmpdir(), 'digit-deploy-'));
  roots.push(root);
  const services: Record<string, object> = { survival: { type: 'paper', version: '1.21.11' } };
  if (network) {
    services.lobby = { type: 'paper', version: '1.21.11' };
    services.proxy = { type: 'velocity', fallback: ['lobby'] };
  }
  if (database) services.database = { type: 'mariadb' };
  const manifest = parseManifest({ name: 'friends', services });
  const lock: Lockfile = {
    schema: 1,
    inputHash: 'test',
    services: Object.fromEntries(
      Object.entries(manifest.services).map(([name, service]) => [
        name,
        {
          type: service.type,
          version: service.version,
          build: service.type === 'velocity' ? 570 : 132,
          java: 21,
          channel: 'STABLE',
          image: `${service.type === 'mariadb' ? 'mariadb' : service.type === 'paper' ? 'itzg/minecraft-server' : 'itzg/mc-proxy'}@sha256:${'a'.repeat(64)}`,
          plugins: [],
        },
      ]),
    ),
  };
  return { project: { root, manifest }, lock };
}
async function put(project: Project, path: string, text: string) {
  await Bun.write(join(project.root, path), text);
}
async function compose(path: string) {
  return yaml(await Bun.file(path).text()) as any;
}

describe('configuration interpolation', () => {
  test('resolves declared references once and preserves escaped placeholders', () => {
    expect(
      interpolate('db=${database.url}; literal=$${other}; raw=${value}', {
        'database.url': 'mysql://db',
        value: '${untouched}',
      }),
    ).toBe('db=mysql://db; literal=${other}; raw=${untouched}');
    expect(() => interpolate('${missing}', {}, 'plugin.yml')).toThrow(
      "Unknown reference 'missing' in plugin.yml",
    );
  });
  test('rejects inherited object keys', () => {
    expect(() => interpolate('${constructor}', {})).toThrow('Unknown reference');
  });
});

describe('deployment bundles', () => {
  test('Minecraft consoles have interactive stdin and TTY, databases do not', async () => {
    const { project, lock } = await fixture(true, true);
    const cfg = await compose((await prepareDeployment(project, lock)).composeFile);
    for (const name of ['survival', 'lobby', 'proxy']) {
      expect(cfg.services[name].stdin_open).toBe(true);
      expect(cfg.services[name].tty).toBe(true);
    }
    expect(cfg.services.database.stdin_open).toBeUndefined();
    expect(cfg.services.database.tty).toBeUndefined();
  });
  test('default Paper omits empty custom properties that the image helper rejects', async () => {
    const { project, lock } = await fixture();
    const deployed = await prepareDeployment(project, lock);
    const cfg = await compose(deployed.composeFile);
    expect(cfg.services.survival.environment.CUSTOM_SERVER_PROPERTIES).toBeUndefined();
    expect(cfg.services.survival.environment.SKIP_SERVER_PROPERTIES).toBe('false');
  });
  test('RCON credentials are per service and environment, persistent, and never published', async () => {
    const { project, lock } = await fixture(true, true);
    const deployed = await prepareDeployment(project, lock);
    const cfg = await compose(deployed.composeFile);
    const passwords = ['survival', 'lobby', 'proxy'].map(
      (name) => cfg.services[name].environment.RCON_PASSWORD,
    );
    expect(new Set(passwords).size).toBe(3);
    for (const name of ['survival', 'lobby', 'proxy']) {
      const service = cfg.services[name];
      expect(service.environment.ENABLE_RCON).toBe('true');
      expect(service.environment.RCON_PORT).toBe('25575');
      expect(service.environment.RCON_PASSWORD).toMatch(/^[a-f0-9]{48}$/);
      expect((service.ports ?? []).some((port: { target: number }) => port.target === 25575)).toBe(
        false,
      );
      expect(service.labels).toEqual({
        'digit.environment': 'dev',
        'digit.service': name,
        'digit.config': deployed.fingerprint,
      });
    }
    expect(cfg.services.database.environment.RCON_PASSWORD).toBeUndefined();
    expect(cfg.services.database.labels['digit.service']).toBe('database');
    const paper = await Bun.file(
      join(deployed.directory, 'survival/config/server.properties'),
    ).text();
    expect(paper).toContain('enable-rcon=true');
    expect(paper).toContain(`rcon.password=${passwords[0]}`);
    const proxy = yaml(
      await Bun.file(join(deployed.directory, 'proxy/config/plugins/velocircon/rcon.yml')).text(),
    ) as any;
    expect(proxy).toMatchObject({
      enable: true,
      host: '127.0.0.1',
      port: 25575,
      password: passwords[2],
    });
    const again = await compose((await prepareDeployment(project, lock)).composeFile);
    expect(again.services.proxy.environment.RCON_PASSWORD).toBe(passwords[2]);
    const staging = await compose(
      (await prepareDeployment(project, lock, { env: 'staging' })).composeFile,
    );
    expect(staging.services.proxy.environment.RCON_PASSWORD).not.toBe(passwords[2]);
    expect(staging.services.proxy.labels['digit.environment']).toBe('staging');
  });
  test('image env options stay effective while explicit properties and managed wiring are authoritative', async () => {
    const { project, lock } = await fixture(true);
    project.manifest.services.survival!.env = {
      OPS: 'Alice,Bob_2',
      VIEW_DISTANCE: 12,
      DIFFICULTY: 'easy',
      TZ: 'UTC',
    };
    project.manifest.services.survival!.properties = { 'view-distance': 6, difficulty: 'hard' };
    await put(
      project,
      'services/survival/server.properties',
      'online-mode=true\nenable-rcon=false\nrcon.port=9999\nrcon.password=unsafe\n',
    );
    const deployed = await prepareDeployment(project, lock);
    const cfg = await compose(deployed.composeFile);
    const env = cfg.services.survival.environment;
    expect(env).toMatchObject({
      OPS: 'Alice,Bob_2',
      VIEW_DISTANCE: '12',
      DIFFICULTY: 'easy',
      TZ: 'UTC',
      SKIP_SERVER_PROPERTIES: 'false',
      ONLINE_MODE: 'false',
      ENABLE_RCON: 'true',
      RCON_PORT: '25575',
    });
    expect(env.CUSTOM_SERVER_PROPERTIES).toBe('view-distance=6\ndifficulty=hard');
    const properties = await Bun.file(
      join(deployed.directory, 'survival/config/server.properties'),
    ).text();
    expect(properties).toContain('view-distance=6');
    expect(properties).toContain('difficulty=hard');
    expect(properties).toContain('online-mode=false');
    expect(properties).not.toContain('unsafe');
    expect(properties).not.toContain('9999');
  });
  test('materialized JARs keep readable aliases and inventory tracks artifact replacements', async () => {
    const { project, lock } = await fixture();
    const cacheBefore = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = join(project.root, 'cache');
    const contents = 'verified-plugin-bytes';
    const sha256 = new Bun.CryptoHasher('sha256').update(contents).digest('hex');
    await Bun.write(join(process.env.XDG_CACHE_HOME, 'digit/artifacts', sha256), contents);
    const artifact = {
      project: 'abc123',
      version: 'v1',
      sha256,
      filename: 'upstream-obscure.jar',
      url: 'https://example.com/plugin.jar',
    };
    try {
      lock.services.survival!.plugins = [
        { ...artifact, name: 'friendly-plugin' },
        { ...artifact, project: 'dependency456' },
      ];
      const first = await prepareDeployment(project, lock);
      const filenames = (await readdir(join(first.directory, 'survival/plugins'))).sort();
      expect(filenames).toHaveLength(2);
      expect(filenames[0]).toMatch(/^digit-dependency456-[a-f0-9]{20}\.jar$/);
      expect(filenames[1]).toMatch(/^digit-friendly-plugin-[a-f0-9]{20}\.jar$/);
      for (const filename of filenames)
        expect(await Bun.file(join(first.directory, 'survival/plugins', filename)).text()).toBe(
          contents,
        );
      lock.services.survival!.plugins = [{ ...artifact, name: 'friendly-plugin', version: 'v2' }];
      const next = await prepareDeployment(project, lock);
      const inventory = await Bun.file(join(next.directory, 'survival/managed.txt')).text();
      for (const filename of filenames) expect(inventory).not.toContain(filename);
      expect(inventory).toContain('plugins/digit-friendly-plugin-');
      expect(next.directory).not.toBe(first.directory);
    } finally {
      if (cacheBefore === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = cacheBefore;
    }
  });
  test('standalone uses exact locked image, local binding and online authentication', async () => {
    const { project, lock } = await fixture();
    const result = await prepareDeployment(project, lock);
    const cfg = await compose(result.composeFile);
    expect(cfg.services.survival.image).toBe(lock.services.survival!.image);
    expect(cfg.services.survival.ports).toEqual([
      { target: 25565, published: '25565', host_ip: '127.0.0.1', protocol: 'tcp' },
    ]);
    expect(cfg.services.survival.environment.EULA).toContain('DIGIT_EULA');
    expect(cfg.services.survival.environment.PAPER_BUILD).toBe('132');
    expect(cfg.services.survival.environment.ONLINE_MODE).toBe('true');
    expect(cfg.services.survival.environment.SERVER_IP).toBe('');
    expect(
      await Bun.file(join(result.directory, 'survival/config/server.properties')).text(),
    ).toContain('online-mode=true');
    expect((await stat(result.composeFile)).mode & 0o777).toBe(0o600);
    expect(
      (await stat(join(project.root, '.digit/environments/dev/secrets.json'))).mode & 0o777,
    ).toBe(0o600);
  });
  test('network wiring shares secret only within environment and publishes proxy only', async () => {
    const { project, lock } = await fixture(true);
    const result = await prepareDeployment(project, lock);
    const cfg = await compose(result.composeFile);
    expect(cfg.services.survival.ports).toBeUndefined();
    expect(cfg.services.lobby.ports).toBeUndefined();
    expect(cfg.services.proxy.ports).toHaveLength(1);
    expect(cfg.services.survival.environment.ONLINE_MODE).toBe('false');
    const velocity = toml(
      await Bun.file(join(result.directory, 'proxy/config/velocity.toml')).text(),
    ) as any;
    expect(velocity['online-mode']).toBe(true);
    expect(velocity['player-info-forwarding-mode']).toBe('modern');
    expect(velocity['forced-hosts']).toEqual({});
    expect(velocity.servers).toEqual({
      lobby: 'lobby:25565',
      survival: 'survival:25565',
      try: ['lobby'],
    });
    const secret = await Bun.file(join(result.directory, 'proxy/config/forwarding.secret')).text();
    const paper = yaml(
      await Bun.file(join(result.directory, 'survival/config/config/paper-global.yml')).text(),
    ) as any;
    expect(paper.proxies.velocity).toEqual({ enabled: true, 'online-mode': true, secret });
    const second = await prepareDeployment(project, lock, { env: 'preview' });
    expect(second.projectName).not.toBe(result.projectName);
    expect(
      await Bun.file(join(second.directory, 'proxy/config/forwarding.secret')).text(),
    ).not.toBe(secret);
    const again = await prepareDeployment(project, lock);
    expect(again.directory).toBe(result.directory);
  });
  test('standalone disables forwarding retained in supplied Paper and Spigot configuration', async () => {
    const { project, lock } = await fixture();
    await put(
      project,
      'services/survival/config/paper-global.yml',
      'proxies:\n  velocity:\n    enabled: true\n    online-mode: false\n    secret: copied-from-a-network\n',
    );
    await put(
      project,
      'services/survival/spigot.yml',
      'settings:\n  bungeecord: true\n  sample-count: 8\n',
    );
    const deployment = await prepareDeployment(project, lock);
    const paper = yaml(
      await Bun.file(join(deployment.directory, 'survival/config/config/paper-global.yml')).text(),
    );
    const spigot = yaml(
      await Bun.file(join(deployment.directory, 'survival/config/spigot.yml')).text(),
    );
    expect(paper.proxies.velocity.enabled).toBe(false);
    expect(spigot.settings.bungeecord).toBe(false);
    expect(spigot.settings['sample-count']).toBe(8);
  });
  test('renaming a project preserves the existing Compose project and data namespace', async () => {
    const { project, lock } = await fixture();
    const original = await prepareDeployment(project, lock);
    project.manifest.name = 'renamed';
    const changed = await prepareDeployment(project, lock);
    expect(changed.projectName).toBe(original.projectName);
    expect(changed.fingerprint).not.toBe(original.fingerprint);
    expect((await compose(changed.composeFile)).name).toBe(original.projectName);
  });
  test('configuration is snapshotted; profile overlays replace complete files', async () => {
    const { project, lock } = await fixture();
    await put(project, 'services/survival/plugins/Example/config.yml', 'mode: common\n');
    await put(
      project,
      'environments/staging/services/survival/plugins/Example/config.yml',
      'mode: staging\n',
    );
    const original = await prepareDeployment(project, lock);
    const staging = await prepareDeployment(project, lock, { env: 'preview', profile: 'staging' });
    expect(
      await Bun.file(join(staging.directory, 'survival/config/plugins/Example/config.yml')).text(),
    ).toBe('mode: staging\n');
    await put(project, 'services/survival/plugins/Example/config.yml', 'mode: modified\n');
    const changed = await prepareDeployment(project, lock);
    expect(changed.fingerprint).not.toBe(original.fingerprint);
    expect(changed.directory).not.toBe(original.directory);
    expect(
      await Bun.file(join(original.directory, 'survival/config/plugins/Example/config.yml')).text(),
    ).toBe('mode: common\n');
  });
  test('database references materialize privately with per-environment credentials', async () => {
    const { project, lock } = await fixture(false, true);
    await put(
      project,
      'services/survival/plugins/Example/config.yml',
      'database_url: "${database.url}"\nhost: ${database.host}\nname: ${environment.name}\n',
    );
    const result = await prepareDeployment(project, lock);
    const cfg = await compose(result.composeFile);
    expect(cfg.services.database.ports).toBeUndefined();
    expect(cfg.services.survival.depends_on.database.condition).toBe('service_healthy');
    const secret = JSON.parse(
      await Bun.file(join(project.root, '.digit/environments/dev/secrets.json')).text(),
    )['database.password'];
    expect(
      await Bun.file(join(result.directory, 'survival/config/plugins/Example/config.yml')).text(),
    ).toContain(`mysql://minecraft:${secret}@database:3306/minecraft`);
    expect(await Bun.file(join(result.directory, 'database/database.env')).text()).toContain(
      `MARIADB_PASSWORD=${secret}`,
    );
    expect(await Bun.file(result.composeFile).text()).not.toContain(secret);
  });
  test('managed inventory contains only generated and declared files', async () => {
    const { project, lock } = await fixture();
    await put(project, 'services/survival/plugins/Example/config.yml', 'enabled: true\n');
    const result = await prepareDeployment(project, lock);
    const inventory = await Bun.file(join(result.directory, 'survival/managed.txt')).text();
    expect(inventory.split('\n').filter(Boolean)).toEqual([
      'config/paper-global.yml',
      'plugins/Example/config.yml',
      'server.properties',
      'spigot.yml',
    ]);
    const script = await Bun.file(join(result.directory, 'survival/bootstrap.sh')).text();
    expect(script).toContain('Refusing symlink');
    expect(script).toContain('grep -Fqx --');
    expect(script).not.toContain('rm -rf');
  });
  test('rejects runtime data, JARs, unknown references and symlink configurations', async () => {
    for (const path of ['world/level.dat', 'plugins/custom.jar', 'plugins/custom.JAR']) {
      const { project, lock } = await fixture();
      await put(project, `services/survival/${path}`, 'bad');
      await expect(prepareDeployment(project, lock)).rejects.toThrow('Runtime worlds and JARs');
    }
    const { project, lock } = await fixture();
    await put(project, 'services/survival/plugin.yml', '${database.missing}');
    await expect(prepareDeployment(project, lock)).rejects.toThrow('Unknown reference');
    const root = join(project.root, 'symlinks');
    await mkdir(root);
    await symlink(join(project.root, 'services'), join(root, 'escape'));
    await expect(collectFiles(root)).rejects.toThrow('symlinks');
  });
  test('rejects symlink source ancestors and invalid generated YAML sections', async () => {
    const { project, lock } = await fixture();
    const other = await fixture();
    await mkdir(join(other.project.root, 'survival'), { recursive: true });
    await Bun.write(join(other.project.root, 'survival/config.yml'), 'enabled: true');
    await symlink(other.project.root, join(project.root, 'services'));
    await expect(prepareDeployment(project, lock)).rejects.toThrow('symlink');
    const network = await fixture(true);
    await put(network.project, 'services/survival/config/paper-global.yml', 'proxies: true');
    await expect(prepareDeployment(network.project, network.lock)).rejects.toThrow();
  });
  test('escapes user environment dollars for Compose and preserves DB options', async () => {
    const { project, lock } = await fixture(false, true);
    project.manifest.services.survival!.env = { EXTRA_OPTION: '${HOST_SECRET}' };
    project.manifest.services.database!.env = { TZ: 'UTC' };
    const result = await prepareDeployment(project, lock);
    const cfg = await compose(result.composeFile);
    expect(cfg.services.survival.environment.EXTRA_OPTION).toBe('$${HOST_SECRET}');
    expect(cfg.services.database.environment.TZ).toBe('UTC');
  });
  test('refuses symlink local state roots', async () => {
    const { project } = await fixture();
    await symlink(tmpdir(), join(project.root, '.digit'));
    await expect(environmentDirectory(project.root)).rejects.toThrow('symbolic link');
  });
  test('file edits alter the plan fingerprint without generating secrets', async () => {
    const { project, lock } = await fixture();
    const original = await sourceFingerprint(project, lock);
    await put(project, 'services/survival/ops.json', '[]');
    expect(await sourceFingerprint(project, lock)).not.toBe(original);
    expect(
      await Bun.file(join(project.root, '.digit/environments/dev/secrets.json')).exists(),
    ).toBe(false);
  });
});
