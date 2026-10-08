# Release operations

[Documentation](README.md) · First-time setup: [Apple credentials and repository setup](release-setup.md)

This guide describes the release pipeline contract. A release is verified only when its actual workflow and publication checks have passed. Current development is `0.1.0-rc.2`; keep it a prerelease until manual acceptance testing supports a stable release. digit is MIT-licensed.

## CI artifacts and published releases

Ordinary CI runs native checks, tests, build and packaging on macOS ARM64, Linux ARM64, and Linux x64. It uploads unsigned development artifacts. These are useful for inspection and testing, but they are not the signed, notarized public macOS release.

A version-tag push triggers `.github/workflows/release.yml`:

1. Validate the version/ref and run checks.
2. Build and test on all three native targets.
3. Sign the macOS binary with Developer ID Application, enable hardened runtime with the required Bun JIT entitlements, and submit a ZIP to Apple's notary service.
4. Require the notarization result to be `Accepted`.
5. Assemble final assets and checksums, and attest them.
6. Upload to a draft GitHub release and verify the uploaded asset digests.
7. Publish the release with repository release immutability enabled.
8. For stable versions only, update `ZifferDev/homebrew-tap` through the reusable `homebrew.yml` workflow.

The `release` GitHub environment provides the six Apple secrets and the repository-scoped `HOMEBREW_TAP_TOKEN`. It allows `v*` tags. Follow [release setup](release-setup.md) if those credentials are missing; do not add secret values to source files, logs, issues, or chat.

## Before tagging

From the version's intended commit:

```sh
bun install --frozen-lockfile
bun run check
bun test
bun run build
./dist/digit --version
```

Use Bun 1.4.2, as pinned in the pipeline. Keep `package.json` and `src/version.ts` aligned with the intended tag. Update user documentation and the verification record to match the actual version and evidence. Renderer changes also need the render revision maintained so existing deployments receive the new generated behavior.

The tag must point to a reviewed commit reachable from `main`. Inspect the working tree and commit before tagging. Do not create a stable `v0.1.0` tag merely to get a default installer or Homebrew release while candidate testing remains incomplete.

## Start a release

For the current candidate, after the intended commit is on `main` and the tag does not already exist:

```sh
git switch main
git pull --ff-only
git status --short
git tag -a v0.1.0-rc.2 -m "digit 0.1.0-rc.2"
git push origin v0.1.0-rc.2
```

Review the commit first; the commands deliberately do not commit changes or choose a different version for you. Pushing the tag starts the release workflow.

```sh
gh run list --repo ZifferDev/digit --workflow release.yml --limit 5
gh run watch RUN_ID --repo ZifferDev/digit --exit-status
```

A draft may appear while assets are uploaded and checked. Do not manually publish it ahead of the workflow.

## Retry a failed release

After correcting credentials or another external failure, retry from the existing version tag:

```sh
gh workflow run release.yml --repo ZifferDev/digit --ref v0.1.0-rc.2
```

The workflow must exist on the default branch, and the selected tag must exist and be reachable from `main`. If code or assets need changing after publication, create a new version. Do not force-move a published tag or replace immutable release assets.

For a Homebrew-only failure after a stable release was successfully published, retry the dedicated workflow:

```sh
# Replace vX.Y.Z with the existing published stable tag.
gh workflow run homebrew.yml --repo ZifferDev/digit --ref vX.Y.Z
```

This repairs the stable tap publication; it is not a way to promote a prerelease. The fine-grained token must target resource owner `ZifferDev`, only repository `homebrew-tap`, with Contents read/write permission. Supply it as `HOMEBREW_TAP_TOKEN` in the `release` environment and obtain organization approval if required; this credential is pending user setup. SSH deploy keys are disabled by organization policy.

## Check the published result

```sh
gh release view v0.1.0-rc.2 --repo ZifferDev/digit --json tagName,isDraft,isPrerelease,assets
gh api repos/ZifferDev/digit/releases/tags/v0.1.0-rc.2 --jq '{tag_name,draft,prerelease,immutable}'
```

Expect the intended tag, `draft: false`, candidate prerelease status, the complete asset set, and immutability. Check the workflow's Apple notarization and attestation steps, not just the release page.

Download the final release assets into a new directory and verify `SHA256SUMS` using `shasum -a 256 -c SHA256SUMS` on macOS or `sha256sum -c SHA256SUMS` on Linux. Check the downloaded executable's version and exercise the installer against the exact published tag. For a stable release, also verify a fresh Homebrew install or upgrade resolves the new formula.

Developer ID signing and notarization are separate checks. `scripts/sign-macos.sh` verifies the hardened signed executable can run, submits it with `notarytool`, requires `Accepted`, and records the result and log. It does not staple a ticket to the standalone executable: Apple documents that standalone binaries cannot currently have tickets stapled. Gatekeeper retrieves their notarization ticket online. See [Apple's custom notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).

## Local builds

```sh
bun run build
bun run build:all
```

`build` produces the current machine's executable. `build:all` cross-compiles macOS ARM64, Linux ARM64, and Linux x64; it may download Bun target runtimes. Linux binaries target glibc, with the baseline x64 target for wider CPU compatibility. Cross-compilation is not evidence of native execution.

Local and ordinary CI builds do not inherit release signing simply because the signing script exists. The release workflow signs before assembling final checksums and attestation.

## Functional release checks

Use disposable projects and Docker resources. Starting real servers requires your explicit [Minecraft EULA](https://www.minecraft.net/eula) acceptance.

- Exercise guided init in a real terminal, including defaults, searchable experimental versions, OP names, and cancellation. `--yes` must not imply EULA acceptance.
- Check a standalone Paper startup, online authentication configuration, server-list handshake, and world persistence across ordinary `down`/`up`.
- Check a Velocity network with two healthy Paper backends, matching forwarding secrets, private backend ports, compatible plugins, and optional MariaDB authentication/interpolation.
- Run a second isolated environment concurrently where resources permit; verify separate volumes, credentials, and addresses.
- Change a configuration file and a locked plugin selection. Confirm application, readable managed JAR names, and retained plugin data when a plugin is removed.
- Verify effective OP/image options and `digit cmd` on Paper and Velocity.
- Attach with `digit console`, run a command, detach with Ctrl+P then Ctrl+Q, and confirm the server stays running without a restart.
- For a disposable environment, verify the first `down --destroy-all-data` only warns, the confirmed second invocation removes its resources, and another environment remains untouched.

Authenticated player login and travel between backends require separate in-game verification. Record what actually ran in [verification](verification.md) and [live evidence](testing-live.md); never substitute a successful build or status ping for those checks.

## Website installer publication

When website access is available, copy the chosen release's `install.sh` unchanged to `https://ziffer.dev/digit/install.sh`. Compare the deployed bytes or digest with that release asset. There is no website deployment in the current GitHub release pipeline; GitHub asset publication and the future website endpoint are separate operations.
