#!/bin/sh
# Install an official digit release without sudo or a Bun runtime.
set -eu
LC_ALL=C
export LC_ALL

fail() { printf 'digit installer: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
Usage: install.sh [--version VERSION] [--install-dir DIRECTORY]

Install digit for macOS ARM64 or glibc Linux ARM64/x64.
  --version VERSION        Pin a stable or release-candidate version (optional v prefix).
                           Without this option, install the latest stable GitHub release.
  --install-dir DIRECTORY  Destination for digit (default: $HOME/.local/bin).
  --help                   Show this help.

Set DIGIT_REPOSITORY=OWNER/REPOSITORY to use another release repository.
The installer verifies SHA256SUMS and never invokes sudo. Homebrew installations
must be updated through brew. Existing unrelated files are never overwritten.
HELP
}
version=
install_dir=
explicit_dir=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) [ "$#" -ge 2 ] || fail '--version needs a value'; [ -n "$2" ] || fail '--version must not be empty'; version=$2; shift 2 ;;
    --install-dir) [ "$#" -ge 2 ] || fail '--install-dir needs a value'; install_dir=$2; explicit_dir=true; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument: $1 (use --help)" ;;
  esac
done
repository=${DIGIT_REPOSITORY:-ZifferDev/digit}
case "$repository" in *'
'*) fail 'DIGIT_REPOSITORY must be OWNER/REPOSITORY' ;; esac
printf '%s\n' "$repository" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$' || fail 'DIGIT_REPOSITORY must be OWNER/REPOSITORY'
valid_version() {
  case "$1" in *'
'*) return 1 ;; esac
  printf '%s\n' "$1" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.(0|[1-9][0-9]*))?$'
}
if [ -n "$version" ]; then version=${version#v}; valid_version "$version" || fail 'Invalid version; use a version such as 0.1.0 or 0.1.0-rc.2'; fi
if [ "$explicit_dir" = false ]; then
  [ -n "${HOME:-}" ] || fail 'HOME is unset; specify --install-dir'
  install_dir=$HOME/.local/bin
fi
[ -n "$install_dir" ] || fail '--install-dir must not be empty'
case "$install_dir" in *'
'*) fail 'Installation directory must not contain a newline' ;; esac
[ "$(id -u)" != 0 ] || [ "$explicit_dir" = true ] || fail 'When running as root, specify --install-dir explicitly. sudo is not needed for user installation.'
for tool in curl tar mktemp grep awk chmod mv readlink stat; do command -v "$tool" >/dev/null 2>&1 || fail "Required command is missing: $tool"; done
if command -v sha256sum >/dev/null 2>&1; then checksum_tool=sha256sum
elif command -v shasum >/dev/null 2>&1; then checksum_tool=shasum
else fail 'Install sha256sum or shasum to verify the release checksum'; fi
case "$(uname -s)" in
  Darwin) os=darwin; case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; *) fail 'macOS requires an Apple Silicon (ARM64) machine' ;; esac ;;
  Linux)
    os=linux
    case "$(uname -m)" in aarch64|arm64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) fail 'Linux requires ARM64 or x64' ;; esac
    libc=$(getconf GNU_LIBC_VERSION 2>/dev/null || true)
    case "$libc" in glibc\ *) ;; *)
      libc=$(ldd --version 2>&1 || true)
      printf '%s\n' "$libc" | grep -Eqi 'musl' && fail 'musl Linux is not supported; use a glibc distribution'
      printf '%s\n' "$libc" | grep -Eqi 'glibc|GNU libc|GNU C Library' || fail 'Could not verify glibc; musl Linux is not supported'
      ;; esac ;;
  *) fail 'Supported platforms: macOS ARM64, glibc Linux ARM64/x64' ;;
esac
# Canonicalize links, including relative links, without requiring GNU readlink -f.
resolve_path() {
  p=$1
  case "$p" in /*) ;; *) p=$PWD/$p ;; esac
  count=0
  while [ -L "$p" ]; do
    count=$((count + 1)); [ "$count" -le 40 ] || fail 'Too many symbolic links in digit path'
    link=$(readlink "$p") || fail "Cannot read symbolic link: $p"
    case "$link" in /*) p=$link ;; *) p=$(dirname "$p")/$link ;; esac
  done
  parent=$(dirname "$p")
  if [ -d "$parent" ]; then parent=$(CDPATH='' cd -P "$parent" && pwd -P) || fail 'Cannot resolve destination'; p=$parent/$(basename "$p"); fi
  printf '%s\n' "$p"
}
brew_prefix=
if command -v brew >/dev/null 2>&1; then brew_prefix=$(brew --prefix 2>/dev/null || true); fi
reject_brew() {
  candidate=$(resolve_path "$1")
  case "$candidate" in */Cellar/digit/*|*/opt/digit/*|/opt/homebrew/*|/home/linuxbrew/.linuxbrew/*) fail 'digit is managed by Homebrew; use brew upgrade digit instead' ;; esac
  if [ -n "$brew_prefix" ]; then case "$candidate" in "$brew_prefix"/*) fail 'Refusing to install or shadow a Homebrew-managed digit; use brew upgrade digit' ;; esac; fi
}
active=$(command -v digit 2>/dev/null || true)
[ -z "$active" ] || reject_brew "$active"
case "$install_dir" in /*) ;; *) install_dir=$PWD/$install_dir ;; esac
destination=$install_dir/digit
reject_brew "$destination"
if [ -e "$destination" ] || [ -L "$destination" ]; then
  [ ! -L "$destination" ] || fail 'Refusing to replace a symlink; manage its installation at the original location'
  [ -f "$destination" ] && [ -x "$destination" ] || fail 'Destination exists and is not an executable digit file'
  owner=$(stat -c '%u' "$destination" 2>/dev/null) || owner=$(stat -f '%u' "$destination" 2>/dev/null) || fail 'Cannot determine existing executable ownership'
  [ "$owner" = "$(id -u)" ] || fail 'Existing digit is owned by another user'
  previous=$("$destination" --version 2>/dev/null) || fail 'Existing destination does not identify as digit; refusing to overwrite it'
  valid_version "${previous#v}" || fail 'Existing destination does not identify as digit; refusing to overwrite it'
  previous_help=$("$destination" --help 2>/dev/null) || fail 'Existing destination does not identify as digit; refusing to overwrite it'
  printf '%s\n' "$previous_help" | grep -Eq '^Usage: digit([[:space:]]|$)' || fail 'Existing destination does not identify as digit; refusing to overwrite it'
fi
work=$(mktemp -d "${TMPDIR:-/tmp}/digit-install.XXXXXXXX") || fail 'Cannot create a temporary directory'
staged=
cleanup() { [ -z "$staged" ] || rm -f "$staged"; rm -rf "$work"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
fetch() { curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 300 "$@"; }
if [ -z "$version" ]; then
  latest=$(fetch --output /dev/null --write-out '%{url_effective}' "https://github.com/$repository/releases/latest") || fail 'Could not resolve the latest stable release; use --version to pin a published release'
  prefix=https://github.com/$repository/releases/tag/
  case "$latest" in "$prefix"*) version=${latest#"$prefix"}; version=${version#v} ;; *) fail 'GitHub returned an unexpected latest-release URL' ;; esac
  valid_version "$version" || fail 'GitHub returned an invalid release version'
  case "$version" in *-*) fail 'Latest release is not stable; select a release candidate explicitly with --version' ;; esac
fi
asset=digit-$version-$os-$arch.tar.gz
base=https://github.com/$repository/releases/download/v$version
printf 'Installing digit %s for %s/%s…\n' "$version" "$os" "$arch"
fetch --output "$work/$asset" "$base/$asset" || fail 'Release download failed; existing installation was not changed'
fetch --output "$work/SHA256SUMS" "$base/SHA256SUMS" || fail 'Checksum download failed; existing installation was not changed'
# Match the complete asset name, and reject duplicate or malformed checksum records.
expected=$(awk -v wanted="$asset" '$2 == wanted || $2 == "*" wanted { count++; value=$1 } END { if (count != 1) exit 1; print value }' "$work/SHA256SUMS") || fail 'SHA256SUMS must contain exactly one record for this release asset'
printf '%s\n' "$expected" | grep -Eq '^[a-fA-F0-9]{64}$' || fail 'Invalid SHA256SUMS entry'
if [ "$checksum_tool" = sha256sum ]; then actual=$(sha256sum "$work/$asset") || fail 'Checksum calculation failed'
else actual=$(shasum -a 256 "$work/$asset") || fail 'Checksum calculation failed'; fi
actual=${actual%% *}
expected=$(printf '%s' "$expected" | tr 'A-F' 'a-f')
[ "$actual" = "$expected" ] || fail 'Checksum mismatch; existing installation was not changed'
tar -tzf "$work/$asset" > "$work/members" || fail 'Invalid release archive'
binary_member=
while IFS= read -r member; do
  normalized=${member#./}
  case "$normalized" in
    digit) [ -z "$binary_member" ] || fail 'Archive contains duplicate digit binaries'; binary_member=$member ;;
    LICENSE|completions|completions/|completions/digit.bash|completions/_digit|completions/digit.fish|.|'') ;;
    *) fail "Unexpected archive member: $member" ;;
  esac
done < "$work/members"
[ -n "$binary_member" ] || fail 'Archive does not contain digit'
tar -tvzf "$work/$asset" "$binary_member" > "$work/binary-info" || fail 'Cannot inspect archived binary'
[ "$(awk 'END {print NR}' "$work/binary-info")" = 1 ] || fail 'Archive contains ambiguous digit binary entries'
case "$(cat "$work/binary-info")" in -*) ;; *) fail 'Archived digit must be a regular file, not a link' ;; esac
# Extract only this regular file to stdout. Never unpack arbitrary archive paths.
tar -xOzf "$work/$asset" "$binary_member" > "$work/digit" || fail 'Could not extract digit'
[ -s "$work/digit" ] || fail 'Release binary is empty'
chmod 755 "$work/digit" || fail 'Cannot set executable permissions'
reported=$("$work/digit" --version) || fail 'Downloaded digit cannot run on this machine'
[ "${reported#v}" = "$version" ] || fail 'Downloaded binary version does not match the requested release'
mkdir -p "$install_dir" || fail "Cannot create $install_dir; choose a writable --install-dir (no sudo needed)"
# Stage on the destination filesystem so replacement is atomic and failures preserve the old binary.
staged=$(mktemp "$install_dir/.digit-install.XXXXXXXX") || fail 'Cannot create a file in the installation directory'
cat "$work/digit" > "$staged" || fail 'Cannot stage the executable'
chmod 755 "$staged" || fail 'Cannot set executable permissions'
mv -f "$staged" "$destination" || fail 'Cannot install digit; existing installation was not changed'
staged=
printf 'Installed digit %s at %s\n' "$version" "$destination"
printf 'Ensure %s is on PATH. Start with: digit init\n' "$install_dir"
printf 'Shell completion: source <(digit complete zsh)  # or bash; fish: digit complete fish | source\n'
