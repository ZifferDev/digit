import * as p from '@clack/prompts';
import { command } from './runtime';
import type { Deployment } from './types';

interface RunningService {
  id: string;
  name: string;
  type: 'paper' | 'velocity';
}
interface ConsoleDependencies {
  run: typeof command;
  interactive: boolean;
  choose: (services: RunningService[]) => Promise<string | symbol>;
  log: (message: string) => void;
  cancel: () => void;
}

/** Attach directly to the existing server process; no RCON session or extra server is started. */
export async function attachConsole(
  d: Deployment,
  service?: string,
  overrides: Partial<ConsoleDependencies> = {},
): Promise<void> {
  const deps: ConsoleDependencies = {
    run: command,
    interactive: !!process.stdin.isTTY && !!process.stdout.isTTY,
    choose: (services) =>
      p.select({
        message: `Attach to a running service · ${d.manifest.name} / ${d.environment}`,
        options: services.map((s) => ({
          value: s.id,
          label: s.name,
          hint: s.type === 'paper' ? 'Paper' : 'Velocity',
        })),
      }),
    log: console.log,
    cancel: () => {
      p.cancel('Console cancelled.');
      process.exitCode = 130;
    },
    ...overrides,
  };
  if (!deps.interactive)
    throw new Error(
      'digit console needs an interactive terminal. Use digit logs to read output or digit cmd to send a single command.',
    );
  if (
    service &&
    (!Object.hasOwn(d.manifest.services, service) ||
      d.manifest.services[service]!.type === 'mariadb')
  )
    throw new Error(
      `'${service}' is not a Minecraft service in this environment. Choose a Paper or Velocity service.`,
    );

  const raw = await deps.run(
    [
      'docker',
      'ps',
      '--no-trunc',
      '--filter',
      `label=com.docker.compose.project=${d.projectName}`,
      '--filter',
      'status=running',
      '--format',
      '{"id":{{json .ID}},"name":{{json (.Label "com.docker.compose.service")}},"oneoff":{{json (.Label "com.docker.compose.oneoff")}}}',
    ],
    { capture: true },
  );
  const services: RunningService[] = [];
  for (const line of raw.trim().split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    const name = row.name;
    const target =
      name && Object.hasOwn(d.manifest.services, name) ? d.manifest.services[name] : undefined;
    if (
      target &&
      (target.type === 'paper' || target.type === 'velocity') &&
      typeof row.id === 'string' &&
      String(row.oneoff).toLowerCase() !== 'true'
    )
      services.push({ id: row.id, name, type: target.type });
  }
  services.sort((a, b) => a.name.localeCompare(b.name));
  if (!services.length)
    throw new Error(
      `No Paper or Velocity services are running in '${d.environment}'. Run digit up --env ${d.environment} first.`,
    );
  const matches = services.filter((s) => s.name === service);
  if (service && matches.length !== 1)
    throw new Error(
      matches.length
        ? `More than one running container matches '${service}'. Use digit console to choose one.`
        : `Service '${service}' is not running. Run digit up --env ${d.environment} first.`,
    );
  const chosen = service ? matches[0]!.id : await deps.choose(services);
  if (typeof chosen === 'symbol') {
    deps.cancel();
    return;
  }
  const selected = services.find((s) => s.id === chosen);
  if (!selected)
    throw new Error('The selected console is no longer available. Run digit console again.');

  const [container] = JSON.parse(
    await deps.run(['docker', 'container', 'inspect', selected.id], { capture: true }),
  );
  if (
    !container?.State?.Running ||
    container.State.Paused ||
    container.State.Restarting ||
    container.Config?.Labels?.['com.docker.compose.project'] !== d.projectName ||
    container.Config?.Labels?.['com.docker.compose.service'] !== selected.name
  )
    throw new Error('The selected service changed or stopped. Run digit console again.');
  if (!container.Config.Tty || !container.Config.OpenStdin)
    throw new Error(
      `'${selected.name}' was created without console input. Run digit up --env ${d.environment} once to recreate it with console support; existing data is retained.`,
    );

  // Historical TTY logs can contain terminal probes; do not replay those as live input requests.
  const history = await deps.run(['docker', 'logs', '--tail', '30', container.Id], {
    capture: true,
  });
  if (history.trim()) deps.log(Bun.stripANSI(history).trimEnd());
  deps.log(
    `\nAttaching to ${selected.name} (${d.environment}). Type Minecraft commands without a leading slash.\nTo detach and leave the server running: press Ctrl+P, then Ctrl+Q.\nDo not use Ctrl+C or the stop/end commands to detach; they can interrupt the server.\n`,
  );
  await deps.run(
    ['docker', 'attach', '--sig-proxy=false', '--detach-keys=ctrl-p,ctrl-q', container.Id],
    {
      // Some Docker CLI versions report their normal detach sequence as exit 1.
      acceptExit: (code, stderr) => code === 1 && stderr.trim() === 'read escape sequence',
    },
  );
  deps.log(`\nConsole session ended for ${selected.name}. Detaching does not stop the server.`);
}
