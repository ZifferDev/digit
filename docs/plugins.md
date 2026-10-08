# Plugins and dependency updates

[Documentation](README.md) · Related: [Configuration files](configuration.md)

## Add a Modrinth plugin

Declare a reusable alias, then add it to the services that need it:

```toml
[plugins.viaversion]
source = "modrinth"
project = "viaversion"
version = "latest"

[services.survival]
type = "paper"
version = "1.21.11"
plugins = ["viaversion"]
```

Use a Modrinth project slug or ID for `project`. `version` accepts `"latest"` or a specific Modrinth version identifier/version number. An alias such as `viaversion` is your project's name for the dependency; it does not have to match the upstream slug.

```sh
digit plan
digit up
```

Adding a plugin changes the relevant lock selection. Review and commit `digit.lock` along with the manifest. Plugin configuration belongs under `services/<service>/plugins/<plugin-folder>/`.

## Compatibility and dependencies

For Paper, digit checks the selected Minecraft version and Paper/Spigot/Bukkit loader compatibility. For Velocity, it selects Velocity-compatible plugins. A `latest` plugin selects a compatible Modrinth release; beta/alpha plugin releases require an explicit compatible selection.

Required Modrinth dependencies are installed recursively. Optional dependencies are not added automatically. Conflicting required versions, reported incompatible dependencies, or dependencies that cannot be resolved through Modrinth produce an error.

Experimental Minecraft releases may have no compatible plugin release yet. Choose another Minecraft version, pin a compatible plugin release explicitly, or leave out that plugin. digit does not ignore compatibility to make a download succeed.

Only Modrinth is supported as a user plugin source in this release. Do not place JARs in configuration folders. Managed runtime filenames include the configured alias and an artifact hash, so you can identify a plugin without depending on upstream filename conventions. Transitive dependencies use their project ID.

## Update locked dependencies

```sh
digit update
git diff -- digit.lock
digit plan
digit up
```

`digit update` refreshes the project's locked Minecraft builds, container images, and plugins. It does not restart servers or update the digit CLI executable. The final `up` applies the new selections and may recreate containers.

An unchanged lockfile is reused. Ordinary configuration edits do not change dependency selections. When a service's dependency declaration changes, digit preserves selections that are still applicable; an explicit `update` deliberately refreshes the project dependencies.

The lock records exact builds, plugin files and checksums, Java choices, and multi-architecture image digests. Commit it so another machine resolves the same selected setup. A missing upstream artifact is an error, not permission to silently replace it.

```sh
digit up --frozen-lockfile
```

Use `--frozen-lockfile` on `up`, `plan`, or `render` to reject a missing or mismatching lock instead of resolving changes. `plan` without that flag can create or update the lockfile, although it does not start containers.

The lockfile is not an offline archive. Fresh machines still need upstream downloads. One auxiliary exception is Velocity command support: the pinned itzg proxy image's built-in helper downloads Velocircon from its upstream GitHub release. That helper-managed JAR is not separately checksum-locked in `digit.lock`. Do not add another Velocircon copy to the proxy's plugin list; digit already provides its configuration.

## Remove a plugin

Remove its alias from a service's `plugins` list, review `digit plan`, and run `digit up`. digit removes the previously managed JAR at startup. It preserves the plugin's data directory and unrelated runtime files.

Deleting a `[plugins.alias]` declaration while a service still references it is a validation error. Remove the references first, or edit both in the same change.

For CLI upgrades, use the installer or Homebrew as described in [installation](installation.md#update-digit).
