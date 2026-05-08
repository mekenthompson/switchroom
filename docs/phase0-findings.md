# Phase 0 — narrative findings

## Summary

The path-derived per-agent socket identity model holds on Linux rootful AND rootless Docker 29.4.1 with no surprises **provided the operator-disjoint UID assumption holds** (see "Model assumption" below). Allow-paths return allow, deny-paths return deny, and a hostile container that cross-mounts another agent's socket dir is stopped at `connect()`, `bind()`, `unlink()`, AND `open(O_CREAT)` by ordinary POSIX file-mode bits — the broker never sees the cross-agent attempt and a hostile agent can neither replace nor squat the other agent's socket. tmux send-keys C-c under tini reaches a supervised child cleanly. The broker's chown/chmod state on the per-agent dirs persists across broker restart (they live on the named volume, not in container-local state), so re-applying perms on every broker startup is safely idempotent. **Phase 0 is PASS on both Linux engine modes (22/22 tests, including the same-UID-twin assumption row)**; Mac / Windows are PENDING on host availability, not design.

## Model assumption: operator-disjoint UIDs (load-bearing)

The path-derived identity model rests on a single unstated assumption that the spike makes explicit: **the compose generator MUST never assign the same UID to two services**. fs perms can distinguish "uid 10001" from "uid 10002", but they cannot distinguish "the legitimate uid 10001 (alice)" from "a hostile container the operator misconfigured to also run as uid 10001". With UID collision, alice's `0700`-mode dir is wide open to the colliding container — `connect()`, `bind()`, `unlink()`, and replace all succeed.

The new `agent-evil-twin` row in the spike (compose `hostile` profile) exercises exactly this: a hostile container running `user: "10001:10001"` cross-mounts alice's socket dir and runs `agent-client.mjs` with `SAME_UID_TWIN=1`. The test inverts pass criteria: every attack is **expected to succeed**, and the row is green when they do. On both rootful and rootless this row is PASS — proving the assumption is load-bearing.

**Mitigation (Phase 1 backlog item):** `switchroom doctor` must enforce UID uniqueness across the fleet's compose-generated services. Without that check, an operator typo silently collapses the security boundary. The fs-perm boundary alone cannot cover this case — it is a generator-level invariant, not a runtime defence. This finding does NOT undermine the model; it identifies the precise invariant the model depends on, and points at the Phase 1 deliverable that must enforce it.

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

### 5. Named-volume permission persistence — now exercised end-to-end

A named volume's contents persist across container restart on Linux rootful — but more importantly, the chown/chmod the broker applies to the per-agent dir at startup persists too (the dir is part of the volume content, not container-local state). The matrix now exercises this directly: `docker compose stop broker` → `docker compose start broker` → re-assert `drwx------` + uid 10001 on `/run/switchroom/broker/alice` from inside the alice container → re-run alice client → identity still resolves to `alice` and all four ACL paths still behave correctly. PASS on both rootful and rootless. The broker's startup-time chown is idempotent and one-shot per fleet lifecycle, not per-agent-restart.

### 6. Adversarial bind/unlink/replace also blocked

In addition to the original `connect()` cross-mount probe, the hostile container now attempts to (a) `bind()` a fresh `intruder.sock` inside the other agent's directory, (b) `unlink()` the other agent's socket inode, and (c) `open(O_CREAT|O_TRUNC)`-replace it. All three fail with `EACCES` because the directory is mode 0700 owned by the other agent's uid and the hostile container runs as a different uid. This closes the "what if the attacker doesn't try to read but tries to squat / DoS / replace?" question — same fs-perm boundary stops all four paths.

### 7. Linux rootless behaves identically to rootful

The rootless row was the highest-risk in the matrix because userns remapping is the most plausible way for a path-derived identity model to drift. It didn't drift. Inside the rootless broker container, `chown(dir, 10001, 10001)` succeeds because the broker is root *inside* its userns; inside the alice agent container, the dir reads back as `drwx------ 10001 10001` because both containers sit inside the same outer userns established by rootlesskit. From the host's perspective the dir is owned by `subuid_10001 + base_offset`, but no host-side process needs to touch the file, so this is irrelevant. The storage driver shifts from `overlay2` (rootful) to `vfs` (rootless) but named-volume contents are unaffected. 10/10 PASS.

## What surprised me

- **Nothing major.** The model behaved exactly as the RFC predicted. The RFC's note that "the per-agent socket design has no known blockers on any target environment" turns out to be accurate at least for the rootful Linux row.
- **One small gotcha**: `node:22-alpine` doesn't have `passwd`/`adduser` semantics that match Debian-family; I used `addgroup -g <gid>` + `adduser -D -u <uid> -G <name>`. The compose generator in Phase 1 will need to know what the agent base image is for its uid-creation snippet — there isn't a portable invocation. Worth flagging for Phase 1: pick one base distro for the agent image and stick to it.
- **`new-session -d` closes the session when its command exits.** That's fine for the spike but production agents need a keepalive command (`bash -i` or similar) wrapped around the work — otherwise the tmux session dies the moment claude exits, breaking subsequent `send-keys` attempts. This is already how the bash scripts work today, so no new work, but worth documenting in Phase 3's tmux-supervisor doc.

## What did NOT get validated locally

- **Docker Desktop Mac / Windows.** No host available locally. virtiofs (Mac) historically has been the source of mode-bit munging on bind-mounted host paths — but the spike uses *named volumes*, not bind mounts, so the in-VM ext4 fs holds the inodes and the host fs never sees them. The driver script now hard-asserts `drwx------` on the per-agent dir from inside each agent container, so a Mac virtiofs UID-collapse would surface as a `perms-alice` / `perms-bob` FAIL in the final tally rather than silently green. ~85% confidence Mac passes; Windows-WSL2 piggybacks on the same in-VM filesystem and should be equivalent. No paper finding substitutes for a real run.

## Phase 1 backlog (carried out of Phase 0)

- **TODO (security, load-bearing): `switchroom doctor` must enforce UID uniqueness across all services in the generated compose file.** A duplicate `user: "<uid>:<gid>"` between any two services collapses the path-derived identity boundary (see "Model assumption" above). Doctor should fail fleet startup with a precise error pointing at the colliding services. Block on Phase 1 RFC.
- The `--check cross-agent-mounts` doctor flag from the original RFC remains valuable as defence-in-depth, but the UID-uniqueness check is strictly more important — without it the cross-mount check is an inadequate barrier.

## Phase 0 verdict

PASS on both Linux rows currently runnable (rootful + rootless, **22/22 tests** — adds one row each for same-UID-twin assumption). Two PENDING rows (Mac, Windows) require operator-driven host access; methodology is locked in `phase0-peercred-matrix.md` and the driver hard-asserts dir mode/owner so silent failures on virtiofs / 9p will surface as red rows in the final tally.

**No Phase 0 abort condition is triggered.** Recommendation: unblock the Mac/Win rows in parallel with Phase 1 design, and add the UID-uniqueness doctor check as a Phase 1 blocker.
