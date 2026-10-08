# digit

**Declare a Minecraft setup. Start an isolated copy in minutes.**

digit turns a Git-friendly configuration into a running Paper server or static Velocity network. It connects the services, locks software and Modrinth plugin versions, prepares configuration, and starts everything through Docker Compose using the itzg Minecraft images.

**Current candidate: `0.1.0-rc.2`.** Runs on macOS ARM64 and Linux ARM64/AMD64. This release supports Paper 1.19 and newer, one optional Velocity proxy, always-on Paper endpoints, and optional MariaDB. It targets one Docker host.

```sh
digit init friends
cd friends
digit up
```

The guided setup asks about your servers, Minecraft version, memory, optional operators and plugins, database, and connection settings. Versions come from PaperMC's catalog, including experimental releases. Before starting Minecraft, digit asks for EULA acceptance and saves your answer locally, outside Git.

## Start here

- [Install digit](docs/installation.md) — requirements, source builds, planned release installer, and Homebrew.
- [Run your first server](docs/quickstart.md) — guided setup, connecting, and keeping your configuration in Git.
- [Read the documentation](docs/README.md) — configuration, plugins, environments, and everyday commands.

Release downloads and the Homebrew tap require the first release to be published. The installation guide distinguishes those distribution paths from building the current checkout.

## A project you can understand

A single server needs only this `digit.toml`:

```toml
schema = 1
name = "friends"

[services.survival]
type = "paper"
version = "1.21.11"
memory = "2G"
```

For a network, add Velocity and another Paper service. digit configures internal addresses, authentication and modern player forwarding. Only the proxy publishes a player connection port.

```toml
[services.proxy]
type = "velocity"
fallback = ["lobby"]

[services.lobby]
type = "paper"
version = "1.21.11"
```

Keep plugin configuration in `services/<name>/`, commit `digit.lock`, and create an independent test environment when you need one:

```sh
digit up --env plugin-test --profile staging
digit status --env plugin-test
```

Each environment has its own worlds, credentials, database contents, and Docker resources. Cloning a repository reproduces its declared setup with fresh runtime data.

## Everyday commands

| Command                     | Purpose                                                  |
| --------------------------- | -------------------------------------------------------- |
| `digit up`                  | Prepare and start the selected environment               |
| `digit down`                | Stop it while preserving data                            |
| `digit status`              | Show readiness and connection address                    |
| `digit logs -f`             | Follow server output                                     |
| `digit cmd survival list`   | Run one console command                                  |
| `digit console`             | Choose a running server and attach to its console        |
| `digit add [plugins...]`    | Add plugins with server selection and dependency consent |
| `digit remove [plugins...]` | Remove plugins and prune unused dependencies             |
| `digit plan`                | Preview configuration and dependency changes             |
| `digit outdated`            | Preview available server, image, and plugin updates      |
| `digit update`              | Save updates and show the old and new versions           |

**In the interactive console, detach with Ctrl+P, then Ctrl+Q.** Ctrl+C or a `stop` command can interrupt the server. See [operations](docs/operations.md) for the complete command reference and the explicitly confirmed data-destruction command.

`digit update` updates project dependencies. Updating the digit CLI itself uses the installer or Homebrew; see [installation](docs/installation.md#update-digit).

## Development

The implementation uses Bun, Commander, Clack, and `@bomb.sh/tab`. Compiled executables include Bun; users do not need Node or Bun to run a release binary.

```sh
bun install --frozen-lockfile
bun test
bun run check
bun run build
```

[Design](docs/design.md) describes the architecture. [Verification](docs/verification.md) and [live test evidence](docs/testing-live.md) distinguish automated checks from actual server testing. [Release setup](docs/release-setup.md) explains the maintainer credentials; [releasing](docs/releasing.md) covers signed builds and publication.

CloudNet, multi-node placement, autoscaling, custom plugin URLs, backups, world migration, and remote deployment are outside this release.
