#!/usr/bin/env bun
import { resolve, join } from 'node:path';
import { validateReleaseMetadata, parseReleaseTag, validateRepository } from './release';

export function newerStable(candidate: string, current?: string): boolean {
  const next = parseReleaseTag(candidate);
  if (next.prerelease) return false;
  if (!current) return true;
  const previous = parseReleaseTag(current);
  if (previous.prerelease) return true;
  const a = next.version.split('.').map(BigInt);
  const b = previous.version.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}

async function runCommand(args: string[]) {
  const child = Bun.spawn(args, { stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' });
  if (await child.exited) throw new Error(`${args.slice(0, 3).join(' ')} failed.`);
}
export interface PublishDependencies {
  environment?: Record<string, string | undefined>;
  api?: (path: string, method?: string, body?: object, missing?: boolean) => Promise<any>;
  run?: (args: string[]) => Promise<void>;
  log?: (message: string) => void;
}
interface GitHubRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  immutable: boolean;
  html_url: string;
  assets: { name: string; digest?: string }[];
}
function releaseResponse(value: any, tag: string): GitHubRelease {
  if (
    !value ||
    !Number.isInteger(value.id) ||
    value.tag_name !== tag ||
    typeof value.draft !== 'boolean' ||
    typeof value.prerelease !== 'boolean' ||
    !Array.isArray(value.assets)
  )
    throw new Error('GitHub returned an invalid or mismatched release.');
  return value;
}
function verifyUploadedAssets(release: GitHubRelease, digests: Map<string, string>) {
  const names = new Set(release.assets.map((asset) => asset.name));
  if (
    release.assets.length !== digests.size ||
    names.size !== digests.size ||
    release.assets.some((asset) => digests.get(asset.name) !== asset.digest)
  )
    throw new Error(
      'GitHub release assets do not match this build. Published assets are never overwritten; retry only failed jobs or use a new version.',
    );
}

export async function publishRelease(directory: string, dependencies: PublishDependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  const run = dependencies.run ?? runCommand;
  const log = dependencies.log ?? console.log;
  const metadata = validateReleaseMetadata(
    await Bun.file(join(directory, 'release-metadata.json')).json(),
  );
  const repository = validateRepository(environment.GITHUB_REPOSITORY ?? '');
  if (repository !== metadata.repository)
    throw new Error('Release repository does not match this workflow.');
  if (metadata.tag !== environment.GITHUB_REF_NAME || environment.GITHUB_REF_TYPE !== 'tag')
    throw new Error('Publishing is only supported from the matching version tag.');
  const token = environment.GH_TOKEN;
  if (!token) throw new Error('GH_TOKEN is required.');
  const api =
    dependencies.api ??
    (async (path: string, method = 'GET', body?: object, missing = false): Promise<any> => {
      const result = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
      if (missing && result.status === 404) return undefined;
      if (!result.ok) throw new Error(`GitHub ${method} ${path} failed: HTTP ${result.status}`);
      return result.json();
    });
  const names = [
    ...metadata.assets.map((a) => a.name),
    'install.sh',
    'release-metadata.json',
    'SHA256SUMS',
  ];
  const digests = new Map<string, string>();
  for (const name of names)
    digests.set(
      name,
      `sha256:${new Bun.CryptoHasher('sha256').update(await Bun.file(join(directory, name)).arrayBuffer()).digest('hex')}`,
    );
  // Validate every payload against the assembly manifest before uploading anything.
  const checksumLines = (await Bun.file(join(directory, 'SHA256SUMS')).text()).trim().split('\n');
  if (checksumLines.length !== names.length - 1) throw new Error('Incomplete checksum manifest.');
  const seen = new Set<string>();
  for (const line of checksumLines) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    if (
      !match ||
      seen.has(match[2]!) ||
      match[2] === 'SHA256SUMS' ||
      digests.get(match[2]!) !== `sha256:${match[1]}`
    )
      throw new Error('Release checksum verification failed.');
    seen.add(match[2]!);
  }
  for (const asset of metadata.assets)
    if (digests.get(asset.name) !== `sha256:${asset.sha256}`)
      throw new Error('Release metadata checksum mismatch.');
  const existing = await api(`releases/tags/${metadata.tag}`, 'GET', undefined, true);
  let release = existing ? releaseResponse(existing, metadata.tag) : undefined;
  if (!release) {
    const args = [
      'gh',
      'release',
      'create',
      metadata.tag,
      '--repo',
      repository,
      '--verify-tag',
      '--draft',
      '--generate-notes',
      '--title',
      `digit ${metadata.version}`,
    ];
    if (metadata.prerelease) args.push('--prerelease');
    await run(args);
    release = releaseResponse(await api(`releases/tags/${metadata.tag}`), metadata.tag);
  }
  if (release.draft) {
    if (release.assets.some((asset: any) => !names.includes(asset.name)))
      throw new Error('Existing draft has unexpected assets. Inspect the draft before retrying.');
    await run([
      'gh',
      'release',
      'upload',
      metadata.tag,
      '--repo',
      repository,
      '--clobber',
      ...names.map((name) => join(directory, name)),
    ]);
    release = releaseResponse(await api(`releases/tags/${metadata.tag}`), metadata.tag);
  }
  verifyUploadedAssets(release, digests);
  if (release.draft) {
    const latest = await api('releases/latest', 'GET', undefined, true);
    release = releaseResponse(
      await api(`releases/${release.id}`, 'PATCH', {
        draft: false,
        prerelease: metadata.prerelease,
        make_latest: newerStable(metadata.tag, latest?.tag_name) ? 'true' : 'false',
      }),
      metadata.tag,
    );
  }
  if (release.draft || release.prerelease !== metadata.prerelease)
    throw new Error(
      'Published release state does not match the intended stable/prerelease channel.',
    );
  verifyUploadedAssets(release, digests);
  if (!release.immutable)
    throw new Error(
      'Published release is not immutable. Enable repository release immutability before any further releases.',
    );
  log(`Published immutable release: ${release.html_url}`);
  return release;
}
if (import.meta.main) await publishRelease(resolve(process.argv[2] ?? 'dist/release'));
