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
# The tarball (if present) is stored as a base64-encoded blob under:
#   clerk-export/_bundle.tar.gz.b64
#
# Why base64 for the tarball: `switchroom vault set --file` reads as
# UTF-8 (src/cli/vault.ts:475), which replaces invalid byte sequences
# with U+FFFD and silently corrupts binary input. Base64 sidesteps
# this entirely. Tracked as a follow-up against the vault CLI; for
# now the script handles binary itself. See PR #1084.
#
# Avoiding repeated passphrase prompts
# ------------------------------------
# Each `switchroom vault {set,get,remove}` opens the vault, which means
# one prompt per file unless the operator either
#
#   (a) exports SWITCHROOM_VAULT_PASSPHRASE before running, OR
#   (b) ensures the vault broker is unlocked (`switchroom vault broker
#       status` exits 0 → unlocked, 1 → locked, 2 → not running).
#
# The script refuses to run if neither is true, surfacing the file
# count up-front so the operator can decide whether to pre-unlock.
#
# Verification
# ------------
# Every write is round-tripped (read back, hashed, compared to source)
# BEFORE the deletion prompt. Any single-file mismatch aborts with the
# offending key and skips deletion entirely. `vault list` proves
# presence; round-trip hashing proves byte fidelity.
#
# Prerequisites
# -------------
#   - switchroom CLI on PATH (`switchroom --version` works)
#   - Vault unlocked via env var OR broker (enforced; see above)
#   - Run from the repo root (where ./clerk-export/ lives)
#
# Usage
# -----
#   ./scripts/migrate-clerk-export-to-vault.sh
#
# Exit codes
# ----------
#   0  success — all files migrated + (optionally) deleted
#   1  precondition failed (missing CLI, missing dir, vault locked,
#      sentinel write/read mismatch, etc.)
#   2  one or more `vault set` or round-trip hash checks failed;
#      nothing deleted
#

set -euo pipefail

# ─── Preconditions ──────────────────────────────────────────────────

EXPORT_DIR="${EXPORT_DIR:-./clerk-export}"
TARBALL="${TARBALL:-./clerk-export-with-secrets.tar.gz}"
KEY_PREFIX="${KEY_PREFIX:-clerk-export}"
BUNDLE_KEY="${KEY_PREFIX}/_bundle.tar.gz.b64"
PROBE_KEY="${KEY_PREFIX}/__migration_probe"

if ! command -v switchroom >/dev/null 2>&1; then
  echo "error: switchroom CLI not found on PATH" >&2
  echo "       install it or add ~/.bun/bin to PATH" >&2
  exit 1
fi

for tool in sha256sum base64; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: required tool '$tool' not found on PATH" >&2
    exit 1
  fi
done

if [ ! -d "$EXPORT_DIR" ] && [ ! -f "$TARBALL" ]; then
  echo "nothing to migrate: neither $EXPORT_DIR nor $TARBALL exists" >&2
  echo "(if you've already migrated, the doctor probe should now pass)" >&2
  exit 0
fi

# ─── Enumerate files (early — so the prompt-count message is accurate) ──

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

# Each file triggers ≥3 vault opens (set + get for verify + final
# remove of the probe doesn't count). Without unlock, that's ≥2×TOTAL
# passphrase prompts — refuse with a clear remedy.
PROMPT_BUDGET=$((TOTAL * 2 + 2))

vault_unlocked=0
if [ -n "${SWITCHROOM_VAULT_PASSPHRASE:-}" ]; then
  vault_unlocked=1
else
  # `switchroom vault broker status` exits 0=unlocked, 1=locked,
  # 2=not running. We only proceed on 0.
  if switchroom vault broker status >/dev/null 2>&1; then
    vault_unlocked=1
  fi
fi

if [ "$vault_unlocked" -ne 1 ]; then
  echo "error: vault is locked and SWITCHROOM_VAULT_PASSPHRASE is not set" >&2
  echo "" >&2
  echo "       This script performs ~${PROMPT_BUDGET} vault operations across" >&2
  echo "       ${TOTAL} item(s) — you would be prompted for the passphrase" >&2
  echo "       on every call. Refusing to run." >&2
  echo "" >&2
  echo "       Pick one before re-running:" >&2
  echo "         (a) export SWITCHROOM_VAULT_PASSPHRASE='...'" >&2
  echo "         (b) switchroom vault broker unlock" >&2
  echo "" >&2
  exit 1
fi

echo "→ vault accessible (broker unlocked or SWITCHROOM_VAULT_PASSPHRASE set)"

# Sentinel probe — `vault list` succeeding doesn't prove the passphrase
# is correct for subsequent writes (an empty/lock-skip vault would
# happily list zero keys). Round-trip a known value through set→get→
# remove so a wrong passphrase or broken broker fails BEFORE we touch
# real data.
echo "→ running sentinel probe at ${PROBE_KEY}..."
SENTINEL_VALUE="migration-probe-$$-$(date +%s)"
if ! printf '%s' "$SENTINEL_VALUE" | switchroom vault set "$PROBE_KEY" >/dev/null; then
  echo "error: sentinel probe write failed — vault may be misconfigured" >&2
  exit 1
fi
PROBE_READ="$(switchroom vault get "$PROBE_KEY" 2>/dev/null || true)"
# `vault get` console.log()s the value with a trailing newline. Strip it.
PROBE_READ="${PROBE_READ%$'\n'}"
if [ "$PROBE_READ" != "$SENTINEL_VALUE" ]; then
  echo "error: sentinel probe round-trip mismatch — refusing to migrate" >&2
  echo "       expected: $SENTINEL_VALUE" >&2
  echo "       got:      $PROBE_READ" >&2
  # Best-effort cleanup of the probe key.
  switchroom vault remove "$PROBE_KEY" >/dev/null 2>&1 || true
  exit 1
fi
if ! switchroom vault remove "$PROBE_KEY" >/dev/null 2>&1; then
  echo "warn: failed to remove sentinel probe ${PROBE_KEY} — please remove manually" >&2
fi
echo "  ✓ sentinel probe round-tripped cleanly"

echo "→ found $TOTAL item(s) to migrate"
echo "    $EXPORT_DIR/: ${#FILES[@]} file(s)"
if [ "$TARBALL_PRESENT" -eq 1 ]; then
  echo "    $TARBALL: 1 tarball"
fi
echo

# ─── Migrate (text via --file, binary via base64) ───────────────────

declare -a KEYS=()
# Parallel array — for each KEYS[i], SOURCES[i] is the on-disk path and
# MODES[i] is "text" or "base64". Used by the verify pass.
declare -a SOURCES=()
declare -a MODES=()
FAILURES=0

migrate_text_file() {
  local path="$1"
  local key="$2"
  echo "  → $key  (text)"
  if switchroom vault set "$key" --file "$path"; then
    KEYS+=("$key")
    SOURCES+=("$path")
    MODES+=("text")
  else
    echo "    ✗ failed to set $key" >&2
    FAILURES=$((FAILURES + 1))
  fi
}

migrate_binary_file() {
  local path="$1"
  local key="$2"
  echo "  → $key  (base64-encoded binary)"
  # Pipe base64 of the file into `vault set` via stdin. The CLI's
  # non-TTY branch (src/cli/vault.ts:481) slurps stdin verbatim, so
  # this preserves the encoded value byte-for-byte.
  if base64 -w0 < "$path" | switchroom vault set "$key" >/dev/null; then
    KEYS+=("$key")
    SOURCES+=("$path")
    MODES+=("base64")
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
  migrate_text_file "$f" "$key"
done

if [ "$TARBALL_PRESENT" -eq 1 ]; then
  migrate_binary_file "$TARBALL" "$BUNDLE_KEY"
fi

echo

if [ "$FAILURES" -ne 0 ]; then
  echo "error: $FAILURES item(s) failed to migrate — nothing deleted" >&2
  echo "       inspect the errors above, fix, re-run" >&2
  exit 2
fi

# ─── Verify: presence + round-trip hash ─────────────────────────────

echo "→ verifying all keys are present in the vault..."
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

echo "→ round-trip hash check (vault get | sha256sum == source sha256sum)..."
MISMATCH=0
for i in "${!KEYS[@]}"; do
  k="${KEYS[$i]}"
  src="${SOURCES[$i]}"
  mode="${MODES[$i]}"

  src_hash="$(sha256sum < "$src" | awk '{print $1}')"

  # `vault get` console.log()s the value + trailing newline; `head -c -1`
  # strips that one byte so the comparison is against the bytes we wrote.
  if [ "$mode" = "text" ]; then
    got_hash="$(switchroom vault get "$k" 2>/dev/null | head -c -1 | sha256sum | awk '{print $1}')"
  else
    # base64 mode: strip trailing newline, base64-decode, then hash.
    got_hash="$(switchroom vault get "$k" 2>/dev/null | head -c -1 | base64 -d | sha256sum | awk '{print $1}')"
  fi

  if [ "$src_hash" != "$got_hash" ]; then
    echo "  ✗ hash mismatch for $k" >&2
    echo "      source:   $src_hash  ($src)" >&2
    echo "      vault:    $got_hash" >&2
    MISMATCH=$((MISMATCH + 1))
  fi
done

if [ "$MISMATCH" -ne 0 ]; then
  echo "error: $MISMATCH key(s) failed round-trip verification — nothing deleted" >&2
  echo "       the on-disk copies remain intact. Inspect the mismatches" >&2
  echo "       (likely a binary-as-text corruption — see PR #1084)." >&2
  exit 2
fi

echo "  ✓ all ${#KEYS[@]} key(s) verified byte-for-byte"
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

# TOCTOU acknowledgement: between the verify pass above and the deletes
# below, an attacker with local write access to $EXPORT_DIR or $TARBALL
# could mutate the on-disk copies — we'd then delete tampered files
# whose contents no longer match what's now in the vault. This is an
# operator-local script run interactively from the repo root; the
# practical risk is negligible. Re-verifying inside the deletion block
# would only narrow, not close, the window. Calling it out so a future
# reader doesn't mistake the gap for an oversight.

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
