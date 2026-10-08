import { expect, test } from 'bun:test';
import { updateTap } from '../scripts/update-tap';
import {
  archiveName,
  homebrewFormula,
  parseReleaseTag,
  PLATFORMS,
  releaseAssets,
} from '../scripts/release';
const environment = {
  GITHUB_REF_NAME: 'v1.2.3',
  GITHUB_REF_TYPE: 'tag',
  GITHUB_REPOSITORY: 'ZifferDev/digit',
  HOMEBREW_TAP_TOKEN: 'tap-only-token',
  GH_TOKEN: 'source-token-must-not-be-used',
};
function formula(version = '1.2.3') {
  return homebrewFormula({
    schema: 1,
    ...parseReleaseTag(`v${version}`),
    repository: 'ZifferDev/digit',
    assets: releaseAssets(
      version,
      'ZifferDev/digit',
      PLATFORMS.map((platform) => ({
        name: archiveName(version, platform),
        sha256: 'a'.repeat(64),
      })),
    ),
  });
}
const sha = 'b'.repeat(40);
function previous(content: string) {
  return Response.json({
    type: 'file',
    encoding: 'base64',
    sha,
    content: Buffer.from(content).toString('base64'),
  });
}
function api(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const logs: string[] = [];
  return {
    calls,
    logs,
    dependencies: {
      environment,
      log: (message: string) => logs.push(message),
      fetch: async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const next = responses.shift();
        if (!next) throw new Error('Unexpected additional request');
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}
test('bootstraps a missing formula using only the tap-scoped token', async () => {
  const mock = api([new Response('', { status: 404 }), Response.json({}, { status: 201 })]);
  const content = formula();
  expect(await updateTap(content, mock.dependencies)).toBe('created');
  expect(mock.calls).toHaveLength(2);
  expect(mock.calls[0]!.url).toBe(
    'https://api.github.com/repos/ZifferDev/homebrew-tap/contents/Formula/digit.rb?ref=main',
  );
  const request = mock.calls[1]!;
  expect(request.init.method).toBe('PUT');
  const body = JSON.parse(request.init.body as string);
  expect(body).toEqual({
    message: 'digit v1.2.3',
    content: Buffer.from(content).toString('base64'),
    branch: 'main',
  });
  for (const call of mock.calls) {
    expect(new Headers(call.init.headers).get('Authorization')).toBe('Bearer tap-only-token');
    expect(call.url).toStartWith('https://api.github.com/repos/ZifferDev/homebrew-tap/');
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  }
});
test('identical formula is an idempotent no-op', async () => {
  const mock = api([previous(formula())]);
  expect(await updateTap(formula(), mock.dependencies)).toBe('unchanged');
  expect(mock.calls).toHaveLength(1);
  expect(mock.logs).toEqual(['Homebrew formula is already current.']);
});
test('upgrades stable version using the inspected blob SHA for compare-and-swap', async () => {
  const mock = api([previous(formula('1.2.2')), Response.json({}, { status: 200 })]);
  expect(await updateTap(formula(), mock.dependencies)).toBe('updated');
  expect(JSON.parse(mock.calls[1]!.init.body as string).sha).toBe(sha);
});
test('rejects downgrades without PUT', async () => {
  const mock = api([previous(formula('1.3.0'))]);
  await expect(updateTap(formula(), mock.dependencies)).rejects.toThrow('downgrade');
  expect(mock.calls).toHaveLength(1);
});
test('rejects same-version formula replacement', async () => {
  const mock = api([previous(formula().replace('desc "Declarative', 'desc "Changed declarative'))]);
  await expect(updateTap(formula(), mock.dependencies)).rejects.toThrow('same immutable release');
  expect(mock.calls).toHaveLength(1);
});
test.each([
  { GITHUB_REF_NAME: 'v1.2.3-rc.1' },
  { GITHUB_REF_NAME: 'main' },
  { GITHUB_REF_TYPE: 'branch' },
  { GITHUB_REPOSITORY: 'unrelated/repository' },
  { HOMEBREW_TAP_TOKEN: '' },
])('rejects unauthorized release context %j before network', async (override) => {
  const mock = api([]);
  await expect(
    updateTap(formula(), { ...mock.dependencies, environment: { ...environment, ...override } }),
  ).rejects.toThrow();
  expect(mock.calls).toHaveLength(0);
});
test.each([
  (content: string) => content.replace('version "1.2.3"', 'version "1.2.4"'),
  (content: string) => content.replace('class Digit < Formula', 'class Other < Formula'),
  (content: string) =>
    content.replaceAll('https://github.com/ZifferDev/digit', 'https://evil.example/digit'),
  (content: string) => `${content}\nsystem "unexpected command"\n`,
  (content: string) => content.replace('  version "1.2.3"', '  version "1.2.3"\n  version "1.2.3"'),
])('rejects wrong or modified candidate formula before network', async (modify) => {
  const mock = api([]);
  await expect(updateTap(modify(formula()), mock.dependencies)).rejects.toThrow();
  expect(mock.calls).toHaveLength(0);
});
test.each([401, 403, 409, 500])('GET HTTP %s is not mistaken for bootstrap', async (status) => {
  const mock = api([new Response('', { status })]);
  await expect(updateTap(formula(), mock.dependencies)).rejects.toThrow(`HTTP ${status}`);
  expect(mock.calls).toHaveLength(1);
  expect(mock.logs).toHaveLength(0);
});
test.each([401, 403, 409, 422, 500])(
  'PUT HTTP %s fails without swallowing or unsafe retry',
  async (status) => {
    const mock = api([previous(formula('1.2.2')), new Response('', { status })]);
    await expect(updateTap(formula(), mock.dependencies)).rejects.toThrow(`HTTP ${status}`);
    expect(mock.calls).toHaveLength(2);
    expect(mock.logs).toHaveLength(0);
  },
);
test.each([
  { type: 'dir', encoding: 'base64', sha, content: '' },
  { type: 'file', encoding: 'none', sha, content: '' },
  { type: 'file', encoding: 'base64', sha: '', content: '' },
  { type: 'file', encoding: 'base64', sha, content: '!!!!' },
])('rejects malformed GitHub file responses', async (response) => {
  const mock = api([Response.json(response)]);
  await expect(updateTap(formula(), mock.dependencies)).rejects.toThrow();
  expect(mock.calls).toHaveLength(1);
});
test('rejects unrecognized current formula rather than replacing it', async () => {
  const mock = api([previous('class Other < Formula\n  version "1.2.2"\nend\n')]);
  await expect(updateTap(formula(), mock.dependencies)).rejects.toThrow('unrecognized');
  expect(mock.calls).toHaveLength(1);
});
test('propagates network failures without success logs', async () => {
  const mock = api([new Error('network unavailable')]);
  await expect(updateTap(formula(), mock.dependencies)).rejects.toThrow('network unavailable');
  expect(mock.logs).toHaveLength(0);
});
