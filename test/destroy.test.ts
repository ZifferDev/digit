import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { destroyEnvironment, type DockerRunner } from '../src/destroy';
import type { Deployment } from '../src/types';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'digit-destroy-')));
  roots.push(root);
  const envDir = join(root, '.digit/environments/dev');
  const directory = join(envDir, 'releases/current');
  await mkdir(directory, { recursive: true });
  await Bun.write(join(root, '.digit/identity'), '123456abcdef');
  await Bun.write(join(envDir, 'secrets.json'), '{"secret":"local"}');
  await Bun.write(join(root, '.digit/environments/staging/secrets.json'), '{"secret":"other"}');
  await Bun.write(join(root, 'digit.toml'), 'name = "friends"');
  const deployment = {
    directory,
    composeFile: join(directory, 'compose.yaml'),
    environment: 'dev',
    projectName: 'digit-friends-123456abcdef-dev',
    fingerprint: 'current-config',
    manifest: { name: 'friends' },
  } as Deployment;
  await Bun.write(join(envDir, 'deployment.json'), JSON.stringify(deployment));
  return { root, envDir, deployment };
}
function docker(project: string) {
  const label = (name: string) => ({ 'com.docker.compose.project': name });
  const container = (id: string, owner: string, volume: string) => ({
    Id: id,
    Created: '2026-10-08T01:00:00Z',
    Config: { Labels: label(owner) },
    Mounts: [{ Type: 'volume', Name: volume }],
  });
  const volume = (name: string, owner: string) => ({
    Name: name,
    CreatedAt: '2026-10-08T01:00:00Z',
    Driver: 'local',
    Mountpoint: `/docker/${name}`,
    Labels: label(owner),
  });
  const state = {
    containers: [
      container('own-container', project, 'own-data'),
      container('other-container', `${project}-other`, 'other-data'),
    ],
    volumes: [
      volume('own-data', project),
      volume('orphan-data', project),
      volume('other-data', `${project}-other`),
    ],
    networks: [
      {
        Id: 'own-network',
        Created: '2026-10-08',
        Labels: label(project),
        Containers: { 'own-container': {} },
      },
    ],
    daemon: 'daemon-A',
    fail: '',
    calls: [] as string[][],
  };
  const run: DockerRunner = async (args) => {
    state.calls.push(args);
    const op = args.slice(1, 3).join(' ');
    if (state.fail && op === state.fail) throw new Error('simulated failure');
    if (args[1] === 'info') return state.daemon;
    if (args[1] === 'ps') {
      const filter = args[args.indexOf('--filter') + 1]!;
      return state.containers
        .filter((c) =>
          filter.startsWith('volume=')
            ? c.Mounts.some((m) => m.Name === filter.slice(7))
            : c.Config.Labels['com.docker.compose.project'] ===
              filter.split('=').slice(2).join('='),
        )
        .map((c) => c.Id)
        .join('\n');
    }
    if (op === 'volume ls')
      return state.volumes
        .filter(
          (v) =>
            v.Labels['com.docker.compose.project'] === args.at(-1)!.split('=').slice(2).join('='),
        )
        .map((v) => v.Name)
        .join('\n');
    if (op === 'network ls')
      return state.networks
        .filter(
          (n) =>
            n.Labels['com.docker.compose.project'] === args.at(-1)!.split('=').slice(2).join('='),
        )
        .map((n) => n.Id)
        .join('\n');
    if (op === 'container inspect')
      return JSON.stringify(state.containers.filter((c) => args.slice(3).includes(c.Id)));
    if (op === 'volume inspect')
      return JSON.stringify(state.volumes.filter((v) => args.slice(3).includes(v.Name)));
    if (op === 'network inspect')
      return JSON.stringify(state.networks.filter((n) => args.slice(3).includes(n.Id)));
    if (op === 'container stop') return '';
    if (op === 'container rm') {
      state.containers = state.containers.filter((c) => !args.slice(3).includes(c.Id));
      state.networks.forEach((n) => (n.Containers = {} as any));
      return '';
    }
    if (op === 'volume rm') {
      state.volumes = state.volumes.filter((v) => !args.slice(3).includes(v.Name));
      return '';
    }
    if (op === 'network rm') {
      state.networks = state.networks.filter((n) => !args.slice(3).includes(n.Id));
      return '';
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };
  const destructive = () => state.calls.filter((c) => ['stop', 'rm'].includes(c[2]!));
  return { state, run, destructive, container };
}

test('first invocation warns without stopping; repeat deletes scoped resources including orphan volumes', async () => {
  const { root, envDir, deployment } = await fixture();
  const fake = docker(deployment.projectName);
  const messages: string[] = [];
  let now = 1000;
  const options = {
    run: fake.run,
    now: () => now,
    log: (message: string) => messages.push(message),
  };
  expect(await destroyEnvironment(deployment, options)).toBe('armed');
  expect(fake.destructive()).toEqual([]);
  expect(messages[0]).toContain('within 60 seconds');
  expect(messages[0]).toContain('2 volumes');
  now += 1000;
  expect(await destroyEnvironment(deployment, options)).toBe('destroyed');
  expect(fake.state.volumes.map((v) => v.Name)).toEqual(['other-data']);
  expect(fake.state.containers.map((v) => v.Id)).toEqual(['other-container']);
  expect(await Bun.file(join(envDir, 'deployment.json')).exists()).toBe(false);
  expect(await Bun.file(join(root, '.digit/identity')).text()).toBe('123456abcdef');
  expect(await Bun.file(join(root, '.digit/environments/staging/secrets.json')).exists()).toBe(
    true,
  );
  expect(await Bun.file(join(root, 'digit.toml')).exists()).toBe(true);
  expect(fake.state.calls.flat()).not.toContain('prune');
});

test('expired or backwards-clock confirmation re-arms with no destruction', async () => {
  const { deployment } = await fixture();
  const fake = docker(deployment.projectName);
  let now = 100000;
  const options = { run: fake.run, now: () => now, log: () => {} };
  await destroyEnvironment(deployment, options);
  now += 60001;
  expect(await destroyEnvironment(deployment, options)).toBe('armed');
  now -= 1;
  expect(await destroyEnvironment(deployment, options)).toBe('armed');
  expect(fake.destructive()).toEqual([]);
});

test.each(['resources', 'daemon', 'configuration'])(
  'confirmation is invalidated by changed %s',
  async (change) => {
    const { deployment } = await fixture();
    const fake = docker(deployment.projectName);
    const options = { run: fake.run, now: () => 1000, log: () => {} };
    await destroyEnvironment(deployment, options);
    if (change === 'resources') fake.state.volumes[0]!.CreatedAt = '2026-10-08T02:00:00Z';
    if (change === 'daemon') fake.state.daemon = 'daemon-B';
    if (change === 'configuration') deployment.fingerprint = 'new-config';
    expect(await destroyEnvironment(deployment, options)).toBe('armed');
    expect(fake.destructive()).toEqual([]);
  },
);

test('volume used by another environment blocks destruction before arming', async () => {
  const { deployment, envDir } = await fixture();
  const fake = docker(deployment.projectName);
  fake.state.containers.push(fake.container('foreign', 'another-project', 'own-data'));
  await expect(destroyEnvironment(deployment, { run: fake.run, log: () => {} })).rejects.toThrow(
    'outside this environment',
  );
  expect(fake.destructive()).toEqual([]);
  expect(await Bun.file(join(envDir, 'destroy-confirmation.json')).exists()).toBe(false);
});

test('failed destructive attempt consumes confirmation and retains local metadata', async () => {
  const { deployment, envDir } = await fixture();
  const fake = docker(deployment.projectName);
  const options = { run: fake.run, now: () => 1000, log: () => {} };
  await destroyEnvironment(deployment, options);
  fake.state.fail = 'volume rm';
  await expect(destroyEnvironment(deployment, options)).rejects.toThrow('did not finish');
  expect(await Bun.file(join(envDir, 'destroy-confirmation.json')).exists()).toBe(false);
  expect(await Bun.file(join(envDir, 'secrets.json')).exists()).toBe(true);
  fake.state.fail = '';
  fake.state.calls = [];
  expect(await destroyEnvironment(deployment, options)).toBe('armed');
  expect(fake.destructive()).toEqual([]);
});

test('identity mismatch cannot arm deletion for an unrelated Compose project', async () => {
  const { deployment } = await fixture();
  const fake = docker(deployment.projectName);
  deployment.projectName = 'digit-other-aaaaaabbbbbb-dev';
  await expect(destroyEnvironment(deployment, { run: fake.run })).rejects.toThrow('identity');
  expect(fake.state.calls).toEqual([]);
});

test('a foreign container attached to the environment network blocks deletion', async () => {
  const { deployment } = await fixture();
  const fake = docker(deployment.projectName);
  fake.state.networks[0]!.Containers['foreign-container' as 'own-container'] = {};
  await expect(destroyEnvironment(deployment, { run: fake.run, log: () => {} })).rejects.toThrow(
    'another container',
  );
  expect(fake.destructive()).toEqual([]);
});

test('foreign volume attachment after confirmation fails before deleting volumes', async () => {
  const { deployment, envDir } = await fixture();
  const fake = docker(deployment.projectName);
  const run: DockerRunner = async (args) => {
    const result = await fake.run(args);
    if (args[1] === 'container' && args[2] === 'rm')
      fake.state.containers.push(fake.container('new-foreign', 'unrelated', 'own-data'));
    return result;
  };
  const options = { run, now: () => 1000, log: () => {} };
  await destroyEnvironment(deployment, options);
  await expect(destroyEnvironment(deployment, options)).rejects.toThrow('outside this environment');
  expect(fake.state.volumes.map((v) => v.Name)).toContain('own-data');
  expect(fake.destructive().some((c) => c[1] === 'volume')).toBe(false);
  expect(await Bun.file(join(envDir, 'deployment.json')).exists()).toBe(true);
});
