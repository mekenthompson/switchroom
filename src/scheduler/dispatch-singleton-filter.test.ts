/**
 * Phase 3 dual-run safety: the singleton scheduler must skip any
 * agent whose cascade-resolved `experimental.inline_scheduler` is
 * true. Mutual exclusion with the in-container scheduler — never
 * dual-fire.
 *
 * Companion to `dispatch-inbound.test.ts` — both target small,
 * pure helpers in `dispatch.ts`.
 */

import { describe, it, expect } from "vitest";
import {
  collectScheduleEntries,
  filterForSingleton,
  inlineScheduledAgents,
} from "./dispatch.js";
import type { SwitchroomConfig } from "../config/schema.js";

function makeConfig(opts: {
  agents: Record<string, {
    schedule?: Array<{ cron: string; prompt: string; secrets?: string[] }>;
    experimental?: { inline_scheduler?: boolean };
    extends?: string;
  }>;
  defaults?: { experimental?: { inline_scheduler?: boolean } };
  profiles?: Record<string, { experimental?: { inline_scheduler?: boolean } }>;
}): SwitchroomConfig {
  // Build a structurally complete SwitchroomConfig with the absolute
  // minimum fields the helpers under test actually read. Cast through
  // unknown to avoid restating the entire schema's required fields
  // when only a slice of it is exercised.
  const built = {
    switchroom: { version: 1 as const, agents_dir: "/tmp", skills_dir: "/tmp" },
    telegram: { bot_token: "x", forum_chat_id: "-1" },
    agents: Object.fromEntries(
      Object.entries(opts.agents).map(([name, raw]) => [
        name,
        {
          schedule: (raw.schedule ?? []).map((e) => ({ ...e, secrets: e.secrets ?? [] })),
          experimental: raw.experimental,
          ...(raw.extends ? { extends: raw.extends } : {}),
        },
      ]),
    ),
    profiles: opts.profiles ?? {},
    defaults: opts.defaults ?? {},
  };
  return built as unknown as SwitchroomConfig;
}

describe("inlineScheduledAgents", () => {
  it("returns the set of agents with experimental.inline_scheduler === true", () => {
    const config = makeConfig({
      agents: {
        alice: { experimental: { inline_scheduler: true } },
        bob: {},
        carol: { experimental: { inline_scheduler: false } },
        dave: { experimental: { inline_scheduler: true } },
      },
    });
    expect(inlineScheduledAgents(config)).toEqual(new Set(["alice", "dave"]));
  });

  it("returns an empty set when no agent has the flag", () => {
    const config = makeConfig({
      agents: {
        alice: {},
        bob: { experimental: {} },
      },
    });
    expect(inlineScheduledAgents(config).size).toBe(0);
  });

  it("treats a missing experimental block as inline=false (default)", () => {
    const config = makeConfig({ agents: { alice: {} } });
    expect(inlineScheduledAgents(config).has("alice")).toBe(false);
  });
});

describe("filterForSingleton", () => {
  const sampleEntries = (config: SwitchroomConfig) => collectScheduleEntries(config);

  it("returns entries unchanged when no agent is inline-scheduled", () => {
    const config = makeConfig({
      agents: {
        alice: { schedule: [{ cron: "0 8 * * *", prompt: "p1" }] },
        bob: { schedule: [{ cron: "0 9 * * *", prompt: "p2" }] },
      },
    });
    const all = sampleEntries(config);
    expect(filterForSingleton(all, config)).toEqual(all);
  });

  it("drops entries for inline-scheduled agents and keeps the others", () => {
    const config = makeConfig({
      agents: {
        alice: {
          schedule: [{ cron: "0 8 * * *", prompt: "alice-1" }],
          experimental: { inline_scheduler: true },
        },
        bob: {
          schedule: [
            { cron: "0 9 * * *", prompt: "bob-1" },
            { cron: "0 10 * * *", prompt: "bob-2" },
          ],
        },
        carol: {
          schedule: [{ cron: "0 11 * * *", prompt: "carol-1" }],
          experimental: { inline_scheduler: true },
        },
      },
    });
    const all = sampleEntries(config);
    expect(all).toHaveLength(4);
    const filtered = filterForSingleton(all, config);
    expect(filtered).toHaveLength(2);
    expect(filtered.map((e) => e.agent)).toEqual(["bob", "bob"]);
    expect(filtered.map((e) => e.prompt)).toEqual(["bob-1", "bob-2"]);
  });

  it("returns the original array when nothing is inline (no needless copy)", () => {
    const config = makeConfig({
      agents: { alice: { schedule: [{ cron: "0 8 * * *", prompt: "p" }] } },
    });
    const all = sampleEntries(config);
    expect(filterForSingleton(all, config)).toBe(all);
  });
});

/**
 * Cascade tests — `experimental.inline_scheduler` MUST cascade
 * defaults → profile → per-agent (the schema doc-comment promises
 * it; Phase 4's planned default-flip relies on it). These tests
 * pin that promise. The merge clause that makes them pass lives
 * in `src/config/merge.ts:mergeAgentConfig`'s experimental block.
 */
describe("inlineScheduledAgents — cascade behavior", () => {
  it("cascades from defaults: a flag set in defaults flips every agent", () => {
    const config = makeConfig({
      defaults: { experimental: { inline_scheduler: true } },
      agents: {
        alice: { schedule: [{ cron: "0 8 * * *", prompt: "p" }] },
        bob: { schedule: [{ cron: "0 9 * * *", prompt: "q" }] },
      },
    });
    expect(inlineScheduledAgents(config)).toEqual(new Set(["alice", "bob"]));
  });

  it("per-agent override wins over defaults (false at agent unsets a true default)", () => {
    const config = makeConfig({
      defaults: { experimental: { inline_scheduler: true } },
      agents: {
        alice: { experimental: { inline_scheduler: false } },
        bob: {},
      },
    });
    // alice explicitly opts out; bob inherits the default true.
    expect(inlineScheduledAgents(config)).toEqual(new Set(["bob"]));
  });

  it("cascades from a profile: extends + flag-on-profile flips the agent", () => {
    const config = makeConfig({
      profiles: {
        canary_pool: { experimental: { inline_scheduler: true } },
      },
      agents: {
        alice: { extends: "canary_pool" },
        bob: {},
      },
    });
    expect(inlineScheduledAgents(config)).toEqual(new Set(["alice"]));
  });

  it("per-agent override wins over profile (false at agent unsets a true profile)", () => {
    const config = makeConfig({
      profiles: {
        canary_pool: { experimental: { inline_scheduler: true } },
      },
      agents: {
        alice: {
          extends: "canary_pool",
          experimental: { inline_scheduler: false },
        },
      },
    });
    expect(inlineScheduledAgents(config).size).toBe(0);
  });
});
