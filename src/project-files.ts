import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function snapshot(path: string): Promise<{ text: string; mode: number } | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Project updates require an ordinary file: ${path}`);
    return { text: await readFile(path, 'utf8'), mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function saveProjectFiles(
  root: string,
  source: NonNullable<Awaited<ReturnType<typeof snapshot>>>,
  originalLock: Awaited<ReturnType<typeof snapshot>>,
  nextManifest: string,
  nextLock: string,
): Promise<void> {
  const manifestPath = join(root, 'digit.toml'),
    lockPath = join(root, 'digit.lock');
  const entries = [
    { path: lockPath, before: originalLock, text: nextLock },
    { path: manifestPath, before: source, text: nextManifest },
  ].map((entry) => ({ ...entry, staged: `${entry.path}.${crypto.randomUUID()}.tmp` }));
  const applied: typeof entries = [];
  try {
    for (const entry of entries)
      await writeFile(entry.staged, entry.text, {
        flag: 'wx',
        mode: entry.before?.mode ?? 0o644,
      });
    for (const entry of entries)
      if ((await snapshot(entry.path))?.text !== entry.before?.text)
        throw new Error(
          `${entry.path} changed while preparing changes. Retry against the current files; no changes were saved.`,
        );
    // Both are staged before replacement. A process crash between renames leaves a detectable
    // stale lock; --frozen-lockfile fails closed and normal resolution can repair it.
    for (const entry of entries) {
      await rename(entry.staged, entry.path);
      applied.push(entry);
    }
  } catch (error) {
    for (const entry of applied.reverse()) {
      if ((await snapshot(entry.path))?.text !== entry.text) continue;
      if (entry.before) {
        await writeFile(entry.staged, entry.before.text, { flag: 'wx', mode: entry.before.mode });
        await rename(entry.staged, entry.path);
      } else await rm(entry.path);
    }
    throw error;
  } finally {
    await Promise.all(entries.map((entry) => rm(entry.staged, { force: true })));
  }
}
