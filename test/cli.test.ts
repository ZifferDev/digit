import { test, expect, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const entry = resolve(import.meta.dir, '../src/cli.ts');
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, entry, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}
test('CLI help describes guided setup and environment workflow', async () => {
  const result = await cli(['--help']);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('digit init friends');
  expect(result.stdout).toContain('--env plugin-test --profile staging');
  expect(result.stdout).toContain('complete');
});
test('CLI reports unknown options without stack traces', async () => {
  const result = await cli(['up', '--typo']);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("unknown option '--typo'");
  expect(result.stderr).not.toContain(' at ');
});
test.each(['bash', 'zsh', 'fish'])('generates %s completion script', async (shell) => {
  const result = await cli(['complete', shell]);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('digit');
  expect(result.stdout).toContain('complete');
  expect(result.stderr).toBe('');
});
test('completion suggests commands', async () => {
  const result = await cli(['complete', '--', '']);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('up');
  expect(result.stdout).toContain('init');
  expect(result.stdout).toContain('console');
});
test('console help explains picker and safe detachment', async () => {
  const result = await cli(['console', '--help']);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('digit console survival');
  expect(result.stdout).toContain('Ctrl+P, then Ctrl+Q');
});
test('completion suggests project service names without network calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'digit-completion-'));
  directories.push(directory);
  await Bun.write(
    join(directory, 'digit.toml'),
    '[services.survival]\ntype="paper"\n[services.lobby]\ntype="paper"\n',
  );
  const result = await cli(['--project', directory, 'complete', '--', 'logs', '']);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain('survival');
  expect(result.stdout).toContain('lobby');
});
test('noninteractive init explains --yes requirement', async () => {
  const result = await cli(['init']);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('--yes');
});

test('command help explains console usage and teardown flag is explicit', async () => {
  const cmd = await cli(['cmd', '--help']);
  expect(cmd.code).toBe(0);
  expect(cmd.stdout).toContain('digit cmd survival say Hello friends');
  const down = await cli(['down', '--help']);
  expect(down.stdout).toContain('--destroy-all-data');
});

test.each(['cmd', 'console'])(
  '%s completes Minecraft services and excludes databases',
  async (command) => {
    const directory = await mkdtemp(join(tmpdir(), 'digit-cmd-completion-'));
    directories.push(directory);
    await Bun.write(
      join(directory, 'digit.toml'),
      '[services.survival]\ntype="paper"\n[services.proxy]\ntype="velocity"\n[services.database]\ntype="mariadb"\n',
    );
    const result = await cli(['--project', directory, 'complete', '--', command, '']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('survival');
    expect(result.stdout).toContain('proxy');
    expect(result.stdout).not.toContain('database');
  },
);

async function runtimeDispatch(args: string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'digit-cmd-dispatch-'));
  directories.push(directory);
  await Bun.write(
    join(directory, '.digit', 'environments', 'dev', 'deployment.json'),
    JSON.stringify({
      composeFile: '/unused/compose.yaml',
      projectName: 'test',
      manifest: { services: { survival: { type: 'paper' } } },
    }),
  );
  // Keep the real CLI parser and deployment lookup; replace only Docker-facing calls.
  const script = `import {mock} from 'bun:test';
mock.module(${JSON.stringify(resolve(import.meta.dir, '../src/runtime.ts'))}, () => ({
  command: async () => { throw new Error('Unexpected Docker call'); },
  sendCommand: async (_deployment, service, command) => console.log(JSON.stringify({service,command})),
  down: async (_deployment, options) => console.log(JSON.stringify(options)),
}));
const {main} = await import(${JSON.stringify(entry)});
await main(['bun','digit','--project',${JSON.stringify(directory)},...${JSON.stringify(args)}]);`;
  const child = Bun.spawn([process.execPath, '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe('');
  expect(code).toBe(0);
  return JSON.parse(stdout);
}
test.each([
  { args: ['say', 'Hello', 'friends'], expected: 'say Hello friends' },
  { args: ['say Hello friends'], expected: 'say Hello friends' },
  {
    args: ['--', 'plugincommand', '--flag', 'literal;$(no-shell)'],
    expected: 'plugincommand --flag literal;$(no-shell)',
  },
])('cmd forwards console arguments literally: %j', async ({ args, expected }) => {
  expect(await runtimeDispatch(['cmd', 'survival', ...args])).toEqual({
    service: 'survival',
    command: expected,
  });
});
test('down passes destructive intent only when explicitly selected', async () => {
  expect(await runtimeDispatch(['down'])).toEqual({});
  expect(await runtimeDispatch(['down', '--destroy-all-data'])).toEqual({ destroyAllData: true });
});
