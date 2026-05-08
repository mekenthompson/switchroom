#!/usr/bin/env bash
# Switchroom static-binary installer.
#
# Detects platform/arch, fetches the matching pre-built `switchroom`
# binary from the latest GitHub release, verifies its SHA256 checksum,
# and installs it to /usr/local/bin (falls back to ~/.local/bin if
# /usr/local/bin is not writable).
#
# Usage:
#   curl -fsSL https://github.com/switchroom/switchroom/raw/main/install.sh | sh
#
# Environment overrides:
#   SWITCHROOM_INSTALL_DIR   target dir (default: /usr/local/bin or ~/.local/bin)
#   SWITCHROOM_VERSION       pin a specific tag (default: latest release)
#
# The binary is self-contained (bun runtime is bundled). You'll still
# need the `claude` CLI installed separately to run agents — see
# https://github.com/switchroom/switchroom for the full setup guide.

set -euo pipefail

REPO="switchroom/switchroom"

BOLD=$(printf '\033[1m')
RED=$(printf '\033[31m')
GREEN=$(printf '\033[32m')
YELLOW=$(printf '\033[33m')
BLUE=$(printf '\033[34m')
RESET=$(printf '\033[0m')

log()  { printf '%s>%s %s\n' "$BLUE" "$RESET" "$1"; }
ok()   { printf '%s+%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()  { printf '%sx%s %s\n' "$RED" "$RESET" "$1" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# ---- platform / arch detection ----

uname_s=$(uname -s)
case "$uname_s" in
  Linux)   platform=linux ;;
  Darwin)  platform=macos ;;
  *)       die "Unsupported OS: $uname_s. Switchroom static binaries ship for Linux and macOS only." ;;
esac

uname_m=$(uname -m)
case "$uname_m" in
  x86_64|amd64)   arch=amd64 ;;
  aarch64|arm64)  arch=arm64 ;;
  *)              die "Unsupported architecture: $uname_m. Switchroom static binaries ship for amd64 and arm64 only." ;;
esac

asset="switchroom-${platform}-${arch}"

log "Detected ${BOLD}${platform}/${arch}${RESET}, will fetch ${BOLD}${asset}${RESET}"

# ---- prerequisites ----

have curl || die "curl is required."

# Either sha256sum (linux) or shasum (macos) works for verification.
if have sha256sum; then
  sha_cmd="sha256sum"
elif have shasum; then
  sha_cmd="shasum -a 256"
else
  die "sha256sum or shasum is required for checksum verification."
fi

# ---- resolve version ----

version="${SWITCHROOM_VERSION:-}"
if [ -z "$version" ]; then
  log "Resolving latest release tag from github.com/${REPO}"
  api_url="https://api.github.com/repos/${REPO}/releases/latest"
  # Grep tag_name out of the JSON without needing jq.
  version=$(curl -fsSL "$api_url" | grep '"tag_name"' | head -n 1 | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
  [ -n "$version" ] || die "Could not determine latest release tag from $api_url."
fi

ok "Version: $version"

# ---- download binary + checksums ----

base_url="https://github.com/${REPO}/releases/download/${version}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

log "Downloading $asset"
curl -fsSL --retry 3 -o "$tmp/$asset" "$base_url/$asset" \
  || die "Failed to download $base_url/$asset (does this release ship static binaries? need v-tag with the release workflow active)."

log "Downloading checksums"
curl -fsSL --retry 3 -o "$tmp/switchroom-checksums.txt" "$base_url/switchroom-checksums.txt" \
  || die "Failed to download $base_url/switchroom-checksums.txt."

# ---- verify checksum ----

log "Verifying SHA256"
expected=$(grep " $asset\$\| ${asset}$" "$tmp/switchroom-checksums.txt" | awk '{print $1}' | head -n 1)
[ -n "$expected" ] || die "No checksum entry for $asset in switchroom-checksums.txt."

actual=$($sha_cmd "$tmp/$asset" | awk '{print $1}')
if [ "$expected" != "$actual" ]; then
  die "Checksum mismatch for $asset. Expected $expected, got $actual."
fi
ok "Checksum verified ($expected)"

chmod +x "$tmp/$asset"

# ---- choose install dir ----

install_dir="${SWITCHROOM_INSTALL_DIR:-}"
if [ -z "$install_dir" ]; then
  if [ -w /usr/local/bin ] || ([ -d /usr/local/bin ] && [ "$(id -u)" -eq 0 ]); then
    install_dir="/usr/local/bin"
  else
    install_dir="$HOME/.local/bin"
    mkdir -p "$install_dir"
    case ":$PATH:" in
      *":$install_dir:"*) ;;
      *) warn "$install_dir is not on your PATH. Add it to your shell profile to run 'switchroom'." ;;
    esac
  fi
fi

target="$install_dir/switchroom"

log "Installing to $target"
if [ -w "$install_dir" ]; then
  mv "$tmp/$asset" "$target"
elif have sudo; then
  warn "$install_dir requires sudo"
  sudo mv "$tmp/$asset" "$target"
else
  die "$install_dir is not writable and sudo not available. Set SWITCHROOM_INSTALL_DIR to a writable directory."
fi

# macOS Gatekeeper: unsigned binaries get the quarantine xattr from curl.
# Strip it so the user doesn't have to right-click > Open the first time.
if [ "$platform" = "macos" ] && have xattr; then
  xattr -d com.apple.quarantine "$target" 2>/dev/null || true
fi

ok "Installed switchroom to $target"

# ---- verify ----

if "$target" version >/dev/null 2>&1; then
  printf '\n%s%sDone.%s ' "$BOLD" "$GREEN" "$RESET"
  "$target" version
else
  warn "Installed but 'switchroom version' did not exit cleanly. Try running it manually."
fi

cat <<'NEXT'

Next:
  switchroom setup            # interactive config + Telegram wiring
  switchroom doctor           # sanity check the environment

Note: the static binary bundles its runtime, but you still need the
`claude` CLI installed (npm i -g @anthropic-ai/claude-code) to run agents.

Docs: https://switchroom.ai
NEXT
