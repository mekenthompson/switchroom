/**
 * Pin the agent-image bake list. The in-container telegram-plugin gateway
 * sidecar shells out to the switchroom CLI for /auth, /vault, /agent
 * (post-fallback restart) and friends — see
 * `telegram-plugin/gateway/gateway.ts:switchroomExec`. Under v0.6 systemd
 * the host CLI was on PATH; under v0.7+ docker the agent container is
 * its own filesystem, so the CLI bundle has to be baked into the image
 * and symlinked onto PATH. Without it, every gateway shell-out hits
 * ENOENT and Telegram-driven auth/vault flows fail silently.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dockerfile = readFileSync(resolve(root, "docker/Dockerfile.agent"), "utf8");

describe("Dockerfile.agent bakes", () => {
  it("bakes the switchroom CLI bundle", () => {
    expect(dockerfile).toMatch(
      /COPY\s+dist\/cli\/switchroom\.js\s+\/opt\/switchroom\/switchroom\.js/,
    );
  });

  it("symlinks the CLI onto PATH at /usr/local/bin/switchroom", () => {
    expect(dockerfile).toMatch(
      /ln\s+-s\s+\/opt\/switchroom\/switchroom\.js\s+\/usr\/local\/bin\/switchroom/,
    );
  });

  it("bakes the autoaccept-poll bundle", () => {
    expect(dockerfile).toMatch(
      /COPY\s+dist\/cli\/autoaccept-poll\.js\s+\/opt\/switchroom\/autoaccept-poll\.js/,
    );
  });

  it("bakes the telegram-plugin dist tree", () => {
    expect(dockerfile).toMatch(
      /COPY\s+telegram-plugin\/dist\s+\/opt\/switchroom\/telegram-plugin\/dist/,
    );
  });

  it("bakes the agent-scheduler bundle", () => {
    expect(dockerfile).toMatch(
      /COPY\s+dist\/agent-scheduler\/index\.js\s+\/opt\/switchroom\/agent-scheduler\/index\.js/,
    );
  });
});
