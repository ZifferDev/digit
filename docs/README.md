# digit documentation

Build a configuration you can keep in Git, then run isolated copies with one command.

## Get running

1. [Installation](installation.md): install digit and check Docker.
2. [Quickstart](quickstart.md): create a project, start it, and connect.
3. [Operations](operations.md): stop, inspect, update, and administer your servers.

## Make it yours

| Guide                                           | What you will find                                                |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| [Manifest reference](manifest.md)               | Services, network settings, versions, memory, and defaults        |
| [Plugins](plugins.md)                           | Modrinth plugins, dependencies, compatibility, and updates        |
| [Configuration and databases](configuration.md) | File overrides, image options, operators, and database references |
| [Environments](environments.md)                 | Isolated worlds, staging profiles, and Git workflows              |
| [Troubleshooting](troubleshooting.md)           | Common setup, connection, plugin, and console problems            |

These guides cover the current release candidate. digit runs one Docker host with standalone Paper or one Velocity proxy and static Paper endpoints. See the [project README](../README.md) for the current version and scope.

## For contributors

- [Design](design.md)
- [Verification overview](verification.md)
- [Recorded live test evidence](testing-live.md)
- [First release setup](release-setup.md)
- [Building and releasing](releasing.md)
