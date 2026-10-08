import { snapshot, saveProjectFiles } from './project-files';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { parseManifest } from './config';
import { editManifest } from './manifest-edit';
import { planAdd, planRemove, type PackageDependencies, type PackageOptions } from './packages';
import { readLock } from './resolve';
import { withProjectOperation } from './operations';

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
    await saveProjectFiles(root, source, originalLock, nextManifest, nextLock);
    return plan.changes.length ? plan.changes : ['Updated dependency lock metadata.'];
  });
}
