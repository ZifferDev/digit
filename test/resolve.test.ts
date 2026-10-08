import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dependencyHash,
  ensureLock,
  fetchArtifact,
  listPaperVersions,
  resolveLock,
} from '../src/resolve';
import type { Manifest, Service } from '../src/types';

const originalFetch = globalThis.fetch;
const originalCache = process.env.XDG_CACHE_HOME;
const temporary: string[] = [];
afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalCache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalCache;
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function temp() {
  const path = await mkdtemp(join(tmpdir(), 'digit-resolver-'));
  temporary.push(path);
  return path;
}
const service = (overrides: Partial<Service> = {}): Service => ({
  type: 'paper',
  version: '1.21.11',
  build: 'latest',
  channel: 'stable',
  memory: '2G',
  plugins: [],
  properties: {},
  env: {},
  ...overrides,
});
const manifest = (s = service()): Manifest => ({
  schema: 1,
  name: 'test',
  network: { bind: '127.0.0.1', port: 25565, motd: 'Test' },
  services: { survival: s },
  plugins: {},
});
const version = (id: string, supported = true) => ({
  version: {
    id,
    support: { status: supported ? 'SUPPORTED' : 'UNSUPPORTED' },
    java: { version: { minimum: 21 } },
  },
  builds: [1, 2],
});
const build = (id: number, channel = 'STABLE') => ({
  id,
  channel,
  downloads: {
    'server:default': {
      name: `paper-${id}.jar`,
      url: `https://example.com/paper-${id}.jar`,
      checksums: { sha256: 'a'.repeat(64) },
    },
  },
});
const plugin = (id: string, project: string, dependencies: any[] = []) => ({
  id,
  project_id: project,
  version_number: '1.0',
  version_type: 'release',
  date_published: '2026-01-01',
  loaders: ['paper'],
  game_versions: ['1.21.11'],
  dependencies,
  files: [
    {
      primary: true,
      filename: `${project}.jar`,
      url: `https://example.com/${project}.jar`,
      hashes: { sha512: 'b'.repeat(128) },
    },
  ],
});
function network(
  extra: (url: string) => unknown = () => undefined,
  architectures = ['arm64', 'amd64'],
) {
  const calls: string[] = [];
  globalThis.fetch = mock(async (input: any) => {
    const url = String(input);
    calls.push(url);
    const special = extra(url);
    if (special !== undefined) return Response.json(special);
    if (url.endsWith('/projects/paper/versions'))
      return Response.json({ versions: [version('1.21.11')] });
    if (url.endsWith('/builds/latest')) return Response.json(build(2));
    if (url.endsWith('/builds')) return Response.json([build(2, 'BETA'), build(1)]);
    if (url.includes('auth.docker.io/token')) return Response.json({ token: 'test' });
    if (url.includes('registry-1.docker.io'))
      return Response.json({
        manifests: architectures.map((architecture) => ({
          platform: { os: 'linux', architecture },
        })),
      });
    throw new Error(`Unexpected request: ${url}`);
  }) as unknown as typeof fetch;
  return calls;
}

describe('dependency locking', () => {
  test('hash ignores deployment settings and includes dependency changes', () => {
    const a = manifest();
    const b = structuredClone(a);
    b.name = 'renamed';
    b.network.port = 12345;
    b.services.survival!.memory = '4G';
    b.services.survival!.properties.difficulty = 'hard';
    expect(dependencyHash(a)).toBe(dependencyHash(b));
    b.services.survival!.version = '26.2';
    expect(dependencyHash(a)).not.toBe(dependencyHash(b));
  });
  test('catalog preserves every version and flags build-channel experimental versions', async () => {
    network((url) =>
      url.endsWith('/projects/paper/versions')
        ? { versions: [version('26.3'), version('26.3-rc-3', false)] }
        : url.includes('/26.3/')
          ? build(2, 'BETA')
          : undefined,
    );
    const result = await listPaperVersions();
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: '26.3', supported: true, experimental: true, java: 21 });
    expect(result[1]!.supported).toBe(false);
  });
  test('stable excludes newer beta builds, locks index digests and reuses offline', async () => {
    const calls = network();
    const m = manifest();
    const first = await resolveLock(m);
    expect(first.services.survival!.build).toBe(1);
    expect(first.services.survival!.image).toMatch(/^itzg\/minecraft-server@sha256:[a-f0-9]{64}$/);
    const count = calls.length;
    expect(await resolveLock(m, first)).toEqual(first);
    expect(calls).toHaveLength(count);
    const experimental = await resolveLock(manifest(service({ channel: 'experimental' })));
    expect(experimental.services.survival!.build).toBe(2);
  });
  test('stable latest skips prerelease version IDs even if their build channel says stable', async () => {
    network((url) =>
      url.endsWith('/projects/paper/versions')
        ? { versions: [version('26.3-rc-3'), version('1.21.11')] }
        : undefined,
    );
    const lock = await resolveLock(manifest(service({ version: 'latest' })));
    expect(lock.services.survival!.version).toBe('1.21.11');
  });
  test('an unrelated service addition does not upgrade an existing service', async () => {
    const calls = network();
    const m = manifest();
    const first = await resolveLock(m);
    const requestsBefore = calls.filter((c) => c.endsWith('/builds')).length;
    m.services.database = service({ type: 'mariadb', version: '11.8' });
    const second = await resolveLock(m, first);
    expect(second.services.survival).toEqual(first.services.survival);
    expect(calls.filter((c) => c.endsWith('/builds'))).toHaveLength(requestsBefore);
  });
  test('removing a plugin preserves the server build and image without contacting Paper or Docker', async () => {
    const calls = network((url) =>
      url.includes('/project/example/version?') ? [plugin('plugin1', 'example')] : undefined,
    );
    const m = manifest(service({ plugins: ['example'] }));
    m.plugins.example = { source: 'modrinth', project: 'example', version: 'latest' };
    const first = await resolveLock(m);
    const before = calls.length;
    m.services.survival!.plugins = [];
    const second = await resolveLock(m, first);
    expect(second.services.survival!.build).toBe(first.services.survival!.build);
    expect(second.services.survival!.image).toBe(first.services.survival!.image);
    expect(second.services.survival!.plugins).toHaveLength(0);
    expect(calls).toHaveLength(before);
  });
  test('root filenames use sorted manifest aliases and reused locks stay offline', async () => {
    const calls = network((url) =>
      url.includes('/project/upstream-slug/version?')
        ? [plugin('pinned1', 'ProjectID')]
        : undefined,
    );
    const m = manifest(service({ plugins: ['z_alias', 'my_plugin'] }));
    m.plugins = {
      z_alias: { source: 'modrinth', project: 'upstream-slug', version: 'latest' },
      my_plugin: { source: 'modrinth', project: 'upstream-slug', version: 'latest' },
    };
    const lock = await resolveLock(m);
    expect(lock.services.survival!.plugins).toHaveLength(1);
    expect(lock.services.survival!.plugins[0]!.name).toBe('my_plugin');
    expect(lock.services.survival!.plugins[0]!.aliases).toEqual(['my_plugin', 'z_alias']);
    const count = calls.length;
    expect(await resolveLock(m, lock)).toEqual(lock);
    expect(calls).toHaveLength(count);
  });
  test('older unchanged locks gain aliases using metadata only, preserving every pinned artifact', async () => {
    network((url) =>
      url.includes('/project/upstream-slug/version?')
        ? [plugin('pinned1', 'ProjectID')]
        : undefined,
    );
    const m = manifest(service({ plugins: ['my_plugin'] }));
    m.plugins.my_plugin = { source: 'modrinth', project: 'upstream-slug', version: 'latest' };
    const prior = await resolveLock(m);
    for (const p of prior.services.survival!.plugins) {
      delete p.name;
      delete p.aliases;
    }
    const calls: string[] = [];
    globalThis.fetch = mock(async (url: any) => {
      calls.push(String(url));
      if (String(url) === 'https://api.modrinth.com/v2/project/upstream-slug')
        return Response.json({ id: 'ProjectID', slug: 'upstream-slug' });
      throw new Error('Unexpected dependency resolution during lock metadata migration');
    }) as unknown as typeof fetch;
    const migrated = await resolveLock(m, prior);
    expect(calls).toEqual(['https://api.modrinth.com/v2/project/upstream-slug']);
    expect(migrated.services.survival!.plugins[0]).toEqual({
      ...prior.services.survival!.plugins[0]!,
      name: 'my_plugin',
      aliases: ['my_plugin'],
    });
    expect(migrated.services.survival!.image).toBe(prior.services.survival!.image);
    expect(migrated.services.survival!.artifact).toEqual(prior.services.survival!.artifact);
    expect(migrated.inputHash).toBe(prior.inputHash);
    await resolveLock(m, migrated);
    expect(calls).toHaveLength(1);
  });
  test('older project-ID locks gain aliases without any network calls', async () => {
    const calls = network((url) =>
      url.includes('/project/ProjectID/version?') ? [plugin('pinned1', 'ProjectID')] : undefined,
    );
    const m = manifest(service({ plugins: ['readable'] }));
    m.plugins.readable = { source: 'modrinth', project: 'ProjectID', version: 'latest' };
    const prior = await resolveLock(m);
    delete prior.services.survival!.plugins[0]!.name;
    delete prior.services.survival!.plugins[0]!.aliases;
    const count = calls.length;
    expect((await resolveLock(m, prior)).services.survival!.plugins[0]!.name).toBe('readable');
    expect(calls).toHaveLength(count);
  });
  test('lockfile plugin filename labels cannot contain traversal or path separators', async () => {
    network((url) =>
      url.includes('/project/example/version?') ? [plugin('pinned1', 'example')] : undefined,
    );
    const m = manifest(service({ plugins: ['example'] }));
    m.plugins.example = { source: 'modrinth', project: 'example', version: 'latest' };
    const prior = await resolveLock(m);
    prior.services.survival!.plugins[0]!.name = '../unsafe';
    await expect(resolveLock(m, prior)).rejects.toThrow();
  });
  test('service names permit underscores consistently with the manifest', async () => {
    network();
    const m = manifest();
    m.services = { my_server: service() };
    expect((await resolveLock(m)).services.my_server).toBeDefined();
  });
  test('refuses images lacking either required architecture', async () => {
    network(() => undefined, ['amd64']);
    await expect(resolveLock(manifest())).rejects.toThrow('does not support Linux arm64');
  });
  test('rejects stale frozen lock and malformed lock rather than resolving', async () => {
    const root = await temp();
    await expect(ensureLock({ root, manifest: manifest() }, { frozen: true })).rejects.toThrow(
      'missing or does not match',
    );
    await Bun.write(join(root, 'digit.lock'), '{"schema":1,"inputHash":"bad","services":{}}');
    await expect(ensureLock({ root, manifest: manifest() })).rejects.toThrow('Invalid digit.lock');
  });
  test('validates explicit Modrinth versions against the server Minecraft version', async () => {
    network((url) =>
      url.includes('/project/example/version/pinned')
        ? { ...plugin('pinned', 'example'), game_versions: ['1.20'] }
        : undefined,
    );
    const m = manifest(service({ plugins: ['example'] }));
    m.plugins.example = { source: 'modrinth', project: 'example', version: 'pinned' };
    await expect(resolveLock(m)).rejects.toThrow('incompatible with paper 1.21.11');
  });
  test('resolves required dependencies, handles cycles, ignores optional ones', async () => {
    const rootPlugin = plugin('root1', 'root', [
      { dependency_type: 'required', version_id: 'dep1', project_id: 'dep' },
      { dependency_type: 'optional', project_id: 'optional' },
    ]);
    const depPlugin = plugin('dep1', 'dep', [
      { dependency_type: 'required', version_id: 'root1', project_id: 'root' },
    ]);
    const calls = network((url) =>
      url.includes('/project/root/version?')
        ? [rootPlugin]
        : url.endsWith('/version/dep1')
          ? depPlugin
          : url.endsWith('/version/root1')
            ? rootPlugin
            : undefined,
    );
    const m = manifest(service({ plugins: ['root'] }));
    m.plugins.root = { source: 'modrinth', project: 'root', version: 'latest' };
    const result = await resolveLock(m);
    expect(result.services.survival!.plugins.map((p) => p.project)).toEqual(['dep', 'root']);
    expect(result.services.survival!.plugins.find((p) => p.project === 'dep')).toMatchObject({
      name: 'dep',
      aliases: [],
    });
    expect(calls.some((c) => c.includes('optional'))).toBe(false);
  });
  test('a required dependency honors a separately configured pinned root', async () => {
    const rootPlugin = plugin('root1', 'root', [
      { dependency_type: 'required', project_id: 'dep' },
    ]);
    const depPlugin = plugin('dep1', 'dep');
    network((url) =>
      url.includes('/project/root/version?')
        ? [rootPlugin]
        : url.endsWith('/project/dep/version/pinned')
          ? depPlugin
          : undefined,
    );
    const m = manifest(service({ plugins: ['root', 'dep'] }));
    m.plugins = {
      root: { source: 'modrinth', project: 'root', version: 'latest' },
      dep: { source: 'modrinth', project: 'dep', version: 'pinned' },
    };
    expect((await resolveLock(m)).services.survival!.plugins).toHaveLength(2);
  });
});

describe('artifact integrity', () => {
  test('verifies download and cache, replacing corrupted destination from cache offline', async () => {
    const directory = await temp();
    process.env.XDG_CACHE_HOME = directory;
    const content = 'test jar contents';
    const sha256 = createHash('sha256').update(content).digest('hex');
    const artifact = { filename: 'test.jar', sha256, url: 'https://example.com/test.jar' };
    const fetchMock = mock(async () => new Response(content));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const path = join(directory, 'target.jar');
    await fetchArtifact(artifact, path);
    await Bun.write(path, 'corrupt');
    await fetchArtifact(artifact, path);
    expect(await Bun.file(path).text()).toBe(content);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  test('rejects checksum mismatches without installing the artifact', async () => {
    const directory = await temp();
    process.env.XDG_CACHE_HOME = directory;
    globalThis.fetch = mock(async () => new Response('wrong')) as unknown as typeof fetch;
    const path = join(directory, 'target.jar');
    await expect(
      fetchArtifact(
        { filename: 'test.jar', sha256: 'a'.repeat(64), url: 'https://example.com/test.jar' },
        path,
      ),
    ).rejects.toThrow('Checksum mismatch');
    expect(await Bun.file(path).exists()).toBe(false);
  });
  test('rejects traversal filenames and missing hashes', async () => {
    await expect(
      fetchArtifact(
        { filename: '../test.jar', sha256: 'a'.repeat(64), url: 'https://example.com/test.jar' },
        '/tmp/unused',
      ),
    ).rejects.toThrow();
    await expect(
      fetchArtifact({ filename: 'test.jar', url: 'https://example.com/test.jar' }, '/tmp/unused'),
    ).rejects.toThrow();
  });
});
