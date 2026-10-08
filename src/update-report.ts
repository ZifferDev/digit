import { hash } from './config';
import { getModrinthVersionLabels } from './resolve';
import type { Artifact, LockedPlugin, LockedService, Lockfile } from './types';

type PluginChange = { before?: LockedPlugin; after?: LockedPlugin };
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
export const versionKey = (plugin: LockedPlugin) => `${plugin.project}/${plugin.version}`;
const softwareName = { paper: 'Paper', velocity: 'Velocity', mariadb: 'MariaDB' };
function software(service: LockedService): string {
  return `${softwareName[service.type]} ${service.version}${service.build === undefined ? '' : ` build ${service.build}`}`;
}
function artifactEqual(a?: Artifact, b?: Artifact): boolean {
  return (
    a?.url === b?.url &&
    a?.filename === b?.filename &&
    a?.sha256 === b?.sha256 &&
    a?.sha512 === b?.sha512
  );
}
function pluginChanges(before?: LockedService, after?: LockedService): PluginChange[] {
  const old = new Map(before?.plugins.map((plugin) => [plugin.project, plugin]));
  const next = new Map(after?.plugins.map((plugin) => [plugin.project, plugin]));
  return [...new Set([...old.keys(), ...next.keys()])].sort().flatMap((id) => {
    const before = old.get(id),
      after = next.get(id);
    return before && after && before.version === after.version && artifactEqual(before, after)
      ? []
      : [{ before, after }];
  });
}
function pair(before: string, after: string): string {
  const short = (value: string) =>
    value.replace(
      /(sha(?:256|512):)([a-f0-9]{13,})/g,
      (_, prefix, digest) => `${prefix}${digest.slice(0, 12)}…`,
    );
  const a = short(before),
    b = short(after);
  return a === b && before !== after ? `${before} → ${after}` : `${a} → ${b}`;
}
function artifactDetails(before?: Artifact, after?: Artifact): string[] {
  const rows: string[] = [];
  if (before?.filename !== after?.filename)
    rows.push(`file: ${before?.filename ?? '(none)'} → ${after?.filename ?? '(none)'}`);
  for (const algorithm of ['sha256', 'sha512'] as const)
    if (before?.[algorithm] !== after?.[algorithm])
      rows.push(
        `checksum: ${pair(before?.[algorithm] ? `${algorithm}:${before[algorithm]}` : '(none)', after?.[algorithm] ? `${algorithm}:${after[algorithm]}` : '(none)')}`,
      );
  if (before?.url !== after?.url) rows.push('download URL changed');
  return rows;
}
function pluginName(change: PluginChange): string {
  const { before, after } = change;
  const aliases = after?.aliases?.length ? after.aliases : before?.aliases;
  return aliases?.length
    ? aliases.join(', ')
    : ([after, before].find((plugin) => plugin?.name && plugin.name !== plugin.project)?.name ??
        after?.name ??
        before?.name ??
        after?.project ??
        before!.project);
}
function pluginRows(change: PluginChange, labels: Map<string, string>): string[] {
  const { before, after } = change;
  const version = (plugin: LockedPlugin) =>
    labels.get(versionKey(plugin)) ?? `version ID ${plugin.version}`;
  const name = pluginName(change);
  if (!before) return [`plugin ${name}: added ${version(after!)}`];
  if (!after) return [`plugin ${name}: removed ${version(before)}`];
  if (before.version !== after.version) {
    const old = version(before),
      next = version(after);
    return [
      `plugin ${name}: ${old === next ? `${old} (${before.version}) → ${next} (${after.version})` : `${old} → ${next}`}`,
    ];
  }
  return [
    `plugin ${name} ${version(after)}: artifact changed`,
    ...artifactDetails(before, after).map((row) => `  ${row}`),
  ];
}

/** Compare dependency identities, ignoring bookkeeping, labels, and array/key ordering. */
export async function formatUpdateReport(
  before: Lockfile | undefined,
  after: Lockfile,
  apply = 'digit up',
  lookup: (plugins: LockedPlugin[]) => Promise<Map<string, string>> = getModrinthVersionLabels,
  options: { outdated?: boolean; updateCommand?: string } = {},
): Promise<string> {
  const names = [
    ...new Set([...Object.keys(before?.services ?? {}), ...Object.keys(after.services)]),
  ].sort();
  const changes = new Map(
    names.map((name) => [name, pluginChanges(before?.services[name], after.services[name])]),
  );
  const plugins = [
    ...new Map(
      [...changes.values()]
        .flatMap((rows) =>
          rows.flatMap(({ before, after }) =>
            [before, after].filter((p): p is LockedPlugin => !!p),
          ),
        )
        .map((plugin) => [versionKey(plugin), plugin]),
    ).values(),
  ];
  let labels = new Map<string, string>();
  // Display enrichment must never turn a successful lock update into an error.
  if (plugins.length)
    try {
      labels = await lookup(plugins);
    } catch {
      /* Exact version IDs remain available. */
    }
  const blocks: string[] = [];
  for (const name of names) {
    const old = before?.services[name],
      next = after.services[name];
    const rows: string[] = [];
    if (!old) {
      rows.push(`added ${software(next!)}`, `image: ${next!.image}`);
      if (next!.java !== undefined) rows.push(`Java: ${next!.java}`);
    } else if (!next) rows.push(`removed ${software(old)}`);
    else {
      if (software(old) !== software(next)) rows.push(`${software(old)} → ${software(next)}`);
      else if (!artifactEqual(old.artifact, next.artifact))
        rows.push(
          ...artifactDetails(old.artifact, next.artifact).map(
            (row) => `${softwareName[next.type]} artifact ${row}`,
          ),
        );
      if (old.java !== next.java)
        rows.push(`Java: ${old.java ?? '(none)'} → ${next.java ?? '(none)'}`);
      if (old.channel !== next.channel)
        rows.push(`channel: ${old.channel ?? '(none)'} → ${next.channel ?? '(none)'}`);
      if (old.image !== next.image) rows.push(`image: ${pair(old.image, next.image)}`);
    }
    for (const change of changes.get(name)!) rows.push(...pluginRows(change, labels));
    if (rows.length) blocks.push(`${name}\n${rows.map((row) => `  ${clean(row)}`).join('\n')}`);
  }
  const heading = options.outdated
    ? blocks.length
      ? 'Available updates (current lock → available selections):'
      : 'No updates found on the configured channels.'
    : !before
      ? 'Created digit.lock with initial selections:'
      : blocks.length
        ? 'Updated digit.lock (previous lock → new lock):'
        : hash(before) !== hash(after)
          ? 'No software updates found. Lockfile metadata refreshed.'
          : 'No updates found. Locked dependencies are unchanged.';
  return [
    heading,
    ...blocks,
    options.outdated
      ? `Manifest and lockfile were not changed.\nRun ${options.updateCommand ?? 'digit update'} to save updates, then ${apply} to apply them.`
      : `Run ${apply} to apply the locked configuration. Running servers have not been changed.`,
  ].join('\n\n');
}

export function updateApplyCommand(
  options: {
    project?: string;
    env?: string;
    profile?: string;
  },
  command: 'up' | 'update' = 'up',
): string {
  const quote = (value: string) =>
    /^[a-zA-Z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
  return [
    'digit',
    ...(options.project && options.project !== '.' ? ['--project', quote(options.project)] : []),
    command,
    ...(options.env && options.env !== 'dev' ? ['--env', quote(options.env)] : []),
    ...(options.profile ? ['--profile', quote(options.profile)] : []),
  ].join(' ');
}
