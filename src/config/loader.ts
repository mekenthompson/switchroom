import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ZodError } from "zod";
import { ClerkConfigSchema, type ClerkConfig } from "./schema.js";

export class ConfigError extends Error {
  constructor(
    message: string,
    public details?: string[]
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

function formatZodErrors(error: ZodError): string[] {
  return error.errors.map((e) => {
    const path = e.path.join(".");
    return `  ${path}: ${e.message}`;
  });
}

export function findConfigFile(startDir?: string): string {
  const searchPaths = [
    startDir ? resolve(startDir, "clerk.yaml") : null,
    startDir ? resolve(startDir, "clerk.yml") : null,
    resolve(process.cwd(), "clerk.yaml"),
    resolve(process.cwd(), "clerk.yml"),
  ].filter(Boolean) as string[];

  for (const path of searchPaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  throw new ConfigError(
    "No clerk.yaml found",
    searchPaths.map((p) => `  Searched: ${p}`)
  );
}

export function loadConfig(configPath?: string): ClerkConfig {
  const filePath = configPath ?? findConfigFile();

  if (!existsSync(filePath)) {
    throw new ConfigError(`Config file not found: ${filePath}`);
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new ConfigError(`Failed to read config file: ${filePath}`, [
      `  ${(err as Error).message}`,
    ]);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new ConfigError(`Invalid YAML in ${filePath}`, [
      `  ${(err as Error).message}`,
    ]);
  }

  try {
    return ClerkConfigSchema.parse(parsed);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new ConfigError("Invalid clerk.yaml configuration", formatZodErrors(err));
    }
    throw err;
  }
}

export function resolveAgentsDir(config: ClerkConfig): string {
  const dir = config.clerk.agents_dir;
  if (dir.startsWith("~/")) {
    return resolve(process.env.HOME ?? "/root", dir.slice(2));
  }
  return resolve(dir);
}

export function resolvePath(pathStr: string): string {
  if (pathStr.startsWith("~/")) {
    return resolve(process.env.HOME ?? "/root", pathStr.slice(2));
  }
  return resolve(pathStr);
}
