import * as p from '@clack/prompts';
import { basename, join, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { stringify } from 'smol-toml';
import { listPaperVersions } from './resolve.ts';
import { parseManifest, validateName as validateConfigName } from './config.ts';
import type { PaperVersion } from './types.ts';

export class Cancelled extends Error {
  constructor() {
    super('Setup cancelled. No project files were created.');
    this.name = 'Cancelled';
  }
}
export function answer<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) throw new Cancelled();
  return value as Exclude<T, symbol>;
}
export interface InitOptions {
  yes?: boolean;
  name?: string;
  minecraft?: string;
  servers?: string;
  proxy?: boolean;
  proxyName?: string;
  plugins?: string;
  ops?: string;
  database?: boolean;
  port?: string;
  bind?: string;
  memory?: string;
}
export function validateName(value: string = ''): string | undefined {
  try {
    validateConfigName(value);
  } catch {
    return 'Use 1–40 lowercase letters, numbers, underscores or hyphens, starting with a letter; reserved names are not allowed.';
  }
  return undefined;
}
function validateServiceName(value: string): string | undefined {
  if (['project', 'environment', 'service'].includes(value))
    return 'The service names project, environment and service are reserved for configuration references.';
  return validateName(value);
}
function csv(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
function validateServers(
  value: string,
  proxy: boolean,
  proxyName: string,
  database: boolean,
): string | undefined {
  const names = csv(value);
  if (!names.length || (!proxy && names.length !== 1))
    return proxy
      ? 'Enter at least one server name.'
      : 'A standalone setup needs exactly one server.';
  for (const name of names) {
    const error = validateServiceName(name);
    if (error) return error;
  }
  if (proxy && names.includes('try'))
    return 'The Paper backend name try is reserved by Velocity. Choose another name.';
  if (new Set(names).size !== names.length) return 'Server names must be unique.';
  if (proxy && names.includes(proxyName)) return 'A server and proxy cannot share a name.';
  if (database && (names.includes('database') || (proxy && proxyName === 'database')))
    return 'The name database is reserved for your database service.';
}
const validMemory = (value: string = '') =>
  /^[1-9]\d*[MG]$/i.test(value) ? undefined : 'Use memory such as 2G or 512M.';
const validPort = (value: string = '') =>
  /^\d+$/.test(value) && Number(value) <= 65535
    ? undefined
    : 'Use a port from 0 (automatic) to 65535.';
const validPlugins = (value: string = '') =>
  csv(value).every((n) => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(n))
    ? undefined
    : 'Use comma-separated Modrinth project IDs or slugs.';
function validOperators(value: string = ''): string | undefined {
  return csv(value).every((name) => /^[A-Za-z0-9_]{1,16}$/.test(name))
    ? undefined
    : 'Use comma-separated Minecraft usernames: 1–16 letters, numbers or underscores each.';
}
function check(error: string | undefined): void {
  if (error) throw new Error(error);
}

export async function initProject(
  directory: string,
  options: InitOptions,
  dependencies: {
    versions?: () => Promise<PaperVersion[]>;
    interactive?: boolean;
    prompts?: typeof p;
  } = {},
): Promise<string> {
  const root = resolve(directory);
  const prompts = dependencies.prompts ?? p;
  const interactive =
    !options.yes &&
    (dependencies.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY));
  if (!options.yes && !interactive)
    throw new Error(
      'Guided setup needs a terminal. For automation, use digit init --yes --minecraft <version> (see digit init --help).',
    );
  if (await Bun.file(join(root, 'digit.toml')).exists())
    throw new Error(`A digit project already exists at ${root}. Choose another directory.`);
  if (interactive) prompts.intro('digit · a Minecraft setup of your own');
  const suggestion = basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
  const defaultName = validateName(suggestion) ? 'friends' : suggestion;
  const name =
    options.name ??
    (interactive
      ? answer(
          await prompts.text({
            message: 'What is this project called?',
            defaultValue: defaultName,
            placeholder: defaultName,
            validate: (value) => validateName(value || defaultName),
          }),
        )
      : defaultName);
  check(validateName(name));
  const proxy =
    options.proxy ??
    (interactive
      ? answer(
          await prompts.select({
            message: 'What would you like to run?',
            options: [
              { value: false, label: 'One Paper server', hint: 'A world for you and your friends' },
              {
                value: true,
                label: 'A Velocity network',
                hint: 'One proxy and always-on Paper servers',
              },
            ],
          }),
        )
      : false);
  const proxyName =
    options.proxyName ??
    (interactive && proxy
      ? answer(
          await prompts.text({
            message: 'What should the proxy be called?',
            defaultValue: 'proxy',
            placeholder: 'proxy',
            validate: (value) => validateServiceName(value || 'proxy'),
          }),
        )
      : 'proxy');
  check(validateServiceName(proxyName));
  const serversText =
    options.servers ??
    (interactive
      ? answer(
          await prompts.text({
            message: proxy
              ? 'Name your Paper servers, separated by commas (first is the lobby)'
              : 'What should the Paper server be called?',
            defaultValue: proxy ? 'lobby,survival' : 'survival',
            placeholder: proxy ? 'lobby,survival' : 'survival',
            validate: (value) =>
              validateServers(
                value || (proxy ? 'lobby,survival' : 'survival'),
                proxy,
                proxyName,
                false,
              ),
          }),
        )
      : proxy
        ? 'lobby,survival'
        : 'survival');
  check(validateServers(serversText, proxy, proxyName, false));
  const servers = csv(serversText);
  const spin = interactive ? prompts.spinner() : undefined;
  spin?.start('Getting every available Minecraft version from Paper…');
  let versions: PaperVersion[];
  try {
    versions = await (dependencies.versions ?? listPaperVersions)();
    spin?.stop('Minecraft versions loaded');
  } catch (error) {
    spin?.error('Could not load Minecraft versions');
    throw error;
  }
  if (!versions.length) throw new Error('Paper returned no Minecraft versions. Try again later.');
  const recommended =
    versions.find((v) => v.supported && !v.experimental) ??
    versions.find((v) => !v.experimental) ??
    versions[0]!;
  const minecraft =
    options.minecraft ??
    (interactive
      ? answer(
          await prompts.autocomplete({
            message: 'Which Minecraft version? Type to search; experimental versions are included.',
            initialValue: recommended.id,
            options: versions.map((v) => {
              const unsupported = /^1\.(\d+)(?:\.|$)/.exec(v.id);
              const disabled = Boolean(unsupported && Number(unsupported[1]) < 19);
              return {
                value: v.id,
                label: v.id,
                disabled,
                hint: disabled
                  ? 'requires Minecraft 1.19+ in this release'
                  : `${v.experimental ? 'experimental' : 'stable'}${v.supported ? ' · supported' : ' · legacy'} · Java ${v.java}`,
              };
            }),
            maxItems: 10,
          }),
        )
      : recommended.id);
  const version = versions.find((v) => v.id === minecraft);
  if (!version)
    throw new Error(
      `Minecraft ${minecraft} is not in the Paper version catalog. Run digit init interactively to see available versions.`,
    );
  const memory =
    options.memory ??
    (interactive
      ? answer(
          await prompts.text({
            message: 'Memory per Paper server?',
            defaultValue: '2G',
            placeholder: '2G',
            validate: (value) => validMemory(value || '2G'),
          }),
        )
      : '2G');
  check(validMemory(memory));
  const operatorsText =
    options.ops ??
    (interactive
      ? answer(
          await prompts.text({
            message:
              'Who should be an operator (OP) on every Paper server? Enter usernames, comma-separated; leave blank to skip.',
            defaultValue: '',
            placeholder: 'YourMinecraftName',
            validate: validOperators,
          }),
        )
      : '');
  check(validOperators(operatorsText));
  const operators = [...new Set(csv(operatorsText))];
  const pluginsText =
    options.plugins ??
    (interactive
      ? answer(
          await prompts.text({
            message:
              'Any Modrinth plugins? Enter project IDs or slugs, comma-separated; leave blank to skip.',
            defaultValue: '',
            placeholder: 'viaversion,luckperms',
            validate: validPlugins,
          }),
        )
      : '');
  check(validPlugins(pluginsText));
  const pluginProjects = [...new Set(csv(pluginsText))];
  const pluginEntries: [string, { source: string; project: string; version: string }][] = [];
  for (const project of pluginProjects) {
    let base = project.toLowerCase().slice(0, 32);
    if (validateName(base)) base = `plugin-${base}`.slice(0, 32);
    let alias = base;
    for (let index = 2; pluginEntries.some(([key]) => key === alias); index++)
      alias = `${base}-${index}`;
    pluginEntries.push([alias, { source: 'modrinth', project, version: 'latest' }]);
  }
  const plugins = pluginEntries.map(([alias]) => alias);
  const database =
    options.database ??
    (interactive
      ? answer(
          await prompts.confirm({
            message: 'Add a private MariaDB database for plugins?',
            initialValue: false,
          }),
        )
      : false);
  check(validateServers(serversText, proxy, proxyName, database));
  const bind =
    options.bind ??
    (interactive
      ? answer(
          await prompts.select({
            message: 'Who can connect to this setup?',
            options: [
              { value: '127.0.0.1', label: 'This computer', hint: 'Good for local testing' },
              {
                value: '0.0.0.0',
                label: 'Other computers',
                hint: 'Listen on all interfaces; router/firewall setup may be needed',
              },
            ],
          }),
        )
      : '127.0.0.1');
  check(
    isIP(bind) === 4
      ? undefined
      : 'Bind address must be an IPv4 address, such as 127.0.0.1 or 0.0.0.0.',
  );
  const port =
    options.port ??
    (interactive
      ? answer(
          await prompts.text({
            message: 'Minecraft port? Use 0 for an automatically assigned port.',
            defaultValue: '25565',
            placeholder: '25565',
            validate: (value) => validPort(value || '25565'),
          }),
        )
      : '25565');
  check(validPort(port));
  const services: Record<string, object> = {};
  if (proxy)
    services[proxyName] = {
      type: 'velocity',
      version: 'latest',
      memory: '512M',
      fallback: [servers[0]!],
    };
  for (const server of servers)
    services[server] = {
      type: 'paper',
      version: minecraft,
      build: 'latest',
      channel: version.experimental ? 'experimental' : 'stable',
      memory: memory.toUpperCase(),
      plugins,
      ...(operators.length ? { env: { OPS: operators.join(',') } } : {}),
    };
  if (database) services.database = { type: 'mariadb', version: '11.8' };
  const document = {
    schema: 1,
    name,
    network: { bind, port: Number(port), motd: `${name} · powered by digit` },
    services,
    plugins: Object.fromEntries(pluginEntries),
  };
  parseManifest(document);
  const manifest = stringify(document);
  if (interactive) {
    prompts.note(
      `${proxy ? `${proxyName} → ` : ''}${servers.join(', ')}\nMinecraft ${minecraft}${version.experimental ? ' (experimental)' : ''} · ${memory.toUpperCase()} per Paper server\n${bind}:${port}${database ? '\nPrivate MariaDB database' : ''}${operators.length ? `\nOperators: ${operators.join(', ')}` : ''}\n${root}`,
      'Your setup',
    );
    if (!answer(await prompts.confirm({ message: 'Create this project?', initialValue: true })))
      throw new Cancelled();
  }
  // Finish all prompts and validation before touching the destination.
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'digit.toml'),
    `# digit: declarative Minecraft servers\n# Commit this file, services/, environments/, and digit.lock to Git.\n\n${manifest}`,
    { flag: 'wx' },
  );
  for (const service of Object.keys(services)) {
    await mkdir(join(root, 'services', service), { recursive: true });
    if (!(await Bun.file(join(root, 'services', service, '.gitkeep')).exists()))
      await writeFile(join(root, 'services', service, '.gitkeep'), '', { flag: 'wx' });
  }
  await mkdir(join(root, 'environments'), { recursive: true });
  const stagingPath = join(root, 'environments', 'staging.toml');
  if (!(await Bun.file(stagingPath).exists()))
    await writeFile(
      stagingPath,
      '# Reusable settings for isolated local testing.\n[network]\nbind = "127.0.0.1"\nport = 0\n',
      { flag: 'wx' },
    );
  const ignorePath = join(root, '.gitignore');
  const ignore = (await Bun.file(ignorePath).exists()) ? await Bun.file(ignorePath).text() : '';
  const additions = ['.digit/', '.env', '.env.*', '!.env.example'].filter(
    (line) => !ignore.split('\n').includes(line),
  );
  if (additions.length)
    await writeFile(
      ignorePath,
      `${ignore}${ignore && !ignore.endsWith('\n') ? '\n' : ''}${additions.join('\n')}\n`,
    );
  if (interactive)
    prompts.outro(
      `Ready. ${root === process.cwd() ? 'Run digit up' : `Open ${root} and run digit up`}. EULA consent is requested before starting.`,
    );
  return root;
}
