# Phase 0 — narrative findings

## Summary

The path-derived per-agent socket identity model holds on Linux rootful Docker 29.4.1 with no surprises. Allow-paths return allow, deny-paths return deny, and a hand-edited hostile compose that cross-mounts another agent's socket dir is stopped at `connect()` by ordinary POSIX file-mode bits — the broker never sees the cross-agent attempt. tmux send-keys C-c under tini reaches a supervised child cleanly. **Phase 0 is PASS for the only environment available locally**; rootless / Mac / Win are PENDING on host availability, not design.

## What was validated, in detail

### 1. `getsockname()` returns the bound path verbatim

The spike's broker binds one UDS per agent at `/run/switchroom/broker/<agent>/sock`. On `accept()`, `server.address()` (which under the hood is `getsockname()` on the listening fd) returns the literal bound path string. We pass that path to `socketPathToAgent()`, parse out the `<agent>` component, and use it as the ACL key. The `boundSocket` field in every broker response confirms that the path round-trips intact through Docker's named-volume layer — there is no path translation, virtualisation, or remapping happening between the broker's bind and its accept.

This matters because the prior RFC draft was nervous about Docker's volume layer rewriting socket paths in subtle ways (e.g. canonicalising symlinks, stripping prefixes). On Linux rootful with named volumes this concern is empirically moot.

### 2. POSIX file-mode bits actually enforce the cross-mount deny

The strongest result of the spike. The `agent-bob-misconfigured` container intentionally mounts BOTH `alice-sock` and `bob-sock` named volumes; from inside that container both `/run/switchroom/broker/alice` and `/run/switchroom/broker/bob` exist. But the alice dir is mode `0700` owned by uid 10001 and the misconfigured container runs as uid 10002 — so:

- `ls /run/switchroom/broker/alice` → `Permission denied`
- `connect("/run/switchroom/broker/alice/sock")` → `EACCES`

The broker's `accept()` is never invoked for the hostile attempt. Defence-in-depth: even if the path-derived ACL had a bug, the kernel-level fs perms would block the cross-agent read. Even if a future bug let a hostile agent stat the inode, `connect()` against a UDS still requires execute (search) permission on the containing directory plus read+write (or, more strictly, the connect permission inferred from the socket's own mode). Both layers have to fail simultaneously for cross-agent access — that is exactly the threat model the RFC promised.

The doctor check called out in the RFC (`switchroom doctor --check cross-agent-mounts`) remains valuable as a pre-flight diagnostic — it surfaces the misconfiguration loud and early instead of silently relying on fs perms — but it is no longer load-bearing for security. That's a good place to be.

### 3. tmux daemonised under tini interrupt path is clean

`pid 1` is `tini`, which forks tmux as a normal child with a private socket at `/tmp/tmux-<uid>/spike`. `tmux send-keys -t spike C-c` sends SIGINT to the foreground process group of the pane (the `sleep 600`). The sleep dies within ~1s, the sentinel marker `/tmp/sleep-result` is never written (i.e. the sleep was killed, not allowed to exit normally). The tmux session closes (default behaviour when its only command exits) but that's expected — production code keeps the session alive by running a long-lived shell, which the spike doesn't bother with.

No interaction quirks observed between tini's SIGTERM-forwarding behaviour and tmux's process-group handling. The supervisor chain `tini → tmux-server → bash → claude` (production) and `tini → tmux-server → sleep` (spike) behave identically with respect to send-keys C-c.

### 4. The `user:` directive in compose works as advertised

The agent containers run as `10001:10001` (alice) and `10002:10002` (bob) via the compose `user:` directive. Inside each container `id` reports the right uid, and the agent process can read/write files in its own per-agent socket dir while being kernel-blocked from the other agent's. No `--privileged` required. No host-level UID remap required. No userns gymnastics required on rootful Docker.

### 5. Named-volume permission persistence

A named volume's contents persist across container restart on Linux rootful — but more importantly, the chown/chmod the broker applies to the per-agent dir at startup persists too (the dir is part of the volume content, not container-local state). Restarting just the agent containers (without the broker) preserves the right uid/gid/mode on the socket dir. This means the broker's startup-time chown is idempotent and one-shot per fleet lifecycle, not per-agent-restart.

## What surprised me

- **Nothing major.** The model behaved exactly as the RFC predicted. The RFC's note that "the per-agent socket design has no known blockers on any target environment" turns out to be accurate at least for the rootful Linux row.
- **One small gotcha**: `node:22-alpine` doesn't have `passwd`/`adduser` semantics that match Debian-family; I used `addgroup -g <gid>` + `adduser -D -u <uid> -G <name>`. The compose generator in Phase 1 will need to know what the agent base image is for its uid-creation snippet — there isn't a portable invocation. Worth flagging for Phase 1: pick one base distro for the agent image and stick to it.
- **`new-session -d` closes the session when its command exits.** That's fine for the spike but production agents need a keepalive command (`bash -i` or similar) wrapped around the work — otherwise the tmux session dies the moment claude exits, breaking subsequent `send-keys` attempts. This is already how the bash scripts work today, so no new work, but worth documenting in Phase 3's tmux-supervisor doc.

## What did NOT get validated locally

- **Linux rootless.** The host has `dockerd-rootless-setuptool.sh` and `rootlesskit` but `uidmap` is missing; install requires sudo apt. Methodology recorded in `phase0-peercred-matrix.md`. Risk assessment: rootless adds a userns layer between host uid and in-container uid, but the per-agent dir's uid/gid/mode are entirely *inside* the container userns — the broker's chown to "uid 10001" lands as "host subuid 10001 + offset" on the host but is observed as plain 10001 inside the userns. The fs-perms enforcement is unchanged. The likeliest failure mode would be an unfortunate interaction between rootlesskit's mount propagation and named-volume ownership, which affects bind-mounts more than named volumes and which I expect to pass; if it fails the fallback (HMAC tokens) is already in the RFC.
- **Docker Desktop Mac / Windows.** No host available locally. virtiofs (Mac) historically has been the source of mode-bit munging on bind-mounted host paths — but the spike uses *named volumes*, not bind mounts, so the in-VM ext4 fs holds the inodes and the host fs never sees them. I am ~85% confident Mac will pass; Windows-WSL2 piggybacks on the same in-VM filesystem and should be equivalent. No paper finding can substitute for a real run.

## Phase 0 verdict

PASS for the only row currently runnable. Two PENDING rows (Mac, Windows) require operator-driven host access and the methodology to run them is locked in `phase0-peercred-matrix.md`. The Linux-rootless row is PENDING on a 30-second `apt install uidmap` step that I declined to execute autonomously because it requires sudo.

**No Phase 0 abort condition is triggered.** Recommendation: dispatch a fresh reviewer against this branch to assess whether the spike actually validates the RFC's identity-model claims, then unblock the Mac/Win pending rows in parallel with Phase 1 design.
