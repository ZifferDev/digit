# Your first server

[Documentation](README.md) · Before you start: [Installation](installation.md)

## Create a project

```sh
digit doctor
digit init friends
cd friends
```

Choose one Paper server or a Velocity network. The wizard asks for service names, Minecraft version, memory, optional operator usernames, Modrinth plugins, an optional database, and who can connect.

Use a stable Minecraft version for the broadest plugin compatibility. Experimental versions are available and labeled in the searchable PaperMC catalog. Selecting a Minecraft version does not guarantee every plugin supports it.

For a network, the first Paper server you name becomes the initial destination. You can change the proxy's `fallback` list later in `digit.toml`.

The initializer creates configuration files only. It does not start containers or accept Minecraft's EULA.

## Start and connect

```sh
digit up
```

On the first start, read and accept the Minecraft EULA when prompted. digit remembers your acceptance in local user state, outside the project and Git. Each person running a cloned project must supply their own local consent.

digit resolves software and plugins into `digit.lock`, prepares configuration, starts Docker containers, waits for readiness, and prints the connection address. First startup downloads images and generates worlds, so allow more time than on later starts.

Open Minecraft Java Edition, select Multiplayer, and use the printed address. The default `127.0.0.1` binding is reachable from this computer. If you selected access from other computers, use the server machine's address; router and firewall configuration remains your responsibility.

```sh
digit status
digit logs -f
```

You can stop following logs with Ctrl+C without stopping the server.

## Stop without losing the world

```sh
digit down
digit up
```

`down` removes the containers and network but retains the data volumes. The next `up` reuses your world, player data, plugin state, and databases.

## Keep the setup in Git

```sh
git init
git add digit.toml digit.lock services environments .gitignore
git commit -m "Add Minecraft setup"
```

Commit the manifest, lockfile, and configuration. Do not commit `.digit/`: it contains local identities, generated bundles, and credentials. Worlds and database contents live in Docker volumes and are not part of the repository.

Someone with digit and Docker can clone the repository and run `digit up`. This creates the same declared setup with fresh runtime data and new local credentials.

## Try an isolated copy

The initializer includes a staging profile:

```sh
digit up --env plugin-test --profile staging
digit status --env plugin-test
digit down --env plugin-test
```

This copy gets its own data and an automatically assigned localhost port. Your main environment keeps running. Read [environments](environments.md) before deciding how to name long-lived staging and production instances.

## Noninteractive setup

```sh
digit init friends --yes --proxy --servers lobby,survival --minecraft 1.21.11 --ops YourMinecraftName
cd friends
# Use only if you accept https://www.minecraft.net/eula:
digit up --accept-eula
```

`--yes` chooses initializer defaults and is not EULA acceptance. Use `digit init --help` for memory, plugin, database, binding, and port options. Names in `--ops` receive Paper operator privileges; leaving it out creates no configured operators.

Next: [add plugins](plugins.md), [change configuration](configuration.md), or [use the console](operations.md#interactive-console).
