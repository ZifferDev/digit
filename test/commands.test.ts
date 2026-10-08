import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sendCommand } from '../src/runtime';
import type { Deployment } from '../src/types';

const directories: string[] = [];
const originalPath = process.env.PATH;
const originalCapture = process.env.DIGIT_TEST_COMMAND_CAPTURE;
afterEach(async () => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalCapture === undefined) delete process.env.DIGIT_TEST_COMMAND_CAPTURE;
  else process.env.DIGIT_TEST_COMMAND_CAPTURE = originalCapture;
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const deployment = {
  projectName: 'digit-command-test',
  composeFile: '/unused/compose.yaml',
  environment: 'preview',
  manifest: {
    services: {
      survival: { type: 'paper' },
      proxy: { type: 'velocity' },
      database: { type: 'mariadb' },
    },
  },
} as unknown as Deployment;
async function fakeDocker(fail = false) {
  const directory = await mkdtemp(join(tmpdir(), 'digit-command-'));
  directories.push(directory);
  const capture = join(directory, 'arguments.json');
  const executable = join(directory, 'docker');
  await Bun.write(
    executable,
    `#!${process.execPath}\nawait Bun.write(process.env.DIGIT_TEST_COMMAND_CAPTURE, JSON.stringify(process.argv.slice(2)));\n${fail ? 'console.error("RCON connection refused"); process.exit(1);' : ''}\n`,
  );
  await chmod(executable, 0o755);
  process.env.PATH = `${directory}:${originalPath ?? ''}`;
  process.env.DIGIT_TEST_COMMAND_CAPTURE = capture;
  return capture;
}
test.each(['survival', 'proxy'])(
  'console commands for %s use local authenticated RCON without a shell',
  async (service) => {
    const capture = await fakeDocker();
    const text = 'say hello; $(touch never) `literal` --flag';
    await sendCommand(deployment, service, `/${text}`);
    const args = (await Bun.file(capture).json()) as string[];
    expect(args.slice(0, 5)).toEqual([
      'compose',
      '--project-name',
      deployment.projectName,
      '--file',
      deployment.composeFile,
    ]);
    expect(args.slice(5)).toEqual([
      'exec',
      '-T',
      service,
      'rcon-cli',
      '--host',
      '127.0.0.1',
      '--port',
      '25575',
      '--',
      text,
    ]);
    expect(args).not.toContain('--password');
    expect(args).not.toContain('sh');
    expect(args).not.toContain('bash');
  },
);
test('invalid targets and multiline commands never reach Docker', async () => {
  const capture = await fakeDocker();
  await expect(sendCommand(deployment, 'unknown', 'list')).rejects.toThrow('Unknown service');
  await expect(sendCommand(deployment, 'constructor', 'list')).rejects.toThrow('Unknown service');
  await expect(sendCommand(deployment, 'database', 'list')).rejects.toThrow('database');
  for (const command of ['', '   ', '/', 'list\nstop', 'list\rstop', 'list\0stop'])
    await expect(sendCommand(deployment, 'survival', command)).rejects.toThrow();
  expect(await Bun.file(capture).exists()).toBe(false);
});
test('connection failures explain readiness and the upgrade command', async () => {
  await fakeDocker(true);
  await expect(sendCommand(deployment, 'survival', 'list')).rejects.toThrow(
    'run digit up --env preview',
  );
});
