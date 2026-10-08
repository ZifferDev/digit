import { test, expect, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withProjectOperation } from '../src/operations.ts';
const directories: string[] = [];
async function temp() {
  const directory = await mkdtemp(join(tmpdir(), 'digit-operation-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
test('concurrent project operations fail clearly, then lock is released', async () => {
  const root = await temp();
  let release!: () => void;
  let entered!: () => void;
  const entry = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const running = withProjectOperation(root, async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return 'done';
  });
  await entry;
  try {
    await expect(withProjectOperation(root, async () => 'bad')).rejects.toThrow(
      'Another digit operation',
    );
  } finally {
    release();
  }
  expect(await running).toBe('done');
  expect(await withProjectOperation(root, async () => 'next')).toBe('next');
  expect(await Bun.file(join(root, '.digit', 'operation.lock')).exists()).toBe(false);
});
test('failed or cancelled operation releases its lock', async () => {
  const root = await temp();
  await expect(
    withProjectOperation(root, async () => {
      throw new Error('cancelled');
    }),
  ).rejects.toThrow('cancelled');
  expect(await withProjectOperation(root, async () => 42)).toBe(42);
});
test('recovers a lock left by an exited process', async () => {
  const root = await temp();
  const child = Bun.spawn([process.execPath, '-e', ''], { stdout: 'ignore', stderr: 'ignore' });
  await child.exited;
  await mkdir(join(root, '.digit'));
  await Bun.write(
    join(root, '.digit', 'operation.lock'),
    JSON.stringify({ pid: child.pid, token: 'stale' }),
  );
  expect(await withProjectOperation(root, async () => 'recovered')).toBe('recovered');
  expect(await Bun.file(join(root, '.digit', 'operation.lock.recovery')).exists()).toBe(false);
});
test('invalid lock is preserved rather than assumed abandoned', async () => {
  const root = await temp();
  await mkdir(join(root, '.digit'));
  await Bun.write(join(root, '.digit', 'operation.lock'), '');
  await expect(withProjectOperation(root, async () => {})).rejects.toThrow('inspect it');
  expect(await Bun.file(join(root, '.digit', 'operation.lock')).exists()).toBe(true);
});
test('rejects a symlinked local state directory', async () => {
  const root = await temp();
  const other = await temp();
  await symlink(other, join(root, '.digit'));
  await expect(withProjectOperation(root, async () => {})).rejects.toThrow('symbolic link');
  expect(await Bun.file(join(other, 'operation.lock')).exists()).toBe(false);
});
test('rejects a symlinked operation lock', async () => {
  const root = await temp();
  await mkdir(join(root, '.digit'));
  await Bun.write(join(root, 'other'), JSON.stringify({ pid: 1, token: 'preserve' }));
  await symlink(join(root, 'other'), join(root, '.digit', 'operation.lock'));
  await expect(withProjectOperation(root, async () => {})).rejects.toThrow('ordinary file');
  expect(await Bun.file(join(root, 'other')).text()).toContain('preserve');
});
