# Installation

[Documentation](README.md) · Next: [Quickstart](quickstart.md)

## Requirements

- macOS on Apple Silicon, or Linux on ARM64 or x64.
- A running Docker engine with the Docker Compose plugin.
- Enough Docker memory for your servers. Defaults are 2 GiB per Paper server and 512 MiB for Velocity, plus overhead and any database.
- Internet access for the first download of images, server software, and plugins.

The compiled digit executable includes its runtime. You do not need Node, Bun, or a host Java installation to run it. Linux release binaries target glibc distributions such as Debian and Ubuntu; Alpine/musl is not covered by this candidate.

On macOS, start Docker Desktop or another compatible Docker runtime before running servers. digit does not install Docker for you.

## Build the current checkout

This path works before release assets are published. Install [Bun](https://bun.sh/) 1.3 or newer; development and release builds currently use Bun 1.4.2.

From the digit source directory:

```sh
bun install --frozen-lockfile
bun run build
mkdir -p "$HOME/.local/bin"
cp dist/digit "$HOME/.local/bin/digit"
```

Put that directory on your shell's `PATH`. For Bash or Zsh, add this to `~/.bashrc` or `~/.zshrc`, then open a new terminal:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

For Fish:

```fish
fish_add_path "$HOME/.local/bin"
```

Do not copy a source build over a Homebrew-managed installation. Use one installation method consistently.

## Release installer

**Publication status:** the commands below describe the release distribution path. They require a published release containing `install.sh`, platform binaries, and `SHA256SUMS`. The release repository is [ZifferDev/digit](https://github.com/ZifferDev/digit); these asset URLs become usable after publication. Until then, build the current checkout as described above.

Download the installer from the release, inspect it if desired, then run it:

```sh
curl -fsSL https://github.com/ZifferDev/digit/releases/latest/download/install.sh -o /tmp/digit-install.sh
sh /tmp/digit-install.sh
```

The default installs the latest stable digit in `~/.local/bin`. If only release candidates exist, request an exact candidate explicitly from its release:

```sh
curl -fsSL https://github.com/ZifferDev/digit/releases/download/v0.1.0-rc.2/install.sh -o /tmp/digit-install.sh
sh /tmp/digit-install.sh --version v0.1.0-rc.2
```

Choose another destination with `--install-dir`:

```sh
sh /tmp/digit-install.sh --version v0.1.0-rc.2 --install-dir "$HOME/bin"
```

The installer selects the supported platform binary and verifies its release checksum. It refuses to overwrite a Homebrew-managed installation. The destination must be writable and on your `PATH`.

## Homebrew

Once the tap is published, install with:

```sh
brew install ZifferDev/tap/digit
```

If Homebrew asks you to trust the third-party tap, the official tap is `ZifferDev/tap`.
On Homebrew versions with explicit trust controls, run `brew trust --tap ZifferDev/tap`
and repeat the installation.

The tap repository is [ZifferDev/homebrew-tap](https://github.com/ZifferDev/homebrew-tap). Publishing a formula is separate from building this checkout; do not expect the command to work before that formula is published. Stable Homebrew publication and prerelease binary downloads are separate release steps.

## Check your installation

```sh
digit --version
digit doctor
```

`doctor` checks the Docker engine, Compose, and available Docker resources. It also reports whether local EULA consent is already recorded. It does not start Minecraft.

## Update digit

For a release-installer installation, rerun the installer to select the latest stable version, or pass `--version` for an exact release or candidate. The CLI executable is replaced; project files and server data remain separate.

For Homebrew:

```sh
brew update
brew upgrade digit
```

For a source build, update your source checkout, install its locked dependencies, rebuild, and copy the executable to the same location.

**`digit update` is different:** it refreshes the current project's server software, images, and plugin lockfile. It does not update the digit executable. See [dependency updates](plugins.md#update-locked-dependencies).

After updating the CLI, run `digit plan` and `digit up` in a project to apply any changed generated configuration. This may recreate containers while retaining their volumes.

## Shell completion

Add one line to the configuration for your shell:

```sh
# Zsh: ~/.zshrc
source <(digit complete zsh)

# Bash: ~/.bashrc
source <(digit complete bash)
```

For Fish, add this to `~/.config/fish/config.fish`:

```fish
digit complete fish | source
```

Open a new terminal. Completion includes commands, options, and local service, environment, and profile names. It does not contact remote version catalogs.
