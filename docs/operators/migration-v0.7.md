# Migration: v0.6 → v0.7 (Docker-only)

v0.7 removes the legacy systemd runtime. Every agent now runs as a
Docker container under `docker compose`. The `switchroom systemd` verb
tree is gone, `bin/bridge-watchdog.sh` is deleted, and `switchroom up`
/ `switchroom init` / `switchroom update` survive only as deprecation
shims (slated for removal in v0.8).

This guide walks an existing v0.6 deployment to v0.7 with no fleet
downtime beyond a normal restart.

## Before you start

- **Snapshot your config.** `cp -a ~/.switchroom ~/.switchroom.v0.6.bak`
  — config, vault, agent state. Cheap insurance.
- **Note what's running.** `switchroom agent list` (capture the output)
  so you can compare after the migration.
- **Confirm the host has compose v2.** `docker compose version` should
  print `Docker Compose version v2.x`. If you only have the v1 plugin
  (`docker-compose`), install the v2 plugin first — `apply` errors out
  on v1.

## Step 1 — Stop the systemd fleet

```sh
# Stop every per-agent unit, the watchdog, and the broker.
systemctl --user stop 'switchroom-*.service' 'switchroom-*.timer' 2>/dev/null || true
systemctl --user stop switchroom-vault-broker.service 2>/dev/null || true
systemctl --user stop switchroom-watchdog.service 2>/dev/null || true

# Disable so they don't fight the docker fleet on next boot.
systemctl --user disable 'switchroom-*.service' 'switchroom-*.timer' 2>/dev/null || true
systemctl --user disable switchroom-vault-broker.service 2>/dev/null || true
systemctl --user disable switchroom-watchdog.service 2>/dev/null || true

systemctl --user daemon-reload
```

The unit files stay on disk for now — Step 5 cleans them up after the
docker fleet has been stable for 48 hours.

## Step 2 — Update switchroom

Pick whichever install path you originally used.

**Source checkout:**

```sh
cd ~/code/switchroom
git pull
bun install
bun run build
```

**Static binary:**

```sh
curl -fsSL https://github.com/switchroom/switchroom/raw/main/install.sh | sh
```

Verify:

```sh
switchroom --version    # should report 0.7.x
```

## Step 3 — Apply + bring the docker fleet up

```sh
switchroom apply
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml pull
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d
```

`switchroom apply` runs the v0.7 preflights (compose-v2 detection,
vault socket check, UID alignment for bind-mounted state dirs) before
writing `~/.switchroom/compose/docker-compose.yml`. If the UID-alignment
check fails (your agent state dirs are owned by a UID the container
won't have), either fix the ownership or pass `--allow-unaligned` after
reading the warning.

If you used auto-unlock under v0.6, move the auto-unlock blob to its
v0.7 path **before** running `switchroom apply` above (v0.7 changed the
default location and the v0.6 file won't be picked up otherwise):

```sh
# v0.7 changed the auto-unlock blob path. If you used auto-unlock on v0.6:
[ -f ~/.config/switchroom/auto-unlock.bin ] && \
  mv ~/.config/switchroom/auto-unlock.bin ~/.switchroom/vault-auto-unlock
```

If you've moved the auto-unlock blob (above) the vault broker re-unlocks
itself inside its new container on first boot. Otherwise you'll be
prompted for the passphrase on first start; re-run
`switchroom vault enable-auto-unlock` to restore unattended unlock.

## Step 4 — Verify

```sh
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml ps
switchroom version
switchroom agent list
```

Expect every previously-running agent to be in `Up (healthy)` state.
`switchroom version` reports the same agent health summary it always
did, but its data source is now `docker compose ps` rather than
`systemctl`. Send a test message to one agent in Telegram to confirm
end-to-end is alive.

## Step 5 — Optional: remove dormant unit files

After the docker fleet has been stable for ~48h:

```sh
rm -f ~/.config/systemd/user/switchroom-*.service
rm -f ~/.config/systemd/user/switchroom-*.timer
rm -f ~/.config/systemd/user/switchroom-watchdog.service
rm -f ~/.config/systemd/user/switchroom-vault-broker.service
systemctl --user daemon-reload
```

The CLI does not write these files in v0.7+; once removed, they don't
come back.

## Rollback

If something breaks and you want back on v0.6:

```sh
# Stop the docker fleet.
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml down

# Restore original UID ownership on agent state dirs. v0.7 apply chowns
# each agent dir to its container UID (10xx range); v0.6 systemd units
# run as your own UID and will refuse to read state owned by 10xx.
# `apply` records the prior <uid>:<gid> per directory to the audit log
# below — replay it in reverse so each dir gets its v0.6 owner back.
# If the log is missing (fresh install or pre-PR-C2 v0.7), the
# unconditional fallback restores everything to your shell user.
if [ -f ~/.switchroom/.uid-alignment.log ]; then
  # Each line: "<iso-ts> <agent-dir> <prior-uid>:<prior-gid> -> <new>".
  awk '{print $2, $3}' ~/.switchroom/.uid-alignment.log \
    | while read -r dir owner; do sudo chown -R "$owner" "$dir"; done
else
  sudo chown -R "$USER:$USER" ~/.switchroom/agents/
fi

# Restore the v0.6 config snapshot you took at the top of this doc.
mv ~/.switchroom ~/.switchroom.v0.7.partial
mv ~/.switchroom.v0.6.bak ~/.switchroom

# Check out the v0.6 source (or reinstall the v0.6 binary release).
cd ~/code/switchroom
git checkout v0.6.0
bun install && bun run build

# Re-enable + start the v0.6 systemd units.
switchroom apply        # v0.6 apply renders systemd units
systemctl --user daemon-reload
switchroom agent start
```

If you had not yet run Step 5, the v0.6 unit files are still on disk
and will start cleanly. Otherwise `switchroom apply` (under v0.6) will
re-render them.

File any rollback needed as a v0.7 bug — the docker path is the
supported runtime going forward and we want to know when it can't take
the place of a v0.6 install.
