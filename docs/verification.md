# Release candidate verification

Verified on 7–8 October 2026 (Asia/Seoul), most recently `0.1.0-rc.2`, using Bun 1.4.2, macOS ARM64,
and Docker Desktop's Linux ARM64 engine (approximately 8 GiB memory).
This report distinguishes running software from compilation and configuration checks.

## Automated checks

- Bun tests cover manifest validation, topology, dependency resolution, checksum enforcement,
  lock reuse, guided initialization, EULA consent, configuration snapshots, environment
  isolation, concurrent-operation locks, command errors, and completion.
- TypeScript checking and Prettier checking pass.
- Standalone executables compile for macOS ARM64, Linux ARM64, and Linux x64.
- Release artifacts have verified SHA-256 checksums in `dist/SHA256SUMS`.
- The example manifests pass the same validation as real projects.
- RC2 with interactive console: 181 tests and 511 assertions pass, including console-command argument safety,
  OP setup, environment options, readable plugin artifacts and scoped destruction.
- Interactive console tests cover service/environment filtering, cancellation, old-container
  upgrade guidance, terminal requirements, state changes and Docker's detach exit behavior.

## Platform and CLI evidence

| Check              | Evidence                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS ARM64 binary | Runs version/help/doctor and shell-completion commands                                                                                              |
| Linux ARM64 binary | Runs inside a native ARM64 Ubuntu Docker container                                                                                                  |
| Linux x64 binary   | Runs inside an AMD64 Ubuntu container using emulation; native x64 hardware was not available                                                        |
| Bash and Zsh       | Completion generation, script syntax, and completion-protocol tests                                                                                 |
| Fish               | Loaded generated completion in a real Fish shell in Linux ARM64 Docker; command suggestions returned                                                |
| Guided setup       | Full compiled wizard completed in a real terminal, including defaults, version search, and experimental selection; cancellation verified separately |
| CI                 | Three-platform test/build matrix configured; remote GitHub Actions has not been run here                                                            |

## Live Minecraft and database evidence

The [live test report](testing-live.md) records the actual runs. These started real itzg
containers and queried the Minecraft server-list protocol over TCP.

- Standalone Paper 1.21.11 became healthy, answered a status handshake, and had online
  authentication enabled in its effective configuration.
- A persistent file survived `digit down` followed by `digit up` on the same volume.
- Velocity, two Paper backends, and MariaDB became healthy together.
- The proxy answered a status handshake. Effective proxy/backend configuration contained
  the correct server registry, modern forwarding mode, and matching forwarding secret.
- Only the proxy published a host port; backends and MariaDB remained private.
- ViaVersion loaded from its locked Modrinth artifact.
- Generated non-root database credentials successfully executed `SELECT 1` in MariaDB.
- Configuration interpolation produced the expected database connection string.
- A configuration-only edit recreated containers and applied the edited file.
- Removing a declared plugin removed its managed JAR and preserved unrelated plugin data.
- A second staging network ran concurrently with separate ports, volumes, forwarding
  secrets, and database credentials.
- Explicit experimental Paper 26.3 started successfully, answered a status handshake, and
  actually ran Java 25.

The live runs found and verified a fix for Velocity's built-in example forced-host routes.
RC2 also verifies live Paper/Velocity console commands, OP/whitelist configuration,
custom image settings, readable plugin filenames, and two-call destructive cleanup.
The console follow-up used a real terminal and real containers, one at a time: the picker
showed only the running service, Velocity accepted `velocity info`, and Paper accepted
`list`. Ctrl+P, Ctrl+Q returned successfully in both cases; each container remained
running with zero restarts. Paper was tested through the rebuilt macOS executable.
The first standalone follow-up exposed an empty custom-properties option; it was fixed
and a fresh standalone run passed. Disposable smoke/harness resources were cleaned up.
The separate manual test project at `/tmp/digit-feature-live` is retained but stopped.
The existing friends Paper containers restarted during concurrent runs; logs showed abrupt
Java exits, possibly due to shared Docker memory pressure. No lifecycle command targeted them.
The test network was stopped to remove the additional load.

## Remaining manual acceptance

A Minecraft 26.3 client was available for RC2, but Computer Use could not attach to its
Java game window; it only exposed Prism Launcher. The manual checks remain pending.
Before using this candidate for an existing community, perform these checks with fresh test worlds:

1. Join a standalone server with an authenticated account.
2. Join the proxy and confirm arrival in the configured lobby.
3. Travel to another backend; confirm UUID, skin, permissions, and any plugin behavior.
4. Restart the environment and confirm player/world persistence through the client.

These are not covered by a server-list ping or matching configuration files. No production
worlds were imported or modified. Native Linux x64 server execution and unsigned macOS
binary distribution also remain release checks before wider publication.

## Reproduce

```sh
bun install --frozen-lockfile
bun test
bun run check
bun run format:check
bun run build:all
# Only if you accept https://www.minecraft.net/eula:
bun scripts/smoke.ts --accept-eula
```

The live script creates isolated temporary projects, uses private localhost ports, and
removes only its own containers and volumes. It requires internet access, Docker Compose,
and enough memory to run two small networks concurrently. Its local raw logs can contain
generated disposable credentials; do not publish them.
