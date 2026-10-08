#!/usr/bin/env bun
import { Command, CommanderError } from 'commander';
import tab from '@bomb.sh/tab/commander';
import * as p from '@clack/prompts';
import { resolve, join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { initProject, Cancelled } from './init.ts';
import { withProjectOperation } from './operations.ts';
import { loadProject } from './config.ts';
import { ensureLock } from './resolve.ts';
import { prepareDeployment, loadDeployment } from './deployment.ts';
import * as runtime from './runtime.ts';
import { attachConsole } from './console.ts';
import { changePackages } from './package-project';
import type { Project } from './types.ts';

import { VERSION } from './version';
function positiveInteger(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error('Expected a nonnegative integer.');
  return Number(value);
}
async function withProgress<T>(label: string, work: () => Promise<T>): Promise<T> {
  if (!process.stdout.isTTY) return work();
  const spin = p.spinner();
  spin.start(label);
  try {
    const result = await work();
    spin.stop(label.replace(/…$/, ' ✓'));
    return result;
  } catch (error) {
    spin.error('Could not complete this step');
    throw error;
  }
}
export function createProgram(): Command {
  const cli = new Command('digit')
    .description(
      'Declarative Minecraft servers, ready in minutes.\nPaper, Velocity and private databases, powered by Docker Compose.',
    )
    .version(VERSION)
    .option('-C, --project <directory>', 'project directory', '.')
    .option('-e, --env <name>', 'isolated environment name', 'dev')
    .option('--profile <name>', 'settings from environments/<name>.toml')
    .option('--debug', 'show error details')
    .showHelpAfterError('(See digit --help)')
    .showSuggestionAfterError()
    .exitOverride();
  cli.addHelpText(
    'after',
    '\nStart here:\n  digit init friends\n  cd friends\n  digit up\n\nTry an isolated copy:\n  digit up --env plugin-test --profile staging\n\nShell completion:\n  source <(digit complete zsh)    # bash works too\n  digit complete fish | source  # fish\n',
  );
  const context = () => {
    const opts = cli.opts();
    return {
      root: resolve(opts.project),
      env: opts.env as string,
      profile: opts.profile as string | undefined,
    };
  };
  const project = async () => {
    const ctx = context();
    return loadProject(ctx.root, { env: ctx.env, profile: ctx.profile });
  };
  const locked = async (value: Project, frozen?: boolean, update?: boolean) =>
    withProgress('Resolving locked software…', () => ensureLock(value, { frozen, update }));
  const existing = () => {
    const ctx = context();
    return loadDeployment(ctx.root, ctx.env);
  };
  const mutation = <T>(work: () => Promise<T>) => withProjectOperation(context().root, work);
  cli
    .command('init [directory]')
    .description('Create a project with a guided setup')
    .option('-y, --yes', 'use defaults without questions (does not accept the EULA)')
    .option('--name <name>', 'project name')
    .option('--minecraft <version>', 'Minecraft version from the Paper catalog')
    .option('--proxy', 'create a Velocity network')
    .option('--proxy-name <name>', 'name of the Velocity proxy')
    .option('--servers <names>', 'comma-separated Paper server names')
    .option('--memory <size>', 'memory per Paper server, for example 2G')
    .option('--plugins <ids>', 'comma-separated Modrinth project IDs or slugs')
    .option('--ops <names>', 'comma-separated operator usernames, applied to all Paper servers')
    .option('--database', 'include a private MariaDB database')
    .option('--bind <address>', 'IPv4 bind address (default: 127.0.0.1)')
    .option('--port <number>', 'public port; 0 selects an available port (default: 25565)')
    .addHelpText(
      'after',
      '\nExamples:\n  digit init friends\n  digit init friends --yes --proxy --servers lobby,survival --minecraft 1.21.11\n\nInitial plugins use the same server selection and required-dependency review as digit add.\nWith --yes, initial plugins and their required dependencies go to every Paper server.\nNo containers are started. When plugins are selected, init also writes digit.lock.\n',
    )
    .action(async (directory, options) => {
      const root = await initProject(
        directory ? resolve(context().root, directory) : context().root,
        options,
      );
      if (options.yes)
        console.log(
          `Created digit project at ${root}\nNext: digit --project ${JSON.stringify(root)} up`,
        );
    });
  for (const action of ['add', 'remove'] as const) {
    cli
      .command(`${action} [plugins...]`)
      .description(
        action === 'add'
          ? 'Add Modrinth plugins with guided server and dependency selection'
          : 'Remove plugins from selected servers and prune unused dependencies',
      )
      .option('--servers <names>', 'comma-separated target services')
      .option('--all', 'select every eligible service')
      .option(
        '-y, --yes',
        'skip questions and include all required dependencies; specify targets for a network',
      )
      .addHelpText(
        'after',
        action === 'add'
          ? '\nExamples:\n  digit add viabackwards\n  digit add viabackwards --servers lobby,survival --yes\n  digit add luckperms@<version> --servers proxy\n\nEdits digit.toml and digit.lock for the whole project. Run digit up to apply.\n'
          : '\nExamples:\n  digit remove\n  digit remove viabackwards --servers survival\n  digit remove viabackwards viaversion --all\n\nUse manifest aliases. Plugin data is preserved. Run digit up to apply.\n',
      )
      .action(async (plugins: string[], options) => {
        if (cli.opts().profile || cli.getOptionValueSource('env') !== 'default')
          throw new Error(
            'add/remove edit project-wide dependencies. Omit --env and --profile; use --servers to choose services.',
          );
        const changes = await changePackages(context().root, action, plugins, options);
        console.log(
          changes.length
            ? `${changes.join('\n')}\nSaved digit.toml and digit.lock. Review with git diff, then run digit up to apply.`
            : 'Plugin selection is already current.',
        );
      });
  }
  cli
    .command('up')
    .description('Prepare and start this environment; wait until ready')
    .option(
      '--accept-eula',
      'explicitly accept https://www.minecraft.net/eula and remember locally',
    )
    .option('--no-wait', 'return after containers have started')
    .option('--frozen-lockfile', 'require an existing matching lockfile')
    .action(async (options) =>
      mutation(async () => {
        const value = await project();
        const lock = await locked(value, options.frozenLockfile);
        const deployment = await withProgress('Preparing configuration…', () =>
          prepareDeployment(value, lock, context()),
        );
        await runtime.up(deployment, { acceptEula: options.acceptEula, wait: options.wait });
      }),
    );
  cli
    .command('down')
    .description('Stop this environment; keep all worlds and database data')
    .option(
      '--destroy-all-data',
      'permanently delete environment data (repeat within 60s to confirm)',
    )
    .action(async (options) =>
      mutation(async () =>
        runtime.down(await existing(), { destroyAllData: options.destroyAllData }),
      ),
    );
  cli
    .command('status')
    .description('Show service status and connection details')
    .action(async () => runtime.status(await existing()));
  cli
    .command('logs [service]')
    .description('Read logs from this environment')
    .option('-f, --follow', 'stream new log output')
    .option('--tail <lines>', 'number of lines per service', positiveInteger, 100)
    .action(async (service, options) => {
      const deployment = await existing();
      if (service && !Object.hasOwn(deployment.manifest.services, service))
        throw new Error(
          `Unknown service ${service}. Available: ${Object.keys(deployment.manifest.services).join(', ')}.`,
        );
      await runtime.logs(deployment, { service, follow: options.follow, tail: options.tail });
    });
  cli
    .command('cmd <service> <command...>')
    .description('Send a console command to a running Minecraft service')
    .allowUnknownOption()
    .addHelpText(
      'after',
      '\nExamples:\n  digit cmd survival list\n  digit cmd survival say Hello friends\n  digit cmd survival "say Hello friends"\n  digit cmd survival -- plugincommand --flag\n',
    )
    .action(async (service: string, command: string[]) => {
      await runtime.sendCommand(await existing(), service, command.join(' '));
    });
  cli
    .command('console [service]')
    .description('Pick a running Minecraft service and attach to its live console')
    .addHelpText(
      'after',
      '\nExamples:\n  digit console\n  digit console survival\n  digit console --env staging\n\nDetach without stopping the server: Ctrl+P, then Ctrl+Q.\nRequires an interactive terminal. Run digit up once to enable console input on older deployments.\n',
    )
    .action(async (service?: string) => attachConsole(await existing(), service));
  cli
    .command('plan')
    .description('Describe changes to this environment without starting containers')
    .option('--frozen-lockfile', 'require an existing matching lockfile')
    .action(async (options) =>
      mutation(async () => {
        const value = await project();
        await runtime.plan(value, await locked(value, options.frozenLockfile), context());
      }),
    );
  cli
    .command('update')
    .description('Refresh locked software and plugin versions without restarting')
    .action(async () =>
      mutation(async () => {
        await locked(await project(), false, true);
        console.log(
          'Updated digit.lock. Review it with git diff, then run digit plan and digit up.',
        );
      }),
    );
  cli
    .command('render')
    .description('Prepare an inspectable local Compose bundle')
    .option('--frozen-lockfile', 'require an existing matching lockfile')
    .action(async (options) =>
      mutation(async () => {
        const value = await project();
        const deployment = await prepareDeployment(
          value,
          await locked(value, options.frozenLockfile),
          context(),
        );
        console.log(
          `Prepared ${deployment.directory}\nCompose file: ${deployment.composeFile}\nThis local bundle can contain secrets. Keep it outside Git.\nRun digit up to start with EULA consent.`,
        );
      }),
    );
  cli
    .command('doctor')
    .description('Check Bun, Docker and Compose prerequisites')
    .action(async () => runtime.doctor());
  const completion = tab(cli);
  // Completion is deliberately local and synchronous: tab never fetches remote APIs.
  const completionRoot = () => {
    const args = process.argv;
    const index = args.findIndex((v) => v === '--project' || v === '-C');
    const inline = args.find((v) => v.startsWith('--project='));
    return resolve(
      inline?.slice('--project='.length) ?? (index >= 0 ? args[index + 1] : undefined) ?? '.',
    );
  };
  const names = (directory: string, extension?: string) => {
    try {
      return readdirSync(directory, { withFileTypes: true })
        .filter((e) => (extension ? e.isFile() && e.name.endsWith(extension) : e.isDirectory()))
        .map((e) => (extension ? e.name.slice(0, -extension.length) : e.name));
    } catch {
      return [];
    }
  };
  const envOption = completion.options.get('env');
  if (envOption)
    envOption.handler = (complete) => {
      for (const name of new Set([
        'dev',
        ...names(join(completionRoot(), '.digit', 'environments')),
      ]))
        complete(name, 'Isolated environment');
    };
  const profileOption = completion.options.get('profile');
  if (profileOption)
    profileOption.handler = (complete) => {
      for (const name of names(join(completionRoot(), 'environments'), '.toml'))
        complete(name, 'Environment settings');
    };
  for (const action of ['add', 'remove']) {
    const command = completion.commands.get(action);
    const plugins = command?.arguments.get('plugins');
    if (plugins)
      plugins.handler = (complete) => {
        try {
          const manifest = parse(readFileSync(join(completionRoot(), 'digit.toml'), 'utf8'));
          for (const alias of Object.keys(manifest.plugins ?? {}))
            complete(alias, 'Declared plugin');
        } catch {
          /* Local completion only. */
        }
      };
    const servers = command?.options.get('servers');
    if (servers)
      servers.handler = (complete) => {
        try {
          const manifest = parse(readFileSync(join(completionRoot(), 'digit.toml'), 'utf8'));
          for (const [name, service] of Object.entries(manifest.services ?? {}))
            if ((service as { type?: string }).type !== 'mariadb')
              complete(name, 'Minecraft service');
        } catch {
          /* Local completion only. */
        }
      };
  }
  for (const command of ['logs', 'cmd', 'console']) {
    const serviceArgument = completion.commands.get(command)?.arguments.get('service');
    if (serviceArgument)
      serviceArgument.handler = (complete) => {
        try {
          const root = completionRoot();
          if (!existsSync(join(root, 'digit.toml'))) return;
          const manifest = parse(readFileSync(join(root, 'digit.toml'), 'utf8'));
          if (manifest.services && typeof manifest.services === 'object')
            for (const [service, value] of Object.entries(manifest.services)) {
              if (
                command !== 'logs' &&
                (typeof value !== 'object' ||
                  value === null ||
                  !['paper', 'velocity'].includes(String((value as Record<string, unknown>).type)))
              )
                continue;
              complete(service, command === 'logs' ? 'Service logs' : 'Minecraft console');
            }
        } catch {
          /* An invalid manifest must not break shell completion. */
        }
      };
  }
  return cli;
}

export async function main(argv = process.argv): Promise<void> {
  const program = createProgram();
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode;
      return;
    }
    if (error instanceof Cancelled) {
      p.cancel(error.message);
      process.exitCode = 130;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`digit: ${message}`);
    if (program.opts().debug && error instanceof Error) console.error(error.stack);
    process.exitCode = 1;
  }
}
if (import.meta.main) await main();
