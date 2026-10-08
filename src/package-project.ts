import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { parseManifest } from './config';
import { editManifest } from './manifest-edit';
import { planAdd, planRemove, type PackageDependencies, type PackageOptions } from './packages';
import { readLock } from './resolve';
import { withProjectOperation } from './operations';

async function snapshot(path: string): Promise<{ text: string; mode: number } | undefined> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Package management requires an ordinary file: ${path}`);
    return { text: await readFile(path, 'utf8'), mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function changePackages(
  root: string,
  action: 'add' | 'remove',
  inputs: string[],
  options: PackageOptions = {},
  deps: PackageDependencies = {},
): Promise<string[]> {
  return withProjectOperation(root, async () => {
    const manifestPath = join(root, 'digit.toml'),
      lockPath = join(root, 'digit.lock');
    const source = await snapshot(manifestPath),
      originalLock = await snapshot(lockPath);
    if (!source) throw new Error(`No digit.toml found at ${root}. Run digit init first.`);
    const before = parseManifest(parse(source.text));
    const previous = await readLock(root);
    const plan = await (action === 'add' ? planAdd : planRemove)(
      before,
      inputs,
      options,
      previous,
      deps,
    );
    const nextManifest = editManifest(source.text, before, plan.manifest);
    const nextLock = `${JSON.stringify(plan.lock, null, 2)}\n`;
    if (nextManifest === source.text && nextLock === originalLock?.text) return [];
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
            `${entry.path} changed while selecting plugins. Retry against the current files; no changes were saved.`,
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
    return plan.changes.length ? plan.changes : ['Updated dependency lock metadata.'];
  });
}
