# RFC A: Bot token to vault

Status: Draft v1
Author: klanker (sub-agent draft)
Date: 2026-05-06

## 1. Summary

Today the Telegram bot token sits on disk in plaintext where any process running as the user (`kenthompson`) can read it. That includes every agent. An agent that reads the token can post messages and approval cards as the bot, intercept callbacks, and impersonate the gateway to the user. This RFC moves the token into the existing vault under a slot that only `switchroom-gateway.service` is granted access to, with the gateway reading it via the broker on boot.

This is a real, current security gap, independent of the approval kernel work. It ships first.

## 2. Motivation

Per `docs/vault.md:227`, the vault ACL is "misconfiguration protection, not a security boundary" — the real boundary is the vault passphrase and the filesystem permissions on `vault.enc` (`0600`). Plaintext-on-disk for the bot token offers neither of those protections. Any agent process can `cat` the file. Once an agent has the token, the trust chain that the kernel (RFC B) and existing surfaces depend on collapses — a malicious agent can post a fake "Allow this scary thing?" card and the user has no way to tell it from a legitimate one.

The fix is mechanical: the vault already exists, the broker already exists, and `src/vault/auto-unlock.ts` already handles the chicken-and-egg of decrypting the vault before the gateway has its config. The token just needs to live there instead of on disk.

## 3. Design

- New vault slot, e.g. `telegram:bot_token`. ACL: only `switchroom-gateway.service` may read it.
- On gateway startup, the gateway reads the token from the vault via the broker IPC (same path the gateway already uses to read other secrets).
- The vault is unlocked at boot via the existing auto-unlock mechanism in `src/vault/auto-unlock.ts` — machine-bound encryption of the vault passphrase, decrypted at boot using `/etc/machine-id` plus per-user state. No new unlock path.
- If auto-unlock is not enabled on this machine, gateway start fails fast with: `vault locked, run "switchroom vault unlock" or enable auto-unlock with "switchroom vault broker enable-auto-unlock"`. Actionable error, no silent boot loop.
- Other agents are NOT granted the slot. An agent attempting to read it gets a vault `denied` response and an audit row.

## 4. Migration steps

The cutover has three failure modes; spec each.

1. **Atomic move sequence.**
   - Read token from current filesystem location.
   - Write to vault slot; verify by reading it back via the broker.
   - Restart the gateway with vault-backed token loading; verify it can post a smoke message to the operator.
   - **Only after the smoke succeeds**, `shred -u` the old file.

2. **Gateway config change.** The gateway's token-loading code switches from "read file" to "ask broker for slot." This is a single call site in the boot path.

3. **Smoke verification.** A post-boot self-check posts a one-line "bot token migration complete" DM to the operator. Migration is considered successful only after this lands.

## 5. Rollback plan

- **Vault-write fails** → abort; token still on disk; no change. Operator inspects vault state and retries.
- **Vault-read after write fails** (corruption, key-derivation glitch) → restore old file from backup taken before the migration; the gateway continues to read from disk; operator re-runs once vault is healthy.
- **Smoke message fails** → restore old file from backup; revert gateway config.
- **`shred` fails** (filesystem doesn't support secure delete, e.g. btrfs CoW) → log loudly and continue. Token now exists in two places — **SECURITY incident**, requires immediate token rotation through the standalone `switchroom token rotate` recovery command (which calls Telegram's `revokeToken`, mints a fresh one, writes to the vault slot, and SIGHUPs the gateway).

The pre-migration backup is taken automatically by the migration command and kept under a clearly-labeled path until the operator runs `switchroom token migration confirm` (or 7 days elapse).

## 6. Effort

~0.5 day. This is a small, mechanical change leveraging machinery that already exists.

## 7. Out of scope

- Wider secret inventory (other long-lived API tokens currently on disk). Each is its own small migration; they can follow the same pattern after this one proves out.
- The approval kernel itself — see RFC B.
