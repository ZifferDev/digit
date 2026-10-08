#!/usr/bin/env bun
// Exercise the real packaged executable through the installer without publishing a release.
import { chmod, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { VERSION } from '../src/version';

const archive = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !(await Bun.file(archive).exists()))
  throw new Error('Usage: bun scripts/smoke-install.ts <native release archive>');
const root = await mkdtemp(join(tmpdir(), 'digit-install-smoke-'));
try {
  const mocks = join(root, 'mocks');
  await mkdir(mocks);
  const hash = new Bun.CryptoHasher('sha256').update(await Bun.file(archive).bytes()).digest('hex');
  await Bun.write(join(root, 'SHA256SUMS'), `${hash}  ${basename(archive)}\n`);
  // Only downloads are substituted: platform detection, tar, checksum checks and execution are real.
  await Bun.write(
    join(mocks, 'curl'),
    `#!/bin/sh
set -eu
output=; url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output=$2; shift 2 ;;
    --proto|--proto-redir|--connect-timeout|--max-time) shift 2 ;;
    --*) shift ;;
    *) url=$1; shift ;;
  esac
done
case "$url" in
  "https://github.com/ZifferDev/digit/releases/download/v$SMOKE_VERSION/$SMOKE_ASSET") cp "$SMOKE_ARCHIVE" "$output" ;;
  "https://github.com/ZifferDev/digit/releases/download/v$SMOKE_VERSION/SHA256SUMS") cp "$SMOKE_CHECKSUMS" "$output" ;;
  *) echo 'Unexpected installer download' >&2; exit 1 ;;
esac
`,
  );
  await chmod(join(mocks, 'curl'), 0o755);
  const env = {
    ...process.env,
    PATH: `${mocks}:/usr/bin:/bin:/usr/sbin:/sbin`,
    DIGIT_REPOSITORY: 'ZifferDev/digit',
    SMOKE_ARCHIVE: archive,
    SMOKE_ASSET: basename(archive),
    SMOKE_VERSION: VERSION,
    SMOKE_CHECKSUMS: join(root, 'SHA256SUMS'),
  };
  const destination = join(root, 'installed cli');
  async function run(args: string[]) {
    const child = Bun.spawn(args, { env, stdout: 'inherit', stderr: 'inherit' });
    if ((await child.exited) !== 0) throw new Error(`Installer smoke failed: ${args[0]}`);
  }
  // A second pass also exercises replacement of an existing compiled digit executable.
  for (let attempt = 0; attempt < 2; attempt++)
    await run([
      '/bin/sh',
      resolve(import.meta.dir, 'install.sh'),
      '--version',
      VERSION,
      '--install-dir',
      destination,
    ]);
  await run([join(destination, 'digit'), '--version']);
  await run([join(destination, 'digit'), 'console', '--help']);
} finally {
  await rm(root, { recursive: true, force: true });
}
