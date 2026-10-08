import { createHash } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type {
  Artifact,
  Lockfile,
  LockedPlugin,
  LockedService,
  Manifest,
  PaperVersion,
  Project,
  Service,
} from './types';

const PAPER = 'https://fill.papermc.io/v3/projects';
const MODRINTH = 'https://api.modrinth.com/v2';
const USER_AGENT = 'digit/0.1.0-rc.2 (declarative Minecraft server CLI)';
const hex256 = z.string().regex(/^[a-f0-9]{64}$/);
const hex512 = z.string().regex(/^[a-f0-9]{128}$/);
const filename = z
  .string()
  .regex(/^[^/\\\x00-\x1f]+\.jar$/)
  .refine((v) => !v.startsWith('.'), 'unsafe artifact filename');
const artifactSchema = z
  .object({
    url: z.url().refine((v) => v.startsWith('https://'), 'artifact URLs must use HTTPS'),
    filename,
    sha256: hex256.optional(),
    sha512: hex512.optional(),
  })
  .refine((v) => !!(v.sha256 || v.sha512), 'artifact checksum is required');
const pluginName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const pluginSchema = artifactSchema.safeExtend({
  name: pluginName.optional(),
  aliases: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/)).optional(),
  project: pluginName,
  version: z.string().min(1),
});
const lockedServiceSchema = z
  .object({
    inputHash: hex256.optional(),
    softwareInputHash: hex256.optional(),
    type: z.enum(['paper', 'velocity', 'mariadb']),
    version: z
      .string()
      .min(1)
      .refine((v) => v !== 'latest'),
    build: z.number().int().positive().optional(),
    java: z.number().int().positive().optional(),
    channel: z.string().optional(),
    image: z
      .string()
      .regex(/^(?:itzg\/(?:minecraft-server|mc-proxy)|mariadb)@sha256:[a-f0-9]{64}$/),
    artifact: artifactSchema.optional(),
    plugins: z.array(pluginSchema),
  })
  .superRefine((v, ctx) => {
    const repository =
      v.type === 'paper'
        ? 'itzg/minecraft-server'
        : v.type === 'velocity'
          ? 'itzg/mc-proxy'
          : 'mariadb';
    if (!v.image.startsWith(`${repository}@`))
      ctx.addIssue({ code: 'custom', message: 'image does not match service type' });
    if (v.type !== 'mariadb' && (!v.artifact || !v.build || !v.java))
      ctx.addIssue({
        code: 'custom',
        message: 'Minecraft service requires artifact, build, and Java version',
      });
  });
const lockSchema = z.object({
  schema: z.literal(1),
  inputHash: hex256,
  services: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/), lockedServiceSchema),
});

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}
function softwareDependencies(service: Service) {
  return {
    type: service.type,
    version: service.version,
    build: service.build,
    channel: service.channel,
  };
}
function serviceDependencies(manifest: Manifest, service: Service) {
  return {
    ...softwareDependencies(service),
    plugins: [...service.plugins].sort().map((name) => ({ name, ...manifest.plugins[name] })),
  };
}
export function dependencyHash(manifest: Manifest): string {
  return digest(
    Object.fromEntries(
      Object.entries(manifest.services).map(([name, service]) => [
        name,
        serviceDependencies(manifest, service),
      ]),
    ),
  );
}

async function request(url: string, init: RequestInit = {}, timeout = 30_000): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: { 'User-Agent': USER_AGENT, ...init.headers },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      if (attempt < 2) {
        await Bun.sleep(300 * (attempt + 1));
        continue;
      }
      throw new Error(
        `Could not reach ${new URL(url).hostname}: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (response.ok) return response;
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      const delay = Math.min(3000, Number(response.headers.get('retry-after') || 1) * 1000);
      await response.body?.cancel();
      await Bun.sleep(Number.isFinite(delay) ? delay : 1000);
      continue;
    }
    await response.body?.cancel();
    throw new Error(
      `Request failed (${response.status}) for ${url}${response.status === 429 ? '. Registry/API rate limit reached; retry shortly.' : ''}`,
    );
  }
  throw new Error(`Request failed for ${url}`);
}
async function json<T>(url: string): Promise<T> {
  return (await (await request(url)).json()) as T;
}
interface FillVersion {
  version: { id: string; support: { status: string }; java: { version: { minimum: number } } };
  builds: number[];
}
interface FillBuild {
  id: number;
  channel: string;
  downloads: Record<string, { name: string; url: string; checksums: { sha256: string } }>;
}
async function versions(project: string): Promise<FillVersion[]> {
  const data = await json<{ versions: FillVersion[] }>(`${PAPER}/${project}/versions`);
  if (!Array.isArray(data.versions) || !data.versions.length)
    throw new Error(`PaperMC returned no ${project} versions.`);
  return data.versions;
}

/** The catalog deliberately includes unsupported and prerelease Minecraft versions. */
export async function listPaperVersions(): Promise<PaperVersion[]> {
  const all = await versions('paper');
  const results: PaperVersion[] = new Array(all.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (next < all.length) {
        const i = next++;
        const row = all[i]!;
        const latest = row.builds.length
          ? await json<FillBuild>(
              `${PAPER}/paper/versions/${encodeURIComponent(row.version.id)}/builds/latest`,
            )
          : undefined;
        results[i] = {
          id: row.version.id,
          supported: row.version.support.status === 'SUPPORTED',
          experimental:
            /(?:rc|pre|snapshot)/i.test(row.version.id) ||
            (!!latest && latest.channel !== 'STABLE'),
          java: row.version.java.version.minimum,
        };
      }
    }),
  );
  return results;
}

async function resolveSoftware(
  service: Service,
): Promise<Omit<LockedService, 'image' | 'plugins'>> {
  const all = await versions(service.type);
  const candidates =
    service.version === 'latest' ? all : all.filter((v) => v.version.id === service.version);
  if (!candidates.length)
    throw new Error(
      `Unknown ${service.type} version "${service.version}". Run digit init to browse available versions.`,
    );
  for (const candidate of candidates) {
    if (
      !candidate.builds.length ||
      (service.channel === 'stable' && /(?:rc|pre|snapshot)/i.test(candidate.version.id))
    )
      continue;
    const base = `${PAPER}/${service.type}/versions/${encodeURIComponent(candidate.version.id)}/builds`;
    const builds =
      service.build === 'latest'
        ? await json<FillBuild[]>(base)
        : [await json<FillBuild>(`${base}/${encodeURIComponent(service.build)}`)];
    const selected = builds
      .filter((b) => service.channel === 'experimental' || b.channel === 'STABLE')
      .sort((a, b) => b.id - a.id)[0];
    if (!selected) continue;
    const download = selected.downloads['server:default'];
    if (!download) throw new Error(`PaperMC build ${selected.id} has no server download.`);
    const artifact = artifactSchema.parse({
      url: download.url,
      filename: download.name,
      sha256: download.checksums.sha256,
    });
    return {
      type: service.type,
      version: candidate.version.id,
      build: selected.id,
      channel: selected.channel,
      java: candidate.version.java.version.minimum,
      artifact,
    };
  }
  throw new Error(
    `No ${service.channel} ${service.type} build matches ${service.version}/${service.build}. To allow prerelease builds, set channel = "experimental" explicitly.`,
  );
}

async function imageDigest(repository: string, tag: string): Promise<string> {
  const path = repository.includes('/') ? repository : `library/${repository}`;
  const token = await json<{ token: string }>(
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${path}:pull`,
  );
  const response = await request(`https://registry-1.docker.io/v2/${path}/manifests/${tag}`, {
    headers: {
      Authorization: `Bearer ${token.token}`,
      Accept:
        'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json',
    },
  });
  const bytes = await response.arrayBuffer();
  const index = JSON.parse(new TextDecoder().decode(bytes)) as {
    manifests?: { platform?: { os: string; architecture: string } }[];
  };
  for (const architecture of ['arm64', 'amd64']) {
    if (
      !index.manifests?.some(
        (m) => m.platform?.os === 'linux' && m.platform.architecture === architecture,
      )
    ) {
      throw new Error(
        `${repository}:${tag} does not support Linux ${architecture}; digit requires ARM64 and AMD64 images.`,
      );
    }
  }
  const hash = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
  const advertised = response.headers.get('docker-content-digest');
  if (advertised && advertised !== `sha256:${hash}`)
    throw new Error(`Image manifest checksum mismatch for ${repository}:${tag}.`);
  return `${repository}@sha256:${hash}`;
}

interface ModrinthVersion {
  id: string;
  project_id: string;
  version_number: string;
  version_type: string;
  date_published: string;
  loaders: string[];
  game_versions: string[];
  files: {
    url: string;
    filename: string;
    primary: boolean;
    hashes: { sha512?: string; sha256?: string };
  }[];
  dependencies: {
    dependency_type: string;
    project_id?: string | null;
    version_id?: string | null;
  }[];
}
async function resolvePlugins(
  manifest: Manifest,
  service: Service,
  minecraft: string,
): Promise<LockedPlugin[]> {
  const selected = new Map<string, ModrinthVersion>();
  const visited = new Set<string>();
  const loaders = service.type === 'velocity' ? ['velocity'] : ['paper', 'spigot', 'bukkit'];
  const compatible = (v: ModrinthVersion) =>
    v.loaders.some((l) => loaders.includes(l)) &&
    (service.type === 'velocity' || v.game_versions.includes(minecraft));
  async function find(project: string, wanted = 'latest'): Promise<ModrinthVersion> {
    if (wanted !== 'latest') {
      const version = await json<ModrinthVersion>(
        `${MODRINTH}/project/${encodeURIComponent(project)}/version/${encodeURIComponent(wanted)}`,
      );
      if (!compatible(version))
        throw new Error(
          `Modrinth ${project}@${wanted} is incompatible with ${service.type} ${minecraft}.`,
        );
      return version;
    }
    const params = new URLSearchParams({
      loaders: JSON.stringify(loaders),
      include_changelog: 'false',
    });
    if (service.type === 'paper') params.set('game_versions', JSON.stringify([minecraft]));
    const choices = await json<ModrinthVersion[]>(
      `${MODRINTH}/project/${encodeURIComponent(project)}/version?${params}`,
    );
    const version = choices
      .filter((v) => compatible(v) && v.version_type === 'release')
      .sort((a, b) => b.date_published.localeCompare(a.date_published))[0];
    if (!version)
      throw new Error(
        `No compatible Modrinth release for ${project} on ${service.type} ${minecraft}. Choose an explicit compatible plugin version or another Minecraft version.`,
      );
    return version;
  }
  async function add(version: ModrinthVersion): Promise<void> {
    if (!compatible(version))
      throw new Error(
        `Required plugin ${version.project_id}@${version.id} is incompatible with ${service.type} ${minecraft}.`,
      );
    const existing = selected.get(version.project_id);
    if (existing) {
      if (existing.id !== version.id)
        throw new Error(
          `Conflicting versions required for Modrinth project ${version.project_id}: ${existing.id} and ${version.id}.`,
        );
    }
    if (visited.has(version.id)) return;
    visited.add(version.id);
    selected.set(version.project_id, version);
    for (const dep of version.dependencies.filter((d) => d.dependency_type === 'required')) {
      if (dep.version_id)
        await add(
          await json<ModrinthVersion>(`${MODRINTH}/version/${encodeURIComponent(dep.version_id)}`),
        );
      else if (dep.project_id)
        await add(selected.get(dep.project_id) ?? (await find(dep.project_id)));
      else
        throw new Error(
          `Plugin ${version.project_id} requires an external dependency that Modrinth cannot resolve.`,
        );
    }
  }
  // Resolve explicit roots first so unpinned dependency edges can reuse the user's selected versions.
  const roots: ModrinthVersion[] = [];
  const aliases = new Map<string, string[]>();
  for (const name of service.plugins) {
    const plugin = manifest.plugins[name];
    if (!plugin) throw new Error(`Undefined plugin "${name}".`);
    const version = await find(plugin.project, plugin.version);
    roots.push(version);
    aliases.set(version.project_id, [...(aliases.get(version.project_id) ?? []), name].sort());
  }
  for (const root of roots) {
    const existing = selected.get(root.project_id);
    if (existing && existing.id !== root.id)
      throw new Error(`Conflicting configured plugin versions for ${root.project_id}.`);
    selected.set(root.project_id, root);
  }
  // Visit dependency graphs separately from the root selection map to support cycles safely.
  for (const root of roots) await add(root);
  for (const version of selected.values())
    for (const dep of version.dependencies.filter((d) => d.dependency_type === 'incompatible')) {
      if (
        [...selected.values()].some((v) =>
          dep.version_id ? v.id === dep.version_id : v.project_id === dep.project_id,
        )
      ) {
        throw new Error(
          `Modrinth reports an incompatible plugin dependency for ${version.project_id}.`,
        );
      }
    }
  const filenames = new Set<string>();
  return [...selected.values()]
    .map((v) => {
      const jars = v.files.filter((f) => f.filename.endsWith('.jar'));
      const file = jars.find((f) => f.primary) ?? (jars.length === 1 ? jars[0] : undefined);
      if (!file)
        throw new Error(`Modrinth ${v.project_id}@${v.id} has no unambiguous primary JAR.`);
      if (filenames.has(file.filename))
        throw new Error(`Two plugins use filename ${file.filename}; cannot safely install both.`);
      filenames.add(file.filename);
      return pluginSchema.parse({
        name: aliases.get(v.project_id)?.[0] ?? v.project_id,
        aliases: aliases.get(v.project_id) ?? [],
        project: v.project_id,
        version: v.id,
        filename: file.filename,
        url: file.url,
        ...file.hashes,
      });
    })
    .sort((a, b) => a.project.localeCompare(b.project));
}

/** Upgrade filename metadata on older locks without resolving any dependency versions. */
async function nameLockedPlugins(
  manifest: Manifest,
  service: Service,
  plugins: LockedPlugin[],
  projectIds: Map<string, Promise<string>>,
): Promise<LockedPlugin[]> {
  if (plugins.every((plugin) => plugin.name !== undefined && plugin.aliases !== undefined))
    return plugins;
  const projects = new Set(plugins.map((plugin) => plugin.project));
  const aliases = new Map<string, string[]>();
  for (const alias of service.plugins) {
    const configured = manifest.plugins[alias]!;
    const annotated = plugins.find((plugin) => plugin.aliases?.includes(alias));
    let id = annotated?.project ?? configured.project;
    if (!annotated && !projects.has(id)) {
      if (!projectIds.has(id)) {
        projectIds.set(
          id,
          json<{ id: string }>(`${MODRINTH}/project/${encodeURIComponent(id)}`).then((project) =>
            pluginName.parse(project.id),
          ),
        );
      }
      id = await projectIds.get(id)!;
    }
    if (!projects.has(id))
      throw new Error(
        `Locked plugin for manifest alias "${alias}" is missing. Run digit update to repair the lockfile.`,
      );
    aliases.set(id, [...(aliases.get(id) ?? []), alias].sort());
  }
  return plugins.map((plugin) => ({
    ...plugin,
    name: aliases.get(plugin.project)?.[0] ?? plugin.project,
    aliases: aliases.get(plugin.project) ?? [],
  }));
}

export async function resolveLock(
  manifest: Manifest,
  previous?: Lockfile,
  update = false,
): Promise<Lockfile> {
  if (previous) previous = lockSchema.parse(previous);
  const inputHash = dependencyHash(manifest);
  const pluginProjectIds = new Map<string, Promise<string>>();
  if (!update && previous?.inputHash === inputHash) {
    const services = { ...previous.services };
    for (const [name, service] of Object.entries(manifest.services)) {
      const prior = services[name];
      if (!prior) throw new Error(`Lockfile is missing service "${name}". Run digit update.`);
      services[name] = {
        ...prior,
        plugins: await nameLockedPlugins(manifest, service, prior.plugins, pluginProjectIds),
      };
    }
    return { ...previous, services };
  }
  const services: Record<string, LockedService> = {};
  const images = new Map<string, Promise<string>>();
  function image(repository: string, tag: string) {
    const key = `${repository}:${tag}`;
    if (!images.has(key)) images.set(key, imageDigest(repository, tag));
    return images.get(key)!;
  }
  for (const [name, service] of Object.entries(manifest.services)) {
    const serviceHash = digest(serviceDependencies(manifest, service));
    const softwareInputHash = digest(softwareDependencies(service));
    const prior = previous?.services[name];
    if (!update && prior?.inputHash === serviceHash) {
      services[name] = {
        ...prior,
        plugins: await nameLockedPlugins(manifest, service, prior.plugins, pluginProjectIds),
      };
      continue;
    }
    try {
      if (service.type === 'mariadb') {
        const version = service.version === 'latest' ? '11.8' : service.version;
        services[name] = {
          inputHash: serviceHash,
          softwareInputHash,
          type: 'mariadb',
          version,
          image: await image('mariadb', version),
          plugins: [],
        };
      } else {
        const reuseSoftware = !update && prior?.softwareInputHash === softwareInputHash;
        const software = reuseSoftware ? prior : await resolveSoftware(service);
        const repository = service.type === 'paper' ? 'itzg/minecraft-server' : 'itzg/mc-proxy';
        services[name] = {
          ...software,
          inputHash: serviceHash,
          softwareInputHash,
          image: reuseSoftware ? prior.image : await image(repository, `java${software.java}`),
          plugins: await resolvePlugins(manifest, service, software.version),
        };
      }
    } catch (error) {
      throw new Error(`Service "${name}": ${error instanceof Error ? error.message : error}`);
    }
  }
  return lockSchema.parse({ schema: 1, inputHash, services });
}

export async function ensureLock(
  project: Project,
  options: { update?: boolean; frozen?: boolean } = {},
): Promise<Lockfile> {
  const path = join(project.root, 'digit.lock');
  let previous: Lockfile | undefined;
  if (await Bun.file(path).exists()) {
    try {
      previous = lockSchema.parse(await Bun.file(path).json());
    } catch (error) {
      throw new Error(
        `Invalid digit.lock: ${error instanceof Error ? error.message : error}. Restore it from Git or remove it and resolve again.`,
      );
    }
  }
  if (options.frozen && (!previous || previous.inputHash !== dependencyHash(project.manifest)))
    throw new Error(
      'digit.lock is missing or does not match the manifest. Run digit update and commit the lockfile before using --frozen.',
    );
  if (options.frozen && options.update)
    throw new Error('--frozen cannot be combined with an update.');
  const lock = await resolveLock(project.manifest, previous, options.update);
  if (stable(lock) !== stable(previous)) {
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await Bun.write(temporary, `${JSON.stringify(lock, null, 2)}\n`);
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return lock;
}

async function verify(path: string, artifact: Artifact): Promise<boolean> {
  if (!(await Bun.file(path).exists())) return false;
  const bytes = await Bun.file(path).arrayBuffer();
  return (
    (!artifact.sha256 ||
      createHash('sha256').update(new Uint8Array(bytes)).digest('hex') === artifact.sha256) &&
    (!artifact.sha512 ||
      createHash('sha512').update(new Uint8Array(bytes)).digest('hex') === artifact.sha512)
  );
}
/** Content-addressed cache never replaces a missing upstream artifact with another version. */
export async function fetchArtifact(input: Artifact, destination: string): Promise<void> {
  const artifact = artifactSchema.parse(input);
  if (await verify(destination, artifact)) return;
  const cacheRoot = join(
    process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
    'digit',
    'artifacts',
  );
  await mkdir(cacheRoot, { recursive: true });
  const cache = join(cacheRoot, artifact.sha512 || artifact.sha256!);
  if (!(await verify(cache, artifact))) {
    const response = await request(artifact.url, {}, 120_000);
    const temporary = `${cache}.${crypto.randomUUID()}.tmp`;
    try {
      await Bun.write(temporary, response);
      if (!(await verify(temporary, artifact)))
        throw new Error(
          `Checksum mismatch downloading ${artifact.filename}. The locked artifact was not installed.`,
        );
      await rename(temporary, cache);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temporary, Bun.file(cache));
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}
