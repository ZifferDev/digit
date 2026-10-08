import { expect, test } from 'bun:test';
import { newerStable } from '../scripts/publish';
test('only newer stable releases advance the default distribution channel', () => {
  expect(newerStable('v0.1.0')).toBe(true);
  expect(newerStable('v0.1.0-rc.2')).toBe(false);
  expect(newerStable('v0.1.1', 'v0.1.0')).toBe(true);
  expect(newerStable('v0.1.0', 'v0.1.0')).toBe(false);
  expect(newerStable('v0.1.0', 'v0.2.0')).toBe(false);
  expect(newerStable('v0.10.0', 'v0.9.0')).toBe(true);
  expect(() => newerStable('v01.0.0')).toThrow();
});

import { afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { publishRelease } from '../scripts/publish';
import {
  PLATFORMS,
  archiveName,
  checksumFile,
  fileChecksum,
  parseReleaseTag,
  releaseAssets,
} from '../scripts/release';
import type { ReleaseMetadata } from '../scripts/release';

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture(version = '1.2.3') {
  const directory = await mkdtemp(join(tmpdir(), 'digit-publish-test-'));
  fixtures.push(directory);
  const repository = 'ZifferDev/digit';
  const archives = [];
  for (const platform of PLATFORMS) {
    const name = archiveName(version, platform);
    await Bun.write(join(directory, name), `archive ${platform}`);
    archives.push({ name, sha256: await fileChecksum(join(directory, name)) });
  }
  const metadata: ReleaseMetadata = {
    schema: 1,
    ...parseReleaseTag(`v${version}`),
    repository,
    assets: releaseAssets(version, repository, archives),
  };
  await Bun.write(join(directory, 'install.sh'), '#!/bin/sh\n# installer fixture\n');
  await Bun.write(join(directory, 'release-metadata.json'), JSON.stringify(metadata));
  const assetNames = [
    ...metadata.assets.map((asset) => asset.name),
    'install.sh',
    'release-metadata.json',
  ];
  await Bun.write(
    join(directory, 'SHA256SUMS'),
    checksumFile(
      await Promise.all(
        assetNames.map(async (name) => ({
          name,
          sha256: await fileChecksum(join(directory, name)),
        })),
      ),
    ),
  );
  assetNames.push('SHA256SUMS');
  const assets = await Promise.all(
    assetNames.map(async (name) => ({
      name,
      digest: `sha256:${await fileChecksum(join(directory, name))}`,
    })),
  );
  const environment = {
    GH_TOKEN: 'fixture-token-not-used',
    GITHUB_REPOSITORY: repository,
    GITHUB_REF_NAME: metadata.tag,
    GITHUB_REF_TYPE: 'tag',
  };
  return { directory, metadata, assets, environment };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type RemoteRelease = {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  immutable: boolean;
  html_url: string;
  assets: { name: string; digest: string }[];
};
function remote(f: Fixture, draft = false): RemoteRelease {
  return {
    id: 123,
    tag_name: f.metadata.tag,
    draft,
    prerelease: f.metadata.prerelease,
    immutable: !draft,
    html_url: `https://github.com/${f.metadata.repository}/releases/tag/${f.metadata.tag}`,
    assets: structuredClone(f.assets),
  };
}
function github(
  f: Fixture,
  options: {
    initial?: RemoteRelease;
    latest?: string;
    failUpload?: boolean;
    corruptUpload?: boolean;
    duplicateUpload?: boolean;
    mutablePublished?: boolean;
  } = {},
) {
  let release = options.initial && structuredClone(options.initial);
  const events: { type: string; path?: string; method?: string; body?: object; args?: string[] }[] =
    [];
  const dependencies = {
    environment: f.environment,
    log: () => {},
    api: async (path: string, method = 'GET', body?: object, missing = false): Promise<any> => {
      events.push({ type: 'api', path, method, body });
      if (path === `releases/tags/${f.metadata.tag}` && method === 'GET') {
        if (!release && !missing) throw new Error('Missing release');
        return release && structuredClone(release);
      }
      if (path === 'releases/latest')
        return options.latest ? { tag_name: options.latest } : undefined;
      if (path === 'releases/123' && method === 'PATCH' && release) {
        release = { ...release, ...(body as any), immutable: !options.mutablePublished };
        return structuredClone(release);
      }
      throw new Error(`Unexpected GitHub call ${method} ${path}`);
    },
    run: async (args: string[]) => {
      events.push({ type: 'command', args });
      if (args[0] !== 'gh' || args[1] !== 'release') throw new Error('Unexpected process');
      if (args[2] === 'create') {
        expect(args).toContain('--draft');
        expect(args).toContain('--verify-tag');
        release = { ...remote(f, true), assets: [] };
        return;
      }
      if (args[2] === 'upload') {
        expect(release?.draft).toBe(true);
        if (options.failUpload) throw new Error('Upload failed');
        const names = args.slice(args.indexOf('--clobber') + 1).map((name) => basename(name));
        expect(names.sort()).toEqual(f.assets.map((asset) => asset.name).sort());
        release!.assets = structuredClone(f.assets);
        if (options.corruptUpload) release!.assets[0]!.digest = `sha256:${'0'.repeat(64)}`;
        if (options.duplicateUpload) release!.assets[1] = { ...release!.assets[0]! };
        return;
      }
      throw new Error('Unexpected gh release operation');
    },
  };
  return { dependencies, events, release: () => release };
}

test('publication creates a draft, uploads and verifies all digests, then publishes immutable', async () => {
  const f = await fixture();
  const gh = github(f, { latest: 'v1.2.2' });
  const result = await publishRelease(f.directory, gh.dependencies);
  expect(result.draft).toBe(false);
  expect(result.immutable).toBe(true);
  expect(
    gh.events.map((e) => (e.type === 'command' ? e.args![2] : `${e.method} ${e.path}`)),
  ).toEqual([
    `GET releases/tags/${f.metadata.tag}`,
    'create',
    `GET releases/tags/${f.metadata.tag}`,
    'upload',
    `GET releases/tags/${f.metadata.tag}`,
    'GET releases/latest',
    'PATCH releases/123',
  ]);
  expect(gh.events.at(-1)!.body).toEqual({ draft: false, prerelease: false, make_latest: 'true' });
});
test('an incomplete or corrupted remote upload stays a draft', async () => {
  for (const failure of [
    { failUpload: true },
    { corruptUpload: true },
    { duplicateUpload: true },
  ]) {
    const f = await fixture();
    const gh = github(f, failure);
    await expect(publishRelease(f.directory, gh.dependencies)).rejects.toThrow();
    expect(gh.release()?.draft).toBe(true);
    expect(gh.events.some((e) => e.method === 'PATCH')).toBe(false);
  }
});
test('retrying a partial draft replaces only its permitted draft assets before verification', async () => {
  const f = await fixture();
  const initial = remote(f, true);
  initial.assets = initial.assets.slice(0, 2);
  const gh = github(f, { initial });
  await publishRelease(f.directory, gh.dependencies);
  expect(gh.events.some((e) => e.args?.[2] === 'create')).toBe(false);
  expect(gh.events.some((e) => e.args?.[2] === 'upload')).toBe(true);
  expect(gh.release()?.draft).toBe(false);
});
test('unexpected draft assets are never deleted or overwritten automatically', async () => {
  const f = await fixture();
  const initial = remote(f, true);
  initial.assets.push({ name: 'manual-extra.txt', digest: 'anything' });
  const gh = github(f, { initial });
  await expect(publishRelease(f.directory, gh.dependencies)).rejects.toThrow('unexpected assets');
  expect(gh.events.every((e) => e.type === 'api' && e.method === 'GET')).toBe(true);
});
test('an already-published matching immutable release is a read-only successful retry', async () => {
  const f = await fixture();
  const gh = github(f, { initial: remote(f) });
  await publishRelease(f.directory, gh.dependencies);
  expect(gh.events).toHaveLength(1);
  expect(gh.events[0]!.method).toBe('GET');
});
test('different or duplicate assets on an existing publication fail without any writes', async () => {
  for (const duplicate of [false, true]) {
    const f = await fixture();
    const initial = remote(f);
    if (duplicate) initial.assets[1] = { ...initial.assets[0]! };
    else initial.assets[0]!.digest = `sha256:${'0'.repeat(64)}`;
    const gh = github(f, { initial });
    await expect(publishRelease(f.directory, gh.dependencies)).rejects.toThrow('never overwritten');
    expect(gh.events.every((e) => e.type === 'api' && e.method === 'GET')).toBe(true);
  }
});
test('prereleases and older stable releases cannot advance latest', async () => {
  for (const [version, latest] of [
    ['1.2.4-rc.1', 'v1.2.3'],
    ['1.2.3', 'v1.3.0'],
  ] as const) {
    const f = await fixture(version);
    const gh = github(f, { latest });
    await publishRelease(f.directory, gh.dependencies);
    expect(gh.events.find((e) => e.method === 'PATCH')!.body).toMatchObject({
      make_latest: 'false',
      prerelease: f.metadata.prerelease,
    });
  }
});
test('published release must retain the intended prerelease channel and immutability', async () => {
  const f = await fixture('1.2.3-rc.1');
  const initial = remote(f);
  initial.prerelease = false;
  const gh = github(f, { initial });
  await expect(publishRelease(f.directory, gh.dependencies)).rejects.toThrow('channel');
  expect(gh.events).toHaveLength(1);
  const stable = await fixture();
  const mutable = github(stable, { mutablePublished: true });
  await expect(publishRelease(stable.directory, mutable.dependencies)).rejects.toThrow(
    'not immutable',
  );
});
test('local tampering and incomplete checksums fail before contacting GitHub', async () => {
  for (const corruptArchive of [true, false]) {
    const f = await fixture();
    const gh = github(f);
    if (corruptArchive) await Bun.write(join(f.directory, f.metadata.assets[0]!.name), 'corrupt');
    else await Bun.write(join(f.directory, 'SHA256SUMS'), '');
    await expect(publishRelease(f.directory, gh.dependencies)).rejects.toThrow();
    expect(gh.events).toHaveLength(0);
  }
});
test('publishing cannot use another repository or a branch context', async () => {
  for (const override of [
    { GITHUB_REPOSITORY: 'other/repository' },
    { GITHUB_REF_TYPE: 'branch' },
    { GITHUB_REF_NAME: 'v9.9.9' },
  ]) {
    const f = await fixture();
    const gh = github(f);
    gh.dependencies.environment = { ...f.environment, ...override };
    await expect(publishRelease(f.directory, gh.dependencies)).rejects.toThrow();
    expect(gh.events).toHaveLength(0);
  }
});
