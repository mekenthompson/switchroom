import type { Command } from "commander";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { withConfigError, getConfig } from "./helpers.js";
import { resolveAgentsDir } from "../config/loader.js";
import { resolveAgentConfig } from "../config/merge.js";
import { resolveAgentWorkspaceDir } from "../agents/workspace.js";
import { renderSoulMd } from "../agents/scaffold.js";
import { getProfilePath } from "../agents/profiles.js";
import { DEFAULT_PROFILE } from "../config/schema.js";
import { askYesNo, isInteractive } from "../setup/prompt.js";

/**
 * `switchroom soul` — manage an agent's persona file.
 *
 * SOUL.md is user-owned: seeded once from the profile, then never
 * overwritten by scaffold/reconcile/update (the deliberate inverse of
 * CLAUDE.md, which stays switchroom-managed). These commands let the
 * operator inspect it and, on demand, re-seed it from the current
 * profile — backing the old one up first so a reset is recoverable.
 */

interface ResolvedSoulTarget {
  agentName: string;
  profileName: string;
  profilePath: string;
  workspaceDir: string;
  soulPath: string;
  soul: unknown;
}

function resolveSoulTargetOrExit(
  program: Command,
  agentName: string,
): ResolvedSoulTarget | undefined {
  const config = getConfig(program);
  const agentConfig = config.agents[agentName];
  if (!agentConfig) {
    console.error(`soul: agent "${agentName}" not defined in switchroom.yaml`);
    process.exit(1);
  }

  const merged = resolveAgentConfig(
    config.defaults,
    config.profiles,
    agentConfig,
  );
  const profileName = merged.extends ?? DEFAULT_PROFILE;
  const profilePath = getProfilePath(profileName);

  const agentsDir = resolveAgentsDir(config);
  const agentDir = resolve(agentsDir, agentName);
  const workspaceDir = resolveAgentWorkspaceDir(agentDir);
  if (!existsSync(workspaceDir)) {
    console.error(
      `soul: ${workspaceDir} does not exist yet. Run \`switchroom setup\` ` +
        `or \`switchroom agent scaffold ${agentName}\` to seed it.`,
    );
    process.exit(1);
  }

  return {
    agentName,
    profileName,
    profilePath,
    workspaceDir,
    soulPath: join(workspaceDir, "SOUL.md"),
    soul: (merged as { soul?: unknown }).soul,
  };
}

export function registerSoulCommand(program: Command): void {
  const cmd = program
    .command("soul")
    .description(
      "Manage an agent's persona file (workspace/SOUL.md, user-owned)",
    );

  cmd
    .command("path <agent>")
    .description("Print the path to the agent's SOUL.md")
    .action(
      withConfigError(async (agentName: string) => {
        const t = resolveSoulTargetOrExit(program, agentName);
        if (!t) return;
        process.stdout.write(`${t.soulPath}\n`);
      }),
    );

  cmd
    .command("show <agent>")
    .description("Print the agent's current SOUL.md to stdout")
    .action(
      withConfigError(async (agentName: string) => {
        const t = resolveSoulTargetOrExit(program, agentName);
        if (!t) return;
        if (!existsSync(t.soulPath)) {
          console.error(
            `soul: ${t.soulPath} does not exist yet — run ` +
              `\`switchroom soul reset ${agentName}\` to seed it.`,
          );
          process.exit(1);
        }
        process.stdout.write(readFileSync(t.soulPath, "utf-8"));
      }),
    );

  cmd
    .command("reset <agent>")
    .description(
      "Re-seed SOUL.md from the agent's current profile " +
        "(backs the existing file up to SOUL.md.bak first)",
    )
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(
      withConfigError(
        async (agentName: string, opts: { yes?: boolean }) => {
          const t = resolveSoulTargetOrExit(program, agentName);
          if (!t) return;

          const content = renderSoulMd(t.profilePath, t.workspaceDir, t.soul);
          if (content === null) {
            console.error(
              `soul: profile "${t.profileName}" ships no SOUL.md.hbs — ` +
                `nothing to re-seed from.`,
            );
            process.exit(1);
          }

          const exists = existsSync(t.soulPath);
          if (exists && !opts.yes) {
            if (!isInteractive()) {
              console.error(
                `soul: ${t.soulPath} already exists. Re-run with --yes to ` +
                  `replace it (the current file is backed up to SOUL.md.bak).`,
              );
              process.exit(1);
            }
            const ok = await askYesNo(
              `Replace ${agentName}'s SOUL.md by re-seeding from profile ` +
                `"${t.profileName}"? The current file is backed up first.`,
              false,
            );
            if (!ok) {
              console.log("soul: reset aborted, nothing changed.");
              return;
            }
          }

          let backupPath: string | undefined;
          if (exists) {
            backupPath = `${t.soulPath}.bak`;
            if (existsSync(backupPath)) {
              backupPath = `${t.soulPath}.bak.${Date.now()}`;
            }
            copyFileSync(t.soulPath, backupPath);
          }

          writeFileSync(t.soulPath, content, "utf-8");

          if (backupPath) {
            console.log(
              `soul: re-seeded ${agentName}'s SOUL.md from profile ` +
                `"${t.profileName}".\n` +
                `      Previous version saved to ${backupPath}`,
            );
          } else {
            console.log(
              `soul: seeded ${agentName}'s SOUL.md from profile ` +
                `"${t.profileName}".`,
            );
          }
          console.log(
            "      SOUL.md is yours — edit it freely; `switchroom update` " +
              "won't overwrite it.",
          );
        },
      ),
    );
}
