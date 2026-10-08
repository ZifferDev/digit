import {
  mkdir,
  readFile,
  writeFile,
  rename,
  chmod,
  readdir,
  lstat,
  realpath,
  access,
} from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse as parseYaml, stringify as yaml } from 'yaml';
import { parse as parseToml, stringify as toml } from 'smol-toml';
import { hash, validateName } from './config';
import { fetchArtifact } from './resolve';
import { VERSION, RENDER_REVISION } from './version';
import type { Project, Lockfile, EnvironmentOptions, Deployment, Manifest } from './types';

export async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
export async function privateWrite(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, value, { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600);
}
export async function environmentDirectory(root: string, env = 'dev') {
  validateName(env);
  const path = join(root, '.digit', 'environments', env);
  // Do not follow a user-supplied .digit symlink into a different checkout.
  for (const candidate of [join(root, '.digit'), join(root, '.digit', 'environments'), path]) {
    if ((await exists(candidate)) && (await lstat(candidate)).isSymbolicLink())
      throw new Error(`Local state must not be a symbolic link: ${candidate}`);
  }
  return path;
}
export async function loadDeployment(root: string, env = 'dev'): Promise<Deployment> {
  const path = join(await environmentDirectory(resolve(root), env), 'deployment.json');
  if (!(await exists(path)))
    throw new Error(`Environment '${env}' has not been prepared. Run digit up --env ${env}.`);
  const value = JSON.parse(await readFile(path, 'utf8')) as Deployment;
  if (!value.composeFile || !value.projectName)
    throw new Error(`Invalid deployment state at ${path}.`);
  return value;
}

/** Files supplied by Git are copied into immutable releases, never mounted live. */
export async function collectFiles(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  if (!(await exists(root))) return files;
  async function walk(path: string) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Configuration symlinks are not supported: ${path}`);
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await walk(join(path, name));
    } else if (stat.isFile()) {
      const name = relative(root, path).split('\\').join('/');
      if (
        !name ||
        /[\r\n\0]/.test(name) ||
        name.startsWith('.digit') ||
        name.split('/').includes('..')
      )
        throw new Error(`Unsafe configuration path: ${name}`);
      files.set(name, await readFile(path));
    } else throw new Error(`Configuration must contain ordinary files: ${path}`);
  }
  await walk(root);
  return files;
}

export function interpolate(
  text: string,
  values: Record<string, string>,
  file = 'configuration',
): string {
  const escaped: string[] = [];
  text = text.replace(/\$\$\{([^}]+)\}/g, (_, key) => {
    escaped.push('${' + key + '}');
    return `\u0000${escaped.length - 1}\u0000`;
  });
  text = text.replace(/\$\{([^}]+)\}/g, (_, key) => {
    if (!Object.hasOwn(values, key))
      throw new Error(
        `Unknown reference '${key}' in ${file}. Use $\${${key}} for a literal placeholder.`,
      );
    return values[key]!;
  });
  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => escaped[Number(index)]!);
}

const textExtensions = /\.(ya?ml|toml|json|properties|conf|cfg|txt|ini)$/i;
async function projectFiles(projectRoot: string, path: string) {
  let current = projectRoot;
  for (const part of relative(projectRoot, path).split('/')) {
    current = join(current, part);
    if ((await exists(current)) && (await lstat(current)).isSymbolicLink())
      throw new Error(`Configuration symlinks are not supported: ${current}`);
  }
  return collectFiles(path);
}

export async function sourceFingerprint(
  project: Project,
  lock: Lockfile,
  options: EnvironmentOptions = {},
) {
  const content: Record<string, string> = {};
  for (const name of Object.keys(project.manifest.services).sort()) {
    for (const [path, data] of await projectFiles(
      project.root,
      join(project.root, 'services', name),
    ))
      content[`${name}/${path}`] = hash(data.toString('base64'));
    const profile = options.profile ?? options.env ?? 'dev';
    validateName(profile);
    for (const [path, data] of await projectFiles(
      project.root,
      join(project.root, 'environments', profile, 'services', name),
    ))
      content[`${profile}/${name}/${path}`] = hash(data.toString('base64'));
  }
  return hash({
    generator: VERSION,
    revision: RENDER_REVISION,
    manifest: project.manifest,
    lock,
    content,
  });
}

const bootstrap = `#!/bin/bash
set -euo pipefail
data="$1"; shift
mkdir -p "$data"
check_path() {
  case "$1" in ''|/*|../*|*/../*|*/..|.digit*) echo 'Invalid managed path' >&2; exit 1;; esac
  if [ "$(realpath -m "$data/$1")" != "$data/$1" ]; then echo "Refusing symlink in managed destination: $1" >&2; exit 1; fi
}
if [ -L "$data/.digit-managed" ]; then echo 'Refusing symlink ownership record' >&2; exit 1; fi
if [ -f "$data/.digit-managed" ]; then
  while IFS= read -r path; do
    check_path "$path"
    if ! grep -Fqx -- "$path" /digit/managed.txt; then
      if [ -f "$data/$path" ]; then rm -- "$data/$path"; fi
    fi
  done < "$data/.digit-managed"
fi
while IFS= read -r path; do check_path "$path"; done < /digit/managed.txt
cp /digit/managed.txt "$data/.digit-managed"
exec "$@"
`;

function properties(text: string, values: Record<string, string | number | boolean>) {
  const keys = new Set(Object.keys(values));
  const retained = text
    .split(/\r?\n/)
    .filter((line) => !keys.has(line.split(/[=: \t]/)[0] ?? ''))
    .join('\n');
  const escape = (v: string) =>
    v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  return `${retained}\n${Object.entries(values)
    .map(([k, v]) => `${k}=${escape(String(v))}`)
    .join('\n')}\n`;
}

export async function prepareDeployment(
  project: Project,
  lock: Lockfile,
  options: EnvironmentOptions = {},
): Promise<Deployment> {
  const { manifest, root } = project;
  validateName(options.profile ?? options.env ?? 'dev');
  const env = options.env ?? 'dev';
  const envDir = await environmentDirectory(root, env);
  await mkdir(envDir, { recursive: true, mode: 0o700 });
  await privateWrite(join(root, '.digit', '.gitignore'), '*\n');
  const idPath = join(root, '.digit', 'identity');
  if (!(await exists(idPath))) await privateWrite(idPath, randomBytes(6).toString('hex'));
  const identity = (await readFile(idPath, 'utf8')).trim();
  const metadataPath = join(envDir, 'deployment.json');
  const previous = (await exists(metadataPath))
    ? (JSON.parse(await readFile(metadataPath, 'utf8')) as Deployment)
    : undefined;
  const projectName = previous?.projectName ?? `digit-${manifest.name}-${identity}-${env}`;
  const secretsPath = join(envDir, 'secrets.json');
  let secrets: Record<string, string> = (await exists(secretsPath))
    ? JSON.parse(await readFile(secretsPath, 'utf8'))
    : {};
  for (const key of [
    'forwarding',
    ...Object.entries(manifest.services)
      .filter(([, service]) => service.type !== 'mariadb')
      .map(([name]) => `${name}.rcon`),
    ...Object.entries(manifest.services)
      .filter(([, s]) => s.type === 'mariadb')
      .flatMap(([n]) => [`${n}.password`, `${n}.root`]),
  ])
    secrets[key] ??= randomBytes(24).toString('hex');
  await privateWrite(secretsPath, JSON.stringify(secrets));
  const fingerprint = await sourceFingerprint(project, lock, options);
  const releaseId = hash({ fingerprint, secrets }).slice(0, 24);
  const directory = join(envDir, 'releases', releaseId);
  const composeFile = join(directory, 'compose.yaml');
  const entrypoint =
    Object.entries(manifest.services).find(([, s]) => s.type === 'velocity')?.[0] ??
    Object.entries(manifest.services).find(([, s]) => s.type === 'paper')![0];
  const deployment: Deployment = {
    directory,
    composeFile,
    projectName,
    environment: env,
    manifest,
    lock,
    fingerprint,
    entrypoint,
  };
  if (!(await exists(composeFile))) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const services: Record<string, any> = {};
    const volumes: Record<string, object> = {};
    const refs: Record<string, string> = { 'environment.name': env, 'project.name': manifest.name };
    for (const [name, service] of Object.entries(manifest.services)) {
      refs[`${name}.host`] = name;
      refs[`${name}.port`] = service.type === 'mariadb' ? '3306' : '25565';
      if (service.type === 'mariadb') {
        Object.assign(refs, {
          [`${name}.name`]: 'minecraft',
          [`${name}.username`]: 'minecraft',
          [`${name}.password`]: secrets[`${name}.password`]!,
          [`${name}.url`]: `mysql://minecraft:${secrets[`${name}.password`]}@${name}:3306/minecraft`,
          [`${name}.jdbc_url`]: `jdbc:mariadb://${name}:3306/minecraft`,
        });
      }
    }
    const proxy = Object.values(manifest.services).some((s) => s.type === 'velocity');
    for (const [name, service] of Object.entries(manifest.services)) {
      const locked = lock.services[name];
      if (!locked || locked.type !== service.type)
        throw new Error(`Lockfile missing service '${name}'. Run digit update.`);
      const dir = join(directory, name);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      volumes[`${name}-data`] = {};
      const common: any = {
        image: locked.image,
        restart: 'unless-stopped',
        stop_grace_period: '120s',
        volumes: [
          {
            type: 'volume',
            source: `${name}-data`,
            target:
              service.type === 'mariadb'
                ? '/var/lib/mysql'
                : service.type === 'paper'
                  ? '/data'
                  : '/server',
          },
        ],
        labels: {
          'digit.environment': env,
          'digit.service': name,
          'digit.config': fingerprint,
        },
        logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
      };
      if (service.type === 'mariadb') {
        await privateWrite(
          join(dir, 'database.env'),
          `MARIADB_DATABASE=minecraft\nMARIADB_USER=minecraft\nMARIADB_PASSWORD=${secrets[`${name}.password`]}\nMARIADB_ROOT_PASSWORD=${secrets[`${name}.root`]}\n`,
        );
        common.env_file = [`./${name}/database.env`];
        common.environment = Object.fromEntries(
          Object.entries(service.env).map(([k, v]) => [k, String(v)]),
        );
        common.healthcheck = {
          test: ['CMD', 'healthcheck.sh', '--connect', '--innodb_initialized'],
          interval: '5s',
          timeout: '5s',
          retries: 30,
          start_period: '30s',
        };
        services[name] = common;
        continue;
      }
      common.stdin_open = true;
      common.tty = true;
      const files = await projectFiles(root, join(root, 'services', name));
      for (const [p, data] of await projectFiles(
        root,
        join(root, 'environments', options.profile ?? env, 'services', name),
      ))
        files.set(p, data);
      for (const [path, data] of files) {
        if (
          ['world', 'world_nether', 'world_the_end'].includes(path.split('/')[0]!) ||
          /\.jar$/i.test(path)
        )
          throw new Error(
            `Runtime worlds and JARs do not belong in services/${name}/${path}. Declare plugins in digit.toml.`,
          );
        if (textExtensions.test(path))
          files.set(
            path,
            Buffer.from(
              interpolate(data.toString(), { ...refs, 'service.name': name }, `${name}/${path}`),
            ),
          );
      }
      if (service.type === 'paper') {
        files.set(
          'server.properties',
          Buffer.from(
            properties(files.get('server.properties')?.toString() ?? '', {
              motd: manifest.network.motd,
              ...service.properties,
              'server-port': 25565,
              'server-ip': '',
              'online-mode': !proxy,
              'enable-rcon': true,
              'rcon.port': 25575,
              'rcon.password': secrets[`${name}.rcon`]!,
              'enable-query': false,
            }),
          ),
        );
        const config = parseYaml(files.get('config/paper-global.yml')?.toString() ?? '{}') ?? {};
        if (typeof config !== 'object' || Array.isArray(config))
          throw new Error(`${name}/config/paper-global.yml must be a YAML mapping.`);
        config.proxies ??= {};
        if (typeof config.proxies !== 'object' || Array.isArray(config.proxies))
          throw new Error(`${name}/config/paper-global.yml proxies must be a mapping.`);
        config.proxies.velocity = {
          enabled: proxy,
          'online-mode': true,
          secret: secrets.forwarding,
        };
        files.set('config/paper-global.yml', Buffer.from(yaml(config)));
        const spigot = parseYaml(files.get('spigot.yml')?.toString() ?? '{}') ?? {};
        if (typeof spigot !== 'object' || Array.isArray(spigot))
          throw new Error(`${name}/spigot.yml must be a mapping.`);
        spigot.settings ??= {};
        if (typeof spigot.settings !== 'object' || Array.isArray(spigot.settings))
          throw new Error(`${name}/spigot.yml settings must be a mapping.`);
        spigot.settings.bungeecord = false;
        files.set('spigot.yml', Buffer.from(yaml(spigot)));
      } else {
        const config: any = parseToml(files.get('velocity.toml')?.toString() ?? '');
        Object.assign(config, {
          'config-version': '2.7',
          bind: '0.0.0.0:25565',
          motd: manifest.network.motd,
          'show-max-players': 100,
          'online-mode': true,
          'player-info-forwarding-mode': 'modern',
          'forwarding-secret-file': 'forwarding.secret',
          'ping-passthrough': 'DESCRIPTION',
        });
        config['forced-hosts'] ??= {};
        config.servers = Object.fromEntries(
          Object.entries(manifest.services)
            .filter(([, s]) => s.type === 'paper')
            .map(([n]) => [n, `${n}:25565`]),
        );
        config.servers.try = service.fallback ?? [Object.keys(config.servers)[0]];
        files.set('velocity.toml', Buffer.from(toml(config)));
        files.set('forwarding.secret', Buffer.from(secrets.forwarding!));
        files.set(
          'plugins/velocircon/rcon.yml',
          Buffer.from(
            yaml({
              enable: true,
              host: '127.0.0.1',
              port: 25575,
              password: secrets[`${name}.rcon`],
              colors: false,
            }),
          ),
        );
      }
      for (const [path, data] of files) {
        const target = join(dir, 'config', path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, data, { mode: 0o600 });
      }
      const managed = [...files.keys()];
      await mkdir(join(dir, 'plugins'), { recursive: true, mode: 0o700 });
      for (const plugin of locked.plugins) {
        const filename = `digit-${plugin.name ?? plugin.project}-${hash({ project: plugin.project, version: plugin.version, sha: plugin.sha512 ?? plugin.sha256 }).slice(0, 20)}.jar`;
        await fetchArtifact(plugin, join(dir, 'plugins', filename));
        managed.push(`plugins/${filename}`);
      }
      await privateWrite(join(dir, 'managed.txt'), managed.sort().join('\n') + '\n');
      await privateWrite(join(dir, 'bootstrap.sh'), bootstrap);
      const dataPath = service.type === 'paper' ? '/data' : '/server';
      common.entrypoint = [
        '/bin/bash',
        '/digit/bootstrap.sh',
        dataPath,
        service.type === 'paper' ? '/start' : '/usr/bin/run-bungeecord.sh',
      ];
      common.volumes.push(
        { type: 'bind', source: `./${name}`, target: '/digit', read_only: true },
        { type: 'bind', source: `./${name}/config`, target: '/config', read_only: true },
        { type: 'bind', source: `./${name}/plugins`, target: '/plugins', read_only: true },
      );
      common.environment = {
        ...Object.fromEntries(Object.entries(service.env).map(([k, v]) => [k, String(v)])),
        TYPE: service.type.toUpperCase(),
        MEMORY: service.memory,
        ENABLE_RCON: 'true',
        RCON_PORT: '25575',
        RCON_PASSWORD: secrets[`${name}.rcon`]!,
        SERVER_PORT: '25565',
        SERVER_IP: '',
        SYNC_SKIP_NEWER_IN_DESTINATION: 'false',
        REPLACE_ENV_DURING_SYNC: 'false',
        REPLACE_ENV_IN_PLACE: 'false',
        REPLACE_ENV_VARIABLES: 'false',
        SKIP_DOWNLOAD_DEFAULTS: 'true',
      };
      if (service.type === 'paper')
        Object.assign(common.environment, {
          EULA: '${DIGIT_EULA:?Accept the Minecraft EULA using digit up or explicitly set DIGIT_EULA=true}',
          VERSION: locked.version,
          PAPER_BUILD: String(locked.build),
          PAPER_CHANNEL: locked.channel?.toLowerCase() === 'stable' ? 'default' : 'experimental',
          COPY_CONFIG_DEST: '/data',
          SKIP_SERVER_PROPERTIES: 'false',
          MOTD: manifest.network.motd,
          ...(Object.keys(service.properties).length
            ? {
                CUSTOM_SERVER_PROPERTIES: Object.entries(service.properties)
                  .map(([key, value]) => `${key}=${String(value)}`)
                  .join('\n'),
              }
            : {}),
          ONLINE_MODE: String(!proxy),
        });
      else
        Object.assign(common.environment, {
          VELOCITY_VERSION: locked.version,
          VELOCITY_BUILD_ID: String(locked.build),
        });
      common.healthcheck = {
        test: ['CMD', 'mc-monitor', 'status', '--host', 'localhost', '--port', '25565'],
        interval: '5s',
        timeout: '10s',
        retries: 40,
        start_period: '60s',
      };
      const databases = Object.entries(manifest.services)
        .filter(([, s]) => s.type === 'mariadb')
        .map(([n]) => n);
      if (databases.length)
        common.depends_on = Object.fromEntries(
          databases.map((n) => [n, { condition: 'service_healthy' }]),
        );
      if (name === entrypoint)
        common.ports = [
          {
            target: 25565,
            published: String(manifest.network.port),
            host_ip: manifest.network.bind,
            protocol: 'tcp',
          },
        ];
      services[name] = common;
    }
    // Compose has its own interpolation pass: preserve literal dollar signs in user values.
    const composed = JSON.parse(
      JSON.stringify({ name: projectName, services, volumes }, (_key, value) =>
        typeof value === 'string' ? value.split('$').join('$$') : value,
      ),
    );
    for (const [name, service] of Object.entries(manifest.services))
      if (service.type === 'paper')
        composed.services[name].environment.EULA =
          '${DIGIT_EULA:?Accept the Minecraft EULA using digit up or explicitly set DIGIT_EULA=true}';
    await privateWrite(composeFile, yaml(composed));
    await privateWrite(
      join(directory, 'README.txt'),
      'Generated by digit. Contains local secrets: do not commit or publish this directory.\nStart with digit up, or explicitly accept the Minecraft EULA and set DIGIT_EULA=true before docker compose up.\n',
    );
  }
  await privateWrite(join(envDir, 'deployment.json'), JSON.stringify(deployment, null, 2));
  return deployment;
}
