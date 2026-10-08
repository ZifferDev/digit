import { readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { environmentDirectory, privateWrite } from './deployment';
import { hash } from './config';
import type { Deployment } from './types';

export type DockerRunner = (args: string[]) => Promise<string>;
interface Container {
  Id: string;
  Created: string;
  Config: { Labels?: Record<string, string> };
  Mounts?: { Type: string; Name?: string }[];
}
interface Volume {
  Name: string;
  CreatedAt?: string;
  Labels?: Record<string, string>;
  Driver: string;
  Mountpoint: string;
  Options?: Record<string, string>;
  Scope?: string;
}
interface Network {
  Id: string;
  Created: string;
  Labels?: Record<string, string>;
  Containers?: Record<string, unknown>;
}
interface Snapshot {
  daemon: string;
  containers: Container[];
  volumes: Volume[];
  networks: Network[];
}
const projectLabel = 'com.docker.compose.project';
const confirmationLifetime = 60_000;
const names = (text: string) => [...new Set(text.trim().split(/\s+/).filter(Boolean))].sort();

async function inspect<T>(run: DockerRunner, kind: string, ids: string[]): Promise<T[]> {
  if (!ids.length) return [];
  const result = JSON.parse(await run(['docker', kind, 'inspect', ...ids]));
  if (!Array.isArray(result) || result.length !== ids.length)
    throw new Error(`Unexpected Docker ${kind} inspection result; nothing was deleted.`);
  return result;
}
function owned(labels: Record<string, string> | undefined, project: string, name: string) {
  if (labels?.[projectLabel] !== project)
    throw new Error(
      `Refusing to delete ${name}: its Compose project label does not match this environment.`,
    );
}
async function volumeConsumers(run: DockerRunner, volume: string): Promise<Container[]> {
  const ids = names(
    await run(['docker', 'ps', '--all', '--quiet', '--no-trunc', '--filter', `volume=${volume}`]),
  );
  return (await inspect<Container>(run, 'container', ids)).filter((c) =>
    c.Mounts?.some((m) => m.Type === 'volume' && m.Name === volume),
  );
}
async function assertPrivateVolumes(run: DockerRunner, project: string, volumes: Volume[]) {
  for (const volume of volumes)
    for (const consumer of await volumeConsumers(run, volume.Name)) {
      if (consumer.Config.Labels?.[projectLabel] !== project)
        throw new Error(
          `Refusing to destroy volume ${volume.Name}: it is used by a container outside this environment (${consumer.Id}).`,
        );
    }
}
async function snapshot(run: DockerRunner, project: string): Promise<Snapshot> {
  const daemon = (await run(['docker', 'info', '--format', '{{.ID}}'])).trim();
  if (!daemon || daemon === '<no value>')
    throw new Error(
      'Docker did not report its daemon identity; destruction cannot be confirmed safely.',
    );
  const filter = `label=${projectLabel}=${project}`;
  const containerIds = names(
    await run(['docker', 'ps', '--all', '--quiet', '--no-trunc', '--filter', filter]),
  );
  const volumeNames = names(await run(['docker', 'volume', 'ls', '--quiet', '--filter', filter]));
  const networkIds = names(
    await run(['docker', 'network', 'ls', '--quiet', '--no-trunc', '--filter', filter]),
  );
  const containers = await inspect<Container>(run, 'container', containerIds);
  const volumes = await inspect<Volume>(run, 'volume', volumeNames);
  const networks = await inspect<Network>(run, 'network', networkIds);
  for (const c of containers) owned(c.Config.Labels, project, c.Id);
  for (const v of volumes) owned(v.Labels, project, v.Name);
  for (const n of networks) {
    owned(n.Labels, project, n.Id);
    if (Object.keys(n.Containers ?? {}).some((id) => !containerIds.includes(id)))
      throw new Error(
        `Refusing to destroy network ${n.Id}: another container is attached outside this environment.`,
      );
  }
  await assertPrivateVolumes(run, project, volumes);
  // Runtime state changes (health, log output, restarts) do not alter resource identity.
  return {
    daemon,
    containers: containers
      .map((c) => ({
        Id: c.Id,
        Created: c.Created,
        Config: { Labels: c.Config.Labels },
        Mounts: c.Mounts?.map((m) => ({ Type: m.Type, Name: m.Name })),
      }))
      .sort((a, b) => a.Id.localeCompare(b.Id)),
    volumes: volumes
      .map((v) => ({
        Name: v.Name,
        CreatedAt: v.CreatedAt,
        Driver: v.Driver,
        Mountpoint: v.Mountpoint,
        Options: v.Options,
        Scope: v.Scope,
        Labels: v.Labels,
      }))
      .sort((a, b) => a.Name.localeCompare(b.Name)),
    networks: networks
      .map((n) => ({ Id: n.Id, Created: n.Created, Labels: n.Labels }))
      .sort((a, b) => a.Id.localeCompare(b.Id)),
  };
}

/** Two invocations against the same resource snapshot authorize one destructive attempt. */
export async function destroyEnvironment(
  d: Deployment,
  dependencies: { run: DockerRunner; now?: () => number; log?: (message: string) => void },
): Promise<'armed' | 'destroyed'> {
  const { run } = dependencies;
  const log = dependencies.log ?? console.log;
  const now = dependencies.now ?? Date.now;
  const envDir = dirname(dirname(resolve(d.directory)));
  const root = await realpath(dirname(dirname(dirname(envDir))));
  if (
    envDir !== (await environmentDirectory(root, d.environment)) ||
    resolve(d.composeFile) !== join(resolve(d.directory), 'compose.yaml')
  )
    throw new Error('Invalid deployment paths; refusing to remove local state.');
  const identity = (await readFile(join(root, '.digit', 'identity'), 'utf8')).trim();
  if (
    !/^[a-f0-9]{12}$/.test(identity) ||
    !d.projectName.startsWith('digit-') ||
    !d.projectName.endsWith(`-${identity}-${d.environment}`)
  )
    throw new Error('Deployment identity does not match this checkout; refusing destruction.');
  const resources = await snapshot(run, d.projectName);
  const binding = hash({
    action: 'down --destroy-all-data',
    root,
    identity,
    environment: d.environment,
    project: d.projectName,
    fingerprint: d.fingerprint,
    resources,
  });
  const recordPath = join(envDir, 'destroy-confirmation.json');
  let previous: { binding: string; armedAt: number } | undefined;
  try {
    previous = JSON.parse(await readFile(recordPath, 'utf8'));
  } catch {
    /* Missing or invalid confirmation always requires a fresh warning. */
  }
  const timestamp = now();
  if (
    !previous ||
    previous.binding !== binding ||
    !Number.isFinite(previous.armedAt) ||
    timestamp < previous.armedAt ||
    timestamp - previous.armedAt > confirmationLifetime
  ) {
    await privateWrite(recordPath, JSON.stringify({ binding, armedAt: timestamp }));
    const reason = previous
      ? 'The previous confirmation expired or the deployment/resources changed. '
      : '';
    log(
      `${reason}WARNING: This permanently deletes all worlds, player data, plugin data, databases, containers, and local environment state for ${d.manifest.name} / ${d.environment}.\nScope: ${resources.containers.length} containers, ${resources.volumes.length} volumes (including retained volumes from removed services), ${resources.networks.length} networks.\nNothing has been stopped or deleted. Repeat the same down --destroy-all-data command for this project and environment within 60 seconds to confirm.`,
    );
    return 'armed';
  }
  // Consume before the first destructive call. Any failure requires a fresh two-call confirmation.
  await rm(recordPath, { force: true });
  try {
    const containerIds = resources.containers.map((c) => c.Id);
    if (containerIds.length) {
      await run(['docker', 'container', 'stop', '--time', '120', ...containerIds]);
      await run(['docker', 'container', 'rm', ...containerIds]);
    }
    // Recheck references after containers stop; Docker itself also refuses in-use volume removal.
    await assertPrivateVolumes(run, d.projectName, resources.volumes);
    if (resources.volumes.length)
      await run(['docker', 'volume', 'rm', ...resources.volumes.map((v) => v.Name)]);
    if (resources.networks.length)
      await run(['docker', 'network', 'rm', ...resources.networks.map((n) => n.Id)]);
    const remaining = await snapshot(run, d.projectName);
    if (
      remaining.daemon !== resources.daemon ||
      remaining.containers.length ||
      remaining.volumes.length ||
      remaining.networks.length
    )
      throw new Error(
        'Docker resources changed while deleting this environment. Remaining resources and local state were retained.',
      );
    await rm(envDir, { recursive: true });
  } catch (error) {
    throw new Error(
      `Environment destruction did not finish: ${error instanceof Error ? error.message : error}\nLocal environment metadata was retained. Inspect Docker resources, then repeat down --destroy-all-data twice to authorize another attempt.`,
    );
  }
  log(
    `Destroyed ${d.environment}: all its containers, volumes, networks, and local environment state were removed. Other environments, the project identity, Git files, and EULA consent were retained.`,
  );
  return 'destroyed';
}
