import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as p from '@clack/prompts';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'smol-toml';
import { parseManifest, loadProject } from '../src/config';
import { planAdd, planRemove } from '../src/packages';
import { Cancelled } from '../src/prompts';
import { changePackages } from '../src/package-project';
import { dependencyHash, ensureLock, resolveLock } from '../src/resolve';
import { initProject } from '../src/init';
import { registry, pluginVersion } from './registry';

const originalFetch = globalThis.fetch;
const roots: string[] = [];
let api: ReturnType<typeof registry>;
beforeEach(() => {
  api = registry();
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const raw = () => ({
  name: 'friends',
  services: {
    proxy: { type: 'velocity', fallback: ['lobby'] },
    lobby: { type: 'paper', version: '1.21.11' },
    survival: { type: 'paper', version: '1.21.11' },
    database: { type: 'mariadb' },
  },
});
const manifest = () => parseManifest(raw());
async function temp() {
  const root = await mkdtemp(join(tmpdir(), 'digit-packages-'));
  roots.push(root);
  return root;
}
function prompts(accept: boolean | symbol = true, servers = ['lobby', 'survival']) {
  const notes: string[] = [],
    questions: string[] = [];
  return {
    notes,
    questions,
    prompts: {
      ...p,
      spinner: () => ({ start() {}, stop() {}, error() {} }),
      multiselect: async (options: { message: string; options: { value: string }[] }) => {
        questions.push(options.message);
        expect(options.options.map((o) => o.value)).not.toContain('database');
        return servers;
      },
      note: (text: string) => {
        notes.push(text);
      },
      confirm: async (options: { message: string }) => {
        questions.push(options.message);
        return accept;
      },
    } as unknown as typeof p,
  };
}

test('ViaBackwards on two servers asks once for ViaVersion and locks both per service', async () => {
  const ui = prompts();
  const before = manifest();
  const result = await planAdd(before, ['viabackwards'], {}, undefined, {
    interactive: true,
    prompts: ui.prompts,
  });
  expect(ui.questions).toHaveLength(2);
  expect(ui.notes).toEqual(['ViaVersion → lobby, survival']);
  expect(Object.keys(result.manifest.plugins)).toEqual(['viabackwards']);
  expect(before.plugins).toEqual({});
  for (const name of ['lobby', 'survival']) {
    expect(result.manifest.services[name]!.plugins).toEqual(['viabackwards']);
    expect(result.lock.services[name]!.plugins.map((p) => p.project)).toEqual(['BackID', 'ViaID']);
    expect(result.lock.services[name]!.plugins.find((p) => p.project === 'ViaID')!.name).toBe(
      'viaversion',
    );
  }
  expect(result.lock.services.proxy!.plugins).toEqual([]);
  expect(result.lock.inputHash).toBe(dependencyHash(result.manifest));
});

test.each([false, p.CANCEL_SYMBOL])(
  'declining or cancelling required dependencies leaves both files unchanged: %s',
  async (accept) => {
    const root = await temp();
    const source = `# My servers\n${stringify(raw())}`;
    await Bun.write(join(root, 'digit.toml'), source);
    await ensureLock(await loadProject(root));
    const before = await Bun.file(join(root, 'digit.lock')).text();
    await expect(
      changePackages(
        root,
        'add',
        ['viabackwards'],
        {},
        { interactive: true, prompts: prompts(accept).prompts },
      ),
    ).rejects.toBeInstanceOf(Cancelled);
    expect(await Bun.file(join(root, 'digit.toml')).text()).toBe(source);
    expect(await Bun.file(join(root, 'digit.lock')).text()).toBe(before);
  },
);

test('automation requires explicit network targets and dependency consent', async () => {
  await expect(planAdd(manifest(), ['viabackwards'], { yes: true })).rejects.toThrow(
    'Choose servers',
  );
  await expect(
    planAdd(manifest(), ['viabackwards'], { servers: 'lobby' }, undefined, { interactive: false }),
  ).rejects.toThrow('--yes');
  await expect(
    planAdd(manifest(), ['viabackwards'], { servers: 'database', yes: true }),
  ).rejects.toThrow('Cannot select');
  await expect(
    planAdd(manifest(), ['viabackwards'], { servers: 'lobby', all: true }),
  ).rejects.toThrow('not both');
  const result = await planAdd(manifest(), ['viabackwards'], {
    servers: 'lobby,survival',
    yes: true,
  });
  expect(result.lock.services.lobby!.plugins).toHaveLength(2);
});

test('adding and removing preserve unrelated locked roots, server builds and images', async () => {
  const first = await planAdd(manifest(), ['luckperms'], { servers: 'lobby', yes: true });
  const existing = first.lock.services.lobby!;
  api.versions
    .get('LuckID')!
    .unshift(pluginVersion('luck2', 'LuckID', [], { date_published: '2026-10-08' }));
  const beforeCalls = api.calls.length;
  const added = await planAdd(
    first.manifest,
    ['viabackwards'],
    { servers: 'lobby', yes: true },
    first.lock,
  );
  expect(added.lock.services.lobby!.plugins.find((p) => p.project === 'LuckID')!.version).toBe(
    'luck1',
  );
  expect(added.lock.services.lobby!.image).toBe(existing.image);
  expect(added.lock.services.lobby!.build).toBe(existing.build);
  expect(added.lock.services.survival).toEqual(first.lock.services.survival);
  expect(api.calls.slice(beforeCalls).some((url) => /papermc|docker.io/.test(url))).toBe(false);
  const removed = await planRemove(
    added.manifest,
    ['viabackwards'],
    { servers: 'lobby' },
    added.lock,
  );
  expect(removed.lock.services.lobby!.plugins.map((p) => p.version)).toEqual(['luck1']);
  expect(removed.manifest.plugins.viabackwards).toBeUndefined();
});

test('partial removal retains the reusable declaration and the other server unchanged', async () => {
  const added = await planAdd(manifest(), ['viabackwards'], {
    servers: 'lobby,survival',
    yes: true,
  });
  const removed = await planRemove(
    added.manifest,
    ['viabackwards'],
    { servers: 'survival' },
    added.lock,
  );
  expect(removed.manifest.plugins.viabackwards).toBeDefined();
  expect(removed.lock.services.survival!.plugins).toEqual([]);
  expect(removed.lock.services.lobby).toEqual(added.lock.services.lobby);
});

test('required direct dependency cannot be removed alone; removing it with the parent works', async () => {
  const added = await planAdd(manifest(), ['viabackwards', 'viaversion'], {
    servers: 'lobby',
    yes: true,
  });
  await expect(
    planRemove(added.manifest, ['viaversion'], { all: true }, added.lock),
  ).rejects.toThrow('still required');
  const removed = await planRemove(
    added.manifest,
    ['viaversion', 'viabackwards'],
    { all: true },
    added.lock,
  );
  expect(removed.manifest.plugins).toEqual({});
  expect(removed.lock.services.lobby!.plugins).toEqual([]);
});

test('an explicitly added dependency survives removal of its parent', async () => {
  const added = await planAdd(manifest(), ['viaversion', 'viabackwards'], {
    servers: 'lobby',
    yes: true,
  });
  const removed = await planRemove(added.manifest, ['viabackwards'], { all: true }, added.lock);
  expect(removed.lock.services.lobby!.plugins.map((p) => p.project)).toEqual(['ViaID']);
});

test('project IDs, slugs and existing aliases reuse one declaration; repeated add is a no-op', async () => {
  const added = await planAdd(manifest(), ['BackID'], { servers: 'lobby', yes: true });
  const again = await planAdd(
    added.manifest,
    ['viabackwards', 'BackID'],
    { servers: 'lobby', yes: true },
    added.lock,
  );
  expect(again.manifest).toEqual(added.manifest);
  expect(again.lock).toEqual(added.lock);
  expect(again.changes).toEqual([]);
});

test('explicit version is validated; changing a shared declaration is never implicit', async () => {
  const added = await planAdd(manifest(), ['luckperms@luck1'], { servers: 'lobby' });
  expect(added.manifest.plugins.luckperms!.version).toBe('luck1');
  await expect(
    planAdd(added.manifest, ['luckperms@luck2'], { servers: 'survival' }, added.lock),
  ).rejects.toThrow('already uses');
  await expect(planAdd(manifest(), ['luckperms@missing'], { servers: 'lobby' })).rejects.toThrow(
    '404',
  );
});

test('optional dependencies are skipped and recursive/cyclic required dependencies are reviewed once', async () => {
  api.versions
    .get('BackID')![0]!
    .dependencies.push({ dependency_type: 'optional', project_id: 'LuckID' });
  api.versions
    .get('ViaID')![0]!
    .dependencies.push({ dependency_type: 'required', project_id: 'BackID' });
  const ui = prompts();
  const result = await planAdd(manifest(), ['viabackwards'], {}, undefined, {
    interactive: true,
    prompts: ui.prompts,
  });
  expect(result.lock.services.lobby!.plugins).toHaveLength(2);
  expect(ui.notes).toEqual(['ViaVersion → lobby, survival']);
});

test('exact dependency version IDs are followed and incompatibilities fail without writing files', async () => {
  api.versions.get('BackID')![0]!.dependencies = [
    { dependency_type: 'required', version_id: 'via1' },
  ];
  const root = await temp();
  await Bun.write(join(root, 'digit.toml'), stringify(raw()));
  await changePackages(root, 'add', ['viabackwards'], { servers: 'lobby', yes: true });
  expect(api.calls.some((url) => url.endsWith('/version/via1'))).toBe(true);
  const before = await Bun.file(join(root, 'digit.toml')).text(),
    lock = await Bun.file(join(root, 'digit.lock')).text();
  api.versions
    .get('LuckID')![0]!
    .dependencies.push({ dependency_type: 'incompatible', project_id: 'BackID' });
  await expect(
    changePackages(root, 'add', ['luckperms'], { servers: 'lobby', yes: true }),
  ).rejects.toThrow('incompatible');
  expect(await Bun.file(join(root, 'digit.toml')).text()).toBe(before);
  expect(await Bun.file(join(root, 'digit.lock')).text()).toBe(lock);
});

test('different Minecraft and loader compatibility is checked for every selected server', async () => {
  const before = manifest();
  before.services.survival!.version = '26.3';
  await expect(
    planAdd(before, ['luckperms'], { servers: 'lobby,survival', yes: true }),
  ).rejects.toThrow('survival');
  api.versions.get('LuckID')![0]!.loaders = ['paper'];
  await expect(planAdd(manifest(), ['luckperms'], { servers: 'proxy' })).rejects.toThrow('proxy');
});

test('writes a matching frozen lock and preserves comments, settings, configuration files and data', async () => {
  const root = await temp();
  const source = `# Network for friends\n${stringify(raw())}\n[services.lobby.env]\nOPS = "m07z" # keep this\n`;
  await Bun.write(join(root, 'digit.toml'), source);
  const config = join(root, 'services', 'lobby', 'plugins', 'ViaBackwards', 'config.yml');
  await Bun.write(config, 'keep: true\n');
  await changePackages(root, 'add', ['viabackwards'], { servers: 'lobby', yes: true });
  const edited = await Bun.file(join(root, 'digit.toml')).text();
  expect(edited).toContain('# Network for friends');
  expect(edited).toContain('OPS = "m07z" # keep this');
  const project = await loadProject(root);
  const beforeCalls = api.calls.length;
  await ensureLock(project, { frozen: true });
  expect(api.calls).toHaveLength(beforeCalls);
  await changePackages(root, 'remove', ['viabackwards'], { all: true });
  expect(await Bun.file(config).text()).toBe('keep: true\n');
  expect((await loadProject(root)).manifest.plugins).toEqual({});
});

test('detects edits made while the picker is open instead of overwriting them', async () => {
  const root = await temp();
  await Bun.write(join(root, 'digit.toml'), stringify(raw()));
  const ui = prompts();
  ui.prompts.confirm = (async () => {
    await Bun.write(join(root, 'digit.toml'), '# edited concurrently\n' + stringify(raw()));
    return true;
  }) as typeof p.confirm;
  await expect(
    changePackages(root, 'add', ['viabackwards'], {}, { interactive: true, prompts: ui.prompts }),
  ).rejects.toThrow('changed while');
  expect(await Bun.file(join(root, 'digit.toml')).text()).toStartWith('# edited concurrently');
  expect(await Bun.file(join(root, 'digit.lock')).exists()).toBe(false);
});

test('refuses symlinked manifest/lock files', async () => {
  const root = await temp(),
    external = join(await temp(), 'manifest');
  await Bun.write(external, stringify(raw()));
  await symlink(external, join(root, 'digit.toml'));
  await expect(changePackages(root, 'add', ['luckperms'], { servers: 'lobby' })).rejects.toThrow(
    'ordinary file',
  );
});

test('init uses the same per-plugin server selection and dependency consent, then writes a matching lock', async () => {
  const root = join(await temp(), 'new');
  const ui = prompts();
  ui.prompts.intro = () => {};
  ui.prompts.outro = () => {};
  ui.prompts.spinner = (() => ({ start() {}, stop() {}, error() {} })) as typeof p.spinner;
  await initProject(
    root,
    {
      name: 'friends',
      proxy: true,
      proxyName: 'proxy',
      servers: 'lobby,survival',
      minecraft: '1.21.11',
      memory: '2G',
      ops: '',
      plugins: 'viabackwards',
      database: false,
      bind: '127.0.0.1',
      port: '25565',
    },
    {
      interactive: true,
      prompts: ui.prompts,
      versions: async () => [{ id: '1.21.11', supported: true, experimental: false, java: 21 }],
    },
  );
  expect(ui.notes[0]).toBe('ViaVersion → lobby, survival');
  expect(ui.questions.some((q) => q.includes('Which servers'))).toBe(true);
  const lock = await ensureLock(await loadProject(root), { frozen: true });
  expect(lock.services.lobby!.plugins.map((p) => p.project)).toEqual(['BackID', 'ViaID']);
});

test('init declining dependency consent creates no project files', async () => {
  const root = join(await temp(), 'cancelled');
  const ui = prompts(false);
  ui.prompts.intro = () => {};
  ui.prompts.spinner = (() => ({ start() {}, stop() {}, error() {} })) as typeof p.spinner;
  await expect(
    initProject(
      root,
      {
        name: 'friends',
        proxy: true,
        proxyName: 'proxy',
        servers: 'lobby,survival',
        minecraft: '1.21.11',
        memory: '2G',
        ops: '',
        plugins: 'viabackwards',
        database: false,
        bind: '127.0.0.1',
        port: '25565',
      },
      {
        interactive: true,
        prompts: ui.prompts,
        versions: async () => [{ id: '1.21.11', supported: true, experimental: false, java: 21 }],
      },
    ),
  ).rejects.toBeInstanceOf(Cancelled);
  expect(await Bun.file(join(root, 'digit.toml')).exists()).toBe(false);
  expect(await Bun.file(join(root, 'digit.lock')).exists()).toBe(false);
});

test('promoting a dependency to a direct plugin keeps its locked version and readable name', async () => {
  const first = await planAdd(manifest(), ['viabackwards'], { servers: 'lobby', yes: true });
  api.versions
    .get('ViaID')!
    .unshift(pluginVersion('via2', 'ViaID', [], { date_published: '2026-10-08' }));
  const added = await planAdd(first.manifest, ['luckperms'], { servers: 'lobby' }, first.lock);
  expect(added.lock.services.lobby!.plugins.find((p) => p.project === 'ViaID')).toEqual(
    first.lock.services.lobby!.plugins.find((p) => p.project === 'ViaID'),
  );
  const promoted = await planAdd(added.manifest, ['viaversion'], { servers: 'lobby' }, added.lock);
  expect(promoted.lock.services.lobby!.plugins.find((p) => p.project === 'ViaID')!.version).toBe(
    'via1',
  );
  const removed = await planRemove(
    promoted.manifest,
    ['viabackwards'],
    { all: true },
    promoted.lock,
  );
  expect(removed.lock.services.lobby!.plugins.map((p) => p.project)).toEqual(['LuckID', 'ViaID']);
});

test('a stale lock does not override an explicit manual version change during add', async () => {
  const first = await planAdd(manifest(), ['luckperms@luck1'], { servers: 'lobby' });
  api.versions.get('LuckID')!.push(pluginVersion('luck2', 'LuckID'));
  first.manifest.plugins.luckperms!.version = 'luck2';
  const added = await planAdd(first.manifest, ['viaversion'], { servers: 'lobby' }, first.lock);
  expect(added.lock.services.lobby!.plugins.find((p) => p.project === 'LuckID')!.version).toBe(
    'luck2',
  );
});

test('multi-plugin removal on explicit servers tolerates absent references and prunes shared dependencies', async () => {
  const first = await planAdd(manifest(), ['viabackwards'], {
    servers: 'lobby,survival',
    yes: true,
  });
  const second = await planAdd(first.manifest, ['luckperms'], { servers: 'lobby' }, first.lock);
  const removed = await planRemove(
    second.manifest,
    ['viabackwards', 'luckperms'],
    { servers: 'lobby,survival' },
    second.lock,
  );
  expect(removed.manifest.plugins).toEqual({});
  expect(removed.lock.services.lobby!.plugins).toEqual([]);
  expect(removed.lock.services.survival!.plugins).toEqual([]);
});

test('required version conflicts preserve existing files and give a clear error', async () => {
  const root = await temp();
  await Bun.write(join(root, 'digit.toml'), stringify(raw()));
  await changePackages(root, 'add', ['viaversion'], { servers: 'lobby' });
  api.versions.get('ViaID')!.push(pluginVersion('via2', 'ViaID'));
  api.versions.get('BackID')![0]!.dependencies = [
    { dependency_type: 'required', version_id: 'via2' },
  ];
  const before = await Bun.file(join(root, 'digit.toml')).text(),
    lock = await Bun.file(join(root, 'digit.lock')).text();
  await expect(
    changePackages(root, 'add', ['viabackwards'], { servers: 'lobby', yes: true }),
  ).rejects.toThrow('Conflicting');
  expect(await Bun.file(join(root, 'digit.toml')).text()).toBe(before);
  expect(await Bun.file(join(root, 'digit.lock')).text()).toBe(lock);
});

test('server picker cancellation and failure of a later package save no partial manifest', async () => {
  const root = await temp();
  const source = stringify(raw());
  await Bun.write(join(root, 'digit.toml'), source);
  const ui = prompts();
  ui.prompts.multiselect = (async () => p.CANCEL_SYMBOL) as typeof p.multiselect;
  await expect(
    changePackages(root, 'add', ['luckperms'], {}, { interactive: true, prompts: ui.prompts }),
  ).rejects.toBeInstanceOf(Cancelled);
  await expect(
    changePackages(root, 'add', ['luckperms', 'missing'], { servers: 'lobby' }),
  ).rejects.toThrow('404');
  expect(await Bun.file(join(root, 'digit.toml')).text()).toBe(source);
  expect(await Bun.file(join(root, 'digit.lock')).exists()).toBe(false);
});

test('remove without arguments uses a plugin picker followed by the server picker', async () => {
  const added = await planAdd(manifest(), ['viabackwards'], {
    servers: 'lobby,survival',
    yes: true,
  });
  const questions: string[] = [];
  const fake = prompts().prompts;
  fake.multiselect = (async (options: { message: string }) => {
    questions.push(options.message);
    return options.message.startsWith('Which plugins') ? ['viabackwards'] : ['survival'];
  }) as typeof p.multiselect;
  const removed = await planRemove(added.manifest, [], {}, added.lock, {
    interactive: true,
    prompts: fake,
  });
  expect(questions).toHaveLength(2);
  expect(removed.lock.services.survival!.plugins).toEqual([]);
  expect(removed.lock.services.lobby!.plugins).toHaveLength(2);
});

test('unknown targets are rejected even when removing an unused declaration', async () => {
  const before = manifest();
  before.plugins.unused = { source: 'modrinth', project: 'ViaID', version: 'latest' };
  await expect(planRemove(before, ['unused'], { servers: 'typo' })).rejects.toThrow(
    'Cannot select',
  );
  await expect(planRemove(before, ['unused'], { servers: '', all: true })).rejects.toThrow(
    'not both',
  );
});

test('package edits upgrade old lock annotations without upgrading its plugins', async () => {
  const before = manifest();
  before.plugins.custom = { source: 'modrinth', project: 'luckperms', version: 'latest' };
  before.services.lobby!.plugins = ['custom'];
  const lock = await resolveLock(before);
  for (const plugin of lock.services.lobby!.plugins) {
    delete plugin.aliases;
    delete plugin.name;
  }
  api.versions
    .get('LuckID')!
    .unshift(pluginVersion('luck2', 'LuckID', [], { date_published: '2026-10-08' }));
  const added = await planAdd(before, ['viaversion'], { servers: 'lobby' }, lock);
  const preserved = added.lock.services.lobby!.plugins.find((p) => p.project === 'LuckID');
  expect(preserved?.version).toBe('luck1');
  expect(preserved?.aliases).toEqual(['custom']);
  expect(preserved?.name).toBe('custom');
});
