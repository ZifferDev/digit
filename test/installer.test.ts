import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const installer = resolve(import.meta.dir, '../scripts/install.sh');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function command(args: string[], env?: Record<string, string | undefined>) {
  const child = Bun.spawn(args, {
    env: env ?? process.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}
async function executable(path: string, content: string) {
  await Bun.write(path, content);
  await chmod(path, 0o755);
}
function binary(version: string) {
  return `#!/bin/sh\ncase "$1" in --version) echo '${version}' ;; --help) echo 'Usage: digit [options] [command]' ;; *) exit 1 ;; esac\n`;
}
async function fixture(version = '0.1.0-rc.2', os = 'linux', arch = 'x64') {
  const root = await mkdtemp(join(tmpdir(), 'digit-installer-'));
  roots.push(root);
  const mocks = join(root, 'mocks'),
    releases = join(root, 'releases'),
    archive = join(root, 'archive'),
    destination = join(root, 'install with spaces');
  await Promise.all([
    mkdir(mocks),
    mkdir(releases),
    mkdir(join(archive, 'completions'), { recursive: true }),
  ]);
  await executable(join(archive, 'digit'), binary(version));
  for (const name of ['digit.bash', '_digit', 'digit.fish'])
    await Bun.write(join(archive, 'completions', name), '# completion\n');
  const asset = `digit-${version}-${os}-${arch}.tar.gz`;
  await Bun.write(join(archive, 'LICENSE'), 'MIT License\n');
  async function pack(members = ['digit', 'LICENSE', 'completions']) {
    const out = await command(['tar', '-czf', join(releases, asset), '-C', archive, ...members]);
    if (out.code) throw new Error(out.stderr);
    await checksum();
  }
  async function checksum() {
    const value = new Bun.CryptoHasher('sha256')
      .update(await Bun.file(join(releases, asset)).bytes())
      .digest('hex');
    await Bun.write(join(releases, 'SHA256SUMS'), `${value}  ${asset}\n`);
  }
  await pack();
  await executable(
    join(mocks, 'curl'),
    `#!/bin/sh
output=; effective=false; url=
for arg in "$@"; do printf '%s\\n' "$arg" >> "$MOCK_LOG"; done
while [ "$#" -gt 0 ]; do
 case "$1" in
 --output) output=$2; shift 2 ;;
 --write-out) effective=true; shift 2 ;;
 --proto|--proto-redir|--connect-timeout|--max-time) shift 2 ;;
 --*) shift ;;
 *) url=$1; shift ;;
 esac
done
if [ "$effective" = true ]; then printf '%s' "$MOCK_LATEST"; exit 0; fi
name=\${url##*/}
[ "\${MOCK_FAIL:-}" != "$name" ] || exit 22
cp "$MOCK_RELEASES/$name" "$output"
`,
  );
  await executable(
    join(mocks, 'uname'),
    '#!/bin/sh\ncase "$1" in -s) echo "$MOCK_OS" ;; -m) echo "$MOCK_ARCH" ;; esac\n',
  );
  await executable(join(mocks, 'getconf'), '#!/bin/sh\nprintf "%s\\n" "$MOCK_LIBC"\n');
  await executable(join(mocks, 'ldd'), '#!/bin/sh\nprintf "%s\\n" "$MOCK_LDD"\n');
  const env = {
    ...process.env,
    PATH: `${mocks}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: join(root, 'home'),
    TMPDIR: root,
    DIGIT_REPOSITORY: 'ZifferDev/digit',
    MOCK_OS: os === 'darwin' ? 'Darwin' : 'Linux',
    MOCK_ARCH: arch === 'arm64' ? 'aarch64' : 'x86_64',
    MOCK_LIBC: 'glibc 2.39',
    MOCK_LDD: 'ldd (GNU libc) 2.39',
    MOCK_RELEASES: releases,
    MOCK_LOG: join(root, 'curl.log'),
    MOCK_LATEST: `https://github.com/ZifferDev/digit/releases/tag/v${version}`,
  };
  const run = (args: string[] = [], overrides: Record<string, string | undefined> = {}) =>
    command(['/bin/sh', installer, '--install-dir', destination, ...args], {
      ...env,
      ...overrides,
    });
  return { root, mocks, releases, archive, destination, asset, env, run, pack, checksum };
}

test('installs a pinned release atomically and updates a recognized existing digit', async () => {
  const f = await fixture();
  await mkdir(f.destination);
  await executable(join(f.destination, 'digit'), binary('0.1.0-rc.1'));
  const result = await f.run(['--version', 'v0.1.0-rc.2']);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('Installed digit 0.1.0-rc.2');
  expect((await command([join(f.destination, 'digit'), '--version'])).stdout.trim()).toBe(
    '0.1.0-rc.2',
  );
  const requests = await Bun.file(f.env.MOCK_LOG).text();
  expect(requests).toContain('--proto\n=https\n--proto-redir\n=https');
  expect(requests).not.toContain('/releases/latest');
  expect(requests).toContain(`/download/v0.1.0-rc.2/${f.asset}`);
});

test('resolves latest stable using GitHub effective redirect URL without jq', async () => {
  const f = await fixture('1.2.3');
  const result = await f.run();
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('digit 1.2.3');
  expect(await Bun.file(f.env.MOCK_LOG).text()).toContain('/releases/latest');
});

test.each([
  ['darwin', 'arm64'],
  ['linux', 'arm64'],
  ['linux', 'x64'],
])('supports %s/%s assets', async (os, arch) => {
  const f = await fixture('0.1.0', os, arch);
  expect((await f.run(['--version', '0.1.0'])).code).toBe(0);
});

test.each(['../../bad', '0.1.0;touch /tmp/evil', '0.1.0\nmalicious', '0.1.0-beta.1', '', '--help'])(
  'rejects malformed version before network: %s',
  async (version) => {
    const f = await fixture();
    const result = await f.run(['--version', version]);
    expect(result.code).not.toBe(0);
    expect(await Bun.file(f.env.MOCK_LOG).exists()).toBe(false);
  },
);

test.each([
  'bad-checksum',
  'download',
  'bad-archive',
  'wrong-version',
  'duplicate-checksum',
  'missing-checksum',
])('%s failure preserves existing binary', async (mode) => {
  const f = await fixture();
  await mkdir(f.destination);
  const before = binary('0.0.1');
  await executable(join(f.destination, 'digit'), before);
  const overrides: Record<string, string | undefined> = {};
  if (mode === 'bad-checksum')
    await Bun.write(join(f.releases, 'SHA256SUMS'), `${'0'.repeat(64)}  ${f.asset}\n`);
  if (mode === 'download') overrides.MOCK_FAIL = f.asset;
  if (mode === 'bad-archive') {
    await Bun.write(join(f.releases, f.asset), 'not an archive');
    await f.checksum();
  }
  if (mode === 'wrong-version') {
    await executable(join(f.archive, 'digit'), binary('9.9.9'));
    await f.pack();
  }
  if (mode === 'duplicate-checksum') {
    const sum = await Bun.file(join(f.releases, 'SHA256SUMS')).text();
    await Bun.write(join(f.releases, 'SHA256SUMS'), sum + sum);
  }
  if (mode === 'missing-checksum')
    await Bun.write(join(f.releases, 'SHA256SUMS'), `${'0'.repeat(64)}  unrelated.tar.gz\n`);
  expect((await f.run(['--version', '0.1.0-rc.2'], overrides)).code).not.toBe(0);
  expect(await Bun.file(join(f.destination, 'digit')).text()).toBe(before);
});

test.each(['unexpected', 'symlink', 'duplicate'])('rejects unsafe %s archive', async (mode) => {
  const f = await fixture();
  if (mode === 'unexpected') {
    await Bun.write(join(f.archive, 'surprise'), 'bad');
    await f.pack(['digit', 'surprise']);
  }
  if (mode === 'symlink') {
    await rm(join(f.archive, 'digit'));
    await symlink('/etc/passwd', join(f.archive, 'digit'));
    await f.pack();
  }
  if (mode === 'duplicate') await f.pack(['digit', 'digit']);
  const result = await f.run(['--version', '0.1.0-rc.2']);
  expect(result.code).not.toBe(0);
  expect(await Bun.file(join(f.destination, 'digit')).exists()).toBe(false);
});

test('does not overwrite an unknown existing executable', async () => {
  const f = await fixture();
  await mkdir(f.destination);
  await executable(join(f.destination, 'digit'), '#!/bin/sh\necho 0.1.0\n');
  const result = await f.run(['--version', '0.1.0-rc.2']);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('does not identify as digit');
  expect(await Bun.file(f.env.MOCK_LOG).exists()).toBe(false);
});

test('refuses to shadow an active Homebrew binary even when installing elsewhere', async () => {
  const f = await fixture();
  const brewBinary = join(f.root, 'brew/Cellar/digit/0.1.0/bin/digit');
  await executable(brewBinary, binary('0.1.0'));
  await symlink(brewBinary, join(f.mocks, 'digit'));
  const result = await f.run(['--version', '0.1.0-rc.2']);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('Homebrew');
  expect(await Bun.file(f.env.MOCK_LOG).exists()).toBe(false);
});

test.each([
  { MOCK_OS: 'Darwin', MOCK_ARCH: 'x86_64' },
  { MOCK_OS: 'FreeBSD' },
  { MOCK_ARCH: 'riscv64' },
  { MOCK_LIBC: '', MOCK_LDD: 'musl libc (x86_64)' },
])('rejects unsupported platform %j', async (env) => {
  const f = await fixture();
  const result = await f.run(['--version', '0.1.0-rc.2'], env);
  expect(result.code).not.toBe(0);
  expect(await Bun.file(f.env.MOCK_LOG).exists()).toBe(false);
});

test.each([
  'https://evil.example/releases/tag/v1.2.3',
  'https://github.com/ZifferDev/digit/releases/tag/v0.1.0-rc.2',
])('rejects unexpected or prerelease latest redirect %s', async (url) => {
  const f = await fixture();
  const result = await f.run([], { MOCK_LATEST: url });
  expect(result.code).not.toBe(0);
  expect(await Bun.file(join(f.destination, 'digit')).exists()).toBe(false);
});

test('a failed atomic replacement leaves the previous executable intact', async () => {
  const f = await fixture();
  await mkdir(f.destination);
  const before = binary('0.0.1');
  await executable(join(f.destination, 'digit'), before);
  await executable(join(f.mocks, 'mv'), '#!/bin/sh\necho simulated rename failure >&2\nexit 1\n');
  const result = await f.run(['--version', '0.1.0-rc.2']);
  expect(result.code).not.toBe(0);
  expect(await Bun.file(join(f.destination, 'digit')).text()).toBe(before);
});

test('rejects a Homebrew destination reached through relative symlinks', async () => {
  const f = await fixture();
  await mkdir(f.destination);
  const brewBinary = join(f.root, 'brew/Cellar/digit/0.1.0/bin/digit');
  await executable(brewBinary, binary('0.1.0'));
  await symlink('../brew/Cellar/digit/0.1.0/bin/digit', join(f.destination, 'digit'));
  const result = await f.run(['--version', '0.1.0-rc.2']);
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('Homebrew');
  expect(await Bun.file(brewBinary).text()).toBe(binary('0.1.0'));
});

test('help does not require platform detection or downloads', async () => {
  const result = await command(['/bin/sh', installer, '--help'], {
    PATH: '/usr/bin:/bin',
    HOME: tmpdir(),
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('--install-dir');
});

test('uses the user-local bin directory by default', async () => {
  const f = await fixture('0.1.0');
  const result = await command(['/bin/sh', installer, '--version', '0.1.0'], f.env);
  if (process.getuid?.() === 0) {
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('specify --install-dir');
  } else {
    expect(result.code).toBe(0);
    expect(await Bun.file(join(f.env.HOME, '.local/bin/digit')).exists()).toBe(true);
  }
});
