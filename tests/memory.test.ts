import { describe, it, expect } from "vitest";
import {
  generateHindsightMcpConfig,
  generateDockerComposeSnippet,
  getCollectionForAgent,
  isStrictIsolation,
} from "../src/memory/hindsight.js";
import { reflectAcrossAgents } from "../src/memory/search.js";
import type { ClerkConfig, MemoryBackendConfig } from "../src/config/schema.js";

function makeMemoryConfig(
  overrides: Partial<MemoryBackendConfig> = {},
): MemoryBackendConfig {
  return {
    backend: "hindsight",
    shared_collection: "shared",
    config: {
      provider: "ollama",
      docker_service: true,
    },
    ...overrides,
  };
}

function makeClerkConfig(
  agents: Record<string, any> = {},
  memory?: Partial<MemoryBackendConfig>,
): ClerkConfig {
  return {
    clerk: { version: 1, agents_dir: "~/.clerk/agents" },
    telegram: { bot_token: "test-token", forum_chat_id: "-100123" },
    memory: makeMemoryConfig(memory),
    agents,
  } as ClerkConfig;
}

describe("generateHindsightMcpConfig", () => {
  it("generates docker mode config", () => {
    const memConfig = makeMemoryConfig();
    const result = generateHindsightMcpConfig("my-collection", memConfig);

    expect(result.command).toBe("docker");
    expect(result.args).toEqual([
      "exec",
      "hindsight",
      "hindsight",
      "mcp",
      "--collection",
      "my-collection",
    ]);
    expect(result.env).toEqual({});
  });

  it("generates local mode config when docker_service is false", () => {
    const memConfig = makeMemoryConfig({
      config: { provider: "ollama", docker_service: false },
    });
    const result = generateHindsightMcpConfig("local-col", memConfig);

    expect(result.command).toBe("hindsight");
    expect(result.args).toEqual(["mcp", "--collection", "local-col"]);
    expect(result.env).toEqual({});
  });
});

describe("generateDockerComposeSnippet", () => {
  it("generates valid YAML snippet with provider and model", () => {
    const memConfig = makeMemoryConfig({
      config: {
        provider: "openai",
        model: "text-embedding-3-small",
        docker_service: true,
      },
    });
    const yaml = generateDockerComposeSnippet(memConfig);

    expect(yaml).toContain("image: vectorize/hindsight:latest");
    expect(yaml).toContain("LLM_PROVIDER=openai");
    expect(yaml).toContain("EMBEDDING_MODEL=text-embedding-3-small");
    expect(yaml).toContain("hindsight-data:/data");
    expect(yaml).toContain("restart: unless-stopped");
  });

  it("omits EMBEDDING_MODEL when model is not set", () => {
    const memConfig = makeMemoryConfig({
      config: { provider: "ollama", docker_service: true },
    });
    const yaml = generateDockerComposeSnippet(memConfig);

    expect(yaml).toContain("LLM_PROVIDER=ollama");
    expect(yaml).not.toContain("EMBEDDING_MODEL");
  });
});

describe("getCollectionForAgent", () => {
  it("returns explicit collection name from agent config", () => {
    const config = makeClerkConfig({
      coach: {
        template: "default",
        topic_name: "Coach",
        schedule: [],
        memory: { collection: "health-data", auto_recall: true, isolation: "default" },
      },
    });

    expect(getCollectionForAgent("coach", config)).toBe("health-data");
  });

  it("defaults to agent name when no collection is specified", () => {
    const config = makeClerkConfig({
      coach: {
        template: "default",
        topic_name: "Coach",
        schedule: [],
      },
    });

    expect(getCollectionForAgent("coach", config)).toBe("coach");
  });

  it("defaults to agent name when memory config is absent", () => {
    const config = makeClerkConfig({
      writer: {
        template: "default",
        topic_name: "Writer",
        schedule: [],
      },
    });

    expect(getCollectionForAgent("writer", config)).toBe("writer");
  });
});

describe("isStrictIsolation", () => {
  it("returns true for strict isolation", () => {
    const config = makeClerkConfig({
      journal: {
        template: "default",
        topic_name: "Journal",
        schedule: [],
        memory: { collection: "journal", auto_recall: true, isolation: "strict" },
      },
    });

    expect(isStrictIsolation("journal", config)).toBe(true);
  });

  it("returns false for default isolation", () => {
    const config = makeClerkConfig({
      coach: {
        template: "default",
        topic_name: "Coach",
        schedule: [],
        memory: { collection: "coach", auto_recall: true, isolation: "default" },
      },
    });

    expect(isStrictIsolation("coach", config)).toBe(false);
  });

  it("returns false when memory config is absent", () => {
    const config = makeClerkConfig({
      bot: {
        template: "default",
        topic_name: "Bot",
        schedule: [],
      },
    });

    expect(isStrictIsolation("bot", config)).toBe(false);
  });
});

describe("reflectAcrossAgents", () => {
  it("excludes strict agents from reflection", () => {
    const config = makeClerkConfig({
      coach: {
        template: "default",
        topic_name: "Coach",
        schedule: [],
        memory: { collection: "coach-data", auto_recall: true, isolation: "default" },
      },
      journal: {
        template: "default",
        topic_name: "Journal",
        schedule: [],
        memory: { collection: "journal-private", auto_recall: true, isolation: "strict" },
      },
      planner: {
        template: "default",
        topic_name: "Planner",
        schedule: [],
        memory: { collection: "planner", auto_recall: true, isolation: "default" },
      },
    });

    const result = reflectAcrossAgents(config);

    expect(result.eligible).toHaveLength(2);
    expect(result.eligible.map((e) => e.agent)).toEqual(["coach", "planner"]);

    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0].agent).toBe("journal");
    expect(result.excluded[0].collection).toBe("journal-private");

    expect(result.commands).toHaveLength(2);
    expect(result.commands[0]).toBe("hindsight reflect --collection coach-data");
    expect(result.commands[1]).toBe("hindsight reflect --collection planner");
  });

  it("returns empty eligible when all agents are strict", () => {
    const config = makeClerkConfig({
      secret: {
        template: "default",
        topic_name: "Secret",
        schedule: [],
        memory: { collection: "secret", auto_recall: true, isolation: "strict" },
      },
    });

    const result = reflectAcrossAgents(config);
    expect(result.eligible).toHaveLength(0);
    expect(result.excluded).toHaveLength(1);
    expect(result.commands).toHaveLength(0);
  });
});
