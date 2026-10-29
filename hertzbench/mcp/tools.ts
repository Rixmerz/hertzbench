// The tools and resources the MCP server offers. Each tool checks its own
// arguments here, at the trust boundary, then calls the orchestrator through
// the session. Scenario and board errors become tool errors the model can read
// and act on.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT } from "../brand.ts";
import { BoardError } from "../orchestrator/boards/board.ts";
import { ESP32_FIDELITY, resolveQemuLibrary } from "../orchestrator/boards/qemu-esp32.ts";
import { scriptedLauncher } from "../orchestrator/boards/scripted.ts";
import { checkFirmwareFiles, loadScenario } from "../orchestrator/load.ts";
import { renderReport } from "../orchestrator/report.ts";
import { CAPTURE_KINDS, type CaptureKind } from "../orchestrator/runner.ts";
import { viewState } from "../view/scene.ts";
import { EVENT_TYPES } from "../engine/mod.ts";
import {
  BOARD_NAMES,
  CHANNEL_FIELDS,
  MQTT_PORT,
  mqttTopic,
  parseChannelChanges,
  parseLinkRule,
  parsePosition,
  parseScenario,
  type Scenario,
  ScenarioError,
  UDP_PORT,
} from "../orchestrator/scenario.ts";
import { type ResourceDefinition, type ToolDefinition, ToolError } from "./protocol.ts";
import { editScenarioText, type ScenarioEdit } from "./scenario-edit.ts";
import type { Session } from "./session.ts";

type Args = Record<string, unknown>;

function known(args: Args, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new ToolError(`unknown argument ${key} (allowed: ${allowed.join(", ") || "none"})`);
    }
  }
}

function requiredText(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value === "") {
    throw new ToolError(`${key} must be a non-empty string`);
  }
  return value;
}

function optionalText(args: Args, key: string): string | null {
  return args[key] === undefined ? null : requiredText(args, key);
}

function optionalInt(args: Args, key: string, min: number, max: number): number | null {
  const value = args[key];
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ToolError(`${key} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function optionalNumber(args: Args, key: string, min: number, max: number): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new ToolError(`${key} must be a number from ${min} to ${max}`);
  }
  return value;
}

function optionalBoolean(args: Args, key: string): boolean | null {
  const value = args[key];
  if (value === undefined) return null;
  if (typeof value !== "boolean") throw new ToolError(`${key} must be true or false`);
  return value;
}

function oneOf<T extends string>(args: Args, key: string, allowed: readonly T[]): T {
  const value = args[key];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ToolError(`${key} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

/** Most bytes one send_serial call carries: a few console lines, not a firmware image. */
const MAX_SERIAL_BYTES = 4096;

/** The bytes of send_serial: `text` (with a newline unless told not to) or `data_base64`. */
function serialBytes(args: Args): Uint8Array {
  const text = args.text;
  const data = args.data_base64;
  if ((text === undefined) === (data === undefined)) {
    throw new ToolError("give exactly one of text or data_base64");
  }
  let bytes: Uint8Array;
  if (text !== undefined) {
    if (typeof text !== "string") throw new ToolError("text must be a string");
    const newline = optionalBoolean(args, "newline") ?? true;
    bytes = new TextEncoder().encode(newline ? `${text}\n` : text);
  } else {
    if (args.newline !== undefined) throw new ToolError("newline applies to text only");
    if (typeof data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      throw new ToolError("data_base64 must be base64");
    }
    try {
      bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    } catch {
      throw new ToolError("data_base64 must be base64");
    }
  }
  if (bytes.length === 0) throw new ToolError("nothing to send");
  if (bytes.length > MAX_SERIAL_BYTES) {
    throw new ToolError(`at most ${MAX_SERIAL_BYTES} bytes per call, got ${bytes.length}`);
  }
  return bytes;
}

/** Most bytes one mqtt_publish or send_payload call carries; each transport may allow less. */
const MAX_PAYLOAD_BYTES = 4096;

/** A payload argument as bytes. `allowEmpty`: an empty retained MQTT message clears its topic. */
function payloadBytes(args: Args, allowEmpty: boolean): Uint8Array {
  const payload = args.payload;
  if (typeof payload !== "string") throw new ToolError("payload must be a string");
  const bytes = new TextEncoder().encode(payload);
  if (bytes.length === 0 && !allowEmpty) throw new ToolError("payload must be a non-empty string");
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    throw new ToolError(`at most ${MAX_PAYLOAD_BYTES} bytes per call, got ${bytes.length}`);
  }
  return bytes;
}

/** Scenario and board errors are the caller's to fix: report them, do not crash. */
async function expected<T>(body: () => Promise<T> | T): Promise<T> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof ScenarioError || error instanceof BoardError) {
      throw new ToolError(error.message);
    }
    // The file mode of a path the caller chose. Deno's own permission flags throw NotCapable instead.
    if (error instanceof Deno.errors.PermissionDenied) throw new ToolError(error.message);
    throw error;
  }
}

function summary(scenario: Scenario) {
  return {
    name: scenario.name,
    seed: scenario.seed,
    duration_ms: scenario.durationMs,
    nodes: scenario.nodes.map((n) => ({
      id: n.id,
      board: n.board,
      ip: n.ip,
      position: n.position,
      phy: n.radio.phy,
      channel: "channel" in n.radio ? n.radio.channel : null,
      on_medium: !n.internetGateway,
      firmware: n.firmware.kind === "script" ? "script" : n.firmware.path,
    })),
    links: scenario.links.length,
    timeline: scenario.timeline.length,
    assertions: scenario.assertions.length,
  };
}

/** Firmware paths of scenario text resolve from `baseDir`, as loadScenario does for a file. */
function withFirmwareFrom(scenario: Scenario, baseDir: string): Scenario {
  return {
    ...scenario,
    nodes: scenario.nodes.map((node) => ({
      ...node,
      firmware: node.firmware.kind === "script"
        ? node.firmware
        : { ...node.firmware, path: resolve(baseDir, node.firmware.path) },
    })),
  };
}

const POSITION_SCHEMA = {
  type: "array",
  items: { type: "number" },
  minItems: 2,
  maxItems: 3,
  description: "[x, y] or [x, y, z] in metres",
};

const PHASE_SCHEMA = {
  type: "string",
  description:
    "Start a metrics phase with this label at the same instant, so get_metrics can compare before and after",
};

function optionalObject(args: Args, key: string): Record<string, unknown> | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolError(`${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

const EDIT_NOTE = "the file was rewritten from its data: comments and the original layout are gone";

/** A scenario file's text. A path that names no readable file is the caller's to fix. */
async function readScenarioFile(file: string, missing: string): Promise<string> {
  try {
    return await Deno.readTextFile(file);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) throw new ToolError(missing);
    if (error instanceof Deno.errors.IsADirectory) {
      throw new ToolError(`${file} is a directory, not a scenario file`);
    }
    if (error instanceof Deno.errors.PermissionDenied) {
      throw new ToolError(`${file} cannot be read: permission denied`);
    }
    // Windows reports a directory as "Incorrect function (os error 1)", not as IsADirectory.
    if ((await Deno.stat(file).catch(() => null))?.isDirectory) {
      throw new ToolError(`${file} is a directory, not a scenario file`);
    }
    throw error;
  }
}

/** Starts the view of the session on a loopback port, or returns the one already serving it. */
export type ViewOpener = (port: number) => { url: string; already_open: boolean };

export function tools(session: Session, openView?: ViewOpener): ToolDefinition[] {
  /** Apply `edit` to the scenario file at `path`, inside the workspace, after checking the result. */
  const editFile = async (path: string, edit: ScenarioEdit) => {
    if (!/\.ya?ml$/.test(path)) throw new ToolError("path must end in .yaml or .yml");
    const file = await session.writablePath(path, "path", "file");
    const text = await readScenarioFile(
      file,
      `${file} does not exist; create_scenario writes a new one`,
    );
    const edited = editScenarioText(text, file, edit);
    await session.replaceFile(file, edited.text);
    const missing = await checkFirmwareFiles(withFirmwareFrom(edited.scenario, dirname(file)));
    return { file, scenario: summary(edited.scenario), missing_firmware: missing, note: EDIT_NOTE };
  };

  return [
    {
      name: "list_boards",
      description:
        "Board kinds a scenario can use, the names it may give them, their fidelity level, and whether this host can run them.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      call: (args) => {
        known(args, []);
        let esp32: { available: boolean; detail: string };
        try {
          esp32 = { available: true, detail: `libqemu-xtensa at ${resolveQemuLibrary()}` };
        } catch (error) {
          if (!(error instanceof BoardError)) throw error;
          esp32 = { available: false, detail: error.message };
        }
        return Promise.resolve({
          boards: [
            {
              board: "esp32",
              names: BOARD_NAMES.esp32,
              fidelity: ESP32_FIDELITY,
              firmware: "a sketch directory (compiled with Velxio's ESP-IDF chain) or a .bin",
              ...esp32,
            },
            {
              board: "scripted",
              names: BOARD_NAMES.scripted,
              fidelity: scriptedLauncher.fidelity,
              firmware: "firmware: { send: [{ to, every, count, start?, port?, payload? }] }",
              available: true,
              detail: "needs only Deno; plays DHCP, UDP pings and pongs, no emulator",
            },
          ],
          not_supported: [
            {
              names: ["esp32-c3*", "esp32-s3*"],
              reason:
                "the C3 asserts in eFuse reload when a NIC is attached; the S3 machine models no radio",
            },
          ],
          fidelity_table: `${PRODUCT.slug}://docs/fidelity.md`,
        });
      },
    },
    {
      name: "validate_scenario",
      description:
        "Check a scenario without running it: give `path` (a YAML file) or `yaml` (the text). Returns the expanded nodes with their addresses, or the first error with its field path. Firmware paths are checked too.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Scenario file, relative to the workspace" },
          yaml: {
            type: "string",
            description: "Scenario text; firmware paths resolve from the workspace",
          },
        },
        additionalProperties: false,
      },
      call: (args) =>
        expected(async () => {
          known(args, ["path", "yaml"]);
          const path = optionalText(args, "path");
          const yaml = optionalText(args, "yaml");
          if ((path === null) === (yaml === null)) {
            throw new ToolError("give exactly one of path or yaml");
          }
          const file = path === null ? null : await session.readablePath(path, "path");
          const scenario = file !== null
            ? (await loadScenario(file)).scenario
            : withFirmwareFrom(parseScenario(yaml as string), session.workspace);
          const missing = await checkFirmwareFiles(scenario);
          if (missing.length > 0) {
            throw new ToolError(`firmware not found\n  ${missing.join("\n  ")}`);
          }
          return { ok: true, file, scenario: summary(scenario) };
        }),
    },
    {
      name: "create_scenario",
      description:
        `Write a scenario YAML file inside the workspace after validating it. Invalid text is refused and nothing is written. Read the resource ${PRODUCT.slug}://docs/scenario-format.md for the format and ${PRODUCT.slug}://examples/* for examples. Firmware paths in the file resolve from the file's own directory; missing firmware is reported, not refused, so the scenario can come first.`,
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Where to write it, relative to the workspace; ends in .yaml or .yml",
          },
          yaml: { type: "string", description: "The scenario" },
          overwrite: { type: "boolean", description: "Replace an existing file. Default false." },
        },
        required: ["path", "yaml"],
        additionalProperties: false,
      },
      call: (args) =>
        expected(async () => {
          known(args, ["path", "yaml", "overwrite"]);
          const path = requiredText(args, "path");
          const yaml = requiredText(args, "yaml");
          if (args.overwrite !== undefined && typeof args.overwrite !== "boolean") {
            throw new ToolError("overwrite must be true or false");
          }
          if (!/\.ya?ml$/.test(path)) throw new ToolError("path must end in .yaml or .yml");
          const parsed = parseScenario(yaml);
          const file = await session.writablePath(path, "path", "file");
          try {
            await Deno.writeTextFile(file, yaml, { createNew: args.overwrite !== true });
          } catch (error) {
            if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
            throw new ToolError(`${file} exists; pass overwrite: true to replace it`);
          }
          const missing = await checkFirmwareFiles(withFirmwareFrom(parsed, dirname(file)));
          return { file, scenario: summary(parsed), missing_firmware: missing };
        }),
    },
    {
      name: "read_scenario",
      description:
        "The text of a scenario file and what it parses to: its nodes with their addresses, positions, radios and firmware, or the first error with its field path. Use it before edit_scenario.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Scenario file, relative to the workspace" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      call: async (args) => {
        known(args, ["path"]);
        const file = await session.readablePath(requiredText(args, "path"), "path");
        const yaml = await readScenarioFile(file, `${file} does not exist`);
        try {
          return { file, yaml, valid: true, scenario: summary(parseScenario(yaml)) };
        } catch (error) {
          if (!(error instanceof ScenarioError)) throw error;
          return { file, yaml, valid: false, error: error.message };
        }
      },
    },
    {
      name: "edit_scenario",
      description:
        "Change a scenario file inside the workspace in one step, checked before it is written: an invalid result is refused and the file stays as it was. `set` is a JSON merge patch on the top level (name, seed, duration, environment and its channel parameters, walls with an id that the timeline can open and close, and interference sources, network, links with their loss, latency, jitter and interference, timeline, assertions, outputs, bridge): objects merge, null removes a key, arrays are replaced whole. `nodes` patches node entries by id the same way (position, board, firmware, radios, ...); null removes the node. `add` appends new node entries. A node made by `count:` is edited through its group's id. The file is rewritten from its data, so comments are lost. Takes effect on the next run_scenario; for the run in progress use move_node, inject_fault, set_channel and set_radio.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Scenario file inside the workspace" },
          set: { type: "object", description: "Merge patch on the top level, nodes excepted" },
          nodes: {
            type: "object",
            description: "Node id -> merge patch on that node entry, or null to remove it",
          },
          add: { type: "array", items: { type: "object" }, description: "Node entries to append" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      call: (args) =>
        expected(() => {
          known(args, ["path", "set", "nodes", "add"]);
          const path = requiredText(args, "path");
          const add = args.add;
          if (add !== undefined && !Array.isArray(add)) throw new ToolError("add must be an array");
          const edit: ScenarioEdit = {
            set: optionalObject(args, "set"),
            nodes: optionalObject(args, "nodes"),
            add: add as Record<string, unknown>[] | undefined,
          };
          if (edit.set === undefined && edit.nodes === undefined && edit.add === undefined) {
            throw new ToolError("nothing to change: give set, nodes or add");
          }
          return editFile(path, edit);
        }),
    },
    {
      name: "add_node",
      description:
        "Add a node entry to a scenario file inside the workspace, checked before it is written: { id, board, position, radios, firmware, count?, ip?, internet_gateway? } as in the scenario format. Takes effect on the next run: a run in progress cannot gain a board.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Scenario file inside the workspace" },
          node: { type: "object", description: "The node entry" },
        },
        required: ["path", "node"],
        additionalProperties: false,
      },
      call: (args) =>
        expected(() => {
          known(args, ["path", "node"]);
          const node = optionalObject(args, "node");
          if (!node) throw new ToolError("node must be an object");
          return editFile(requiredText(args, "path"), { add: [node] });
        }),
    },
    {
      name: "remove_node",
      description:
        "Remove a node entry from a scenario file inside the workspace, by its id. Refused, with the field that still names it, while a link rule, timeline entry, assertion or scripted send refers to the node; remove those in the same edit_scenario call. Takes effect on the next run.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Scenario file inside the workspace" },
          id: { type: "string" },
        },
        required: ["path", "id"],
        additionalProperties: false,
      },
      call: (args) =>
        expected(() => {
          known(args, ["path", "id"]);
          return editFile(requiredText(args, "path"), {
            nodes: { [requiredText(args, "id")]: null },
          });
        }),
    },
    {
      name: "run_scenario",
      description:
        "Start a scenario in the background and return at once. Poll get_status until state is running (live tools work then), finished, failed or stopped. One run at a time. Every output (metrics.json, air.pcap, events.jsonl, serial logs) goes to out_dir inside the workspace. Errors known before boot (invalid scenario, missing firmware, no libqemu for esp32) come back here.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Scenario file, relative to the workspace" },
          seed: {
            type: "integer",
            minimum: 0,
            maximum: 4294967295,
            description: "Override the scenario seed",
          },
          out: {
            type: "string",
            description: "Output directory inside the workspace. Default out/<scenario>/<run id>",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
      call: (args) =>
        expected(async () => {
          known(args, ["path", "seed", "out"]);
          const path = await session.readablePath(requiredText(args, "path"), "path");
          const seed = optionalInt(args, "seed", 0, 2 ** 32 - 1);
          const out = optionalText(args, "out");
          await session.start(path, {
            ...(seed !== null ? { seed } : {}),
            ...(out !== null ? { out } : {}),
          });
          return session.status();
        }),
    },
    {
      name: "get_status",
      description:
        "State of the current or last run: starting, running, finished (with pass/fail, assertions and files), failed (with the error) or stopped. Also elapsed time, node positions and problems. `idle` before the first run.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      call: (args) => {
        known(args, []);
        return Promise.resolve(session.status());
      },
    },
    {
      name: "get_serial",
      description:
        "Serial output lines of one node in the current or last run, with engine time in ms since time zero. Returns the last `tail` lines; pass the returned next_since_ms back as since_ms to read only new lines.",
      inputSchema: {
        type: "object",
        properties: {
          node: { type: "string" },
          since_ms: { type: "number", description: "Only lines after this engine time" },
          tail: {
            type: "integer",
            minimum: 1,
            maximum: 2000,
            description: "Most lines to return. Default 200",
          },
        },
        required: ["node"],
        additionalProperties: false,
      },
      call: (args) => {
        known(args, ["node", "since_ms", "tail"]);
        const node = requiredText(args, "node");
        const since = args.since_ms;
        if (since !== undefined && (typeof since !== "number" || !Number.isFinite(since))) {
          throw new ToolError("since_ms must be a number");
        }
        const tail = optionalInt(args, "tail", 1, 2000) ?? 200;
        return Promise.resolve(session.serial(node, (since as number | undefined) ?? null, tail));
      },
    },
    {
      name: "get_metrics",
      description:
        "Per-link metrics (sent, delivered, loss, latency p50/p95/p99, RSSI, SNR, attempts) for the whole run and per phase. Live and marked partial while running or after stop; the metrics.json document once finished. Latency is modelled by the channel model, not measured on a guest clock.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      call: (args) => {
        known(args, []);
        return Promise.resolve(session.metrics());
      },
    },
    {
      name: "move_node",
      description:
        "Move a node, or the mobile bridge's station, now, while the run is in progress. The channel model uses the new position for every later frame. Returns the new distance, RSSI and SNR from it to each other station on the medium, on every PHY.",
      inputSchema: {
        type: "object",
        properties: { node: { type: "string" }, position: POSITION_SCHEMA, phase: PHASE_SCHEMA },
        required: ["node", "position"],
        additionalProperties: false,
      },
      call: (args) =>
        expected(() => {
          known(args, ["node", "position", "phase"]);
          const node = requiredText(args, "node");
          const position = parsePosition(args.position, "position");
          return session.move(node, position, optionalText(args, "phase"));
        }),
    },
    {
      name: "inject_fault",
      description:
        'Force chaos on links now, while the run is in progress: extra loss, extra latency, jitter (extra latency drawn from 0 to the value per frame) and interference (a noise rise at the receiver that lowers the link\'s SNR, so the channel model loses frames by itself). `link` is from->to and either side may use * ("*->gw", "a->*"). It replaces any earlier override on those links; set every value to 0 to clear it. Works on every PHY.',
      inputSchema: {
        type: "object",
        properties: {
          link: { type: "string", description: "from->to, * allowed on either side" },
          extra_loss_pct: { type: "number", minimum: 0, maximum: 100, description: "Default 0" },
          extra_latency_ms: {
            type: "number",
            minimum: 0,
            maximum: 60000,
            description: "Default 0",
          },
          extra_jitter_ms: {
            type: "number",
            minimum: 0,
            maximum: 60000,
            description: "Extra latency drawn uniformly from 0 to this, per frame. Default 0",
          },
          interference_db: {
            type: "number",
            minimum: 0,
            maximum: 100,
            description:
              "Noise rise at the receiver in dB; the link's SNR falls by as much. Default 0",
          },
          phase: PHASE_SCHEMA,
        },
        required: ["link"],
        additionalProperties: false,
      },
      call: (args) =>
        expected(() => {
          known(args, [
            "link",
            "extra_loss_pct",
            "extra_latency_ms",
            "extra_jitter_ms",
            "interference_db",
            "phase",
          ]);
          const link = requiredText(args, "link");
          const sides = link.split("->");
          if (sides.length !== 2 || sides.some((s) => s.trim() === "")) {
            throw new ToolError('link must be "from->to"');
          }
          const rule = parseLinkRule({
            from: sides[0]!.trim(),
            to: sides[1]!.trim(),
            extra_loss_pct: args.extra_loss_pct,
            extra_latency_ms: args.extra_latency_ms,
            extra_jitter_ms: args.extra_jitter_ms,
            interference_db: args.interference_db,
          }, "inject_fault");
          return session.fault(rule, optionalText(args, "phase"));
        }),
    },
    {
      name: "set_channel",
      description:
        "Change the channel model of the run in progress, now, for every later frame and link budget: path_loss_exponent, shadowing_sigma_db (scales each pair's seeded draw), noise_figure_db (Wi-Fi receivers; chip PHYs use their own), base_latency_ms, and obstacles (replaces every wall; scenario format: [{ id?, polygon: [[x, y], ...], attenuation_db }], an id naming a door the scenario's timeline changes). A door that the run's scenario opens or closes by id needs that id to stay on a wall here, or the change is logged as a warning and ignored. Same units and ranges as the scenario's environment block. Logged as a channel event.",
      inputSchema: {
        type: "object",
        properties: {
          path_loss_exponent: { type: "number", minimum: 1, maximum: 8 },
          shadowing_sigma_db: { type: "number", minimum: 0, maximum: 30 },
          noise_figure_db: { type: "number", minimum: 0, maximum: 30 },
          base_latency_ms: { type: "number", minimum: 0, maximum: 10000 },
          obstacles: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$" },
                polygon: { type: "array", items: { type: "array", items: { type: "number" } } },
                attenuation_db: { type: "number", minimum: 0 },
              },
              required: ["polygon", "attenuation_db"],
            },
          },
          phase: PHASE_SCHEMA,
        },
        additionalProperties: false,
      },
      call: (args) =>
        expected(() => {
          known(args, [...CHANNEL_FIELDS, "phase"]);
          const { phase: _phase, ...fields } = args;
          if (Object.keys(fields).length === 0) {
            throw new ToolError(`nothing to change: give any of ${CHANNEL_FIELDS.join(", ")}`);
          }
          const changes = parseChannelChanges(fields, "set_channel");
          return session.setChannel(changes, optionalText(args, "phase"));
        }),
    },
    {
      name: "set_radio",
      description:
        "Change a station's radio as the medium models it, in the run in progress, now. Wi-Fi: channel (the one the medium hears it on), tx_power_dbm, antenna_gain_dbi. LoRa, nRF24 and BLE: antenna_gain_dbi only, since the chip's channel and power are in its registers, where the firmware put them. The firmware is not told. Returns the new RSSI and SNR from that station to each other one.",
      inputSchema: {
        type: "object",
        properties: {
          node: { type: "string" },
          channel: { type: "integer", minimum: 1, maximum: 14 },
          tx_power_dbm: { type: "number", minimum: -20, maximum: 30 },
          antenna_gain_dbi: { type: "number", minimum: -20, maximum: 30 },
          phase: PHASE_SCHEMA,
        },
        required: ["node"],
        additionalProperties: false,
      },
      call: (args) =>
        expected(() => {
          known(args, ["node", "channel", "tx_power_dbm", "antenna_gain_dbi", "phase"]);
          const node = requiredText(args, "node");
          const channel = optionalInt(args, "channel", 1, 14);
          const txPowerDbm = optionalNumber(args, "tx_power_dbm", -20, 30);
          const antennaGainDbi = optionalNumber(args, "antenna_gain_dbi", -20, 30);
          const changes = {
            ...(channel !== null ? { channel } : {}),
            ...(txPowerDbm !== undefined ? { txPowerDbm } : {}),
            ...(antennaGainDbi !== undefined ? { antennaGainDbi } : {}),
          };
          if (Object.keys(changes).length === 0) {
            throw new ToolError(
              "nothing to change: give channel, tx_power_dbm or antenna_gain_dbi",
            );
          }
          return session.setRadio(node, changes, optionalText(args, "phase"));
        }),
    },
    {
      name: "start_phase",
      description:
        "Start a metrics phase with this label now, without changing anything, so get_metrics can compare before and after something that happens on its own (firmware behaviour, a serial command).",
      inputSchema: {
        type: "object",
        properties: { label: { type: "string" } },
        required: ["label"],
        additionalProperties: false,
      },
      call: (args) => {
        known(args, ["label"]);
        return Promise.resolve(session.startPhase(requiredText(args, "label")));
      },
    },
    {
      name: "send_serial",
      description:
        "Type into a board's serial console (UART0) while the run plays, as a person at a terminal would. ESP32 boards receive the bytes through QEMU's UART, with its RX interrupt; their answer shows in get_serial. Scripted boards have no console and refuse. Give `text` (a newline is added unless newline is false) or `data_base64` for raw bytes; at most 4096 bytes per call.",
      inputSchema: {
        type: "object",
        properties: {
          node: { type: "string" },
          text: { type: "string" },
          newline: { type: "boolean", description: "Append \\n to text. Default true" },
          data_base64: { type: "string", description: "Raw bytes, base64" },
        },
        required: ["node"],
        additionalProperties: false,
      },
      call: (args) =>
        expected(() => {
          known(args, ["node", "text", "newline", "data_base64"]);
          const node = requiredText(args, "node");
          return session.sendSerial(node, serialBytes(args));
        }),
    },
    {
      name: "mqtt_publish",
      description:
        "Publish an MQTT message through a scripted broker node (one whose firmware serves mqtt) while the run plays, as if a client had published it: it reaches every client subscribed to a matching filter, the scripted boards' subscriptions and phones on the IP bridge alike, and the broker logs `mqtt publish <topic> \"<payload>\" from mcp` in get_serial. With retain, the broker also keeps it for clients that subscribe later; an empty payload with retain clears the topic's. Refused when the node is not a scripted broker. Returns delivered_to: how many client sessions the broker wrote it to, whatever the links then do with the frames.",
      inputSchema: {
        type: "object",
        properties: {
          node: { type: "string", description: "The broker node" },
          topic: { type: "string", description: "A topic name; no + or # wildcard" },
          payload: { type: "string", description: "The message, UTF-8; at most 4096 bytes" },
          retain: { type: "boolean", description: "Keep it for later subscribers. Default false" },
          port: {
            type: "integer",
            minimum: 1,
            maximum: 65535,
            description: "Which MQTT service, when the node serves more than one",
          },
        },
        required: ["node", "topic", "payload"],
        additionalProperties: false,
      },
      call: (args) =>
        expected(() => {
          known(args, ["node", "topic", "payload", "retain", "port"]);
          const node = requiredText(args, "node");
          const topic = mqttTopic(args.topic, "topic", false);
          const payload = payloadBytes(args, true);
          const retain = optionalBoolean(args, "retain") ?? false;
          const port = optionalInt(args, "port", 1, 65535);
          return session.mqttPublish(node, { topic, payload, retain, port });
        }),
    },
    {
      name: "send_payload",
      description:
        'Make a scripted Wi-Fi or BLE board send one message now, while the run plays, over a path its script could use: `udp` (a datagram to a node, port 5000 unless given), `espnow` (a frame to a node, or to "broadcast"; the ACK result shows in get_serial as `espnow tx ok|fail to <peer>`) or `mqtt` (a publish to a broker node, with `topic`; the board opens its session first if its script had none) or, on a BLE board, `gatt` (a notification from a peripheral, or a write from a central, on its connection to the node `to`; at most 20 bytes; refused when they are not connected). The payload goes as given, without the ":<sequence>" a scheduled send adds. To publish from the broker itself use mqtt_publish. Scripted LoRa and nRF24 boards and ESP32 boards refuse.',
      inputSchema: {
        type: "object",
        properties: {
          node: { type: "string", description: "The sending board" },
          to: { type: "string", description: 'The receiving node; "broadcast" for ESP-NOW' },
          via: { type: "string", enum: ["udp", "espnow", "mqtt", "gatt"] },
          payload: {
            type: "string",
            description: "The message, UTF-8; at most 4096 bytes (ESP-NOW 250, UDP 1472, GATT 20)",
          },
          topic: { type: "string", description: "mqtt only: the topic published to" },
          port: {
            type: "integer",
            minimum: 1,
            maximum: 65535,
            description: "udp: the port both ends use (default 5000). mqtt: the broker's (1883)",
          },
        },
        required: ["node", "to", "via", "payload"],
        additionalProperties: false,
      },
      call: (args) =>
        expected(() => {
          known(args, ["node", "to", "via", "payload", "topic", "port"]);
          const node = requiredText(args, "node");
          const to = requiredText(args, "to");
          const via = oneOf(args, "via", ["udp", "espnow", "mqtt", "gatt"] as const);
          const payload = payloadBytes(args, false);
          const port = optionalInt(args, "port", 1, 65535);
          if (via === "mqtt") {
            return session.sendPayload(node, {
              via,
              to,
              payload,
              port: port ?? MQTT_PORT,
              topic: mqttTopic(args.topic, "topic", false),
            });
          }
          if (args.topic !== undefined) throw new ToolError("topic needs via: mqtt");
          if ((via === "espnow" || via === "gatt") && port !== null) {
            throw new ToolError(`${via === "gatt" ? "GATT" : "ESP-NOW"} has no ports`);
          }
          return session.sendPayload(node, { via, to, payload, port: port ?? UDP_PORT });
        }),
    },
    {
      name: "get_events",
      description:
        "The engine's event stream of the current or last run, oldest first: every transmission (tx), delivery and drop with its reason, RSSI and SNR, moves, link overrides, phases, serial lines, BLE link changes and warnings, timed in ms since time zero. The same records as events.jsonl. Pass the returned next_since_seq back as since_seq to follow the stream.",
      inputSchema: {
        type: "object",
        properties: {
          since_seq: {
            type: "integer",
            minimum: -1,
            description: "Only events with a larger sequence number. Default -1: from the start",
          },
          types: {
            type: "array",
            items: { type: "string", enum: EVENT_TYPES },
            description: "Only these event types",
          },
          node: {
            type: "string",
            description: "Only events about this node: sent, received, moved or printed",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 5000,
            description: "Most events to return. Default 500",
          },
        },
        additionalProperties: false,
      },
      call: (args) => {
        known(args, ["since_seq", "types", "node", "limit"]);
        const since = optionalInt(args, "since_seq", -1, Number.MAX_SAFE_INTEGER) ?? -1;
        let types: string[] | null = null;
        if (args.types !== undefined) {
          if (!Array.isArray(args.types) || args.types.length === 0) {
            throw new ToolError("types must be a non-empty array of event types");
          }
          types = args.types.map((type) => {
            if (typeof type !== "string" || !(EVENT_TYPES as string[]).includes(type)) {
              throw new ToolError(
                `unknown event type ${JSON.stringify(type)} (types: ${EVENT_TYPES.join(", ")})`,
              );
            }
            return type;
          });
        }
        const limit = optionalInt(args, "limit", 1, 5000) ?? 500;
        return Promise.resolve(
          session.eventsSince(since, { types, node: optionalText(args, "node") }, limit),
        );
      },
    },
    {
      name: "export_capture",
      description:
        "Write a packet capture of the current or last run as it stands now, also mid-run and after stop (which writes no files of its own): `pcap` the whole air (Wi-Fi Ethernet frames, LoRaTap, the nRF24 record, or BLE link-layer packets, by the run's PHY), `pcap-80211` its ESP-NOW frames as 802.11 (Wi-Fi runs), `btsnoop` one BLE node's HCI traffic. Opens in Wireshark. Written inside the workspace, by default into the run's out_dir.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: CAPTURE_KINDS },
          node: { type: "string", description: "btsnoop only: the BLE node" },
          path: {
            type: "string",
            description:
              "Where to write it, inside the workspace. Default <out_dir>/air-live.pcap, air-live-80211.pcap or hci-<node>-live.btsnoop",
          },
        },
        required: ["kind"],
        additionalProperties: false,
      },
      call: (args) =>
        expected(() => {
          known(args, ["kind", "node", "path"]);
          const kind: CaptureKind = oneOf(args, "kind", CAPTURE_KINDS);
          return session.exportCapture(
            kind,
            optionalText(args, "node"),
            optionalText(args, "path"),
          );
        }),
    },
    {
      name: "get_report",
      description:
        "The text report `hertzbench run` prints for a finished run: every node with its board, radio, clock and fidelity, the per-link table, the assertions with their verdicts, warnings and the files written.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      call: (args) => {
        known(args, []);
        const run = session.run;
        if (!run) throw new ToolError("no run yet: call run_scenario first");
        if (!run.result) {
          throw new ToolError(
            `the report is made when a run finishes; this one is ${run.state}. ` +
              "get_metrics has the numbers so far",
          );
        }
        return Promise.resolve({ state: run.state, report: renderReport(run.result) });
      },
    },
    {
      name: "open_view",
      description:
        "Serve the visual layer of this server's runs on a loopback port and return its URL for a person to open: a map of the nodes, links colored by signal or loss, the link table and a packet timeline; dragging a node there calls move_node. Nothing is launched: the URL is only returned. One view per server; a second call returns the same URL.",
      inputSchema: {
        type: "object",
        properties: {
          port: {
            type: "integer",
            minimum: 0,
            maximum: 65535,
            description: "Loopback port. Default 0: a free one",
          },
        },
        additionalProperties: false,
      },
      call: (args) => {
        known(args, ["port"]);
        if (!openView) throw new ToolError("this server has no view to open");
        const port = optionalInt(args, "port", 0, 65535) ?? 0;
        try {
          return Promise.resolve(openView(port));
        } catch (error) {
          if (error instanceof Deno.errors.AddrInUse) {
            throw new ToolError(`port ${port} is in use; pass another, or 0 for a free one`);
          }
          throw error;
        }
      },
    },
    {
      name: "get_view_state",
      description:
        "What the view draws now, as data: the status, every directed link with its distance, RSSI, SNR, rate, signal quality (Wi-Fi by the rate the SNR allows; LoRa, nRF24 and BLE by the share of frames their PHY loses at that SNR), loss over the last 2 s and any forced chaos, the walls, and the packet timeline after `since` (pass back next_since).",
      inputSchema: {
        type: "object",
        properties: {
          since: {
            type: "integer",
            minimum: -1,
            description: "Timeline entries after this sequence number. Default -1: all",
          },
        },
        additionalProperties: false,
      },
      call: (args) => {
        known(args, ["since"]);
        const since = optionalInt(args, "since", -1, Number.MAX_SAFE_INTEGER) ?? -1;
        return Promise.resolve(viewState(session, since));
      },
    },
    {
      name: "stop",
      description:
        "Stop the run in progress and its boards. No output files are written and assertions are not judged; get_metrics and get_serial still answer with what happened up to the stop.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      call: async (args) => {
        known(args, []);
        await session.stop();
        return session.status();
      },
    },
  ];
}

const HERTZBENCH_DIR = new URL("../", import.meta.url);

/** Example scenarios and the docs a model needs to write one, read from disk on demand. */
export async function resources(): Promise<ResourceDefinition[]> {
  const scheme = `${PRODUCT.slug}://`;
  const list: ResourceDefinition[] = [
    {
      uri: `${scheme}docs/fidelity.md`,
      name: "Fidelity table",
      description:
        "What each board and protocol is faithful to (F1, F2, F3, none), the channel model, and what is not modelled",
      mimeType: "text/markdown",
      read: () => Deno.readTextFile(new URL("docs/fidelity.md", HERTZBENCH_DIR)),
    },
    {
      uri: `${scheme}docs/scenario-format.md`,
      name: "Scenario format",
      description: "Every field of a scenario YAML file",
      mimeType: "text/markdown",
      read: () => Deno.readTextFile(new URL("docs/scenario-format.md", HERTZBENCH_DIR)),
    },
  ];
  const examples = new URL("scenarios/examples/", HERTZBENCH_DIR);
  const names: string[] = [];
  for await (const entry of Deno.readDir(examples)) {
    if (entry.isFile && /\.ya?ml$/.test(entry.name)) names.push(entry.name);
  }
  for (const name of names.sort()) {
    const url = new URL(name, examples);
    list.push({
      uri: `${scheme}examples/${name}`,
      name: `Example scenario ${name}`,
      description: `Ready-to-run example; on disk at ${fileURLToPath(url)}`,
      mimeType: "application/yaml",
      read: () => Deno.readTextFile(url),
    });
  }
  return list;
}
