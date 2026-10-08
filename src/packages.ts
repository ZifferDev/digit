import * as p from '@clack/prompts';
import { parseManifest, validateName } from './config';
import { answer, Cancelled } from './prompts';
import { getModrinthProject, resolveLock, type ModrinthProject } from './resolve';
import type { Lockfile, Manifest } from './types';

export interface PackageOptions {
  yes?: boolean;
  servers?: string;
  all?: boolean;
}
export interface PackageDependencies {
  interactive?: boolean;
  prompts?: typeof p;
  project?: typeof getModrinthProject;
  resolve?: typeof resolveLock;
  /** init --yes applies its initial plugins to all Paper servers. */
  defaultServers?: string[];
}
export interface PackagePlan {
  manifest: Manifest;
  lock: Lockfile;
  changes: string[];
}
export function pluginInputs(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}
export function validatePluginInputs(value = ''): string | undefined {
  return pluginInputs(value).every((s) => /^[a-zA-Z0-9][a-zA-Z0-9_-]*(?:@[^\s@]+)?$/.test(s))
    ? undefined
    : 'Use Modrinth project IDs or slugs, optionally followed by @version.';
}
export async function selectPluginInputs(prompts: typeof p, optional = false): Promise<string[]> {
  return pluginInputs(
    answer(
      await prompts.text({
        message: optional
          ? 'Any Modrinth plugins? Enter project IDs or slugs, comma-separated; leave blank to skip.'
          : 'Which Modrinth plugins? Enter project IDs or slugs, comma-separated.',
        defaultValue: '',
        placeholder: 'viabackwards,luckperms',
        validate: (value) =>
          !optional && !pluginInputs(value ?? '').length
            ? 'Enter at least one plugin.'
            : validatePluginInputs(value),
      }),
    ),
  );
}
function normalize(manifest: Manifest): Manifest {
  const raw = structuredClone(manifest) as unknown as Record<string, any>;
  for (const service of Object.values(raw.services) as Record<string, unknown>[])
    if (service.type === 'mariadb') {
      delete service.build;
      delete service.channel;
      delete service.memory;
    }
  return parseManifest(raw);
}
function aliasFor(slug: string, manifest: Manifest): string {
  let base = slug.toLowerCase().slice(0, 32);
  try {
    validateName(base);
  } catch {
    base = `plugin-${base}`.slice(0, 32);
  }
  let alias = base;
  for (let i = 2; Object.hasOwn(manifest.plugins, alias); i++) alias = `${base}-${i}`;
  return alias;
}
function ui(options: PackageOptions, deps: PackageDependencies) {
  const prompts = deps.prompts ?? p;
  const interactive =
    !options.yes && (deps.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY));
  return { prompts, interactive };
}
function validateTargets(manifest: Manifest, options: PackageOptions) {
  if (options.all && options.servers !== undefined)
    throw new Error('Use --servers or --all, not both.');
  if (options.servers !== undefined) {
    const names = pluginInputs(options.servers);
    if (!names.length) throw new Error('Choose at least one server.');
    for (const name of names)
      if (!Object.hasOwn(manifest.services, name) || manifest.services[name]!.type === 'mariadb')
        throw new Error(
          `Cannot select "${name}": choose a Paper or Velocity service from digit.toml.`,
        );
  }
}
async function targets(
  manifest: Manifest,
  candidates: string[],
  label: string,
  options: PackageOptions,
  deps: PackageDependencies,
): Promise<string[]> {
  const { prompts, interactive } = ui(options, deps);
  let selected: string[];
  if (options.servers !== undefined) selected = pluginInputs(options.servers);
  else if (options.all) selected = candidates;
  else if (interactive)
    selected = answer(
      await prompts.multiselect({
        message: `Which servers should ${label}?`,
        options: candidates.map((name) => ({
          value: name,
          label: name,
          hint: `${manifest.services[name]!.type} ${manifest.services[name]!.version}`,
        })),
        initialValues:
          deps.defaultServers?.filter((name) => candidates.includes(name)) ??
          (candidates.length === 1 ? candidates : []),
        required: true,
      }),
    );
  else if (deps.defaultServers) selected = deps.defaultServers;
  else if (candidates.length === 1) selected = candidates;
  else
    throw new Error(
      `Choose servers for ${label}: use --servers lobby,survival or --all, or run in a terminal.`,
    );
  if (!selected.length) throw new Error('Choose at least one server.');
  if (options.servers !== undefined) return selected.filter((name) => candidates.includes(name));
  for (const name of selected)
    if (!candidates.includes(name))
      throw new Error(
        `Cannot select "${name}" for ${label}. Available servers: ${candidates.join(', ')}.`,
      );
  return selected;
}
function metadata(deps: PackageDependencies) {
  const cache = new Map<string, Promise<ModrinthProject>>();
  return (id: string) => {
    if (!cache.has(id))
      cache.set(
        id,
        (deps.project ?? getModrinthProject)(id).then((value) => {
          const safe = { ...value, title: value.title.replace(/[\x00-\x1f\x7f]/g, '') };
          cache.set(value.id, Promise.resolve(safe));
          cache.set(value.slug, Promise.resolve(safe));
          return safe;
        }),
      );
    return cache.get(id)!;
  };
}
async function resolvePlan(
  manifest: Manifest,
  before: Manifest,
  previous: Lockfile | undefined,
  options: PackageOptions,
  deps: PackageDependencies,
): Promise<Lockfile> {
  const { prompts, interactive } = ui(options, deps);
  const spin = interactive ? prompts.spinner() : undefined;
  spin?.start('Resolving compatible plugins and required dependencies…');
  try {
    const lock = await (deps.resolve ?? resolveLock)(manifest, previous, false, before);
    spin?.stop('Plugin selections resolved');
    return lock;
  } catch (error) {
    spin?.error('Could not resolve plugin selections');
    throw error;
  }
}

/** Shared by init and add. Complete selection, resolution and consent before returning a plan. */
export async function planAdd(
  before: Manifest,
  inputs: string[],
  options: PackageOptions = {},
  previous?: Lockfile,
  deps: PackageDependencies = {},
): Promise<PackagePlan> {
  validateTargets(before, options);
  const { prompts, interactive } = ui(options, deps);
  if (!inputs.length) {
    if (!interactive)
      throw new Error(
        'Specify a Modrinth project: digit add viabackwards --servers lobby,survival --yes.',
      );
    inputs = await selectPluginInputs(prompts);
  }
  if (
    !inputs.length ||
    inputs.some((input) => validatePluginInputs(input) || pluginInputs(input).length !== 1)
  )
    throw new Error('Use Modrinth project IDs or slugs, optionally followed by @version.');
  const manifest = structuredClone(before);
  const project = metadata(deps);
  const candidates = Object.keys(manifest.services).filter(
    (name) => manifest.services[name]!.type !== 'mariadb',
  );
  const changes: string[] = [];
  for (const input of [...new Set(inputs)]) {
    const [id, requested] = input.split('@');
    const knownAlias = Object.hasOwn(before.plugins, id!) ? id : undefined;
    const info = await project(knownAlias ? manifest.plugins[knownAlias]!.project : id!);
    let alias = knownAlias;
    if (!alias)
      for (const [name, plugin] of Object.entries(manifest.plugins)) {
        if (
          plugin.project === info.id ||
          plugin.project === info.slug ||
          (await project(plugin.project)).id === info.id
        ) {
          alias = name;
          break;
        }
      }
    alias ??= aliasFor(info.slug, manifest);
    const existing = manifest.plugins[alias];
    if (existing && requested && existing.version !== requested)
      throw new Error(
        `Plugin "${alias}" already uses ${existing.version}. Edit its version in digit.toml and run digit update to change it for every server.`,
      );
    manifest.plugins[alias] = existing ?? {
      source: 'modrinth',
      project: info.id,
      version: requested ?? 'latest',
    };
    const selected = await targets(
      manifest,
      candidates,
      `install ${info.title} (${alias})`,
      options,
      deps,
    );
    for (const name of selected) {
      const service = manifest.services[name]!;
      if (!service.plugins.includes(alias)) {
        service.plugins.push(alias);
        changes.push(`Add ${alias} → ${name}`);
      }
    }
  }
  const valid = normalize(manifest);
  const lock = await resolvePlan(valid, before, previous, options, deps);
  const required = new Map<string, { title: string; servers: string[] }>();
  for (const [name, service] of Object.entries(lock.services)) {
    for (const plugin of service.plugins) {
      if (plugin.aliases?.length) continue;
      if (
        previous?.services[name]?.plugins.some(
          (prior) => prior.project === plugin.project && prior.version === plugin.version,
        )
      )
        continue;
      const info = await project(plugin.project);
      plugin.name = aliasFor(info.slug, { ...manifest, plugins: {} });
      const row = required.get(plugin.project) ?? { title: info.title, servers: [] };
      row.servers.push(name);
      required.set(plugin.project, row);
    }
  }
  if (required.size) {
    const summary = [...required.values()]
      .map((row) => `${row.title} → ${row.servers.join(', ')}`)
      .join('\n');
    if (interactive) {
      prompts.note(summary, 'Required Modrinth dependencies');
      if (
        !answer(
          await prompts.confirm({
            message: 'Also install these required dependencies?',
            initialValue: true,
          }),
        )
      )
        throw new Cancelled(
          'Add cancelled. Required dependencies cannot be skipped; no project files were changed.',
        );
    } else if (!options.yes)
      throw new Error(
        `Required dependencies:\n${summary}\nRun interactively to confirm, or use --yes to include required dependencies.`,
      );
    changes.push(
      ...[...required.values()].map((row) => `Required: ${row.title} → ${row.servers.join(', ')}`),
    );
  }
  return { manifest: valid, lock, changes };
}

export async function planRemove(
  before: Manifest,
  inputs: string[],
  options: PackageOptions = {},
  previous?: Lockfile,
  deps: PackageDependencies = {},
): Promise<PackagePlan> {
  validateTargets(before, options);
  const { prompts, interactive } = ui(options, deps);
  const manifest = structuredClone(before);
  if (!inputs.length) {
    const aliases = Object.keys(manifest.plugins);
    if (!aliases.length) throw new Error('No plugins are declared in digit.toml.');
    if (!interactive)
      throw new Error(
        'Specify a manifest alias: digit remove viabackwards --servers lobby,survival.',
      );
    inputs = answer(
      await prompts.multiselect({
        message: 'Which plugins should be removed?',
        options: aliases.map((alias) => ({ value: alias, label: alias })),
        required: true,
      }),
    );
  }
  const project = metadata(deps);
  const removed = new Map<string, Set<string>>();
  const changes: string[] = [];
  for (const alias of [...new Set(inputs)]) {
    if (!Object.hasOwn(manifest.plugins, alias))
      throw new Error(
        `Unknown plugin alias "${alias}". Available: ${Object.keys(manifest.plugins).join(', ')}. Transitive dependencies are removed with their parent plugin.`,
      );
    const candidates = Object.keys(manifest.services).filter((name) =>
      manifest.services[name]!.plugins.includes(alias),
    );
    const selected = candidates.length
      ? await targets(manifest, candidates, `remove ${alias}`, options, deps)
      : [];
    for (const name of selected) {
      manifest.services[name]!.plugins = manifest.services[name]!.plugins.filter(
        (value) => value !== alias,
      );
      const aliases = removed.get(name) ?? new Set<string>();
      aliases.add(alias);
      removed.set(name, aliases);
      changes.push(`Remove ${alias} ← ${name}`);
    }
    if (!Object.values(manifest.services).some((service) => service.plugins.includes(alias))) {
      delete manifest.plugins[alias];
      if (!candidates.length) changes.push(`Remove unused declaration ${alias}`);
    }
  }
  const valid = normalize(manifest);
  const lock = await resolvePlan(valid, before, previous, options, deps);
  for (const [name, aliases] of removed)
    for (const alias of aliases) {
      const pinned = previous?.services[name]?.plugins.find((plugin) =>
        plugin.aliases?.includes(alias),
      );
      const id = pinned?.project ?? (await project(before.plugins[alias]!.project)).id;
      const remaining = lock.services[name]!.plugins.find((plugin) => plugin.project === id);
      if (remaining && !remaining.aliases?.length)
        throw new Error(
          `Cannot remove ${alias} from ${name}: it is still required by the remaining plugins (${manifest.services[name]!.plugins.join(', ')}). Remove the dependent plugin(s) first or together.`,
        );
    }
  return { manifest: valid, lock, changes };
}
