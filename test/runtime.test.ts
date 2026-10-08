import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command, consentPath, ensureEula } from '../src/runtime';

const directories: string[] = [];
const original = process.env.DIGIT_STATE_HOME;
afterEach(async () => {
  if (original === undefined) delete process.env.DIGIT_STATE_HOME;
  else process.env.DIGIT_STATE_HOME = original;
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function isolated() {
  const path = await mkdtemp(join(tmpdir(), 'digit-consent-'));
  directories.push(path);
  process.env.DIGIT_STATE_HOME = path;
  return path;
}

describe('explicit local EULA consent', () => {
  test('refuses unattended start without acceptance and does not save consent', async () => {
    await isolated();
    await expect(ensureEula(false)).rejects.toThrow('EULA acceptance is required');
    expect(await Bun.file(consentPath()).exists()).toBe(false);
  });
  test('records explicit consent privately and reuses it without prompting', async () => {
    const root = await isolated();
    await ensureEula(true);
    const path = consentPath();
    expect(path.startsWith(root)).toBe(true);
    const record = JSON.parse(await readFile(path, 'utf8'));
    expect(record.accepted).toBe(true);
    expect(record.url).toBe('https://www.minecraft.net/eula');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await ensureEula(false);
    expect(JSON.parse(await readFile(path, 'utf8')).acceptedAt).toBe(record.acceptedAt);
  });
  test('corrupt or unrelated records do not authorize starting', async () => {
    await isolated();
    await ensureEula(true);
    await writeFile(consentPath(), '{broken');
    await expect(ensureEula(false)).rejects.toThrow('EULA acceptance is required');
    await writeFile(consentPath(), JSON.stringify({ accepted: true, url: 'different' }));
    await expect(ensureEula(false)).rejects.toThrow('EULA acceptance is required');
  });
});

test('subprocess arguments remain literal and failures are actionable', async () => {
  const input = 'hello; $(exit 42) `not-a-command`';
  expect(
    (
      await command([process.execPath, '-e', 'console.log(process.argv[1])', input], {
        capture: true,
      })
    ).trim(),
  ).toBe(input);
  await expect(
    command([process.execPath, '-e', 'console.error("intentional failure");process.exit(7)'], {
      capture: true,
    }),
  ).rejects.toThrow('intentional failure');
});

test('interactive subprocess exit handling accepts only the expected detach response', async () => {
  const acceptExit = (code: number, stderr: string) =>
    code === 1 && stderr.trim() === 'read escape sequence';
  await expect(
    command([process.execPath, '-e', 'console.error("read escape sequence"); process.exit(1)'], {
      acceptExit,
    }),
  ).resolves.toBe('');
  await expect(
    command([process.execPath, '-e', 'console.error("permission denied"); process.exit(1)'], {
      acceptExit,
    }),
  ).rejects.toThrow('permission denied');
  await expect(
    command([process.execPath, '-e', 'console.error("read escape sequence"); process.exit(2)'], {
      acceptExit,
    }),
  ).rejects.toThrow('exit 2');
});
