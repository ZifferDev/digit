# Configuration and databases

[Documentation](README.md) · Related: [Manifest](manifest.md), [Environments](environments.md)

## Server properties and image options

Set ordinary Paper properties in the manifest:

```toml
[services.survival.properties]
difficulty = "hard"
pvp = true
max-players = 20
view-distance = 8
```

Values are strings, numbers, or booleans. The table applies only to Paper. digit reserves authentication, ports, MOTD, RCON, and other connection wiring.

Additional supported itzg image options go under `env`:

```toml
[services.survival.env]
OPS = "Alice,Bob_2"
WHITELIST = "Alice,Bob_2,Charlie"
VIEW_DISTANCE = 8
TZ = "UTC"
```

Environment keys use uppercase letters, numbers, and underscores. digit passes ordinary image options through and enables image property processing. Explicit manifest properties take precedence over corresponding generic image options; digit-owned wiring remains authoritative. Image options may have their own startup or update semantics: setting an option is not a general way to reset an existing world.

`digit init` can ask for OP usernames, or accept `--ops Alice,Bob_2`. It puts that list on every Paper service. Existing projects can add `OPS` as shown above. These privileges apply to Paper and do not grant Velocity plugin permissions. Server console commands run with console privileges regardless of your in-game OP status.

## File overrides

Put configuration files in the matching service directory:

```text
services/
└── survival/
    └── plugins/
        └── MyPlugin/
            └── config.yml
```

digit copies a snapshot into the server's runtime directory when you apply the project. It does not modify your source file. Changes take effect after:

```sh
digit plan
digit up
```

A source file replaces that entire file; arbitrary YAML or JSON is not merged. digit then patches its owned connection fields into core Paper, Spigot, and Velocity configuration. Runtime-generated files that you do not supply remain managed by the server or plugin.

To override a file only for a profile, use the same path beneath `environments/<profile>/services/`. See [profile files](environments.md#profile-files).

Removing a managed source file removes that exact managed runtime path on the next apply/start. Other plugin data and world directories remain. Do not put worlds, player data, database files, or JARs in these configuration directories. Symlink configurations are rejected.

## Databases

Add MariaDB to the manifest:

```toml
[services.database]
type = "mariadb"
version = "11.8"
```

digit creates a persistent database volume, the `minecraft` database, a non-root `minecraft` user, and generated credentials. The database has no published host port. Minecraft services wait for its readiness.

A plugin configuration can refer to the generated values:

```yaml
host: '${database.host}'
port: ${database.port}
database: '${database.name}'
username: '${database.username}'
password: '${database.password}'
```

Or, when the plugin supports a connection URI:

```yaml
database_url: '${database.url}'
```

Available references:

| Reference              | Value                                                |
| ---------------------- | ---------------------------------------------------- |
| `${database.host}`     | Internal service hostname                            |
| `${database.port}`     | `3306`                                               |
| `${database.name}`     | `minecraft`                                          |
| `${database.username}` | `minecraft`                                          |
| `${database.password}` | Generated application password                       |
| `${database.url}`      | `mysql://` URI containing application credentials    |
| `${database.jdbc_url}` | `jdbc:mariadb://` URL; supply credentials separately |

Replace `database` with your database service's name. Choose the fields required by the actual plugin; JDBC URLs and credential-bearing URIs are not interchangeable.

Credentials persist locally across restarts and differ between environments. Preserve `.digit/` together with the deployment's volumes to keep that continuity. Cloning Git alone deliberately creates fresh credentials and data.

## Other references and literal placeholders

Configuration files can also use `${project.name}`, `${environment.name}`, `${service.name}`, and `${<service>.host}` / `${<service>.port}`.

Substitution runs once in `.yml`, `.yaml`, `.toml`, `.json`, `.properties`, `.conf`, `.cfg`, `.txt`, and `.ini` files. Unknown references fail with a file location. Use `$${something}` to produce a literal `${something}` for a plugin's own placeholder system.

This is text substitution, not a YAML/JSON-aware serializer. Quote values appropriately for the destination format. Generated files may contain credentials and must stay outside Git.

## What to keep

Commit `digit.toml`, `digit.lock`, service configuration, profile configuration, and `.gitignore`. Keep `.digit/` local: it contains project identity, credentials, release snapshots, and deployment records. Runtime data lives in Docker volumes.

There is no backup or migration command yet. Do not delete `.digit/` to troubleshoot a running deployment; doing so loses its local identity and credential records. Use the scoped commands in [operations](operations.md).
