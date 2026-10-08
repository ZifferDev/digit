#!/usr/bin/env bun
/** Local release tooling. These commands prepare files; they never publish a release or tap. */
import {
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import { VERSION } from '../src/version';

export const PLATFORMS = ['darwin-arm64', 'linux-arm64', 'linux-x64'] as const;
export type Platform = (typeof PLATFORMS)[number];
export interface ReleaseAsset {
  name: string;
  platform: Platform;
  sha256: string;
  url: string;
}
export interface ReleaseMetadata {
  schema: 1;
  version: string;
  tag: string;
  prerelease: boolean;
  repository: string;
  assets: ReleaseAsset[];
}
const root = resolve(import.meta.dir, '..');
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const sha256 = /^[a-f0-9]{64}$/;

export function parseReleaseTag(tag: string): {
  version: string;
  tag: string;
  prerelease: boolean;
} {
  if (!tag.startsWith('v') || !semver.test(tag.slice(1)))
    throw new Error(
      'Release tag must be canonical vMAJOR.MINOR.PATCH, optionally with a prerelease suffix; build metadata is unsupported.',
    );
  const version = tag.slice(1);
  return { version, tag, prerelease: version.includes('-') };
}
export function validateReleaseVersions(
  tag: string,
  packageVersion: string,
  sourceVersion: string,
) {
  const result = parseReleaseTag(tag);
  if (result.version !== packageVersion || result.version !== sourceVersion)
    throw new Error(
      `Release ${tag} does not match package.json (${packageVersion}) and src/version.ts (${sourceVersion}). Update both before tagging.`,
    );
  return result;
}
export function validateRepository(repository: string): string {
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(
      repository,
    )
  )
    throw new Error(
      'Repository must be a GitHub OWNER/REPO name, without a URL, whitespace, or shell syntax.',
    );
  return repository;
}
export function validatePlatform(platform: string): Platform {
  if (!(PLATFORMS as readonly string[]).includes(platform))
    throw new Error(`Unsupported release platform ${platform}. Expected ${PLATFORMS.join(', ')}.`);
  return platform as Platform;
}
export function nativePlatform(): Platform {
  return validatePlatform(`${process.platform}-${process.arch}`);
}
export function archiveName(version: string, platform: Platform): string {
  parseReleaseTag(`v${version}`);
  validatePlatform(platform);
  return `digit-${version}-${platform}.tar.gz`;
}
export function releaseAssets(
  version: string,
  repository: string,
  archives: { name: string; sha256: string }[],
): ReleaseAsset[] {
  const { tag } = parseReleaseTag(`v${version}`);
  validateRepository(repository);
  const expected = new Map(PLATFORMS.map((platform) => [archiveName(version, platform), platform]));
  if (archives.length !== PLATFORMS.length)
    throw new Error('A release requires exactly one archive for each supported platform.');
  const seen = new Set<string>();
  return archives
    .map((archive) => {
      const platform = expected.get(archive.name);
      if (!platform || seen.has(archive.name))
        throw new Error(`Unexpected or duplicate release archive: ${archive.name}`);
      if (!sha256.test(archive.sha256))
        throw new Error(`Invalid SHA256 checksum for ${archive.name}.`);
      seen.add(archive.name);
      return {
        ...archive,
        platform,
        url: `https://github.com/${repository}/releases/download/${tag}/${archive.name}`,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
export function validateReleaseMetadata(input: unknown): ReleaseMetadata {
  if (!input || typeof input !== 'object') throw new Error('Invalid release metadata.');
  const data = input as ReleaseMetadata;
  if (
    data.schema !== 1 ||
    typeof data.version !== 'string' ||
    typeof data.tag !== 'string' ||
    typeof data.repository !== 'string' ||
    !Array.isArray(data.assets)
  )
    throw new Error('Invalid release metadata schema.');
  const parsed = parseReleaseTag(data.tag);
  if (parsed.version !== data.version || parsed.prerelease !== data.prerelease)
    throw new Error('Release metadata version, tag, or prerelease flag is inconsistent.');
  const assets = releaseAssets(data.version, data.repository, data.assets);
  for (const actual of data.assets) {
    const expected = assets.find((asset) => asset.name === actual.name)!;
    if (actual.url !== expected.url || actual.platform !== expected.platform)
      throw new Error(`Release metadata URL or platform mismatch for ${actual.name}.`);
  }
  return { schema: 1, ...parsed, repository: data.repository, assets };
}
export function renderInstaller(template: string, repository: string): string {
  validateRepository(repository);
  const token = '__DIGIT_REPOSITORY__';
  const count = template.split(token).length - 1;
  let rendered: string;
  if (count === 1) rendered = template.replace(token, repository);
  else if (count === 0 && template.includes(`DIGIT_REPOSITORY:-${repository}`)) rendered = template;
  else
    throw new Error(
      'Installer must contain one repository template marker, or an existing default matching the release repository.',
    );
  if (/__DIGIT_[A-Z0-9_]+__/.test(rendered))
    throw new Error('Installer contains unresolved template markers.');
  if (!rendered.startsWith('#!/')) throw new Error('Installer is missing its shell shebang.');
  return rendered;
}
export function checksumFile(assets: { name: string; sha256: string }[]): string {
  return `${[...assets]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((asset) => `${asset.sha256}  ${asset.name}`)
    .join('\n')}\n`;
}
export function homebrewFormula(input: unknown): string {
  const metadata = validateReleaseMetadata(input);
  if (metadata.prerelease)
    throw new Error(
      'Homebrew tap updates require a stable release; prereleases must not replace the stable formula.',
    );
  const asset = (platform: Platform) => metadata.assets.find((a) => a.platform === platform)!;
  const branch = (platform: Platform, indent: string) =>
    `${indent}url "${asset(platform).url}"\n${indent}sha256 "${asset(platform).sha256}"`;
  return `# Generated from verified release archives by scripts/release.ts.\nclass Digit < Formula\n  desc "Declarative Minecraft servers with Paper and Velocity"\n  homepage "https://github.com/${metadata.repository}"\n  version "${metadata.version}"\n  license "MIT"\n\n  if OS.mac?\n    if Hardware::CPU.arm?\n${branch('darwin-arm64', '      ')}\n    else\n      raise "digit supports macOS on Apple Silicon only"\n    end\n  elsif OS.linux?\n    if Hardware::CPU.arm?\n${branch('linux-arm64', '      ')}\n    elsif Hardware::CPU.intel?\n${branch('linux-x64', '      ')}\n    else\n      raise "digit supports Linux ARM64 and x86_64 only"\n    end\n  else\n    raise "digit supports macOS and Linux only"\n  end\n\n  def install\n    bin.install "digit"\n    bash_completion.install "completions/digit.bash" => "digit"\n    zsh_completion.install "completions/_digit"\n    fish_completion.install "completions/digit.fish"\n  end\n\n  test do\n    assert_equal version.to_s, shell_output("#{bin}/digit --version").strip\n  end\nend\n`;
}
async function run(args: string[], cwd?: string): Promise<string> {
  const process = Bun.spawn(args, {
    cwd,
    env: { ...Bun.env, COPYFILE_DISABLE: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [output, error, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0) throw new Error(`${args[0]} failed (${code}): ${error.trim()}`);
  return output;
}
export async function fileChecksum(path: string): Promise<string> {
  if (!(await lstat(path)).isFile()) throw new Error(`Expected a regular release file: ${path}`);
  return new Bun.CryptoHasher('sha256').update(await Bun.file(path).arrayBuffer()).digest('hex');
}
export async function verifyReleaseArchives(
  input: unknown,
  directory: string,
): Promise<ReleaseMetadata> {
  const metadata = validateReleaseMetadata(input);
  for (const asset of metadata.assets) {
    if ((await fileChecksum(join(directory, asset.name))) !== asset.sha256)
      throw new Error(`Archive checksum mismatch: ${asset.name}`);
  }
  return metadata;
}
export async function packageReleaseArchive(options: {
  version: string;
  platform: Platform;
  binary: string;
  output: string;
  license?: string;
}): Promise<string> {
  const { version, platform } = options;
  const name = archiveName(version, platform);
  if (platform !== nativePlatform())
    throw new Error(
      `Package ${platform} on a native ${platform} runner; this runner is ${nativePlatform()}.`,
    );
  const binary = resolve(options.binary);
  if (!(await lstat(binary)).isFile())
    throw new Error('Release binary must be a regular file, not a symlink.');
  if ((await run([binary, '--version'])).trim() !== version)
    throw new Error(`Binary version does not match release ${version}. Rebuild before packaging.`);
  const staging = await mkdtemp(join(tmpdir(), 'digit-package-'));
  const output = resolve(options.output);
  await mkdir(output, { recursive: true });
  const archive = join(output, name);
  const temporary = `${archive}.${crypto.randomUUID()}.tmp`;
  try {
    await copyFile(binary, join(staging, 'digit'));
    await chmod(join(staging, 'digit'), 0o755);
    const license = options.license ?? join(root, 'LICENSE');
    if (!(await lstat(license)).isFile())
      throw new Error('Release LICENSE must be a regular file.');
    await copyFile(license, join(staging, 'LICENSE'));
    await mkdir(join(staging, 'completions'));
    for (const [shell, name] of [
      ['bash', 'digit.bash'],
      ['zsh', '_digit'],
      ['fish', 'digit.fish'],
    ] as const) {
      const completion = await run([binary, 'complete', shell]);
      if (!completion.trim()) throw new Error(`Binary returned empty ${shell} completion.`);
      await Bun.write(join(staging, 'completions', name), completion);
    }
    await run(['tar', '-czf', temporary, '-C', staging, 'digit', 'completions', 'LICENSE']);
    await rename(temporary, archive);
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(temporary, { force: true });
  }
  return archive;
}
async function archivePaths(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Release input must not contain symlinks: ${path}`);
    if (entry.isDirectory()) paths.push(...(await archivePaths(path)));
    else if (entry.name.endsWith('.tar.gz')) paths.push(path);
  }
  return paths;
}
export async function assembleRelease(options: {
  version: string;
  repository: string;
  input: string;
  output: string;
  installer: string;
}): Promise<ReleaseMetadata> {
  const parsed = parseReleaseTag(`v${options.version}`);
  const repository = validateRepository(options.repository);
  const paths = await archivePaths(resolve(options.input));
  const files = await Promise.all(
    paths.map(async (path) => ({ name: basename(path), sha256: await fileChecksum(path) })),
  );
  const assets = releaseAssets(options.version, repository, files);
  const installer = renderInstaller(await Bun.file(options.installer).text(), repository);
  const metadata: ReleaseMetadata = { schema: 1, ...parsed, repository, assets };
  const output = resolve(options.output);
  await mkdir(output, { recursive: true });
  // All validation happens before modifying the output bundle.
  for (const path of paths)
    if (resolve(path) !== join(output, basename(path)))
      await copyFile(path, join(output, basename(path)));
  await verifyReleaseArchives(metadata, output);
  await Bun.write(join(output, 'install.sh'), installer);
  await chmod(join(output, 'install.sh'), 0o755);
  await Bun.write(join(output, 'release-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  const checksums = [
    ...assets.map(({ name, sha256 }) => ({ name, sha256 })),
    ...(await Promise.all(
      ['install.sh', 'release-metadata.json'].map(async (name) => ({
        name,
        sha256: await fileChecksum(join(output, name)),
      })),
    )),
  ];
  await Bun.write(join(output, 'SHA256SUMS'), checksumFile(checksums));
  return metadata;
}
async function checkedVersion(tag: string) {
  const pkg = await Bun.file(join(root, 'package.json')).json();
  return validateReleaseVersions(tag, pkg.version, VERSION);
}
export async function main(args = process.argv) {
  const cli = new Command('release').description(
    'Prepare digit release files without publishing them',
  );
  cli
    .command('validate')
    .requiredOption('--tag <tag>')
    .option('--repository <owner/repo>')
    .option('--github-output <path>')
    .action(async (options) => {
      const info = {
        ...(await checkedVersion(options.tag)),
        ...(options.repository ? { repository: validateRepository(options.repository) } : {}),
      };
      if (options.githubOutput)
        await appendFile(
          options.githubOutput,
          Object.entries(info)
            .map(([key, value]) => `${key}=${value}\n`)
            .join(''),
        );
      console.log(JSON.stringify(info));
    });
  cli
    .command('package')
    .requiredOption('--tag <tag>')
    .requiredOption('--platform <platform>')
    .option('--binary <path>', 'native compiled binary', 'dist/digit')
    .option('--output <path>', 'archive directory', 'dist/release')
    .action(async (options) => {
      const { version } = await checkedVersion(options.tag);
      console.log(
        await packageReleaseArchive({
          version,
          platform: validatePlatform(options.platform),
          binary: options.binary,
          output: options.output,
        }),
      );
    });
  cli
    .command('assemble')
    .requiredOption('--tag <tag>')
    .requiredOption('--repository <owner/repo>')
    .requiredOption('--input <path>')
    .option('--output <path>', 'assembled release directory', 'dist/release')
    .option(
      '--installer <path>',
      'installer template or repository-specific script',
      'scripts/install.sh',
    )
    .action(async (options) => {
      const { version } = await checkedVersion(options.tag);
      console.log(
        JSON.stringify(
          await assembleRelease({
            version,
            repository: options.repository,
            input: options.input,
            output: options.output,
            installer: options.installer,
          }),
        ),
      );
    });
  cli
    .command('formula')
    .requiredOption('--metadata <path>')
    .option('--assets <path>', 'directory containing archives; defaults to the metadata directory')
    .requiredOption('--output <path>')
    .action(async (options) => {
      const metadata = await verifyReleaseArchives(
        await Bun.file(options.metadata).json(),
        options.assets ?? dirname(resolve(options.metadata)),
      );
      const formula = homebrewFormula(metadata);
      await mkdir(dirname(resolve(options.output)), { recursive: true });
      await Bun.write(options.output, formula);
      console.log(resolve(options.output));
    });
  await cli.parseAsync(args);
}
if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`release: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
