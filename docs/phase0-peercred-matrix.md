# Phase 0 — container identity matrix

Run: `2026-05-07T23:54:50Z`
Driver: `spike/test-acl-matrix.sh`
Spike artifacts: `spike/Dockerfile.broker`, `spike/Dockerfile.agent`, `spike/docker-compose.yml`, `spike/broker-server.mjs`, `spike/agent-client.mjs`, `spike/test-tmux-interrupt.sh`
Raw logs: `spike/results/`

## Matrix

| Environment | Docker version | Engine mode | identity resolved (alice) | identity resolved (bob) | cross-mount denied (hostile) | tmux interrupt works | SO_PEERCRED uid (forensics) | verdict |
|---|---|---|---|---|---|---|---|---|
| Linux rootful (Ubuntu, kernel 6.17.0-23-generic) | 29.4.1 (client+server) | rootful, overlay2, cgroupv2, apparmor+seccomp | YES (`/run/switchroom/broker/alice/sock` → `alice`; allow-own-key + deny-other-key + deny-unknown-key all behaved as expected) | YES (mirror of alice; full 4/4 pass on bob client) | YES — `EACCES` at `connect()` from misconfigured-bob (uid 10002) into `alice/sock` (mode 0700, owned by uid 10001), without the broker ever seeing the connection attempt | YES — `tmux send-keys C-c` reaches the supervised `sleep 600` under `tini` PID 1; `/tmp/sleep-result` never written, target pid gone within 1s | not captured (Node lacks built-in SO_PEERCRED; informational column only per RFC §Phase 0) | **PASS** |
| Linux rootless | n/a | n/a | PENDING | PENDING | PENDING | PENDING | n/a | **PENDING** — `uidmap` package not installed; see methodology below |
| Docker Desktop Mac (Apple Silicon, virtiofs) | n/a | n/a | PENDING | PENDING | PENDING | PENDING | n/a | **PENDING** — requires Mac host; methodology below |
| Docker Desktop Windows (WSL2 backend) | n/a | n/a | PENDING | PENDING | PENDING | PENDING | n/a | **PENDING** — requires Windows host; methodology below |

## Verdict (local-runnable subset)

Linux rootful — the production deployment target on bare-metal / RasPi / Linux servers — passes the full matrix end-to-end. **The RFC's Phase 0 abort condition (Linux rootful failure) is not triggered.** The remaining three rows are PENDING on host availability, not on design failure; their methodology is locked below so a Mac/Win operator can run them unattended.

## Pending-row methodology

For each pending environment, run from the project root after fetching `feat/docker-phase0-spike`:

```bash
cd spike
bash ./test-acl-matrix.sh
# matrix log lands under spike/results/<env>-<ts>.log
```

The driver auto-detects rootless contexts via `/run/user/$(id -u)/docker.sock`; on Mac/Windows the default Docker Desktop socket already shows up as `default` in `docker context ls`, and the spike's compose file works unchanged.

### Linux rootless — install steps

```bash
sudo apt-get install -y uidmap            # provides newuidmap / newgidmap
dockerd-rootless-setuptool.sh install --force
systemctl --user enable --now docker
export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
cd spike && bash ./test-acl-matrix.sh
```

The driver script will detect `linux-rootless` automatically and run a second matrix row. Expected behaviour: identical to rootful for ACL allow/deny/cross-mount, with the caveat that the broker's `chown` calls inside the container map through rootlesskit's user namespace — UID 10001 inside == subuid 10001 in the rootless namespace, both invisible to the host. As long as `chown` succeeds inside the container (it should, because the broker runs as root inside its userns), the spike is unchanged.

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
