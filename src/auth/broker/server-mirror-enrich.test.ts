/**
 * End-to-end test for the broker's mirror-time enrichment path.
 *
 * Drives `mirrorAccountToAgent` (via boot fanout) with a stale legacy
 * source-of-truth credentials.json and asserts the per-agent mirror
 * carries the post-#1280 shape claude accepts. This is the residual
 * gap #1280 alone can't close: a stale source written before #1280
 * landed (or via a path that bypasses `writeAccountCredentials`)
 * doesn't get rewritten until refresh-tick fires — which can be
 * hours away when expiresAt is far-future.
 *
 * Companion unit test (`mirror-enrich.test.ts`) covers the pure
 * `enrichMirrorContent` helper.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthBroker } from "./server.js";
import { accountCredentialsPath, accountDir } from "../account-store.js";
import type { SwitchroomConfig } from "../../config/schema.js";

interface Harness {
  tmp: string;
  home: string;
  agentsDir: string;
  stateDir: string;
  socketRoot: string;
}

let harnesses: Harness[] = [];

function makeHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "auth-broker-mirror-enrich-test-"));
  const home = join(tmp, "home");
  const agentsDir = join(home, ".switchroom", "agents");
  const stateDir = join(home, ".switchroom", "state", "auth-broker");
  const socketRoot = join(tmp, "run", "switchroom", "auth-broker");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  const h: Harness = { tmp, home, agentsDir, stateDir, socketRoot };
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses) {
    try {
      rmSync(h.tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  harnesses = [];
});

function makeConfig(h: Harness, agents: Record<string, object>): SwitchroomConfig {
  return {
    switchroom: { version: 1, agents_dir: h.agentsDir },
    telegram: {},
    agents,
    auth: { active: "default" },
  } as unknown as SwitchroomConfig;
}

/**
 * Write a source-of-truth credentials.json by hand, bypassing
 * `writeAccountCredentials` — that's the situation we're testing.
 * Anything that ever wrote credentials before #1280 landed (legacy
 * slot setup, manual sudo-tee unstick, third-party export) produced
 * this shape.
 */
function writeStaleSourceCredentials(
  h: Harness,
  label: string,
  body: object,
): void {
  mkdirSync(accountDir(label, h.home), { recursive: true });
  writeFileSync(accountCredentialsPath(label, h.home), JSON.stringify(body));
}

describe("AuthBroker — mirror-time credential enrichment (residual #1280 gap)", () => {
  it("enriches a stale legacy source file at boot fanout (empty scopes + missing subscriptionType)", async () => {
    const h = makeHarness();
    writeStaleSourceCredentials(h, "default", {
      claudeAiOauth: {
        accessToken: "at-default",
        refreshToken: "rt-default",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000, // far future — refresh-tick won't fire
        scopes: [],
        // subscriptionType missing
      },
    });
    mkdirSync(join(h.agentsDir, "ziggy"), { recursive: true });

    const broker = new AuthBroker(makeConfig(h, { ziggy: {} }), {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();

    const mirror = JSON.parse(
      readFileSync(
        join(h.agentsDir, "ziggy", ".claude", ".credentials.json"),
        "utf-8",
      ),
    );
    // The per-agent mirror has the shape claude accepts.
    expect(mirror.claudeAiOauth.scopes).toEqual(["user:inference"]);
    expect(mirror.claudeAiOauth.subscriptionType).toBe("max");
    // Original fields preserved.
    expect(mirror.claudeAiOauth.accessToken).toBe("at-default");
    expect(mirror.claudeAiOauth.refreshToken).toBe("rt-default");

    // Source file is NOT mutated by mirror-time enrichment — that's
    // #1280's job at write-time. Stale source stays stale until
    // refresh-tick or another writer touches it.
    const source = JSON.parse(
      readFileSync(accountCredentialsPath("default", h.home), "utf-8"),
    );
    expect(source.claudeAiOauth.scopes).toEqual([]);
    expect(source.claudeAiOauth.subscriptionType).toBeUndefined();

    broker.stop();
  });

  it("passes through an already-enriched source file unchanged (byte-identical mirror)", async () => {
    const h = makeHarness();
    const enrichedBody = {
      claudeAiOauth: {
        accessToken: "at-default",
        refreshToken: "rt-default",
        expiresAt: Date.now() + 60_000,
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    };
    writeStaleSourceCredentials(h, "default", enrichedBody);
    mkdirSync(join(h.agentsDir, "ziggy"), { recursive: true });

    const broker = new AuthBroker(makeConfig(h, { ziggy: {} }), {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();

    const sourceContent = readFileSync(
      accountCredentialsPath("default", h.home),
      "utf-8",
    );
    const mirrorContent = readFileSync(
      join(h.agentsDir, "ziggy", ".claude", ".credentials.json"),
      "utf-8",
    );
    // Byte-for-byte identical when no enrichment is needed — keeps
    // operator tooling / audit snapshots stable.
    expect(mirrorContent).toBe(sourceContent);

    broker.stop();
  });
});
