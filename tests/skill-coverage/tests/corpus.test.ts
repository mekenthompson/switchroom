/**
 * Determinism + shape tests for the corpus generator.
 *
 * Critical invariant: given the same fixture file + seed, the output
 * must be byte-stable. Authors rely on stable probe ids to track
 * which utterances have been graded by hand vs. machine.
 */

import { describe, expect, it } from "vitest";
import { generateCorpus, generateForSkill, probesToJsonl } from "../corpus/generate-corpus.js";
import type { SkillFixture } from "../corpus/types.js";

describe("generate-corpus", () => {
  it("is byte-stable across runs for the same seed", () => {
    const a = generateCorpus({ seed: 42 });
    const b = generateCorpus({ seed: 42 });
    expect(Object.keys(a.bySkill).sort()).toEqual(Object.keys(b.bySkill).sort());
    for (const skill of Object.keys(a.bySkill)) {
      expect(probesToJsonl(a.bySkill[skill])).toEqual(probesToJsonl(b.bySkill[skill]));
    }
  });

  it("produces different probes for different seeds", () => {
    const a = generateCorpus({ seed: 1 });
    const b = generateCorpus({ seed: 999 });
    // The ID hash mixes the seed in — at least one skill should
    // shift IDs. Spot-check the union of all ids.
    const idsA = Object.values(a.bySkill).flat().map((p) => p.id).sort();
    const idsB = Object.values(b.bySkill).flat().map((p) => p.id).sort();
    expect(idsA).not.toEqual(idsB);
  });

  it("skips out-of-scope skills (in_default_pool=false or user_invocable=false)", () => {
    const r = generateCorpus({ seed: 1 });
    expect(r.skipped).toContain("token-helpers");
    expect(r.skipped).toContain("switchroom-architecture");
    expect(r.bySkill["token-helpers"]).toBeUndefined();
    expect(r.bySkill["switchroom-architecture"]).toBeUndefined();
  });

  it("emits the expected per-skill probe distribution", () => {
    const mockSkills: SkillFixture[] = [
      {
        id: "alpha",
        category: "test",
        in_default_pool: true,
        user_invocable: true,
        description: "Alpha skill",
        trigger_phrases: ["do alpha", "perform alpha task"],
        negatives: [],
        adjacent_skills: ["beta"],
      },
      {
        id: "beta",
        category: "test",
        in_default_pool: true,
        user_invocable: true,
        description: "Beta skill",
        trigger_phrases: ["do beta", "perform beta task"],
        negatives: [],
        adjacent_skills: ["alpha"],
      },
    ];
    const probes = generateForSkill(mockSkills[0], mockSkills, 7);
    const byKind = {
      paraphrase: probes.filter((p) => p.kind === "paraphrase").length,
      typo: probes.filter((p) => p.kind === "typo").length,
      slang: probes.filter((p) => p.kind === "slang").length,
      indirect: probes.filter((p) => p.kind === "indirect").length,
      negative: probes.filter((p) => p.kind === "negative").length,
    };
    // The dedupe step can drop variants when templates collide on
    // short trigger sets. We assert lower bounds rather than exact
    // counts — with a 2-phrase mock fixture and one adjacent skill,
    // collision risk is high. The real corpus is keyed off skills
    // with 8–14 triggers and 2–4 adjacents and hits the documented
    // caps comfortably.
    expect(byKind.paraphrase).toBeGreaterThanOrEqual(3);
    expect(byKind.typo).toBeGreaterThanOrEqual(1);
    expect(byKind.slang).toBeGreaterThanOrEqual(2);
    expect(byKind.indirect).toBeGreaterThanOrEqual(2);
    expect(byKind.negative).toBeGreaterThanOrEqual(2);
  });

  it("assigns negative controls to adjacent skill triggers with expectedOtherSkill set", () => {
    const r = generateCorpus({ seed: 1, onlySkills: ["docx"] });
    const docx = r.bySkill["docx"] ?? [];
    const negatives = docx.filter((p) => p.kind === "negative");
    expect(negatives.length).toBeGreaterThan(0);
    for (const n of negatives) {
      expect(n.targetSkill).toBeNull();
      // negatives drawn from adjacent skills carry an expectedOtherSkill
      expect(n.expectedOtherSkill).toBeDefined();
      expect(["pdf", "xlsx", "pptx"]).toContain(n.expectedOtherSkill);
    }
  });

  it("hits documented per-category caps on real fixture-set skills", () => {
    // switchroom-cli has 20 triggers + 4 adjacents — comfortably
    // above the cap-collision threshold, so it should hit the full
    // 6/3/3/3/4 distribution.
    const r = generateCorpus({ seed: 1, onlySkills: ["switchroom-cli"] });
    const probes = r.bySkill["switchroom-cli"];
    const byKind = {
      paraphrase: probes.filter((p) => p.kind === "paraphrase").length,
      typo: probes.filter((p) => p.kind === "typo").length,
      slang: probes.filter((p) => p.kind === "slang").length,
      indirect: probes.filter((p) => p.kind === "indirect").length,
      negative: probes.filter((p) => p.kind === "negative").length,
    };
    expect(byKind.paraphrase).toBe(6);
    expect(byKind.typo).toBe(3);
    expect(byKind.slang).toBe(3);
    expect(byKind.indirect).toBe(3);
    expect(byKind.negative).toBe(4);
  });

  it("probe ids are 16-char hex and stable", () => {
    const r = generateCorpus({ seed: 1, onlySkills: ["docx"] });
    for (const p of r.bySkill["docx"]) {
      expect(p.id).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});
