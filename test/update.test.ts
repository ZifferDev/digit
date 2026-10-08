import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as p from '@clack/prompts';
import { stringify } from 'smol-toml';
import { parseManifest, loadProject } from '../src/config';
import { ensureLock, findStableBuild, getModrinthVersionLabels } from '../src/resolve';
import { formatUpdateReport, updateApplyCommand } from '../src/update-report';
import { outdatedProject, updateProject } from '../src/update';
import { Cancelled } from '../src/prompts';
import { registry } from './registry';
import type { Lockfile, LockedPlugin } from '../src/types';

const originalFetch = globalThis.fetch,
  roots: string[] = [];
beforeEach(() => {
  registry();
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function plugin(version = 'old'): LockedPlugin {
  return {
    name: 'viaversion',
    aliases: ['viaversion'],
    project: 'ViaID',
    version,
    filename: 'via.jar',
    url: 'https://example.com/via.jar',
    sha512: 'b'.repeat(128),
  };
}
function lock(): Lockfile {
  return {
    schema: 1,
    inputHash: 'a'.repeat(64),
    services: {
      survival: {
        type: 'paper',
        version: '26.2',
        build: 1,
        java: 21,
        channel: 'STABLE',
        image: `itzg/minecraft-server@sha256:${'a'.repeat(64)}`,
        plugins: [plugin()],
      },
    },
  };
}
const labels = async () =>
  new Map([
    ['ViaID/old', '5.5.0'],
    ['ViaID/new', '5.6.0'],
  ]);

test('reports server version, build, Java, image, and readable plugin old/new versions', async () => {
  const before = lock(),
    after = structuredClone(before);
  Object.assign(after.services.survival!, {
    version: '26.3',
    build: 2,
    java: 25,
    image: `itzg/minecraft-server@sha256:${'c'.repeat(64)}`,
  });
  after.services.survival!.plugins[0]!.version = 'new';
  const report = await formatUpdateReport(before, after, 'digit up', labels);
  expect(report).toContain('Paper 26.2 build 1 → Paper 26.3 build 2');
  expect(report).toContain('Java: 21 → 25');
  expect(report).toContain('sha256:aaaaaaaaaaaa… → itzg/minecraft-server@sha256:cccccccccccc…');
  expect(report).toContain('plugin viaversion: 5.5.0 → 5.6.0');
  expect(report).toContain('Run digit up to apply');
  expect(report).toContain('Running servers have not been changed');
});
test('reports no-op honestly without fetching metadata or mutating locks', async () => {
  const before = lock(),
    after = structuredClone(before);
  const report = await formatUpdateReport(before, after, 'digit up', async () => {
    throw new Error('must not call');
  });
  expect(report).toContain('No updates found');
  expect(report).not.toContain('Updated digit.lock');
  expect(after).toEqual(before);
});
test('initial locks and added/removed services and plugins have explicit labels', async () => {
  const before = lock(),
    after = structuredClone(before);
  after.services.database = {
    type: 'mariadb',
    version: '11.8',
    image: `mariadb@sha256:${'d'.repeat(64)}`,
    plugins: [],
  };
  delete after.services.survival;
  const report = await formatUpdateReport(before, after, 'digit up', labels);
  expect(report).toContain('added MariaDB 11.8');
  expect(report).toContain('removed Paper 26.2 build 1');
  expect(report).toContain('plugin viaversion: removed 5.5.0');
  const initial = await formatUpdateReport(undefined, before, 'digit up', labels);
  expect(initial).toContain('Created digit.lock');
  expect(initial).toContain('added 5.5.0');
  expect(initial).not.toContain('→');
});
test('same-version artifacts, image-only changes, and identical display versions remain visible', async () => {
  const before = lock(),
    after = structuredClone(before);
  after.services.survival!.plugins[0]!.sha512 = 'c'.repeat(128);
  const report = await formatUpdateReport(before, after, 'digit up', labels);
  expect(report).toContain('5.5.0: artifact changed');
  expect(report).toContain('sha512:bbbbbbbbbbbb… → sha512:cccccccccccc…');
  after.services.survival!.plugins[0]!.version = 'new';
  const sameLabel = await formatUpdateReport(
    before,
    after,
    'digit up',
    async () =>
      new Map([
        ['ViaID/old', '5.5.0'],
        ['ViaID/new', '5.5.0'],
      ]),
  );
  expect(sameLabel).toContain('5.5.0 (old) → 5.5.0 (new)');
  after.services.survival!.plugins = before.services.survival!.plugins;
  after.services.survival!.image = `itzg/minecraft-server@sha256:${'a'.repeat(63)}b`;
  const image = await formatUpdateReport(before, after);
  expect(image).toContain('image:');
  expect(image).toContain('a'.repeat(63) + 'b');
  expect(image).not.toContain('plugin viaversion');
});
test('metadata-only changes are not claimed as software updates and missing labels fall back to exact IDs', async () => {
  const before = lock(),
    after = structuredClone(before);
  after.inputHash = 'f'.repeat(64);
  expect(await formatUpdateReport(before, after)).toContain(
    'No software updates found. Lockfile metadata refreshed',
  );
  after.services.survival!.plugins[0]!.version = 'new';
  const report = await formatUpdateReport(before, after, 'digit up', async () => {
    throw new Error('offline');
  });
  expect(report).toContain('version ID old → version ID new');
});
test('batched version labels are scoped by project, deduplicated, and best effort', async () => {
  let calls = 0;
  globalThis.fetch = (async (url: string, options: RequestInit) => {
    calls++;
    expect(JSON.parse(new URL(url).searchParams.get('ids')!)).toEqual(['old']);
    expect(options.signal).toBeDefined();
    return Response.json([
      { project_id: 'ViaID', id: 'old', version_number: '5.5.0' },
      { project_id: 'OtherID', id: 'old', version_number: 'wrong' },
    ]);
  }) as unknown as typeof fetch;
  expect(await getModrinthVersionLabels([plugin(), plugin()])).toEqual(
    new Map([['ViaID/old', '5.5.0']]),
  );
  expect(calls).toBe(1);
  globalThis.fetch = (async () => new Response('', { status: 503 })) as unknown as typeof fetch;
  expect(await getModrinthVersionLabels([plugin()])).toEqual(new Map());
});
test('apply command retains project, environment and profile with safe shell quoting', () => {
  expect(updateApplyCommand({ project: '.', env: 'dev' })).toBe('digit up');
  expect(
    updateApplyCommand({ project: "/tmp/friend's $world", env: 'preview', profile: 'staging' }),
  ).toBe("digit --project '/tmp/friend'\\''s $world' up --env preview --profile staging");
});

async function fixture(extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'digit-update-'));
  roots.push(root);
  const raw = {
    name: 'friends',
    services: { survival: { type: 'paper', version: '26.2', channel: 'experimental', ...extra } },
  };
  await Bun.write(join(root, 'digit.toml'), `# keep my setup\n${stringify(raw)}`);
  const upstream = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const response = await upstream(input as string, init);
    if (String(input).includes('papermc.io') && String(input).endsWith('/builds')) {
      const builds = (await response.json()) as any[];
      return Response.json([{ ...builds[0], id: 2, channel: 'BETA' }, ...builds]);
    }
    return response;
  }) as typeof fetch;
  await ensureLock(await loadProject(root));
  return root;
}
function ui(accept: boolean | symbol) {
  const questions: string[] = [];
  return {
    questions,
    interactive: true,
    prompts: {
      ...p,
      confirm: async (options: { message: string }) => {
        questions.push(options.message);
        return accept;
      },
      spinner: () => ({ start() {}, stop() {}, error() {} }),
    } as unknown as typeof p,
  };
}
test('accepting stable saves the manifest and matching stable lock with comments preserved', async () => {
  const root = await fixture();
  const prompts = ui(true);
  const result = await updateProject(root, {}, prompts);
  expect(prompts.questions).toHaveLength(1);
  expect(prompts.questions[0]).toContain('Paper 26.2 stable build 1');
  expect(result.before!.services.survival!.channel).toBe('BETA');
  expect(result.after.services.survival!.channel).toBe('STABLE');
  expect((await loadProject(root)).manifest.services.survival!.channel).toBe('stable');
  expect(await Bun.file(join(root, 'digit.toml')).text()).toStartWith('# keep my setup');
  await ensureLock(await loadProject(root), { frozen: true });
});
test('declining and unattended updates keep experimental with an explicit notice', async () => {
  const root = await fixture();
  const source = await Bun.file(join(root, 'digit.toml')).text();
  const declined = await updateProject(root, {}, ui(false));
  expect(declined.after.services.survival!.channel).toBe('BETA');
  expect(declined.notices[0]).toContain('kept the experimental channel');
  const unattended = await updateProject(root, {}, { interactive: false });
  expect(unattended.notices[0]).toContain('--stable');
  expect(await Bun.file(join(root, 'digit.toml')).text()).toBe(source);
});
test('cancelling or resolution failure leaves both files untouched even after consent', async () => {
  const root = await fixture();
  const source = await Bun.file(join(root, 'digit.toml')).text(),
    lock = await Bun.file(join(root, 'digit.lock')).text();
  await expect(updateProject(root, {}, ui(p.CANCEL_SYMBOL))).rejects.toBeInstanceOf(Cancelled);
  await expect(
    updateProject(
      root,
      {},
      {
        ...ui(true),
        resolve: async () => {
          throw new Error('registry offline');
        },
      },
    ),
  ).rejects.toThrow('registry offline');
  expect(await Bun.file(join(root, 'digit.toml')).text()).toBe(source);
  expect(await Bun.file(join(root, 'digit.lock')).text()).toBe(lock);
});
test('explicit stable flag switches without questions; keep flag avoids availability checks', async () => {
  const root = await fixture();
  await updateProject(
    root,
    { keepExperimental: true },
    {
      stableBuild: async () => {
        throw new Error('must not call');
      },
    },
  );
  const result = await updateProject(root, { stable: true }, { interactive: false });
  expect(result.decisions[0]).toContain('experimental → stable');
  await expect(updateProject(root, { stable: true, keepExperimental: true })).rejects.toThrow(
    'not both',
  );
});
test('latest selector pins the selected release on consent rather than jumping to another release', async () => {
  const root = await fixture({ version: 'latest' });
  const prompts = ui(true);
  const result = await updateProject(root, {}, prompts);
  expect(prompts.questions[0]).toContain('set version latest → 1.21.11');
  expect((await loadProject(root)).manifest.services.survival!.version).toBe('1.21.11');
  expect(result.after.services.survival!.version).toBe('1.21.11');
});
test('stable offer explicitly replaces a pinned experimental build after consent', async () => {
  const root = await fixture({ build: '2' });
  const prompts = ui(true);
  await updateProject(root, {}, prompts);
  expect(prompts.questions[0]).toContain('replace pinned build 2 → 1');
  expect((await loadProject(root)).manifest.services.survival!.build).toBe('1');
});
test.each(['paper', 'velocity'] as const)(
  'finds the final stable counterpart of a prerelease for %s only',
  async (type) => {
    const base = type === 'paper' ? '26.3' : '3.4.0';
    const selected = `${base}-${type === 'paper' ? 'rc-3' : 'SNAPSHOT'}`;
    const service = {
      ...parseManifest({ name: 'test', services: { survival: { type: 'paper' } } }).services
        .survival!,
      type,
      version: selected,
      channel: 'experimental' as const,
    };
    const requests: string[] = [];
    globalThis.fetch = (async (input: string) => {
      requests.push(input);
      return Response.json(
        input.endsWith('/versions')
          ? {
              versions: [
                { version: { id: base }, builds: [10] },
                { version: { id: '99.0' }, builds: [20] },
              ],
            }
          : [
              { id: 10, channel: 'STABLE', downloads: { 'server:default': {} } },
              { id: 11, channel: 'BETA', downloads: { 'server:default': {} } },
            ],
      );
    }) as unknown as typeof fetch;
    expect(await findStableBuild(service)).toEqual({ version: base, build: 10 });
    expect(requests[1]).toContain(`/${type}/versions/${base}/builds`);
    service.version = '25.0-rc-1';
    expect(await findStableBuild(service)).toBeUndefined();
  },
);
test('the actual CLI reports initial selections and then no changes with the scoped apply command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'digit-update-cli-'));
  roots.push(root);
  await Bun.write(
    join(root, 'digit.toml'),
    'name="test"\n[services.survival]\ntype="paper"\nversion="26.2"\n',
  );
  const script = `import {registry} from ${JSON.stringify(resolve(import.meta.dir, 'registry.ts'))}; registry(); const {main}=await import(${JSON.stringify(resolve(import.meta.dir, '../src/cli.ts'))}); await main(['bun','digit','-C',${JSON.stringify(root)},'update','--env','preview']);`;
  const run = async () => {
    const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(err).toBe('');
    return out;
  };
  const first = await run();
  expect(first).toContain('Created digit.lock');
  expect(first).toContain('added Paper 26.2 build 1');
  expect(first).toContain('up --env preview');
  expect(await run()).toContain('No updates found');
});

test('outdated previews newer builds and stable availability without changing files or creating state', async () => {
  const root = await fixture();
  const source = await Bun.file(join(root, 'digit.toml')).text();
  const oldLock = await Bun.file(join(root, 'digit.lock')).text();
  const files = await readdir(root);
  const upstream = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const response = await upstream(input as string, init);
    if (String(input).includes('papermc.io') && String(input).endsWith('/builds')) {
      const builds = (await response.json()) as any[];
      return Response.json([{ ...builds[0], id: 3 }, ...builds]);
    }
    return response;
  }) as typeof fetch;
  const result = await outdatedProject(root);
  expect(result.before.services.survival!.build).toBe(2);
  expect(result.after.services.survival!.build).toBe(3);
  expect(result.after.services.survival!.channel).toBe('BETA');
  expect(result.notices[0]).toContain('stable build 1 is available');
  const report = await formatUpdateReport(result.before, result.after, 'digit up', labels, {
    outdated: true,
  });
  expect(report).toContain('Available updates');
  expect(report).toContain('Paper 26.2 build 2 → Paper 26.2 build 3');
  expect(report).toContain('Run digit update to save updates, then digit up to apply them');
  expect(report).not.toContain('Updated digit.lock');
  expect(await Bun.file(join(root, 'digit.toml')).text()).toBe(source);
  expect(await Bun.file(join(root, 'digit.lock')).text()).toBe(oldLock);
  expect(await readdir(root)).toEqual(files);
  expect(files).not.toContain('.digit');
});

test('outdated requires a lock and does not create one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'digit-outdated-'));
  roots.push(root);
  await Bun.write(join(root, 'digit.toml'), 'name="test"\n[services.survival]\ntype="paper"\n');
  await expect(outdatedProject(root)).rejects.toThrow('Run digit update');
  expect(await readdir(root)).toEqual(['digit.toml']);
});

test('outdated detects concurrent edits without overwriting them', async () => {
  const root = await fixture();
  const oldLock = await Bun.file(join(root, 'digit.lock')).text();
  const original = await Bun.file(join(root, 'digit.toml')).text();
  const upstream = globalThis.fetch;
  let edited = false;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (!edited) {
      edited = true;
      await Bun.write(join(root, 'digit.toml'), original + '\n# concurrent edit\n');
    }
    return upstream(input as string, init);
  }) as typeof fetch;
  await expect(outdatedProject(root)).rejects.toThrow('Project files changed');
  expect(await Bun.file(join(root, 'digit.toml')).text()).toContain('# concurrent edit');
  expect(await Bun.file(join(root, 'digit.lock')).text()).toBe(oldLock);
});

test('actual outdated CLI reports no changes and preserves scoped next steps', async () => {
  const root = await fixture();
  const before = await Bun.file(join(root, 'digit.lock')).text();
  // The plain registry offers stable build 1, so keep the source and lock on stable for this check.
  await updateProject(root, { stable: true }, { interactive: false });
  const lock = await Bun.file(join(root, 'digit.lock')).text();
  expect(lock).not.toBe(before);
  const script = `import {registry} from ${JSON.stringify(resolve(import.meta.dir, 'registry.ts'))}; registry(); const {main}=await import(${JSON.stringify(resolve(import.meta.dir, '../src/cli.ts'))}); await main(['bun','digit','-C',${JSON.stringify(root)},'outdated','--env','preview']);`;
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(0);
  expect(err).toBe('');
  expect(out).toContain('No updates found on the configured channels');
  expect(out).toContain('update --env preview');
  expect(out).toContain('up --env preview');
  expect(await Bun.file(join(root, 'digit.lock')).text()).toBe(lock);
});
