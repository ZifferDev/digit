#!/usr/bin/env bash
# Run only on an ephemeral macOS release runner. Never enable shell tracing here.
set -euo pipefail

: "${APPLE_CERTIFICATE_P12_BASE64:?Set this secret in the release environment}"
: "${APPLE_CERTIFICATE_PASSWORD:?Set this secret in the release environment}"
: "${APPLE_SIGNING_IDENTITY:?Set the Developer ID Application identity}"
: "${APPLE_ID:?Set the Apple account used for notarization}"
: "${APPLE_TEAM_ID:?Set the Apple Developer team ID}"
: "${APPLE_APP_SPECIFIC_PASSWORD:?Set an Apple app-specific password}"
: "${RUNNER_TEMP:?This script requires an ephemeral GitHub Actions runner}"

case "$APPLE_SIGNING_IDENTITY" in
  "Developer ID Application: "*) ;;
  *) echo 'A Developer ID Application certificate is required, not Apple Development.' >&2; exit 1 ;;
esac

binary=${1:-dist/digit}
test -f "$binary"
signing_dir=$(mktemp -d "$RUNNER_TEMP/digit-signing.XXXXXX")
chmod 700 "$signing_dir"
keychain="$signing_dir/signing.keychain-db"
keychain_password=$(openssl rand -hex 32)
cleanup() {
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$signing_dir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s' "$APPLE_CERTIFICATE_P12_BASE64" | base64 --decode > "$signing_dir/certificate.p12"
security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 7200 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"
security import "$signing_dir/certificate.p12" -k "$keychain" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple: -k "$keychain_password" "$keychain" >/dev/null

codesign --force --options runtime --timestamp --identifier dev.ziffer.digit \
  --entitlements scripts/macos-entitlements.plist --keychain "$keychain" \
  --sign "$APPLE_SIGNING_IDENTITY" "$binary"
codesign --verify --strict --verbose=2 "$binary"
# Verify the actual hardened executable can run before submission.
"$binary" --version
"$binary" console --help >/dev/null
ditto -c -k --keepParent "$binary" "$signing_dir/digit.zip"
mkdir -p dist/notarization
xcrun notarytool submit "$signing_dir/digit.zip" \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --wait --timeout 30m --output-format json > dist/notarization/result.json
jq -e '.status == "Accepted"' dist/notarization/result.json >/dev/null
submission_id=$(jq -r .id dist/notarization/result.json)
xcrun notarytool log "$submission_id" \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  dist/notarization/log.json
# Standalone Mach-O binaries cannot have tickets stapled; Apple records the signed code hash.
codesign --verify --strict "$binary"
echo 'Developer ID signing and Apple notarization succeeded.'
