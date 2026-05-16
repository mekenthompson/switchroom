/**
 * Phase 2b — approval-kernel client resolver unit tests.
 *
 * The resolver picks where to connect based on opts + env. Pure function;
 * no socket I/O — that's covered end-to-end by the docker integration
 * test (tests/docker/phase2b-kernel-ipc.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveKernelSocketPath,
  resolveKernelOperatorSocket,
  kernelOperatorSocketPath,
} from "./client.js";

describe("resolveKernelSocketPath (Phase 2b)", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.SWITCHROOM_KERNEL_SOCKET;
    delete process.env.SWITCHROOM_KERNEL_SOCKET;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.SWITCHROOM_KERNEL_SOCKET;
    } else {
      process.env.SWITCHROOM_KERNEL_SOCKET = savedEnv;
    }
  });

  it("returns null when no opts and no env (host mode)", () => {
    expect(resolveKernelSocketPath()).toBeNull();
    expect(resolveKernelSocketPath({})).toBeNull();
  });

  it("prefers explicit opts.socket above all", () => {
    process.env.SWITCHROOM_KERNEL_SOCKET = "/run/switchroom/kernel/alice/sock";
    expect(
      resolveKernelSocketPath({ socket: "/tmp/explicit.sock", kernelSocket: "/tmp/k.sock" }),
    ).toBe("/tmp/explicit.sock");
  });

  it("uses SWITCHROOM_KERNEL_SOCKET when no opts.socket", () => {
    process.env.SWITCHROOM_KERNEL_SOCKET = "/run/switchroom/kernel/alice/sock";
    expect(resolveKernelSocketPath()).toBe("/run/switchroom/kernel/alice/sock");
    expect(resolveKernelSocketPath({})).toBe("/run/switchroom/kernel/alice/sock");
  });

  it("falls through to opts.kernelSocket when env is unset", () => {
    expect(resolveKernelSocketPath({ kernelSocket: "/tmp/k.sock" })).toBe(
      "/tmp/k.sock",
    );
  });

  it("treats empty SWITCHROOM_KERNEL_SOCKET as unset (host mode)", () => {
    process.env.SWITCHROOM_KERNEL_SOCKET = "";
    expect(resolveKernelSocketPath()).toBeNull();
    expect(resolveKernelSocketPath({ kernelSocket: "/tmp/k.sock" })).toBe(
      "/tmp/k.sock",
    );
  });

  it("env beats kernelSocket — docker overrides programmatic default", () => {
    process.env.SWITCHROOM_KERNEL_SOCKET = "/run/switchroom/kernel/alice/sock";
    expect(
      resolveKernelSocketPath({ kernelSocket: "/tmp/programmatic.sock" }),
    ).toBe("/run/switchroom/kernel/alice/sock");
  });

  it("host fallback resolver stays OUT of the pure resolver", () => {
    // Even if the operator socket exists, resolveKernelSocketPath must
    // not pick it up — that path is opt-in by the host caller only.
    expect(resolveKernelSocketPath()).toBeNull();
  });
});

describe("resolveKernelOperatorSocket (host operator fallback)", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kern-op-home-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns the operator sock path when it exists on disk", () => {
    const dir = join(home, ".switchroom", "state", "kernel-operator");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sock"), "");
    expect(resolveKernelOperatorSocket(home)).toBe(
      kernelOperatorSocketPath(home),
    );
  });

  it("returns null when the operator sock is absent (host-mode unchanged)", () => {
    expect(resolveKernelOperatorSocket(home)).toBeNull();
  });
});
