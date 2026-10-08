# Example projects

Copy `standalone/` or `network/` to a separate directory, then run `digit up` there.
They use a fixed Minecraft version and resolve exact builds/plugins on first use.
Commit the generated `digit.lock` alongside the project configuration.

The network includes two Paper endpoints, Velocity, ViaVersion, a private MariaDB
instance, and a reusable staging profile. Its `Example/config.yml` only shows
interpolation; it does not declare or install a real plugin.

For a new project using today's versions, prefer `digit init` and its live catalog.
