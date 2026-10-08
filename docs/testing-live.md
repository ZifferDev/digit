# Live integration evidence

Started: 2026-10-07T14:16:50.165Z
Finished: 2026-10-07T14:19:09.665Z

- PASS: Host: linux/aarch64; 8214716416 bytes; 11 CPUs
- PASS: Standalone Paper responds to a real Minecraft status handshake
- PASS: Standalone Paper has online authentication enabled in its effective configuration
- PASS: Standalone data survives digit down followed by digit up
- PASS: Velocity network responds to a real Minecraft status handshake
- PASS: Velocity, both Paper endpoints, and MariaDB are healthy
- PASS: Velocity and Paper use modern forwarding with identical environment secret
- PASS: Backend Paper is configured to delegate authentication to the proxy
- PASS: Velocity registry contains both internal Paper destinations
- PASS: Configuration interpolation supplies private database connection credentials
- PASS: Generated non-root database credentials authenticate and query MariaDB
- PASS: Paper backends and MariaDB publish no host ports
- PASS: Locked ViaVersion plugin appears in actual Paper startup logs
- PASS: Config-only edit recreates the service and applies the new configuration
- PASS: Removing a declared plugin removes its managed JAR
- PASS: Removing a managed plugin preserves unrelated plugin runtime data
- PASS: A second staging network runs concurrently and responds to status
- PASS: Staging receives a distinct Compose project identity
- PASS: Staging receives a distinct forwarding secret
- PASS: Staging and development use different persistent data volumes
- PASS: Staging configuration references isolated environment and database credentials

All live smoke checks passed. Test-owned containers and volumes were removed.

Limitations: No authenticated player login or in-game travel was tested. This run used the host architecture listed above; cross-architecture image availability was validated by the resolver.

Raw command log (local, may include generated test secrets): /var/folders/hb/yt8tcwxx56ncj690y657_19w0000gn/T/digit-live-uC227W/commands.log

---

# Live integration evidence

Started: 2026-10-07T14:20:17.157Z
Finished: 2026-10-07T14:20:39.109Z

- PASS: Host: linux/aarch64; 8214716416 bytes; 11 CPUs
- PASS: Explicit experimental Paper 26.3 starts and responds to Minecraft status
- PASS: Experimental selection locks its prerelease channel and Java 25 image
- PASS: Experimental server container actually runs Java 25

All live smoke checks passed. Test-owned containers and volumes were removed.

Limitations: No authenticated player login or in-game travel was tested. This run used the host architecture listed above; cross-architecture image availability was validated by the resolver.

Raw command log (local, may include generated test secrets): /var/folders/hb/yt8tcwxx56ncj690y657_19w0000gn/T/digit-live-mq8PmG/commands.log

---

# Follow-up regression coverage — 2026-10-08 (Asia/Seoul)

The OP, console-command, image-environment, readable-plugin-name, and explicit-destruction changes received automated coverage. The following results are unit and subprocess-boundary tests, not additional live Minecraft evidence:

- PASS: Optional OP input accepts valid usernames, rejects malformed names, and writes `env.OPS` to every Paper service while leaving Velocity unchanged.
- PASS: Generated Paper bundles enable image property processing (`SKIP_SERVER_PROPERTIES=false`), retain supported custom image options, and supply explicit manifest properties through `CUSTOM_SERVER_PROPERTIES`.
- PASS: Paper and Velocity RCON settings receive distinct passwords per service and environment, reuse credentials on repeat rendering, and publish no RCON host port.
- PASS: Generated container labels identify digit's environment, service, and configuration fingerprint.
- PASS: Managed JAR filenames include their declared alias or dependency project ID, preserve verified bytes, and change the managed inventory when the locked artifact changes.
- PASS: `digit cmd` accepts quoted or split command text, preserves literal shell metacharacters at the subprocess boundary, rejects database/unknown targets and multiline commands, and provides an actionable connection-failure message.
- PASS: Destruction's first invocation only warns; confirmation expires after 60 seconds and is invalidated by changed resources, daemon, or configuration. Scoped deletion includes retained volumes from removed services and rejects shared volumes or networks.
- PASS: Failed destruction consumes confirmation and retains local metadata for inspection.

Targeted verification: 73 tests passed across `test/init.test.ts`, `test/cli.test.ts`, `test/deployment.test.ts`, `test/commands.test.ts`, and `test/destroy.test.ts`; `bun run check` passed.

No authenticated in-game login, in-game command execution, or backend travel is established by these checks. The earlier live Docker and status-handshake results above remain separate evidence for the earlier deployment behavior. Effective image startup behavior for the new environment options and live Paper/Velocity RCON responses need their own live verification.

---

# Live integration evidence

Started: 2026-10-07T23:10:46.128Z
Finished: 2026-10-07T23:11:09.135Z

- PASS: Host: linux/aarch64; 8214716416 bytes; 11 CPUs
- PASS: First destructive invocation only warns
- PASS: Second invocation removes test environment data

FAILED: Command failed (1): /opt/homebrew/Cellar/bun/1.3.14/bin/bun /Users/motz/Documents/Entwicklung/digit/src/cli.ts -C /var/folders/hb/yt8tcwxx56ncj690y657_19w0000gn/T/digit-live-WSl9HV/experimental up --accept-eula
Network digit-smoke-experimental-88dff182d09e-dev_default Creating
Volume digit-smoke-experimental-88dff182d09e-dev_survival-data Creating
Volume digit-smoke-experimental-88dff182d09e-dev_survival-data Creating
Network digit-smoke-experimental-88dff182d09e-dev_default Creating
Volume digit-smoke-experimental-88dff182d09e-dev_survival-data Created
Volume digit-smoke-experimental-88dff182d09e-dev_survival-data Created
Network digit-smoke-experimental-88dff182d09e-dev_default Created
Network digit-smoke-experimental-88dff182d09e-dev_default Created
Container digit-smoke-experimental-88dff182d09e-dev-survival-1 Creating
Container digit-smoke-experimental-88dff182d09e-dev-survival-1 Created
Container digit-smoke-experimental-88dff182d09e-dev-survival-1 Starting
Container digit-smoke-experimental-88dff182d09e-dev-survival-1 Started
Container digit-smoke-experimental-88dff182d09e-dev-survival-1 Waiting
container digit-smoke-experimental-88dff182d09e-dev-survival-1 is unhealthy
digit: docker compose --project-name failed (exit 1).
Inspect digit status --env dev and digit logs --env dev. Data was retained; fix the issue and run digit up again.

Starting smoke-experimental / dev…

Limitations: No authenticated player login or in-game travel was tested. This run used the host architecture listed above; cross-architecture image availability was validated by the resolver.

Raw command log (local, may include generated test secrets): /var/folders/hb/yt8tcwxx56ncj690y657_19w0000gn/T/digit-live-WSl9HV/commands.log

---

# Live integration evidence

Started: 2026-10-07T23:11:38.654Z
Finished: 2026-10-07T23:12:43.828Z

- PASS: Host: linux/aarch64; 8214716416 bytes; 11 CPUs
- PASS: Explicit experimental Paper 26.3 starts and responds to Minecraft status
- PASS: Experimental selection locks its prerelease channel and Java 25 image
- PASS: Experimental server container actually runs Java 25
- PASS: digit cmd executes against standalone experimental Paper through authenticated RCON
- PASS: First destructive invocation only warns
- PASS: Second invocation removes test environment data

All live smoke checks passed. Test-owned containers and volumes were removed.

Limitations: No authenticated player login or in-game travel was tested. This run used the host architecture listed above; cross-architecture image availability was validated by the resolver.

Raw command log (local, may include generated test secrets): /var/folders/hb/yt8tcwxx56ncj690y657_19w0000gn/T/digit-live-I8kbzV/commands.log

---

# Release candidate 2 live feature checks — 2026-10-08 (Asia/Seoul)

Test network: a separate localhost-only Velocity 4.2.0 proxy with two Paper 26.3 servers on Java 25. No lifecycle commands targeted the existing friends environment. During concurrent tests, its Paper JVMs exited abruptly and the containers restarted; memory pressure in the shared 8 GiB Docker engine may have contributed. The separate test network was stopped to remove that load.

- PASS: Real digit cmd responses from Velocity (velocity info) and both Paper backends (list).
- PASS: Both Paper servers resolve m07z to the authenticated UUID and configure OP level 4 and whitelist membership. This checks effective configuration, not player login.
- PASS: DIFFICULTY=hard, VIEW_DISTANCE=4 and SIMULATION_DISTANCE=4 take effect through service env; max-players=7 takes effect through manifest properties.
- PASS: Both servers load ViaVersion 5.12.0 from digit-compatibility-02ed325dc9eec7a17eba.jar; compatibility is the manifest alias.
- PASS: Running containers use digit.environment, digit.service and digit.config labels, with no sh.digit labels. Paper backends publish no host ports; proxy RCON binds to 127.0.0.1 inside its container.
- PASS: Separate real Docker destruction harness passed 12 assertions: warning keeps the container and sentinel data alive, repeat deletes scoped containers/networks/volumes including an orphan, staging stays running with its data/secrets, and project identity survives. Harness resources were cleaned.
- PASS: Fresh standalone Paper 26.3 reaches healthy state, answers a Minecraft status handshake and accepts digit cmd; its actual world volume and container are removed through the two-invocation destruction flow (run recorded above).

The first fresh standalone run exposed an empty CUSTOM_SERVER_PROPERTIES value rejected by the image helper. digit now omits that variable when there are no explicit properties. The failing run above is retained for traceability; the subsequent run passed.

Final automated verification: 162 tests, 458 assertions, no failures; TypeScript checking passed. macOS ARM64, Linux ARM64 and Linux x64 executables were rebuilt; SHA-256 checksums verified. The Mac binary runs locally, ARM64 binary runs in a native Linux container, and x64 command help runs under Docker emulation.

Client limitation: a Minecraft 26.3 client was available, but Computer Use only exposed Prism Launcher and could not attach to its Java game window, even after the user brought it forward. Authenticated login, backend travel and in-game permissions are not yet verified. The test project at /tmp/digit-feature-live is retained with its data but stopped. It can be started later with digit -C /tmp/digit-feature-live up, listening on localhost:25566; avoid running multiple full networks beyond the Docker engines available memory.

---

# Interactive console — 2026-10-08 (Asia/Seoul)

- PASS: A real PTY displayed the running-service picker, filtered to the selected environment. With only the proxy running it offered proxy; after stopping proxy and starting lobby it offered only lobby.
- PASS: The Velocity attachment displayed recent logs, accepted velocity info, and streamed the response from Velocity 4.2.0.
- PASS: The rebuilt macOS executable attached to Paper 26.3, accepted list, and streamed the real player-count response.
- PASS: Ctrl+P then Ctrl+Q detached successfully (exit 0) in both tests. Docker inspect immediately afterward showed running=true and restarts=0.
- PASS: A Docker CLI normal-detach exit-code quirk was reproduced and handled specifically; unrelated exit errors remain errors. Historical terminal probes are stripped before logs are replayed.
- PASS: Full automated suite: 181 tests, 511 assertions. Type checking passed. All three platform binaries rebuilt.

Only one test Minecraft service ran at a time. The test containers/network were removed afterward using ordinary digit down; retained test data is unchanged. No in-game interaction was attempted.
