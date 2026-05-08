# Phase 0 — container identity matrix

Run: `2026-05-08T00:47:20Z` (rootful + rootless full matrix; supersedes 2026-05-07T23:54:50Z rootful-only run)
Driver: `spike/test-acl-matrix.sh`
Spike artifacts: `spike/Dockerfile.broker`, `spike/Dockerfile.agent`, `spike/docker-compose.yml`, `spike/broker-server.mjs`, `spike/agent-client.mjs`, `spike/test-tmux-interrupt.sh`
Raw logs: `spike/results/`

## Matrix

Per-env tests (10 each): `build`, `up`, `perms-alice`, `perms-bob`, `alice-client` (3 sub-tests), `bob-client` (3 sub-tests), `tmux-interrupt`, `hostile-cross-mount` (cross-mount + bind/unlink/replace adversarial — 4 sub-tests), `perms-alice-after-restart`, `alice-client-after-restart`.

| Environment | Docker version | Engine mode | identity resolved (alice) | identity resolved (bob) | cross-mount + bind/unlink/replace denied (hostile) | tmux interrupt works | broker-restart persistence | dir-perms assertion | verdict |
|---|---|---|---|---|---|---|---|---|---|
| Linux rootful (Ubuntu, kernel 6.17.0-23-generic) | 29.4.1 (client+server) | rootful, overlay2, cgroupv2, apparmor+seccomp | YES — allow-own-key + deny-own-unknown + deny-other-key + cross-mount-attempt-na (ENOENT, *not mounted*) all pass | YES — mirror of alice | YES — `EACCES` at `connect()`, `bind()`, `unlink()`, `open(O_CREAT)` from uid 10002 against alice's dir (mode 0700, uid 10001). All four adversarial paths blocked at the kernel | YES — `tmux send-keys C-c` reaches supervised child under tini PID 1 | YES — broker stop/start preserves chown/chmod on the named volume; alice can re-connect; ACL still resolves to `alice` | YES — `ls -la` parser confirms `drwx------` and uid match | **PASS (10/10)** |
| Linux rootless (same host, `dockerd-rootless-setuptool.sh`, slirp4netns + builtin port driver) | 29.4.1 (client+server) | rootless, seccomp+cgroupns, vfs storage, userns remap via `subuid`/`subgid` | YES — identical 4/4 alice client behaviour to rootful | YES — identical 4/4 bob client | YES — identical EACCES on cross-mount, bind, unlink, replace; userns remapping does NOT degrade fs-perm enforcement (the broker chowns inside its own userns to uid 10001/10002, which the agent containers also see as 10001/10002) | YES — identical to rootful | YES — identical to rootful | YES — `drwx------` confirmed inside agent-alice and agent-bob containers | **PASS (10/10)** |
| Docker Desktop Mac (Apple Silicon, virtiofs) | n/a | n/a | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | **PENDING** — requires Mac host; methodology below |
| Docker Desktop Windows (WSL2 backend) | n/a | n/a | PENDING | PENDING | PENDING | PENDING | PENDING | PENDING | **PENDING** — requires Windows host; methodology below |

## Verdict (local-runnable subset)

Both Linux rootful AND Linux rootless pass the full matrix end-to-end (10/10 tests each = 20/20 across the local-runnable rows). **The RFC's Phase 0 abort condition (rootful or rootless failure on Linux) is not triggered.** Rootless was the highest-risk row in this batch — userns remapping was the most plausible failure mode for a path-derived identity model — and it behaved identically to rootful. The remaining two rows (Mac, Windows) are PENDING on host availability, not design failure; methodology is locked below so an operator can run them unattended.

## Pending-row methodology

For each pending environment, run from the project root after fetching `feat/docker-phase0-spike`:

```bash
cd spike
bash ./test-acl-matrix.sh
# matrix log lands under spike/results/<env>-<ts>.log
```

The driver auto-detects rootless contexts via `/run/user/$(id -u)/docker.sock`; on Mac/Windows the default Docker Desktop socket already shows up as `default` in `docker context ls`, and the spike's compose file works unchanged.

### Linux rootless — RAN 2026-05-08 (PASS)

Install steps actually executed on this host:

```bash
sudo apt-get install -y uidmap            # provides newuidmap / newgidmap
dockerd-rootless-setuptool.sh install --force
systemctl --user start docker.service
# rootful daemon left untouched on /var/run/docker.sock
# rootless daemon listens on /run/user/$(id -u)/docker.sock
cd spike && bash ./test-acl-matrix.sh
```

The driver auto-detects rootless via the user-systemd unit and runs a second matrix row. Confirmed behaviour: identical to rootful end-to-end. The broker's `chown` calls inside its container map through rootlesskit's user namespace — uid 10001 *inside* the userns is a `subuid` on the host but agents *also see* it as 10001 inside their userns, so fs-perm checks at `connect()` / `bind()` / `unlink()` work unchanged. No mount-propagation edge cases observed with named volumes (the storage driver is `vfs` under rootless rather than `overlay2`, but that doesn't affect the path-derived identity model).

### Docker Desktop Mac (Apple Silicon, virtiofs)

```bash
# Latest Docker Desktop, default settings.
docker context use desktop-linux
cd spike && bash ./test-acl-matrix.sh
```

Things to watch: virtiofs has historically munged mode bits and uid/gid on bind-mounted host paths. We use NAMED VOLUMES, not bind mounts, so this risk is mitigated — named volumes live inside the LinuxKit VM's filesystem, not on virtiofs. If `ls -la /run/switchroom/broker` inside agent-alice does NOT show `drwx------ alice alice alice`, the model is broken on this platform and the row fails. Expected SO_PEERCRED forensics: peer uid will be the in-VM agent uid (10001/10002), unrelated to the host macOS uid.

### Docker Desktop Windows (WSL2 backend)

```powershell
# Latest Docker Desktop with WSL2 backend enabled.
wsl -d Ubuntu
cd /mnt/c/path/to/switchroom-docker-phase0/spike
bash ./test-acl-matrix.sh
```

Same expected behaviour as Mac (named volumes, not 9p/wsl bind mounts). Watch for: line endings in the shell scripts (run `dos2unix` on `*.sh` if the `#!` line is unrecognised), and that `tini` is included in the agent image build (Alpine package, no host dependency).

## Notes for review

- The matrix's "SO_PEERCRED uid" column is informational per RFC §Phase 0 and is not captured here. The RFC explicitly downgrades it to a forensics column under the path-derived identity model. Adding native SO_PEERCRED capture (via `node-ffi-napi` or a small native addon) is in-scope for Phase 2's production broker, not for the Phase 0 spike.
- The `boundSocket` field is logged on every broker response (visible in `spike/results/*.log`) and is the authoritative identity string. Reviewer can cross-check that `agent` in each response equals the basename's parent of `boundSocket`.
- The "cross-mount denied" column is exercised by the `agent-bob-misconfigured` service in the compose `hostile` profile, which intentionally mounts BOTH socket dirs into a uid-10002 container. The connect attempt against alice's socket failed with `EACCES` at the kernel — the broker never accepted the connection. This is the strongest possible result: the deny is enforced before any application code runs.
