#!/usr/bin/env bash
#
# migrate-clerk-export-to-vault.sh — one-shot operator script for #1072.
#
# Moves the contents of ./clerk-export/ (and the sealed bundle
# ./clerk-export-with-secrets.tar.gz, if present) into the switchroom
# vault, then offers to delete the on-disk copies.
#
# Why this script exists
# ----------------------
# The OpenClaw export bundle carries real secrets and has been sitting
# in the repo root since the initial migration. It's gitignored, so it
# can never be committed — but it's still readable by any backup tool,
# grep, file-share workflow, or "upload my repo" agent that scans the
# tree. The fix is to migrate the contents into the vault (encrypted at
# rest, gated by passphrase + broker ACL) and delete the on-disk copy.
#
# The PR that adds this script does NOT delete anything. The operator
# (you) runs the script when ready, on the host that owns the vault.
#
# Vault key scheme
# ----------------
#   clerk-export/<relative-path-with-slashes-preserved>
#
# e.g. clerk-export/credentials/files/notion-token
#      clerk-export/config/secrets.json
#      clerk-export/identity/USER.md
#
# The tarball (if present) is stored as a single binary blob under:
#   clerk-export/_bundle.tar.gz
#
# Prerequisites
# -------------
#   - switchroom CLI on PATH (`switchroom --version` works)
#   - Vault unlocked (`switchroom vault list` returns without
#     prompting, OR you're prepared to type the passphrase once)
#   - Run from the repo root (where ./clerk-export/ lives)
#
# Usage
# -----
#   ./scripts/migrate-clerk-export-to-vault.sh
#
# Exit codes
# ----------
#   0  success — all files migrated + (optionally) deleted
#   1  precondition failed (missing CLI, missing dir, vault locked)
#   2  one or more `vault set` calls failed; nothing deleted
#

set -euo pipefail

# ─── Preconditions ──────────────────────────────────────────────────

EXPORT_DIR="${EXPORT_DIR:-./clerk-export}"
TARBALL="${TARBALL:-./clerk-export-with-secrets.tar.gz}"
KEY_PREFIX="${KEY_PREFIX:-clerk-export}"

if ! command -v switchroom >/dev/null 2>&1; then
  echo "error: switchroom CLI not found on PATH" >&2
  echo "       install it or add ~/.bun/bin to PATH" >&2
  exit 1
fi

if [ ! -d "$EXPORT_DIR" ] && [ ! -f "$TARBALL" ]; then
  echo "nothing to migrate: neither $EXPORT_DIR nor $TARBALL exists" >&2
  echo "(if you've already migrated, the doctor probe should now pass)" >&2
  exit 0
fi

# Probe vault — `vault list` is the cheapest way to confirm the vault
# is reachable and unlocked. We discard output but capture the exit.
echo "→ probing vault (this may prompt for passphrase)..."
if ! switchroom vault list >/dev/null; then
  echo "error: 'switchroom vault list' failed — vault locked or misconfigured" >&2
  echo "       unlock with 'switchroom vault broker unlock' first" >&2
  exit 1
fi
echo "  ✓ vault reachable"

# ─── Enumerate files ────────────────────────────────────────────────

declare -a FILES=()
if [ -d "$EXPORT_DIR" ]; then
  # -print0 / read -d '' so paths with spaces or newlines survive.
  while IFS= read -r -d '' f; do
    FILES+=("$f")
  done < <(find "$EXPORT_DIR" -type f -print0)
fi

TARBALL_PRESENT=0
if [ -f "$TARBALL" ]; then
  TARBALL_PRESENT=1
fi

TOTAL=$((${#FILES[@]} + TARBALL_PRESENT))
if [ "$TOTAL" -eq 0 ]; then
  echo "nothing to migrate: $EXPORT_DIR is empty and no tarball"
  exit 0
fi

echo "→ found $TOTAL item(s) to migrate"
echo "    $EXPORT_DIR/: ${#FILES[@]} file(s)"
if [ "$TARBALL_PRESENT" -eq 1 ]; then
  echo "    $TARBALL: 1 tarball"
fi
echo

# ─── Migrate ────────────────────────────────────────────────────────

declare -a KEYS=()
FAILURES=0

migrate_file() {
  local path="$1"
  local key="$2"
  echo "  → $key"
  if switchroom vault set "$key" --file "$path"; then
    KEYS+=("$key")
  else
    echo "    ✗ failed to set $key" >&2
    FAILURES=$((FAILURES + 1))
  fi
}

for f in "${FILES[@]}"; do
  # Strip the leading "./clerk-export/" — but keep the bundle prefix
  # in the vault key. e.g. ./clerk-export/credentials/foo →
  # clerk-export/credentials/foo
  rel="${f#"$EXPORT_DIR"/}"
  key="$KEY_PREFIX/$rel"
  migrate_file "$f" "$key"
done

if [ "$TARBALL_PRESENT" -eq 1 ]; then
  migrate_file "$TARBALL" "$KEY_PREFIX/_bundle.tar.gz"
fi

echo

# ─── Verify ─────────────────────────────────────────────────────────

if [ "$FAILURES" -ne 0 ]; then
  echo "error: $FAILURES item(s) failed to migrate — nothing deleted" >&2
  echo "       inspect the errors above, fix, re-run" >&2
  exit 2
fi

echo "→ verifying all keys are present in the vault..."
# `vault list` is line-per-key; grep -Fx for exact match per key.
LIVE_KEYS="$(switchroom vault list)"
MISSING=0
for k in "${KEYS[@]}"; do
  if ! printf '%s\n' "$LIVE_KEYS" | grep -Fxq "$k"; then
    echo "  ✗ missing from vault: $k" >&2
    MISSING=$((MISSING + 1))
  fi
done

if [ "$MISSING" -ne 0 ]; then
  echo "error: $MISSING key(s) missing from vault list — nothing deleted" >&2
  exit 2
fi

echo "  ✓ all ${#KEYS[@]} key(s) present"
echo

# ─── Delete on-disk copies (prompted) ───────────────────────────────

echo "All ${#KEYS[@]} item(s) migrated to vault under prefix '$KEY_PREFIX/'."
printf "Delete on-disk copies (%s and %s)? [y/N] " "$EXPORT_DIR" "$TARBALL"
read -r REPLY
case "$REPLY" in
  [yY]|[yY][eE][sS])
    ;;
  *)
    echo "skipped deletion — on-disk copies remain at:"
    [ -d "$EXPORT_DIR" ] && echo "    $EXPORT_DIR"
    [ -f "$TARBALL" ]    && echo "    $TARBALL"
    echo "(re-run this script or remove them manually when ready)"
    exit 0
    ;;
esac

# Prefer `trash` (recoverable) over `rm` (irrecoverable) when available.
if command -v trash >/dev/null 2>&1; then
  RM="trash"
else
  RM="rm -rf"
fi

if [ -d "$EXPORT_DIR" ]; then
  echo "  → $RM $EXPORT_DIR"
  $RM "$EXPORT_DIR"
fi
if [ -f "$TARBALL" ]; then
  echo "  → $RM $TARBALL"
  $RM "$TARBALL"
fi

echo
echo "✓ migration complete. 'switchroom doctor' should now show repo hygiene OK."
