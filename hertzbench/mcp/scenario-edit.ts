// Edits to a scenario file as its author wrote it: on the YAML document, before
// `count:` expands a node into several, so a node is the entry with that `id`.
// The edited text must parse as a scenario before anything is written; the
// caller writes it. Comments and the original layout are not kept.

import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { parseScenario, type Scenario, ScenarioError } from "../orchestrator/scenario.ts";
import { ToolError } from "./protocol.ts";

type Doc = Record<string, unknown>;

export interface ScenarioEdit {
  /** JSON merge patch (RFC 7396) on the top level, `nodes` excepted: null removes a key, arrays are replaced whole. */
  set?: Record<string, unknown>;
  /** Merge patch per node, by its `id`; null removes the node. */
  nodes?: Record<string, unknown>;
  /** New node entries, appended in this order. */
  add?: Record<string, unknown>[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Keys that would reach an object's prototype through a plain assignment (CWE-1321).
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** RFC 7396: objects merge key by key, null deletes, anything else replaces. */
export function mergePatch(target: unknown, patch: unknown, path = "patch"): unknown {
  if (!isObject(patch)) return patch;
  const out: Record<string, unknown> = isObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (FORBIDDEN_KEYS.has(key)) throw new ToolError(`${path}: the key ${key} is not allowed`);
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value, `${path}.${key}`);
  }
  return out;
}

function parseDocument(text: string, file: string): Doc {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (error) {
    throw new ToolError(
      `${file} is not valid YAML: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (!isObject(doc)) throw new ToolError(`${file} is not a scenario: its top level is not a map`);
  return doc;
}

function nodeEntries(doc: Doc): Record<string, unknown>[] {
  const nodes = doc.nodes ?? [];
  if (!Array.isArray(nodes) || !nodes.every(isObject)) {
    throw new ToolError("nodes must be a list of node entries");
  }
  return nodes;
}

/** The index of the entry declared with `id`; a name that `count:` expanded is refused with its group. */
function entryIndex(nodes: Record<string, unknown>[], id: string): number {
  const index = nodes.findIndex((n) => n.id === id);
  if (index >= 0) return index;
  const group = nodes.find((n) =>
    typeof n.id === "string" && typeof n.count === "number" && id.startsWith(`${n.id}-`) &&
    Number(id.slice(n.id.length + 1)) >= 1 && Number(id.slice(n.id.length + 1)) <= n.count
  );
  if (group) {
    throw new ToolError(
      `${id} is one of the ${group.count} nodes of the group ${group.id} (count: ${group.count}); ` +
        `edit the group by its id ${group.id}, or lower its count`,
    );
  }
  const declared = nodes.map((n) => String(n.id)).join(", ");
  throw new ToolError(`no node entry with id ${JSON.stringify(id)} (entries: ${declared})`);
}

/**
 * The scenario text after `edit`, with the scenario it parses to. Refused with
 * the scenario's own error, naming the field, when the result is not valid.
 */
export function editScenarioText(
  text: string,
  file: string,
  edit: ScenarioEdit,
): { text: string; scenario: Scenario } {
  let doc = parseDocument(text, file);
  if (edit.set !== undefined) {
    if ("nodes" in edit.set) {
      throw new ToolError("set cannot replace nodes; use nodes (by id), add_node or remove_node");
    }
    doc = mergePatch(doc, edit.set, "set") as Doc;
  }
  const nodes = nodeEntries(doc);
  for (const [id, patch] of Object.entries(edit.nodes ?? {})) {
    if (FORBIDDEN_KEYS.has(id)) throw new ToolError(`nodes: the key ${id} is not allowed`);
    const index = entryIndex(nodes, id);
    if (patch === null) {
      nodes.splice(index, 1);
      continue;
    }
    if (!isObject(patch)) throw new ToolError(`nodes.${id} must be an object or null`);
    if ("id" in patch && patch.id !== id) {
      throw new ToolError(`nodes.${id}: renaming a node is not an edit; remove it and add it`);
    }
    nodes[index] = mergePatch(nodes[index], patch, `nodes.${id}`) as Record<string, unknown>;
  }
  for (const [i, entry] of (edit.add ?? []).entries()) {
    if (!isObject(entry)) throw new ToolError(`add[${i}] must be a node entry`);
    const id = entry.id;
    if (typeof id !== "string" || id === "") throw new ToolError(`add[${i}].id must be a string`);
    if (nodes.some((n) => n.id === id)) {
      throw new ToolError(`a node entry with id ${JSON.stringify(id)} already exists`);
    }
    nodes.push(mergePatch({}, entry, `add[${i}]`) as Record<string, unknown>);
  }
  doc = { ...doc, nodes };
  const edited = stringifyYaml(doc, { lineWidth: 100 });
  try {
    return { text: edited, scenario: parseScenario(edited) };
  } catch (error) {
    if (error instanceof ScenarioError) {
      throw new ToolError(
        `the edited scenario is not valid, nothing was written: ${error.message}`,
      );
    }
    throw error;
  }
}
