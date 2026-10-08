# First release setup

[Documentation](README.md) · Next: [Release operations](releasing.md)

This is the maintainer setup for public releases from [ZifferDev/digit](https://github.com/ZifferDev/digit) and the [ZifferDev Homebrew tap](https://github.com/ZifferDev/homebrew-tap). The code is MIT-licensed.

**Current status:** `0.1.0-rc.2` is a release candidate. This guide does not establish that Apple signing, notarization, or a public release has succeeded. Complete the steps below, then inspect the actual workflow run. Do not publish `0.1.0` as stable while the candidate's manual testing is still pending.

## What you need to supply

Add the six Apple secrets listed below to the `release` GitHub environment in `ZifferDev/digit`. Do not send certificates, private keys, account passwords, or secret values through chat or commit them to Git.

Repository setup handles release immutability and the environment's `v*` tag-only access policy. The organization rejects SSH deploy keys, so Homebrew publication currently requires a fine-grained token scoped only to `ZifferDev/homebrew-tap`. That credential is pending until you supply `HOMEBREW_TAP_TOKEN` in the same environment and obtain any required organization approval; see step 4.

## 1. Obtain a Developer ID Application identity

An **Apple Development** identity cannot sign this distribution. You need **Developer ID Application**, with its corresponding private key. **Developer ID Installer** is for installer packages and is not the certificate used by digit's standalone binary.

In your Apple Developer account, open Certificates, Identifiers & Profiles, add a certificate, and choose Developer ID Application. Follow the certificate-signing-request process on the Mac that will hold the private key. Download the issued `.cer` and open it to install it. Apple documents this under [Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/); creating the exportable certificate through that account flow requires the Account Holder role.

In Keychain Access, look under **My Certificates**. Expand the new `Developer ID Application: …` entry and confirm that a private key appears underneath it. A downloaded `.cer` alone is insufficient.

Export the complete identity as a password-protected `.p12`, for example `digit-developer-id.p12`, outside the repository. Choose a strong export password and retain it in your password manager. If `.p12` export is unavailable, the private key may be missing. Apple's [signing identity export guide](https://developer.apple.com/documentation/Xcode/sharing-your-teams-signing-certificates) also describes exporting a PKCS#12 identity through Xcode and recovering a missing key from its original creator.

To see the exact signing identity name without exporting secrets:

```sh
security find-identity -v -p codesigning
```

Copy the complete quoted name beginning `Developer ID Application:`, including its team suffix. That name is `APPLE_SIGNING_IDENTITY`. The certificate's team must match `APPLE_TEAM_ID` below.

## 2. Prepare notarization credentials

Use an Apple account with access to the same Developer team. Record its Apple ID email and team ID, then create an app-specific password named something recognizable such as `digit GitHub releases`.

At [account.apple.com](https://account.apple.com/), open Sign-In and Security → App-Specific Passwords. Two-factor authentication must be enabled. Supply the generated app-specific password, not your normal Apple account password. See [Apple's password instructions](https://support.apple.com/en-us/102654).

## 3. Store six environment secrets

In [repository environment settings](https://github.com/ZifferDev/digit/settings/environments), open **release** and add these environment secrets:

| Secret                         | Value                                                             |
| ------------------------------ | ----------------------------------------------------------------- |
| `APPLE_CERTIFICATE_P12_BASE64` | Base64 encoding of the exported `.p12`, including its private key |
| `APPLE_CERTIFICATE_PASSWORD`   | Password you chose when exporting that `.p12`                     |
| `APPLE_SIGNING_IDENTITY`       | Exact `Developer ID Application: … (TEAMID)` identity name        |
| `APPLE_ID`                     | Apple account email used for notarization                         |
| `APPLE_TEAM_ID`                | Apple Developer team ID matching the signing identity             |
| `APPLE_APP_SPECIFIC_PASSWORD`  | Generated Apple app-specific password                             |

You can use GitHub's UI or the GitHub CLI. First confirm the CLI account has access to the repository:

```sh
gh auth status
```

Send the certificate directly from its file to GitHub without printing its encoded contents. Replace the example path with your exported identity:

```sh
base64 < "$HOME/Downloads/digit-developer-id.p12" | tr -d '\n' |
  gh secret set APPLE_CERTIFICATE_P12_BASE64 --env release --repo ZifferDev/digit
```

For the remaining values, run each command and enter the value at its interactive prompt. Keeping the value out of the command itself avoids placing it in shell history:

```sh
gh secret set APPLE_CERTIFICATE_PASSWORD --env release --repo ZifferDev/digit
gh secret set APPLE_SIGNING_IDENTITY --env release --repo ZifferDev/digit
gh secret set APPLE_ID --env release --repo ZifferDev/digit
gh secret set APPLE_TEAM_ID --env release --repo ZifferDev/digit
gh secret set APPLE_APP_SPECIFIC_PASSWORD --env release --repo ZifferDev/digit
```

If you already keep one value in a private local file, standard input works too:

```sh
gh secret set APPLE_TEAM_ID --env release --repo ZifferDev/digit < /private/path/team-id.txt
```

The commands store environment secrets, not repository-level secrets. Do not enable shell tracing while handling them. Keep the `.p12` and its password in secure backup outside the repository.

Check names and timestamps, without reading secret values:

```sh
gh secret list --env release --repo ZifferDev/digit
```

The six Apple names should be present. The tap credential below is separate and is needed before a stable Homebrew publication.

## 4. Supply the Homebrew tap token

Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) with these settings:

- Resource owner: **ZifferDev**.
- Repository access: **Only select repositories**, selecting **homebrew-tap** only.
- Repository permissions: **Contents — Read and write**. Metadata read access is implicit.
- Expiration: choose an appropriate limited lifetime and record when it must be renewed.

Do not give this token access to all repositories, organization administration, or unrelated permissions. The token creator must already have the required access to the tap. If ZifferDev requires token approval, an organization owner must approve it before the workflow can publish. See [GitHub's organization token policy](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization).

Store the generated value at the interactive prompt, without putting it in the shell command or chat:

```sh
gh secret set HOMEBREW_TAP_TOKEN --env release --repo ZifferDev/digit
```

Then check that the secret name exists with `gh secret list --env release --repo ZifferDev/digit`. A listed secret does not prove the token is approved or has the right permissions. Until the value is supplied and usable, the stable tap publication remains unconfigured. Renew or replace the secret before its token expires.

## 5. Run the candidate release

The workflow files must already be on `main`. The version tag must exist and point to a commit reachable from `main`; package/source versions must agree with the tag.

If the candidate tag has already been pushed, trigger a retry using that exact ref:

```sh
gh workflow run release.yml --repo ZifferDev/digit --ref v0.1.0-rc.2
gh run list --repo ZifferDev/digit --workflow release.yml --limit 5
```

Then watch the returned run ID:

```sh
gh run watch RUN_ID --repo ZifferDev/digit --exit-status
```

If the tag does not exist, follow [release operations](releasing.md#start-a-release) to create it from the reviewed commit. Do not retag an existing published version to different code.

Success requires passing checks, three native builds, Developer ID signing, Apple's `Accepted` notarization result, attestation and asset verification, and publication. A workflow merely starting or producing a CI artifact is not release success. Release candidates remain prereleases and do not update the stable Homebrew formula.

## Common setup failures

| Failure                                 | What to check                                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| No signing identity found               | The `.p12` contains the private key, its export password matches, and the exact Developer ID Application name is configured    |
| Wrong certificate type                  | Replace Apple Development/Developer ID Installer with Developer ID Application                                                 |
| Apple authentication fails              | Team ID and Apple account access match; the app-specific password is current                                                   |
| Notarization is rejected                | Read the workflow's notary result/log and fix the reported issue; do not publish an unsigned substitute                        |
| Environment blocks the job              | Run from the intended `v*` version tag, not `main`; verify the tag points to reviewed main history                             |
| Tap update fails after a stable release | Check the tap token, expiry, repository scope, and organization approval; then retry the Homebrew workflow for that stable tag |

Changing your primary Apple account password revokes existing app-specific passwords, so regenerate and replace the notarization secret if necessary. [Apple explains this revocation behavior](https://support.apple.com/en-us/102654).

## Website installer later

No website deployment is included in this setup. Once website hosting is available, serve the release's `install.sh` **byte for byte** at `https://ziffer.dev/digit/install.sh`. Do not maintain a separate edited installer at that URL.

The first website deployment needs access to that hosting project. Until it exists, use the GitHub release installer URLs in [installation](installation.md). Publishing a GitHub release does not automatically make the website URL live.
