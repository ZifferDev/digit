#!/usr/bin/env bun
import { newerStable } from './publish';
import { homebrewFormula, parseReleaseTag, releaseAssets } from './release';

const repository = 'ZifferDev/digit';
const endpoint = 'https://api.github.com/repos/ZifferDev/homebrew-tap/contents/Formula/digit.rb';
export interface TapDependencies {
  environment?: Record<string, string | undefined>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  log?: (message: string) => void;
}
function formulaVersion(content: string): string | undefined {
  const matches = [...content.matchAll(/^  version "([^"\r\n]+)"$/gm)];
  return /^class Digit < Formula$/m.test(content) && matches.length === 1
    ? matches[0]?.[1]
    : undefined;
}
function validateFormula(formula: string, parsed: ReturnType<typeof parseReleaseTag>) {
  if (formulaVersion(formula) !== parsed.version)
    throw new Error('Formula version or class does not match the digit release tag.');
  const downloads = [...formula.matchAll(/^\s+url "([^"\r\n]+)"\n\s+sha256 "([a-f0-9]{64})"$/gm)];
  const assets = releaseAssets(
    parsed.version,
    repository,
    downloads.map((match) => ({ name: match[1]!.split('/').at(-1)!, sha256: match[2]! })),
  );
  const expected = homebrewFormula({ schema: 1, ...parsed, repository, assets });
  if (formula !== expected)
    throw new Error(
      'Formula must be the unchanged generated formula for the verified ZifferDev/digit release.',
    );
}
function readPrevious(value: unknown): { sha: string; content: string } {
  if (!value || typeof value !== 'object') throw new Error('Unexpected Homebrew formula response.');
  const previous = value as Record<string, unknown>;
  if (
    previous.type !== 'file' ||
    previous.encoding !== 'base64' ||
    typeof previous.sha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(previous.sha) ||
    typeof previous.content !== 'string'
  )
    throw new Error('Unexpected Homebrew formula response.');
  const encoded = previous.content.replace(/[\r\n]/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    throw new Error('Invalid base64 content in Homebrew formula response.');
  const bytes = Buffer.from(encoded, 'base64');
  const content = bytes.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(bytes))
    throw new Error('Homebrew formula is not valid UTF-8.');
  return { sha: previous.sha, content };
}

/** The tap-only token is never used for source-repository requests. */
export async function updateTap(
  formula: string,
  dependencies: TapDependencies = {},
): Promise<'created' | 'updated' | 'unchanged'> {
  const environment = dependencies.environment ?? process.env;
  const request = dependencies.fetch ?? fetch;
  const log = dependencies.log ?? console.log;
  const tag = environment.GITHUB_REF_NAME ?? '';
  const parsed = parseReleaseTag(tag);
  if (parsed.prerelease) throw new Error('Only stable releases can update Homebrew.');
  if (environment.GITHUB_REF_TYPE !== 'tag')
    throw new Error('Homebrew updates must run from a version tag.');
  if (environment.GITHUB_REPOSITORY !== repository)
    throw new Error(`Homebrew updates must originate from ${repository}.`);
  const token = environment.HOMEBREW_TAP_TOKEN;
  if (!token) throw new Error('HOMEBREW_TAP_TOKEN is required.');
  validateFormula(formula, parsed);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const response = await request(`${endpoint}?ref=main`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok && response.status !== 404)
    throw new Error(`Cannot read Homebrew formula: HTTP ${response.status}`);
  let sha: string | undefined;
  if (response.ok) {
    const previous = readPrevious(await response.json());
    if (previous.content === formula) {
      log('Homebrew formula is already current.');
      return 'unchanged';
    }
    const current = formulaVersion(previous.content);
    if (!current) throw new Error('Refusing to replace an unrecognized Homebrew formula.');
    if (current === parsed.version)
      throw new Error(
        'Refusing to replace different formula content for the same immutable release version.',
      );
    if (!newerStable(tag, `v${current}`))
      throw new Error('Refusing to downgrade the Homebrew formula.');
    sha = previous.sha;
  }
  const result = await request(endpoint, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `digit ${tag}`,
      content: Buffer.from(formula).toString('base64'),
      branch: 'main',
      ...(sha ? { sha } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!result.ok)
    throw new Error(
      `Homebrew update failed: HTTP ${result.status}. Check the tap-only token and retry the update-homebrew workflow.`,
    );
  log(`Updated ZifferDev/homebrew-tap to ${tag}.`);
  return sha ? 'updated' : 'created';
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: bun scripts/update-tap.ts <verified digit.rb>');
  await updateTap(await Bun.file(file).text());
}
