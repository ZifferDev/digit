#!/usr/bin/env bash
set -euo pipefail
: "${GITHUB_REF_TYPE:?Run from a version tag}"
: "${GITHUB_REF_NAME:?Run from a version tag}"
: "${GITHUB_REPOSITORY:?Set the source repository}"
: "${HOMEBREW_TAP_TOKEN:?Add a tap-only token to the release environment}"
test "$GITHUB_REF_TYPE" = tag
bun scripts/release.ts validate --tag "$GITHUB_REF_NAME" --repository "$GITHUB_REPOSITORY" > /dev/null
release=$(gh api "repos/$GITHUB_REPOSITORY/releases/tags/$GITHUB_REF_NAME")
printf '%s' "$release" | jq -e '.draft == false and .prerelease == false and .immutable == true' > /dev/null
latest=$(gh api "repos/$GITHUB_REPOSITORY/releases/latest" --jq .tag_name)
if [ "$latest" != "$GITHUB_REF_NAME" ]; then
  echo 'This is not the latest stable release; leaving the Homebrew package unchanged.'
  exit 0
fi
work=$(mktemp -d)
cleanup() { rm -rf "$work"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p "$work/release"
gh release download "$GITHUB_REF_NAME" --repo "$GITHUB_REPOSITORY" --dir "$work/release" \
  --pattern '*.tar.gz' --pattern 'release-metadata.json' --pattern 'install.sh' --pattern 'SHA256SUMS'
(cd "$work/release" && sha256sum -c SHA256SUMS)
gh release verify "$GITHUB_REF_NAME" --repo "$GITHUB_REPOSITORY"
gh release verify-asset "$GITHUB_REF_NAME" "$work/release/release-metadata.json" --repo "$GITHUB_REPOSITORY"
bun scripts/release.ts formula --metadata "$work/release/release-metadata.json" --output "$work/digit.rb"
ruby -c "$work/digit.rb"
bun scripts/update-tap.ts "$work/digit.rb"
