import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import * as p from '@clack/prompts';
import { destroyEnvironment } from './destroy';
import { exists, environmentDirectory, privateWrite, sourceFingerprint } from './deployment';
import type { Deployment, Project, Lockfile, EnvironmentOptions } from './types';

export async function command(
  args: string[],
  options: {
    env?: Record<string, string>;
    capture?: boolean;
    cwd?: string;
    acceptExit?: (code: number, stderr: string) => boolean;
  } = {},
) {
  let proc;
  try {
    proc = Bun.spawn(args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdin: 'inherit',
      stdout: options.capture ? 'pipe' : 'inherit',
      stderr: options.capture || options.acceptExit ? 'pipe' : 'inherit',
    });
  } catch {
    throw new Error(
      `Could not run ${args[0]}. Install Docker with the Compose plugin, then run digit doctor.`,
    );
  }
  const stdout = options.capture ? new Response(proc.stdout).text() : Promise.resolve('');
  const stderr =
    options.capture || options.acceptExit ? new Response(proc.stderr).text() : Promise.resolve('');
  const [code, out, err] = await Promise.all([proc.exited, stdout, stderr]);
  if (code !== 0 && !options.acceptExit?.(code, err))
    throw new Error(
      `${args.slice(0, 3).join(' ')} failed (exit ${code}).${err.trim() ? `\n${err.trim()}` : ''}`,
    );
  if (!options.capture && options.acceptExit && code === 0 && err.trim())
    console.error(err.trimEnd());
  return out;
}
function composeArgs(d: Deployment, args: string[]) {
  return ['docker', 'compose', '--project-name', d.projectName, '--file', d.composeFile, ...args];
}
async function compose(d: Deployment, args: string[], capture = false) {
  // Resolving Compose variables is needed even for read-only commands. Only up starts servers and is consent-gated.
  return command(composeArgs(d, args), { capture, env: { DIGIT_EULA: 'true' } });
}
export function consentPath() {
  return join(
    process.env.DIGIT_STATE_HOME ??
      process.env.XDG_STATE_HOME ??
      join(homedir(), '.local', 'state'),
    'digit',
    'eula.json',
  );
}
export async function ensureEula(accepted = false) {
  const path = consentPath();
  if (await exists(path)) {
    try {
      const record = JSON.parse(await readFile(path, 'utf8'));
      if (record.accepted === true && record.url === 'https://www.minecraft.net/eula') return;
    } catch {
      /* ask again if invalid */
    }
  }
  if (!accepted) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error(
        'Minecraft EULA acceptance is required. Read https://www.minecraft.net/eula and run digit up --accept-eula if you agree.',
      );
    const answer = await p.confirm({
      message: 'Do you accept the Minecraft EULA? https://www.minecraft.net/eula',
      initialValue: false,
    });
    if (p.isCancel(answer) || !answer)
      throw new Error('EULA not accepted. No servers were started.');
  }
  await privateWrite(
    path,
    JSON.stringify(
      {
        accepted: true,
        url: 'https://www.minecraft.net/eula',
        acceptedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
export async function up(d: Deployment, options: { acceptEula?: boolean; wait?: boolean } = {}) {
  await ensureEula(options.acceptEula);
  await compose(d, ['config', '--quiet'], true);
  console.log(`Starting ${d.manifest.name} / ${d.environment}…`);
  const args = ['up', '--detach', '--remove-orphans'];
  if (options.wait !== false) args.push('--wait', '--wait-timeout', '300');
  try {
    await compose(d, args);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : error}\nInspect digit status --env ${d.environment} and digit logs --env ${d.environment}. Data was retained; fix the issue and run digit up again.`,
    );
  }
  await privateWrite(
    join(dirname(dirname(d.directory)), 'applied.json'),
    JSON.stringify({
      fingerprint: d.fingerprint,
      services: Object.keys(d.manifest.services),
      images: Object.fromEntries(
        Object.entries(d.lock.services).map(([name, s]) => [name, s.image]),
      ),
      appliedAt: new Date().toISOString(),
    }),
  );
  if (options.wait !== false) console.log('All services are healthy.');
  await printAddress(d);
}
async function printAddress(d: Deployment) {
  try {
    const address = (await compose(d, ['port', d.entrypoint, '25565'], true)).trim();
    console.log(
      `Connect: ${address.replace(/^0\.0\.0\.0:/, 'localhost:').replace(/^\[::\]:/, 'localhost:')}`,
    );
    if (d.manifest.network.bind === '0.0.0.0' || d.manifest.network.bind === '::')
      console.log('Listening on all host interfaces. Remote players use this host’s address.');
  } catch {
    console.log(
      'Connection address will be available with digit status once the entrypoint starts.',
    );
  }
}
export async function down(d: Deployment, options: { destroyAllData?: boolean } = {}) {
  if (options.destroyAllData) {
    await destroyEnvironment(d, { run: (args) => command(args, { capture: true }) });
    return;
  }
  await compose(d, ['down', '--remove-orphans']);
  console.log(`Stopped ${d.environment}. Worlds, databases, and plugin data are retained.`);
}
export async function status(d: Deployment) {
  const raw = await compose(d, ['ps', '--all', '--format', 'json'], true);
  let rows: any[];
  try {
    const json = JSON.parse(raw || '[]');
    rows = Array.isArray(json) ? json : [json];
  } catch {
    rows = raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
  if (!rows.length) {
    console.log(`Environment '${d.environment}' is stopped. Run digit up --env ${d.environment}.`);
    return;
  }
  console.table(
    rows.map((row) => ({ service: row.Service, state: row.State, health: row.Health || '—' })),
  );
  await printAddress(d);
}
export async function logs(
  d: Deployment,
  options: { service?: string; follow?: boolean; tail?: number } = {},
) {
  if (options.service && !d.manifest.services[options.service])
    throw new Error(
      `Unknown service '${options.service}'. Available: ${Object.keys(d.manifest.services).join(', ')}`,
    );
  const args = ['logs', '--tail', String(options.tail ?? 100)];
  if (options.follow) args.push('--follow');
  if (options.service) args.push(options.service);
  await compose(d, args);
}
export async function plan(project: Project, lock: Lockfile, options: EnvironmentOptions = {}) {
  const env = options.env ?? 'dev';
  const path = join(await environmentDirectory(project.root, env), 'applied.json');
  const fingerprint = await sourceFingerprint(project, lock, options);
  const previous = (await exists(path)) ? JSON.parse(await readFile(path, 'utf8')) : undefined;
  console.log(`${project.manifest.name} / ${env}`);
  if (previous?.fingerprint === fingerprint) {
    console.log('No configuration or dependency changes. digit up starts any stopped containers.');
    return;
  }
  for (const [name, service] of Object.entries(project.manifest.services))
    console.log(
      `  ${previous?.services.includes(name) ? 'restart' : 'create '}  ${name} (${service.type} ${lock.services[name]?.version})`,
    );
  for (const name of previous?.services ?? [])
    if (!project.manifest.services[name]) console.log(`  remove   ${name} (data volume retained)`);
  console.log(
    `  entrypoint: ${project.manifest.network.bind}:${project.manifest.network.port || 'automatic port'}`,
  );
  if (previous)
    console.log(
      'This candidate restarts the deployment when its configuration changes. Persistent data is retained.',
    );
}
export async function doctor() {
  console.log(`digit · Bun ${Bun.version} · ${process.platform}/${process.arch}`);
  const checks = [
    { name: 'Docker engine', args: ['docker', 'version', '--format', '{{.Server.Version}}'] },
    { name: 'Docker Compose', args: ['docker', 'compose', 'version', '--short'] },
    {
      name: 'Docker resources',
      args: [
        'docker',
        'info',
        '--format',
        '{{.OSType}}/{{.Architecture}} · {{.NCPU}} CPUs · {{.MemTotal}} bytes RAM',
      ],
    },
  ];
  let failed = false;
  for (const check of checks)
    try {
      console.log(`✓ ${check.name}: ${(await command(check.args, { capture: true })).trim()}`);
    } catch (error) {
      failed = true;
      console.log(`✗ ${check.name}: ${error instanceof Error ? error.message : error}`);
    }
  console.log(
    `EULA consent: ${(await exists(consentPath())) ? 'local record exists' : 'will be requested on first start'}`,
  );
  if (failed)
    throw new Error(
      'Start Docker Desktop on macOS, or Docker Engine with the Compose plugin on Linux, then rerun digit doctor.',
    );
}

/** Execute a Minecraft console command through the image's local authenticated RCON client. */
export async function sendCommand(d: Deployment, service: string, text: string): Promise<void> {
  const target = Object.hasOwn(d.manifest.services, service)
    ? d.manifest.services[service]
    : undefined;
  if (!target)
    throw new Error(
      `Unknown service '${service}'. Available: ${Object.keys(d.manifest.services).join(', ')}`,
    );
  if (target.type === 'mariadb')
    throw new Error(`'${service}' is a database. digit cmd supports Paper and Velocity services.`);
  if (!text.trim() || /[\r\n\0]/.test(text))
    throw new Error('Provide one non-empty Minecraft command without newlines.');
  const commandText = text.trim().replace(/^\//, '');
  if (!commandText) throw new Error('Provide a Minecraft command after the slash.');
  try {
    const response = await compose(
      d,
      [
        'exec',
        '-T',
        service,
        'rcon-cli',
        '--host',
        '127.0.0.1',
        '--port',
        '25575',
        '--',
        commandText,
      ],
      true,
    );
    if (response.trim()) console.log(response.trimEnd());
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : error}\nMake sure '${service}' is running and ready. For an older deployment, run digit up --env ${d.environment} once to enable command access.`,
    );
  }
}
