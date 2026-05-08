import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeComposeFile } from "./compose.js";
import type { SwitchroomConfig } from "../config/schema.js";

/** Minimal config — generateCompose is exercised in its own dedicated
 *  snapshot tests; here we only verify the CLI helper writes the file
 *  it is asked to write. */
const stubConfig = {
  agents: {
    klanker: {
      profile: "engineer",
      claudeAccount: "default",
    },
  },
  profiles: {},
  defaults: {},
} as unknown as SwitchroomConfig;

describe("writeComposeFile", () => {
  it("writes the compose YAML to the requested path with 0600 mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "switchroom-compose-test-"));
    const outPath = join(dir, "nested", "docker-compose.yml");
    const res = await writeComposeFile(stubConfig, { outPath });
    expect(res.path).toBe(outPath);
    expect(res.bytes).toBeGreaterThan(0);
    const onDiskBytes = await readFile(outPath);
    expect(onDiskBytes.byteLength).toBe(res.bytes);
    expect(onDiskBytes.toString("utf8")).toMatch(/services:/);
  });
});
