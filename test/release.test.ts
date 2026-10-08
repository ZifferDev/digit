import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PLATFORMS,
  archiveName,
  assembleRelease,
  checksumFile,
  fileChecksum,
  homebrewFormula,
  nativePlatform,
  packageReleaseArchive,
  parseReleaseTag,
  releaseAssets,
  renderInstaller,
  validateReleaseMetadata,
  validateReleaseVersions,
  validateRepository,
  verifyReleaseArchives,
} from '../scripts/release';
import type { ReleaseMetadata } from '../scripts/release';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'digit-release-test-'));
  directories.push(path);
  return path;
}
function metadata(version = '1.2.3'): ReleaseMetadata {
  return {
    schema: 1,
    ...parseReleaseTag(`v${version}`),
    repository: 'ZifferDev/digit',
    assets: releaseAssets(
      version,
      'ZifferDev/digit',
      PLATFORMS.map((platform, i) => ({
        name: archiveName(version, platform),
        sha256: String(i + 1).repeat(64),
      })),
    ),
  };
}
async function capture(args: string[]) {
  const child = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(err);
  return out;
}

describe('release validation', () => {
  test('canonical versions identify stable and prerelease releases', () => {
    expect(parseReleaseTag('v1.2.3')).toEqual({
      version: '1.2.3',
      tag: 'v1.2.3',
      prerelease: false,
    });
    expect(parseReleaseTag('v0.1.0-rc.2').prerelease).toBe(true);
    expect(parseReleaseTag('v1.0.0-beta.0')).toBeDefined();
  });
  test.each([
    '1.2.3',
    'v01.2.3',
    'v1.2',
    'v1.2.3-01',
    'v1.2.3-rc.01',
    'v1.2.3+build',
    'v1.2.3\n',
    'v1.2.3;echo bad',
  ])('rejects malformed tag %s', (tag) => {
    expect(() => parseReleaseTag(tag)).toThrow('canonical');
  });
  test('both declared source versions must match the release tag', () => {
    expect(validateReleaseVersions('v1.2.3', '1.2.3', '1.2.3').version).toBe('1.2.3');
    expect(() => validateReleaseVersions('v1.2.3', '1.2.4', '1.2.3')).toThrow('does not match');
    expect(() => validateReleaseVersions('v1.2.3', '1.2.3', '1.2.4')).toThrow('does not match');
  });
  test.each([
    'https://github.com/ZifferDev/digit',
    'owner/repo/extra',
    'owner/repo\n',
    'owner/$(bad)',
    'owner/repo"',
    '../repo',
    '-owner/repo',
  ])('rejects unsafe repository %s', (repo) => {
    expect(() => validateRepository(repo)).toThrow('OWNER/REPO');
  });
  test('requires all three exact platform archives and lowercase SHA256 hashes', () => {
    const m = metadata();
    expect(m.assets.map((a) => a.platform)).toEqual([...PLATFORMS]);
    expect(() => releaseAssets(m.version, m.repository, m.assets.slice(1))).toThrow('exactly one');
    expect(() =>
      releaseAssets(m.version, m.repository, [m.assets[0]!, m.assets[0]!, m.assets[2]!]),
    ).toThrow('duplicate');
    expect(() =>
      releaseAssets(
        m.version,
        m.repository,
        m.assets.map((a, i) => (i === 0 ? { ...a, name: 'digit-1.2.3-darwin-x64.tar.gz' } : a)),
      ),
    ).toThrow('Unexpected');
    expect(() =>
      releaseAssets(
        m.version,
        m.repository,
        m.assets.map((a, i) => (i === 0 ? { ...a, sha256: 'a'.repeat(63) } : a)),
      ),
    ).toThrow('checksum');
  });
  test('metadata cannot redirect downloads or disguise a prerelease', () => {
    const redirected = metadata();
    redirected.assets[0]!.url = 'https://example.com/payload';
    expect(() => validateReleaseMetadata(redirected)).toThrow('URL or platform mismatch');
    const prerelease = metadata('1.2.3-rc.1');
    prerelease.prerelease = false;
    expect(() => validateReleaseMetadata(prerelease)).toThrow('inconsistent');
  });
  test('checksum lists are sorted deterministically', () => {
    const assets = metadata().assets;
    expect(checksumFile([...assets].reverse())).toBe(checksumFile(assets));
    expect(checksumFile(assets).endsWith('\n')).toBe(true);
  });
});

describe('installer and formula generation', () => {
  test('replaces exactly one bounded repository marker or verifies an existing default', () => {
    expect(renderInstaller('#!/bin/sh\nrepo=__DIGIT_REPOSITORY__\n', 'ZifferDev/digit')).toContain(
      'repo=ZifferDev/digit',
    );
    const pinned = '#!/bin/sh\nrepo="${DIGIT_REPOSITORY:-ZifferDev/digit}"\n';
    expect(renderInstaller(pinned, 'ZifferDev/digit')).toBe(pinned);
    expect(() => renderInstaller(pinned, 'other/repo')).toThrow('default matching');
    expect(() =>
      renderInstaller('#!/bin/sh\n__DIGIT_REPOSITORY__ __DIGIT_REPOSITORY__', 'ZifferDev/digit'),
    ).toThrow('one repository');
    expect(() =>
      renderInstaller('#!/bin/sh\n__DIGIT_REPOSITORY__ __DIGIT_UNKNOWN__', 'ZifferDev/digit'),
    ).toThrow('unresolved');
  });
  test('formula contains each pinned archive and completion install, rejects macOS Intel', async () => {
    const m = metadata();
    const formula = homebrewFormula(m);
    for (const asset of m.assets) {
      expect(formula).toContain(asset.url);
      expect(formula).toContain(asset.sha256);
    }
    expect(formula).toContain('macOS on Apple Silicon only');
    expect(formula).toContain('bash_completion.install "completions/digit.bash"');
    expect(formula).toContain('zsh_completion.install "completions/_digit"');
    expect(formula).toContain('fish_completion.install "completions/digit.fish"');
    expect(formula).toContain('license "MIT"');
    if (Bun.which('ruby')) {
      const path = join(await directory(), 'digit.rb');
      await Bun.write(path, formula);
      expect(await capture(['ruby', '-c', path])).toContain('Syntax OK');
    }
    expect(() => homebrewFormula(metadata('1.2.3-rc.1'))).toThrow('stable release');
  });
});

describe('release files', () => {
  test('packages binary, native-generated completions, and license in portable root layout', async () => {
    const root = await directory();
    const binary = join(root, 'candidate');
    const license = join(root, 'LICENSE');
    await Bun.write(
      binary,
      '#!/bin/sh\nif [ "$1" = --version ]; then printf "1.2.3\\n"; else printf "# %s completion for digit\\n" "$2"; fi\n',
    );
    await chmod(binary, 0o755);
    await Bun.write(license, 'MIT test fixture\n');
    const archive = await packageReleaseArchive({
      version: '1.2.3',
      platform: nativePlatform(),
      binary,
      output: join(root, 'out'),
      license,
    });
    const entries = (await capture(['tar', '-tzf', archive])).trim().split('\n').sort();
    expect(entries).toEqual(
      [
        'LICENSE',
        'completions/',
        'completions/_digit',
        'completions/digit.bash',
        'completions/digit.fish',
        'digit',
      ].sort(),
    );
    expect(await capture(['tar', '-xOzf', archive, 'LICENSE'])).toBe('MIT test fixture\n');
    expect(await capture(['tar', '-xOzf', archive, 'completions/_digit'])).toContain(
      'completion for digit',
    );
    await expect(
      packageReleaseArchive({
        version: '1.2.4',
        platform: nativePlatform(),
        binary,
        output: join(root, 'out'),
        license,
      }),
    ).rejects.toThrow('Binary version');
    const linked = join(root, 'linked');
    await symlink(binary, linked);
    await expect(
      packageReleaseArchive({
        version: '1.2.3',
        platform: nativePlatform(),
        binary: linked,
        output: join(root, 'out'),
        license,
      }),
    ).rejects.toThrow('regular file');
  });
  test('assembles platform outputs and verifies archives before formula generation', async () => {
    const root = await directory();
    const input = join(root, 'artifacts');
    const output = join(root, 'release');
    await mkdir(input);
    const installer = join(root, 'install.sh');
    await Bun.write(installer, '#!/bin/sh\nrepo=__DIGIT_REPOSITORY__\n');
    for (const platform of PLATFORMS) {
      await mkdir(join(input, platform));
      await Bun.write(
        join(input, platform, archiveName('1.2.3', platform)),
        `archive fixture ${platform}`,
      );
    }
    const release = await assembleRelease({
      version: '1.2.3',
      repository: 'ZifferDev/digit',
      input,
      output,
      installer,
    });
    expect(await verifyReleaseArchives(release, output)).toEqual(release);
    const checksums = (await Bun.file(join(output, 'SHA256SUMS')).text()).trim().split('\n');
    expect(checksums).toHaveLength(5);
    for (const line of checksums) {
      const [sum, name] = line.split('  ');
      expect(await fileChecksum(join(output, name!))).toBe(sum!);
    }
    expect(await Bun.file(join(output, 'install.sh')).text()).toContain('repo=ZifferDev/digit');
    expect(await Bun.file(join(output, 'release-metadata.json')).json()).toEqual(release);
    await Bun.write(join(output, release.assets[0]!.name), 'corrupt');
    await expect(verifyReleaseArchives(release, output)).rejects.toThrow('checksum mismatch');
  });
  test('incomplete input fails before output assets are written', async () => {
    const root = await directory();
    const input = join(root, 'artifacts');
    const output = join(root, 'release');
    await mkdir(input);
    await Bun.write(join(input, archiveName('1.2.3', 'linux-x64')), 'only one');
    await expect(
      assembleRelease({
        version: '1.2.3',
        repository: 'ZifferDev/digit',
        input,
        output,
        installer: join(root, 'absent'),
      }),
    ).rejects.toThrow('exactly one');
    expect(await Bun.file(join(output, 'release-metadata.json')).exists()).toBe(false);
  });
});
