# Environments and staging

[Documentation](README.md) · Related: [Configuration](configuration.md), [Operations](operations.md)

An **environment** is a running instance with its own data. A **profile** is a reusable set of configuration overrides. Neither requires a Git branch.

```sh
digit up --env staging
digit up --env plugin-test --profile staging
```

The first command uses the environment named `staging` and, if present, the matching staging profile. The second creates a separate environment named `plugin-test` using that same profile. They have different worlds, databases, credentials, and Docker resources.

## Default behavior

| Selection                             | Settings and data                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| No `--env`                            | Environment `dev`, using the manifest's connection settings                  |
| `--env staging`                       | Separate data; localhost with an automatic port; matching profile if present |
| `--env plugin-test --profile staging` | Separate `plugin-test` data, with the staging profile applied                |

A matching `environments/<environment>.toml` is optional. An explicitly selected `--profile` must exist. Profile settings can override the default localhost binding and automatic port, so avoid assigning the same fixed host port to simultaneously running environments.

```sh
digit status --env plugin-test
digit logs survival --env plugin-test
digit down --env plugin-test
```

Use the address printed by `up` or `status`. The environment name is not a hostname that Minecraft resolves automatically.

## Profile files

```toml
# environments/staging.toml
[network]
bind = "127.0.0.1"
port = 0
motd = "Friends staging"

[services.survival]
memory = "1G"

[services.survival.properties]
max-players = 5

[services.survival.env]
VIEW_DISTANCE = 6
```

A profile can change network fields and existing services' memory, properties, image environment options, or Velocity fallback destinations. Properties and environment tables override matching keys. It cannot add services or change versions, builds, channels, or plugin dependencies; environments in the same checkout share one lockfile.

For a profile-specific plugin file, use:

```text
environments/staging/services/survival/plugins/MyPlugin/config.yml
```

It replaces the corresponding common file completely. The source remains untouched; running containers use prepared snapshots.

## Git workflows

Commit a known-good manifest, lockfile, and configuration. Apply that commit to staging, then apply the same files to your production environment after testing. Promotion changes configuration and software; it does not copy staging worlds or database contents.

To test different dependency versions, use another checkout or branch with its own changed manifest and lockfile. Separate checkouts receive distinct local project identities. Do not copy `.digit/` between them, because it belongs to an existing deployment.

Switching branches does not switch worlds or modify running containers. `--env` selects runtime data; the checkout supplies configuration. Run `digit plan` and `digit up` to apply the current checkout. The candidate conservatively recreates the deployment when configuration changes and does not provide rolling updates.

## Stopping and removing a test copy

`digit down --env plugin-test` stops the copy but keeps its data for later. To permanently remove that environment and its volumes, use the two-invocation [destruction workflow](operations.md#permanently-destroy-one-environment). There is no automatic cleanup of environment data.
