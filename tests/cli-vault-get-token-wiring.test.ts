/**
 * Static-source guard pinning that the CLI's `vault get` and the
 * cascade-time vault-reference resolver BOTH read the capability
 * token file and forward it via `getViaBrokerStructured`.
 *
 * Lives at the integration-shape layer that the unit-level test
 * `src/vault/broker/client-get-token.test.ts` can't reach: the
 * client unit test proves the wire payload is correct when the
 * caller passes a token, but it can't catch the case where the
 * caller never bothers to read the token in the first place —
 * which is exactly how #1053 got past code review.
 *
 * This file pins the call-site wiring. If a future refactor moves
 * `vault get` to a different code path that forgets to read the
 * token file, this test fails loudly with a recognizable message
 * pointing at the regression class.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");

describe("vault get CLI forwards the agent's capability token (#1053 regression guard)", () => {
  const cliSrc = readFileSync(resolve(REPO_ROOT, "src/cli/vault.ts"), "utf-8");

  it("the get-via-broker call site reads the agent's token file", () => {
    // Locate the broker get call by anchor; the surrounding window
    // MUST mention readVaultTokenFile.
    const ix = cliSrc.indexOf("getViaBrokerStructured(");
    expect(ix, "expected getViaBrokerStructured call site in src/cli/vault.ts").toBeGreaterThan(0);
    const window = cliSrc.slice(Math.max(0, ix - 600), ix + 200);
    // The call must be preceded by a token read.
    expect(
      window,
      "vault get's broker-call site must read the agent's .vault-token (readVaultTokenFile) — see #1053",
    ).toMatch(/readVaultTokenFile/);
    // And the resolved token must be passed on the call.
    expect(
      window,
      "vault get's broker-call site must forward the token in opts (e.g. token: getToken)",
    ).toMatch(/token:\s*(getToken|token)/);
  });
});

describe("vault-reference resolver forwards the agent's capability token (#1053 regression guard)", () => {
  const resolverSrc = readFileSync(
    resolve(REPO_ROOT, "src/vault/resolver.ts"),
    "utf-8",
  );

  it("the cascade-time resolver reads the token before its per-key loop", () => {
    const ix = resolverSrc.indexOf("getViaBrokerStructured(");
    expect(ix, "expected getViaBrokerStructured call site in src/vault/resolver.ts").toBeGreaterThan(0);
    const window = resolverSrc.slice(Math.max(0, ix - 600), ix + 100);
    // Resolver must read SWITCHROOM_AGENT_NAME and the token file
    // (mirrors the CLI path); without this, agents that need
    // grant-authorized cascade refs at startup hit the same #1053
    // class of bug.
    expect(window).toMatch(/SWITCHROOM_AGENT_NAME/);
    expect(window).toMatch(/readVaultTokenFile/);
    expect(window).toMatch(/token/);
  });
});
