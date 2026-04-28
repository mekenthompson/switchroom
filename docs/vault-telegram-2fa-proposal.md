# Telegram-as-2FA for Vault Unlock: Design Proposal

## 1. Threat Model

### Current Passphrase Model
The existing vault security rests on a single factor: the operator knows a strong passphrase. Attack surface:

- **Shoulder-surfing / scrollback capture**: Passphrase was visible on terminal before #160; now masked, but still a single factor.
- **Breakage/friction**: Operators who forget the passphrase must perform key rotation (re-encrypt entire vault with new passphrase). This friction may incentivize weak passphrases or note-taking (both worse).
- **Host compromise (non-root)**: A process running as the same user (but outside switchroom cgroups) can read `~/.switchroom/vault.enc` and attempt offline brute-force. The scrypt KDF (N=32768, ~100ms) adds cost, but does not prevent determined offline attacks.
- **Broker memory read**: If an attacker gains root or debugger access post-unlock, the plaintext vault in broker memory is exposed for the unlocked duration (default: 1 hour TTL).

### Proposed Telegram 2FA Model
**What it protects against:**
- **Keyboard sniffing / scrollback**: No passphrase is entered on the terminal. Reduces shoulder-surf and scrollback risk to keystroke-logger level.
- **Operator availability friction**: Operators don't memorize a second factor — they tap "Approve" on a device they already use. Reduces incentive for weak passphrases.
- **Phishing**: The approval is bound to the operator's Telegram account (which runs on a separate device). Hijacking the terminal does not grant unlock ability.

**What it does NOT protect against:**
- **Host compromise (root)**: Root can still read vault.enc, intercept unlock RPCs, or extract any device-bound secret stored on the host. Root is root.
- **Hijacked Telegram account**: If the operator's Telegram session is compromised (stolen phone, token-dumped), the attacker can approve unlocks. The 2FA only helps if Telegram is harder to compromise than the terminal user account.
- **OS-level keyring exfiltration** (if using libsecret/Keychain): Many OS keyrings are readable by processes running as the same user if they trick the keyring daemon into trusting them. This is not a strong boundary against non-root privilege escalation.
- **Supply-chain attacks**: If grammy (the Telegram bot library) or switchroom itself is compromised, the approval mechanism is broken. Same as today's passphrase entry.
- **Operator fatigue / approval without attention**: If the operator routinely approves Telegram prompts without reading, the 2FA becomes security theater. Mitigated by UX design (explicit action required, not a default button).

### Comparison: Passphrase vs. Telegram 2FA
| Attack | Passphrase | Telegram 2FA | Winner |
|--------|-----------|-------------|--------|
| Scrollback capture | Vulnerable (pre-#160) / Mitigated (post-#160) | Invulnerable | Telegram |
| Shoulder-surf | Mitigated by masking | Invulnerable (phone screen) | Telegram |
| User fatigue / weak choice | Passphrase entropy is operator-dependent | Operator just taps; no entropy concern | Telegram |
| Terminal hijacking (non-root) | Compromised | Uncompromised (separate device) | Telegram |
| Root compromise | Compromised | Compromised | Tie |
| Telegram compromise | Unaffected | Compromised | Passphrase |
| Offline brute-force of stored secret | Passphrase requires scrypt; device-bound secret TBD | Device-bound secret depends on storage choice | Variable |

**Net effect**: Telegram 2FA is stronger against interactive/passive attacks (user-facing terminal threats) and device-local threats, but introduces a dependency on Telegram security. For operators already trusting Telegram to run agents (the entire switchroom premise), this is a reasonable exchange.

---

## 2. Cryptographic Design

### Goal
Replace passphrase entry with Telegram approval. The operator has stored a device-bound secret (DBS) on the host that the broker uses to unlock without re-prompting. The secret must:
1. Be unreadable without the operator's Telegram session.
2. Resist exfiltration if the host is compromised (non-root).
3. Support recovery/re-binding if the operator changes devices or loses access.

### Candidate Storage Mechanisms

#### Option A: File at known path (e.g., `~/.config/credstore.encrypted/vault-passphrase`)
**Design**: Store the vault passphrase encrypted with a host-local random key. On first unlock, the broker:
1. Reads the encrypted blob from disk.
2. Decrypts it to get the vault passphrase.
3. Unlocks the vault as before.

**Pros:**
- Simplest implementation. No new dependencies.
- Works immediately after bootstrap (no session state required).
- Encrypted file is as secure as the host; moving it to a new host is not transparent (see recovery below).

**Cons:**
- The host-local key must be stored somewhere. If stored on the same filesystem, it's readable by root (and non-root if permissions are misconfigured).
- Not truly device-bound — only host-bound. A copy of the encrypted blob + key combo exfiltrates the secret.
- Requires a separate mechanism to bind the device to Telegram (see bootstrap below).

**Security**: Against non-root, this is slightly stronger than the passphrase (encrypted instead of plaintext input), but not qualitatively different. Against root, it's equivalent. **Not recommended as primary option.**

#### Option B: OS Keyring (libsecret on Linux, Keychain on macOS) via `keytar` or native APIs
**Design**: Store the vault passphrase in the system keyring, bound to the switchroom service/user. On first unlock, the broker:
1. Calls `libsecret` (or Keychain) API to retrieve the secret by a fixed key ID.
2. Decrypts the vault with the retrieved passphrase.

**Pros:**
- OS-level secret storage with explicit security model (e.g., libsecret checks the calling process's PID/cgroup, Keychain uses ACLs).
- Transparent across logins on the same host (if keyring is unlocked).
- Standard practice for credential storage (1Password, Bitwarden, GitHub CLI all use this).
- Non-root processes cannot read the keyring without the daemon's consent.

**Cons:**
- Requires the keyring daemon to be running. If the user logs out, the keyring locks and broker cannot auto-unlock.
- Depends on keyring daemon security, which varies. libsecret has a history of privilege-escalation bugs.
- If the user's login session is compromised, a process running in that session can trick the keyring daemon into releasing the secret (shared PID namespace / session key).
- Not truly device-independent; moving the secret to a new device requires re-storing it (see bootstrap).
- Additional dependency: `keytar` or native bindings (`libsecret-1.0` on Linux).

**Security**: Stronger than Option A against non-root, because the keyring daemon acts as a gatekeeper. But the security boundary is fragile — determined adversaries with process-level access can still extract the secret. **Good option for interactive sessions, but problematic for headless cron/systemd.**

#### Option C: TPM-backed secret (where available)
**Design**: Use the Trusted Platform Module to seal the vault passphrase. The TPM's PCRs (Platform Configuration Registers) lock the secret to the current boot state. On unlock:
1. Broker unseals the secret from the TPM.
2. TPM only releases it if PCRs match the sealed value (preventing bootkits / OS tampering).

**Pros:**
- Hardware-based trust anchor. Even root cannot extract the secret if the boot chain is altered.
- Excellent security against offline attacks and VM escape.
- Industry standard for disk encryption (LUKS, Windows BitLocker).

**Cons:**
- Requires a TPM chip (not all machines have one, cloud VMs rarely do).
- PCR-based sealing is brittle; any kernel update changes PCRs (mitigated by measuring only critical components, but still fragile).
- Added complexity: broker must communicate with TPM daemon (tpm2-tools, or use libraries like tpm2-python).
- Learning curve steep; requires careful PCR selection to avoid boot-time failures.
- If the TPM is disabled in BIOS or not present, falls back to another mechanism (weak fallback story).

**Security**: Strongest option against physical attacks and offline exfiltration, but overkill for the stated threat model (terminal-level, non-root attacks). **Good as an option, not as the default.**

#### Option D: Telegram-Derived Key (Theoretical)
**Concept**: The operator's Telegram account ID + a server-side secret derive a decryption key on each unlock. The broker:
1. Sends a request to a Telegram-aware backend (or a local service watching for approvals).
2. Waits for operator approval via Telegram button tap.
3. On approval, a key is derived using the approved timestamp + account ID + server secret.
4. The derived key decrypts the vault passphrase.

**Pros:**
- True device binding: the secret is not stored on disk; it's ephemeral and derived on each unlock.
- If the operator loses access to Telegram, the secret cannot be recovered (clean revocation).

**Cons:**
- Requires a stateful backend or service to coordinate approvals. Adds latency and complexity.
- The "server secret" must be stored somewhere (falls back to Option A/B).
- Hard to implement offline-first (cron jobs may run when the operator is unreachable).
- Security depends on the backend's integrity; if compromised, the derived key is compromised.

**Security**: Theoretically strong, but introduces new dependencies that reduce overall reliability. **Not recommended for this use case; better for web-service 2FA.**

### Recommendation

**Primary path: Option B (OS Keyring)** with fallback to **Option A (encrypted file)**.

**Rationale:**
1. Option B is the industry standard and provides a meaningful security improvement over passphrase alone.
2. The fallback to Option A handles headless/cron scenarios where the keyring is unavailable (e.g., systemd user session without an interactive login).
3. Option C is overkill for the threat model and introduces fragility (PCRs, hardware assumptions).
4. Option D is elegant but adds infrastructure dependencies that conflict with switchroom's philosophy of being operator-controlled, not server-dependent.

**Implementation notes:**
- Use `keytar` (if available as a native module) or fall back to direct `libsecret` bindings via FFI / shell calls.
- On macOS, use native Keychain APIs (not keytar, which may have compatibility issues).
- If the keyring is unavailable at unlock time, fall back to Option A (encrypted file at `~/.config/credstore.encrypted/vault-dbs`).
- Log which mechanism was used in the audit trail (`stored_in: "keyring"` or `stored_in: "file"`).

---

## 3. Bootstrap Path

### First-Time Setup
When an operator runs vault commands for the first time (or explicitly rebinds Telegram), we need to:
1. Establish that the current Telegram session is the one bound to the vault.
2. Store the device-bound secret (the vault passphrase, encrypted or in the keyring).

**Flow:**
```
User runs: switchroom vault bind-telegram

↓

Broker checks: Is a Telegram account already bound? 
  - If yes: confirm rebinding (destructive action, ask first)
  - If no: proceed

↓

Broker generates a random PIN (6 digits) and sends a Telegram message:
  "Vault binding: enter PIN 123456 in the terminal to confirm"

↓

User sees the PIN in Telegram and types it in the terminal prompt:
  Confirm vault binding for Telegram account @username? Enter PIN: 123456

↓

Broker receives PIN match → asks for vault passphrase one last time:
  Vault passphrase (you'll use Telegram approvals from now on): <input>

↓

Broker encrypts/stores the passphrase in the keyring / encrypted file.
Writes a binding record to switchroom.yaml (or a sidecar JSON):
  vault:
    unlock_method: telegram
    bound_telegram_account: 123456789
    bound_device_hostname: my-laptop
    bound_at: "2026-04-28T12:00:00Z"

↓

Broker prints success:
  "Vault bound to @username. From now on, unlock via: /vault unlock"
```

**Rationale:**
- The PIN exchange proves that the person with the Telegram phone is the same person at the terminal (synchronous confirmation).
- Storing the passphrase immediately means no more terminal prompts.
- The binding record allows audit trails and recovery flows.

### Recovery Path (Passphrase as Break-Glass)
If the operator loses Telegram access (stolen phone, account lockout), they can still unlock using the original passphrase:

```
User runs: switchroom vault unlock --break-glass

Prompt: Vault passphrase (break-glass recovery): <input>

Broker validates passphrase against vault.enc, then:
  1. Unlocks the vault.
  2. Logs to audit trail: {"op":"unlock","method":"break-glass","risk":"operator_lost_telegram"}
  3. Prints a warning: "RECOVERY MODE. Rebind your Telegram account when access is restored."
```

**Passphrase rotation (recovery):**
If the passphrase was lost/forgotten, the operator can re-bootstrap:
```
switchroom vault rotate-passphrase

Broker: Re-encrypt vault.enc with a new passphrase (scrypt KDF + salt).
  Then: Prompt for new passphrase, update vault, delete old DBS.
```

This is a rare operation (not a regression from today; it exists already), but now it's explicitly a recovery path.

### Re-Binding to a New Telegram Account
```
switchroom vault rebind-telegram

Prompt: This will revoke the current Telegram binding. Continue? (y/N)

Then: Follow the same flow as bootstrap (PIN exchange, passphrase entry).
```

Audit log: `{"op":"rebind","old_account":"123456789","new_account":"987654321"}` (no passphrase in the log, of course).

---

## 4. Approval UX

### Trigger Conditions
**When does the Telegram prompt fire?**

The operator can configure this (new config option):

```yaml
vault:
  unlock_method: telegram
  approval_prompt_at:
    - "broker_startup"    # Ask on every broker startup
    - "lock_to_unlock"    # Ask when broker transitions locked → unlocked
    - "key_request_only"  # Ask only when a cron unit requests a key (deferred)
```

**Recommendation**: Default to `lock_to_unlock`. Rationale: operators expect an unlock action to require confirmation. Per-key deferral (on-demand) adds latency and can block cron jobs.

### Message and Buttons
**What the operator sees in Telegram:**

```
🔓 Vault unlock request

Host: my-laptop
Time: 2026-04-28 12:34:56 UTC
Caller: switchroom-myagent-cron-0.service
Requested keys: github-api-key, slack-token

Approve?

[Approve 30m]  [Deny]  [Always this hour]
```

**Button meanings:**
- **Approve 30m**: Unlock the vault for the next 30 minutes. Cron jobs can read keys without re-prompting. After 30m, next unlock requires another approval.
- **Deny**: Reject the unlock. Cron job will fail (exit code 3).
- **Always this hour**: Approve unlocks for the next 60 minutes without prompting again (for batch jobs).

### Timeout Behavior
If the operator doesn't respond within 5 minutes:

```
Broker: Still waiting for unlock approval. Auto-deny in 2 minutes.
```

At 7 minutes:
```
Broker: Unlock request expired. Reverting to locked state.
Cron job: Fails with exit code 3 (broker locked).
```

**Rationale**: Cron jobs should fail fast, not hang forever. The operator can restart the cron or re-run manually.

### TTL and Session Scope
An "Approve 30m" button unlocks the vault for 30 minutes. This is a broker-level unlock, not per-agent or per-key. (All cron jobs scheduled in that 30m window can read their allowed keys.)

If the operator needs finer granularity, they can:
1. Re-lock manually: `/vault lock`.
2. Use `--break-glass` for specific one-shot unlocks.

---

## 5. Audit & Observability

### Audit Log Format
Every unlock attempt (approval, denial, timeout) is logged as a JSON line:

```json
{
  "ts": "2026-04-28T12:34:56.789Z",
  "op": "unlock",
  "method": "telegram",
  "requester_unit": "switchroom-myagent-cron-0.service",
  "requester_pid": 2847291,
  "telegram_user": 123456789,
  "approval_ttl_minutes": 30,
  "action": "approved",
  "result": "allowed"
}
```

**For a denial:**
```json
{
  "ts": "2026-04-28T12:35:10.123Z",
  "op": "unlock",
  "method": "telegram",
  "requester_unit": "switchroom-myagent-cron-0.service",
  "telegram_user": 123456789,
  "action": "denied",
  "result": "denied"
}
```

**For a timeout:**
```json
{
  "ts": "2026-04-28T12:41:30.456Z",
  "op": "unlock",
  "method": "telegram",
  "requester_unit": "switchroom-myagent-cron-0.service",
  "telegram_user": 123456789,
  "action": "timeout",
  "result": "denied:timeout_after_5m"
}
```

**For break-glass (passphrase fallback):**
```json
{
  "ts": "2026-04-28T13:00:00.000Z",
  "op": "unlock",
  "method": "passphrase",
  "requester": "cli",
  "action": "break_glass",
  "result": "allowed"
}
```

### Telegram-Side Audit
Every approval is a Telegram message in the chat history, so the operator can scroll back and review:

```
[12:34] 🔓 Vault unlock request
        Host: my-laptop
        Caller: switchroom-myagent-cron-0.service
        [Approve 30m]  [Deny]

[12:34] ✅ Approved for 30 minutes
```

**No sensitive data is logged** (not the vault passphrase, not the keys being unlocked). The audit trail shows who approved, when, and for how long — enough for compliance and incident investigation.

---

## 6. Phasing

### Phase 1: Opt-In via Config Flag (This Proposal)
**What ships first:**

1. New config option:
   ```yaml
   vault:
     unlock_method: "passphrase"  # or "telegram" (opt-in)
   ```

2. `switchroom vault bind-telegram` command (PIN exchange, store passphrase in keyring/file).

3. Broker accepts Telegram approval requests (wireup to Telegram plugin).

4. `/vault unlock` Telegram command (sends approval request, waits for broker to unlock).

5. Audit log entries for Telegram unlock attempts.

6. **Default remains passphrase** — operators opt-in to Telegram 2FA.

**Why phased?** 
- Telegram 2FA is a new interaction pattern; opt-in lets operators test and provide feedback.
- The fallback to passphrase (`--break-glass`) is critical infrastructure; should be proven before it's the default.
- Compatibility with existing `vault.broker.autoUnlock` (#129/#168) needs testing.

### Phase 2: Hardening & Refinement (Separate PRs)
- OS Keyring integration (libsecret on Linux, Keychain on macOS).
- TPM-backed storage option.
- Directive-based approval policies (e.g., "always approve cron job X").
- Rate-limiting on approval requests (prevent approval spam).

### Phase 3: Make Telegram Default (Future)
Once Telegram 2FA is widely deployed and trusted:
```yaml
vault:
  unlock_method: "telegram"  # New default
  allow_passphrase_fallback: true  # Always on for recovery
```

### Compatibility: `vault.broker.autoUnlock`
The existing `autoUnlock` feature (issue #129/#168) allows the broker to auto-unlock on startup if a credential is found at `~/.config/credstore.encrypted/vault-passphrase`.

**New behavior:**
- If `unlock_method: "telegram"`, the passphrase stored in the keyring/file is used for auto-unlock (same as before).
- No change to the CLI or operator workflow.
- Audit log will show `{"op":"unlock","method":"auto_unlock_dbs"}` to distinguish from manual unlocks.

---

## 7. Open Questions

1. **Keyring availability in systemd user session:**
   When the operator logs out, the keyring locks. But the broker (running as a systemd user service) may still need to auto-unlock if a cron job fires.
   - **Question**: Should we require the operator to keep a session open? Or should we fall back to the encrypted-file option for headless scenarios?
   - **Proposed answer**: Fall back to encrypted file (Option A) if keyring is unavailable. Log the fallback in the audit trail. The operator can re-run the bind-telegram flow to prefer the keyring if they want.

2. **Cron job blocking on missing approval:**
   If a cron job requests a key and the vault is locked, and the operator doesn't respond to the Telegram prompt within 5 minutes, the job fails. This is correct behavior, but some operators may not expect it.
   - **Question**: Should we add a config option to auto-deny after N minutes instead of blocking?
   - **Proposed answer**: Auto-deny after 5 minutes (no config needed). Operators can re-run the job manually if they missed the window. This is better than a hanging cron job.

3. **Binding multiple hosts / accounts:**
   An operator may have multiple machines running switchroom. Can the same Telegram account be bound to multiple hosts?
   - **Question**: Should we allow multi-host binding, or enforce 1:1 (one Telegram account → one bound host)?
   - **Proposed answer**: Allow multi-host binding. Each host has its own encrypted secret in the keyring/file. The Telegram approval is global (operator approves, all hosts unlock for 30m). This simplifies the operator's workflow (one approval for the morning, all machines unlock). Audit trail will include the requesting host.

4. **Operator is asleep / unreachable:**
   If a cron job fires at 3 AM and the operator is asleep, the job will block or fail. Is this acceptable?
   - **Question**: Should we provide an override mechanism (e.g., API token, passphrase hash, etc.) for unattended scenarios?
   - **Proposed answer**: No override in Phase 1. This is a business decision the operator makes: do I want approval-gated unlocks, or do I accept the passphrase model? For 24/7 operations, the operator can use `--break-glass` for the specific cron job (explicit opt-out of Telegram 2FA). See the phasing section: this is Phase 2 refinement.

5. **Passphrase recovery if forgotten:**
   If the operator set up Telegram 2FA, then loses the passphrase *and* loses Telegram access (e.g., both secrets forgotten), how do they recover?
   - **Question**: Should we store a recovery code?
   - **Proposed answer**: No recovery code in Phase 1. This is an edge case (operator loses *both* secrets). Escalation path: the operator must re-initialize the vault from scratch (rotate passphrase with a new one). This is already a supported operation, though destructive. For Phase 2+, we can add a recovery code (stored in a password manager, printed on first bind, etc.).

---

## 8. Implementation Work Breakdown

### PR 1: Core Broker Changes — Telegram Unlock RPC
**Scope**: Extend the vault broker to accept unlock requests via Telegram.

- [ ] Add new RPC message type: `UnlockViaApprovalRequest` (async, waits for Telegram approval).
- [ ] Add broker state: `pending_approval_timeout`, `pending_requester_unit`.
- [ ] Implement approval timeout timer (5 minutes, auto-deny).
- [ ] Emit audit log entries for approval, denial, timeout.
- [ ] No config changes yet; this RPC is internal-only.

**Test coverage**: Unit tests for timeout logic, audit log format, concurrent approval requests.

### PR 2: Config Schema & Binding Command
**Scope**: Add new config options and CLI command.

- [ ] Extend `switchroom.yaml` schema: `vault.unlock_method`, `vault.bound_telegram_account`, `vault.bound_device_hostname`, `vault.bound_at`.
- [ ] Implement `switchroom vault bind-telegram` command (PIN exchange, passphrase entry).
- [ ] Store vault passphrase in keyring (or encrypted file fallback).
- [ ] Implement `switchroom vault rebind-telegram` command.
- [ ] Implement `switchroom vault unlock --break-glass` flag.

**Test coverage**: Unit tests for PIN validation, keyring API calls (mocked), config serialization.

### PR 3: Telegram Plugin Integration
**Scope**: Wire up the Telegram bot to send/receive unlock requests.

- [ ] Add `/vault unlock` command handler (if not already present; #158 may have it).
- [ ] Implement inline keyboard buttons (Approve, Deny, Always this hour).
- [ ] Handle button taps: call broker's approval RPC.
- [ ] Display approval confirmation message with TTL countdown.
- [ ] Handle timeout case: notify operator that unlock request expired.

**Test coverage**: Integration tests with a mock Telegram bot, mock broker RPC.

### PR 4: Audit Logging & Observability
**Scope**: Ensure all unlock attempts are logged.

- [ ] Extend audit log schema to include: `method`, `telegram_user`, `approval_ttl_minutes`, `action` (approved/denied/timeout).
- [ ] Add `stored_in` field to auto-unlock log entries (keyring vs. file).
- [ ] Ensure break-glass unlocks are marked clearly.
- [ ] Write audit log examples to the broker documentation.

**Test coverage**: End-to-end tests generating audit log entries, validation of JSON format.

### PR 5: Documentation & Examples
**Scope**: Update docs for operators.

- [ ] Update `docs/vault-broker.md` with new Telegram 2FA section.
- [ ] Add example `switchroom.yaml` snippet showing `unlock_method: telegram`.
- [ ] Add troubleshooting section (keyring unavailable, approval timeout, rebinding).
- [ ] Update `docs/configuration.md` with the new config keys.

**No code changes; documentation only.**

### PR 6: Compatibility Layer — Auto-Unlock
**Scope**: Ensure existing `vault.broker.autoUnlock` (#129/#168) works with Telegram 2FA.

- [ ] If `unlock_method: telegram` and a stored DBS exists (keyring or file), auto-unlock uses the DBS instead of prompting.
- [ ] Audit log: mark auto-unlock entries with `method: "auto_unlock_dbs"`.
- [ ] Tests: verify auto-unlock behavior with both keyring and file fallback.

**Note:** This may be combined with PR 1 or 2 depending on phasing.

---

## Summary

This proposal establishes Telegram approval as a passwordless 2FA for vault unlock, while retaining the passphrase as a break-glass recovery mechanism. The design balances security (protection against shoulder-surfing and keyboard sniffing), usability (operator just taps "Approve"), and reliability (automatic fallback, audit trails).

**Key decisions:**
1. **Storage**: OS Keyring (primary) + encrypted file (fallback).
2. **Trigger**: On broker unlock (`lock_to_unlock`), configurable.
3. **TTL**: 30 minutes (per-operator button tap), configurable.
4. **Audit**: JSON-structured log entries, no sensitive data.
5. **Phasing**: Opt-in in Phase 1, with hardening and multi-host support in Phase 2+.

Estimated effort: **6–8 weeks** for Phase 1 (PRs 1–6), assuming ~2–3 PRs per week, each ~3–5 days. Phases 2–3 would follow once feedback from early adopters is gathered.
