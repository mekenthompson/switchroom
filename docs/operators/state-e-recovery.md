# State E recovery — vault layout divergence

You're seeing this because `switchroom apply` (or `switchroom update`)
just printed a multi-paragraph error starting with:

```
✗ Vault layout divergence detected — refusing to proceed.
```

This page expands on what that means and how to recover. The error
message itself contains the literal `mv` commands you need; this is
just the explanatory background.

## What happened

In v0.7.12, switchroom moved the vault file from `~/.switchroom/vault.enc`
(legacy) to `~/.switchroom/vault/vault.enc` (canonical). The legacy
path became a **symlink** pointing at the new file so older CLI
versions could still read.

Linux `rename()` does NOT follow a symlink at the destination. If a
v0.7.10 or v0.7.11 CLI runs `switchroom vault set` after migration —
its `atomicWriteFileSync` calls `rename(tmp, ~/.switchroom/vault.enc)`,
which **replaces the symlink with a fresh regular file**.

Now you have two distinct vault files:

- `~/.switchroom/vault.enc` — what the old CLI wrote (the rotation
  the old CLI just made).
- `~/.switchroom/vault/vault.enc` — what the broker has been reading
  + writing since migration.

Reads from inside agents (broker-mediated) saw one. Reads from the
host CLI (legacy path) saw the other. **Vault state has silently
diverged.** State E's job is to refuse to proceed until you pick
one canonical truth.

## How to pick

The error message lists three options:

### a) Keep the NEW path (recommended for most operators)

This is right when:
- You've been using vault from inside agent containers since the
  migration (agents rotating tokens via `switchroom vault set` from
  inside the agent container always go through the broker → end up
  at the new path).
- The legacy path is a stale snapshot from before the migration.

### b) Keep the OLD path

This is right when:
- You ran `switchroom vault set` from the host on purpose AFTER the
  migration, and want to keep that change.
- The new path's content predates your manual rotation.

### c) If unsure — diff the contents

The error message includes a recipe for decrypting both with your
passphrase + listing keys, so you can see which file has the entries
you expect.

## After recovery

The `.divergent.bak` file is your safety net. Verify the fleet works
after `switchroom apply`. Once you've confirmed the right file was
kept, delete the `.bak`.

## Why this can't auto-resolve

The two files are encrypted blobs. Switchroom can decrypt both with
your passphrase and merge — but merging carries semantic risk
("which version of `microsoft/ken-tokens` is correct?"). The safe
default is to refuse and let you decide. The hash + mtime + size
information in the error message gives you the data needed to make
the call.

## Preventing recurrence

Once you're past the v0.7.12 migration, this state shouldn't recur:
- v0.7.13 emits a CLI warning when writes go through the symlink.
- v0.7.14 removes the symlink entirely; old paths simply don't
  resolve.

## Related

- CHANGELOG entry for v0.7.12 — full migration story
- Issue [#954](https://github.com/switchroom/switchroom/issues/954) — original RCA of the EBUSY loop
- Issue [#951](https://github.com/switchroom/switchroom/issues/951) — self-serve token refresh from Telegram
