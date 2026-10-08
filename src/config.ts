import { realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join, relative, resolve, sep } from 'node:path';
import { parse } from 'smol-toml';
import type { EnvironmentOptions, Manifest, Plugin, Project, Service } from './types';

type Table = Record<string, unknown>;
const reservedNames = new Set(['__proto__', 'prototype', 'constructor']);
const managedEnv =
  /^(?:EULA|TYPE|VERSION|PAPER(?:_.*)?|VELOCITY(?:_.*)?|VELOCIRCON(?:_.*)?|ONLINE_MODE|SERVER_PORT|SERVER_IP|SERVER_NAME|MOTD|ENABLE_RCON|RCON(?:_.*)?|MEMORY|INIT_MEMORY|MAX_MEMORY|JVM(?:_.*)?|PLUGINS?(?:_.*)?|MODRINTH(?:_.*)?|COPY(?:_.*)?|REPLACE(?:_.*)?|REMOVE(?:_.*)?|SYNC(?:_.*)?|USE_FLARE_FLAGS|PATCH_DEFINITIONS|SKIP_SERVER_PROPERTIES|SERVER_PROPERTIES(?:_.*)?|CUSTOM_SERVER_PROPERTIES|ENABLE_QUERY|SPIGET(?:_.*)?|MODS?(?:_.*)?|GENERIC_PACK(?:_.*)?|BUNGEE(?:_.*)?|CUSTOM_SERVER|SERVER|CFG(?:_.*)?|MARIADB(?:_.*)?|MYSQL(?:_.*)?)$/;
const managedProperties = new Set([
  'online-mode',
  'server-port',
  'server-ip',
  'enable-rcon',
  'enable-query',
  'rcon.port',
  'rcon.password',
  'motd',
]);

function fail(path: string, message: string): never {
  throw new Error(`${path}: ${message}`);
}
function table(value: unknown, path: string): Table {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    fail(path, 'expected a table');
  return value as Table;
}
function fields(value: Table, allowed: string[], path: string) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`${path}.${key}`, 'unknown field');
}
function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim())
    fail(path, 'expected a non-empty string (quote versions in TOML)');
  if (value.includes('\0')) fail(path, 'must not contain NUL');
  return value;
}
function strings(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(path, 'expected an array of strings');
  const result = value.map((entry, index) => string(entry, `${path}[${index}]`));
  if (new Set(result).size !== result.length) fail(path, 'duplicate entries');
  return result;
}
function identifier(value: unknown, path: string): string {
  const result = string(value, path);
  try {
    validateName(result);
  } catch (error) {
    fail(path, (error as Error).message);
  }
  return result;
}
function scalars(
  value: unknown,
  path: string,
  env: boolean,
): Record<string, string | number | boolean> {
  const input = table(value, path);
  const result: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (env ? !/^[A-Z][A-Z0-9_]*$/.test(key) : !/^[a-zA-Z0-9_.-]+$/.test(key))
      fail(`${path}.${key}`, 'invalid key');
    if (
      env
        ? managedEnv.test(key) && !['JVM_OPTS', 'JVM_XX_OPTS'].includes(key)
        : managedProperties.has(key)
    )
      fail(
        `${path}.${key}`,
        'managed by digit; configure it through the service or network settings',
      );
    if (
      !['string', 'number', 'boolean'].includes(typeof entry) ||
      (typeof entry === 'number' && !Number.isFinite(entry))
    )
      fail(`${path}.${key}`, 'expected a string, number, or boolean');
    if (typeof entry === 'string' && /[\r\n\0]/.test(entry))
      fail(`${path}.${key}`, 'must be a single line');
    result[key] = entry as string | number | boolean;
  }
  return result;
}

/** Names are also filesystem paths, Docker aliases, and environment identifiers. */
export function validateName(name: string): void {
  if (
    typeof name !== 'string' ||
    !/^[a-z][a-z0-9_-]{0,39}$/.test(name) ||
    reservedNames.has(name)
  ) {
    throw new Error(
      'use 1–40 lowercase letters, digits, hyphens, or underscores, starting with a letter; reserved names are not allowed',
    );
  }
}

export function parseManifest(raw: unknown): Manifest {
  const input = table(raw, 'digit');
  fields(input, ['schema', 'name', 'services', 'plugins', 'network'], 'digit');
  if (input.schema !== undefined && input.schema !== 1)
    fail('schema', 'only schema = 1 is supported');
  const name = identifier(input.name, 'name');
  const network = table(input.network ?? {}, 'network');
  fields(network, ['bind', 'port', 'motd'], 'network');
  const bind = string(network.bind ?? '127.0.0.1', 'network.bind');
  if (!isIP(bind)) fail('network.bind', 'expected an IPv4 or IPv6 address');
  const port = network.port ?? 25565;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535)
    fail('network.port', 'expected a port from 0 to 65535 (0 assigns an available port)');
  const motd = string(network.motd ?? name, 'network.motd');
  if (/[\r\n]/.test(motd)) fail('network.motd', 'must be a single line');
  const plugins: Record<string, Plugin> = {};
  for (const [key, rawPlugin] of Object.entries(table(input.plugins ?? {}, 'plugins'))) {
    identifier(key, `plugins.${key}`);
    const plugin = table(rawPlugin, `plugins.${key}`);
    fields(plugin, ['source', 'project', 'version'], `plugins.${key}`);
    if (plugin.source !== 'modrinth') fail(`plugins.${key}.source`, 'only "modrinth" is supported');
    const project = string(plugin.project, `plugins.${key}.project`);
    if (!/^[a-zA-Z0-9_-]+$/.test(project))
      fail(`plugins.${key}.project`, 'expected a Modrinth project slug or ID');
    plugins[key] = {
      source: 'modrinth',
      project,
      version: string(plugin.version ?? 'latest', `plugins.${key}.version`),
    };
  }
  const services: Record<string, Service> = {};
  for (const [key, rawService] of Object.entries(table(input.services, 'services'))) {
    const path = `services.${key}`;
    identifier(key, path);
    if (['project', 'environment', 'service'].includes(key))
      fail(
        path,
        'reserved service name; project, environment, and service are configuration reference namespaces',
      );
    const service = table(rawService, path);
    fields(
      service,
      ['type', 'version', 'build', 'channel', 'memory', 'plugins', 'fallback', 'properties', 'env'],
      path,
    );
    const type = service.type;
    if (type !== 'paper' && type !== 'velocity' && type !== 'mariadb')
      fail(`${path}.type`, 'expected paper, velocity, or mariadb');
    const version = string(
      service.version ?? (type === 'mariadb' ? '11.8' : 'latest'),
      `${path}.version`,
    );
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(version)) fail(`${path}.version`, 'invalid version');
    const legacy = /^1\.(\d+)(?:\.|$)/.exec(version);
    if (type === 'paper' && legacy && Number(legacy[1]) < 19)
      fail(
        `${path}.version`,
        'this release candidate supports Paper 1.19 and newer; older versions need different forwarding configuration',
      );
    const build = string(service.build ?? 'latest', `${path}.build`);
    if (build !== 'latest' && !/^[1-9][0-9]*$/.test(build))
      fail(`${path}.build`, 'expected "latest" or a positive build number as a string');
    const channel = service.channel ?? 'stable';
    if (channel !== 'stable' && channel !== 'experimental')
      fail(`${path}.channel`, 'expected stable or experimental');
    const memory = string(service.memory ?? (type === 'paper' ? '2G' : '512M'), `${path}.memory`);
    if (!/^[1-9][0-9]*[MG]$/.test(memory))
      fail(`${path}.memory`, 'expected a positive amount such as "2G" or "512M"');
    const selectedPlugins = strings(service.plugins ?? [], `${path}.plugins`);
    for (const plugin of selectedPlugins)
      if (!Object.hasOwn(plugins, plugin))
        fail(`${path}.plugins`, `unknown plugin "${plugin}"; declare it under [plugins.${plugin}]`);
    if (
      type === 'velocity' &&
      selectedPlugins.some((alias) => {
        const project = plugins[alias]!.project;
        return project.toLowerCase() === 'velocircon' || project === 'KkmSfl3v';
      })
    )
      fail(
        `${path}.plugins`,
        'Velocircon is already provided by digit for built-in command support. Remove it from this service’s plugin list and use digit cmd.',
      );
    const properties = scalars(service.properties ?? {}, `${path}.properties`, false);
    const env = scalars(service.env ?? {}, `${path}.env`, true);
    if (type !== 'paper' && Object.keys(properties).length)
      fail(`${path}.properties`, 'server properties are only supported on Paper');
    if (type === 'mariadb' && selectedPlugins.length)
      fail(`${path}.plugins`, 'databases cannot install Minecraft plugins');
    if (
      type === 'mariadb' &&
      (service.build !== undefined || service.channel !== undefined || service.memory !== undefined)
    )
      fail(path, 'build, channel, and memory are only supported on Minecraft services');
    const fallback =
      service.fallback === undefined ? undefined : strings(service.fallback, `${path}.fallback`);
    if (fallback && type !== 'velocity')
      fail(`${path}.fallback`, 'only a Velocity proxy has fallback destinations');
    services[key] = {
      type,
      version,
      build,
      channel,
      memory,
      plugins: selectedPlugins,
      properties,
      env,
      ...(fallback ? { fallback } : {}),
    };
  }
  const papers = Object.keys(services).filter((key) => services[key]!.type === 'paper');
  const proxies = Object.keys(services).filter((key) => services[key]!.type === 'velocity');
  if (!papers.length) fail('services', 'at least one Paper server is required');
  if (proxies.length && papers.includes('try'))
    fail(
      'services.try',
      'Paper backend name "try" is reserved by Velocity for fallback destinations',
    );
  if (proxies.length > 1) fail('services', 'this release supports one Velocity proxy per project');
  if (papers.length > 1 && !proxies.length)
    fail('services', 'multiple Paper servers require a Velocity proxy');
  for (const proxy of proxies) {
    const service = services[proxy]!;
    if (!service.fallback) {
      if (papers.length > 1)
        fail(
          `services.${proxy}.fallback`,
          'choose an initial server, for example fallback = ["lobby"]',
        );
      service.fallback = [papers[0]!];
    }
    if (!service.fallback.length)
      fail(`services.${proxy}.fallback`, 'at least one destination is required');
    for (const destination of service.fallback)
      if (!papers.includes(destination))
        fail(`services.${proxy}.fallback`, `"${destination}" is not a Paper service`);
  }
  return { schema: 1, name, network: { bind, port, motd }, plugins, services };
}

/** Order-independent object hashing. Array order remains significant. */
export function hash(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, val]) => [key, canonical(val)]),
      );
    return item;
  }
  return new Bun.CryptoHasher('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

async function readToml(path: string, root: string): Promise<unknown> {
  const actual = await realpath(path);
  const rel = relative(root, actual);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== actual)
    throw new Error(`${path}: symlink escapes the project directory`);
  try {
    return parse(await Bun.file(actual).text());
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
}

export async function loadProject(
  root: string,
  options: EnvironmentOptions = {},
): Promise<Project> {
  const actualRoot = await realpath(resolve(root));
  const env = options.env ?? 'dev';
  validateName(env);
  if (options.profile !== undefined) validateName(options.profile);
  const manifest = parseManifest(await readToml(join(actualRoot, 'digit.toml'), actualRoot));
  // Named instances use private ephemeral ports unless their profile requests otherwise.
  if (env !== 'dev') manifest.network = { ...manifest.network, bind: '127.0.0.1', port: 0 };
  const profile = options.profile ?? env;
  const path = join(actualRoot, 'environments', `${profile}.toml`);
  if (!(await Bun.file(path).exists())) {
    if (options.profile) throw new Error(`Profile "${profile}" does not exist: ${path}`);
    return { root: actualRoot, manifest };
  }
  const overlay = table(await readToml(path, actualRoot), `profile ${profile}`);
  fields(overlay, ['network', 'services'], `profile ${profile}`);
  if (overlay.network !== undefined) {
    const network = table(overlay.network, `profile ${profile}.network`);
    fields(network, ['bind', 'port', 'motd'], `profile ${profile}.network`);
    manifest.network = { ...manifest.network, ...network } as Manifest['network'];
  }
  if (overlay.services !== undefined)
    for (const [key, raw] of Object.entries(
      table(overlay.services, `profile ${profile}.services`),
    )) {
      if (!Object.hasOwn(manifest.services, key))
        fail(
          `profile ${profile}.services.${key}`,
          'cannot introduce a service; declare it in digit.toml',
        );
      const service = manifest.services[key]!;
      const overrides = table(raw, `profile ${profile}.services.${key}`);
      fields(
        overrides,
        ['memory', 'properties', 'env', 'fallback'],
        `profile ${profile}.services.${key}`,
      );
      if (service.type === 'mariadb' && overrides.memory !== undefined)
        fail(
          `profile ${profile}.services.${key}.memory`,
          'memory is only supported on Minecraft services',
        );
      manifest.services[key] = {
        ...service,
        ...overrides,
        properties: {
          ...service.properties,
          ...table(overrides.properties ?? {}, `services.${key}.properties`),
        },
        env: { ...service.env, ...table(overrides.env ?? {}, `services.${key}.env`) },
      } as Service;
    }
  // Reparse normalized input so overlay values get exactly the same validation.
  // MariaDB's internal defaults are omitted because those fields are not user knobs.
  const validationInput = structuredClone(manifest) as unknown as Table;
  for (const service of Object.values(validationInput.services as Record<string, Table>))
    if (service.type === 'mariadb') {
      delete service.build;
      delete service.channel;
      delete service.memory;
    }
  return { root: actualRoot, manifest: parseManifest(validationInput) };
}
