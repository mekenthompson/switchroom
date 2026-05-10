# Rollback runbook — v0.7.12 → v0.7.11

If v0.7.12 introduces a regression in your environment, this runbook
walks through reverting both the layout migration and the CLI
binary.

> **Heads-up:** the layout migration is forward-only by design. The
> rollback recipe undoes the symlink and moves the file back to the
> legacy path. After rolling back, your fleet runs against
> v0.7.11's broker behavior — which has the EBUSY-on-rotation bug
> (#954) you may be specifically rolling back to escape something
> ELSE about v0.7.12, e.g. an apply-time guard that's surfacing.

## When to roll back

- Apply-time vault-dir guard refuses to mount and you can't
  resolve the unexpected file in the dir cleanly (very rare).
- State-E recovery after a botched migration — DON'T rollback;
  follow `state-e-recovery.md` instead.
- A genuine regression in v0.7.12's broker / migration code that
  affects your specific config.

## Sequence

```bash
# 1. Stop the broker — critical: while it's running, broker writes
#    go to the canonical path; if you mv the file back to legacy
#    while broker is up, the next broker write recreates the
#    canonical path and you're back in state E.
docker compose -p switchroom \
  -f ~/.switchroom/compose/docker-compose.yml \
  stop vault-broker

# 2. Move the canonical file back to the legacy path. Replace the
#    symlink with the real file content.
mv ~/.switchroom/vault.enc ~/.switchroom/vault.enc.symlink
mv ~/.switchroom/vault/vault.enc ~/.switchroom/vault.enc
rm ~/.switchroom/vault.enc.symlink

# 3. Remove the now-empty vault dir (apply will refuse to mount it
#    if anything's left — it'll just be gone after rollback).
rmdir ~/.switchroom/vault/

# 4. Downgrade. Two paths depending on how you installed:
#    a) bun-linked / npm-global installation:
npm install -g switchroom@0.7.11
#    b) source checkout — git checkout the v0.7.11 tag in your
#       switchroom checkout, then npm run build.

# 5. Re-apply. The v0.7.11 compose generator emits the
#    single-file :ro mount; after this, broker is back to v0.7.11
#    behavior.
switchroom apply
docker compose -p switchroom \
  -f ~/.switchroom/compose/docker-compose.yml \
  up -d --remove-orphans
```

## Verification

```bash
# Broker container should be running with the v0.7.11 image:
docker exec switchroom-vault-broker switchroom --version
# Expected: 0.7.11

# Vault file should be at the legacy path:
ls -la ~/.switchroom/vault.enc          # → regular file
ls -la ~/.switchroom/vault/             # → does not exist
```

## After rollback

You are back on v0.7.11 with the EBUSY-on-broker-rotation bug
still present. The calendar skill (and other rotation-driven
skills) will fail on the next refresh window.

Consider opening an issue with details of why v0.7.12 didn't work
in your environment — the maintainers can iterate on a v0.7.12
patch that addresses your specific case.

## Related

- CHANGELOG entry for v0.7.12 — full migration story
- [`docs/operators/state-e-recovery.md`](state-e-recovery.md) — for
  divergent-state recovery (NOT a rollback)
- Issue [#954](https://github.com/switchroom/switchroom/issues/954) —
  EBUSY RCA, the bug v0.7.12 fixes
