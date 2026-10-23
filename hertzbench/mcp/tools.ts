// The tools and resources the MCP server offers. Each tool checks its own
// arguments here, at the trust boundary, then calls the orchestrator through
// the session. Scenario and board errors become tool errors the model can read
// and act on.

import { dirname, resolve } from "node:path";
import { PRODUCT } from "../brand.ts";
import { BoardError } from "../orchestrator/boards/board.ts";
import { ESP32_FIDELITY, resolveQemuLibrary } from "../orchestrator/boards/qemu-esp32.ts";
import { scriptedLauncher } from "../orchestrator/boards/scripted.ts";
import { checkFirmwareFiles, loadScenario } from "../orchestrator/load.ts";
import { CAPTURE_KINDS, type CaptureKind } from "../orchestrator/runner.ts";
import { EVENT_TYPES } from "../engine/mod.ts";
import {
  BOARD_NAMES,
  parseLinkRule,
  parsePosition,
  parseScenario,
  type Scenario,
  ScenarioError,
} from "../orchestrator/scenario.ts";
import { type ResourceDefinition, type ToolDefinition, ToolError } from "./protocol.ts";
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

/** Scenario and board errors are the caller's to fix: report them, do not crash. */
async function expected<T>(body: () => Promise<T> | T): Promise<T> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof ScenarioError || error instanceof BoardError) {
      throw new ToolError(error.message);
    }
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

export function tools(session: Session): ToolDefinition[] {
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
          const file = path === null ? null : session.resolvePath(path);
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
          const path = requiredText(args, "path");
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
        "Move a node now, while the run is in progress. The channel model uses the new position for every later frame. Returns the new distance, RSSI and SNR to each other node on a Wi-Fi run; on LoRa, nRF24 and BLE runs that list is empty.",
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
      description: `Ready-to-run example; on disk at ${url.pathname}`,
      mimeType: "application/yaml",
      read: () => Deno.readTextFile(url),
    });
  }
  return list;
}
