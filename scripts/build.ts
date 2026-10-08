#!/usr/bin/env bun
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dir, '..');
const destination = join(root, 'dist');
await mkdir(destination, { recursive: true });
const targets = [
  ['darwin-arm64', 'bun-darwin-arm64'],
  ['linux-arm64', 'bun-linux-arm64'],
  ['linux-x64', 'bun-linux-x64-baseline'],
] as const;
const checksums: string[] = [];
for (const [name, target] of targets) {
  const filename = `digit-${name}`;
  console.log(`Building ${filename}…`);
  const child = Bun.spawn(
    [
      process.execPath,
      'build',
      '--compile',
      `--target=${target}`,
      'src/cli.ts',
      '--outfile',
      join(destination, filename),
    ],
    { cwd: root, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
  );
  if ((await child.exited) !== 0) throw new Error(`Compilation failed for ${name}.`);
  const bytes = await Bun.file(join(destination, filename)).arrayBuffer();
  checksums.push(`${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}  ${filename}`);
}
await Bun.write(join(destination, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
console.log('Release binaries and SHA256SUMS are in dist/.');
