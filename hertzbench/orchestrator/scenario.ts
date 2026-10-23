// Scenario files: YAML in, a validated typed Scenario out. Parsing does no I/O,
// so `validate` and the tests need no files besides the scenario itself.
// Everything is checked here, once, at the trust boundary; the rest of the
// orchestrator takes a Scenario to be well formed.

import { parse as parseYaml } from "@std/yaml";
import {
  type Environment,
  environmentFromPreset,
  isPresetName,
  type Obstacle,
  type Point2,
  type Position,
} from "../engine/channel.ts";
import type { FrameKind } from "../engine/events.ts";
import { macToBytes } from "../engine/packet.ts";
import { type NodeRadio, parseNodeRadio, type Phy } from "./radios.ts";

export class ScenarioError extends Error {
  override name = "ScenarioError";
}

export type BoardKind = "esp32" | "scripted";

export interface ScriptedSend {
  /** The receiving node; null on LoRa, whose PHY has no addresses (every listener hears it). */
  to: string | null;
  everyMs: number;
  count: number;
  startMs: number;
  port: number;
  payload: string;
}

export type FirmwareSpec =
  | { kind: "sketch"; path: string }
  | { kind: "binary"; path: string }
  | {
    kind: "script";
    send: ScriptedSend[];
    /** Chip radios: keep the receiver on between sends. Defaults to true for a node that sends nothing. */
    listen: boolean;
  };

export interface ScenarioNode {
  id: string;
  board: BoardKind;
  firmware: FirmwareSpec;
  position: Position;
  radio: NodeRadio;
  ip: string;
  mac: string;
  /** Keeps SLIRP: the board reaches the host network but is not on the medium. */
  internetGateway: boolean;
}

export interface LinkRule {
  from: string;
  to: string;
  extraLossPct: number;
  extraLatencyMs: number;
}

export type TimelineAction =
  | { kind: "move"; node: string; to: Position }
  | { kind: "link"; rule: LinkRule };

export interface TimelineEvent {
  atMs: number;
  /** Starts a new metrics phase with this name when present. */
  label: string | null;
  actions: TimelineAction[];
}

export const METRIC_FIELDS = [
  "sent",
  "delivered",
  "loss_pct",
  "latency_p50_ms",
  "latency_p95_ms",
  "latency_p99_ms",
  "latency_mean_ms",
  "rssi_dbm",
  "snr_db",
  "mean_attempts",
] as const;
export type MetricField = (typeof METRIC_FIELDS)[number];

export const METRIC_OPS = ["lt", "lte", "gt", "gte", "eq"] as const;
export type MetricOp = (typeof METRIC_OPS)[number];

export interface MetricCheck {
  field: MetricField;
  op: MetricOp;
  value: number;
}

export type Assertion =
  | { kind: "serial"; node: string; contains: string; withinMs: number | null }
  | {
    kind: "metric";
    /** `from->to`, either side may use `*`. */
    link: string;
    phase: string | null;
    frameKind: FrameKind | null;
    checks: MetricCheck[];
  };

export interface Outputs {
  metrics: string | null;
  pcap: string | null;
  events: string | null;
}

export interface Scenario {
  name: string;
  /** Every node's radio has this PHY: one medium per run. */
  phy: Phy;
  seed: number;
  durationMs: number;
  environment: Environment;
  retryLimit: number;
  /** Dotted prefix of the /24, e.g. "192.168.4". The gateway is .1, boards start at .11. */
  subnetPrefix: string;
  nodes: ScenarioNode[];
  links: LinkRule[];
  timeline: TimelineEvent[];
  assertions: Assertion[];
  outputs: Outputs;
}

// ── field readers ───────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function fail(path: string, message: string): never {
  throw new ScenarioError(`${path}: ${message}`);
}

function record(value: unknown, path: string): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected a mapping");
  }
  return value as Obj;
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "expected a list");
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "") fail(path, "expected a non-empty string");
  return value;
}

function num(value: unknown, path: string, min = -Infinity, max = Infinity): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected a number");
  if (value < min || value > max) fail(path, `must be between ${min} and ${max}, got ${value}`);
  return value;
}

function int(value: unknown, path: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = num(value, path, min, max);
  if (!Number.isInteger(n)) fail(path, `expected an integer, got ${n}`);
  return n;
}

function known(obj: Obj, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      fail(`${path}.${key}`, `unknown field (allowed: ${allowed.join(", ")})`);
    }
  }
}

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m)$/;

/** "500ms", "60s", "1.5s", "2m" to milliseconds. A bare number is refused: its unit would be a guess. */
export function parseDuration(value: unknown, path: string): number {
  if (typeof value !== "string") {
    fail(path, 'expected a duration with a unit, like "500ms", "60s" or "2m"');
  }
  const match = DURATION.exec(value.trim());
  if (!match) fail(path, `not a duration: ${JSON.stringify(value)} (use ms, s or m)`);
  const amount = Number(match[1]);
  return match[2] === "ms" ? amount : match[2] === "s" ? amount * 1000 : amount * 60_000;
}

function point(value: unknown, path: string): Position {
  const coords = list(value, path);
  if (coords.length !== 2 && coords.length !== 3) fail(path, "expected [x, y] or [x, y, z]");
  const [x, y, z] = coords.map((c, i) => num(c, `${path}[${i}]`));
  return z === undefined
    ? { x: x as number, y: y as number }
    : { x: x as number, y: y as number, z };
}

function point2(value: unknown, path: string): Point2 {
  const p = point(value, path);
  return [p.x, p.y];
}

// ── sections ────────────────────────────────────────────────────────────────

const ENVIRONMENT_FIELDS = [
  "preset",
  "obstacles",
  "path_loss_exponent",
  "shadowing_sigma_db",
  "noise_figure_db",
  "base_latency_ms",
  "retry_limit",
] as const;

function parseEnvironment(
  value: unknown,
  path: string,
): { environment: Environment; retryLimit: number } {
  const obj = value === undefined ? {} : record(value, path);
  known(obj, ENVIRONMENT_FIELDS, path);
  const presetName = obj.preset === undefined
    ? "indoor_office"
    : text(obj.preset, `${path}.preset`);
  if (!isPresetName(presetName)) {
    fail(
      `${path}.preset`,
      `unknown preset ${JSON.stringify(presetName)} (free_space, indoor_office, urban, rural)`,
    );
  }
  const obstacles: Obstacle[] = [];
  list(obj.obstacles ?? [], `${path}.obstacles`).forEach((raw, i) => {
    const p = `${path}.obstacles[${i}]`;
    const wall = record(raw, p);
    known(wall, ["polygon", "attenuation_db"], p);
    const vertices = list(wall.polygon, `${p}.polygon`).map((v, j) =>
      point2(v, `${p}.polygon[${j}]`)
    );
    if (vertices.length < 2) fail(`${p}.polygon`, "needs at least two points");
    const attenuationDb = num(wall.attenuation_db, `${p}.attenuation_db`, 0);
    // Two points are one wall; three or more are a closed outline.
    const edges = vertices.length === 2 ? 1 : vertices.length;
    for (let e = 0; e < edges; e++) {
      obstacles.push({
        from: vertices[e] as Point2,
        to: vertices[(e + 1) % vertices.length] as Point2,
        attenuationDb,
      });
    }
  });
  const environment = environmentFromPreset(presetName, {
    obstacles,
    ...(obj.path_loss_exponent !== undefined
      ? { pathLossExponent: num(obj.path_loss_exponent, `${path}.path_loss_exponent`, 1, 8) }
      : {}),
    ...(obj.shadowing_sigma_db !== undefined
      ? { shadowingSigmaDb: num(obj.shadowing_sigma_db, `${path}.shadowing_sigma_db`, 0, 30) }
      : {}),
    ...(obj.noise_figure_db !== undefined
      ? { noiseFigureDb: num(obj.noise_figure_db, `${path}.noise_figure_db`, 0, 30) }
      : {}),
    ...(obj.base_latency_ms !== undefined
      ? { baseLatencyMs: num(obj.base_latency_ms, `${path}.base_latency_ms`, 0, 10_000) }
      : {}),
  });
  const retryLimit = obj.retry_limit === undefined
    ? 7
    : int(obj.retry_limit, `${path}.retry_limit`, 1, 32);
  return { environment, retryLimit };
}

function parseSubnet(value: unknown, path: string): string {
  if (value === undefined) return "192.168.4";
  const obj = record(value, path);
  known(obj, ["subnet"], path);
  const subnet = text(obj.subnet, `${path}.subnet`);
  const match = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.0\/24$/.exec(subnet);
  if (!match || (match[1] as string).split(".").some((o) => Number(o) > 255)) {
    fail(
      `${path}.subnet`,
      `only a /24 like 192.168.4.0/24 is supported, got ${JSON.stringify(subnet)}`,
    );
  }
  return match[1] as string;
}

const NODE_FIELDS = [
  "id",
  "count",
  "board",
  "firmware",
  "position",
  "radios",
  "ip",
  "internet_gateway",
] as const;

const ESP32_BOARDS = new Set(["esp32", "esp32-devkit-v1"]);

function parseBoard(value: unknown, path: string): BoardKind {
  const board = text(value, path);
  if (ESP32_BOARDS.has(board)) return "esp32";
  if (board === "scripted") return "scripted";
  if (/c3|s3/.test(board)) {
    fail(
      path,
      `${board} cannot do Wi-Fi networking in Phase 1: the C3 asserts in eFuse reload when a NIC is attached and the S3 machine models no radio. Use esp32.`,
    );
  }
  return fail(path, `unknown board ${JSON.stringify(board)} (esp32, esp32-devkit-v1, scripted)`);
}

const READERS = { fail, record, num, int, known };

function parseScript(value: unknown, path: string, phy: Phy): FirmwareSpec {
  const obj = record(value, path);
  known(obj, ["send", "listen"], path);
  const send = list(obj.send ?? [], `${path}.send`).map((raw, i): ScriptedSend => {
    const p = `${path}.send[${i}]`;
    const entry = record(raw, p);
    known(entry, ["to", "every", "count", "start", "port", "payload"], p);
    if (phy === "lora" && entry.to !== undefined) {
      fail(`${p}.to`, "LoRa has no addresses: every listening node hears a send; leave `to` out");
    }
    return {
      to: phy === "lora" ? null : text(entry.to, `${p}.to`),
      everyMs: parseDuration(entry.every, `${p}.every`),
      count: int(entry.count, `${p}.count`, 1, 100_000),
      startMs: entry.start === undefined ? 0 : parseDuration(entry.start, `${p}.start`),
      port: int(entry.port ?? 5000, `${p}.port`, 1, 65535),
      payload: entry.payload === undefined ? "ping" : text(entry.payload, `${p}.payload`),
    };
  });
  if (obj.listen !== undefined && typeof obj.listen !== "boolean") {
    fail(`${path}.listen`, "expected true or false");
  }
  const listen = typeof obj.listen === "boolean" ? obj.listen : send.length === 0;
  return { kind: "script", send, listen };
}

function parseFirmware(board: BoardKind, value: unknown, path: string, phy: Phy): FirmwareSpec {
  if (board === "scripted") return parseScript(value ?? {}, path, phy);
  const file = text(value, path);
  return { kind: file.endsWith(".bin") ? "binary" : "sketch", path: file };
}

const GRID_FIELDS = ["origin", "step"] as const;

function positionFor(value: unknown, index: number, count: number, path: string): Position {
  if (Array.isArray(value)) {
    if (count > 1) {
      fail(path, "count > 1 needs a grid position: { grid: { origin: [x, y], step: [dx, dy] } }");
    }
    return point(value, path);
  }
  const obj = record(value, path);
  known(obj, ["grid"], path);
  const grid = record(obj.grid, `${path}.grid`);
  known(grid, GRID_FIELDS, `${path}.grid`);
  const origin = point(grid.origin, `${path}.grid.origin`);
  const step = point(grid.step, `${path}.grid.step`);
  return {
    x: origin.x + index * step.x,
    y: origin.y + index * step.y,
    ...(origin.z !== undefined || step.z !== undefined
      ? { z: (origin.z ?? 0) + index * (step.z ?? 0) }
      : {}),
  };
}

export function macForIndex(index: number): string {
  const mac = `02:68:7a:62:01:${index.toString(16).padStart(2, "0")}`;
  macToBytes(mac);
  return mac;
}

const FIRST_HOST = 11;

/** A board address the DHCP server may hand out: inside the /24, and not the network, gateway or broadcast address. */
function checkHostAddress(ip: string, subnetPrefix: string, path: string): void {
  const match = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!match || match[1] !== subnetPrefix) fail(path, `${ip} is not inside ${subnetPrefix}.0/24`);
  const host = Number(match[2]);
  if (host < 2 || host > 254) {
    fail(
      path,
      `${ip} cannot be used: .0 is the network, .1 the gateway and .255 the broadcast address`,
    );
  }
}

/** The virtual gateway sits at .1 of the subnet with a MAC no board is given. */
export const GATEWAY_MAC = "02:68:7a:62:00:01";
export const GATEWAY_HOST = 1;

function parseNodes(value: unknown, subnetPrefix: string): ScenarioNode[] {
  const raw = list(value, "nodes");
  if (raw.length < 2 || raw.length > 10) {
    fail("nodes", `Phase 1 runs 2 to 10 boards, got ${raw.length}`);
  }
  const nodes: ScenarioNode[] = [];
  raw.forEach((entry, i) => {
    const path = `nodes[${i}]`;
    const obj = record(entry, path);
    known(obj, NODE_FIELDS, path);
    const baseId = text(obj.id, `${path}.id`);
    const count = obj.count === undefined ? 1 : int(obj.count, `${path}.count`, 1, 10);
    const board = parseBoard(obj.board, `${path}.board`);
    const radio = parseNodeRadio(READERS, obj.radios, `${path}.radios`);
    const internetGateway = obj.internet_gateway === true;
    if (obj.internet_gateway !== undefined && typeof obj.internet_gateway !== "boolean") {
      fail(`${path}.internet_gateway`, "expected true or false");
    }
    if (internetGateway && (board !== "esp32" || count !== 1)) {
      fail(`${path}.internet_gateway`, "must be a single esp32 node");
    }
    if (radio.phy !== "wifi" && internetGateway) {
      fail(`${path}.internet_gateway`, "is a Wi-Fi notion; a LoRa or nRF24 node has no IP network");
    }
    if (radio.phy !== "wifi" && obj.ip !== undefined) {
      fail(`${path}.ip`, "is a Wi-Fi notion; a LoRa or nRF24 node has no IP address");
    }
    for (let k = 0; k < count; k++) {
      const index = nodes.length + 1;
      const explicitIp = obj.ip === undefined ? null : text(obj.ip, `${path}.ip`);
      if (explicitIp !== null && count > 1) {
        fail(`${path}.ip`, "cannot be set on a node with count > 1");
      }
      if (explicitIp !== null) checkHostAddress(explicitIp, subnetPrefix, `${path}.ip`);
      nodes.push({
        id: count === 1 ? baseId : `${baseId}-${k + 1}`,
        board,
        firmware: parseFirmware(board, obj.firmware, `${path}.firmware`, radio.phy),
        position: positionFor(obj.position, k, count, `${path}.position`),
        radio,
        ip: explicitIp ?? `${subnetPrefix}.${FIRST_HOST + index - 1}`,
        mac: macForIndex(index),
        internetGateway,
      });
    }
  });
  const ids = new Set<string>();
  const ips = new Set<string>();
  for (const node of nodes) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(node.id)) {
      fail(
        "nodes",
        `node id ${JSON.stringify(node.id)} may only use letters, digits, "_", "." and "-"`,
      );
    }
    if (ids.has(node.id)) fail("nodes", `duplicate node id ${JSON.stringify(node.id)}`);
    ids.add(node.id);
    if (ips.has(node.ip)) fail("nodes", `two nodes share the address ${node.ip}`);
    ips.add(node.ip);
  }
  if (nodes.filter((n) => n.internetGateway).length > 1) {
    fail("nodes", "at most one node can be the internet gateway");
  }
  if (nodes.filter((n) => !n.internetGateway).length < 2) {
    fail("nodes", "at least two nodes must be on the medium");
  }
  return nodes;
}

function parseLinkRule(value: unknown, path: string): LinkRule {
  const obj = record(value, path);
  known(obj, ["from", "to", "extra_loss_pct", "extra_latency_ms"], path);
  return {
    from: text(obj.from, `${path}.from`),
    to: text(obj.to, `${path}.to`),
    extraLossPct: num(obj.extra_loss_pct ?? 0, `${path}.extra_loss_pct`, 0, 100),
    extraLatencyMs: num(obj.extra_latency_ms ?? 0, `${path}.extra_latency_ms`, 0, 60_000),
  };
}

function parseTimeline(value: unknown): TimelineEvent[] {
  return list(value ?? [], "timeline")
    .map((raw, i): TimelineEvent => {
      const path = `timeline[${i}]`;
      const obj = record(raw, path);
      known(obj, ["at", "label", "move", "link"], path);
      const actions: TimelineAction[] = [];
      if (obj.move !== undefined) {
        const move = record(obj.move, `${path}.move`);
        known(move, ["node", "to"], `${path}.move`);
        actions.push({
          kind: "move",
          node: text(move.node, `${path}.move.node`),
          to: point(move.to, `${path}.move.to`),
        });
      }
      if (obj.link !== undefined) {
        actions.push({ kind: "link", rule: parseLinkRule(obj.link, `${path}.link`) });
      }
      const label = obj.label === undefined ? null : text(obj.label, `${path}.label`);
      if (actions.length === 0 && label === null) fail(path, "needs a move, a link or a label");
      return { atMs: parseDuration(obj.at, `${path}.at`), label, actions };
    })
    .sort((a, b) => a.atMs - b.atMs);
}

const FRAME_KINDS: readonly FrameKind[] = [
  "arp",
  "dhcp",
  "udp",
  "tcp",
  "icmp",
  "ipv4",
  "espnow-pseudo-ethernet",
  "lora",
  "nrf24",
  "nrf24-ack",
  "other",
];

function parseAssertion(raw: unknown, path: string): Assertion {
  const obj = record(raw, path);
  const keys = Object.keys(obj);
  if (keys.length !== 1) fail(path, 'expected exactly one of "serial" or "metric"');
  if (obj.serial !== undefined) {
    const s = record(obj.serial, `${path}.serial`);
    known(s, ["node", "contains", "within"], `${path}.serial`);
    return {
      kind: "serial",
      node: text(s.node, `${path}.serial.node`),
      contains: text(s.contains, `${path}.serial.contains`),
      withinMs: s.within === undefined ? null : parseDuration(s.within, `${path}.serial.within`),
    };
  }
  if (obj.metric !== undefined) {
    const m = record(obj.metric, `${path}.metric`);
    known(m, ["link", "phase", "kind", ...METRIC_FIELDS], `${path}.metric`);
    const link = text(m.link, `${path}.metric.link`);
    if (!link.includes("->")) fail(`${path}.metric.link`, 'expected "from->to"');
    const checks: MetricCheck[] = [];
    for (const field of METRIC_FIELDS) {
      if (m[field] === undefined) continue;
      const ops = record(m[field], `${path}.metric.${field}`);
      for (const [op, value] of Object.entries(ops)) {
        if (!(METRIC_OPS as readonly string[]).includes(op)) {
          fail(
            `${path}.metric.${field}.${op}`,
            `unknown comparison (use ${METRIC_OPS.join(", ")})`,
          );
        }
        checks.push({
          field,
          op: op as MetricOp,
          value: num(value, `${path}.metric.${field}.${op}`),
        });
      }
    }
    if (checks.length === 0) {
      fail(`${path}.metric`, `needs at least one of ${METRIC_FIELDS.join(", ")}`);
    }
    const kind = m.kind === undefined ? null : text(m.kind, `${path}.metric.kind`);
    if (kind !== null && !(FRAME_KINDS as readonly string[]).includes(kind)) {
      fail(
        `${path}.metric.kind`,
        `unknown frame kind ${JSON.stringify(kind)} (${FRAME_KINDS.join(", ")})`,
      );
    }
    return {
      kind: "metric",
      link,
      phase: m.phase === undefined ? null : text(m.phase, `${path}.metric.phase`),
      frameKind: kind as FrameKind | null,
      checks,
    };
  }
  return fail(path, 'expected "serial" or "metric"');
}

function parseOutputs(value: unknown): Outputs {
  const obj = value === undefined ? {} : record(value, "outputs");
  known(obj, ["metrics", "pcap", "events"], "outputs");
  const opt = (v: unknown, p: string) => (v === undefined ? null : text(v, p));
  return {
    metrics: opt(obj.metrics, "outputs.metrics"),
    pcap: opt(obj.pcap, "outputs.pcap"),
    events: opt(obj.events, "outputs.events"),
  };
}

// ── cross-references ────────────────────────────────────────────────────────

/** `*` matches any run of characters; everything else is literal. */
export function matchesPattern(pattern: string, name: string): boolean {
  const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join(".*")}$`).test(name);
}

function checkReferences(scenario: Scenario): void {
  const medium = scenario.nodes.filter((n) => !n.internetGateway).map((n) => n.id);
  const ids = scenario.nodes.map((n) => n.id);
  const needNode = (id: string, path: string) => {
    if (!ids.includes(id)) fail(path, `no node named ${JSON.stringify(id)}`);
  };
  const needPattern = (pattern: string, path: string) => {
    if (!medium.some((id) => matchesPattern(pattern, id))) {
      fail(path, `${JSON.stringify(pattern)} matches no node on the medium`);
    }
  };
  scenario.links.forEach((rule, i) => {
    needPattern(rule.from, `links[${i}].from`);
    needPattern(rule.to, `links[${i}].to`);
  });
  scenario.timeline.forEach((event, i) => {
    for (const action of event.actions) {
      if (action.kind === "move") {
        needNode(action.node, `timeline[${i}].move.node`);
        if (!medium.includes(action.node)) {
          fail(
            `timeline[${i}].move.node`,
            "the internet gateway is not on the medium and has no position to move",
          );
        }
      } else {
        needPattern(action.rule.from, `timeline[${i}].link.from`);
        needPattern(action.rule.to, `timeline[${i}].link.to`);
      }
    }
    if (event.atMs > scenario.durationMs) {
      fail(`timeline[${i}].at`, "is after the end of the run");
    }
  });
  const phases = new Set(scenario.timeline.flatMap((e) => (e.label ? [e.label] : [])));
  scenario.nodes.forEach((node, i) => {
    if (node.firmware.kind !== "script") return;
    node.firmware.send.forEach((send, j) => {
      if (send.to === null) return;
      if (!medium.includes(send.to)) {
        fail(
          `nodes[${i}].firmware.send[${j}].to`,
          `no node named ${JSON.stringify(send.to)} on the medium`,
        );
      }
      if (send.to === node.id) {
        fail(`nodes[${i}].firmware.send[${j}].to`, "a node cannot send to itself");
      }
    });
  });
  scenario.assertions.forEach((a, i) => {
    if (a.kind === "serial") {
      needNode(a.node, `assertions[${i}].serial.node`);
    } else {
      const [from, to] = a.link.split("->") as [string, string];
      needPattern(from, `assertions[${i}].metric.link`);
      needPattern(to, `assertions[${i}].metric.link`);
      if (a.phase !== null && a.phase !== "start" && !phases.has(a.phase)) {
        fail(
          `assertions[${i}].metric.phase`,
          `no timeline label ${JSON.stringify(a.phase)} (phases: start${
            [...phases].map((p) => `, ${p}`).join("")
          })`,
        );
      }
    }
  });
}

// ── entry point ─────────────────────────────────────────────────────────────

const TOP_LEVEL = [
  "name",
  "seed",
  "duration",
  "environment",
  "network",
  "nodes",
  "links",
  "timeline",
  "assertions",
  "outputs",
] as const;

export function parseScenario(yamlText: string): Scenario {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch (error) {
    throw new ScenarioError(`not valid YAML: ${error instanceof Error ? error.message : error}`);
  }
  const root = record(doc, "scenario");
  known(root, TOP_LEVEL, "scenario");
  const { environment, retryLimit } = parseEnvironment(root.environment, "environment");
  const subnetPrefix = parseSubnet(root.network, "network");
  // Read in the order of the file's sections, so the first error reported is the first one there.
  const name = text(root.name, "name");
  const seed = int(root.seed ?? 1, "seed", 0, 2 ** 32 - 1);
  const durationMs = parseDuration(root.duration, "duration");
  const nodes = parseNodes(root.nodes, subnetPrefix);
  const phy = nodes[0]?.radio.phy ?? "wifi";
  const other = nodes.find((n) => n.radio.phy !== phy);
  if (other) {
    fail(
      "nodes",
      `a scenario runs one PHY, but ${
        nodes[0]?.id
      } uses ${phy} and ${other.id} uses ${other.radio.phy}`,
    );
  }
  const scenario: Scenario = {
    name,
    phy,
    seed,
    durationMs,
    environment,
    retryLimit,
    subnetPrefix,
    nodes,
    links: list(root.links ?? [], "links").map((l, i) => parseLinkRule(l, `links[${i}]`)),
    timeline: parseTimeline(root.timeline),
    assertions: list(root.assertions ?? [], "assertions").map((a, i) =>
      parseAssertion(a, `assertions[${i}]`)
    ),
    outputs: parseOutputs(root.outputs),
  };
  if (scenario.durationMs <= 0) fail("duration", "must be positive");
  checkReferences(scenario);
  return scenario;
}
