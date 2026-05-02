/**
 * YAML editor for `switchroom telegram enable/disable` (#597).
 *
 * Pure module: takes a YAML string in, returns a YAML string out.
 * Uses the `yaml` package's Document API so comments and formatting
 * outside the edited path are preserved.
 *
 * The shape we edit: `agents.<name>.channels.telegram.<feature>` —
 * the cascade-canonical location after #596. Intermediate keys are
 * created on demand.
 */

import { parseDocument, type Document, isMap, type YAMLMap } from "yaml";

export type TelegramFeature = "voice_in" | "telegraph" | "webhook_sources";

/**
 * Set a feature payload under `agents.<agentName>.channels.telegram.<feature>`.
 * Creates intermediate maps if absent. Returns the new YAML string.
 *
 * Throws if the agent doesn't exist in the YAML — operators should
 * see "agent X not declared in switchroom.yaml" rather than have us
 * silently create an entry that wouldn't otherwise scaffold.
 */
export function setTelegramFeature(
  yamlText: string,
  agentName: string,
  feature: TelegramFeature,
  value: unknown,
): string {
  const doc = parseDocument(yamlText);
  ensureAgent(doc, agentName);
  doc.setIn(["agents", agentName, "channels", "telegram", feature], value);
  return String(doc);
}

/**
 * Remove a feature under `agents.<agentName>.channels.telegram.<feature>`.
 * No-op if the path doesn't exist. Trims now-empty parent maps so the
 * YAML doesn't accumulate `telegram: {}` debris over time.
 */
export function removeTelegramFeature(
  yamlText: string,
  agentName: string,
  feature: TelegramFeature,
): string {
  const doc = parseDocument(yamlText);
  if (!hasAgent(doc, agentName)) return yamlText;
  // doc.deleteIn throws if any intermediate path is missing, so check
  // first. No-op when the feature isn't currently set.
  if (!doc.hasIn(["agents", agentName, "channels", "telegram", feature])) {
    return yamlText;
  }
  doc.deleteIn(["agents", agentName, "channels", "telegram", feature]);

  // Prune empty parents — leaving `telegram: {}` after disable looks
  // weird and the cascade treats absent and empty the same.
  pruneEmptyMap(doc, ["agents", agentName, "channels", "telegram"]);
  pruneEmptyMap(doc, ["agents", agentName, "channels"]);
  return String(doc);
}

function ensureAgent(doc: Document, agentName: string): void {
  if (!hasAgent(doc, agentName)) {
    throw new Error(
      `agent '${agentName}' is not declared in switchroom.yaml under 'agents:'. Add it first via 'switchroom agent create' or hand-edit the file.`,
    );
  }
}

function hasAgent(doc: Document, agentName: string): boolean {
  const agents = doc.get("agents");
  if (!isMap(agents)) return false;
  return (agents as YAMLMap).has(agentName);
}

function pruneEmptyMap(doc: Document, path: string[]): void {
  const node = doc.getIn(path);
  if (isMap(node) && (node as YAMLMap).items.length === 0) {
    doc.deleteIn(path);
  }
}
