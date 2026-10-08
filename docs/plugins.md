# Plugins and dependency updates

[Documentation](README.md) · Related: [Configuration files](configuration.md)

## Add a Modrinth plugin

Run the guided package command:

```sh
digit add viabackwards
```

digit asks which Paper servers or Velocity proxy should receive each plugin, then checks
compatible versions and required dependencies. For example, selecting `lobby` and `survival`
for ViaBackwards prompts you to also install its required ViaVersion dependency on both servers.
Declining cancels the whole operation without changing `digit.toml` or `digit.lock`.

You can add several plugins, choose a version, or supply targets for automation:

```sh
digit add viabackwards luckperms
digit add viabackwards --servers lobby,survival --yes
digit add luckperms@<version-id-or-number> --servers proxy
```

Replace the version placeholder with an actual Modrinth version. `digit add` with no arguments
asks for plugin IDs or slugs. Existing manifest aliases are also accepted. New aliases come from
the project's Modrinth slug; the declaration stores its canonical project ID so upstream renaming
does not change its identity. `--all` selects every Minecraft service, including Velocity;
the plugin must be compatible with every selected service. Databases cannot receive plugins.

`--yes` accepts required dependencies and skips questions. In a network, pass `--servers` or
`--all` as well so the targets are explicit. A standalone server is selected automatically outside
a terminal. Without `--yes`, unattended adds that need new required dependencies fail with a
consent instruction instead of silently including them.

The commands save the manifest and matching lockfile after successful resolution and consent.
They preserve unrelated TOML formatting/comments and existing applicable version selections.
They do not download plugin JARs into a running server or restart it. Review and apply:

```sh
git diff -- digit.toml digit.lock
digit up
```

`add` and `remove` edit project-wide dependencies. Use `--servers` for service selection;
`--env` and `--profile` are not accepted. Environments receive the new selection when you next
run `up` for each environment.

## Initial plugins

`digit init` uses the same plugin input, server picker, compatibility checks, and required-dependency
confirmation as `digit add`. When initial plugins are selected, it also creates `digit.lock`.
For unattended initialization, `--yes --plugins viabackwards` includes required dependencies and
targets every Paper server. It does not put those plugins on the proxy or accept the Minecraft EULA.

## Editing the manifest directly

You can still declare a reusable alias and add it to the services that need it:

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

Required Modrinth dependencies are resolved recursively from the selected version's
[dependency metadata](https://docs.modrinth.com/api/operations/getprojectversions/).
Direct plugins live in `digit.toml`; transitive dependencies live only in `digit.lock` and are
removed automatically when nothing needs them. If you want to keep ViaVersion independently
of ViaBackwards, add it explicitly with `digit add viaversion` on those servers.

Optional dependencies are not added automatically. Conflicting required versions, reported
incompatible dependencies, or dependencies that cannot be resolved through Modrinth produce
an error. A package edit preserves existing compatible locked choices instead of upgrading
unrelated plugins. If a new plugin conflicts with an existing pinned selection, review your
version declarations and use `digit update` before trying again.

Hand-written manifest changes still resolve required dependencies automatically on `plan`,
`update`, or `up`; the new dependency consent step belongs to `add` and `init`.

Experimental Minecraft releases may have no compatible plugin release yet. Choose another Minecraft version, pin a compatible plugin release explicitly, or leave out that plugin. digit does not ignore compatibility to make a download succeed.

Only Modrinth is supported as a user plugin source in this release. Do not place JARs in configuration folders. Managed runtime filenames include the configured alias and an artifact hash, so you can identify a plugin without depending on upstream filename conventions. Required dependencies added through the guided commands use a readable Modrinth slug; dependencies resolved directly from manual manifest edits may use their project ID.

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

```sh
digit remove viabackwards
digit remove viabackwards --servers survival
digit remove viabackwards --all
```

Use the plugin's manifest alias. With no arguments, `digit remove` offers a plugin picker,
then asks which servers should lose each plugin. `--servers` and `--all` bypass the server picker.
Removing from only `survival` retains the declaration and installation on `lobby` if it still uses
the plugin. After the last reference is removed, digit removes the unused declaration and prunes
unneeded transitive dependencies from the lockfile.

digit refuses to remove a direct plugin if another selected plugin still requires it on that server.
Remove the dependent plugin first, or remove both together:

```sh
digit remove viabackwards viaversion --all
digit up
```

On the next `up`, digit removes the previously managed JARs. It preserves plugin data directories
and unrelated runtime files. Removing a plugin does not require `down --destroy-all-data`.

You can also edit the service's `plugins` list directly and run `digit plan` followed by `digit up`.

Deleting a `[plugins.alias]` declaration while a service still references it is a validation error. Remove the references first, or edit both in the same change.

For CLI upgrades, use the installer or Homebrew as described in [installation](installation.md#update-digit).
