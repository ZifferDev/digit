import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as prompts from '@clack/prompts';
import { initProject, Cancelled, answer } from '../src/init.ts';
import { loadProject } from '../src/config.ts';
const directories: string[] = [];
const versions = async () => [
  { id: '26.3', supported: true, experimental: true, java: 25 },
  { id: '26.2', supported: true, experimental: false, java: 25 },
  { id: '1.21.11', supported: false, experimental: false, java: 21 },
];
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), 'digit-init-'));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
describe('guided and noninteractive project creation', () => {
  test.each([false, true])(
    'guided %s topology accepts Enter at every default prompt',
    async (proxy) => {
      const root = join(await temp(), 'friends');
      const fields: string[] = [];
      const fake = {
        ...prompts,
        intro: () => {},
        note: () => {},
        outro: () => {},
        spinner: () => ({ start: () => {}, stop: () => {}, error: () => {} }),
        text: async (options: prompts.TextOptions) => {
          const validate = options.validate as (value: string | undefined) => unknown;
          expect(await validate('')).toBeUndefined();
          expect(await validate(undefined)).toBeUndefined();
          fields.push(options.message);
          if (options.message.includes('proxy'))
            expect(await validate('project')).toContain('reserved');
          if (
            options.message.startsWith('Name your Paper') ||
            options.message.startsWith('What should the Paper')
          ) {
            expect(await validate('environment')).toContain('reserved');
            if (proxy) expect(await validate('try')).toContain('reserved');
          }
          return options.defaultValue ?? '';
        },
        select: async (options: { message: string }) =>
          options.message.includes('like to run') ? proxy : '127.0.0.1',
        autocomplete: async (options: { initialValue: string }) => options.initialValue,
        confirm: async (options: { message: string }) =>
          options.message.includes('Create this project'),
      } as unknown as typeof prompts;
      await initProject(root, {}, { versions, interactive: true, prompts: fake });
      const project = await loadProject(root);
      expect(project.manifest.name).toBe('friends');
      expect(project.manifest.network.port).toBe(25565);
      expect(project.manifest.services.survival?.memory).toBe('2G');
      expect(project.manifest.services.survival?.version).toBe('26.2');
      expect(Boolean(project.manifest.services.proxy)).toBe(proxy);
      expect(project.manifest.services.survival?.env.OPS).toBeUndefined();
      expect(fields).toHaveLength(proxy ? 7 : 6);
    },
  );

  test('operator usernames apply to every Paper service and preserve original casing', async () => {
    const root = await temp();
    await initProject(root, { yes: true, proxy: true, ops: 'Alice, Bob_2,Alice' }, { versions });
    const project = await loadProject(root);
    expect(project.manifest.services.lobby?.env.OPS).toBe('Alice,Bob_2');
    expect(project.manifest.services.survival?.env.OPS).toBe('Alice,Bob_2');
    expect(project.manifest.services.proxy?.env.OPS).toBeUndefined();
  });
  test.each(['not-a-name', 'longer_than_16_chars', 'Name With Spaces', 'Alice\nBob', 'Alice,@Bob'])(
    'invalid operator names fail before creating files: %s',
    async (ops) => {
      const root = await temp();
      await expect(initProject(root, { yes: true, ops }, { versions })).rejects.toThrow(
        'Minecraft usernames',
      );
      expect(await Bun.file(join(root, 'digit.toml')).exists()).toBe(false);
    },
  );
  test('creates a valid locked-ready network and preserves existing gitignore', async () => {
    const root = await temp();
    await Bun.write(join(root, '.gitignore'), 'custom-file\n');
    await initProject(
      root,
      {
        yes: true,
        name: 'friends',
        proxy: true,
        servers: 'lobby,survival',
        database: true,
        plugins: 'viaversion,luckperms',
        minecraft: '26.2',
      },
      { versions },
    );
    const project = await loadProject(root);
    expect(project.manifest.services.proxy?.fallback).toEqual(['lobby']);
    expect(project.manifest.services.survival?.plugins).toEqual(['viaversion', 'luckperms']);
    expect(project.manifest.services.database?.type).toBe('mariadb');
    expect(project.manifest.network.bind).toBe('127.0.0.1');
    expect(await Bun.file(join(root, '.gitignore')).text()).toContain('custom-file\n.digit/');
    const staging = await loadProject(root, { profile: 'staging' });
    expect(staging.manifest.network.port).toBe(0);
    expect(await Bun.file(join(root, '.digit', 'eula.json')).exists()).toBe(false);
  });
  test('accepts case-sensitive Modrinth IDs using safe manifest aliases', async () => {
    const root = await temp();
    await initProject(root, { yes: true, plugins: 'A1B2c3d4,1A2B3c4D,a1b2c3d4' }, { versions });
    const project = await loadProject(root);
    expect(Object.values(project.manifest.plugins).map((p) => p.project)).toEqual([
      'A1B2c3d4',
      '1A2B3c4D',
      'a1b2c3d4',
    ]);
    expect(project.manifest.services.survival?.plugins).toEqual([
      'a1b2c3d4',
      'plugin-1a2b3c4d',
      'a1b2c3d4-2',
    ]);
  });
  test('defaults to stable even if the newest version is experimental', async () => {
    const root = await temp();
    await initProject(root, { yes: true }, { versions });
    const project = await loadProject(root);
    expect(project.manifest.services.survival?.version).toBe('26.2');
    expect(project.manifest.services.survival?.channel).toBe('stable');
  });
  test('explicit experimental version remains selectable and marks its channel', async () => {
    const root = await temp();
    await initProject(root, { yes: true, minecraft: '26.3' }, { versions });
    const project = await loadProject(root);
    expect(project.manifest.services.survival?.channel).toBe('experimental');
  });
  test.each([
    { servers: 'survival,another' },
    { proxy: true, servers: 'lobby,lobby' },
    { proxy: true, servers: 'proxy' },
    { database: true, servers: 'database' },
    { name: '../oops' },
    { port: '-1' },
    { port: '65536' },
    { port: '2.5' },
    { memory: '0G' },
    { bind: 'not-an-address' },
    { plugins: '../bad' },
    { minecraft: 'unlisted' },
  ])('invalid options leave no project behind: %j', async (options) => {
    const root = join(await temp(), 'project');
    await expect(initProject(root, { yes: true, ...options }, { versions })).rejects.toThrow();
    expect(await Bun.file(join(root, 'digit.toml')).exists()).toBe(false);
  });
  test('does not overwrite an existing manifest', async () => {
    const root = await temp();
    await Bun.write(join(root, 'digit.toml'), '# important\n');
    await expect(initProject(root, { yes: true }, { versions })).rejects.toThrow('already exists');
    expect(await Bun.file(join(root, 'digit.toml')).text()).toBe('# important\n');
  });
  test('requires --yes outside a terminal', async () => {
    await expect(initProject(await temp(), {}, { interactive: false, versions })).rejects.toThrow(
      '--yes',
    );
  });
  test('cancelled prompts create no project files', async () => {
    const root = join(await temp(), 'cancelled');
    const fake = {
      ...prompts,
      intro: () => {},
      text: async () => prompts.CANCEL_SYMBOL,
    } as typeof prompts;
    await expect(
      initProject(root, {}, { interactive: true, versions, prompts: fake }),
    ).rejects.toBeInstanceOf(Cancelled);
    expect(await Bun.file(join(root, 'digit.toml')).exists()).toBe(false);
  });
  test('cancellation symbol cannot be mistaken for consent', () => {
    expect(() => answer(prompts.CANCEL_SYMBOL)).toThrow(Cancelled);
    expect(answer(false)).toBe(false);
  });
  test('failure fetching the version catalog leaves destination untouched', async () => {
    const root = join(await temp(), 'offline');
    await expect(
      initProject(
        root,
        { yes: true },
        {
          versions: async () => {
            throw new Error('offline');
          },
        },
      ),
    ).rejects.toThrow('offline');
    expect(await Bun.file(join(root, 'digit.toml')).exists()).toBe(false);
  });
});
