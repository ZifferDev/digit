import { expect, test } from 'bun:test';
import { attachConsole } from '../src/console';
import type { Deployment } from '../src/types';

const deployment = {
  projectName: 'digit-test-123456789abc-staging',
  environment: 'staging',
  manifest: {
    name: 'test',
    services: {
      lobby: { type: 'paper' },
      proxy: { type: 'velocity' },
      database: { type: 'mariadb' },
      stopped: { type: 'paper' },
    },
  },
} as unknown as Deployment;
function fixture() {
  const calls: string[][] = [];
  const messages: string[] = [];
  let picked: any[] = [];
  let cancelled = false;
  const rows = [
    { id: 'lobby-id', name: 'lobby' },
    { id: 'proxy-id', name: 'proxy' },
    { id: 'database-id', name: 'database' },
    { id: 'orphan-id', name: 'orphan' },
    { id: 'oneoff-id', name: 'lobby', oneoff: 'True' },
  ];
  const container = {
    Id: 'full-lobby-id',
    State: { Running: true, Paused: false, Restarting: false },
    Config: {
      Tty: true,
      OpenStdin: true,
      Labels: {
        'com.docker.compose.project': deployment.projectName,
        'com.docker.compose.service': 'lobby',
      },
    },
  };
  const deps = {
    interactive: true,
    run: async (args: string[]) => {
      calls.push(args);
      if (args[1] === 'ps') return rows.map((row) => JSON.stringify(row)).join('\n');
      if (args[1] === 'container') return JSON.stringify([container]);
      return '';
    },
    choose: async (services: any[]): Promise<string | symbol> => {
      picked = services;
      return 'lobby-id';
    },
    log: (s: string) => {
      messages.push(s);
    },
    cancel: () => {
      cancelled = true;
    },
  };
  return {
    calls,
    messages,
    rows,
    container,
    deps,
    get picked() {
      return picked;
    },
    get cancelled() {
      return cancelled;
    },
  };
}
test('console picker scopes running Minecraft services, shows detach help and attaches inspected ID', async () => {
  const f = fixture();
  await attachConsole(deployment, undefined, f.deps);
  expect(f.calls[0]).toContain(`label=com.docker.compose.project=${deployment.projectName}`);
  expect(f.calls[0]).toContain('status=running');
  expect(f.picked.map((s) => s.name)).toEqual(['lobby', 'proxy']);
  expect(f.calls.slice(-2)).toEqual([
    ['docker', 'logs', '--tail', '30', 'full-lobby-id'],
    ['docker', 'attach', '--sig-proxy=false', '--detach-keys=ctrl-p,ctrl-q', 'full-lobby-id'],
  ]);
  expect(f.messages.join('\n')).toContain('Ctrl+P, then Ctrl+Q');
  expect(f.messages.join('\n')).toContain('Do not use Ctrl+C');
});
test('explicit service skips picker', async () => {
  const f = fixture();
  await attachConsole(deployment, 'lobby', f.deps);
  expect(f.picked).toEqual([]);
  expect(f.calls.at(-1)?.[1]).toBe('attach');
});
test('cancellation never attaches', async () => {
  const f = fixture();
  f.deps.choose = async () => Symbol('cancel');
  await attachConsole(deployment, undefined, f.deps);
  expect(f.cancelled).toBe(true);
  expect(f.calls).toHaveLength(1);
});
test('requires a terminal before calling Docker', async () => {
  const f = fixture();
  await expect(
    attachConsole(deployment, undefined, { ...f.deps, interactive: false }),
  ).rejects.toThrow('interactive terminal');
  expect(f.calls).toEqual([]);
});
test.each(['missing', 'database', 'constructor'])(
  'rejects non-Minecraft service %s',
  async (service) => {
    const f = fixture();
    await expect(attachConsole(deployment, service, f.deps)).rejects.toThrow(
      'not a Minecraft service',
    );
    expect(f.calls).toEqual([]);
  },
);
test('no running servers and explicit stopped service explain how to start', async () => {
  const f = fixture();
  await expect(attachConsole(deployment, 'stopped', f.deps)).rejects.toThrow('not running');
  f.rows.length = 0;
  await expect(attachConsole(deployment, undefined, f.deps)).rejects.toThrow(
    'digit up --env staging',
  );
});
test.each(['Tty', 'OpenStdin'] as const)(
  'older container without %s requests reapply, never attaches',
  async (key) => {
    const f = fixture();
    f.container.Config[key] = false;
    await expect(attachConsole(deployment, 'lobby', f.deps)).rejects.toThrow(
      'recreate it with console support',
    );
    expect(f.calls.some((a) => a[1] === 'attach')).toBe(false);
  },
);
test.each(['stopped', 'paused', 'restarting', 'foreign', 'relabelled'])(
  'refuses %s container after selection',
  async (change) => {
    const f = fixture();
    if (change === 'stopped') f.container.State.Running = false;
    if (change === 'paused') f.container.State.Paused = true;
    if (change === 'restarting') f.container.State.Restarting = true;
    if (change === 'foreign')
      f.container.Config.Labels['com.docker.compose.project'] = 'another-project';
    if (change === 'relabelled') f.container.Config.Labels['com.docker.compose.service'] = 'proxy';
    await expect(attachConsole(deployment, 'lobby', f.deps)).rejects.toThrow('changed or stopped');
    expect(f.calls.some((a) => a[1] === 'attach')).toBe(false);
  },
);
