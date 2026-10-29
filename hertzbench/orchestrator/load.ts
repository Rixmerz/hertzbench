// Reads a scenario file and turns the paths in it into absolute ones, so the
// rest of the orchestrator never depends on the working directory.

import { dirname, isAbsolute, join, resolve } from "node:path";
import type { OutputPaths } from "./runner.ts";
import { parseScenario, type Scenario, ScenarioError } from "./scenario.ts";

export interface LoadedScenario {
  scenario: Scenario;
  file: string;
  outDir: string;
  outputs: OutputPaths;
}

function resolveFrom(baseDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

/**
 * `outDirOverride` (the CLI's --out) wins over the scenario's `outputs`, so one
 * flag redirects everything a run writes.
 */
export async function loadScenario(file: string, outDirOverride?: string): Promise<LoadedScenario> {
  let text: string;
  try {
    text = await Deno.readTextFile(file);
  } catch (error) {
    // Windows reports a directory as "Incorrect function (os error 1)", not as IsADirectory.
    if ((await Deno.stat(file).catch(() => null))?.isDirectory) {
      throw new ScenarioError(`cannot read ${file}: it is a directory, not a scenario file`);
    }
    throw new ScenarioError(
      `cannot read ${file}: ${error instanceof Error ? error.message : error}`,
    );
  }
  const parsed = parseScenario(text);
  const baseDir = dirname(resolve(file));

  const scenario: Scenario = {
    ...parsed,
    ...(parsed.android !== null
      ? { android: { ...parsed.android, apk: resolveFrom(baseDir, parsed.android.apk) } }
      : {}),
    nodes: parsed.nodes.map((node) => ({
      ...node,
      firmware: node.firmware.kind === "script"
        ? node.firmware
        : { ...node.firmware, path: resolveFrom(baseDir, node.firmware.path) },
      ...(node.android?.instrument?.apk !== undefined
        ? {
          android: {
            ...node.android,
            instrument: {
              ...node.android.instrument,
              apk: resolveFrom(baseDir, node.android.instrument.apk),
            },
          },
        }
        : {}),
    })),
  };

  const outDir = outDirOverride !== undefined ? resolve(outDirOverride) : join(baseDir, "out");
  const pick = (configured: string | null, fallback: string) =>
    outDirOverride === undefined && configured !== null
      ? resolveFrom(baseDir, configured)
      : join(outDir, fallback);
  return {
    scenario,
    file: resolve(file),
    outDir,
    outputs: {
      metrics: pick(parsed.outputs.metrics, "metrics.json"),
      pcap: pick(parsed.outputs.pcap, "air.pcap"),
      events: pick(parsed.outputs.events, "events.jsonl"),
    },
  };
}

/** Check that the firmware a scenario names exists, so `validate` and `run` fail before any board starts. */
export async function checkFirmwareFiles(scenario: Scenario): Promise<string[]> {
  const missing: string[] = [];
  if (scenario.android !== null) {
    try {
      if (!(await Deno.stat(scenario.android.apk)).isFile) throw new Error("not a file");
    } catch {
      missing.push(`android: ${scenario.android.apk} is not an .apk file that exists`);
    }
  }
  for (const node of scenario.nodes) {
    const testApk = node.android?.instrument?.apk;
    if (testApk !== undefined) {
      try {
        if (!(await Deno.stat(testApk)).isFile) throw new Error("not a file");
      } catch {
        missing.push(`${node.id}: ${testApk} is not an .apk file that exists`);
      }
    }
    if (node.firmware.kind === "script") continue;
    try {
      const info = await Deno.stat(node.firmware.path);
      const wantDir = node.firmware.kind === "sketch";
      if (info.isDirectory !== wantDir) {
        missing.push(
          `${node.id}: ${node.firmware.path} should be a ${
            wantDir ? "sketch directory" : node.firmware.kind === "apk" ? ".apk file" : ".bin file"
          }`,
        );
      }
    } catch {
      missing.push(`${node.id}: ${node.firmware.path} does not exist`);
    }
  }
  return missing;
}
