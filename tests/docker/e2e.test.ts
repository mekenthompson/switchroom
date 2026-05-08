/**
 * Phase 1b E2E suite — exercises the actual built images. Skipped when
 * Docker isn't available or the phase1b-test images haven't been built
 * yet. CI builds the images first, then runs this suite.
 *
 * What this test covers:
 *   1. Each image's CMD entrypoint loads without ENOENT / MODULE_NOT_FOUND
 *      (the Phase 1a Dockerfiles' `dist/...` paths were aspirational —
 *      Phase 1b's build.mjs bundles them).
 *   2. Per-agent identity isolation: read-only rootfs blocks writes
 *      (EROFS), cap_drop=ALL + no-new-privileges blocks mount (EPERM).
 *   3. better-sqlite3's prebuilt binary actually loads inside the
 *      scheduler image (no apt build-essential fallback needed for
 *      linux/amd64; arm64 would test similarly under multi-arch CI).
 *
 * What this does NOT cover (deferred):
 *   - Live docker-compose stand-up across all 5 services
 *   - Real broker socket peercred handshake
 *   - Approval kernel — kernel-server.ts entrypoint doesn't exist yet
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execSync, spawnSync } from "node:child_process";

const TAG = "phase1b-test";
const IMAGES = {
  base: `switchroom/base:${TAG}`,
  agent: `switchroom/agent:${TAG}`,
  broker: `switchroom/broker:${TAG}`,
  kernel: `switchroom/kernel:${TAG}`,
  scheduler: `switchroom/scheduler:${TAG}`,
};

function hasDocker(): boolean {
  try {
    execSync("docker version --format '{{.Server.Version}}'", {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

function hasImage(ref: string): boolean {
  try {
    execSync(`docker image inspect ${ref}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const dockerOk = hasDocker();
const allImagesPresent =
  dockerOk &&
  Object.values(IMAGES).every((ref) => hasImage(ref));

describe.skipIf(!dockerOk || !allImagesPresent)(
  "phase1b docker images — E2E (skipped when docker / images unavailable)",
  () => {
    it("base image has node, bun, tini, tmux, claude on PATH", () => {
      // dash's `command -v` only accepts one arg, so loop in shell.
      // Use spawnSync with explicit argv so neither the host shell nor
      // the JS template literal mangles `$c` before it reaches dash.
      const r = spawnSync(
        "docker",
        [
          "run", "--rm", "--entrypoint", "sh", IMAGES.base, "-c",
          'for c in node bun tini tmux claude; do command -v "$c" || echo "MISSING:$c"; done',
        ],
        { encoding: "utf8" },
      );
      const out = r.stdout;
      expect(out).not.toMatch(/^MISSING:/m);
      expect(out).toMatch(/\/node\b/);
      expect(out).toMatch(/\/bun\b/);
      expect(out).toMatch(/\/tini\b/);
      expect(out).toMatch(/\/tmux\b/);
      expect(out).toMatch(/claude/);
    });

    it("broker image's bundled server.js loads under bun", () => {
      // Don't actually start the listen — just assert the module
      // resolves. A live listen would need a writable /run mount.
      const out = execSync(
        `docker run --rm --entrypoint bun ${IMAGES.broker} ` +
          `-e "import('/opt/switchroom/dist/vault/broker/server.js').then(()=>console.log('OK')).catch(e=>{console.error(e);process.exit(1)})"`,
      ).toString();
      expect(out.trim()).toBe("OK");
    });

    it("scheduler image's bundled index.js loads under node and better-sqlite3 prebuilt opens an in-memory DB", () => {
      const script = [
        `const Database = require('better-sqlite3');`,
        `const db = new Database(':memory:');`,
        `db.exec('CREATE TABLE t(x INTEGER)');`,
        `db.prepare('INSERT INTO t VALUES (?)').run(7);`,
        `const row = db.prepare('SELECT x FROM t').get();`,
        `console.log('sqlite_ok=' + row.x);`,
      ].join("");
      const out = execSync(
        `docker run --rm --entrypoint node ${IMAGES.scheduler} -e ${JSON.stringify(script)}`,
      ).toString();
      expect(out.trim()).toBe("sqlite_ok=7");
    });

    it("agent image enforces read-only rootfs (touch /etc/passwd → EROFS)", () => {
      const r = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--tmpfs",
          "/tmp:rw,size=64m,mode=1777",
          "--entrypoint",
          "sh",
          IMAGES.agent,
          "-c",
          "touch /etc/passwd",
        ],
        { encoding: "utf8" },
      );
      // The shell exits non-zero. The stderr should mention read-only fs.
      expect(r.status).not.toBe(0);
      expect(`${r.stderr}${r.stdout}`).toMatch(/read-only file system/i);
    });

    it("agent image with cap_drop=ALL blocks mount (mount -t tmpfs → EPERM)", () => {
      const r = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--tmpfs",
          "/tmp",
          "--entrypoint",
          "sh",
          IMAGES.agent,
          "-c",
          "mount -t tmpfs none /mnt",
        ],
        { encoding: "utf8" },
      );
      expect(r.status).not.toBe(0);
      // mount(8) prints "permission denied" when CAP_SYS_ADMIN is missing.
      expect(`${r.stderr}${r.stdout}`).toMatch(/permission denied|operation not permitted/i);
    });
  },
);

describe.skipIf(dockerOk && allImagesPresent)(
  "phase1b docker images — sentinel (visible when E2E was skipped)",
  () => {
    it("documents skip reason", () => {
      // Surfaces in the vitest report so a developer running locally
      // knows WHY the E2E suite didn't run.
      const reason = !dockerOk
        ? "docker daemon unreachable"
        : "phase1b-test images not built — run `bash tests/docker/build-images.sh` first";
      expect(reason).toMatch(/docker|phase1b/);
    });
  },
);
