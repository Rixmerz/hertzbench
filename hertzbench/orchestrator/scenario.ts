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
import { ipToBytes, macToBytes } from "../engine/packet.ts";
import { DEFAULT_WIFI, type NodeRadio, parseNodeRadio, type Phy } from "./radios.ts";

export class ScenarioError extends Error {
  override name = "ScenarioError";
}

export type BoardKind = "esp32" | "scripted";

export interface ScriptedSend {
  /**
   * The receiving node; "broadcast" for an ESP-NOW frame to every station on
   * the channel; null on LoRa, whose PHY has no addresses (every listener hears it).
   */
  to: string | null;
  /** Wi-Fi: a UDP datagram, or an ESP-NOW frame through the fork's MAC model. BLE: an ATT PDU on the connection. */
  via: "udp" | "espnow" | "gatt";
  everyMs: number;
  count: number;
  startMs: number;
  port: number;
  payload: string;
}

/** A TCP server a scripted Wi-Fi board runs, for the IP bridge (Phase 5a) to reach. */
export interface ScriptedService {
  port: number;
  /** http also answers a WebSocket upgrade, as an ESP32 web server does; mqtt is a QoS 0 broker. */
  protocol: "http" | "mqtt";
}

/** What a scripted BLE board does besides its sends. */
export interface BleScript {
  /** Peripheral: advertise, connectable, until a central connects, and again after it leaves. */
  advertise: { name: string; intervalMs: number } | null;
  /** Central: connect to these nodes, and again whenever a connection drops. */
  connect: { peers: string[]; intervalMs: number; timeoutMs: number } | null;
  /** Log every advertisement heard (passive scan). */
  scan: boolean;
}

export type FirmwareSpec =
  | { kind: "sketch"; path: string }
  | { kind: "binary"; path: string }
  | {
    kind: "script";
    send: ScriptedSend[];
    /** Wi-Fi only: TCP servers. */
    serve: ScriptedService[];
    /** Chip radios: keep the receiver on between sends. Defaults to true for a node that sends nothing. */
    listen: boolean;
    /** BLE only. */
    ble: BleScript | null;
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
  "acked_pct",
  "ack_rtt_p95_ms",
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

/** What the IP bridge relays: TCP connections to one port of one node. */
export type BridgeServiceKind = "http" | "websocket" | "mqtt";

export interface ExposedService {
  node: string;
  /** The TCP port on the node. */
  port: number;
  service: BridgeServiceKind;
  /** The host port a phone connects to; 0 lets the OS pick. */
  listenPort: number;
}

interface BridgeCommon {
  /** The bridge's node on the medium: where the phone is, as far as the channel model knows. */
  id: string;
  position: Position;
  radio: NodeRadio;
  /** Station MAC on Wi-Fi, device address on BLE. */
  mac: string;
}

/** Phase 5a: a phone on the host's LAN reaches nodes over TCP through a host proxy. */
export interface IpBridgeSpec extends BridgeCommon {
  kind: "ip";
  ip: string;
  /** The host address the proxy binds. */
  listen: string;
  mdns: boolean;
  /** The host address mDNS advertises; null: the host's first non-loopback IPv4 address. */
  advertiseIp: string | null;
  expose: ExposedService[];
}

/** Phase 5b: a phone reaches a simulated peripheral's GATT server through BlueZ on the host. */
export interface BleBridgeSpec extends BridgeCommon {
  kind: "ble";
  /** The peripheral node whose GATT server the host mirrors. */
  mirror: string;
  /** BlueZ adapter the host advertises on. */
  adapter: string;
  /** The name the host advertises to the phone. */
  name: string;
  intervalMs: number;
  timeoutMs: number;
}

export type BridgeSpec = IpBridgeSpec | BleBridgeSpec;

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
  /** The mobile bridge, at most one per scenario. */
  bridge: BridgeSpec | null;
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

/** `[x, y]` or `[x, y, z]` in metres. */
export function parsePosition(value: unknown, path: string): Position {
  const coords = list(value, path);
  if (coords.length !== 2 && coords.length !== 3) fail(path, "expected [x, y] or [x, y, z]");
  const [x, y, z] = coords.map((c, i) => num(c, `${path}[${i}]`));
  return z === undefined
    ? { x: x as number, y: y as number }
    : { x: x as number, y: y as number, z };
}

function point2(value: unknown, path: string): Point2 {
  const p = parsePosition(value, path);
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

/** The names a scenario may give each board kind. */
export const BOARD_NAMES: Record<BoardKind, readonly string[]> = {
  esp32: ["esp32", "esp32-devkit-v1"],
  scripted: ["scripted"],
};

function parseBoard(value: unknown, path: string): BoardKind {
  const board = text(value, path);
  for (const [kind, names] of Object.entries(BOARD_NAMES)) {
    if (names.includes(board)) return kind as BoardKind;
  }
  if (/c3|s3/.test(board)) {
    fail(
      path,
      `${board} cannot do Wi-Fi networking in Phase 1: the C3 asserts in eFuse reload when a NIC is attached and the S3 machine models no radio. Use esp32.`,
    );
  }
  return fail(
    path,
    `unknown board ${JSON.stringify(board)} (${Object.values(BOARD_NAMES).flat().join(", ")})`,
  );
}

const READERS = { fail, record, num, int, known };

/** The `to` of a scripted ESP-NOW send that goes to every station on the channel. */
export const BROADCAST_TARGET = "broadcast";

const BLE_SCRIPT_FIELDS = ["advertise", "connect", "scan"] as const;

/** A duration in [min, max] that is a whole number of `stepMs` (the link layer's units). */
function linkLayerDuration(
  value: unknown,
  fallback: number,
  path: string,
  minMs: number,
  maxMs: number,
  stepMs: number,
): number {
  const ms = value === undefined ? fallback : parseDuration(value, path);
  if (ms < minMs || ms > maxMs) fail(path, `must be between ${minMs} ms and ${maxMs} ms`);
  if (Math.abs(ms / stepMs - Math.round(ms / stepMs)) > 1e-9) {
    fail(path, `must be a multiple of ${stepMs} ms`);
  }
  return ms;
}

function parseBleScript(obj: Obj, path: string, nodeName: string): BleScript {
  let advertise: BleScript["advertise"] = null;
  if (obj.advertise !== undefined && obj.advertise !== false) {
    const a = obj.advertise === true ? {} : record(obj.advertise, `${path}.advertise`);
    known(a, ["name", "interval"], `${path}.advertise`);
    const name = a.name === undefined ? nodeName : text(a.name, `${path}.advertise.name`);
    if (new TextEncoder().encode(name).length > 26) {
      fail(`${path}.advertise.name`, "must fit in 26 bytes of advertising data");
    }
    advertise = {
      name,
      intervalMs: linkLayerDuration(
        a.interval,
        100,
        `${path}.advertise.interval`,
        20,
        10240,
        0.625,
      ),
    };
  }
  let connect: BleScript["connect"] = null;
  if (obj.connect !== undefined) {
    const c = record(obj.connect, `${path}.connect`);
    known(c, ["peers", "interval", "timeout"], `${path}.connect`);
    const peers = list(c.peers, `${path}.connect.peers`).map((p, i) =>
      text(p, `${path}.connect.peers[${i}]`)
    );
    if (peers.length === 0) fail(`${path}.connect.peers`, "names no node to connect to");
    const intervalMs = linkLayerDuration(
      c.interval,
      30,
      `${path}.connect.interval`,
      7.5,
      4000,
      1.25,
    );
    const timeoutMs = linkLayerDuration(c.timeout, 1000, `${path}.connect.timeout`, 100, 32000, 10);
    if (timeoutMs <= 2 * intervalMs) {
      fail(`${path}.connect.timeout`, "must be more than twice the connection interval");
    }
    connect = { peers, intervalMs, timeoutMs };
  }
  if (obj.scan !== undefined && typeof obj.scan !== "boolean") {
    fail(`${path}.scan`, "expected true or false");
  }
  if (advertise && connect) {
    fail(path, "a scripted BLE board is a peripheral (advertise) or a central (connect), not both");
  }
  return { advertise, connect, scan: obj.scan === true };
}

function parseScript(value: unknown, path: string, phy: Phy, nodeName: string): FirmwareSpec {
  const obj = record(value, path);
  known(obj, ["send", "listen", "serve", ...BLE_SCRIPT_FIELDS], path);
  if (phy !== "wifi" && obj.serve !== undefined) {
    fail(`${path}.serve`, "is a Wi-Fi notion: TCP servers need an IP network");
  }
  const serve = list(obj.serve ?? [], `${path}.serve`).map((raw, i): ScriptedService => {
    const p = `${path}.serve[${i}]`;
    const entry = record(raw, p);
    known(entry, ["port", "protocol"], p);
    const protocol = text(entry.protocol, `${p}.protocol`);
    if (protocol !== "http" && protocol !== "mqtt") {
      fail(`${p}.protocol`, 'expected "http" or "mqtt"');
    }
    return { port: int(entry.port, `${p}.port`, 1, 65535), protocol };
  });
  const servedPorts = new Set<number>();
  for (const [i, service] of serve.entries()) {
    if (servedPorts.has(service.port)) fail(`${path}.serve[${i}].port`, "is already served");
    servedPorts.add(service.port);
  }
  for (const field of BLE_SCRIPT_FIELDS) {
    if (phy !== "ble" && obj[field] !== undefined) {
      fail(`${path}.${field}`, "is a BLE notion; this node's radio is not ble");
    }
  }
  if (phy === "ble" && obj.listen !== undefined) {
    fail(`${path}.listen`, "is not a BLE notion: a peripheral advertises, a central connects");
  }
  const send = list(obj.send ?? [], `${path}.send`).map((raw, i): ScriptedSend => {
    const p = `${path}.send[${i}]`;
    const entry = record(raw, p);
    known(entry, ["to", "via", "every", "count", "start", "port", "payload"], p);
    if (phy === "lora" && entry.to !== undefined) {
      fail(`${p}.to`, "LoRa has no addresses: every listening node hears a send; leave `to` out");
    }
    const via = entry.via === undefined
      ? (phy === "ble" ? "gatt" : "udp")
      : text(entry.via, `${p}.via`);
    if (phy === "ble" && via !== "gatt") fail(`${p}.via`, 'a BLE node sends "gatt"');
    if (phy !== "ble" && via === "gatt") fail(`${p}.via`, "GATT needs a ble radio");
    if (via !== "udp" && via !== "espnow" && via !== "gatt") {
      fail(`${p}.via`, 'expected "udp", "espnow" or "gatt"');
    }
    if (via === "espnow" && phy !== "wifi") fail(`${p}.via`, "ESP-NOW needs a wifi radio");
    const to = phy === "lora" ? null : text(entry.to, `${p}.to`);
    if (to === BROADCAST_TARGET && via !== "espnow") {
      fail(`${p}.to`, `"${BROADCAST_TARGET}" needs via: espnow`);
    }
    if ((via === "espnow" || via === "gatt") && entry.port !== undefined) {
      fail(`${p}.port`, via === "gatt" ? "GATT has no ports" : "ESP-NOW has no ports");
    }
    const payload = entry.payload === undefined ? "ping" : text(entry.payload, `${p}.payload`);
    // Room for ":<sequence>" inside ESP-NOW's 250-byte payload.
    if (via === "espnow" && new TextEncoder().encode(payload).length > 200) {
      fail(`${p}.payload`, "an ESP-NOW payload must stay within 200 bytes");
    }
    // Room for ":<sequence>" in the 20 bytes an ATT notification carries at the default MTU.
    if (via === "gatt" && new TextEncoder().encode(payload).length > 14) {
      fail(`${p}.payload`, "a GATT payload must stay within 14 bytes");
    }
    return {
      to,
      via,
      everyMs: parseDuration(entry.every, `${p}.every`),
      count: int(entry.count, `${p}.count`, 1, 100_000),
      startMs: entry.start === undefined ? 0 : parseDuration(entry.start, `${p}.start`),
      port: int(entry.port ?? 5000, `${p}.port`, 1, 65535),
      payload,
    };
  });
  if (obj.listen !== undefined && typeof obj.listen !== "boolean") {
    fail(`${path}.listen`, "expected true or false");
  }
  const listen = typeof obj.listen === "boolean" ? obj.listen : send.length === 0;
  return {
    kind: "script",
    send,
    serve,
    listen,
    ble: phy === "ble" ? parseBleScript(obj, path, nodeName) : null,
  };
}

function parseFirmware(
  board: BoardKind,
  value: unknown,
  path: string,
  phy: Phy,
  nodeName: string,
): FirmwareSpec {
  if (board === "scripted") return parseScript(value ?? {}, path, phy, nodeName);
  const file = text(value, path);
  return { kind: file.endsWith(".bin") ? "binary" : "sketch", path: file };
}

const GRID_FIELDS = ["origin", "step"] as const;

function positionFor(value: unknown, index: number, count: number, path: string): Position {
  if (Array.isArray(value)) {
    if (count > 1) {
      fail(path, "count > 1 needs a grid position: { grid: { origin: [x, y], step: [dx, dy] } }");
    }
    return parsePosition(value, path);
  }
  const obj = record(value, path);
  known(obj, ["grid"], path);
  const grid = record(obj.grid, `${path}.grid`);
  known(grid, GRID_FIELDS, `${path}.grid`);
  const origin = parsePosition(grid.origin, `${path}.grid.origin`);
  const step = parsePosition(grid.step, `${path}.grid.step`);
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
      fail(
        `${path}.internet_gateway`,
        "is a Wi-Fi notion; a LoRa, nRF24 or BLE node has no IP network",
      );
    }
    if (radio.phy !== "wifi" && obj.ip !== undefined) {
      fail(`${path}.ip`, "is a Wi-Fi notion; a LoRa, nRF24 or BLE node has no IP address");
    }
    for (let k = 0; k < count; k++) {
      const index = nodes.length + 1;
      const explicitIp = obj.ip === undefined ? null : text(obj.ip, `${path}.ip`);
      if (explicitIp !== null && count > 1) {
        fail(`${path}.ip`, "cannot be set on a node with count > 1");
      }
      if (explicitIp !== null) checkHostAddress(explicitIp, subnetPrefix, `${path}.ip`);
      const id = count === 1 ? baseId : `${baseId}-${k + 1}`;
      nodes.push({
        id,
        board,
        firmware: parseFirmware(board, obj.firmware, `${path}.firmware`, radio.phy, id),
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

export function parseLinkRule(value: unknown, path: string): LinkRule {
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
          to: parsePosition(move.to, `${path}.move.to`),
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
  "espnow",
  "espnow-ack",
  "lora",
  "nrf24",
  "nrf24-ack",
  "ble-adv",
  "ble-data",
  "ble-acl",
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

// ── bridge ──────────────────────────────────────────────────────────────────

/** The bridge's station MAC and BLE address: outside the boards' 02:68:7a:62:01:NN and the gateway's. */
export const BRIDGE_MAC = "02:68:7a:62:02:01";
/** The bridge's address on the /24 when the scenario gives none. */
export const BRIDGE_HOST = 250;

export const BRIDGE_SERVICES: readonly BridgeServiceKind[] = ["http", "websocket", "mqtt"];

const BRIDGE_COMMON_FIELDS = ["id", "position", "radios"] as const;
const IP_BRIDGE_FIELDS = [
  ...BRIDGE_COMMON_FIELDS,
  "ip",
  "listen",
  "mdns",
  "advertise_ip",
  "expose",
] as const;
const BLE_BRIDGE_FIELDS = [
  ...BRIDGE_COMMON_FIELDS,
  "mirror",
  "adapter",
  "name",
  "interval",
  "timeout",
] as const;

function ipv4(value: unknown, path: string): string {
  const ip = text(value, path);
  try {
    ipToBytes(ip);
  } catch {
    fail(path, `not an IPv4 address: ${JSON.stringify(ip)}`);
  }
  return ip;
}

function parseBridge(value: unknown, phy: Phy, subnetPrefix: string): BridgeSpec | null {
  if (value === undefined) return null;
  const path = "bridge";
  const obj = record(value, path);
  if (phy !== "wifi" && phy !== "ble") {
    fail(path, `bridges a phone over Wi-Fi/IP or BLE; this scenario's radios are ${phy}`);
  }
  known(obj, phy === "wifi" ? IP_BRIDGE_FIELDS : BLE_BRIDGE_FIELDS, path);
  const id = obj.id === undefined ? "phone" : text(obj.id, `${path}.id`);
  const radio = obj.radios === undefined
    ? (phy === "wifi" ? null : parseNodeRadio(READERS, [{ phy: "ble" }], `${path}.radios`))
    : parseNodeRadio(READERS, obj.radios, `${path}.radios`);
  if (radio && radio.phy !== phy) {
    fail(`${path}.radios`, `the bridge's radio must be ${phy}, like every node's`);
  }
  const common = {
    id,
    position: parsePosition(obj.position, `${path}.position`),
    mac: BRIDGE_MAC,
  };
  if (phy === "ble") {
    const intervalMs = linkLayerDuration(obj.interval, 30, `${path}.interval`, 7.5, 4000, 1.25);
    const timeoutMs = linkLayerDuration(obj.timeout, 1000, `${path}.timeout`, 100, 32000, 10);
    if (timeoutMs <= 2 * intervalMs) {
      fail(`${path}.timeout`, "must be more than twice the connection interval");
    }
    const mirror = text(obj.mirror, `${path}.mirror`);
    const adapter = obj.adapter === undefined ? "hci0" : text(obj.adapter, `${path}.adapter`);
    if (!/^hci\d{1,3}$/.test(adapter)) {
      fail(`${path}.adapter`, 'expected a BlueZ adapter like "hci0"');
    }
    const name = obj.name === undefined ? mirror : text(obj.name, `${path}.name`);
    if (new TextEncoder().encode(name).length > 26) {
      fail(`${path}.name`, "must fit in 26 bytes of advertising data");
    }
    return {
      kind: "ble",
      ...common,
      radio: radio as NodeRadio,
      mirror,
      adapter,
      name,
      intervalMs,
      timeoutMs,
    };
  }
  const ip = obj.ip === undefined ? `${subnetPrefix}.${BRIDGE_HOST}` : ipv4(obj.ip, `${path}.ip`);
  checkHostAddress(ip, subnetPrefix, `${path}.ip`);
  const listen = obj.listen === undefined ? "127.0.0.1" : ipv4(obj.listen, `${path}.listen`);
  if (obj.mdns !== undefined && typeof obj.mdns !== "boolean") {
    fail(`${path}.mdns`, "expected true or false");
  }
  const expose = list(obj.expose, `${path}.expose`).map((raw, i): ExposedService => {
    const p = `${path}.expose[${i}]`;
    const entry = record(raw, p);
    known(entry, ["node", "port", "service", "listen_port"], p);
    const service = text(entry.service, `${p}.service`);
    if (!(BRIDGE_SERVICES as readonly string[]).includes(service)) {
      fail(`${p}.service`, `expected one of ${BRIDGE_SERVICES.join(", ")}`);
    }
    return {
      node: text(entry.node, `${p}.node`),
      port: int(entry.port, `${p}.port`, 1, 65535),
      service: service as BridgeServiceKind,
      listenPort: int(entry.listen_port ?? 0, `${p}.listen_port`, 0, 65535),
    };
  });
  if (expose.length === 0) fail(`${path}.expose`, "names no node port to relay");
  const listenPorts = new Set<number>();
  expose.forEach((e, i) => {
    if (e.listenPort === 0) return;
    if (listenPorts.has(e.listenPort)) {
      fail(`${path}.expose[${i}].listen_port`, `${e.listenPort} is already used by the bridge`);
    }
    listenPorts.add(e.listenPort);
  });
  return {
    kind: "ip",
    ...common,
    // Filled in from the exposed nodes' channel when the scenario names no radio.
    radio: radio ?? DEFAULT_WIFI,
    ip,
    listen,
    // A proxy bound to loopback is unreachable from a phone, so there is nothing to advertise.
    mdns: typeof obj.mdns === "boolean" ? obj.mdns : !listen.startsWith("127."),
    advertiseIp: obj.advertise_ip === undefined
      ? null
      : ipv4(obj.advertise_ip, `${path}.advertise_ip`),
    expose,
  };
}

/** The bridge against the nodes: names, addresses, the nodes it reaches. */
function checkBridge(scenario: Scenario, radioGiven: boolean): void {
  const bridge = scenario.bridge;
  if (!bridge) return;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(bridge.id)) {
    fail(
      "bridge.id",
      `${JSON.stringify(bridge.id)} may only use letters, digits, "_", "." and "-"`,
    );
  }
  if (scenario.nodes.some((n) => n.id === bridge.id)) {
    fail("bridge.id", `${JSON.stringify(bridge.id)} is already a node's id`);
  }
  if (bridge.id === "gateway" || bridge.id === BROADCAST_TARGET) {
    fail("bridge.id", `${JSON.stringify(bridge.id)} is reserved`);
  }
  const onMedium = (id: string, path: string) => {
    const node = scenario.nodes.find((n) => n.id === id);
    if (!node) fail(path, `no node named ${JSON.stringify(id)}`);
    if (node.internetGateway) {
      fail(path, `${id} is the internet gateway, which is not on the medium`);
    }
    return node;
  };
  if (bridge.kind === "ble") {
    const node = onMedium(bridge.mirror, "bridge.mirror");
    if (node.firmware.kind === "script" && !node.firmware.ble?.advertise) {
      fail(
        "bridge.mirror",
        `${node.id} is a scripted central; the bridge mirrors a peripheral that advertises`,
      );
    }
    return;
  }
  const clash = scenario.nodes.find((n) => n.ip === bridge.ip);
  if (clash) fail("bridge.ip", `${bridge.ip} is already ${clash.id}'s address`);
  const channels = new Set<number>();
  bridge.expose.forEach((e, i) => {
    const node = onMedium(e.node, `bridge.expose[${i}].node`);
    if (node.radio.phy === "wifi") channels.add(node.radio.channel);
  });
  if (!radioGiven) {
    if (channels.size > 1) {
      fail("bridge.radios", "the exposed nodes use different channels: give the bridge its radio");
    }
    const [channel] = channels;
    if (channel !== undefined && bridge.radio.phy === "wifi") {
      bridge.radio = { ...bridge.radio, channel };
    }
  }
  const channel = bridge.radio.phy === "wifi" ? bridge.radio.channel : 0;
  bridge.expose.forEach((e, i) => {
    const node = scenario.nodes.find((n) => n.id === e.node);
    if (node?.radio.phy === "wifi" && node.radio.channel !== channel) {
      fail(
        `bridge.expose[${i}].node`,
        `${e.node} is on channel ${node.radio.channel} and the bridge on ${channel}: it would never hear the bridge`,
      );
    }
  });
}

// ── cross-references ────────────────────────────────────────────────────────

/** `*` matches any run of characters; everything else is literal. */
export function matchesPattern(pattern: string, name: string): boolean {
  const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join(".*")}$`).test(name);
}

function checkReferences(scenario: Scenario): void {
  const boards = scenario.nodes.filter((n) => !n.internetGateway).map((n) => n.id);
  // The bridge is a station on the medium too: links, moves and metrics can name it.
  const bridgeIds = scenario.bridge ? [scenario.bridge.id] : [];
  const medium = [...boards, ...bridgeIds];
  const ids = [...scenario.nodes.map((n) => n.id), ...bridgeIds];
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
  const connects = (central: ScenarioNode, peripheral: string) =>
    central.firmware.kind === "script" &&
    (central.firmware.ble?.connect?.peers.includes(peripheral) ?? false);
  scenario.nodes.forEach((node, i) => {
    if (node.firmware.kind !== "script") return;
    node.firmware.ble?.connect?.peers.forEach((peer, j) => {
      const p = `nodes[${i}].firmware.connect.peers[${j}]`;
      if (!boards.includes(peer)) fail(p, `no node named ${JSON.stringify(peer)} on the medium`);
      if (peer === node.id) fail(p, "a node cannot connect to itself");
    });
    node.firmware.send.forEach((send, j) => {
      if (send.to === null || send.to === BROADCAST_TARGET) return;
      if (!boards.includes(send.to)) {
        fail(
          `nodes[${i}].firmware.send[${j}].to`,
          `no node named ${JSON.stringify(send.to)} on the medium`,
        );
      }
      if (send.to === node.id) {
        fail(`nodes[${i}].firmware.send[${j}].to`, "a node cannot send to itself");
      }
      const peer = scenario.nodes.find((n) => n.id === send.to);
      if (send.via === "gatt" && peer && !connects(node, send.to) && !connects(peer, node.id)) {
        fail(
          `nodes[${i}].firmware.send[${j}].to`,
          `GATT goes over a connection, and neither ${node.id} nor ${send.to} connects to the other`,
        );
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
  "bridge",
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
    bridge: parseBridge(root.bridge, phy, subnetPrefix),
  };
  if (scenario.durationMs <= 0) fail("duration", "must be positive");
  checkBridge(scenario, record(root.bridge ?? {}, "bridge").radios !== undefined);
  checkReferences(scenario);
  return scenario;
}
