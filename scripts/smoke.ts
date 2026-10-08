/** Real Docker smoke test. Starts only isolated test projects and cleans their own volumes.
 * Run: bun scripts/smoke.ts --accept-eula
 * This acceptance flag is intentionally required independently of normal digit consent.
 */
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { parse as yaml } from 'yaml';
import { parse as toml, stringify as stringifyToml } from 'smol-toml';
import type { Deployment } from '../src/types';

if (!process.argv.includes('--accept-eula'))
  throw new Error('Read https://www.minecraft.net/eula; pass --accept-eula only if you agree.');
const experimentalOnly = process.argv.includes('--experimental-only');
const root = await mkdtemp(join(tmpdir(), 'digit-live-'));
const cli = resolve(import.meta.dir, '../src/cli.ts');
const state = join(root, 'state');
const log = join(root, 'commands.log');
const evidence: string[] = [];
const deployments: Deployment[] = [];
const started = new Date().toISOString();
console.log(`Live test workspace: ${root}`);
async function run(args: string[], cwd?: string): Promise<string> {
  console.log(`> ${args.slice(0, 6).join(' ')}${args.length > 6 ? ' …' : ''}`);
  const proc = Bun.spawn(args, {
    cwd,
    env: { ...process.env, DIGIT_STATE_HOME: state, DIGIT_EULA: 'true' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  await Bun.write(
    log,
    ((await Bun.file(log).exists()) ? await Bun.file(log).text() : '') +
      `\n$ ${args.join(' ')}\n${out}\n${err}\nexit=${code}\n`,
  );
  if (code)
    throw new Error(
      `Command failed (${code}): ${args.join(' ')}\n${err.slice(-5000)}\n${out.slice(-2000)}`,
    );
  return out;
}
const digit = (project: string, ...args: string[]) =>
  run([process.execPath, cli, '-C', project, ...args]);
async function deployment(project: string, env = 'dev') {
  const d = (await Bun.file(
    join(project, '.digit', 'environments', env, 'deployment.json'),
  ).json()) as Deployment;
  if (!deployments.some((x) => x.projectName === d.projectName)) deployments.push(d);
  return d;
}
const compose = (d: Deployment, ...args: string[]) =>
  run(['docker', 'compose', '-p', d.projectName, '-f', d.composeFile, ...args]);
async function cid(d: Deployment, service: string) {
  return (await compose(d, 'ps', '-q', service)).trim();
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  evidence.push(message);
  console.log(`✓ ${message}`);
}
function vi(value: number): Buffer {
  const bytes = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return Buffer.from(bytes);
}
function packet(payload: Buffer) {
  return Buffer.concat([vi(payload.length), payload]);
}
function readVi(data: Buffer, at = 0): [number, number] | undefined {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = data[at + i];
    if (byte === undefined) return;
    value |= (byte & 127) << (i * 7);
    if (!(byte & 128)) return [value, at + i + 1];
  }
  throw new Error('Invalid VarInt from Minecraft status server');
}
async function ping(d: Deployment): Promise<any> {
  const address = (await compose(d, 'port', d.entrypoint, '25565')).trim();
  const port = Number(address.split(':').at(-1));
  return new Promise((res, rej) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let buffered = Buffer.alloc(0);
    socket.setTimeout(15_000, () => socket.destroy(new Error('Minecraft status timed out')));
    socket.on('error', rej);
    socket.on('connect', () => {
      const host = Buffer.from('localhost');
      const portBytes = Buffer.alloc(2);
      portBytes.writeUInt16BE(port);
      socket.write(
        Buffer.concat([
          packet(Buffer.concat([vi(0), vi(774), vi(host.length), host, portBytes, vi(1)])),
          packet(vi(0)),
        ]),
      );
    });
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      const length = readVi(buffered);
      if (!length || buffered.length < length[1] + length[0]) return;
      try {
        const id = readVi(buffered, length[1])!;
        const size = readVi(buffered, id[1])!;
        res(JSON.parse(buffered.subarray(size[1], size[1] + size[0]).toString()));
        socket.end();
      } catch (error) {
        socket.destroy();
        rej(error);
      }
    });
  });
}
async function file(id: string, path: string) {
  return run(['docker', 'exec', id, 'cat', path]);
}
let failure: unknown;
try {
  evidence.push(
    `Host: ${(await run(['docker', 'info', '--format', '{{.OSType}}/{{.Architecture}}; {{.MemTotal}} bytes; {{.NCPU}} CPUs'])).trim()}`,
  );
  if (!experimentalOnly) {
    const single = join(root, 'single');
    await digit(
      root,
      'init',
      single,
      '--yes',
      '--name',
      'smoke-single',
      '--minecraft',
      '1.21.11',
      '--memory',
      '1G',
      '--port',
      '0',
    );
    await digit(single, 'up', '--accept-eula');
    const sd = await deployment(single);
    check(
      (await ping(sd)).version.name.includes('1.21.11'),
      'Standalone Paper responds to a real Minecraft status handshake',
    );
    const singleId = await cid(sd, sd.entrypoint);
    check(
      (await file(singleId, '/data/server.properties')).includes('online-mode=true'),
      'Standalone Paper has online authentication enabled in its effective configuration',
    );
    await run([
      'docker',
      'exec',
      singleId,
      'sh',
      '-c',
      'printf persistent > /data/digit-smoke-sentinel',
    ]);
    await digit(single, 'down');
    await digit(single, 'up', '--frozen-lockfile');
    check(
      (await file(await cid(sd, sd.entrypoint), '/data/digit-smoke-sentinel')).trim() ===
        'persistent',
      'Standalone data survives digit down followed by digit up',
    );
    await digit(single, 'down');

    const network = join(root, 'network');
    await digit(
      root,
      'init',
      network,
      '--yes',
      '--name',
      'smoke-network',
      '--proxy',
      '--servers',
      'lobby,survival',
      '--minecraft',
      '1.21.11',
      '--memory',
      '1G',
      '--plugins',
      'viaversion',
      '--ops',
      'm07z',
      '--database',
      '--port',
      '0',
    );
    const networkManifest = toml(await Bun.file(join(network, 'digit.toml')).text()) as any;
    networkManifest.plugins.compatibility = networkManifest.plugins.viaversion;
    delete networkManifest.plugins.viaversion;
    for (const name of ['lobby', 'survival']) {
      networkManifest.services[name].plugins = ['compatibility'];
      Object.assign(networkManifest.services[name].env, { DIFFICULTY: 'hard', MAX_PLAYERS: 12 });
      networkManifest.services[name].properties = { 'max-players': 7 };
    }
    await Bun.write(join(network, 'digit.toml'), stringifyToml(networkManifest));
    await mkdir(join(network, 'services', 'survival', 'plugins', 'Smoke'), { recursive: true });
    await Bun.write(
      join(network, 'services', 'survival', 'plugins', 'Smoke', 'config.yml'),
      'database_url: "${database.url}"\nenvironment: "${environment.name}"\nmarker: first\n',
    );
    await digit(network, 'up');
    let nd = await deployment(network);
    check(
      !!(await ping(nd)).version,
      'Velocity network responds to a real Minecraft status handshake',
    );
    const rows = (await compose(nd, 'ps', '--format', 'json'))
      .trim()
      .split('\n')
      .map((v) => JSON.parse(v));
    check(
      rows.length === 4 && rows.every((r) => r.Health === 'healthy'),
      'Velocity, both Paper endpoints, and MariaDB are healthy',
    );
    let lobbyId = await cid(nd, 'lobby');
    let survivalId = await cid(nd, 'survival');
    const proxyId = await cid(nd, 'proxy');
    check(
      (await digit(network, 'cmd', 'proxy', 'velocity info')).includes('Velocity'),
      'digit cmd returns a real Velocity console response',
    );
    for (const [name, id] of [
      ['lobby', lobbyId],
      ['survival', survivalId],
    ] as const) {
      check(
        (await digit(network, 'cmd', name, 'list')).includes('max of 7'),
        `digit cmd reaches ${name}; explicit properties override generic image options`,
      );
      const effective = await file(id, '/data/server.properties');
      check(
        effective.includes('difficulty=hard'),
        `${name} applies custom itzg environment options`,
      );
      check(
        JSON.parse(await file(id, '/data/ops.json')).some(
          (p: any) => p.name === 'm07z' && p.level === 4,
        ),
        `${name} grants the initializer's selected player operator status`,
      );
      const jars = await run(['docker', 'exec', id, 'sh', '-c', 'ls /data/plugins/digit-*.jar']);
      check(
        jars.includes('digit-compatibility-'),
        `${name} plugin JAR contains its manifest alias`,
      );
      const labels = JSON.parse(
        await run(['docker', 'inspect', '--format', '{{json .Config.Labels}}', id]),
      );
      check(
        labels['digit.service'] === name &&
          !Object.keys(labels).some((k) => k.startsWith('sh.digit.')),
        `${name} uses digit labels without an implied domain`,
      );
    }
    const velocity = toml(await file(proxyId, '/server/velocity.toml')) as any;
    const paper = yaml(await file(survivalId, '/data/config/paper-global.yml')) as any;
    const secret = (await file(proxyId, '/server/forwarding.secret')).trim();
    check(
      velocity['player-info-forwarding-mode'] === 'modern' &&
        paper.proxies.velocity.enabled &&
        paper.proxies.velocity.secret === secret,
      'Velocity and Paper use modern forwarding with identical environment secret',
    );
    check(
      (await file(survivalId, '/data/server.properties')).includes('online-mode=false'),
      'Backend Paper is configured to delegate authentication to the proxy',
    );
    check(
      velocity.servers.lobby === 'lobby:25565' && velocity.servers.survival === 'survival:25565',
      'Velocity registry contains both internal Paper destinations',
    );
    const renderedConfig = yaml(await file(survivalId, '/data/plugins/Smoke/config.yml'));
    check(
      renderedConfig.database_url.startsWith('mysql://minecraft:') &&
        renderedConfig.database_url.endsWith('@database:3306/minecraft'),
      'Configuration interpolation supplies private database connection credentials',
    );
    const databaseId = await cid(nd, 'database');
    check(
      (
        await run([
          'docker',
          'exec',
          databaseId,
          'sh',
          '-c',
          'mariadb -uminecraft -p"$MARIADB_PASSWORD" minecraft -N -e "SELECT 1"',
        ])
      ).trim() === '1',
      'Generated non-root database credentials authenticate and query MariaDB',
    );
    check(
      !(await run(['docker', 'port', survivalId])).trim() &&
        !(await run(['docker', 'port', databaseId])).trim(),
      'Paper backends and MariaDB publish no host ports',
    );
    const logText = await compose(nd, 'logs', '--no-color', 'survival');
    check(
      logText.includes('ViaVersion'),
      'Locked ViaVersion plugin appears in actual Paper startup logs',
    );
    await run([
      'docker',
      'exec',
      survivalId,
      'sh',
      '-c',
      'mkdir -p /data/plugins/Smoke; printf preserved > /data/plugins/Smoke/runtime-data',
    ]);
    const originalId = survivalId;
    await Bun.write(
      join(network, 'services', 'survival', 'plugins', 'Smoke', 'config.yml'),
      'database_url: "${database.url}"\nenvironment: "${environment.name}"\nmarker: second\n',
    );
    await digit(network, 'up', '--frozen-lockfile');
    nd = await deployment(network);
    survivalId = await cid(nd, 'survival');
    check(
      survivalId !== originalId &&
        yaml(await file(survivalId, '/data/plugins/Smoke/config.yml')).marker === 'second',
      'Config-only edit recreates the service and applies the new configuration',
    );
    const manifestPath = join(network, 'digit.toml');
    await Bun.write(
      manifestPath,
      (await Bun.file(manifestPath).text()).replace(
        /plugins\s*=\s*\[\s*"compatibility"\s*\]/g,
        'plugins = []',
      ),
    );
    await digit(network, 'up');
    nd = await deployment(network);
    survivalId = await cid(nd, 'survival');
    check(
      (
        await run([
          'docker',
          'exec',
          survivalId,
          'sh',
          '-c',
          'find /data/plugins -maxdepth 1 -name "digit-*.jar"',
        ])
      ).trim() === '',
      'Removing a declared plugin removes its managed JAR',
    );
    check(
      (await file(survivalId, '/data/plugins/Smoke/runtime-data')).trim() === 'preserved',
      'Removing a managed plugin preserves unrelated plugin runtime data',
    );
    await digit(network, '--env', 'staging', 'up', '--frozen-lockfile');
    const stage = await deployment(network, 'staging');
    check(
      !!(await ping(stage)).version,
      'A second staging network runs concurrently and responds to status',
    );
    check(
      stage.projectName !== nd.projectName,
      'Staging receives a distinct Compose project identity',
    );
    const stageSecret = (await file(await cid(stage, 'proxy'), '/server/forwarding.secret')).trim();
    check(stageSecret !== secret, 'Staging receives a distinct forwarding secret');
    const volumes = async (d: Deployment) =>
      JSON.parse(await run(['docker', 'inspect', await cid(d, 'survival')]))[0]
        .Mounts.filter((m: any) => m.Type === 'volume')
        .map((m: any) => m.Name);
    check(
      (await volumes(nd))[0] !== (await volumes(stage))[0],
      'Staging and development use different persistent data volumes',
    );
    const stagingState = yaml(
      await file(await cid(stage, 'survival'), '/data/plugins/Smoke/config.yml'),
    );
    check(
      stagingState.environment === 'staging' &&
        stagingState.database_url !== renderedConfig.database_url,
      'Staging configuration references isolated environment and database credentials',
    );
    await digit(network, '--env', 'staging', 'down');
    await digit(network, 'down');
  }
  const experimental = join(root, 'experimental');
  await digit(
    root,
    'init',
    experimental,
    '--yes',
    '--name',
    'smoke-experimental',
    '--minecraft',
    '26.3',
    '--memory',
    '1G',
    '--port',
    '0',
  );
  await digit(experimental, 'up', '--accept-eula');
  const ed = await deployment(experimental);
  check(
    (await ping(ed)).version.name.includes('26.3'),
    'Explicit experimental Paper 26.3 starts and responds to Minecraft status',
  );
  check(
    ed.lock.services[ed.entrypoint]!.channel !== 'STABLE' &&
      ed.lock.services[ed.entrypoint]!.java === 25,
    'Experimental selection locks its prerelease channel and Java 25 image',
  );
  const javaVersion = await run([
    'docker',
    'exec',
    await cid(ed, ed.entrypoint),
    'sh',
    '-c',
    'java -version 2>&1',
  ]);
  check(javaVersion.includes('25.'), 'Experimental server container actually runs Java 25');
  check(
    (await digit(experimental, 'cmd', ed.entrypoint, 'list')).includes('players online'),
    'digit cmd executes against standalone experimental Paper through authenticated RCON',
  );
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  // Discover prepared deployments even when startup fails before the normal bookkeeping point.
  for (const project of ['single', 'network', 'experimental'])
    for (const env of ['dev', 'staging']) {
      try {
        await deployment(join(root, project), env);
      } catch {
        /* not created */
      }
    }
  for (const d of deployments)
    try {
      // Use the current release for each project because tests may have replaced configuration.
      const project = d.directory.split('/.digit/')[0]!;
      const current = (await Bun.file(
        join(project, '.digit', 'environments', d.environment, 'deployment.json'),
      ).json()) as Deployment;
      await compose(current, 'logs', '--no-color');
      const warning = await digit(
        project,
        '--env',
        current.environment,
        'down',
        '--destroy-all-data',
      );
      check(
        warning.includes('Nothing has been stopped or deleted'),
        'First destructive invocation only warns',
      );
      const destroyed = await digit(
        project,
        '--env',
        current.environment,
        'down',
        '--destroy-all-data',
      );
      check(
        destroyed.includes(`Destroyed ${current.environment}`),
        'Second invocation removes test environment data',
      );
    } catch (error) {
      console.error(`Cleanup failed: ${error}`);
      failure ??= error;
    }
  const report = `# Live integration evidence\n\nStarted: ${started}\nFinished: ${new Date().toISOString()}\n\n${evidence.map((item) => `- PASS: ${item}`).join('\n')}\n\n${failure ? `FAILED: ${failure instanceof Error ? failure.message : failure}\n` : 'All live smoke checks passed. Test-owned containers and volumes were removed.\n'}\nLimitations: No authenticated player login or in-game travel was tested. This run used the host architecture listed above; cross-architecture image availability was validated by the resolver.\n\nRaw command log (local, may include generated test secrets): ${log}\n`;
  const reportPath = resolve(import.meta.dir, '../docs/testing-live.md');
  const previousReport =
    experimentalOnly && (await Bun.file(reportPath).exists())
      ? (await Bun.file(reportPath).text()) + '\n---\n\n'
      : '';
  await Bun.write(reportPath, previousReport + report);
  console.log(`Evidence: docs/testing-live.md; raw logs: ${log}`);
}
if (failure) process.exitCode = 1;
