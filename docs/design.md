# digit release candidate design

## Product boundary

digit is a CLI and deployment compiler. The everyday operation is `digit up`; Docker Compose owns process supervision after the command exits. There is no digit daemon or custom server container image. Minecraft containers use itzg images, and the optional database uses the official MariaDB image.

The project is a Git repository containing intent and configuration. The running environment is local state containing identity, credentials, containers, and data volumes. Copying the repository starts a fresh environment rather than copying a world.

## Processing pipeline

1. `config.ts` parses TOML, applies a selected environment profile, and validates names, topology, fields, and managed-setting boundaries.
2. `resolve.ts` converts version selectors into a checked JSON lockfile. It consults PaperMC Fill v3, Modrinth v2, and the Docker registry. It checks that pinned image indexes contain Linux ARM64 and AMD64 manifests.
3. `deployment.ts` fingerprints the effective manifest, lock, and configuration files. It creates environment credentials once and prepares an immutable local release directory containing Compose and configuration snapshots.
4. `runtime.ts` prompts for local EULA acceptance, validates Compose, applies the deployment, waits for service health, and records the applied fingerprint.
5. `cli.ts` provides Commander commands, Clack interaction, and Bash/Zsh/Fish completion through `@bomb.sh/tab`.

The code runs on Bun. Bun's built-in file, process, hashing, and executable compiler APIs are used alongside compatible standard-library modules. Node is not a runtime requirement.

## Locking and updates

Dependency identity consists of service type/version/build/channel and its declared plugins. Memory, network bindings, properties, and ordinary configuration edits do not invalidate dependency locks. Per-service hashes allow unchanged services to keep their selections when another service changes. An explicit `update` resolves every service anew.

The lock records server download metadata, Java requirements, exact builds, container image index digests, and checked plugin artifacts. Plugin dependencies are resolved recursively; required incompatible versions fail. Optional dependencies are not automatically installed. Minecraft and plugin catalogs remain separate compatibility constraints: an available experimental Minecraft build does not imply compatible plugins exist.

For Velocity, `ENABLE_RCON=true` lets the pinned itzg proxy image's built-in helper download Velocircon from its upstream GitHub release. The helper controls that version (currently 1.0.7 in the selected image); this auxiliary artifact is not separately resolved or checksum-locked by digit. This is a reproducibility limitation of proxy command access. Managed plugin filenames include the configured alias (or dependency project ID) plus a hash so installed plugins remain recognizable without sacrificing artifact identity.

Server startup is delegated to itzg with exact versions/builds. Plugin downloads are materialized and checksum-verified by digit, then supplied through itzg's copy machinery. Missing upstream content fails instead of silently upgrading.

## Environment identity

A checkout receives a random identity in `.digit/identity`. The Compose project name combines project name, checkout identity, and environment name. Docker's project scoping isolates networks and volumes. The local environment record stores secrets and its most recently prepared bundle; a separate applied record identifies the last successful `up`.

The default environment is `dev`. Other environments default to loopback binding and an ephemeral published port. A profile can override that policy explicitly. Profiles cannot add services or alter dependency choices. A branch or second checkout changes configuration, while `--env` chooses runtime data; these concepts are intentionally independent.

Only the ingress service publishes Minecraft's port. Without a proxy this is the single Paper server; with a proxy it is Velocity. Compose's internal network connects backends and databases by service name. Forwarding secrets and database credentials differ across environments. Every Minecraft service also receives its own persistent RCON password. Container labels `digit.environment`, `digit.service`, and `digit.config` expose the environment, service, and configuration fingerprint for diagnostics.

## File ownership and application

Files under `services/<name>` are complete-file overrides. A selected profile's `environments/<profile>/services/<name>` replaces matching paths. Generated wiring then patches digit-owned fields. Text reference interpolation occurs exactly once, with an explicit literal escape. Source files are never rewritten.

A release is keyed by the effective fingerprint and environment secrets. Docker mounts that snapshot rather than the mutable checkout. Editing a source file or switching a branch has no effect until another apply.

Each Minecraft service receives an inventory of managed paths. A bootstrap script compares this inventory to the previous runtime inventory and removes only previously managed paths that are absent now. This prevents removed plugins from lingering while retaining plugin directories and runtime data. The script checks destination symlinks before deletion/copy. Whole data directories are never mirrored destructively.

The current planner applies a conservative restart of all services when the deployment fingerprint changes. This is simple and predictable for small static networks. Per-service impact analysis, draining players, and rolling restarts are future improvements.

## Configuration safety

Names are constrained before being used as directories, Docker aliases, or completion values. Unknown TOML fields fail early. The manifest does not accept Compose fragments or arbitrary lifecycle commands. Managed image variables and authentication/port settings are reserved. Other service `env` values are passed through to itzg, including `OPS` from guided setup. Paper runs with `SKIP_SERVER_PROPERTIES=false`, allowing the image to apply supported environment options. Explicit manifest properties are supplied through `CUSTOM_SERVER_PROPERTIES` to take precedence over the corresponding generic image options; generated authentication, ports, MOTD, and RCON values remain authoritative. Configuration snapshots reject symlinks and runtime-world/JAR content.

Credentials and rendered files use private local permissions and stay outside Git. Compose references local database environment files. The exported local bundle can contain secrets and is intended for inspection or use on the same machine, not publication.

This does not sandbox Minecraft plugins: installed plugins run with the server's capabilities. A digit project and its plugins must be trusted before starting the deployment.

## Console commands and explicit destruction

`digit console [service]` discovers running containers by the selected environment's Compose project label, offers a Clack picker, checks the selected container's current labels/state and terminal configuration, prints recent logs and attaches through Docker. Paper and Velocity containers have `stdin_open` and `tty` enabled. Older containers require an explicit `digit up`; console never recreates them automatically. Attachment disables Docker signal forwarding and explicitly sets Ctrl+P, Ctrl+Q as the detach sequence. Terminal probes are stripped from historical log output before displaying it. Normal Docker detach responses are treated as success, including CLI versions that return exit 1 with `read escape sequence`. See the [Docker attach reference](https://docs.docker.com/reference/cli/docker/container/attach/).

`digit cmd <service> <command...>` loads an existing deployment and executes the image's `rcon-cli` through `docker compose exec -T`. Arguments are passed as an argument array, never interpolated into a shell. Commands must contain one nonempty line; Paper and Velocity are supported. Paper RCON is enabled in managed server properties. Velocity uses a generated VelociRCON configuration bound to loopback. Neither publishes its RCON port to the host, and generated credentials never appear in the command arguments.

`digit down` retains volumes. `digit down --destroy-all-data` requires two identical invocations within 60 seconds. The first records a fingerprint of the checkout identity, environment, deployment, Docker daemon and owned resource identities, then prints the scope without stopping anything. The second must match that snapshot before deletion. Shared volumes and networks with foreign consumers are refused. Confirmation is consumed before the destructive attempt; failures retain local metadata and require a fresh two-call confirmation. Successful destruction removes only the selected environment's local directory and Docker resources, retaining checkout identity, other environments, source files and EULA consent.

## Scope deliberately deferred

This release has no remote hosts, CloudNet integration, autoscaling, alternative server software, custom image providers, custom plugin URLs, backups, data migration, automatic background volume deletion, encrypted secret storage, or arbitrary database engines. `mariadb` is an explicit service type, not a generic `sql` promise.

Future orchestration can consume the validated service model through a different renderer. Dynamic instances would need separate concepts for templates, counts, placement, discovery, player routing, and scaling policy; those concepts should not be simulated with today's static service names.
