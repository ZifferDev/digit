# Operations and commands

[Documentation](README.md) · Related: [Troubleshooting](troubleshooting.md)

Run commands from a project directory, or pass `--project /path/to/project`. The default environment is `dev`; use `--env <name>` to select another one.

## Command reference

| Command                            | Behavior                                                             |
| ---------------------------------- | -------------------------------------------------------------------- |
| `digit init [directory]`           | Guided project creation; never starts containers                     |
| `digit up`                         | Resolve as needed, prepare configuration, start, and wait for health |
| `digit down`                       | Stop/remove containers and network; keep data volumes                |
| `digit status`                     | Show service state, health, and connection address                   |
| `digit logs [service]`             | Print recent logs from one or all services                           |
| `digit cmd <service> <command...>` | Send a single console command                                        |
| `digit console [service]`          | Pick a running Minecraft service or attach directly                  |
| `digit plan`                       | Describe changes without starting containers                         |
| `digit update`                     | Refresh project dependency locks; do not restart containers          |
| `digit render`                     | Prepare a local Compose bundle for inspection                        |
| `digit doctor`                     | Check Docker, Compose, resources, and consent status                 |
| `digit complete <shell>`           | Generate Bash, Zsh, or Fish completion                               |

Global options are `--project` (`-C`), `--env` (`-e`), `--profile`, and `--debug`. Use `digit <command> --help` for command-specific flags. Profiles change configuration during preparation, not the identity of an already running environment.

`down`, `status`, `logs`, `cmd`, and `console` use the selected environment's prepared deployment. They do not resolve new versions from the current manifest.

## Start and observe

```sh
digit plan
digit up
digit status
digit logs survival -f --tail 200
```

`up` waits for service health by default. `up --no-wait` returns once containers have been started; it is not a readiness guarantee. Stop log-following with Ctrl+C; the server continues running.

`up`, `plan`, and `render` accept `--frozen-lockfile`. Without it, `plan` can write a missing or outdated lockfile, but does not create deployment secrets or start containers. See [plugin and server updates](plugins.md#update-locked-dependencies).

Mutating project operations are serialized locally. If another operation is running, digit reports the lock instead of racing configuration or credential updates.

## One console command

```sh
digit cmd survival list
digit cmd survival say Hello friends
digit cmd survival "time set day"
digit cmd proxy velocity info
digit cmd survival -- plugincommand --flag
```

Split arguments are joined with spaces; quoting the whole command also works. Use `--` before command arguments that look like digit options. Commands must be a single nonempty line. A leading Minecraft slash is optional.

Commands run with console privileges through the image's authenticated local RCON client, without shell evaluation. Paper and Velocity are supported; databases are not. RCON credentials are generated separately per service and environment, and no RCON port is published on the host.

## Interactive console

```sh
digit console
digit console survival
digit console --env staging
```

Without a service name, choose from running Paper and Velocity services in the selected environment. Stopped services and databases are excluded. The command requires an interactive terminal and never starts or recreates containers.

The console shows recent output and attaches to the container's Minecraft console. Type Minecraft commands without a leading slash. It is not an operating-system shell.

**To detach without stopping the server, press Ctrl+P, then Ctrl+Q, one after the other.** Do not use Ctrl+C or `stop`/`end` to leave the console; these can interrupt the server. For read-only output, use `digit logs` instead.

Older deployments may need one `digit up` to recreate their containers with console input and RCON support enabled. Data volumes are retained.

## EULA consent

Interactive `up` asks for consent if none is recorded. For unattended operation, pass `--accept-eula` only when you accept [Minecraft's EULA](https://www.minecraft.net/eula). `init --yes` never accepts it.

Consent is stored at the first applicable location:

1. `$DIGIT_STATE_HOME/digit/eula.json`
2. `$XDG_STATE_HOME/digit/eula.json`
3. `~/.local/state/digit/eula.json`

The record stays outside Git. Cloning another person's project does not count as your acceptance.

## Permanently destroy one environment

Ordinary `down` retains all worlds and databases. The explicit destructive form requires two identical invocations within 60 seconds:

```sh
digit down --env plugin-test --destroy-all-data
# Read the warning and resource counts. Nothing has stopped or been deleted yet.
digit down --env plugin-test --destroy-all-data
```

**The second invocation permanently deletes this environment's worlds, player data, plugin data, database contents, containers, volumes, network, and local environment directory.** Retained volumes from services removed earlier are included. There is no undo or built-in backup.

Other environments, source files, project identity, and EULA consent remain. Confirmation is tied to the checkout, selected environment, Docker daemon, and resource snapshot. Expiration or changed resources requires a new warning and confirmation. Shared resources are refused. If deletion fails, local metadata remains for inspection and another destructive attempt requires a fresh two-call confirmation.

## Compose bundles

`digit render` prints a local bundle path containing Compose configuration, snapshots, plugins, and credentials. Keep it outside Git and do not publish it. It uses local mounts and is not a portable deployment archive.

After explicit EULA acceptance, a prepared bundle can be started with Compose directly:

```sh
DIGIT_EULA=true docker compose -f /printed/path/compose.yaml up -d --wait
```

Direct Compose operations bypass digit's applied-state record. A later `digit plan` may conservatively report changes. Prefer `digit up` for everyday use.
