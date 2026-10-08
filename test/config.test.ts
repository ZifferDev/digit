import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash, loadProject, parseManifest, validateName } from '../src/config';

const roots: string[] = [];
async function project(extra = '') {
  const root = await mkdtemp(join(tmpdir(), 'digit-config-'));
  roots.push(root);
  await Bun.write(
    join(root, 'digit.toml'),
    `name = "friends"\n[services.survival]\ntype = "paper"\n${extra}`,
  );
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const simple = () => ({ name: 'friends', services: { survival: { type: 'paper' } } });

describe('manifest validation', () => {
  test('standalone defaults are usable and explicit', () => {
    const manifest = parseManifest(simple());
    expect(manifest.schema).toBe(1);
    expect(manifest.network).toEqual({ bind: '127.0.0.1', port: 25565, motd: 'friends' });
    expect(manifest.services.survival).toMatchObject({
      version: 'latest',
      build: 'latest',
      channel: 'stable',
      memory: '2G',
      plugins: [],
    });
  });
  test('network topology uses known Paper destinations', () => {
    const services = {
      lobby: { type: 'paper' },
      survival: { type: 'paper' },
      proxy: { type: 'velocity', fallback: ['lobby'] },
    };
    expect(parseManifest({ name: 'friends', services }).services.proxy?.fallback).toEqual([
      'lobby',
    ]);
    expect(() =>
      parseManifest({
        name: 'friends',
        services: { ...services, proxy: { type: 'velocity', fallback: ['missing'] } },
      }),
    ).toThrow('not a Paper service');
    expect(() =>
      parseManifest({ name: 'friends', services: { ...services, proxy: { type: 'velocity' } } }),
    ).toThrow('choose an initial server');
    expect(() =>
      parseManifest({
        name: 'friends',
        services: { lobby: services.lobby, survival: services.survival },
      }),
    ).toThrow('require a Velocity proxy');
    expect(() =>
      parseManifest({ name: 'friends', services: { ...services, proxy2: { type: 'velocity' } } }),
    ).toThrow('one Velocity');
    expect(() =>
      parseManifest({ name: 'friends', services: { database: { type: 'mariadb' } } }),
    ).toThrow('at least one Paper');
  });
  test.each(['project', 'environment', 'service'])(
    'reserves interpolation namespace service %s',
    (name) => {
      expect(() =>
        parseManifest({ name: 'friends', services: { [name]: { type: 'paper' } } }),
      ).toThrow('reserved service name');
    },
  );
  test('reserves Velocity fallback key only for network backends', () => {
    expect(() =>
      parseManifest({
        name: 'friends',
        services: { try: { type: 'paper' }, proxy: { type: 'velocity' } },
      }),
    ).toThrow('reserved by Velocity');
    expect(
      parseManifest({ name: 'friends', services: { try: { type: 'paper' } } }).services.try?.type,
    ).toBe('paper');
  });
  test('one Paper fallback may be inferred', () => {
    expect(
      parseManifest({
        name: 'friends',
        services: { ...simple().services, proxy: { type: 'velocity' } },
      }).services.proxy?.fallback,
    ).toEqual(['survival']);
  });
  test.each(['../escape', 'A', '', 'bad.name', '__proto__', 'constructor', 'a'.repeat(41)])(
    'rejects unsafe name %s',
    (name) => {
      expect(() => validateName(name)).toThrow();
    },
  );
  test.each(['schema', 'service', 'network'])('rejects unknown fields in %s', (location) => {
    const raw: any = simple();
    if (location === 'schema') raw.scheam = 1;
    if (location === 'service') raw.services.survival.verison = 'latest';
    if (location === 'network') raw.network = { ports: 25565 };
    expect(() => parseManifest(raw)).toThrow('unknown field');
  });
  test('reports non-string versions and legacy Paper', () => {
    expect(() =>
      parseManifest({ name: 'friends', services: { survival: { type: 'paper', version: 26.3 } } }),
    ).toThrow('quote versions');
    expect(() =>
      parseManifest({
        name: 'friends',
        services: { survival: { type: 'paper', version: '1.18.2' } },
      }),
    ).toThrow('1.19 and newer');
  });
  test.each([
    'EULA',
    'TYPE',
    'VERSION',
    'PAPER_BUILD',
    'ONLINE_MODE',
    'SERVER_PORT',
    'SERVER_IP',
    'PATCH_DEFINITIONS',
    'PLUGINS',
    'MODRINTH_PROJECTS',
    'COPY_CONFIG_DEST',
    'REPLACE_ENV_VARIABLES',
    'RCON_PASSWORD',
    'VELOCIRCON__PASSWORD',
    'VELOCIRCON__HOST',
    'VELOCIRCON__ENABLE',
    'MEMORY',
    'SKIP_SERVER_PROPERTIES',
    'SERVER_PROPERTIES',
    'CUSTOM_SERVER_PROPERTIES',
    'ENABLE_QUERY',
    'SPIGET_RESOURCES',
    'MODS',
    'GENERIC_PACK',
    'BUNGEE_JAR_REVISION',
  ])('protects managed env %s', (key) => {
    expect(() =>
      parseManifest({
        name: 'friends',
        services: { survival: { type: 'paper', env: { [key]: 'override' } } },
      }),
    ).toThrow('managed by digit');
  });
  test.each(['online-mode', 'server-port', 'rcon.password', 'motd'])(
    'protects managed property %s',
    (key) => {
      expect(() =>
        parseManifest({
          name: 'friends',
          services: { survival: { type: 'paper', properties: { [key]: 'override' } } },
        }),
      ).toThrow('managed by digit');
    },
  );
  test('allows scalar server properties, rejects multiline injection', () => {
    expect(
      parseManifest({
        name: 'friends',
        services: {
          survival: {
            type: 'paper',
            properties: { difficulty: 'hard', 'max-players': 20, pvp: true },
          },
        },
      }).services.survival?.properties,
    ).toEqual({ difficulty: 'hard', 'max-players': 20, pvp: true });
    expect(() =>
      parseManifest({
        name: 'friends',
        services: {
          survival: { type: 'paper', properties: { difficulty: 'hard\nonline-mode=false' } },
        },
      }),
    ).toThrow('single line');
  });
  test('plugins must be declared and use Modrinth', () => {
    expect(() =>
      parseManifest({
        name: 'friends',
        services: { survival: { type: 'paper', plugins: ['missing'] } },
      }),
    ).toThrow('unknown plugin');
    expect(() =>
      parseManifest({ ...simple(), plugins: { test: { source: 'url', project: 'test' } } }),
    ).toThrow('only "modrinth"');
    expect(
      parseManifest({
        name: 'friends',
        plugins: { via: { source: 'modrinth', project: 'viaversion' } },
        services: { survival: { type: 'paper', plugins: ['via'] } },
      }).plugins.via?.version,
    ).toBe('latest');
  });
  test.each(['velocircon', 'KkmSfl3v'])(
    'rejects duplicate built-in Velocity RCON plugin %s',
    (project) => {
      expect(() =>
        parseManifest({
          name: 'friends',
          plugins: { console: { source: 'modrinth', project } },
          services: {
            proxy: { type: 'velocity', plugins: ['console'] },
            survival: { type: 'paper' },
          },
        }),
      ).toThrow('already provided by digit');
    },
  );
  test('network port and IP validation', () => {
    expect(() => parseManifest({ ...simple(), network: { bind: 'localhost' } })).toThrow(
      'IPv4 or IPv6',
    );
    expect(() => parseManifest({ ...simple(), network: { port: 65536 } })).toThrow('0 to 65535');
    expect(parseManifest({ ...simple(), network: { bind: '::1', port: 0 } }).network.port).toBe(0);
  });
});

describe('project environments', () => {
  test('optional named environment defaults to an isolated ephemeral port', async () => {
    const root = await project();
    expect((await loadProject(root)).manifest.network.port).toBe(25565);
    expect((await loadProject(root, { env: 'staging' })).manifest.network).toMatchObject({
      port: 0,
      bind: '127.0.0.1',
    });
    await expect(loadProject(root, { profile: 'missing' })).rejects.toThrow('does not exist');
  });
  test('profile merges config maps and permits reusable staging settings', async () => {
    const root = await project('[services.survival.properties]\ndifficulty = "hard"\npvp = true\n');
    await mkdir(join(root, 'environments'));
    await Bun.write(
      join(root, 'environments', 'staging.toml'),
      '[network]\nport = 25566\n[services.survival]\nmemory = "1G"\n[services.survival.properties]\npvp = false\n',
    );
    const result = await loadProject(root, { env: 'preview', profile: 'staging' });
    expect(result.manifest.network.port).toBe(25566);
    expect(result.manifest.services.survival?.memory).toBe('1G');
    expect(result.manifest.services.survival?.properties).toEqual({
      difficulty: 'hard',
      pvp: false,
    });
  });
  test('profiles cannot mutate dependencies or introduce services', async () => {
    const root = await project();
    await mkdir(join(root, 'environments'));
    const path = join(root, 'environments', 'staging.toml');
    await Bun.write(path, '[services.survival]\nversion = "1.21.11"');
    await expect(loadProject(root, { env: 'staging' })).rejects.toThrow('unknown field');
    await Bun.write(path, '[services.other]\nmemory = "1G"');
    await expect(loadProject(root, { env: 'staging' })).rejects.toThrow(
      'cannot introduce a service',
    );
    await Bun.write(path, '[services.survival.env]\nEULA = true');
    await expect(loadProject(root, { env: 'staging' })).rejects.toThrow('managed by digit');
  });
  test('rejects environment path traversal and external symlinks', async () => {
    const root = await project();
    const outside = await project();
    await mkdir(join(root, 'environments'));
    await symlink(join(outside, 'digit.toml'), join(root, 'environments', 'staging.toml'));
    await expect(loadProject(root, { env: '../oops' })).rejects.toThrow('lowercase');
    await expect(loadProject(root, { env: 'staging' })).rejects.toThrow('symlink escapes');
  });
  test('database survives profile normalization', async () => {
    const root = await project('[services.database]\ntype = "mariadb"\n');
    await mkdir(join(root, 'environments'));
    await Bun.write(join(root, 'environments', 'staging.toml'), '[network]\nport = 0\n');
    expect((await loadProject(root, { env: 'staging' })).manifest.services.database?.version).toBe(
      '11.8',
    );
  });
});

test('hash is stable for key order but sensitive to ordered values', () => {
  expect(hash({ a: 1, b: { c: true, d: [1, 2] } })).toBe(hash({ b: { d: [1, 2], c: true }, a: 1 }));
  expect(hash([1, 2])).not.toBe(hash([2, 1]));
  expect(hash('test')).toMatch(/^[a-f0-9]{64}$/);
});
