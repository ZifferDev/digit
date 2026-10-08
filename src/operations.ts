import { mkdir, open, lstat, readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { environmentDirectory } from './deployment.ts';

type Owner = { pid: number; token: string };
const busy = (path: string) =>
  new Error(
    `Another digit operation owns ${path}. Wait for it to finish. If an interrupted process left an invalid lock, inspect it before removing the file.`,
  );
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
async function readOwner(path: string): Promise<Owner> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error(`Operation lock must be an ordinary file: ${path}`);
  let owner: Owner;
  try {
    owner = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw busy(path);
  }
  if (
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.token !== 'string' ||
    !owner.token
  )
    throw busy(path);
  return owner;
}
async function createLock(path: string): Promise<Owner> {
  const owner = { pid: process.pid, token: randomUUID() };
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(owner));
  } finally {
    await file.close();
  }
  return owner;
}
async function releaseLock(path: string, owner: Owner): Promise<void> {
  try {
    const current = await readOwner(path);
    if (current.pid === owner.pid && current.token === owner.token) await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
async function acquireLock(path: string): Promise<Owner> {
  try {
    return await createLock(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const previous = await readOwner(path);
  if (alive(previous.pid)) throw busy(path);
  // Serialize stale reclamation. Without this guard, simultaneous reclaimers could
  // delete a lock already acquired by another process after the stale check.
  const recoveryPath = `${path}.recovery`;
  let recovery: Owner;
  try {
    recovery = await createLock(recoveryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw busy(recoveryPath);
    throw error;
  }
  try {
    const current = await readOwner(path);
    if (alive(current.pid)) throw busy(path);
    await unlink(path);
    try {
      return await createLock(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw busy(path);
      throw error;
    }
  } finally {
    await releaseLock(recoveryPath, recovery);
  }
}

/** Serialize mutations across environments sharing a project's lockfile and state. */
export async function withProjectOperation<T>(root: string, work: () => Promise<T>): Promise<T> {
  root = resolve(root);
  await environmentDirectory(root, 'dev');
  const state = join(root, '.digit');
  await mkdir(state, { recursive: true, mode: 0o700 });
  const path = join(state, 'operation.lock');
  const owner = await acquireLock(path);
  try {
    return await work();
  } finally {
    await releaseLock(path, owner);
  }
}
