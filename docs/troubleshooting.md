# Troubleshooting

[Documentation](README.md) · Related: [Operations](operations.md)

Start with:

```sh
digit doctor
digit status
digit logs --tail 200
```

Add `--env <name>` for another environment. Use `--debug` when you need error details. Fix configuration and run `digit up` again; ordinary startup failures retain data.

## digit is not found

Confirm the executable exists in your installation directory and that directory is on `PATH`. Open a new terminal after changing your shell configuration. `command -v digit` shows which executable you are using. A source build, installer copy, and Homebrew installation in different directories can leave you running an older copy.

See [installation](installation.md). Update Homebrew-managed copies with Homebrew; the installer refuses to overwrite them.

## Docker is unavailable

Start your Docker runtime, then rerun `digit doctor`. On Linux, confirm your user can talk to the Docker engine and that `docker compose version` succeeds. Installing the digit executable does not install Docker.

If services exit under memory pressure, give the Docker runtime more memory or lower per-service `memory` values deliberately. Allow additional memory beyond Java heap sizes for the operating system, proxy, database, and native allocations.

## A version or plugin cannot be resolved

Check the exact Minecraft version and whether it needs `channel = "experimental"`. The initializer's searchable catalog labels experimental versions. Paper before 1.19 is outside this release.

A plugin must support the selected loader and Minecraft version. `latest` selects a compatible release, not an arbitrary newest file. Experimental Minecraft releases may have few compatible plugins. Pin a compatible version, change Minecraft version, or omit the plugin.

If a locked upstream artifact is unavailable, digit fails instead of upgrading it silently. Review a deliberate `digit update`, or restore upstream access. Do not delete the lockfile just to hide a compatibility failure.

## Frozen lockfile mismatch

`--frozen-lockfile` means “use this exact matching lockfile.” It cannot initialize a missing lock or accept dependency changes. Resolve and review the changes intentionally with `digit plan` or `digit update`, commit `digit.lock`, and retry the frozen command.

`digit update` changes project dependencies. For the digit executable itself, use the [installation method's update process](installation.md#update-digit).

## Cannot connect in Minecraft

Use the address printed by `digit status`. Named test environments often have automatically assigned ports. `127.0.0.1` is accessible only from the same computer. To permit remote players, configure an appropriate bind address and the host/router firewall, then apply with `digit up`.

For a network, connect to Velocity. Paper backend ports are intentionally not published. Check that all services are healthy and inspect the relevant proxy and backend logs.

A successful server-list response is not proof that an authenticated player can join or travel between backends. If login fails, preserve the actual proxy/backend error messages when reporting the problem.

## A configuration edit did not take effect

Running services use snapshots. Editing files or switching Git branches does not change those snapshots until `digit up` applies the change.

Check that the file is under the correct `services/<name>/` directory. A selected profile may replace it. Files override whole files; arbitrary YAML is not merged. digit also reapplies its own connection, authentication, port, and RCON fields.

For image options, use `[services.<name>.env]`; for Paper properties, use `[services.<name>.properties]`. Explicit properties take precedence over corresponding generic image options. Some options only affect newly generated data, so they cannot regenerate an existing world automatically.

## Unknown configuration placeholder

Check service names and available [references](configuration.md#other-references-and-literal-placeholders). If the text belongs to a plugin's own placeholder system, escape it as `$${placeholder}` so digit emits `${placeholder}` literally.

## Console or command access fails

`digit console` needs an interactive terminal and a running Minecraft service. Use `digit logs` for output or `digit cmd` in scripts. On an older deployment, run `digit up` once to enable the current console/RCON configuration.

For `cmd`, check that the service is healthy. Velocity's image helper needs upstream access when first installing its RCON plugin. Do not add a second Velocircon plugin manually.

When attached, detach with **Ctrl+P, then Ctrl+Q**. If you interrupted the server accidentally, inspect `digit status` and start it again with `digit up`.

## Another operation owns the project lock

Wait for the active command to finish. digit can recover a lock whose recorded process has exited. Invalid locks or interrupted recovery may require inspecting the reported lock file. Verify that no digit operation is active before removing only that stale lock. Do not delete the entire `.digit/` directory.

## Destruction asks for confirmation again

The second `down --destroy-all-data` must select the same project/environment within 60 seconds and see the same deployment resources. Expiration, a new deployment, a different Docker daemon, or changed resources requires a fresh warning. Foreign containers using the environment's resources prevent deletion; inspect that sharing before proceeding.

## Reporting a problem

Include digit's version, operating system/architecture, the failing command, and relevant error logs. Redact credentials and player information. Generated bundles, `.digit/` secrets, and raw Docker inspection output can contain passwords; do not post them wholesale.

State whether the problem was observed in a real Minecraft client, a server-list ping, or only the logs. This distinction makes connection problems much easier to diagnose.
