// Coverage of the orchestrator: every field of a scenario through parseScenario
// (the one parser `validate`, `run` and the MCP server share), the radios, the
// assertions, metrics.json and the report, the loader, the runner and its live
// control, the air networks, and the boards (scripted and qemu-esp32 against a
// fake worker).

import { join } from "node:path";
import { writeFakePython } from "./platform.ts";
import { fileURLToPath } from "node:url";
import {
  assert,
  assertEquals,
  assertExists,
  assertFalse,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { stringify } from "@std/yaml";
import {
  type AirFrame,
  computeMetrics,
  type EngineEvent,
  EventLog,
  ManualClock,
  type NewEvent,
} from "../engine/mod.ts";
import { evaluateAssertions } from "../orchestrator/assertions.ts";
import { describeRadio, nrf24AddressFor } from "../orchestrator/radios.ts";
import { linkJson, metricsDocument, renderReport } from "../orchestrator/report.ts";
import {
  dot11CapturePath,
  expandLinkRule,
  type LiveRun,
  type NodeReport,
  RunInterrupted,
  type RunResult,
  runScenario,
} from "../orchestrator/runner.ts";
import { checkFirmwareFiles, loadScenario } from "../orchestrator/load.ts";
import { createEsp32Launcher, resolveQemuLibrary } from "../orchestrator/boards/qemu-esp32.ts";
import { scriptedLauncher } from "../orchestrator/boards/scripted.ts";
import { encodeFrame, FrameDecoder } from "../adapters/qemu-wifi-l2/mod.ts";
import { BROADCAST_MAC, buildUdp, parseIpv4, parseUdp, VirtualGateway } from "../engine/mod.ts";
import { until } from "./helpers.ts";
import {
  type BoardContext,
  BoardError,
  type BoardLauncher,
  type RunningBoard,
} from "../orchestrator/boards/board.ts";
import {
  bleRecord,
  createAirNetwork,
  declaredMismatches,
  declaredSignal,
  loraTapRecord,
  nrf24Record,
} from "../orchestrator/air-network.ts";
import {
  matchesPattern,
  parseDuration,
  parsePosition,
  parseScenario,
  type Scenario,
  ScenarioError,
} from "../orchestrator/scenario.ts";
// ── drivers ─────────────────────────────────────────────────────────────────
// The scripted-board drivers (ATT/GATT, HCI host, arduino-LoRa and RF24
// replays, the TCP services) and the two scripted boards built on them, driven
// in process against fake buses, fake controllers and the real chip models.

import {
  AirMedium,
  environmentFromPreset,
  substream,
  type TcpConnection,
  TcpHost,
} from "../engine/mod.ts";
import {
  addressToBytes,
  encodeHci,
  EVT,
  H4Decoder,
  LE_SUBEVENT,
  OP,
  STATUS,
} from "../adapters/ble-hci/hci.ts";
import { Sx127x } from "../adapters/lora-sx127x/mod.ts";
import { Nrf24l01 } from "../adapters/nrf24/mod.ts";
import { SpiLinkAdapter } from "../adapters/spi-link/adapter.ts";
import type { SpiLinkClient } from "../adapters/spi-link/client.ts";
import type { Level, SpiDevice } from "../adapters/spi-link/device.ts";
import type { LoraRadio, NodeRadio, Nrf24Radio } from "../orchestrator/radios.ts";
import type { BleScript, ScenarioNode, ScriptedSend } from "../orchestrator/scenario.ts";
import type { PeerInfo } from "../orchestrator/boards/board.ts";
import {
  ATT,
  ATT_ERROR,
  AttClient,
  AttError,
  errorRsp,
  GATT_UUID,
  GattServer,
  MAX_VALUE_BYTES,
  PROPERTY,
  propertyNames,
  uuidToString,
} from "../orchestrator/boards/drivers/att.ts";
import {
  advertisedName,
  type AdvertisingReport,
  HciHost,
} from "../orchestrator/boards/drivers/hci-host.ts";
import { ArduinoLora } from "../orchestrator/boards/drivers/arduino-lora.ts";
import { Rf24 } from "../orchestrator/boards/drivers/rf24.ts";
import type { DriverBus } from "../orchestrator/boards/drivers/bus.ts";
import {
  MqttBroker,
  mqttPacket,
  mqttPublish,
  mqttTopicMatches,
  parseMqttPacket,
  parseWebsocketFrame,
  serveHttp,
  websocketAccept,
  websocketFrame,
} from "../orchestrator/boards/drivers/tcp-services.ts";
import {
  ScriptedRadioBoard,
  startScriptedRadioBoard,
} from "../orchestrator/boards/scripted-radio.ts";
import { SCRIPTED_ATT_HANDLE, startScriptedBleBoard } from "../orchestrator/boards/scripted-ble.ts";

// ── scenario helpers ────────────────────────────────────────────────────────

type Doc = Record<string, unknown>;

/** Two scripted Wi-Fi boards, the smallest valid scenario. Each call returns a fresh copy. */
function wifiDoc(): Doc {
  return {
    name: "cov",
    duration: "1s",
    nodes: [
      { id: "a", board: "scripted", position: [0, 0] },
      { id: "b", board: "scripted", position: [10, 0] },
    ],
  };
}

function radioDoc(radio: Doc, firmware: Doc[] = [{}, {}]): Doc {
  return {
    name: "cov",
    duration: "1s",
    nodes: [
      { id: "a", board: "scripted", position: [0, 0], radios: [radio], firmware: firmware[0] },
      { id: "b", board: "scripted", position: [5, 0], radios: [radio], firmware: firmware[1] },
    ],
  };
}

function bleDoc(): Doc {
  return radioDoc({ phy: "ble" }, [
    { connect: { peers: ["b"] } },
    { advertise: true },
  ]);
}

function nodesOf(doc: Doc): Doc[] {
  return doc.nodes as Doc[];
}

function parse(doc: Doc | string): Scenario {
  return parseScenario(typeof doc === "string" ? doc : stringify(doc));
}

/** The scenario is refused, and the message starts with the path of the offending field. */
function expectInvalid(doc: Doc | string, path: string, words?: string): ScenarioError {
  const error = assertThrows(() => parse(doc), ScenarioError);
  assert(
    error.message.startsWith(`${path}:`),
    `expected an error at ${path}, got: ${error.message}`,
  );
  if (words !== undefined) assertStringIncludes(error.message, words);
  return error;
}

function edit(mutate: (doc: Doc) => void, base: () => Doc = wifiDoc): Doc {
  const doc = base();
  mutate(doc);
  return doc;
}

// ── scenario: regressions ───────────────────────────────────────────────────

Deno.test("scenario: one node entry with count 3 is three boards, enough for a run", () => {
  const scenario = parse(edit((d) => {
    d.nodes = [{
      id: "s",
      count: 3,
      board: "scripted",
      position: { grid: { origin: [0, 0], step: [5, 0] } },
    }];
  }));
  assertEquals(scenario.nodes.map((n) => n.id), ["s-1", "s-2", "s-3"]);
});

Deno.test("scenario: count expansion past 10 boards is refused", () => {
  expectInvalid(
    edit((d) => {
      d.nodes = [0, 1, 2].map((i) => ({
        id: `s${i}`,
        count: 4,
        board: "scripted",
        position: { grid: { origin: [i * 50, 0], step: [5, 0] } },
      }));
    }),
    "nodes",
    "got 12",
  );
});

Deno.test("scenario: a metric link with two arrows is refused", () => {
  expectInvalid(
    edit((d) => {
      d.assertions = [{ metric: { link: "a->b->a", sent: { gt: 0 } } }];
    }),
    "assertions[0].metric.link",
    "from->to",
  );
});

Deno.test("scenario: a node address with a leading zero is refused, not a second .12", () => {
  expectInvalid(
    edit((d) => {
      nodesOf(d)[0]!.ip = "192.168.4.012";
    }),
    "nodes[0].ip",
  );
  expectInvalid(edit((d) => (d.network = { subnet: "192.168.004.0/24" })), "network.subnet");
});

Deno.test("scenario: a duration past the longest timer is refused instead of ending at once", () => {
  expectInvalid(edit((d) => (d.duration = "40000m")), "duration", "at most");
  // The longest one a timer keeps.
  assertEquals(parse(edit((d) => (d.duration = "2147483647ms"))).durationMs, 2 ** 31 - 1);
});

Deno.test("scenario: a timeline label used twice, or named start, is refused", () => {
  expectInvalid(
    edit((d) => {
      d.timeline = [{ at: "100ms", label: "x" }, { at: "200ms", label: "x" }];
    }),
    "timeline[1].label",
    "already",
  );
  expectInvalid(
    edit((d) => {
      d.timeline = [{ at: "100ms", label: "start" }];
    }),
    "timeline[0].label",
    "start",
  );
});

// ── scenario: every field refused where it is wrong ─────────────────────────

const n0 = (d: Doc) => nodesOf(d)[0]!;
const fw0 = (d: Doc) => (n0(d).firmware ??= {}) as Doc;
const lora = () => radioDoc({ phy: "lora" });
const nrf = () => radioDoc({ phy: "nrf24" });
const loraRadio = (d: Doc) => (n0(d).radios as Doc[])[0]!;

/** [case name, scenario, path the error must name, words it must carry]. */
const INVALID: [string, Doc | string, string, string?][] = [
  // the document
  ["not YAML", "name: [unclosed", "not valid YAML"],
  ["a list, not a mapping", "- a\n- b\n", "scenario", "mapping"],
  ["unknown top-level field", edit((d) => (d.nodez = [])), "scenario.nodez", "unknown field"],
  ["name missing", edit((d) => delete d.name), "name", "non-empty string"],
  ["name empty", edit((d) => (d.name = "")), "name"],
  ["seed negative", edit((d) => (d.seed = -1)), "seed", "between"],
  ["seed past 32 bits", edit((d) => (d.seed = 2 ** 32)), "seed"],
  ["seed fractional", edit((d) => (d.seed = 1.5)), "seed", "integer"],
  ["seed a string", edit((d) => (d.seed = "7")), "seed", "number"],
  ["duration missing", edit((d) => delete d.duration), "duration", "unit"],
  ["duration a bare number", edit((d) => (d.duration = 5)), "duration", "unit"],
  ["duration in hours", edit((d) => (d.duration = "1h")), "duration", "not a duration"],
  ["duration negative", edit((d) => (d.duration = "-1s")), "duration", "not a duration"],
  ["duration zero", edit((d) => (d.duration = "0s")), "duration", "positive"],
  // environment
  ["environment a list", edit((d) => (d.environment = [])), "environment", "mapping"],
  ["environment unknown", edit((d) => (d.environment = { fog: 1 })), "environment.fog"],
  ["preset unknown", edit((d) => (d.environment = { preset: "moon" })), "environment.preset"],
  ["preset empty", edit((d) => (d.environment = { preset: "" })), "environment.preset"],
  ["retry_limit 0", edit((d) => (d.environment = { retry_limit: 0 })), "environment.retry_limit"],
  ["retry_limit 33", edit((d) => (d.environment = { retry_limit: 33 })), "environment.retry_limit"],
  [
    "path_loss_exponent 0.5",
    edit((d) => (d.environment = { path_loss_exponent: 0.5 })),
    "environment.path_loss_exponent",
  ],
  [
    "shadowing 31 dB",
    edit((d) => (d.environment = { shadowing_sigma_db: 31 })),
    "environment.shadowing_sigma_db",
  ],
  [
    "noise figure negative",
    edit((d) => (d.environment = { noise_figure_db: -1 })),
    "environment.noise_figure_db",
  ],
  [
    "base latency 10001 ms",
    edit((d) => (d.environment = { base_latency_ms: 10001 })),
    "environment.base_latency_ms",
  ],
  [
    "obstacles a mapping",
    edit((d) => (d.environment = { obstacles: {} })),
    "environment.obstacles",
    "list",
  ],
  [
    "obstacle unknown field",
    edit((
      d,
    ) => (d.environment = { obstacles: [{ polygon: [[0, 0], [1, 1]], attenuation_db: 3, h: 1 }] })),
    "environment.obstacles[0].h",
  ],
  [
    "obstacle of one point",
    edit((d) => (d.environment = { obstacles: [{ polygon: [[0, 0]], attenuation_db: 3 }] })),
    "environment.obstacles[0].polygon",
    "two points",
  ],
  [
    "obstacle negative attenuation",
    edit((
      d,
    ) => (d.environment = { obstacles: [{ polygon: [[0, 0], [1, 1]], attenuation_db: -1 }] })),
    "environment.obstacles[0].attenuation_db",
  ],
  [
    "obstacle point of one coordinate",
    edit((d) => (d.environment = { obstacles: [{ polygon: [[0], [1, 1]], attenuation_db: 3 }] })),
    "environment.obstacles[0].polygon[0]",
  ],
  // network
  ["network a string", edit((d) => (d.network = "lan")), "network", "mapping"],
  [
    "network unknown",
    edit((d) => (d.network = { subnet: "10.0.0.0/24", vlan: 2 })),
    "network.vlan",
  ],
  ["subnet /16", edit((d) => (d.network = { subnet: "10.0.0.0/16" })), "network.subnet", "/24"],
  ["subnet octet 300", edit((d) => (d.network = { subnet: "10.300.0.0/24" })), "network.subnet"],
  ["subnet not ending .0", edit((d) => (d.network = { subnet: "10.0.0.5/24" })), "network.subnet"],
  // nodes
  ["nodes missing", edit((d) => delete d.nodes), "nodes", "list"],
  ["one board", edit((d) => nodesOf(d).pop()), "nodes", "got 1"],
  [
    "eleven entries",
    edit((
      d,
    ) => (d.nodes = Array.from(
      { length: 11 },
      (_, i) => ({ id: `n${i}`, board: "scripted", position: [i, 0] }),
    ))),
    "nodes",
    "got 11",
  ],
  ["node a string", edit((d) => (nodesOf(d)[0] = "a" as unknown as Doc)), "nodes[0]", "mapping"],
  ["node unknown field", edit((d) => (n0(d).colour = "red")), "nodes[0].colour"],
  ["node id missing", edit((d) => delete n0(d).id), "nodes[0].id"],
  ["count 0", edit((d) => (n0(d).count = 0)), "nodes[0].count"],
  ["count 11", edit((d) => (n0(d).count = 11)), "nodes[0].count"],
  ["board missing", edit((d) => delete n0(d).board), "nodes[0].board"],
  ["board unknown", edit((d) => (n0(d).board = "uno")), "nodes[0].board", "unknown board"],
  ["board esp32-c3", edit((d) => (n0(d).board = "esp32-c3")), "nodes[0].board", "C3"],
  ["board esp32-s3", edit((d) => (n0(d).board = "esp32-s3")), "nodes[0].board", "S3"],
  [
    "internet_gateway a string",
    edit((d) => (n0(d).internet_gateway = "yes")),
    "nodes[0].internet_gateway",
    "true or false",
  ],
  [
    "internet_gateway on a scripted board",
    edit((d) => (n0(d).internet_gateway = true)),
    "nodes[0].internet_gateway",
    "single esp32",
  ],
  [
    "internet_gateway with count 2",
    edit((d) => {
      Object.assign(n0(d), {
        board: "esp32",
        firmware: "fw.bin",
        internet_gateway: true,
        count: 2,
        position: { grid: { origin: [0, 0], step: [1, 0] } },
      });
    }),
    "nodes[0].internet_gateway",
  ],
  [
    "internet_gateway on a LoRa node",
    edit(
      (d) => Object.assign(n0(d), { board: "esp32", firmware: "fw.bin", internet_gateway: true }),
      lora,
    ),
    "nodes[0].internet_gateway",
    "Wi-Fi notion",
  ],
  [
    "two internet gateways",
    edit((d) => {
      d.nodes = [0, 1, 2, 3].map((i) => ({
        id: `n${i}`,
        board: "esp32",
        firmware: "fw.bin",
        position: [i, 0],
        ...(i < 2 ? { internet_gateway: true } : {}),
      }));
    }),
    "nodes",
    "at most one",
  ],
  [
    "a gateway and one board on the medium",
    edit((d) =>
      Object.assign(n0(d), { board: "esp32", firmware: "fw.bin", internet_gateway: true })
    ),
    "nodes",
    "at least two",
  ],
  [
    "ip on a LoRa node",
    edit((d) => (n0(d).ip = "192.168.4.20"), lora),
    "nodes[0].ip",
    "Wi-Fi notion",
  ],
  [
    "ip with count 2",
    edit((d) =>
      Object.assign(n0(d), {
        ip: "192.168.4.20",
        count: 2,
        position: { grid: { origin: [0, 0], step: [1, 0] } },
      })
    ),
    "nodes[0].ip",
    "count > 1",
  ],
  ["ip outside the subnet", edit((d) => (n0(d).ip = "10.0.0.20")), "nodes[0].ip", "not inside"],
  ["ip of the gateway", edit((d) => (n0(d).ip = "192.168.4.1")), "nodes[0].ip", "gateway"],
  ["ip of the broadcast", edit((d) => (n0(d).ip = "192.168.4.255")), "nodes[0].ip"],
  ["ip of the network", edit((d) => (n0(d).ip = "192.168.4.0")), "nodes[0].ip"],
  ["ip not a string", edit((d) => (n0(d).ip = 20)), "nodes[0].ip"],
  ["id with a space", edit((d) => (n0(d).id = "a b")), "nodes", "letters, digits"],
  ["id starting with a dash", edit((d) => (n0(d).id = "-a")), "nodes", "letters, digits"],
  ["duplicate id", edit((d) => (nodesOf(d)[1]!.id = "a")), "nodes", "duplicate node id"],
  ["two nodes on one address", edit((d) => (nodesOf(d)[1]!.ip = "192.168.4.11")), "nodes", "share"],
  ["position missing", edit((d) => delete n0(d).position), "nodes[0].position", "mapping"],
  [
    "position of one coordinate",
    edit((d) => (n0(d).position = [1])),
    "nodes[0].position",
    "[x, y]",
  ],
  [
    "position of four coordinates",
    edit((d) => (n0(d).position = [1, 2, 3, 4])),
    "nodes[0].position",
  ],
  [
    "position not numbers",
    edit((d) => (n0(d).position = [1, "a"])),
    "nodes[0].position[1]",
    "number",
  ],
  [
    "count 2 with a fixed position",
    edit((d) => (n0(d).count = 2)),
    "nodes[0].position",
    "grid",
  ],
  [
    "position mapping without grid",
    edit((d) => (n0(d).position = { at: [0, 0] })),
    "nodes[0].position.at",
  ],
  [
    "grid unknown field",
    edit((d) => (n0(d).position = { grid: { origin: [0, 0], step: [1, 0], jitter: 1 } })),
    "nodes[0].position.grid.jitter",
  ],
  [
    "grid without origin",
    edit((d) => (n0(d).position = { grid: { step: [1, 0] } })),
    "nodes[0].position.grid.origin",
  ],
  ["esp32 without firmware", edit((d) => (n0(d).board = "esp32")), "nodes[0].firmware"],
  ["mixed PHYs", edit((d) => (nodesOf(d)[1]!.radios = [{ phy: "lora" }])), "nodes", "one PHY"],
  // radios
  ["radios a mapping", edit((d) => (n0(d).radios = { phy: "wifi" })), "nodes[0].radios", "list"],
  [
    "two radios",
    edit((d) => (n0(d).radios = [{ phy: "wifi" }, { phy: "wifi" }])),
    "nodes[0].radios",
    "exactly one",
  ],
  ["radio a string", edit((d) => (n0(d).radios = ["wifi"])), "nodes[0].radios[0]", "mapping"],
  [
    "radio phy unknown",
    edit((d) => (n0(d).radios = [{ phy: "zigbee" }])),
    "nodes[0].radios[0].phy",
  ],
  [
    "wifi radio unknown field",
    edit((d) => (n0(d).radios = [{ phy: "wifi", sf: 7 }])),
    "nodes[0].radios[0].sf",
  ],
  [
    "wifi channel 0",
    edit((d) => (n0(d).radios = [{ phy: "wifi", channel: 0 }])),
    "nodes[0].radios[0].channel",
  ],
  [
    "wifi channel 15",
    edit((d) => (n0(d).radios = [{ phy: "wifi", channel: 15 }])),
    "nodes[0].radios[0].channel",
  ],
  [
    "wifi power 31 dBm",
    edit((d) => (n0(d).radios = [{ phy: "wifi", tx_power_dbm: 31 }])),
    "nodes[0].radios[0].tx_power_dbm",
  ],
  [
    "wifi antenna 31 dBi",
    edit((d) => (n0(d).radios = [{ phy: "wifi", antenna_gain_dbi: 31 }])),
    "nodes[0].radios[0].antenna_gain_dbi",
  ],
  [
    "lora unknown field",
    edit((d) => (loraRadio(d).channel = 3), lora),
    "nodes[0].radios[0].channel",
  ],
  [
    "lora 100 kHz",
    edit((d) => (loraRadio(d).bw_khz = 100), lora),
    "nodes[0].radios[0].bw_khz",
    "100 kHz",
  ],
  ["lora SF5", edit((d) => (loraRadio(d).sf = 5), lora), "nodes[0].radios[0].sf"],
  ["lora SF13", edit((d) => (loraRadio(d).sf = 13), lora), "nodes[0].radios[0].sf"],
  ["lora cr 4/9", edit((d) => (loraRadio(d).cr = "4/9"), lora), "nodes[0].radios[0].cr", "4/5"],
  ["lora cr 5/4", edit((d) => (loraRadio(d).cr = "5/4"), lora), "nodes[0].radios[0].cr"],
  ["lora cr 9", edit((d) => (loraRadio(d).cr = 9), lora), "nodes[0].radios[0].cr"],
  [
    "lora 100 MHz",
    edit((d) => (loraRadio(d).frequency_mhz = 100), lora),
    "nodes[0].radios[0].frequency_mhz",
  ],
  [
    "lora sync word 256",
    edit((d) => (loraRadio(d).sync_word = 256), lora),
    "nodes[0].radios[0].sync_word",
  ],
  [
    "lora preamble 5",
    edit((d) => (loraRadio(d).preamble = 5), lora),
    "nodes[0].radios[0].preamble",
  ],
  [
    "lora crc a string",
    edit((d) => (loraRadio(d).crc = "on"), lora),
    "nodes[0].radios[0].crc",
    "true or false",
  ],
  [
    "lora power 1 dBm",
    edit((d) => (loraRadio(d).tx_power_dbm = 1), lora),
    "nodes[0].radios[0].tx_power_dbm",
  ],
  [
    "lora power 21 dBm",
    edit((d) => (loraRadio(d).tx_power_dbm = 21), lora),
    "nodes[0].radios[0].tx_power_dbm",
  ],
  [
    "lora pins a list",
    edit((d) => (loraRadio(d).pins = [5]), lora),
    "nodes[0].radios[0].pins",
    "mapping",
  ],
  [
    "lora pins unknown",
    edit((d) => (loraRadio(d).pins = { csn: 5 }), lora),
    "nodes[0].radios[0].pins.csn",
  ],
  [
    "lora cs unwired",
    edit((d) => (loraRadio(d).pins = { cs: null }), lora),
    "nodes[0].radios[0].pins.cs",
    "wired",
  ],
  [
    "lora cs GPIO 40",
    edit((d) => (loraRadio(d).pins = { cs: 40 }), lora),
    "nodes[0].radios[0].pins.cs",
  ],
  [
    "nrf24 500 kbit/s",
    edit((d) => (loraRadio(d).data_rate_kbps = 500), nrf),
    "nodes[0].radios[0].data_rate_kbps",
    "250, 1000 or 2000",
  ],
  [
    "nrf24 -10 dBm",
    edit((d) => (loraRadio(d).tx_power_dbm = -10), nrf),
    "nodes[0].radios[0].tx_power_dbm",
    "-18, -12",
  ],
  [
    "nrf24 delay 300 us",
    edit((d) => (loraRadio(d).retry_delay_us = 300), nrf),
    "nodes[0].radios[0].retry_delay_us",
    "multiple of 250",
  ],
  [
    "nrf24 channel 126",
    edit((d) => (loraRadio(d).channel = 126), nrf),
    "nodes[0].radios[0].channel",
  ],
  ["nrf24 retries 16", edit((d) => (loraRadio(d).retries = 16), nrf), "nodes[0].radios[0].retries"],
  [
    "nrf24 auto_ack a number",
    edit((d) => (loraRadio(d).auto_ack = 1), nrf),
    "nodes[0].radios[0].auto_ack",
  ],
  [
    "nrf24 csn unwired",
    edit((d) => (loraRadio(d).pins = { csn: null }), nrf),
    "nodes[0].radios[0].pins.csn",
    "CSN",
  ],
  [
    "nrf24 ce unwired",
    edit((d) => (loraRadio(d).pins = { ce: null }), nrf),
    "nodes[0].radios[0].pins.ce",
    "CE",
  ],
  [
    "nrf24 pins unknown",
    edit((d) => (loraRadio(d).pins = { cs: 5 }), nrf),
    "nodes[0].radios[0].pins.cs",
  ],
  [
    "ble unknown field",
    edit((d) => (loraRadio(d).channel = 37), bleDoc),
    "nodes[0].radios[0].channel",
  ],
  [
    "ble HCI on UART0",
    edit((d) => (loraRadio(d).hci_uart = 0), bleDoc),
    "nodes[0].radios[0].hci_uart",
    "serial console",
  ],
  [
    "ble HCI on UART3",
    edit((d) => (loraRadio(d).hci_uart = 3), bleDoc),
    "nodes[0].radios[0].hci_uart",
  ],
  [
    "ble power 21 dBm",
    edit((d) => (loraRadio(d).tx_power_dbm = 21), bleDoc),
    "nodes[0].radios[0].tx_power_dbm",
  ],
  // scripted firmware
  ["script a list", edit((d) => (n0(d).firmware = [])), "nodes[0].firmware", "mapping"],
  ["script unknown field", edit((d) => (fw0(d).loop = true)), "nodes[0].firmware.loop"],
  [
    "serve on LoRa",
    edit((d) => (fw0(d).serve = []), lora),
    "nodes[0].firmware.serve",
    "Wi-Fi notion",
  ],
  ["serve a mapping", edit((d) => (fw0(d).serve = {})), "nodes[0].firmware.serve", "list"],
  [
    "serve entry unknown",
    edit((d) => (fw0(d).serve = [{ port: 80, protocol: "http", tls: true }])),
    "nodes[0].firmware.serve[0].tls",
  ],
  [
    "serve ftp",
    edit((d) => (fw0(d).serve = [{ port: 21, protocol: "ftp" }])),
    "nodes[0].firmware.serve[0].protocol",
    "http",
  ],
  [
    "serve port 0",
    edit((d) => (fw0(d).serve = [{ port: 0, protocol: "http" }])),
    "nodes[0].firmware.serve[0].port",
  ],
  [
    "serve one port twice",
    edit((d) => (fw0(d).serve = [{ port: 80, protocol: "http" }, { port: 80, protocol: "mqtt" }])),
    "nodes[0].firmware.serve[1].port",
    "already served",
  ],
  [
    "advertise on Wi-Fi",
    edit((d) => (fw0(d).advertise = true)),
    "nodes[0].firmware.advertise",
    "BLE notion",
  ],
  ["scan on LoRa", edit((d) => (fw0(d).scan = true), lora), "nodes[0].firmware.scan", "BLE notion"],
  [
    "listen on BLE",
    edit((d) => (fw0(d).listen = true), bleDoc),
    "nodes[0].firmware.listen",
    "not a BLE notion",
  ],
  [
    "listen a string",
    edit((d) => (fw0(d).listen = "yes")),
    "nodes[0].firmware.listen",
    "true or false",
  ],
  ["send a mapping", edit((d) => (fw0(d).send = {})), "nodes[0].firmware.send", "list"],
  ["send entry a number", edit((d) => (fw0(d).send = [1])), "nodes[0].firmware.send[0]", "mapping"],
  [
    "send unknown field",
    edit((d) => (fw0(d).send = [{ to: "b", every: "1s", count: 1, ttl: 3 }])),
    "nodes[0].firmware.send[0].ttl",
  ],
  [
    "LoRa send with a to",
    edit((d) => (fw0(d).send = [{ to: "b", every: "1s", count: 1 }]), lora),
    "nodes[0].firmware.send[0].to",
    "no addresses",
  ],
  [
    "ESP-NOW on LoRa",
    edit((d) => (fw0(d).send = [{ via: "espnow", every: "1s", count: 1 }]), lora),
    "nodes[0].firmware.send[0].via",
    "wifi radio",
  ],
  [
    "GATT on Wi-Fi",
    edit((d) => (fw0(d).send = [{ to: "b", via: "gatt", every: "1s", count: 1 }])),
    "nodes[0].firmware.send[0].via",
    "ble radio",
  ],
  [
    "UDP on BLE",
    edit((d) => (fw0(d).send = [{ to: "b", via: "udp", every: "1s", count: 1 }]), bleDoc),
    "nodes[0].firmware.send[0].via",
    "gatt",
  ],
  [
    "via tcp",
    edit((d) => (fw0(d).send = [{ to: "b", via: "tcp", every: "1s", count: 1 }])),
    "nodes[0].firmware.send[0].via",
    "udp",
  ],
  [
    "Wi-Fi send without a to",
    edit((d) => (fw0(d).send = [{ every: "1s", count: 1 }])),
    "nodes[0].firmware.send[0].to",
  ],
  [
    "broadcast over UDP",
    edit((d) => (fw0(d).send = [{ to: "broadcast", every: "1s", count: 1 }])),
    "nodes[0].firmware.send[0].to",
    "via: espnow",
  ],
  [
    "a port on ESP-NOW",
    edit((d) => (fw0(d).send = [{ to: "b", via: "espnow", port: 9, every: "1s", count: 1 }])),
    "nodes[0].firmware.send[0].port",
    "ESP-NOW has no ports",
  ],
  [
    "a port on GATT",
    edit((d) => (fw0(d).send = [{ to: "b", port: 9, every: "1s", count: 1 }]), bleDoc),
    "nodes[0].firmware.send[0].port",
    "GATT has no ports",
  ],
  [
    "ESP-NOW payload of 201 bytes",
    edit((
      d,
    ) => (fw0(d).send = [{
      to: "b",
      via: "espnow",
      payload: "x".repeat(201),
      every: "1s",
      count: 1,
    }])),
    "nodes[0].firmware.send[0].payload",
    "200 bytes",
  ],
  [
    "GATT payload of 15 bytes",
    edit(
      (d) => (fw0(d).send = [{ to: "b", payload: "x".repeat(15), every: "1s", count: 1 }]),
      bleDoc,
    ),
    "nodes[0].firmware.send[0].payload",
    "14 bytes",
  ],
  [
    "send without every",
    edit((d) => (fw0(d).send = [{ to: "b", count: 1 }])),
    "nodes[0].firmware.send[0].every",
  ],
  [
    "send count 0",
    edit((d) => (fw0(d).send = [{ to: "b", every: "1s", count: 0 }])),
    "nodes[0].firmware.send[0].count",
  ],
  [
    "send count 100001",
    edit((d) => (fw0(d).send = [{ to: "b", every: "1s", count: 100_001 }])),
    "nodes[0].firmware.send[0].count",
  ],
  [
    "send start without unit",
    edit((d) => (fw0(d).send = [{ to: "b", every: "1s", count: 1, start: 5 }])),
    "nodes[0].firmware.send[0].start",
  ],
  [
    "send port 65536",
    edit((d) => (fw0(d).send = [{ to: "b", every: "1s", count: 1, port: 65536 }])),
    "nodes[0].firmware.send[0].port",
  ],
  [
    "send payload empty",
    edit((d) => (fw0(d).send = [{ to: "b", every: "1s", count: 1, payload: "" }])),
    "nodes[0].firmware.send[0].payload",
  ],
  // the BLE script
  [
    "advertise name of 27 bytes",
    edit((d) => (nodesOf(d)[1]!.firmware = { advertise: { name: "n".repeat(27) } }), bleDoc),
    "nodes[1].firmware.advertise.name",
    "26 bytes",
  ],
  [
    "advertise unknown field",
    edit((d) => (nodesOf(d)[1]!.firmware = { advertise: { power: 3 } }), bleDoc),
    "nodes[1].firmware.advertise.power",
  ],
  [
    "advertise every 10 ms",
    edit((d) => (nodesOf(d)[1]!.firmware = { advertise: { interval: "10ms" } }), bleDoc),
    "nodes[1].firmware.advertise.interval",
    "between 20 ms",
  ],
  [
    "advertise interval off the 0.625 ms grid",
    edit((d) => (nodesOf(d)[1]!.firmware = { advertise: { interval: "100.3ms" } }), bleDoc),
    "nodes[1].firmware.advertise.interval",
    "multiple of 0.625",
  ],
  [
    "advertise a number",
    edit((d) => (nodesOf(d)[1]!.firmware = { advertise: 3 }), bleDoc),
    "nodes[1].firmware.advertise",
    "mapping",
  ],
  [
    "connect a list",
    edit((d) => (fw0(d).connect = ["b"]), bleDoc),
    "nodes[0].firmware.connect",
    "mapping",
  ],
  [
    "connect unknown field",
    edit((d) => (fw0(d).connect = { peers: ["b"], latency: 1 }), bleDoc),
    "nodes[0].firmware.connect.latency",
  ],
  [
    "connect to nobody",
    edit((d) => (fw0(d).connect = { peers: [] }), bleDoc),
    "nodes[0].firmware.connect.peers",
    "no node",
  ],
  [
    "connect peers a string",
    edit((d) => (fw0(d).connect = { peers: "b" }), bleDoc),
    "nodes[0].firmware.connect.peers",
  ],
  [
    "connect interval 5 ms",
    edit((d) => (fw0(d).connect = { peers: ["b"], interval: "5ms" }), bleDoc),
    "nodes[0].firmware.connect.interval",
  ],
  [
    "connect interval off the 1.25 ms grid",
    edit((d) => (fw0(d).connect = { peers: ["b"], interval: "8ms" }), bleDoc),
    "nodes[0].firmware.connect.interval",
    "multiple of 1.25",
  ],
  [
    "supervision timeout under twice the interval",
    edit((d) => (fw0(d).connect = { peers: ["b"], interval: "100ms", timeout: "200ms" }), bleDoc),
    "nodes[0].firmware.connect.timeout",
    "twice",
  ],
  [
    "supervision timeout off the 10 ms grid",
    edit((d) => (fw0(d).connect = { peers: ["b"], timeout: "1005ms" }), bleDoc),
    "nodes[0].firmware.connect.timeout",
    "multiple of 10",
  ],
  [
    "scan a string",
    edit((d) => (fw0(d).scan = "yes"), bleDoc),
    "nodes[0].firmware.scan",
    "true or false",
  ],
  [
    "advertise and connect",
    edit((d) => (fw0(d).advertise = true), bleDoc),
    "nodes[0].firmware",
    "not both",
  ],
  [
    "connect to an unknown peer",
    edit((d) => (fw0(d).connect = { peers: ["z"] }), bleDoc),
    "nodes[0].firmware.connect.peers[0]",
    "no node",
  ],
  [
    "connect to itself",
    edit((d) => (fw0(d).connect = { peers: ["a"] }), bleDoc),
    "nodes[0].firmware.connect.peers[0]",
    "itself",
  ],
  [
    "GATT send without a connection",
    edit((d) => {
      d.nodes = [
        {
          id: "a",
          board: "scripted",
          position: [0, 0],
          radios: [{ phy: "ble" }],
          firmware: { advertise: true, send: [{ to: "b", every: "1s", count: 1 }] },
        },
        {
          id: "b",
          board: "scripted",
          position: [1, 0],
          radios: [{ phy: "ble" }],
          firmware: { advertise: true },
        },
      ];
    }),
    "nodes[0].firmware.send[0].to",
    "neither",
  ],
  // sends against the nodes
  [
    "send to an unknown node",
    edit((d) => (fw0(d).send = [{ to: "z", every: "1s", count: 1 }])),
    "nodes[0].firmware.send[0].to",
    "no node",
  ],
  [
    "send to itself",
    edit((d) => (fw0(d).send = [{ to: "a", every: "1s", count: 1 }])),
    "nodes[0].firmware.send[0].to",
    "itself",
  ],
  // links
  ["links a mapping", edit((d) => (d.links = {})), "links", "list"],
  [
    "link unknown field",
    edit((d) => (d.links = [{ from: "a", to: "b", delay: 1 }])),
    "links[0].delay",
  ],
  ["link without from", edit((d) => (d.links = [{ to: "b" }])), "links[0].from"],
  [
    "link loss 101 %",
    edit((d) => (d.links = [{ from: "a", to: "b", extra_loss_pct: 101 }])),
    "links[0].extra_loss_pct",
  ],
  [
    "link latency 60001 ms",
    edit((d) => (d.links = [{ from: "a", to: "b", extra_latency_ms: 60_001 }])),
    "links[0].extra_latency_ms",
  ],
  [
    "link jitter negative",
    edit((d) => (d.links = [{ from: "a", to: "b", extra_jitter_ms: -1 }])),
    "links[0].extra_jitter_ms",
  ],
  [
    "link interference 101 dB",
    edit((d) => (d.links = [{ from: "a", to: "b", interference_db: 101 }])),
    "links[0].interference_db",
  ],
  [
    "link from no node",
    edit((d) => (d.links = [{ from: "z*", to: "b" }])),
    "links[0].from",
    "matches no node",
  ],
  [
    "link to no node",
    edit((d) => (d.links = [{ from: "a", to: "z" }])),
    "links[0].to",
    "matches no node",
  ],
  // timeline
  ["timeline a mapping", edit((d) => (d.timeline = {})), "timeline", "list"],
  [
    "timeline entry unknown",
    edit((d) => (d.timeline = [{ at: "1ms", label: "x", fade: 1 }])),
    "timeline[0].fade",
  ],
  [
    "timeline entry empty",
    edit((d) => (d.timeline = [{ at: "1ms" }])),
    "timeline[0]",
    "move, a link or a label",
  ],
  ["timeline without at", edit((d) => (d.timeline = [{ label: "x" }])), "timeline[0].at"],
  [
    "timeline label empty",
    edit((d) => (d.timeline = [{ at: "1ms", label: "" }])),
    "timeline[0].label",
  ],
  [
    "move a list",
    edit((d) => (d.timeline = [{ at: "1ms", move: [] }])),
    "timeline[0].move",
    "mapping",
  ],
  [
    "move unknown field",
    edit((d) => (d.timeline = [{ at: "1ms", move: { node: "a", to: [1, 1], speed: 1 } }])),
    "timeline[0].move.speed",
  ],
  [
    "move without node",
    edit((d) => (d.timeline = [{ at: "1ms", move: { to: [1, 1] } }])),
    "timeline[0].move.node",
  ],
  [
    "move to a bad place",
    edit((d) => (d.timeline = [{ at: "1ms", move: { node: "a", to: [1] } }])),
    "timeline[0].move.to",
  ],
  [
    "move an unknown node",
    edit((d) => (d.timeline = [{ at: "1ms", move: { node: "z", to: [1, 1] } }])),
    "timeline[0].move.node",
    "no node",
  ],
  [
    "move the internet gateway",
    edit((d) => {
      d.nodes = [
        { id: "gw", board: "esp32", firmware: "fw.bin", position: [0, 0], internet_gateway: true },
        { id: "a", board: "scripted", position: [1, 0] },
        { id: "b", board: "scripted", position: [2, 0] },
      ];
      d.timeline = [{ at: "1ms", move: { node: "gw", to: [5, 5] } }];
    }),
    "timeline[0].move.node",
    "internet gateway",
  ],
  [
    "timeline link to no node",
    edit((d) => (d.timeline = [{ at: "1ms", link: { from: "a", to: "q" } }])),
    "timeline[0].link.to",
  ],
  [
    "timeline link from no node",
    edit((d) => (d.timeline = [{ at: "1ms", link: { from: "q", to: "a" } }])),
    "timeline[0].link.from",
  ],
  [
    "timeline after the end",
    edit((d) => (d.timeline = [{ at: "2s", label: "late" }])),
    "timeline[0].at",
    "after the end",
  ],
  // assertions
  ["assertions a mapping", edit((d) => (d.assertions = {})), "assertions", "list"],
  [
    "assertion with two kinds",
    edit((
      d,
    ) => (d.assertions = [{ serial: { node: "a", contains: "x" }, metric: { link: "a->b" } }])),
    "assertions[0]",
    "exactly one",
  ],
  [
    "assertion of an unknown kind",
    edit((d) => (d.assertions = [{ pcap: {} }])),
    "assertions[0]",
    '"serial" or "metric"',
  ],
  [
    "serial unknown field",
    edit((d) => (d.assertions = [{ serial: { node: "a", contains: "x", regex: true } }])),
    "assertions[0].serial.regex",
  ],
  [
    "serial of no node",
    edit((d) => (d.assertions = [{ serial: { node: "z", contains: "x" } }])),
    "assertions[0].serial.node",
    "no node",
  ],
  [
    "serial without contains",
    edit((d) => (d.assertions = [{ serial: { node: "a" } }])),
    "assertions[0].serial.contains",
  ],
  [
    "serial within without unit",
    edit((d) => (d.assertions = [{ serial: { node: "a", contains: "x", within: 5 } }])),
    "assertions[0].serial.within",
  ],
  [
    "metric link without arrow",
    edit((d) => (d.assertions = [{ metric: { link: "a-b", sent: { gt: 0 } } }])),
    "assertions[0].metric.link",
    "from->to",
  ],
  [
    "metric unknown field",
    edit((d) => (d.assertions = [{ metric: { link: "a->b", jitter: { lt: 1 } } }])),
    "assertions[0].metric.jitter",
  ],
  [
    "metric without checks",
    edit((d) => (d.assertions = [{ metric: { link: "a->b" } }])),
    "assertions[0].metric",
    "at least one",
  ],
  [
    "metric field a number",
    edit((d) => (d.assertions = [{ metric: { link: "a->b", sent: 3 } }])),
    "assertions[0].metric.sent",
    "mapping",
  ],
  [
    "metric op ne",
    edit((d) => (d.assertions = [{ metric: { link: "a->b", sent: { ne: 3 } } }])),
    "assertions[0].metric.sent.ne",
    "unknown comparison",
  ],
  [
    "metric value a string",
    edit((d) => (d.assertions = [{ metric: { link: "a->b", sent: { gt: "3" } } }])),
    "assertions[0].metric.sent.gt",
    "number",
  ],
  [
    "metric kind unknown",
    edit((d) => (d.assertions = [{ metric: { link: "a->b", kind: "zigbee", sent: { gt: 0 } } }])),
    "assertions[0].metric.kind",
    "unknown frame kind",
  ],
  [
    "metric phase unknown",
    edit((d) => (d.assertions = [{ metric: { link: "a->b", phase: "late", sent: { gt: 0 } } }])),
    "assertions[0].metric.phase",
    "no timeline label",
  ],
  [
    "metric link from no node",
    edit((d) => (d.assertions = [{ metric: { link: "z->b", sent: { gt: 0 } } }])),
    "assertions[0].metric.link",
    "matches no node",
  ],
  [
    "metric link to no node",
    edit((d) => (d.assertions = [{ metric: { link: "a->z", sent: { gt: 0 } } }])),
    "assertions[0].metric.link",
    "matches no node",
  ],
  // outputs
  ["outputs a list", edit((d) => (d.outputs = [])), "outputs", "mapping"],
  ["outputs unknown", edit((d) => (d.outputs = { html: "x" })), "outputs.html"],
  ["outputs metrics empty", edit((d) => (d.outputs = { metrics: "" })), "outputs.metrics"],
  ["outputs pcap a number", edit((d) => (d.outputs = { pcap: 1 })), "outputs.pcap"],
];

Deno.test(`scenario: ${INVALID.length} invalid scenarios are each refused at the offending field`, async (t) => {
  for (const [name, doc, path, words] of INVALID) {
    await t.step(name, () => {
      expectInvalid(doc, path, words);
    });
  }
});

// ── scenario: what a valid file turns into ──────────────────────────────────

Deno.test("scenario: defaults fill in what a minimal file leaves out", () => {
  const s = parse(wifiDoc());
  assertEquals(s.seed, 1);
  assertEquals(s.phy, "wifi");
  assertEquals(s.retryLimit, 7);
  assertEquals(s.subnetPrefix, "192.168.4");
  assertEquals(s.nodes.map((n) => [n.ip, n.mac]), [
    ["192.168.4.11", "02:68:7a:62:01:01"],
    ["192.168.4.12", "02:68:7a:62:01:02"],
  ]);
  assertEquals(s.nodes[0]!.radio, { phy: "wifi", channel: 6, txPowerDbm: 15, antennaGainDbi: 0 });
  assertEquals(s.nodes[0]!.firmware, {
    kind: "script",
    send: [],
    serve: [],
    listen: true,
    ble: null,
  });
  assertEquals(s.outputs, { metrics: null, pcap: null, events: null });
  assertEquals([s.links, s.timeline, s.assertions, s.bridge], [[], [], [], null]);
});

Deno.test("scenario: durations take ms, s and m, and trim spaces", () => {
  assertEquals(parseDuration("500ms", "d"), 500);
  assertEquals(parseDuration(" 1.5s ", "d"), 1500);
  assertEquals(parseDuration("2m", "d"), 120_000);
  assertThrows(() => parseDuration(1000, "d"), ScenarioError, "unit");
  assertThrows(() => parseDuration("1.s", "d"), ScenarioError, "not a duration");
});

Deno.test("scenario: positions are 2-D or 3-D", () => {
  assertEquals(parsePosition([1, 2], "p"), { x: 1, y: 2 });
  assertEquals(parsePosition([1, 2, 3], "p"), { x: 1, y: 2, z: 3 });
  assertThrows(() => parsePosition("1,2", "p"), ScenarioError, "list");
});

Deno.test("scenario: link patterns treat * as any run and everything else literally", () => {
  assert(matchesPattern("sensor-*", "sensor-12"));
  assert(matchesPattern("*", "a"));
  assert(!matchesPattern("a.b", "axb"), "a dot is literal");
  assert(!matchesPattern("a", "ab"), "a pattern matches the whole name");
  assert(matchesPattern("(x)+", "(x)+"));
});

Deno.test("scenario: environment, network and grid values are read as written", () => {
  const s = parse(edit((d) => {
    d.seed = 0;
    d.environment = {
      preset: "free_space",
      retry_limit: 32,
      path_loss_exponent: 3,
      shadowing_sigma_db: 0,
      noise_figure_db: 5,
      base_latency_ms: 2,
      obstacles: [
        { polygon: [[0, -1], [0, 1]], attenuation_db: 6 },
        { polygon: [[5, 5], [6, 5], [6, 6]], attenuation_db: 3 },
      ],
    };
    d.network = { subnet: "10.0.0.0/24" };
    d.nodes = [{
      id: "s",
      count: 3,
      board: "scripted",
      position: { grid: { origin: [1, 2, 3], step: [10, 0] } },
    }];
  }));
  assertEquals(s.seed, 0);
  assertEquals(s.retryLimit, 32);
  assertEquals(s.environment.pathLossExponent, 3);
  assertEquals(s.environment.noiseFigureDb, 5);
  assertEquals(s.environment.baseLatencyMs, 2);
  // Two points are one wall; three are a closed triangle of three walls.
  assertEquals(s.environment.obstacles.length, 4);
  assertEquals(s.environment.obstacles[3], { from: [6, 6], to: [5, 5], attenuationDb: 3 });
  assertEquals(s.nodes.map((n) => n.ip), ["10.0.0.11", "10.0.0.12", "10.0.0.13"]);
  assertEquals(s.nodes.map((n) => n.position), [
    { x: 1, y: 2, z: 3 },
    { x: 11, y: 2, z: 3 },
    { x: 21, y: 2, z: 3 },
  ]);
  // A z on the step alone still gives every node a height.
  const z = parse(edit((d) => {
    d.nodes = [{
      id: "s",
      count: 2,
      board: "scripted",
      position: { grid: { origin: [0, 0], step: [1, 0, 2] } },
    }];
  }));
  assertEquals(z.nodes.map((n) => n.position.z), [0, 2]);
});

Deno.test("scenario: esp32 boards, aliases, firmware kinds and the internet gateway", () => {
  const s = parse(edit((d) => {
    d.nodes = [
      {
        id: "gw",
        board: "esp32-devkit-v1",
        firmware: "fw/gw",
        position: [0, 0],
        internet_gateway: true,
      },
      { id: "a", board: "esp32", firmware: "build/a.bin", position: [1, 0], ip: "192.168.4.200" },
      { id: "b", board: "scripted", position: [2, 0], internet_gateway: false },
    ];
  }));
  assertEquals(s.nodes.map((n) => n.board), ["esp32", "esp32", "scripted"]);
  assertEquals(s.nodes[0]!.firmware, { kind: "sketch", path: "fw/gw" });
  assertEquals(s.nodes[1]!.firmware, { kind: "binary", path: "build/a.bin" });
  assertEquals(s.nodes.map((n) => n.internetGateway), [true, false, false]);
  assertEquals(s.nodes[1]!.ip, "192.168.4.200");
});

Deno.test("scenario: a scripted Wi-Fi board's sends and servers keep their values", () => {
  const s = parse(edit((d) => {
    fw0(d).send = [
      { to: "b", every: "50ms", count: 3, start: "1s", port: 7000, payload: "hi" },
      { to: "broadcast", via: "espnow", every: "1s", count: 2, payload: "x".repeat(200) },
    ];
    fw0(d).serve = [{ port: 80, protocol: "http" }, { port: 1883, protocol: "mqtt" }];
    fw0(d).listen = true;
  }));
  const fw = s.nodes[0]!.firmware;
  assert(fw.kind === "script");
  assertEquals(fw.send[0], {
    to: "b",
    via: "udp",
    everyMs: 50,
    count: 3,
    startMs: 1000,
    port: 7000,
    payload: "hi",
  });
  assertEquals([fw.send[1]!.to, fw.send[1]!.via, fw.send[1]!.port, fw.send[1]!.startMs], [
    "broadcast",
    "espnow",
    5000,
    0,
  ]);
  assertEquals(fw.serve, [{ port: 80, protocol: "http" }, { port: 1883, protocol: "mqtt" }]);
  assertEquals(fw.listen, true);
  // A board that sends listens only when told to.
  const quiet = parse(edit((d) => (fw0(d).send = [{ to: "b", every: "1s", count: 1 }])));
  assert(quiet.nodes[0]!.firmware.kind === "script" && !quiet.nodes[0]!.firmware.listen);
});

Deno.test("scenario: LoRa and nRF24 radios with every field set, and their defaults", () => {
  const l = parse(radioDoc({
    phy: "lora",
    frequency_mhz: 915.2,
    sf: 12,
    bw_khz: 62.5,
    cr: "4/8",
    sync_word: 0x34,
    preamble: 12,
    crc: false,
    tx_power_dbm: 20,
    antenna_gain_dbi: 2,
    pins: { cs: 18, reset: null, dio0: 33 },
  }, [{ send: [{ every: "1s", count: 1 }] }, {}]));
  assertEquals(l.phy, "lora");
  assertEquals(l.nodes[0]!.radio, {
    phy: "lora",
    frequencyHz: 915_200_000,
    sf: 12,
    bandwidthHz: 62_500,
    codingRate: 8,
    syncWord: 0x34,
    preambleLength: 12,
    crc: false,
    txPowerDbm: 20,
    antennaGainDbi: 2,
    pins: { cs: 18, reset: null, dio0: 33 },
  });
  const fw = l.nodes[0]!.firmware;
  assert(fw.kind === "script");
  assertEquals([fw.send[0]!.to, fw.listen], [null, false]);
  assertEquals(parse(lora()).nodes[1]!.radio, {
    phy: "lora",
    frequencyHz: 868_100_000,
    sf: 7,
    bandwidthHz: 125_000,
    codingRate: 5,
    syncWord: 0x12,
    preambleLength: 8,
    crc: true,
    txPowerDbm: 14,
    antennaGainDbi: 0,
    pins: { cs: 5, reset: 14, dio0: 26 },
  });
  assertEquals(
    (parse(radioDoc({ phy: "lora", cr: 6 })).nodes[0]!.radio as { codingRate: number }).codingRate,
    6,
  );
  const n = parse(radioDoc({
    phy: "nrf24",
    channel: 125,
    data_rate_kbps: 250,
    tx_power_dbm: -18,
    auto_ack: false,
    retries: 0,
    retry_delay_us: 4000,
    pins: { csn: 15, ce: 2, irq: 27 },
  }));
  assertEquals(n.nodes[0]!.radio, {
    phy: "nrf24",
    channel: 125,
    dataRate: 250_000,
    txPowerDbm: -18,
    antennaGainDbi: 0,
    autoAck: false,
    retries: 0,
    retryDelayUs: 4000,
    pins: { csn: 15, ce: 2, irq: 27 },
  });
  assertEquals(parse(nrf()).nodes[0]!.radio, {
    phy: "nrf24",
    channel: 76,
    dataRate: 1_000_000,
    txPowerDbm: 0,
    antennaGainDbi: 0,
    autoAck: true,
    retries: 15,
    retryDelayUs: 1500,
    pins: { csn: 5, ce: 4, irq: null },
  });
});

Deno.test("scenario: a BLE central and peripheral, with defaults and explicit timing", () => {
  const s = parse(radioDoc({ phy: "ble", tx_power_dbm: -12, hci_uart: 2 }, [
    {
      connect: { peers: ["b"], interval: "7.5ms", timeout: "100ms" },
      scan: true,
      send: [{ to: "b", every: "1s", count: 1, payload: "x".repeat(14) }],
    },
    {
      advertise: { name: "n".repeat(26), interval: "20ms" },
      send: [{ to: "a", every: "1s", count: 1 }],
    },
  ]));
  assertEquals(s.phy, "ble");
  assertEquals(s.nodes[0]!.radio, { phy: "ble", txPowerDbm: -12, antennaGainDbi: 0, hciUart: 2 });
  const [central, peripheral] = s.nodes.map((n) => n.firmware);
  assert(central?.kind === "script" && peripheral?.kind === "script");
  assertEquals(central.ble, {
    advertise: null,
    connect: { peers: ["b"], intervalMs: 7.5, timeoutMs: 100 },
    scan: true,
  });
  assertEquals(peripheral.ble, {
    advertise: { name: "n".repeat(26), intervalMs: 20 },
    connect: null,
    scan: false,
  });
  assertEquals(central.send[0]!.via, "gatt");
  const d = parse(bleDoc());
  const [c, p] = d.nodes.map((n) => n.firmware);
  assert(c?.kind === "script" && p?.kind === "script");
  assertEquals(c.ble?.connect, { peers: ["b"], intervalMs: 30, timeoutMs: 1000 });
  assertEquals(p.ble?.advertise, { name: "b", intervalMs: 100 });
  assertEquals(d.nodes[0]!.radio, { phy: "ble", txPowerDbm: 0, antennaGainDbi: 0, hciUart: 1 });
  // advertise: false is no advertising at all.
  const off = parse(
    edit((x) => (nodesOf(x)[1]!.firmware = { advertise: false, scan: false }), bleDoc),
  );
  assert(
    off.nodes[1]!.firmware.kind === "script" && off.nodes[1]!.firmware.ble?.advertise === null,
  );
});

Deno.test("scenario: links, timeline and assertions keep their values, the timeline sorted", () => {
  const s = parse(edit((d) => {
    d.duration = "5s";
    d.links = [{
      from: "*",
      to: "b",
      extra_loss_pct: 100,
      extra_latency_ms: 60_000,
      extra_jitter_ms: 3,
      interference_db: 100,
    }];
    d.timeline = [
      { at: "3s", label: "late", link: { from: "a", to: "b" } },
      { at: "1s", move: { node: "a", to: [5, 5, 1] } },
      { at: "5s", label: "end" },
    ];
    d.assertions = [
      { serial: { node: "a", contains: "rx", within: "2s" } },
      { serial: { node: "b", contains: "rx" } },
      {
        metric: {
          link: "a->*",
          phase: "late",
          kind: "udp",
          loss_pct: { lte: 5, gte: 0 },
          sent: { eq: 3 },
        },
      },
      { metric: { link: "*->b", phase: "start", rssi_dbm: { gt: -90 } } },
    ];
    d.outputs = { metrics: "m.json", pcap: "a.pcap", events: "e.jsonl" };
  }));
  assertEquals(s.links[0], {
    from: "*",
    to: "b",
    extraLossPct: 100,
    extraLatencyMs: 60_000,
    extraJitterMs: 3,
    interferenceDb: 100,
  });
  assertEquals(s.timeline.map((e) => [e.atMs, e.label, e.actions.map((a) => a.kind)]), [
    [1000, null, ["move"]],
    [3000, "late", ["link"]],
    [5000, "end", []],
  ]);
  assertEquals(s.assertions[0], { kind: "serial", node: "a", contains: "rx", withinMs: 2000 });
  assertEquals(s.assertions[1], { kind: "serial", node: "b", contains: "rx", withinMs: null });
  assertEquals(s.assertions[2], {
    kind: "metric",
    link: "a->*",
    phase: "late",
    frameKind: "udp",
    checks: [{ field: "sent", op: "eq", value: 3 }, { field: "loss_pct", op: "lte", value: 5 }, {
      field: "loss_pct",
      op: "gte",
      value: 0,
    }],
  });
  assertEquals(s.outputs, { metrics: "m.json", pcap: "a.pcap", events: "e.jsonl" });
});

// ── scenario: the mobile bridge ─────────────────────────────────────────────

/** `fields` over `base`; a field given as undefined is left out. */
function merged(base: Doc, fields: Doc): Doc {
  return Object.fromEntries(
    Object.entries({ ...base, ...fields }).filter(([, v]) => v !== undefined),
  );
}

function ipBridgeDoc(bridge: Doc = {}): Doc {
  return edit((d) => {
    d.bridge = merged(
      { position: [3, 0], expose: [{ node: "a", port: 80, service: "http" }] },
      bridge,
    );
  });
}

function bleBridgeDoc(bridge: Doc = {}): Doc {
  return edit((d) => {
    d.bridge = merged({ position: [3, 0], mirror: "b" }, bridge);
  }, bleDoc);
}

const INVALID_BRIDGE: [string, Doc, string, string?][] = [
  ["on LoRa", edit((d) => (d.bridge = { position: [0, 0] }), lora), "bridge", "lora"],
  ["a list", edit((d) => (d.bridge = [])), "bridge", "mapping"],
  ["a BLE field on Wi-Fi", ipBridgeDoc({ mirror: "a" }), "bridge.mirror", "unknown field"],
  ["an IP field on BLE", bleBridgeDoc({ expose: [] }), "bridge.expose", "unknown field"],
  ["id with a slash", ipBridgeDoc({ id: "a/b" }), "bridge.id", "letters"],
  ["id of a node", ipBridgeDoc({ id: "b" }), "bridge.id", "already a node"],
  ["id gateway", ipBridgeDoc({ id: "gateway" }), "bridge.id", "reserved"],
  ["id broadcast", ipBridgeDoc({ id: "broadcast" }), "bridge.id", "reserved"],
  [
    "a LoRa radio on Wi-Fi",
    ipBridgeDoc({ radios: [{ phy: "lora" }] }),
    "bridge.radios",
    "must be wifi",
  ],
  [
    "a Wi-Fi radio on BLE",
    bleBridgeDoc({ radios: [{ phy: "wifi" }] }),
    "bridge.radios",
    "must be ble",
  ],
  ["no position", ipBridgeDoc({ position: undefined }), "bridge.position"],
  ["ip outside the subnet", ipBridgeDoc({ ip: "10.0.0.5" }), "bridge.ip", "not inside"],
  ["ip not an address", ipBridgeDoc({ ip: "phone" }), "bridge.ip", "not an IPv4"],
  ["ip of a node", ipBridgeDoc({ ip: "192.168.4.12" }), "bridge.ip", "already b's"],
  ["listen not an address", ipBridgeDoc({ listen: "localhost" }), "bridge.listen", "not an IPv4"],
  [
    "advertise_ip not an address",
    ipBridgeDoc({ advertise_ip: "300.1.1.1" }),
    "bridge.advertise_ip",
  ],
  ["mdns a string", ipBridgeDoc({ mdns: "on" }), "bridge.mdns", "true or false"],
  ["expose missing", ipBridgeDoc({ expose: undefined }), "bridge.expose", "list"],
  ["expose empty", ipBridgeDoc({ expose: [] }), "bridge.expose", "no node port"],
  [
    "expose entry unknown",
    ipBridgeDoc({ expose: [{ node: "a", port: 80, service: "http", tls: 1 }] }),
    "bridge.expose[0].tls",
  ],
  [
    "expose ftp",
    ipBridgeDoc({ expose: [{ node: "a", port: 21, service: "ftp" }] }),
    "bridge.expose[0].service",
    "http",
  ],
  [
    "expose port 0",
    ipBridgeDoc({ expose: [{ node: "a", port: 0, service: "http" }] }),
    "bridge.expose[0].port",
  ],
  [
    "expose listen_port 65536",
    ipBridgeDoc({ expose: [{ node: "a", port: 80, service: "http", listen_port: 65536 }] }),
    "bridge.expose[0].listen_port",
  ],
  [
    "one listen_port twice",
    ipBridgeDoc({
      expose: [{ node: "a", port: 80, service: "http", listen_port: 9000 }, {
        node: "b",
        port: 80,
        service: "http",
        listen_port: 9000,
      }],
    }),
    "bridge.expose[1].listen_port",
    "already used",
  ],
  [
    "expose an unknown node",
    ipBridgeDoc({ expose: [{ node: "z", port: 80, service: "http" }] }),
    "bridge.expose[0].node",
    "no node",
  ],
  [
    "expose the internet gateway",
    edit((d) => {
      d.nodes = [
        { id: "gw", board: "esp32", firmware: "fw.bin", position: [0, 0], internet_gateway: true },
        { id: "a", board: "scripted", position: [1, 0] },
        { id: "b", board: "scripted", position: [2, 0] },
      ];
      d.bridge = { position: [0, 0], expose: [{ node: "gw", port: 80, service: "http" }] };
    }),
    "bridge.expose[0].node",
    "internet gateway",
  ],
  [
    "exposed nodes on two channels, no bridge radio",
    edit((d) => {
      n0(d).radios = [{ phy: "wifi", channel: 1 }];
      d.bridge = {
        position: [0, 0],
        expose: [{ node: "a", port: 80, service: "http" }, {
          node: "b",
          port: 80,
          service: "http",
        }],
      };
    }),
    "bridge.radios",
    "different channels",
  ],
  [
    "a bridge radio on another channel",
    ipBridgeDoc({ radios: [{ phy: "wifi", channel: 11 }] }),
    "bridge.expose[0].node",
    "channel 6",
  ],
  ["BLE interval 5 ms", bleBridgeDoc({ interval: "5ms" }), "bridge.interval"],
  [
    "BLE timeout under twice the interval",
    bleBridgeDoc({ interval: "100ms", timeout: "200ms" }),
    "bridge.timeout",
    "twice",
  ],
  ["BLE mirror missing", bleBridgeDoc({ mirror: undefined }), "bridge.mirror"],
  ["BLE mirror of no node", bleBridgeDoc({ mirror: "z" }), "bridge.mirror", "no node"],
  ["BLE mirror of a central", bleBridgeDoc({ mirror: "a" }), "bridge.mirror", "central"],
  ["BLE adapter usb0", bleBridgeDoc({ adapter: "usb0" }), "bridge.adapter", "hci0"],
  ["BLE name of 27 bytes", bleBridgeDoc({ name: "n".repeat(27) }), "bridge.name", "26 bytes"],
];

Deno.test(`scenario: ${INVALID_BRIDGE.length} invalid bridges are each refused at the offending field`, async (t) => {
  for (const [name, doc, path, words] of INVALID_BRIDGE) {
    await t.step(name, () => {
      expectInvalid(doc, path, words);
    });
  }
});

Deno.test("scenario: an IP bridge's defaults, its channel taken from the nodes it exposes", () => {
  const s = parse(edit((d) => {
    for (const node of nodesOf(d)) node.radios = [{ phy: "wifi", channel: 11 }];
    d.bridge = {
      position: [3, 0],
      expose: [{ node: "a", port: 80, service: "http" }, {
        node: "b",
        port: 1883,
        service: "mqtt",
        listen_port: 1883,
      }, { node: "a", port: 81, service: "websocket" }],
    };
  }));
  const b = s.bridge;
  assert(b?.kind === "ip");
  assertEquals([b.id, b.ip, b.mac, b.listen, b.mdns, b.advertiseIp], [
    "phone",
    "192.168.4.250",
    "02:68:7a:62:02:01",
    "127.0.0.1",
    false,
    null,
  ]);
  assertEquals(b.radio, { phy: "wifi", channel: 11, txPowerDbm: 15, antennaGainDbi: 0 });
  assertEquals(b.expose.map((e) => [e.node, e.port, e.service, e.listenPort]), [
    ["a", 80, "http", 0],
    ["b", 1883, "mqtt", 1883],
    ["a", 81, "websocket", 0],
  ]);
  // A proxy on every interface is reachable from a phone, so it is advertised unless told not to.
  const lan = parse(
    ipBridgeDoc({
      listen: "0.0.0.0",
      advertise_ip: "192.168.1.20",
      id: "tablet",
      ip: "192.168.4.40",
    }),
  );
  assert(lan.bridge?.kind === "ip");
  assertEquals([lan.bridge.mdns, lan.bridge.advertiseIp, lan.bridge.id, lan.bridge.ip], [
    true,
    "192.168.1.20",
    "tablet",
    "192.168.4.40",
  ]);
  const quiet = parse(
    ipBridgeDoc({
      listen: "0.0.0.0",
      mdns: false,
      radios: [{ phy: "wifi", channel: 6, tx_power_dbm: 5 }],
    }),
  );
  assert(quiet.bridge?.kind === "ip");
  assertEquals([quiet.bridge.mdns, quiet.bridge.radio], [false, {
    phy: "wifi",
    channel: 6,
    txPowerDbm: 5,
    antennaGainDbi: 0,
  }]);
});

Deno.test("scenario: a BLE bridge's defaults, and what it may name", () => {
  const s = parse(edit((d) => {
    d.bridge = { position: [3, 0], mirror: "b" };
    // The mirrored node may notify the bridge, which connects to it.
    nodesOf(d)[1]!.firmware = { advertise: true, send: [{ to: "phone", every: "1s", count: 1 }] };
    d.links = [{ from: "phone", to: "b", extra_loss_pct: 1 }];
    d.timeline = [{ at: "500ms", move: { node: "phone", to: [9, 9] } }];
    d.assertions = [{ serial: { node: "phone", contains: "x" } }, {
      metric: { link: "phone->b", sent: { gt: 0 } },
    }];
  }, bleDoc));
  const b = s.bridge;
  assert(b?.kind === "ble");
  assertEquals([b.id, b.mirror, b.adapter, b.name, b.intervalMs, b.timeoutMs, b.mac], [
    "phone",
    "b",
    "hci0",
    "b",
    30,
    1000,
    "02:68:7a:62:02:01",
  ]);
  assertEquals(b.radio, { phy: "ble", txPowerDbm: 0, antennaGainDbi: 0, hciUart: 1 });
  const named = parse(
    bleBridgeDoc({
      adapter: "hci12",
      name: "Sensor",
      interval: "50ms",
      timeout: "2s",
      radios: [{ phy: "ble", tx_power_dbm: 4 }],
    }),
  );
  assert(named.bridge?.kind === "ble");
  assertEquals([
    named.bridge.adapter,
    named.bridge.name,
    named.bridge.intervalMs,
    named.bridge.timeoutMs,
    named.bridge.radio.txPowerDbm,
  ], [
    "hci12",
    "Sensor",
    50,
    2000,
    4,
  ]);
  // An esp32 node is mirrored whatever its firmware advertises: the firmware is the truth.
  const esp = parse(edit((d) => {
    nodesOf(d)[1] = {
      id: "b",
      board: "esp32",
      firmware: "s.bin",
      position: [5, 0],
      radios: [{ phy: "ble" }],
    };
    d.bridge = { position: [1, 1], mirror: "b" };
  }, bleDoc));
  assertEquals(esp.bridge?.kind, "ble");
});

// ── radios ──────────────────────────────────────────────────────────────────

Deno.test("radios: one report line per PHY, nRF24 rates in kbit/s or Mbit/s", () => {
  const radio = (doc: Doc) => parse(doc).nodes[0]!.radio;
  assertEquals(describeRadio(radio(wifiDoc())), "wifi ch 6");
  assertEquals(describeRadio(radio(lora())), "lora 868.1 MHz SF7 BW125 CR4/5");
  assertEquals(describeRadio(radio(nrf())), "nrf24 ch 76 1 Mbit/s");
  assertEquals(
    describeRadio(radio(radioDoc({ phy: "nrf24", data_rate_kbps: 250 }))),
    "nrf24 ch 76 250 kbit/s",
  );
  assertEquals(
    describeRadio(radio(radioDoc({ phy: "nrf24", data_rate_kbps: 2000 }))),
    "nrf24 ch 76 2 Mbit/s",
  );
  assertEquals(describeRadio(radio(bleDoc())), "ble 1M 0 dBm, HCI on UART1");
});

Deno.test("radios: an nRF24 receive address is HZB, 0 and the node index, LSB first", () => {
  assertEquals([...nrf24AddressFor(3)], [3, 0x00, 0x42, 0x5a, 0x48]);
  assertEquals([...nrf24AddressFor(0x1ff)], [0xff, 0x00, 0x42, 0x5a, 0x48]);
});

// ── assertions ──────────────────────────────────────────────────────────────

function logOf(events: NewEvent[]): EngineEvent[] {
  const log = new EventLog();
  for (const event of events) log.append(event);
  return [...log.events];
}

const deliver = (t: number, from: string, to: string, delayMs: number, kind = "udp"): NewEvent => ({
  type: "deliver",
  t,
  from,
  to,
  bytes: 10,
  kind: kind as "udp",
  delayMs,
  attempts: 2,
  rateMbps: 54,
  rssiDbm: -60,
  snrDb: 30,
});

const drop = (t: number, from: string, to: string, kind = "udp"): NewEvent => ({
  type: "drop",
  t,
  from,
  to,
  bytes: 10,
  kind: kind as "udp",
  reason: "retry_exhausted",
  attempts: 7,
  rssiDbm: -95,
  snrDb: -2,
});

function metricScenario(assertions: Doc[]): Scenario {
  return parse(edit((d) => {
    d.duration = "10s";
    d.timeline = [{ at: "5s", label: "later" }];
    d.assertions = assertions;
  }));
}

function judge(assertions: Doc[], events: NewEvent[]) {
  const scenario = metricScenario(assertions);
  const log = logOf(events);
  return evaluateAssertions(
    scenario.assertions,
    log,
    computeMetrics(log, scenario.durationMs).phases,
  );
}

Deno.test("assertions: a serial line passes when seen, within its deadline if it has one", () => {
  const serial = (t: number, node: string, text: string): NewEvent => ({
    type: "serial",
    t,
    node,
    text,
  });
  const [seen, late, never, wrongNode] = judge([
    { serial: { node: "a", contains: "ready" } },
    { serial: { node: "a", contains: "ready", within: "100ms" } },
    { serial: { node: "a", contains: "boom" } },
    { serial: { node: "b", contains: "ready" } },
  ], [serial(250.5, "a", "radio ready now")]);
  assertEquals([seen!.passed, seen!.detail], [true, "seen at 250.500 ms"]);
  assertStringIncludes(seen!.description, 'serial a contains "ready"');
  assertEquals([late!.passed, late!.detail], [false, "never seen"]);
  assertStringIncludes(late!.description, "within 100 ms");
  assertEquals(never!.passed, false);
  assertEquals(wrongNode!.passed, false);
});

Deno.test("assertions: every metric field against every comparison", () => {
  // a->b: 4 delivered of 5, latencies 1..4 ms; a->a never happens.
  const events = [1, 2, 3, 4].map((ms, i) => deliver(100 + i, "a", "b", ms));
  events.push(drop(200, "a", "b"));
  const check = (field: string, op: string, value: number) =>
    judge([{ metric: { link: "a->b", [field]: { [op]: value } } }], events)[0]!.passed;
  assertEquals(check("sent", "eq", 5), true);
  assertEquals(check("sent", "eq", 4), false);
  assertEquals(check("delivered", "gte", 4), true);
  assertEquals(check("delivered", "gt", 4), false);
  assertEquals(check("loss_pct", "eq", 20), true);
  assertEquals(check("loss_pct", "lt", 20), false);
  assertEquals(check("loss_pct", "lte", 20), true);
  assertEquals(check("latency_p50_ms", "eq", 2), true);
  assertEquals(check("latency_p95_ms", "eq", 4), true);
  assertEquals(check("latency_p99_ms", "lt", 4), false);
  assertEquals(check("latency_mean_ms", "eq", 2.5), true);
  assertEquals(check("rssi_dbm", "lt", -60), true, "mean over delivered and dropped");
  assertEquals(check("snr_db", "gt", 0), true);
  assertEquals(check("mean_attempts", "gt", 2), true);
  // ESP-NOW fields have no value on a link without ESP-NOW sends.
  const acked = judge([{ metric: { link: "a->b", acked_pct: { gte: 0 } } }], events)[0]!;
  assertEquals(acked.passed, false);
  assertStringIncludes(acked.detail, "ESP-NOW");
  const rtt = judge([{ metric: { link: "a->b", ack_rtt_p95_ms: { lt: 9 } } }], events)[0]!;
  assertStringIncludes(rtt.detail, "ack_rtt_p95_ms");
});

Deno.test("assertions: ESP-NOW ACK share and round trip come from espnow-send events", () => {
  const send = (
    t: number,
    outcome: "acked" | "frame_lost",
    roundTripMs: number | null,
  ): NewEvent => ({
    type: "espnow-send",
    t,
    from: "a",
    to: "b",
    outcome,
    roundTripMs,
  });
  const events = [
    deliver(10, "a", "b", 1, "espnow"),
    send(10, "acked", 1.5),
    send(20, "frame_lost", null),
  ];
  const [pct, rtt, wrong] = judge([
    { metric: { link: "a->b", kind: "espnow", acked_pct: { eq: 50 } } },
    { metric: { link: "a->b", ack_rtt_p95_ms: { lte: 1.5 } } },
    { metric: { link: "a->b", acked_pct: { gt: 50 } } },
  ], events);
  assertEquals([pct!.passed, rtt!.passed, wrong!.passed], [true, true, false]);
  assertEquals(wrong!.detail, "a->b acked_pct = 50");
});

Deno.test("assertions: a latency on a link that delivered nothing fails, saying so", () => {
  const [result] = judge([{ metric: { link: "a->b", latency_p50_ms: { lt: 5 } } }], [
    drop(1, "a", "b"),
  ]);
  assertEquals(result!.passed, false);
  assertStringIncludes(result!.detail, "nothing was delivered");
});

Deno.test("assertions: patterns judge every matching link, and need at least one", () => {
  const events = [deliver(1, "a", "b", 1), deliver(2, "b", "a", 9)];
  const [all, none, oneFails] = judge([
    { metric: { link: "*->*", sent: { eq: 1 } } },
    { metric: { link: "a->b", kind: "tcp", sent: { gt: 0 } } },
    { metric: { link: "*->*", latency_p50_ms: { lt: 5 }, sent: { eq: 1 } } },
  ], events);
  assertEquals([all!.passed, all!.detail], [true, "2 link(s) satisfy it"]);
  assertEquals([none!.passed, none!.detail], [false, "no frames crossed a matching link"]);
  assertStringIncludes(none!.description, "tcp frames");
  assertEquals(oneFails!.passed, false);
  assertEquals(oneFails!.detail, "b->a latency_p50_ms = 9");
});

Deno.test("assertions: a phase judges its own window; the last one runs to the end", () => {
  const events: NewEvent[] = [
    deliver(1000, "a", "b", 1),
    { type: "phase", t: 5000, label: "later" },
    drop(6000, "a", "b"),
    drop(10_000, "a", "b"),
  ];
  const [start, later, missing] = judge([
    { metric: { link: "a->b", phase: "start", loss_pct: { eq: 0 } } },
    { metric: { link: "a->b", phase: "later", sent: { eq: 2 }, loss_pct: { eq: 100 } } },
    { metric: { link: "a->b", phase: "start", sent: { eq: 1 } } },
  ], events);
  assertEquals(start!.passed, true);
  assertStringIncludes(start!.description, "(phase start)");
  assertEquals(later!.passed, true, later!.detail);
  assertEquals(missing!.passed, true);
  // The phase the scenario names never started (a run cut short).
  const scenario = metricScenario([{ metric: { link: "a->b", phase: "later", sent: { gt: 0 } } }]);
  const log = logOf([deliver(1, "a", "b", 1)]);
  const [unstarted] = evaluateAssertions(
    scenario.assertions,
    log,
    computeMetrics(log, 10_000).phases,
  );
  assertEquals([unstarted!.passed, unstarted!.detail], [false, "no phase named later"]);
});

Deno.test("assertions: events before time zero are not measured", () => {
  const [result] = judge([{ metric: { link: "a->b", sent: { gt: 0 } } }], [
    deliver(-5, "a", "b", 1),
  ]);
  assertEquals(result!.passed, false);
});

// ── report and metrics.json ─────────────────────────────────────────────────

function nodeReport(id: string, extra: Partial<NodeReport> = {}): NodeReport {
  return {
    id,
    board: "scripted",
    ip: "192.168.4.11",
    mac: "02:68:7a:62:01:01",
    position: { x: 1, y: 2 },
    channel: 6,
    radio: "wifi ch 6",
    onMedium: true,
    clock: "wall clock",
    fidelity: "none",
    ...extra,
  };
}

function resultOf(
  scenario: Scenario,
  events: NewEvent[],
  extra: Partial<RunResult> = {},
): RunResult {
  const log = logOf(events);
  const metrics = computeMetrics(log, scenario.durationMs);
  const assertions = evaluateAssertions(scenario.assertions, log, metrics.phases);
  return {
    scenario,
    nodes: [nodeReport("a"), nodeReport("b", { position: { x: 3, y: 4, z: 5 } })],
    events: log,
    metrics,
    assertions,
    problems: [],
    passed: assertions.every((a) => a.passed),
    files: [],
    bridge: null,
    ...extra,
  };
}

Deno.test("report: a Wi-Fi run with ESP-NOW, phases, warnings, problems, a bridge and files", () => {
  const scenario = metricScenario([{ metric: { link: "a->b", sent: { gt: 0 } } }]);
  const result = resultOf(scenario, [
    { type: "tx", t: 1, node: "a", bytes: 10, kind: "espnow", dst: "b", src: "a" },
    deliver(1, "a", "b", 1, "espnow"),
    { type: "espnow-send", t: 1, from: "a", to: "b", outcome: "acked", roundTripMs: 1.25 },
    { type: "espnow-send", t: 2, from: "a", to: "b", outcome: "no_ack", roundTripMs: null },
    { type: "phase", t: 5000, label: "later" },
    drop(6000, "a", "b", "espnow"),
    { type: "espnow-send", t: 6000, from: "a", to: "b", outcome: "frame_lost", roundTripMs: null },
    { type: "warning", t: 7, text: "a chip did something odd" },
  ], {
    problems: ["b: worker exited early"],
    passed: false,
    files: ["/tmp/x/metrics.json"],
    nodes: [
      nodeReport("gw", { onMedium: false, board: "esp32" }),
      nodeReport("a"),
      nodeReport("b", { position: { x: 3, y: 4, z: 5 } }),
    ],
    bridge: { kind: "ip", id: "phone", endpoints: [], mdns: "off" },
  });
  const text = renderReport(result);
  assertStringIncludes(text, "wi-fi/ip: F2");
  assertStringIncludes(text, "esp-now: F1");
  assertStringIncludes(text, "MODELLED by the channel model");
  assertStringIncludes(text, "off the medium (SLIRP)");
  assertStringIncludes(text, "(3, 4, 5)");
  assertStringIncludes(text, "192.168.4.11");
  assertStringIncludes(text, "Mobile bridge");
  assertStringIncludes(text, "bridge phone: mDNS off");
  assertStringIncludes(text, "ESP-NOW unicast sends");
  assertStringIncludes(text, "50.0%");
  assertStringIncludes(text, "1.25");
  assertStringIncludes(text, 'Phase "start" (0 to 5000 ms)');
  assertStringIncludes(text, 'Phase "later" (5000 to 10000 ms)');
  assertStringIncludes(text, "warning: a chip did something odd");
  assertStringIncludes(text, "problem: b: worker exited early");
  assertStringIncludes(text, "PASS  metric a->b");
  assertStringIncludes(text, "RESULT: FAIL");
  assertStringIncludes(text, "Files\n  /tmp/x/metrics.json");
  // The later phase has its own ESP-NOW table: one send, lost.
  const later = text.slice(text.indexOf('Phase "later"'), text.indexOf("Warnings"));
  assertStringIncludes(later, "frame_lost");
  assertStringIncludes(later, "0.0%");
});

Deno.test("report: a BLE run lists connections with their HCI reasons; LoRa says time on air", () => {
  const ble = parse(bleDoc());
  const link = (t: number, state: "up" | "down", reason: number | null): NewEvent => ({
    type: "ble-link",
    t,
    node: "a",
    peer: "b",
    role: "central",
    state,
    reason,
    intervalMs: 30,
  });
  const text = renderReport(resultOf(ble, [
    link(10, "up", null),
    link(20, "down", 0x08),
    link(30, "down", 0x99),
  ]));
  assertStringIncludes(text, "ble: F3");
  assertStringIncludes(text, "ble-acl is host to host");
  assertStringIncludes(text, "BLE connections");
  assertStringIncludes(text, "connected");
  assertStringIncludes(text, "disconnected (0x08 supervision timeout)");
  assertStringIncludes(text, "disconnected (0x99 other)");
  assertStringIncludes(text, "no frames crossed the medium");
  assertStringIncludes(text, "Assertions\n  none");
  assert(!text.includes("192.168.4.11"), "a non-Wi-Fi run prints no IP addresses");
  assert(!text.includes("Phase "), "one phase gets no per-phase tables");
  const loraText = renderReport(resultOf(parse(lora()), []));
  assertStringIncludes(loraText, "lora: F1");
  assertStringIncludes(loraText, "time on air from the chip's registers");
  assertStringIncludes(renderReport(resultOf(parse(nrf()), [])), "nrf24: F1");
});

Deno.test("report: a phase that carried nothing says no frames", () => {
  const scenario = metricScenario([]);
  const text = renderReport(
    resultOf(scenario, [deliver(1, "a", "b", 1), { type: "phase", t: 5000, label: "later" }]),
  );
  assertStringIncludes(text.slice(text.indexOf('Phase "later"')), "no frames");
  assertStringIncludes(text, "RESULT: PASS");
});

Deno.test("metrics.json: schema 2 with the PHY, each node's radio and the fidelity rows", () => {
  const scenario = parse(lora());
  const result = resultOf(scenario, [deliver(1, "a", "b", 2, "lora")], {
    nodes: [
      nodeReport("a", {
        channel: null,
        radio: "lora 868.1 MHz SF7 BW125 CR4/5",
        board: "scripted",
      }),
      nodeReport("b", { channel: null, radio: "lora", board: "esp32", fidelity: "F1" }),
    ],
  });
  const doc = metricsDocument(result);
  assertEquals(doc.schema, 2);
  assertEquals([doc.tool, doc.scenario, doc.phy, doc.seed, doc.duration_ms, doc.latency], [
    "hertzbench",
    "cov",
    "lora",
    1,
    1000,
    "modelled",
  ]);
  assertEquals(doc.fidelity.map((f) => "component" in f ? f.component : ""), [
    "lora-sx127x model over spi-link",
    "board",
    "board",
  ]);
  assertEquals(doc.nodes[0], {
    id: "a",
    board: "scripted",
    ip: "192.168.4.11",
    mac: "02:68:7a:62:01:01",
    position: { x: 1, y: 2 },
    channel: null,
    radio: "lora 868.1 MHz SF7 BW125 CR4/5",
    on_medium: true,
    clock: "wall clock",
  });
  assertEquals(doc.links[0], linkJson(result.metrics.total[0]!));
  assertEquals(doc.links[0]!.espnow, null);
  assertEquals(doc.links[0]!.latency_ms?.p50, 2);
  assertEquals(doc.phases.map((p) => [p.label, p.from_ms, p.to_ms]), [["start", 0, 1000]]);
  assertEquals([doc.bridge, doc.warnings, doc.problems, doc.passed], [null, [], [], true]);
  // A JSON round trip keeps every field: metrics.json is what CI reads.
  assertEquals(JSON.parse(JSON.stringify(doc)).links[0].loss_pct, 0);
});

Deno.test("metrics.json: an ESP-NOW link carries its sends, outcomes and round trips", () => {
  const scenario = parse(wifiDoc());
  const doc = metricsDocument(resultOf(scenario, [
    { type: "tx", t: 1, node: "a", bytes: 10, kind: "espnow", dst: "b", src: "a" },
    deliver(1, "a", "b", 1, "espnow"),
    { type: "espnow-send", t: 1, from: "a", to: "b", outcome: "acked", roundTripMs: 2 },
  ]));
  assertEquals(doc.fidelity.slice(0, 2).map((f) => "protocol" in f ? f.protocol : ""), [
    "wi-fi/ip",
    "esp-now",
  ]);
  const espnow = doc.links[0]!.espnow;
  assertExists(espnow);
  assertEquals([
    espnow.sends,
    espnow.acked,
    espnow.outcomes,
    espnow.acked_pct,
    espnow.round_trip_ms?.p95,
  ], [
    1,
    1,
    { acked: 1 },
    100,
    2,
  ]);
});

// ── load ────────────────────────────────────────────────────────────────────

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "hzb-cov-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("load: a file that cannot be read is a ScenarioError naming it", async () => {
  await assertRejects(
    () => loadScenario("/nonexistent/hzb/scenario.yaml"),
    ScenarioError,
    "cannot read /nonexistent/hzb/scenario.yaml",
  );
});

Deno.test("load: firmware and outputs resolve against the scenario's directory; --out wins", async () => {
  await withTempDir(async (dir) => {
    const doc = edit((d) => {
      d.nodes = [
        { id: "a", board: "esp32", firmware: "fw/a", position: [0, 0] },
        { id: "b", board: "esp32", firmware: "/abs/b.bin", position: [1, 0] },
        { id: "c", board: "scripted", position: [2, 0] },
      ];
      d.outputs = { metrics: "res/m.json", pcap: "/abs/air.pcap" };
    });
    await Deno.writeTextFile(`${dir}/s.yaml`, stringify(doc));
    const loaded = await loadScenario(`${dir}/s.yaml`);
    assertEquals(loaded.file, join(dir, "s.yaml"));
    assertEquals(loaded.outDir, join(dir, "out"));
    assertEquals(
      loaded.scenario.nodes.map((n) => n.firmware.kind === "script" ? null : n.firmware.path),
      [
        join(dir, "fw", "a"),
        "/abs/b.bin",
        null,
      ],
    );
    assertEquals(loaded.outputs, {
      metrics: join(dir, "res", "m.json"),
      pcap: "/abs/air.pcap",
      events: join(dir, "out", "events.jsonl"),
    });
    const redirected = await loadScenario(`${dir}/s.yaml`, `${dir}/elsewhere`);
    assertEquals(redirected.outputs, {
      metrics: join(dir, "elsewhere", "metrics.json"),
      pcap: join(dir, "elsewhere", "air.pcap"),
      events: join(dir, "elsewhere", "events.jsonl"),
    });
  });
});

Deno.test("load: firmware checks name what is missing and what has the wrong kind", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(`${dir}/sketch`);
    await Deno.mkdir(`${dir}/dir.bin`);
    await Deno.writeTextFile(`${dir}/file-sketch`, "");
    await Deno.writeTextFile(`${dir}/ok.bin`, "");
    const scenario = parse(edit((d) => {
      d.nodes = [
        { id: "good-sketch", board: "esp32", firmware: `${dir}/sketch`, position: [0, 0] },
        { id: "good-bin", board: "esp32", firmware: `${dir}/ok.bin`, position: [1, 0] },
        { id: "file", board: "esp32", firmware: `${dir}/file-sketch`, position: [2, 0] },
        { id: "dir", board: "esp32", firmware: `${dir}/dir.bin`, position: [3, 0] },
        { id: "gone", board: "esp32", firmware: `${dir}/gone.bin`, position: [4, 0] },
        { id: "script", board: "scripted", position: [5, 0] },
      ];
    }));
    const missing = await checkFirmwareFiles(scenario);
    assertEquals(missing.length, 3);
    assertStringIncludes(missing[0]!, "file:");
    assertStringIncludes(missing[0]!, "should be a sketch directory");
    assertStringIncludes(missing[1]!, "dir:");
    assertStringIncludes(missing[1]!, "should be a .bin file");
    assertStringIncludes(missing[2]!, "gone:");
    assertStringIncludes(missing[2]!, "does not exist");
  });
});

Deno.test("load: every example scenario parses, and only unbuilt ESP-IDF binaries are missing", async () => {
  const dir = fileURLToPath(new URL("../scenarios/examples/", import.meta.url));
  const files = [...Deno.readDirSync(dir)].filter((e) => e.name.endsWith(".yaml")).map((e) =>
    e.name
  )
    .sort();
  assert(files.length >= 13, `found ${files.length} examples`);
  for (const name of files) {
    const loaded = await loadScenario(`${dir}${name}`);
    assert(loaded.scenario.nodes.length >= 2, name);
    for (const line of await checkFirmwareFiles(loaded.scenario)) {
      // ESP-IDF projects are committed as sources; their build/ output is made by `idf.py build`.
      assert(/[\\/]build[\\/][^\\/]+\.bin does not exist$/.test(line), `${name}: ${line}`);
    }
  }
});

// ── runner: helpers ─────────────────────────────────────────────────────────

Deno.test("runner: link rules expand over the medium, never from a node to itself", () => {
  const rule = { from: "s-*", to: "*", extraLossPct: 0, extraLatencyMs: 0 };
  assertEquals(expandLinkRule(rule, ["s-1", "s-2", "gw"]), [
    ["s-1", "s-2"],
    ["s-1", "gw"],
    ["s-2", "s-1"],
    ["s-2", "gw"],
  ]);
  assertEquals(expandLinkRule({ ...rule, from: "x" }, ["a", "b"]), []);
});

Deno.test("runner: the 802.11 capture sits next to the pcap", () => {
  assertEquals(dot11CapturePath("/out/air.pcap"), "/out/air-80211.pcap");
  assertEquals(dot11CapturePath("/out/capture"), "/out/capture-80211");
});

// ── runner: runs with stand-in boards ───────────────────────────────────────

interface FakeBoards {
  launcher: BoardLauncher;
  started: string[];
  stopped: string[];
  written: string[];
  contexts: BoardContext[];
}

/** Boards that only connect to their medium port (or do what `behave` says), and record their lives. */
function fakeBoards(
  behave: (ctx: BoardContext) => Promise<void> | void = () => {},
  opts: { connect?: boolean; serial?: boolean } = {},
): FakeBoards {
  const record: FakeBoards = {
    started: [],
    stopped: [],
    written: [],
    contexts: [],
    launcher: {
      fidelity: "fake board",
      start: async (ctx) => {
        record.contexts.push(ctx);
        await behave(ctx);
        const conn = opts.connect === false || ctx.netPort === null
          ? null
          : await Deno.connect({ hostname: "127.0.0.1", port: ctx.netPort });
        record.started.push(ctx.node.id);
        const board: RunningBoard = {
          clockDescription: `fake clock of ${ctx.node.id}`,
          stop: () => {
            record.stopped.push(ctx.node.id);
            try {
              conn?.close();
            } catch {
              // The adapter closed it first.
            }
            return Promise.resolve();
          },
          ...(opts.serial
            ? {
              writeSerial: (bytes: Uint8Array) => {
                record.written.push(`${ctx.node.id}:${new TextDecoder().decode(bytes)}`);
                return Promise.resolve();
              },
            }
            : {}),
        };
        return board;
      },
    },
  };
  return record;
}

function runOptions(
  dir: string,
  boards: FakeBoards,
  extra: Partial<Parameters<typeof runScenario>[1]> = {},
) {
  return {
    outDir: dir,
    outputs: {
      metrics: `${dir}/m/metrics.json`,
      pcap: `${dir}/air.pcap`,
      events: `${dir}/events.jsonl`,
    },
    launchers: { scripted: boards.launcher, esp32: boards.launcher },
    startupTimeoutMs: 3000,
    ...extra,
  };
}

function shortRun(mutate: (d: Doc) => void = () => {}, durationMs = 150): Scenario {
  const scenario = parse(edit(mutate));
  return { ...scenario, durationMs };
}

Deno.test("runner: a board that throws a plain error could not start; siblings are stopped", async () => {
  await withTempDir(async (dir) => {
    const boards = fakeBoards((ctx) => {
      if (ctx.node.id === "b") throw new Error("no such device");
    });
    const error = await assertRejects(
      () => runScenario(shortRun(), runOptions(dir, boards)),
      BoardError,
      "b: could not start: no such device",
    );
    assert(!(error instanceof RunInterrupted));
    assertEquals(boards.stopped, ["a"]);
  });
});

Deno.test("runner: a BoardError from a launcher reaches the caller as it is", async () => {
  await withTempDir(async (dir) => {
    const boards = fakeBoards((ctx) => {
      if (ctx.node.id === "a") throw new BoardError("a: libqemu missing");
    });
    await assertRejects(
      () => runScenario(shortRun(), runOptions(dir, boards)),
      BoardError,
      "a: libqemu missing",
    );
  });
});

Deno.test("runner: a problem during start-up ends it at once, with the problem in the message", async () => {
  await withTempDir(async (dir) => {
    const boards = fakeBoards((ctx) => {
      if (ctx.node.id === "b") ctx.onProblem("b: worker exited early (code 3)");
    }, { connect: false });
    const started = performance.now();
    const error = await assertRejects(
      () => runScenario(shortRun(), runOptions(dir, boards, { startupTimeoutMs: 20_000 })),
      BoardError,
    );
    assertStringIncludes(error.message, "a board failed during start-up");
    assertStringIncludes(error.message, "b: worker exited early (code 3)");
    assert(performance.now() - started < 10_000, "did not wait out the connect timeout");
  });
});

Deno.test("runner: boards that never connect time out with the start-up message", async () => {
  await withTempDir(async (dir) => {
    const boards = fakeBoards(() => {}, { connect: false });
    const error = await assertRejects(
      () => runScenario(shortRun(), runOptions(dir, boards, { startupTimeoutMs: 100 })),
      BoardError,
    );
    assertStringIncludes(error.message, "worker logs are in the output directory");
    assertEquals(boards.stopped.sort(), ["a", "b"]);
  });
});

Deno.test("runner: an already aborted signal interrupts the run before it starts", async () => {
  await withTempDir(async (dir) => {
    const boards = fakeBoards();
    const abort = new AbortController();
    abort.abort();
    await assertRejects(
      () => runScenario(shortRun(), runOptions(dir, boards, { signal: abort.signal })),
      RunInterrupted,
    );
    // Nothing was written: an interrupted run has no results.
    assertEquals([...Deno.readDirSync(dir)].map((e) => e.name), []);
  });
});

Deno.test("runner: aborting mid-run stops every board and writes nothing", async () => {
  await withTempDir(async (dir) => {
    const boards = fakeBoards();
    const abort = new AbortController();
    await assertRejects(
      () =>
        runScenario(
          shortRun(() => {}, 60_000),
          runOptions(dir, boards, {
            signal: abort.signal,
            onUnderway: () => abort.abort(),
          }),
        ),
      RunInterrupted,
    );
    assertEquals(boards.stopped.sort(), ["a", "b"]);
    assertEquals([...Deno.readDirSync(dir)].filter((e) => e.isFile).map((e) => e.name), []);
  });
});

Deno.test("runner: a bridge that cannot open its host port fails the start as a BoardError", async () => {
  await withTempDir(async (dir) => {
    const taken = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    try {
      const port = (taken.addr as Deno.NetAddr).port;
      const scenario = shortRun((d) => {
        d.bridge = {
          position: [1, 1],
          expose: [{ node: "a", port: 80, service: "http", listen_port: port }],
        };
      });
      const boards = fakeBoards();
      await assertRejects(
        () => runScenario(scenario, runOptions(dir, boards)),
        BoardError,
        "already in use",
      );
      assertEquals(boards.stopped.sort(), ["a", "b"]);
    } finally {
      taken.close();
    }
  });
});

Deno.test("runner: a full run with live control writes metrics.json, the pcap, events and serial logs", async () => {
  await withTempDir(async (dir) => {
    const scenario = shortRun((d) => {
      d.links = [{ from: "a", to: "b", extra_loss_pct: 5 }];
      d.timeline = [
        { at: "10ms", label: "moved", move: { node: "b", to: [20, 0] } },
        { at: "20ms", link: { from: "b", to: "a", extra_latency_ms: 3 } },
      ];
      d.assertions = [{ serial: { node: "a", contains: "hello" } }];
      d.bridge = { position: [1, 1], expose: [{ node: "a", port: 80, service: "http" }] };
    }, 400);
    const boards = fakeBoards((ctx) => ctx.onSerial(`hello from ${ctx.node.id}`), { serial: true });
    let live: LiveRun | null = null;
    const seen: Record<string, unknown> = {};
    const result = await runScenario(
      scenario,
      runOptions(dir, boards, {
        onUnderway: (run) => {
          live = run;
          seen.active = run.active;
          seen.elapsed = run.elapsedMs() >= 0;
          seen.position = run.position("a");
          seen.budget = typeof run.budget("a", "b").rssiDbm;
          run.moveNode("a", { x: 2, y: 2 });
          run.setEnvironment({ baseLatencyMs: 1 });
          run.setRadio("a", { txPowerDbm: 10 });
          seen.pairs = run.setLink({ from: "*", to: "phone", extraLossPct: 1, extraLatencyMs: 0 });
          run.startPhase("live");
          seen.bridge = run.bridge()?.kind;
          seen.notBoard = assertThrows(() =>
            run.writeSerial("phone", new Uint8Array(1)), BoardError).message;
          void run.writeSerial("a", new TextEncoder().encode("hi"));
          seen.pcap = run.capture("pcap") !== null;
          seen.dot11 = run.capture("pcap-80211")?.packets;
          seen.snoop = run.capture("btsnoop", "a");
          seen.snoopNoNode = run.capture("btsnoop");
          seen.problems = run.problems().length;
        },
      }),
    );
    assertEquals(seen, {
      active: true,
      elapsed: true,
      position: { x: 0, y: 0 },
      budget: "number",
      pairs: [["a", "phone"], ["b", "phone"]],
      bridge: "ip",
      notBoard: "phone is not a board of this run",
      pcap: true,
      dot11: 0,
      snoop: null,
      snoopNoNode: null,
      problems: 0,
    });
    assertEquals(boards.written, ["a:hi"]);
    // The live handle outlives the run for reading, not for acting.
    const after = live as LiveRun | null;
    assertExists(after);
    assertEquals(after.active, false);
    assertThrows(() => after.moveNode("a", { x: 0, y: 0 }), Error, "the run has ended");
    assert(after.events().length > 0);

    assert(result.passed, JSON.stringify(result.assertions));
    const types = new Set(result.events.map((e) => e.type));
    for (const type of ["move", "link-override", "phase", "channel", "radio", "serial"]) {
      assert(types.has(type as EngineEvent["type"]), `no ${type} event`);
    }
    assertEquals(result.nodes.map((n) => [n.id, n.board, n.clock]), [
      ["a", "scripted", "fake clock of a"],
      ["b", "scripted", "fake clock of b"],
      ["phone", "bridge", "wall clock (host proxy)"],
    ]);
    assertEquals(result.nodes[1]!.position, { x: 20, y: 0 });
    assertEquals(result.nodes[2]!.radio, "wifi ch 6");
    assertEquals(result.bridge?.kind, "ip");
    // Every board learned the bridge as a peer, and its own index.
    assertEquals(boards.contexts.find((c) => c.node.id === "a")!.peers.map((p) => p.id), [
      "b",
      "phone",
    ]);

    const metrics = JSON.parse(await Deno.readTextFile(`${dir}/m/metrics.json`));
    assertEquals([metrics.schema, metrics.phy, metrics.passed], [2, "wifi", true]);
    assertEquals(metrics.phases.map((p: { label: string }) => p.label), ["start", "live", "moved"]);
    const pcap = await Deno.readFile(`${dir}/air.pcap`);
    assertEquals(new DataView(pcap.buffer).getUint32(0, true), 0xa1b2c3d4);
    assertEquals(new DataView(pcap.buffer).getUint32(20, true), 1, "LINKTYPE_ETHERNET");
    const lines = (await Deno.readTextFile(`${dir}/events.jsonl`)).trimEnd().split("\n");
    assertEquals(lines.length, result.events.length);
    for (const line of lines) assert(typeof JSON.parse(line).type === "string");
    assertStringIncludes(await Deno.readTextFile(`${dir}/serial-a.log`), "hello from a");
    assertEquals(result.files, [
      `${dir}/m/metrics.json`,
      `${dir}/air.pcap`,
      `${dir}/events.jsonl`,
      join(dir, "serial-a.log"),
      join(dir, "serial-b.log"),
      join(dir, "serial-phone.log"),
    ]);
    // No ESP-NOW crossed: no 802.11 capture.
    await assertRejects(() => Deno.stat(`${dir}/air-80211.pcap`), Deno.errors.NotFound);
  });
});

Deno.test("runner: a board with no serial console says so when written to", async () => {
  await withTempDir(async (dir) => {
    let message = "";
    await runScenario(
      shortRun(),
      runOptions(dir, fakeBoards(), {
        onUnderway: (run) => {
          message = assertThrows(() => run.writeSerial("a", new Uint8Array(1)), BoardError).message;
        },
      }),
    );
    assertStringIncludes(message, "scripted board: it has no serial console");
  });
});

Deno.test("runner: the internet gateway keeps no medium port and stays off the medium", async () => {
  await withTempDir(async (dir) => {
    const scenario = shortRun((d) => {
      d.nodes = [
        { id: "gw", board: "esp32", firmware: "fw.bin", position: [9, 9], internet_gateway: true },
        { id: "a", board: "scripted", position: [0, 0] },
        { id: "b", board: "scripted", position: [1, 0] },
      ];
    });
    const boards = fakeBoards();
    const result = await runScenario(scenario, runOptions(dir, boards));
    assertEquals(boards.contexts.find((c) => c.node.id === "gw")!.netPort, null);
    const gw = result.nodes.find((n) => n.id === "gw")!;
    assertEquals([gw.onMedium, gw.position, gw.channel], [false, { x: 9, y: 9 }, 6]);
    // No serial line came from anyone, so no serial logs and an events file that is empty or JSONL.
    assertEquals(result.files.filter((f) => f.includes("serial-")), []);
  });
});

Deno.test("runner: an empty event log writes an empty events.jsonl", async () => {
  await withTempDir(async (dir) => {
    // LoRa boards that never transmit: the air logs nothing.
    const scenario = { ...parse(lora()), durationMs: 50 };
    const result = await runScenario(scenario, runOptions(dir, fakeBoards()));
    assertEquals(result.events.length, 0);
    assertEquals(await Deno.readTextFile(`${dir}/events.jsonl`), "");
    assertEquals(result.nodes.map((n) => n.channel), [null, null]);
    const pcap = await Deno.readFile(`${dir}/air.pcap`);
    assertEquals(new DataView(pcap.buffer).getUint32(20, true), 270, "LINKTYPE_LORATAP");
  });
});

Deno.test("runner: an nRF24 run captures under LINKTYPE_USER0 and reports the channel", async () => {
  await withTempDir(async (dir) => {
    const result = await runScenario(
      { ...parse(nrf()), durationMs: 50 },
      runOptions(dir, fakeBoards()),
    );
    assertEquals(result.nodes.map((n) => [n.channel, n.radio]), [
      [76, "nrf24 ch 76 1 Mbit/s"],
      [76, "nrf24 ch 76 1 Mbit/s"],
    ]);
    const pcap = await Deno.readFile(`${dir}/air.pcap`);
    assertEquals(new DataView(pcap.buffer).getUint32(20, true), 147, "LINKTYPE_USER0");
  });
});

// ── air networks ────────────────────────────────────────────────────────────

function airFrame(kind: AirFrame["kind"], payload: number[], header: unknown = null): AirFrame {
  return {
    kind,
    payload: Uint8Array.from(payload),
    airtimeMs: 1,
    frequencyHz: 868_100_000,
    bandwidthHz: 125_000,
    noiseFigureDb: 6,
    requiredSnrDb: -7,
    referenceBytes: 20,
    captureDb: 6,
    txPowerDbm: 14,
    interferenceKey: "k",
    rateBps: 5000,
    dst: "",
    src: "",
    params: {},
    header,
  };
}

Deno.test("air network: LoRaTap carries frequency, bandwidth steps, SF and sync word", () => {
  const record = loraTapRecord(
    airFrame("lora", [0xaa, 0xbb], { modulation: { sf: 9, syncWord: 0x34 } }),
  );
  const view = new DataView(record.buffer);
  assertEquals([
    record.length,
    view.getUint16(2),
    view.getUint32(4),
    record[8],
    record[9],
    record[14],
  ], [
    17,
    15,
    868_100_000,
    1,
    9,
    0x34,
  ]);
  assertEquals([...record.subarray(15)], [0xaa, 0xbb]);
  // A frame that is not LoRa keeps a zero SF and sync word; a narrow band writes 0 steps.
  const other = loraTapRecord({ ...airFrame("other", [1]), bandwidthHz: 62_500 });
  assertEquals([other[8], other[9], other[14]], [0, 0, 0]);
});

Deno.test("air network: the nRF24 record is channel, width, address, payload; other frames pass through", () => {
  const record = nrf24Record(
    airFrame("nrf24", [9, 8], { channel: 76, address: Uint8Array.of(1, 2, 3) }),
  );
  assertEquals([...record], [76, 3, 1, 2, 3, 9, 8]);
  assertEquals([...nrf24Record(airFrame("lora", [5, 6]))], [5, 6]);
  assertEquals([...bleRecord(airFrame("lora", [7]))], [7]);
});

Deno.test("air network: a Wi-Fi radio has no chip-level signal and no chip model", () => {
  assertThrows(
    () => declaredSignal({ phy: "wifi", channel: 1, txPowerDbm: 0, antennaGainDbi: 0 }),
    Error,
    "not on the chip-level air",
  );
  const wifi = parse(wifiDoc());
  assertThrows(
    () =>
      createAirNetwork(wifi, {
        clock: new ManualClock(),
        log: new EventLog(),
        epochMs: 0,
        onProblem: () => {},
      }),
    Error,
    "has no chip model",
  );
  const mixed = { ...parse(bleDoc()), nodes: wifi.nodes };
  assertThrows(
    () =>
      createAirNetwork(mixed, {
        clock: new ManualClock(),
        log: new EventLog(),
        epochMs: 0,
        onProblem: () => {},
      }),
    Error,
    "not a BLE node",
  );
});

Deno.test("air network: declared signals per chip, BLE read on channel 37", () => {
  const [l, n, b] = [lora(), nrf(), bleDoc()].map((d) => declaredSignal(parse(d).nodes[0]!.radio));
  assertEquals([l!.frequencyHz, l!.bandwidthHz, l!.txPowerDbm], [868_100_000, 125_000, 14]);
  assertEquals([n!.frequencyHz, n!.rateBps], [2_476_000_000, 1_000_000]);
  assertEquals(b!.frequencyHz, 2_402_000_000);
});

Deno.test("air network: firmware that programs other modem settings is warned about once per field", () => {
  const scenario = parse(lora());
  const tx = (
    node: string,
    radio: Record<string, string | number | boolean>,
    kind = "lora",
  ): EngineEvent => ({
    type: "tx",
    t: 1,
    seq: 0,
    node,
    bytes: 1,
    kind: kind as "lora",
    dst: "",
    src: "",
    radio,
  });
  const warnings = declaredMismatches(scenario, [
    tx("a", { sf: 9, bw_khz: 125, frequency_mhz: 868.1, cr: "4/5", sync_word: 0x12 }),
    tx("a", { sf: 10 }),
    tx("b", { sync_word: 0x34 }),
    { type: "serial", t: 1, seq: 1, node: "a", text: "x" },
    { type: "tx", t: 1, seq: 2, node: "a", bytes: 1, kind: "lora", dst: "", src: "" },
  ]);
  assertEquals(warnings, [
    "a: the firmware transmitted with sf 9, the scenario declares 7",
    "b: the firmware transmitted with sync_word 52, the scenario declares 18",
  ]);
  const nrfScenario = parse(nrf());
  assertEquals(
    declaredMismatches(nrfScenario, [
      tx("a", { channel: 2 }, "nrf24-ack"),
      tx("a", { channel: 2, data_rate_kbps: 1000 }, "nrf24"),
    ]),
    ["a: the firmware transmitted with channel 2, the scenario declares 76"],
  );
  assertEquals(declaredMismatches(parse(wifiDoc()), [tx("a", { channel: 1 }, "udp")]), []);
  assertEquals(declaredMismatches(parse(bleDoc()), [tx("a", { channel: 1 }, "ble-adv")]), []);
});

// ── qemu-esp32 against a fake worker ────────────────────────────────────────

// A stand-in for backend/app/services/esp32_worker.py that speaks its stdin and
// stdout protocol, and for orchestrator/compile_sketch.py. HZB_FAKE_MODE picks
// what it does; the config line it was given goes to stderr, which the board
// writes to worker-<node>.stderr.log.
const FAKE_WORKER = `
import base64, json, os, sys, time
mode = os.environ.get("HZB_FAKE_MODE", "events")
config = json.loads(sys.stdin.readline())
sys.stderr.write("config " + json.dumps(config) + "\\n")
sys.stderr.flush()
def emit(event):
    print(json.dumps(event), flush=True)
if mode == "exit":
    sys.exit(3)
if mode == "events":
    print("not json", flush=True)
    print("5", flush=True)
    for byte in b"hi\\r\\n":
        emit({"type": "uart_tx", "uart": 0, "byte": byte})
    for byte in b"bare\\n":
        emit({"type": "uart_tx", "byte": byte})
    emit({"type": "serial_output", "data": "two\\nlines\\n"})
    emit({"type": "serial_output", "uart": 1, "data": "hidden\\n"})
    emit({"type": "error", "message": "bad opcode"})
    emit({"type": "system", "event": "crash", "reason": "LoadProhibited"})
    emit({"type": "system", "event": "crash"})
    for byte in (0x04, 0x0e):
        emit({"type": "uart_tx", "uart": 1, "byte": byte})
for line in sys.stdin:
    command = json.loads(line)
    if command.get("cmd") == "stop" and mode != "ignore-stop":
        break
    if command.get("cmd") == "uart_send":
        data = base64.b64decode(command["data"])
        emit({"type": "serial_output", "data": "uart%d got %s\\n" % (command["uart"], data.hex())})
if mode == "events":
    emit({"type": "serial_output", "data": "tail without newline"})
if mode == "ignore-stop":
    time.sleep(60)
`;

const FAKE_COMPILE = `
import base64, json, os, sys
mode = os.environ.get("HZB_FAKE_MODE", "compile-ok")
with open(os.environ["HZB_FAKE_COUNT"], "a") as counter:
    counter.write(sys.argv[1] + "\\n")
if mode == "compile-fail":
    sys.stderr.write("sketch.ino:3: error: boom\\n")
    sys.exit(1)
print(json.dumps({"firmware_b64": base64.b64encode(b"FW").decode()} if mode == "compile-ok" else {}))
`;

interface Esp32Rig {
  dir: string;
  serial: string[];
  problems: string[];
  ctx(doc: Doc, netPort: number | null, nodeIndex?: number): BoardContext;
  config(id: string): Promise<Record<string, unknown>>;
}

async function withFakeWorker(mode: string, fn: (rig: Esp32Rig) => Promise<void>): Promise<void> {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/worker.py`, FAKE_WORKER);
    await Deno.writeTextFile(`${dir}/compile.py`, FAKE_COMPILE);
    // The compile helper gets its sketch directory, the worker its config on stdin.
    const python = await writeFakePython(
      dir,
      `import runpy, sys\nhere = ${JSON.stringify(dir)}\n` +
        `if sys.argv[1].endswith("compile_sketch.py"):\n` +
        `    sys.argv = [sys.argv[0], sys.argv[2]]\n    runpy.run_path(here + "/compile.py", run_name="__main__")\n` +
        `else:\n    runpy.run_path(here + "/worker.py", run_name="__main__")\n`,
    );
    await Deno.writeFile(`${dir}/libqemu-xtensa.so`, new Uint8Array(0));
    await Deno.writeFile(`${dir}/fw.bin`, Uint8Array.of(0xe9, 1, 2, 3));
    await Deno.mkdir(`${dir}/sketch`);
    const saved = ["HERTZBENCH_PYTHON", "QEMU_ESP32_LIB", "HZB_FAKE_MODE", "HZB_FAKE_COUNT"].map((
      k,
    ) => [k, Deno.env.get(k)] as const);
    Deno.env.set("HERTZBENCH_PYTHON", python);
    Deno.env.set("QEMU_ESP32_LIB", `${dir}/libqemu-xtensa.so`);
    Deno.env.set("HZB_FAKE_MODE", mode);
    Deno.env.set("HZB_FAKE_COUNT", `${dir}/compiles.txt`);
    const serial: string[] = [];
    const problems: string[] = [];
    try {
      await fn({
        dir,
        serial,
        problems,
        ctx: (doc, netPort, nodeIndex = 1) => {
          const scenario = parse(doc);
          const node = scenario.nodes[nodeIndex - 1]!;
          const firmware = node.firmware.kind === "script"
            ? node.firmware
            : { ...node.firmware, path: `${dir}/${node.firmware.path}` };
          return {
            node: { ...node, firmware },
            nodeIndex,
            netPort,
            peers: [],
            gateway: { ip: "192.168.4.1", mac: "02:68:7a:62:00:01", subnetMask: "255.255.255.0" },
            clock: new ManualClock(),
            outDir: dir,
            onSerial: (line) => serial.push(line),
            onProblem: (message) => problems.push(message),
          };
        },
        config: async (id) => {
          const log = await Deno.readTextFile(`${dir}/worker-${id}.stderr.log`);
          const line = log.split("\n").find((l) => l.startsWith("config "));
          assertExists(line, log);
          return JSON.parse(line.slice("config ".length));
        },
      });
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
    }
  });
}

function esp32Doc(radio: Doc | null, firmware = "fw.bin"): Doc {
  return edit((d) => {
    d.nodes = ["a", "b"].map((id, i) => ({
      id,
      board: "esp32",
      firmware,
      position: [i, 0],
      ...(radio ? { radios: [radio] } : {}),
    }));
  });
}

Deno.test("qemu-esp32: a Wi-Fi board gets its eFuse image and engine port, and its events become lines and problems", async () => {
  await withFakeWorker("events", async (rig) => {
    const board = await createEsp32Launcher().start(rig.ctx(esp32Doc(null), 4321));
    assertStringIncludes(board.clockDescription, "wall clock");
    await until(() => rig.problems.length >= 3, "the worker's error and crashes");
    await board.writeSerial!(new TextEncoder().encode("ab"));
    await until(
      () => rig.serial.includes("uart0 got 6162"),
      `the console echo: ${JSON.stringify(rig.serial)}`,
    );
    await board.stop();
    const config = await rig.config("a");
    assertEquals(config.wifi_l2_port, 4321);
    assertEquals(config.efuse_image, `${rig.dir}/efuse-a.bin`);
    assertEquals([config.lib_path, config.machine, config.wifi_enabled], [
      `${rig.dir}/libqemu-xtensa.so`,
      "esp32-picsimlab",
      true,
    ]);
    assertEquals(config.firmware_b64, btoa(String.fromCharCode(0xe9, 1, 2, 3)));
    assert((await Deno.stat(`${rig.dir}/efuse-a.bin`)).size > 0);
    assertEquals(rig.serial, [
      "hi",
      "bare",
      "two",
      "lines",
      "uart0 got 6162",
      "tail without newline",
    ]);
    assertEquals(rig.problems, [
      "a: worker error: bad opcode",
      "a: firmware crashed (LoadProhibited)",
      "a: firmware crashed (no reason given)",
    ]);
    await assertRejects(() => board.writeSerial!(Uint8Array.of(1)), BoardError, "stopping");
  });
});

Deno.test("qemu-esp32: LoRa and nRF24 boards get their radio_spi wiring and no eFuse image", async () => {
  await withFakeWorker("idle", async (rig) => {
    const launcher = createEsp32Launcher();
    const loraBoard = await launcher.start(
      rig.ctx(esp32Doc({ phy: "lora", pins: { cs: 18, reset: 23 } }), 7001),
    );
    const bare = await launcher.start(
      rig.ctx(esp32Doc({ phy: "lora", pins: { reset: null } }), 7002, 2),
    );
    await loraBoard.stop();
    await bare.stop();
    assertEquals((await rig.config("a")).radio_spi, { port: 7001, cs: 18, watch: [18, 23] });
    assertEquals((await rig.config("b")).radio_spi, { port: 7002, cs: 5, watch: [5] });
    assertEquals((await rig.config("a")).wifi_l2_port, undefined);
    await assertRejects(() => Deno.stat(`${rig.dir}/efuse-a.bin`), Deno.errors.NotFound);
    const nrfBoard = await createEsp32Launcher().start(
      rig.ctx(esp32Doc({ phy: "nrf24", pins: { csn: 15, ce: 2 } }), 7003),
    );
    await nrfBoard.stop();
    assertEquals((await rig.config("a")).radio_spi, { port: 7003, cs: 15, watch: [15, 2] });
    assertEquals(rig.problems, []);
  });
});

Deno.test("qemu-esp32: the internet gateway keeps SLIRP: no engine port in its config", async () => {
  await withFakeWorker("idle", async (rig) => {
    const board = await createEsp32Launcher().start(rig.ctx(esp32Doc(null), null));
    await board.stop();
    const config = await rig.config("a");
    assertEquals(Object.keys(config).sort(), [
      "firmware_b64",
      "lib_path",
      "machine",
      "wifi_enabled",
    ]);
  });
});

Deno.test("qemu-esp32: a BLE board relays HCI both ways between its UART and the engine port", async () => {
  await withFakeWorker("events", async (rig) => {
    const engine = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    try {
      const port = (engine.addr as Deno.NetAddr).port;
      const accepted = engine.accept();
      const board = await createEsp32Launcher().start(
        rig.ctx(esp32Doc({ phy: "ble", hci_uart: 1 }), port),
      );
      const conn = await accepted;
      // Firmware to engine: the worker's uart_tx bytes on UART1, gathered into one write.
      const buffer = new Uint8Array(16);
      let got: number[] = [];
      while (got.length < 2) {
        const n = await conn.read(buffer);
        if (n === null) break;
        got = [...got, ...buffer.subarray(0, n)];
      }
      assertEquals(got, [0x04, 0x0e]);
      // Engine to firmware: bytes from the engine arrive as uart_send on UART1.
      await conn.write(Uint8Array.of(1, 2, 3));
      await until(() => rig.serial.includes("uart1 got 010203"), "the HCI bytes at the worker");
      await board.stop();
      conn.close();
      assertEquals(Object.keys(await rig.config("a")).sort(), [
        "firmware_b64",
        "lib_path",
        "machine",
        "wifi_enabled",
      ]);
    } finally {
      engine.close();
    }
  });
});

Deno.test("qemu-esp32: a worker that exits on its own is a problem; one that ignores stop is killed", async () => {
  await withFakeWorker("exit", async (rig) => {
    const board = await createEsp32Launcher().start(rig.ctx(esp32Doc(null), 4000));
    await until(() => rig.problems.length > 0, "the early exit");
    assertStringIncludes(rig.problems[0]!, "a: worker exited early (code 3)");
    assertStringIncludes(rig.problems[0]!, "worker-a.stderr.log");
    await board.stop();
  });
  await withFakeWorker("ignore-stop", async (rig) => {
    const board = await createEsp32Launcher().start(rig.ctx(esp32Doc(null), 4000));
    const started = performance.now();
    await board.stop();
    // The grace period ran out and the worker was killed, which is not a problem.
    assert(performance.now() - started >= 4000);
    assertEquals(rig.problems, []);
  });
});

Deno.test("qemu-esp32: a sketch compiles once per launcher, and compile failures are BoardErrors", async () => {
  await withFakeWorker("compile-ok", async (rig) => {
    const launcher = createEsp32Launcher();
    const boards = [
      await launcher.start(rig.ctx(esp32Doc(null, "sketch"), 4000)),
      await launcher.start(rig.ctx(esp32Doc(null, "sketch"), 4001, 2)),
    ];
    for (const board of boards) await board.stop();
    assertEquals((await Deno.readTextFile(`${rig.dir}/compiles.txt`)).trim().split("\n"), [
      `${rig.dir}/sketch`,
    ]);
    assertEquals((await rig.config("b")).firmware_b64, btoa("FW"));
  });
  for (
    const [mode, words] of [["compile-fail", "boom"], ["compile-empty", "returned no firmware"]]
  ) {
    await withFakeWorker(mode!, async (rig) => {
      const error = await assertRejects(
        () => createEsp32Launcher().start(rig.ctx(esp32Doc(null, "sketch"), 4000)),
        BoardError,
      );
      assertStringIncludes(error.message, words!);
      assertStringIncludes(error.message, `${rig.dir}/sketch`);
    });
  }
});

Deno.test("qemu-esp32: a script firmware or a missing library is refused before any worker starts", async () => {
  await withFakeWorker("idle", async (rig) => {
    await assertRejects(
      () => createEsp32Launcher().start(rig.ctx(wifiDoc(), 4000)),
      BoardError,
      "needs a sketch directory or a .bin",
    );
    Deno.env.set("QEMU_ESP32_LIB", `${rig.dir}/missing.so`);
    await assertRejects(
      () => createEsp32Launcher().start(rig.ctx(esp32Doc(null), 4000)),
      BoardError,
      "missing.so",
    );
    // A directory is not a library either.
    Deno.env.set("QEMU_ESP32_LIB", rig.dir);
    assertThrows(() => resolveQemuLibrary(), BoardError, "libqemu-xtensa not found");
    Deno.env.delete("QEMU_ESP32_LIB");
    // Without the variable the library is looked for beside the worker.
    try {
      assertStringIncludes(resolveQemuLibrary(), "backend/app/services/libqemu-xtensa");
    } catch (error) {
      assert(error instanceof BoardError);
      assertStringIncludes(error.message, "backend/app/services/libqemu-xtensa");
    }
  });
});

// ── scripted Wi-Fi board, driven by hand on a manual clock ──────────────────

interface ScriptedRig {
  clock: ManualClock;
  board: RunningBoard;
  serial: string[];
  problems: string[];
  /** Every frame the board sent, decoded from the QEMU stream framing. */
  frames: Uint8Array[];
  send(frame: Uint8Array): Promise<void>;
  /** Answer the board's DHCP with the virtual gateway, until it is bound. */
  bind(): Promise<void>;
  udpPayloads(dstIp: string): string[];
}

async function withScriptedBoard(
  doc: Doc,
  fn: (rig: ScriptedRig) => Promise<void>,
  peersOf: (s: Scenario) => BoardContext["peers"] = (s) =>
    s.nodes.slice(1).map((n, i) => ({ id: n.id, index: i + 2, ip: n.ip, mac: n.mac })),
): Promise<void> {
  const scenario = parse(doc);
  const node = scenario.nodes[0]!;
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const clock = new ManualClock();
  const serial: string[] = [];
  const problems: string[] = [];
  const frames: Uint8Array[] = [];
  const started = scriptedLauncher.start({
    node,
    nodeIndex: 1,
    netPort: (listener.addr as Deno.NetAddr).port,
    peers: peersOf(scenario),
    gateway: { ip: "192.168.4.1", mac: "02:68:7a:62:00:01", subnetMask: "255.255.255.0" },
    clock,
    outDir: "/nonexistent",
    onSerial: (line) => serial.push(line),
    onProblem: (message) => problems.push(message),
  });
  const conn = await listener.accept();
  listener.close();
  const board = await started;
  const decoder = new FrameDecoder();
  const reading = (async () => {
    const buffer = new Uint8Array(65536);
    try {
      for (;;) {
        const n = await conn.read(buffer);
        if (n === null) return;
        frames.push(...decoder.push(buffer.subarray(0, n)));
      }
    } catch {
      // Closed below.
    }
  })();
  const gateway = new VirtualGateway({
    mac: "02:68:7a:62:00:01",
    ip: "192.168.4.1",
    subnetMask: "255.255.255.0",
    leases: new Map([[node.mac, node.ip]]),
  });
  const send = async (frame: Uint8Array) => {
    const bytes = encodeFrame(frame);
    let written = 0;
    while (written < bytes.length) written += await conn.write(bytes.subarray(written));
  };
  const rig: ScriptedRig = {
    clock,
    board,
    serial,
    problems,
    frames,
    send,
    bind: async () => {
      let answered = 0;
      while (!serial.some((l) => l.startsWith("dhcp bound"))) {
        await until(() => frames.length > answered, "a DHCP message from the board");
        for (const reply of gateway.handle(frames[answered]!)?.replies ?? []) await send(reply);
        answered++;
        await until(
          () => frames.length > answered || serial.some((l) => l.startsWith("dhcp bound")),
          "the board's next DHCP step",
        );
      }
    },
    udpPayloads: (dstIp) =>
      frames.flatMap((f) => {
        const ip = parseIpv4(f);
        const udp = ip && ip.dst === dstIp ? parseUdp(f, ip) : null;
        return udp ? [new TextDecoder().decode(udp.payload)] : [];
      }),
  };
  try {
    await fn(rig);
  } finally {
    await board.stop();
    try {
      conn.close();
    } catch {
      // The board's stop closed its end; ours may already be done too.
    }
    await reading;
  }
}

/** A DHCP server message to `mac`'s request `xid`, built by hand so its options can be anything. */
function dhcpReply(xid: number, yiaddr: string, options: number[], bootpLength = 300): Uint8Array {
  const bootp = new Uint8Array(Math.max(bootpLength, 240 + options.length));
  bootp[0] = 2;
  new DataView(bootp.buffer).setUint32(4, xid);
  bootp.set(yiaddr.split(".").map(Number), 16);
  bootp.set([99, 130, 83, 99], 236);
  bootp.set(options, 240);
  return buildUdp({
    srcMac: "02:68:7a:62:00:01",
    dstMac: BROADCAST_MAC,
    srcIp: "192.168.4.1",
    dstIp: "255.255.255.255",
    srcPort: 67,
    dstPort: 68,
    payload: bootp.subarray(0, bootpLength < 240 ? bootpLength : bootp.length),
  });
}

/** The xid a scripted board uses: from the last byte of its MAC. */
const xidOf = (index: number) => (index * 0x10001 + 0xc0de0000) >>> 0;

Deno.test("scripted board: a board without a medium port cannot start", async () => {
  const node = parse(wifiDoc()).nodes[0]!;
  await assertRejects(
    () =>
      scriptedLauncher.start({
        node,
        nodeIndex: 1,
        netPort: null,
        peers: [],
        gateway: { ip: "192.168.4.1", mac: "02:68:7a:62:00:01", subnetMask: "255.255.255.0" },
        clock: new ManualClock(),
        outDir: "/nonexistent",
        onSerial: () => {},
        onProblem: () => {},
      }),
    BoardError,
    "a: a scripted board needs a medium port",
  );
});

Deno.test("scripted board: with no DHCP answer it gives up after ten tries, one a second", async () => {
  await withScriptedBoard(wifiDoc(), async (rig) => {
    for (let i = 1; i <= 10; i++) {
      await until(() => rig.frames.length === i, `DHCPDISCOVER number ${i}`);
      rig.clock.advanceBy(1000);
    }
    assertEquals(rig.problems, ["a: no DHCP answer after 10 tries"]);
    rig.clock.advanceBy(5000);
    assertEquals(rig.frames.length, 10, "no eleventh try");
  });
});

Deno.test("scripted board: DHCP answers for someone else, or without a type, are ignored", async () => {
  await withScriptedBoard(wifiDoc(), async (rig) => {
    await until(() => rig.frames.length === 1, "the first DHCPDISCOVER");
    const xid = xidOf(1);
    await rig.send(dhcpReply(xid + 1, "192.168.4.11", [53, 1, 5, 255])); // another board's xid
    await rig.send(dhcpReply(xid, "192.168.4.11", [53, 1, 5, 255], 200)); // too short to be BOOTP
    await rig.send(dhcpReply(xid, "192.168.4.11", [255])); // no message type
    await rig.send(dhcpReply(xid, "192.168.4.11", [12, 1, 0x41, 255])); // only a host name
    // A pad byte, then the ACK itself: bound without an OFFER first.
    await rig.send(dhcpReply(xid, "192.168.4.77", [0, 53, 1, 5, 255]));
    await until(() => rig.serial.length > 0, "the board binding");
    assertEquals(rig.serial, ["dhcp bound ip=192.168.4.77"]);
    // A second ACK changes nothing.
    await rig.send(dhcpReply(xid, "192.168.4.78", [53, 1, 5, 255]));
    await rig.send(dhcpReply(xid, "192.168.4.79", [53, 1, 2, 255]));
    await rig.send(dhcpReply(xid, "192.168.4.79", [53, 1, 5, 255]).subarray(0, 20)); // not IPv4
    rig.clock.advanceBy(1);
    assertEquals(rig.serial, ["dhcp bound ip=192.168.4.77"]);
  });
});

Deno.test("scripted board: it answers pings from peers, logs other datagrams, ignores the rest", async () => {
  await withScriptedBoard(wifiDoc(), async (rig) => {
    await rig.bind();
    const udp = (srcIp: string, dstIp: string, text: string, srcMac = "02:68:7a:62:01:02") =>
      buildUdp({
        srcMac,
        dstMac: "02:68:7a:62:01:01",
        srcIp,
        dstIp,
        srcPort: 6000,
        dstPort: 5000,
        payload: new TextEncoder().encode(text),
      });
    await rig.send(udp("192.168.4.12", "192.168.4.11", "ping:7"));
    await rig.send(udp("192.168.4.99", "192.168.4.11", "ping:8", "02:00:00:00:00:99"));
    await rig.send(udp("192.168.4.12", "192.168.4.13", "for someone else"));
    await until(() => rig.serial.length >= 3, "the datagrams");
    assertEquals(rig.serial.slice(1), ["rx ping:7 from b", "rx ping:8 from 192.168.4.99"]);
    await until(() => rig.udpPayloads("192.168.4.12").length === 1, "the pong");
    // The pong goes back to the sender's port, and only to a known peer.
    assertEquals(rig.udpPayloads("192.168.4.12"), ["pong:7"]);
    assertEquals(rig.udpPayloads("192.168.4.99"), []);
  });
});

Deno.test("scripted board: a script's UDP sends follow start, every and count", async () => {
  const doc = edit((
    d,
  ) => (fw0(d).send = [{ to: "b", every: "100ms", count: 3, start: "50ms", payload: "hey" }]));
  await withScriptedBoard(doc, async (rig) => {
    await rig.bind();
    rig.clock.advanceBy(49);
    assertEquals(rig.udpPayloads("192.168.4.12"), []);
    rig.clock.advanceBy(1);
    await until(() => rig.udpPayloads("192.168.4.12").length === 1, "the first send");
    rig.clock.advanceBy(1000);
    await until(() => rig.udpPayloads("192.168.4.12").length === 3, "all three sends");
    assertEquals(rig.udpPayloads("192.168.4.12"), ["hey:0", "hey:1", "hey:2"]);
  });
});

Deno.test("scripted board: a send to a peer the run does not know is a problem", async () => {
  const doc = edit((d) => (fw0(d).send = [{ to: "b", every: "1s", count: 1 }]));
  await withScriptedBoard(doc, async (rig) => {
    await rig.bind();
    assertEquals(rig.problems, ["a: scripted send to unknown peer b"]);
  }, () => []);
});

Deno.test("scripted board: its servers listen once bound; ESP-NOW waits for each ACK", async () => {
  const doc = edit((d) => {
    fw0(d).serve = [{ port: 80, protocol: "http" }, { port: 1883, protocol: "mqtt" }];
    fw0(d).send = [
      { to: "b", via: "espnow", every: "1ms", count: 2, payload: "r" },
      { to: "broadcast", via: "espnow", every: "1s", count: 1, payload: "beacon" },
    ];
  });
  await withScriptedBoard(doc, async (rig) => {
    await rig.bind();
    assertEquals(rig.serial.slice(1, 3), [
      "tcp listening on 80 (http)",
      "tcp listening on 1883 (mqtt)",
    ]);
    // Nobody ACKs: each unicast send fails after the fork's 10 ms wait, then the next goes.
    for (let i = 0; i < 5; i++) rig.clock.advanceBy(20);
    await until(
      () => rig.serial.filter((l) => l.startsWith("espnow tx")).length === 3,
      "three sends done",
    );
    // The broadcast was queued at 0 ms, behind the first unicast and before the second.
    assertEquals(rig.serial.filter((l) => l.startsWith("espnow tx")), [
      "espnow tx fail to b",
      "espnow tx ok to broadcast",
      "espnow tx fail to b",
    ]);
  });
});

// ── shared helpers ──────────────────────────────────────────────────────────

const drvEncoder = new TextEncoder();
const drvDecoder = new TextDecoder();
const drvText = (s: string) => drvEncoder.encode(s);
const drvBytes = (...parts: ArrayLike<number>[]) =>
  Uint8Array.from(parts.flatMap((p) => [...Array.from(p)]));
const drvU16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];

/** Yield to the event loop until `cond` holds; fails after `timeoutMs` of wall time. */
async function drvUntil(
  cond: () => boolean,
  what: string | (() => string),
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${typeof what === "string" ? what : what()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Advance a manual clock in 1 ms steps, yielding between them, until `cond` or `maxMs` of virtual time. */
async function drvPump(
  clock: ManualClock,
  maxMs: number,
  cond: () => boolean = () => false,
): Promise<void> {
  const end = clock.now() + maxMs;
  const deadline = Date.now() + 10_000;
  while (clock.now() < end && !cond()) {
    if (Date.now() > deadline) throw new Error("drvPump: wall-time deadline passed");
    clock.advanceBy(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// ── att.ts: helpers ─────────────────────────────────────────────────────────

Deno.test("drivers att: uuidToString formats 16-bit and 128-bit UUIDs from wire order", () => {
  assertEquals(uuidToString(Uint8Array.of(0x01, 0xff)), "0000ff01-0000-1000-8000-00805f9b34fb");
  // Nordic UART service 6e400001-b5a3-f393-e0a9-e50e24dcca9e, least significant byte first.
  const nus = Uint8Array.of(
    0x9e,
    0xca,
    0xdc,
    0x24,
    0x0e,
    0xe5,
    0xa9,
    0xe0,
    0x93,
    0xf3,
    0xa3,
    0xb5,
    0x01,
    0x00,
    0x40,
    0x6e,
  );
  assertEquals(uuidToString(nus), "6e400001-b5a3-f393-e0a9-e50e24dcca9e");
});

Deno.test("drivers att: propertyNames lists each set bit and nothing else", () => {
  assertEquals(propertyNames(0), []);
  assertEquals(propertyNames(PROPERTY.read | PROPERTY.notify), ["read", "notify"]);
  assertEquals(propertyNames(0x3e), [
    "read",
    "write-without-response",
    "write",
    "notify",
    "indicate",
  ]);
});

// ── att.ts: GattServer ──────────────────────────────────────────────────────

function drvGatt(properties: number, charUuid = 0xff01) {
  const writes: string[] = [];
  const server = new GattServer(
    { uuid: 0xff00, firstHandle: 0x0e, characteristic: { uuid: charUuid, properties } },
    (value) => writes.push(drvDecoder.decode(value)),
  );
  return { server, writes };
}

Deno.test("drivers att server: MTU, reads, and errors for unknown and unreadable handles", () => {
  const { server } = drvGatt(PROPERTY.write | PROPERTY.notify);
  assertEquals(server.valueHandle, 0x10);
  assertEquals(server.cccdHandle, 0x11);
  assertEquals(
    server.handle(Uint8Array.of(ATT.mtuReq, 0xf7, 0x00)),
    Uint8Array.of(ATT.mtuRsp, 23, 0),
  );
  // The service declaration reads back its UUID.
  assertEquals(
    server.handle(Uint8Array.of(ATT.readReq, 0x0e, 0)),
    Uint8Array.of(ATT.readRsp, 0x00, 0xff),
  );
  assertEquals(
    server.handle(Uint8Array.of(ATT.readReq, 0x40, 0)),
    errorRsp(ATT.readReq, 0x40, ATT_ERROR.invalidHandle),
  );
  // No read property: the value is write-only.
  assertEquals(
    server.handle(Uint8Array.of(ATT.readReq, 0x10, 0)),
    Uint8Array.of(ATT.errorRsp, ATT.readReq, 0x10, 0, ATT_ERROR.readNotPermitted),
  );
  // An empty PDU is opcode 0: a request nobody supports.
  assertEquals(server.handle(new Uint8Array(0)), errorRsp(0, 0, ATT_ERROR.requestNotSupported));
});

Deno.test("drivers att server: writes reach the value, CCCD writes must be 2 bytes, commands never answer", () => {
  const { server, writes } = drvGatt(
    PROPERTY.read | PROPERTY.write | PROPERTY.writeWithoutResponse,
  );
  assertEquals(
    server.handle(drvBytes([ATT.writeReq, 0x10, 0], drvText("on"))),
    Uint8Array.of(ATT.writeRsp),
  );
  assertEquals(server.handle(drvBytes([ATT.writeCmd, 0x10, 0], drvText("off"))), null);
  assertEquals(writes, ["on", "off"]);
  assertEquals(
    server.handle(Uint8Array.of(ATT.readReq, 0x10, 0)),
    drvBytes([ATT.readRsp], drvText("off")),
  );

  // Unknown handle: an error for a request, silence for a command.
  assertEquals(
    server.handle(Uint8Array.of(ATT.writeReq, 0x99, 0, 1)),
    errorRsp(ATT.writeReq, 0x99, ATT_ERROR.invalidHandle),
  );
  assertEquals(server.handle(Uint8Array.of(ATT.writeCmd, 0x99, 0, 1)), null);
  // The characteristic declaration is read-only.
  assertEquals(
    server.handle(Uint8Array.of(ATT.writeReq, 0x0f, 0, 1)),
    errorRsp(ATT.writeReq, 0x0f, ATT_ERROR.writeNotPermitted),
  );
  assertEquals(server.handle(Uint8Array.of(ATT.writeCmd, 0x0f, 0, 1)), null);
  // CCCD: 3 bytes are refused, 2 bytes stored, and the value callback is not called.
  assertEquals(
    server.handle(Uint8Array.of(ATT.writeReq, 0x11, 0, 1, 0, 0)),
    errorRsp(ATT.writeReq, 0x11, ATT_ERROR.invalidLength),
  );
  assertEquals(server.handle(Uint8Array.of(ATT.writeCmd, 0x11, 0, 1)), null);
  assertEquals(
    server.handle(Uint8Array.of(ATT.writeReq, 0x11, 0, 1, 0)),
    Uint8Array.of(ATT.writeRsp),
  );
  assertEquals(
    server.handle(Uint8Array.of(ATT.readReq, 0x11, 0)),
    Uint8Array.of(ATT.readRsp, 1, 0),
  );
  assertEquals(writes, ["on", "off"]);
  // A value longer than MTU - 3 is cut on setValue.
  server.setValue(new Uint8Array(30).fill(0x41));
  assertEquals(server.handle(Uint8Array.of(ATT.readReq, 0x10, 0))?.length, 1 + MAX_VALUE_BYTES);
});

Deno.test("drivers att server: confirmations and server PDUs are ignored, unknown commands too", () => {
  const { server } = drvGatt(PROPERTY.read);
  for (const op of [ATT.confirm, ATT.notify, ATT.indicate]) {
    assertEquals(server.handle(Uint8Array.of(op, 0x10, 0)), null, `op 0x${op.toString(16)}`);
  }
  assertEquals(server.handle(Uint8Array.of(0x7f)), null, "bit 6 set: a command");
  assertEquals(
    server.handle(Uint8Array.of(0x20)),
    errorRsp(0x20, 0, ATT_ERROR.requestNotSupported),
  );
});

Deno.test("drivers att server: discovery requests outside the table or of other types find nothing", () => {
  const { server } = drvGatt(PROPERTY.read);
  const group = (start: number, end: number, type: number[]) =>
    server.handle(Uint8Array.of(ATT.readByGroupReq, ...drvU16(start), ...drvU16(end), ...type));
  assertEquals(
    group(1, 0xffff, drvU16(0x2801)),
    errorRsp(ATT.readByGroupReq, 1, ATT_ERROR.attributeNotFound),
    "secondary services are not served",
  );
  assertEquals(
    group(1, 0xffff, []),
    errorRsp(ATT.readByGroupReq, 1, ATT_ERROR.attributeNotFound),
    "a short PDU has no type",
  );
  assertEquals(group(0x0f, 0xffff, drvU16(GATT_UUID.primaryService))?.[0], ATT.errorRsp);
  assertEquals(group(1, 0x0d, drvU16(GATT_UUID.primaryService))?.[0], ATT.errorRsp);
  assertEquals(
    group(1, 0xffff, drvU16(GATT_UUID.primaryService)),
    Uint8Array.of(ATT.readByGroupRsp, 6, 0x0e, 0, 0x11, 0, 0x00, 0xff),
  );
  assertEquals(
    server.handle(Uint8Array.of(ATT.findInfoReq, ...drvU16(0x12), ...drvU16(0xffff))),
    errorRsp(ATT.findInfoReq, 0x12, ATT_ERROR.attributeNotFound),
  );
  assertEquals(
    server.handle(Uint8Array.of(ATT.readByTypeReq, ...drvU16(1), ...drvU16(0xffff))),
    errorRsp(ATT.readByTypeReq, 1, ATT_ERROR.attributeNotFound),
  );
});

Deno.test("drivers att server: read by type returns only the pairs as long as the first", () => {
  // A characteristic whose UUID is 0x2902 shares its type with the CCCD.
  const { server } = drvGatt(PROPERTY.read, GATT_UUID.cccd);
  const byType = () =>
    server.handle(
      Uint8Array.of(ATT.readByTypeReq, ...drvU16(1), ...drvU16(0xffff), ...drvU16(GATT_UUID.cccd)),
    );
  server.setValue(Uint8Array.of(7, 8));
  assertEquals(byType(), Uint8Array.of(ATT.readByTypeRsp, 4, 0x10, 0, 7, 8, 0x11, 0, 0, 0));
  server.setValue(Uint8Array.of(7, 8, 9));
  assertEquals(
    byType(),
    Uint8Array.of(ATT.readByTypeRsp, 5, 0x10, 0, 7, 8, 9),
    "the CCCD is left out",
  );
});

// ── att.ts: AttClient ───────────────────────────────────────────────────────

/** A client whose sent PDUs go to `respond`, and whose answers come straight back. */
function drvAttClient(respond: (pdu: Uint8Array) => Uint8Array | null, clock = new ManualClock()) {
  const sent: Uint8Array[] = [];
  const client: AttClient = new AttClient((pdu) => {
    sent.push(pdu);
    const answer = respond(pdu);
    if (answer) client.handle(answer);
  }, clock);
  return { client, sent, clock };
}

Deno.test("drivers att client: discover() walks a GattServer's service, characteristic and CCCD", async () => {
  const { server } = drvGatt(PROPERTY.read | PROPERTY.notify);
  const { client, sent } = drvAttClient((pdu) => server.handle(pdu));
  const services = await client.discover();
  assertEquals(services, [{
    uuid: "0000ff00-0000-1000-8000-00805f9b34fb",
    startHandle: 0x0e,
    endHandle: 0x11,
    characteristics: [{
      uuid: "0000ff01-0000-1000-8000-00805f9b34fb",
      declarationHandle: 0x0f,
      valueHandle: 0x10,
      properties: PROPERTY.read | PROPERTY.notify,
      cccdHandle: 0x11,
    }],
  }]);
  assertEquals(sent.map((p) => p[0]), [
    ATT.readByGroupReq,
    ATT.readByGroupReq,
    ATT.readByTypeReq,
    ATT.readByTypeReq,
    ATT.findInfoReq,
  ]);
  server.setValue(drvText("21.5"));
  assertEquals(drvDecoder.decode(await client.read(0x10)), "21.5");
});

Deno.test("drivers att client: discover() reads 128-bit UUIDs, stops at 0xffff and on empty answers", async () => {
  const nus = Uint8Array.of(
    0x9e,
    0xca,
    0xdc,
    0x24,
    0x0e,
    0xe5,
    0xa9,
    0xe0,
    0x93,
    0xf3,
    0xa3,
    0xb5,
    0x01,
    0x00,
    0x40,
    0x6e,
  );
  const { client, sent } = drvAttClient((pdu) => {
    switch (pdu[0]) {
      case ATT.readByGroupReq: // one 128-bit service that ends at 0xffff: no second request
        return drvBytes([ATT.readByGroupRsp, 20], drvU16(0x20), drvU16(0xffff), nus);
      case ATT.readByTypeReq: // one characteristic with a 128-bit UUID, then a zero-size answer
        return pdu[1] === 0x20
          ? drvBytes([ATT.readByTypeRsp, 21], drvU16(0x21), [PROPERTY.write], drvU16(0x22), nus)
          : Uint8Array.of(ATT.readByTypeRsp, 0);
      case ATT.findInfoReq: // format 2 (128-bit types) at 0x23: no CCCD among them; nothing after
        return pdu[1] === 0x23
          ? drvBytes([ATT.findInfoRsp, 2], drvU16(0x23), nus)
          : errorRsp(ATT.findInfoReq, pdu[1] ?? 0, ATT_ERROR.attributeNotFound);
      default:
        return null;
    }
  });
  const services = await client.discover();
  assertEquals(services.length, 1);
  assertEquals(services[0]?.uuid, "6e400001-b5a3-f393-e0a9-e50e24dcca9e");
  assertEquals(services[0]?.endHandle, 0xffff);
  const chars = services[0]?.characteristics ?? [];
  assertEquals(chars.length, 1);
  assertEquals(chars[0]?.uuid, "6e400001-b5a3-f393-e0a9-e50e24dcca9e");
  assertEquals(chars[0]?.valueHandle, 0x22);
  assertEquals(chars[0]?.cccdHandle, null);
  assertEquals(sent.filter((p) => p[0] === ATT.readByGroupReq).length, 1);
  assertEquals(sent.filter((p) => p[0] === ATT.readByTypeReq).length, 2);
  assertEquals(sent.filter((p) => p[0] === ATT.findInfoReq).length, 2);
});

Deno.test("drivers att client: discover() ends on a zero-size group answer and a missing descriptor", async () => {
  let groups = 0;
  const { client } = drvAttClient((pdu) => {
    if (pdu[0] === ATT.readByGroupReq) {
      groups++;
      return groups === 1
        ? drvBytes([ATT.readByGroupRsp, 6], drvU16(1), drvU16(5), drvU16(0x180f))
        : Uint8Array.of(ATT.readByGroupRsp, 0);
    }
    if (pdu[0] === ATT.readByTypeReq) {
      return pdu[1] === 1
        ? drvBytes([ATT.readByTypeRsp, 7], drvU16(2), [PROPERTY.read], drvU16(3), drvU16(0x2a19))
        : errorRsp(ATT.readByTypeReq, pdu[1] ?? 0, ATT_ERROR.attributeNotFound);
    }
    return errorRsp(pdu[0] ?? 0, 4, ATT_ERROR.attributeNotFound);
  });
  const services = await client.discover();
  assertEquals(groups, 2);
  assertEquals(services.map((s) => [s.uuid.slice(0, 8), s.startHandle, s.endHandle]), [[
    "0000180f",
    1,
    5,
  ]]);
  assertEquals(services[0]?.characteristics[0]?.cccdHandle, null);
});

Deno.test("drivers att client: discover() stops when a server answers below where it asked", async () => {
  // A server that answers every request with the same handles, whatever the start.
  let requests = 0;
  const { client } = drvAttClient((pdu) => {
    // Bound the requests so the unfixed walk ends instead of hanging the test.
    if (++requests > 50) return errorRsp(pdu[0] ?? 0, 1, ATT_ERROR.attributeNotFound);
    if (pdu[0] === ATT.readByGroupReq) {
      return drvBytes([ATT.readByGroupRsp, 6], drvU16(1), drvU16(8), drvU16(0x180f));
    }
    if (pdu[0] === ATT.readByTypeReq) {
      return drvBytes(
        [ATT.readByTypeRsp, 7],
        drvU16(2),
        [PROPERTY.notify],
        drvU16(3),
        drvU16(0x2a19),
      );
    }
    if (pdu[0] === ATT.findInfoReq) {
      return drvBytes([ATT.findInfoRsp, 1], drvU16(4), drvU16(0x2902));
    }
    return errorRsp(pdu[0] ?? 0, 1, ATT_ERROR.attributeNotFound);
  });
  const services = await client.discover();
  assertEquals(services.map((s) => [s.startHandle, s.endHandle]), [[1, 8]]);
  assertEquals(services[0]!.characteristics.map((c) => [c.declarationHandle, c.cccdHandle]), [[
    2,
    4,
  ]]);
  // One request per walk and one more each to see the answer go backwards.
  assert(requests <= 6, `${requests} requests`);
});

Deno.test("drivers att client: discover() rethrows an error other than Attribute Not Found", async () => {
  const { client } = drvAttClient((pdu) => errorRsp(pdu[0] ?? 0, 1, 0x05));
  const error = await assertRejects(() => client.discover(), AttError, "ATT error 0x05");
  assertEquals(error.code, 0x05);
});

Deno.test("drivers att client: notifications are handed over, indications are confirmed", () => {
  const { client, sent } = drvAttClient(() => null);
  const seen: [number, string][] = [];
  client.onNotification = (handle, value) => seen.push([handle, drvDecoder.decode(value)]);
  assert(client.handle(drvBytes([ATT.notify, 0x10, 0], drvText("n"))));
  assertEquals(sent, [], "a notification needs no answer");
  assert(client.handle(drvBytes([ATT.indicate, 0x10, 0], drvText("i"))));
  assertEquals(sent, [Uint8Array.of(ATT.confirm)]);
  assertEquals(seen, [[0x10, "n"], [0x10, "i"]]);
  // Nothing in flight: a response is not ours.
  assertFalse(client.handle(Uint8Array.of(ATT.readRsp, 1)));
  assertFalse(client.handle(new Uint8Array(0)));
});

Deno.test("drivers att client: only the matching response or error settles the request in flight", async () => {
  const { client, sent } = drvAttClient(() => null);
  const reading = client.read(0x10);
  await drvUntil(() => sent.length === 1, "the read request");
  assertFalse(client.handle(Uint8Array.of(ATT.writeRsp)), "another response opcode");
  assertFalse(client.handle(errorRsp(ATT.writeReq, 0x10, 0x01)), "an error for another request");
  assert(client.handle(Uint8Array.of(ATT.readRsp, 0x34, 0x12)));
  assertEquals(await reading, Uint8Array.of(0x34, 0x12));

  const failing = client.read(0x10);
  await drvUntil(() => sent.length === 2, "the second read");
  assert(client.handle(errorRsp(ATT.readReq, 0x10, ATT_ERROR.readNotPermitted)));
  const error = await assertRejects(() => failing, AttError, "0x02");
  assertEquals(error.code, ATT_ERROR.readNotPermitted);
  // A truncated error PDU still settles, with code 0.
  const truncated = client.read(0x10);
  await drvUntil(() => sent.length === 3, "the third read");
  assert(client.handle(Uint8Array.of(ATT.errorRsp, ATT.readReq)));
  assertEquals((await assertRejects(() => truncated, AttError)).code, 0);
});

Deno.test("drivers att client: a request unanswered for 30 s times out, and the next one still runs", async () => {
  const { client, clock, sent } = drvAttClient(() => null);
  const first = client.read(0x10);
  const second = client.read(0x11);
  await drvUntil(() => sent.length === 1, "the first request");
  clock.advanceBy(29_999);
  let settled = false;
  first.catch(() => (settled = true));
  await Promise.resolve();
  assertFalse(settled, "not before 30 s");
  clock.advanceBy(1);
  const error = await assertRejects(() => first, AttError, "30 s");
  assertEquals(error.code, 0);
  // The second request is now in flight; answer it.
  await drvUntil(() => sent.length === 2, "the second request");
  assertEquals(sent[1], Uint8Array.of(ATT.readReq, 0x11, 0));
  assert(client.handle(Uint8Array.of(ATT.readRsp, 9)));
  assertEquals(await second, Uint8Array.of(9));
});

Deno.test("drivers att client: close() fails the request in flight and every later one", async () => {
  const { client, sent } = drvAttClient(() => null);
  const pending = client.read(0x10);
  await drvUntil(() => sent.length === 1, "the read request");
  client.close("the link dropped");
  const error = await assertRejects(() => pending, AttError, "the link dropped");
  assertEquals(error.code, 0);
  await assertRejects(() => client.read(0x10), AttError, "the link dropped");
  await assertRejects(() => client.write(0x10, drvText("x"), false), AttError, "the link dropped");
  await assertRejects(() => client.write(0x10, drvText("x"), true), AttError, "the link dropped");
  assertEquals(sent.length, 1, "only the first read went out");
  client.close("again"); // nothing in flight: no throw
});

Deno.test("drivers att client: writes with and without response, and the MTU limit", async () => {
  const { server, writes } = drvGatt(PROPERTY.write | PROPERTY.writeWithoutResponse);
  const { client, sent } = drvAttClient((pdu) => server.handle(pdu));
  await client.write(0x10, drvText("a"), true);
  await client.write(0x10, drvText("b"), false);
  assertEquals(writes, ["a", "b"]);
  assertEquals(sent.map((p) => p[0]), [ATT.writeReq, ATT.writeCmd]);
  const error = await assertRejects(
    () => client.write(0x10, new Uint8Array(MAX_VALUE_BYTES + 1), true),
    AttError,
    "21 bytes",
  );
  assertEquals(error.code, ATT_ERROR.invalidLength);
  await client.write(0x10, new Uint8Array(MAX_VALUE_BYTES), false);
  assertEquals(sent.length, 3, "a 20-byte value fits");
  const refused = drvAttClient((pdu) => server.handle(pdu));
  await assertRejects(() => refused.client.write(0x0f, drvText("x"), true), AttError, "0x03");
});

// ── hci-host.ts ─────────────────────────────────────────────────────────────

const DRV_HCI_ADDRESS = "02:68:7a:62:01:09";

function drvCommandComplete(
  op: number,
  status: number,
  params: ArrayLike<number> = [],
): Uint8Array {
  return encodeHci({
    type: "event",
    code: EVT.commandComplete,
    params: drvBytes([1], drvU16(op), [status], params),
  });
}

function drvCommandStatus(op: number, status: number): Uint8Array {
  return encodeHci({
    type: "event",
    code: EVT.commandStatus,
    params: drvBytes([status, 1], drvU16(op)),
  });
}

function drvEvent(code: number, params: ArrayLike<number>): Uint8Array {
  return encodeHci({ type: "event", code, params: Uint8Array.from(params) });
}

function drvConnectionComplete(handle: number, role: 0 | 1, peer: string, status = 0): Uint8Array {
  return drvEvent(EVT.leMeta, [
    LE_SUBEVENT.connectionComplete,
    status,
    ...drvU16(handle),
    role,
    0,
    ...addressToBytes(peer),
    ...drvU16(24),
    0,
    0,
    ...drvU16(400),
    0,
  ]);
}

function drvAdvReport(
  peer: string,
  data: ArrayLike<number>,
  rssi: number,
  random = false,
): Uint8Array {
  return drvEvent(EVT.leMeta, [
    LE_SUBEVENT.advertisingReport,
    1,
    0x00,
    random ? 1 : 0,
    ...addressToBytes(peer),
    data.length,
    ...Array.from(data),
    rssi & 0xff,
  ]);
}

function drvAclAtt(handle: number, pdu: ArrayLike<number>, cid = 4, pb = 2): Uint8Array {
  return encodeHci({
    type: "acl",
    handle,
    pb,
    data: drvBytes(drvU16(pdu.length), drvU16(cid), pdu),
  });
}

/** Default controller answers: success, 3 LE ACL buffers, a fixed address, Command Status for Create Connection. */
function drvDefaultReply(op: number): Uint8Array {
  if (op === OP.leReadBufferSize) return drvCommandComplete(op, 0, [...drvU16(27), 3]);
  if (op === OP.readBdAddr) return drvCommandComplete(op, 0, addressToBytes(DRV_HCI_ADDRESS));
  if (op === OP.leCreateConnection) return drvCommandStatus(op, 0);
  return drvCommandComplete(op, 0);
}

/** An HciHost wired to a fake controller in process: commands are answered synchronously. */
function drvHciRig(
  opts: {
    reply?: (op: number, params: Uint8Array) => Uint8Array | null;
    write?: (bytes: Uint8Array) => Promise<void> | null;
    events?: boolean;
  } = {},
) {
  const decoder = new H4Decoder();
  const commands: { op: number; params: Uint8Array }[] = [];
  const acl: { handle: number; pdu: Uint8Array }[] = [];
  const connected: { handle: number; role: string; peer: string; status: number }[] = [];
  const disconnected: [number, number][] = [];
  const reports: AdvertisingReport[] = [];
  const att: [number, Uint8Array][] = [];
  const reply = opts.reply ?? drvDefaultReply;
  const host: HciHost = new HciHost(
    (bytes) => {
      const custom = opts.write?.(bytes);
      if (custom) return custom;
      for (const packet of decoder.push(bytes)) {
        if (packet.type === "command") {
          commands.push({ op: packet.opcode, params: packet.params });
          const answer = reply(packet.opcode, packet.params);
          if (answer) host.feed(answer);
        } else if (packet.type === "acl") {
          acl.push({ handle: packet.handle, pdu: packet.data.slice(4) });
        }
      }
      return Promise.resolve();
    },
    opts.events === false ? {} : {
      connected: (handle, role, peer, status) => connected.push({ handle, role, peer, status }),
      disconnected: (handle, reason) => disconnected.push([handle, reason]),
      advertisingReport: (report) => reports.push(report),
      att: (handle, pdu) => att.push([handle, pdu]),
    },
  );
  return { host, commands, acl, connected, disconnected, reports, att };
}

Deno.test("drivers hci: init() resets, reads the buffer credits and the address", async () => {
  const r = drvHciRig();
  await r.host.init();
  assertEquals(r.commands.map((c) => c.op), [
    OP.reset,
    OP.setEventMask,
    OP.leSetEventMask,
    OP.leReadBufferSize,
    OP.readBdAddr,
  ]);
  assertEquals(r.host.address, DRV_HCI_ADDRESS);
  // Three credits: three ATT frames go out at once, the fourth waits.
  for (let i = 0; i < 4; i++) r.host.sendAtt(0x40, Uint8Array.of(ATT.notify, 0x10, 0, i));
  assertEquals(r.acl.map((a) => a.pdu[3]), [0, 1, 2]);
  r.host.feed(drvEvent(EVT.numberOfCompletedPackets, [1, ...drvU16(0x40), ...drvU16(1)]));
  assertEquals(r.acl.map((a) => a.pdu[3]), [0, 1, 2, 3]);
  assertEquals(r.acl[0]?.pdu, Uint8Array.of(ATT.notify, 0x10, 0, 0));
});

Deno.test("drivers hci: ok() names the command that failed, with or without a label", async () => {
  const r = drvHciRig({ reply: (op) => drvCommandComplete(op, STATUS.commandDisallowed) });
  await assertRejects(() => r.host.init(), Error, "HCI Reset failed with status 0xc");
  await assertRejects(() => r.host.ok(OP.leRand), Error, `HCI 0x${OP.leRand.toString(16)} failed`);
  // command() itself reports the status rather than throwing.
  assertEquals((await r.host.command(OP.leRand)).status, STATUS.commandDisallowed);
});

Deno.test("drivers hci: advertise, scan and the accept list send the parameters a host sends", async () => {
  const r = drvHciRig();
  await r.host.advertise("sensor", 100);
  const [params, data, enable] = r.commands;
  assertEquals(params?.op, OP.leSetAdvParams);
  assertEquals(
    params?.params.subarray(0, 4),
    Uint8Array.of(160, 0, 160, 0),
    "100 ms in 0.625 ms units",
  );
  assertEquals(params?.params[13], 0x07);
  assertEquals(data?.op, OP.leSetAdvData);
  assertEquals(data?.params.length, 32);
  assertEquals(advertisedName((data?.params ?? new Uint8Array()).subarray(1)), "sensor");
  assertEquals(enable?.params, Uint8Array.of(1));

  r.commands.length = 0;
  await r.host.scan(true, 100, 50, true);
  await r.host.scan(false, 10, 10);
  assertEquals(r.commands.map((c) => [c.op, c.params[0]]), [
    [OP.leSetScanParams, 1],
    [OP.leSetScanEnable, 1],
    [OP.leSetScanParams, 0],
    [OP.leSetScanEnable, 1],
  ]);
  assertEquals(r.commands[0]?.params.subarray(1, 5), Uint8Array.of(160, 0, 80, 0));
  assertEquals(r.commands[1]?.params[1], 1, "filter duplicates");
  assertEquals(r.commands[3]?.params[1], 0);

  r.commands.length = 0;
  await r.host.setAcceptList(["02:68:7a:62:01:02", "02:68:7a:62:01:03"]);
  assertEquals(r.commands.map((c) => c.op), [
    OP.leClearAcceptList,
    OP.leAddToAcceptList,
    OP.leAddToAcceptList,
  ]);
  assertEquals(r.commands[2]?.params, Uint8Array.of(0, 0x03, 0x01, 0x62, 0x7a, 0x68, 0x02));
  await r.host.setAcceptList([]);
  assertEquals(r.commands.length, 4, "an empty list only clears");
});

Deno.test("drivers hci: connectAcceptList() takes Command Status, and throws on a failing one", async () => {
  let status: number = STATUS.success;
  const r = drvHciRig({
    reply: (op) =>
      op === OP.leCreateConnection ? drvCommandStatus(op, status) : drvDefaultReply(op),
  });
  await r.host.connectAcceptList(30, 1000);
  const create = r.commands[0]?.params ?? new Uint8Array();
  assertEquals(create[4], 0x01, "initiator filter policy: the accept list");
  assertEquals([create[13], create[14]], [24, 0], "30 ms in 1.25 ms units");
  assertEquals([create[19], create[20]], [100, 0], "1000 ms in 10 ms units");
  status = STATUS.commandDisallowed;
  await assertRejects(
    () => r.host.connectAcceptList(30, 1000),
    Error,
    "LE Create Connection failed with status 0xc",
  );
});

Deno.test("drivers hci: events for another or no command are ignored; truncated ones read as failures", async () => {
  let mode: "other" | "short-complete" | "short-status" = "other";
  const r = drvHciRig({
    reply: (op) => {
      if (mode === "other") return drvCommandComplete(OP.leRand, 0);
      if (mode === "short-complete") {
        return drvEvent(EVT.commandComplete, [1, ...drvU16(op)]);
      }
      return drvEvent(EVT.commandStatus, []);
    },
  });
  // A Command Complete for nothing pending is dropped.
  r.host.feed(drvCommandComplete(OP.reset, 0));
  let done = false;
  const pending = r.host.command(OP.reset).then((result) => {
    done = true;
    return result;
  });
  await drvUntil(() => r.commands.length === 1, "the reset command");
  await Promise.resolve();
  assertFalse(done, "a Command Complete for another opcode does not settle it");
  r.host.feed(drvCommandComplete(OP.reset, 0, [7]));
  assertEquals(await pending, { status: 0, params: Uint8Array.of(7) });

  mode = "short-complete";
  assertEquals((await r.host.command(OP.reset)).status, 0xff, "no status byte");
  // A Command Status with no parameters names opcode 0: it settles a command 0 only.
  mode = "short-status";
  const nop = await r.host.command(0);
  assertEquals(nop, { status: 0xff, params: new Uint8Array(0) });
});

Deno.test("drivers hci: connection, disconnection and advertising reports reach the handlers", () => {
  const r = drvHciRig();
  r.host.feed(drvConnectionComplete(0x40, 0, "02:68:7a:62:01:02"));
  r.host.feed(
    drvConnectionComplete(0x41, 1, "02:68:7a:62:01:03", STATUS.connectionFailedToEstablish),
  );
  assertEquals(r.connected, [
    { handle: 0x40, role: "central", peer: "02:68:7a:62:01:02", status: 0 },
    { handle: 0x41, role: "peripheral", peer: "02:68:7a:62:01:03", status: 0x3e },
  ]);
  r.host.feed(
    drvEvent(EVT.disconnectionComplete, [0, ...drvU16(0x40), STATUS.remoteUserTerminated]),
  );
  r.host.feed(drvEvent(EVT.disconnectionComplete, [0, ...drvU16(0x41)]));
  assertEquals(r.disconnected, [[0x40, 0x13], [0x41, 0]]);

  r.host.feed(drvAdvReport("02:68:7a:62:01:05", [6, 0x09, ...drvText("phone")], -72, true));
  r.host.feed(drvAdvReport("02:68:7a:62:01:06", [], -40));
  assertEquals(r.reports.length, 2);
  assertEquals(r.reports[0]?.address, "02:68:7a:62:01:05");
  assertEquals(r.reports[0]?.random, true);
  assertEquals(r.reports[0]?.rssi, -72);
  assertEquals(advertisedName(r.reports[0]?.data ?? new Uint8Array()), "phone");
  assertEquals(r.reports[1]?.random, false);
  assertEquals(r.reports[1]?.data.length, 0);
  assertEquals(r.reports[1]?.rssi, -40);
  // Other LE subevents and other events are ignored.
  r.host.feed(drvEvent(EVT.leMeta, [LE_SUBEVENT.connectionUpdateComplete, 0, 0x40, 0]));
  r.host.feed(drvEvent(EVT.readRemoteVersionComplete, [0, 0x40, 0]));
  r.host.feed(drvEvent(EVT.leMeta, []));
  assertEquals(r.connected.length, 2);
  assertEquals(r.reports.length, 2);
});

Deno.test("drivers hci: a host without handlers takes every event quietly", () => {
  const r = drvHciRig({ events: false });
  r.host.feed(drvConnectionComplete(0x40, 0, "02:68:7a:62:01:02"));
  r.host.feed(drvEvent(EVT.disconnectionComplete, [0, ...drvU16(0x40), 0x13]));
  r.host.feed(drvAdvReport("02:68:7a:62:01:05", [], -50));
  r.host.feed(drvAclAtt(0x40, [ATT.notify, 0x10, 0, 1]));
  assertEquals(r.connected.length + r.disconnected.length + r.reports.length + r.att.length, 0);
});

Deno.test("drivers hci: ATT frames are reassembled from continuations; other channels are dropped", () => {
  const r = drvHciRig();
  const pdu = drvBytes([ATT.notify, 0x10, 0], drvText("fragmented"));
  const frame = drvBytes(drvU16(pdu.length), drvU16(4), pdu);
  r.host.feed(encodeHci({ type: "acl", handle: 0x40, pb: 2, data: frame.subarray(0, 6) }));
  assertEquals(r.att.length, 0, "the first fragment alone is not a frame");
  r.host.feed(encodeHci({ type: "acl", handle: 0x40, pb: 1, data: frame.subarray(6) }));
  assertEquals(r.att.length, 1);
  assertEquals(r.att[0]?.[0], 0x40);
  assertEquals(drvDecoder.decode(r.att[0]?.[1].subarray(3)), "fragmented");
  // A continuation with nothing to continue is read as a frame of its own.
  r.host.feed(drvAclAtt(0x41, [ATT.notify, 0x10, 0, 0x41], 4, 1));
  assertEquals(r.att.length, 2);
  // L2CAP signalling (CID 5) is not ATT.
  r.host.feed(drvAclAtt(0x40, [0x01, 0x02, 0x03], 5));
  assertEquals(r.att.length, 2);
  // forget() drops a partial frame: the next continuation starts afresh and is incomplete.
  r.host.feed(encodeHci({ type: "acl", handle: 0x42, pb: 2, data: frame.subarray(0, 6) }));
  r.host.forget(0x42);
  r.host.feed(encodeHci({ type: "acl", handle: 0x42, pb: 1, data: frame.subarray(6) }));
  assertEquals(r.att.length, 2);
});

Deno.test("drivers hci: data queued for a dropped connection is forgotten, other connections keep theirs", async () => {
  const r = drvHciRig({
    reply: (op) =>
      op === OP.leReadBufferSize
        ? drvCommandComplete(op, 0, [...drvU16(27), 0])
        : drvDefaultReply(op),
  });
  await r.host.init();
  r.host.sendAtt(0x40, Uint8Array.of(ATT.notify, 0x10, 0, 1));
  r.host.sendAtt(0x41, Uint8Array.of(ATT.notify, 0x10, 0, 2));
  r.host.sendAtt(0x40, Uint8Array.of(ATT.notify, 0x10, 0, 3));
  assertEquals(r.acl.length, 0, "no credits: everything waits");
  r.host.feed(drvEvent(EVT.disconnectionComplete, [0, ...drvU16(0x40), 0x08]));
  r.host.feed(
    drvEvent(EVT.numberOfCompletedPackets, [
      2,
      ...drvU16(0x40),
      ...drvU16(1),
      ...drvU16(0x41),
      ...drvU16(4),
    ]),
  );
  assertEquals(r.acl.map((a) => [a.handle, a.pdu[3]]), [[0x41, 2]]);
});

Deno.test("drivers hci: a failing transport write fails the host, and later commands reject", async () => {
  let failAcl = false;
  const r = drvHciRig({
    write: (bytes) => failAcl && bytes[0] === 0x02 ? Promise.reject(new Error("uart gone")) : null,
  });
  await r.host.init();
  failAcl = true;
  r.host.sendAtt(0x40, Uint8Array.of(ATT.notify, 0x10, 0, 1));
  await assertRejects(() => r.host.command(OP.leRand), Error, "uart gone");
  // Once closed, nothing more is pumped to the controller.
  failAcl = false;
  r.host.sendAtt(0x40, Uint8Array.of(ATT.notify, 0x10, 0, 2));
  assertEquals(r.acl.length, 0);
});

Deno.test("drivers hci: a write that rejects with a non-Error value still fails the host", async () => {
  let failAcl = false;
  const r = drvHciRig({
    write: (bytes) => failAcl && bytes[0] === 0x02 ? Promise.reject("broken pipe") : null,
  });
  await r.host.init();
  failAcl = true;
  r.host.sendAtt(0x40, Uint8Array.of(ATT.notify, 0x10, 0, 1));
  await assertRejects(() => r.host.command(OP.leRand), Error, "broken pipe");
});

Deno.test("drivers hci: fail() rejects the command in flight and every later command", async () => {
  const r = drvHciRig({ reply: () => null });
  const pending = r.host.command(OP.reset);
  await drvUntil(() => r.commands.length === 1, "the reset command");
  r.host.fail(new Error("transport closed"));
  await assertRejects(() => pending, Error, "transport closed");
  await assertRejects(() => r.host.ok(OP.reset), Error, "transport closed");
  assertEquals(r.commands.length, 1, "nothing is written after the failure");
});

Deno.test("drivers hci: a command whose write rejects leaves nothing behind for fail() to reject", async () => {
  // Regression: the result promise of a command whose write failed stayed pending
  // and was rejected by a later fail() with nobody listening (an uncaught rejection).
  const r = drvHciRig({ write: () => Promise.reject(new Error("socket closed")) });
  await assertRejects(() => r.host.command(OP.reset), Error, "socket closed");
  r.host.fail(new Error("stopped"));
  // Give an unhandled rejection the chance to surface before the test ends.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assertRejects(() => r.host.command(OP.reset), Error, "stopped");
});

Deno.test("drivers hci: advertisedName finds the complete or shortened name and stops at padding", () => {
  assertEquals(advertisedName(Uint8Array.of(2, 0x01, 0x06, 4, 0x09, ...drvText("abc"))), "abc");
  assertEquals(advertisedName(Uint8Array.of(3, 0x08, ...drvText("ab"))), "ab");
  assertEquals(advertisedName(Uint8Array.of(2, 0x01, 0x06)), null, "flags only");
  assertEquals(
    advertisedName(Uint8Array.of(0, 4, 0x09, ...drvText("abc"))),
    null,
    "zero length ends the data",
  );
  assertEquals(advertisedName(new Uint8Array(0)), null);
});

// ── arduino-lora.ts ─────────────────────────────────────────────────────────

const DRV_LORA_PINS = { ss: 5, reset: 14, dio0: 26 };

/** An SX127x register file: bit 7 of the address byte is write. Reads can be overridden per register. */
class DrvLoraRegs implements SpiDevice {
  readonly regs = new Uint8Array(0x80);
  readonly writes: [number, number][] = [];
  readonly reads: number[] = [];
  readonly pins: [number, Level][] = [];
  readonly delays: number[] = [];
  readonly overrides = new Map<number, () => number>();
  onWrite: (address: number, value: number) => void = () => {};
  onDelay: () => void = () => {};
  #address: number | null = null;

  constructor() {
    this.regs[0x42] = 0x12;
  }

  pinChanged(gpio: number, level: Level): void {
    this.pins.push([gpio, level]);
    if (gpio === DRV_LORA_PINS.ss) this.#address = null;
  }

  transfer(mosi: number): number {
    if (this.#address === null) {
      this.#address = mosi;
      return 0;
    }
    const address = this.#address;
    this.#address = null;
    if (address & 0x80) {
      this.regs[address & 0x7f] = mosi;
      this.writes.push([address & 0x7f, mosi]);
      this.onWrite(address & 0x7f, mosi);
      return 0;
    }
    this.reads.push(address);
    return this.overrides.get(address)?.() ?? this.regs[address] ?? 0;
  }

  bus(): DriverBus {
    return {
      digitalWrite: (gpio, level) => Promise.resolve(this.pinChanged(gpio, level)),
      transfer: (mosi) => Promise.resolve(this.transfer(mosi)),
      delay: (ms) => {
        this.delays.push(ms);
        this.onDelay();
        return Promise.resolve();
      },
    };
  }

  wrote(address: number): number[] {
    return this.writes.filter(([a]) => a === address).map(([, v]) => v);
  }
}

Deno.test("drivers lora: begin() gives up on a chip that does not answer version 0x12", async () => {
  const chip = new DrvLoraRegs();
  chip.regs[0x42] = 0x22;
  const lora = new ArduinoLora(chip.bus(), DRV_LORA_PINS);
  assertFalse(await lora.begin(868.1e6));
  assertEquals(chip.writes, [], "nothing is configured");
  assertEquals(chip.pins.slice(0, 3), [[5, 1], [14, 0], [14, 1]], "reset pulsed before the read");
  assertEquals(chip.delays, [10, 10]);
});

Deno.test("drivers lora: begin() without a reset pin skips the pulse; 433 MHz uses the LF RSSI offset", async () => {
  const chip = new DrvLoraRegs();
  const lora = new ArduinoLora(chip.bus(), { ss: 5, reset: null, dio0: null });
  assert(await lora.begin(433e6));
  assertEquals(chip.delays, []);
  assertFalse(chip.pins.some(([gpio]) => gpio === 14));
  assertEquals(chip.regs[0x01], 0x81, "standby");
  assertEquals([chip.regs[0x06], chip.regs[0x07], chip.regs[0x08]], [0x6c, 0x40, 0x00]);
  assertEquals(chip.regs[0x0c], 0x03, "LNA boost on");
  chip.regs[0x1a] = 100;
  assertEquals(await lora.packetRssi(), 100 - 164);
  await lora.setFrequency(868e6);
  assertEquals(await lora.packetRssi(), 100 - 157);
});

Deno.test("drivers lora: setTxPower clamps, and above 17 dBm turns on the high-power DAC and a higher OCP", async () => {
  const chip = new DrvLoraRegs();
  const lora = new ArduinoLora(chip.bus(), DRV_LORA_PINS);
  await lora.setTxPower(25);
  assertEquals([chip.regs[0x4d], chip.regs[0x0b], chip.regs[0x09]], [0x87, 0x20 | 17, 0x80 | 15]);
  await lora.setTxPower(18);
  assertEquals(chip.regs[0x09], 0x80 | 13);
  await lora.setTxPower(1);
  assertEquals([chip.regs[0x4d], chip.regs[0x0b], chip.regs[0x09]], [0x84, 0x20 | 11, 0x80 | 0]);
});

Deno.test("drivers lora: spreading factor, bandwidth and coding rate clamp and set LowDataRateOptimize", async () => {
  const chip = new DrvLoraRegs();
  const lora = new ArduinoLora(chip.bus(), DRV_LORA_PINS);
  await lora.setSignalBandwidth(125e3);
  await lora.setSpreadingFactor(5);
  assertEquals(await lora.getSpreadingFactor(), 6, "SF5 clamps to 6");
  assertEquals([chip.regs[0x31], chip.regs[0x37]], [0xc5, 0x0c], "SF6 detection settings");
  await lora.setSpreadingFactor(13);
  assertEquals(await lora.getSpreadingFactor(), 12);
  assertEquals([chip.regs[0x31], chip.regs[0x37]], [0xc3, 0x0a]);
  assertEquals((chip.regs[0x26] ?? 0) & 0x08, 0x08, "SF12 at 125 kHz: 32 ms symbols, LDO on");
  await lora.setSignalBandwidth(600e3);
  assertEquals(await lora.getSignalBandwidth(), 500e3, "over 500 kHz picks the widest");
  assertEquals((chip.regs[0x26] ?? 0) & 0x08, 0, "SF12 at 500 kHz: 8 ms symbols, LDO off");
  await lora.setSignalBandwidth(7e3);
  assertEquals(await lora.getSignalBandwidth(), 7.8e3);
  chip.regs[0x1d] = 0xa0; // bandwidth index 10 does not exist
  assertEquals(await lora.getSignalBandwidth(), -1);
  chip.regs[0x1d] = 0;
  await lora.setCodingRate4(9);
  assertEquals((chip.regs[0x1d] ?? 0) & 0x0e, 4 << 1);
  await lora.setCodingRate4(1);
  assertEquals((chip.regs[0x1d] ?? 0) & 0x0e, 1 << 1);
});

Deno.test("drivers lora: CRC, preamble and sync word land in their registers", async () => {
  const chip = new DrvLoraRegs();
  const lora = new ArduinoLora(chip.bus(), DRV_LORA_PINS);
  chip.regs[0x1e] = 0x70;
  await lora.enableCrc();
  assertEquals(chip.regs[0x1e], 0x74);
  await lora.disableCrc();
  assertEquals(chip.regs[0x1e], 0x70);
  await lora.setPreambleLength(0x0123);
  assertEquals([chip.regs[0x20], chip.regs[0x21]], [0x01, 0x23]);
  await lora.setSyncWord(0x34);
  assertEquals(chip.regs[0x39], 0x34);
  await lora.sleep();
  assertEquals(chip.regs[0x01], 0x80);
});

Deno.test("drivers lora: beginPacket refuses while transmitting and clears a stale TxDone otherwise", async () => {
  const chip = new DrvLoraRegs();
  const lora = new ArduinoLora(chip.bus(), DRV_LORA_PINS);
  chip.regs[0x01] = 0x83; // TX
  assert(await lora.isTransmitting());
  assertFalse(await lora.beginPacket());
  assertEquals(chip.writes, [], "nothing written while a packet is on the air");
  chip.regs[0x01] = 0x81;
  chip.regs[0x12] = 0x08; // TxDone left set
  assert(await lora.beginPacket(true));
  assertEquals(chip.wrote(0x12), [0x08], "TxDone cleared");
  assertEquals((chip.regs[0x1d] ?? 0) & 0x01, 0x01, "implicit header");
  assertEquals([chip.regs[0x0d], chip.regs[0x22]], [0, 0]);
  assert(await lora.beginPacket());
  assertEquals((chip.regs[0x1d] ?? 0) & 0x01, 0, "explicit header");
});

Deno.test("drivers lora: write() fills the FIFO up to 255 bytes; endPacket polls until TxDone", async () => {
  const chip = new DrvLoraRegs();
  const lora = new ArduinoLora(chip.bus(), DRV_LORA_PINS);
  assert(await lora.beginPacket());
  assertEquals(await lora.write(drvText("abc")), 3);
  assertEquals(chip.wrote(0x00), [0x61, 0x62, 0x63]);
  assertEquals(chip.regs[0x22], 3);
  chip.regs[0x22] = 254;
  assertEquals(await lora.write(drvText("xyz")), 1, "only one byte of room left");
  assertEquals(chip.regs[0x22], 255);
  let polls = 0;
  chip.onDelay = () => {
    if (++polls === 3) chip.regs[0x12] = 0x08;
  };
  await lora.endPacket();
  assertEquals(chip.wrote(0x01).at(-1), 0x83, "TX mode");
  assertEquals(chip.delays, [1, 1, 1]);
  assertEquals(chip.wrote(0x12), [0x08], "TxDone cleared");
});

Deno.test("drivers lora: parsePacket in implicit mode reads the fixed length; a CRC error is dropped", async () => {
  const chip = new DrvLoraRegs();
  const lora = new ArduinoLora(chip.bus(), DRV_LORA_PINS);
  chip.regs[0x12] = 0x40; // RxDone
  chip.regs[0x10] = 0x20;
  assertEquals(await lora.parsePacket(12), 12);
  assertEquals((chip.regs[0x1d] ?? 0) & 0x01, 1, "implicit header");
  assertEquals(chip.regs[0x0d], 0x20, "FIFO pointer at the packet");
  assertEquals(chip.regs[0x01], 0x81, "standby after the packet");
  // RxDone with a CRC error: no packet, and RX single is entered again.
  chip.regs[0x12] = 0x60;
  chip.regs[0x01] = 0x81;
  assertEquals(await lora.parsePacket(), 0);
  assertEquals(chip.regs[0x01], 0x86);
  // Already in RX single: it is not re-armed.
  chip.regs[0x12] = 0;
  const before = chip.writes.length;
  assertEquals(await lora.parsePacket(), 0);
  assertFalse(chip.writes.slice(before).some(([a]) => a === 0x01));
});

Deno.test("drivers lora: handleDio0Rise ignores CRC errors and spurious rises; implicit mode reads the fixed length", async () => {
  const chip = new DrvLoraRegs();
  const lora = new ArduinoLora(chip.bus(), DRV_LORA_PINS);
  chip.regs[0x12] = 0x60;
  assertEquals(await lora.handleDio0Rise(), 0, "CRC error");
  assertEquals(chip.wrote(0x12), [0x60], "the flags are cleared anyway");
  chip.regs[0x12] = 0x10;
  assertEquals(await lora.handleDio0Rise(), 0, "no RxDone");
  await lora.receive(9);
  assertEquals(chip.regs[0x22], 9);
  assertEquals(chip.regs[0x01], 0x85, "RX continuous");
  assertEquals(chip.regs[0x40], 0, "DIO0 mapped to RxDone");
  chip.regs[0x12] = 0x40;
  chip.regs[0x13] = 99; // ignored in implicit mode
  assertEquals(await lora.handleDio0Rise(), 9);
});

Deno.test("drivers lora: read() returns -1 once the packet is consumed; SNR is signed quarter dB", async () => {
  const chip = new DrvLoraRegs();
  const lora = new ArduinoLora(chip.bus(), DRV_LORA_PINS);
  let fifo = 0;
  chip.overrides.set(0x00, () => [0x68, 0x69][fifo++] ?? 0);
  chip.regs[0x13] = 2;
  chip.regs[0x12] = 0x40;
  assertEquals(await lora.handleDio0Rise(), 2);
  assertEquals(await lora.available(), 2);
  assertEquals(drvDecoder.decode(await lora.readAll()), "hi");
  assertEquals(await lora.available(), 0);
  assertEquals(await lora.read(), -1);
  chip.regs[0x19] = 0xf8;
  assertEquals(await lora.packetSnr(), -2);
  chip.regs[0x19] = 0x28;
  assertEquals(await lora.packetSnr(), 10);
});

Deno.test("drivers lora: against the SX127x model, an implicit-header packet is parsed back", async () => {
  const clock = new ManualClock();
  const air = new AirMedium({
    seed: 5,
    clock,
    log: new EventLog(),
    environment: environmentFromPreset("free_space", { shadowingSigmaDb: 0 }),
  });
  const make = (id: string, x: number) => {
    const chip = new Sx127x({
      pins: { cs: 5, reset: 14, dio0: 26 },
      clock,
      transmit: (frame) => air.transmit(id, frame),
      drivePin: () => {},
      rng: substream(5, `sx127x:${id}`),
      warn: () => {},
    });
    air.addNode({ id, position: { x, y: 0 }, antennaGainDbi: 0 }, chip);
    return new ArduinoLora({
      digitalWrite: (gpio, level) => Promise.resolve(chip.pinChanged(gpio, level)),
      transfer: (mosi) => Promise.resolve(chip.transfer(mosi)),
      delay: (ms) => Promise.resolve(clock.advanceBy(ms)),
    }, DRV_LORA_PINS);
  };
  const tx = make("tx", 0);
  const rx = make("rx", 30);
  assert(await tx.begin(868.1e6));
  assert(await rx.begin(868.1e6));
  await rx.receive(5);
  assert(await tx.beginPacket(true));
  await tx.write(drvText("12345"));
  await tx.endPacket();
  assertEquals(await rx.handleDio0Rise(), 5);
  assertEquals(drvDecoder.decode(await rx.readAll()), "12345");
});

// ── rf24.ts ─────────────────────────────────────────────────────────────────

const DRV_RF24_PINS = { ce: 4, csn: 5 };

/** An nRF24L01+ register file: the first byte after CSN falls is the command. */
class DrvRf24Regs implements SpiDevice {
  readonly regs = new Uint8Array(0x20);
  readonly wide = new Map<number, number[]>();
  /** Every completed CSN frame: command then data bytes. */
  readonly frames: number[][] = [];
  readonly ce: Level[] = [];
  readonly delays: number[] = [];
  readonly readHooks = new Map<number, () => number>();
  status: () => number = () => 0x0e;
  #frame: number[] | null = null;

  pinChanged(gpio: number, level: Level): void {
    if (gpio === DRV_RF24_PINS.ce) this.ce.push(level);
    if (gpio !== DRV_RF24_PINS.csn) return;
    if (level === 0) this.#frame = [];
    else if (this.#frame) {
      const [cmd = 0, ...data] = this.#frame;
      if (cmd >= 0x20 && cmd < 0x40) {
        const reg = cmd & 0x1f;
        if (data.length > 1) this.wide.set(reg, data);
        else this.regs[reg] = data[0] ?? 0;
      }
      this.frames.push(this.#frame);
      this.#frame = null;
    }
  }

  transfer(mosi: number): number {
    const frame = this.#frame;
    if (!frame) return 0xff;
    frame.push(mosi);
    if (frame.length === 1) return this.status();
    const cmd = frame[0] ?? 0;
    if (cmd < 0x20 && frame.length === 2) return this.readHooks.get(cmd)?.() ?? this.regs[cmd] ?? 0;
    return 0;
  }

  bus(): DriverBus {
    return {
      digitalWrite: (gpio, level) => Promise.resolve(this.pinChanged(gpio, level)),
      transfer: (mosi) => Promise.resolve(this.transfer(mosi)),
      delay: (ms) => {
        this.delays.push(ms);
        return Promise.resolve();
      },
    };
  }

  commands(): number[] {
    return this.frames.map((f) => f[0] ?? -1);
  }
}

Deno.test("drivers rf24: begin() reports false when CONFIG does not read back", async () => {
  const chip = new DrvRf24Regs();
  chip.readHooks.set(0x00, () => 0x00);
  const rf = new Rf24(chip.bus(), DRV_RF24_PINS);
  assertFalse(await rf.begin());
  assertEquals(chip.regs[0x00], 0x02, "powerUp wrote PWR_UP over the bad readback");
  assertEquals(rf.status, 0x0e, "the last STATUS seen");
  const chip2 = new DrvRf24Regs();
  assert(await new Rf24(chip2.bus(), DRV_RF24_PINS).begin());
  assertEquals(chip2.regs[0x00], 0x7e);
  assertEquals(chip2.regs[0x05], 76);
  assertEquals(chip2.regs[0x03], 3, "5-byte addresses");
});

Deno.test("drivers rf24: begin() turns off features left on, toggling ACTIVATE back when it changed nothing", async () => {
  // FEATURE reads 0x06 before and after ACTIVATE: toggled twice, then cleared.
  const sticky = new DrvRf24Regs();
  sticky.readHooks.set(0x1d, () => 0x06);
  assert(await new Rf24(sticky.bus(), DRV_RF24_PINS).begin());
  assertEquals(sticky.commands().filter((c) => c === 0x50).length, 2);
  assertEquals(sticky.frames.filter((f) => f[0] === 0x3d), [[0x3d, 0]], "FEATURE written to 0");

  // FEATURE appears only after ACTIVATE: one toggle, then cleared.
  const fresh = new DrvRf24Regs();
  let featureReads = 0;
  fresh.readHooks.set(0x1d, () => (featureReads++ === 0 ? 0 : 0x04));
  assert(await new Rf24(fresh.bus(), DRV_RF24_PINS).begin());
  assertEquals(fresh.commands().filter((c) => c === 0x50).length, 1);
  assertEquals(fresh.frames.filter((f) => f[0] === 0x3d).length, 1);

  // FEATURE stays 0: one toggle, no FEATURE write.
  const none = new DrvRf24Regs();
  assert(await new Rf24(none.bus(), DRV_RF24_PINS).begin());
  assertEquals(none.commands().filter((c) => c === 0x50).length, 1);
  assertEquals(none.frames.filter((f) => f[0] === 0x3d).length, 0);
});

Deno.test("drivers rf24: setters clamp, and setDataRate reports a register that did not take", async () => {
  const chip = new DrvRf24Regs();
  const rf = new Rf24(chip.bus(), DRV_RF24_PINS);
  await rf.setChannel(200);
  assertEquals(chip.regs[0x05], 125);
  await rf.setRetries(20, 30);
  assertEquals(chip.regs[0x04], 0xff);
  await rf.setPayloadSize(0);
  assertEquals(chip.regs[0x11], 1);
  await rf.setPayloadSize(64);
  assertEquals([chip.regs[0x11], chip.regs[0x16]], [32, 32]);
  assert(await rf.setDataRate(250));
  assertEquals(chip.regs[0x06], 0x20);
  assert(await rf.setDataRate(2000));
  assertEquals(chip.regs[0x06], 0x08);
  chip.readHooks.set(0x06, () => 0x00);
  assertFalse(await rf.setDataRate(2000), "RF_SETUP read back without the rate bit");
  chip.readHooks.delete(0x06);
  chip.regs[0x06] = 0x08;
  await rf.setPALevel(1, false);
  assertEquals(chip.regs[0x06], 0x08 | 0x02);
  await rf.setPALevel(3);
  assertEquals(chip.regs[0x06], 0x08 | 0x06 | 0x01);
  await rf.setAutoAck(false);
  assertEquals(chip.regs[0x01], 0);
  await rf.setAutoAck(true);
  assertEquals(chip.regs[0x01], 0x3f);
  chip.regs[0x03] = 3;
  assert(await rf.isChipConnected());
  chip.regs[0x03] = 0;
  assertFalse(await rf.isChipConnected());
});

Deno.test("drivers rf24: reading pipes: pipe 0 waits for startListening, pipes 2-5 take one byte, 6 is ignored", async () => {
  const chip = new DrvRf24Regs();
  const rf = new Rf24(chip.bus(), DRV_RF24_PINS);
  const address = Uint8Array.of(0xa1, 0xb2, 0xc3, 0xd4, 0xe5, 0xf6);
  await rf.openReadingPipe(0, address);
  assertEquals(chip.wide.has(0x0a), false, "not written while transmitting");
  assertEquals((chip.regs[0x02] ?? 0) & 1, 1);
  await rf.openReadingPipe(3, address);
  assertEquals(chip.regs[0x0d], 0xa1, "only the first byte for pipe 3");
  assertEquals((chip.regs[0x02] ?? 0) & 0x08, 0x08);
  const before = chip.frames.length;
  await rf.openReadingPipe(6, address);
  assertEquals(chip.frames.length, before, "pipe 6 does not exist");

  await rf.startListening();
  assertEquals(
    chip.wide.get(0x0a),
    [0xa1, 0xb2, 0xc3, 0xd4, 0xe5],
    "pipe 0 address restored, 5 bytes",
  );
  assertEquals((chip.regs[0x00] ?? 0) & 0x01, 1, "PRIM_RX");
  assertEquals(chip.ce.at(-1), 1);
  // While receiving, pipe 0 is written straight away.
  await rf.openReadingPipe(0, Uint8Array.of(1, 2, 3, 4, 5));
  assertEquals(chip.wide.get(0x0a), [1, 2, 3, 4, 5]);
});

Deno.test("drivers rf24: stopListening restores the writing address on pipe 0; startListening without pipe 0 closes it", async () => {
  const chip = new DrvRf24Regs();
  const rf = new Rf24(chip.bus(), DRV_RF24_PINS);
  await rf.openWritingPipe(Uint8Array.of(9, 8, 7, 6, 5));
  assertEquals(chip.wide.get(0x10), [9, 8, 7, 6, 5]);
  chip.regs[0x02] = 0x03;
  await rf.startListening();
  assertEquals(chip.regs[0x02], 0x02, "pipe 0 disabled: nothing to read on it");
  chip.wide.delete(0x0a);
  await rf.stopListening();
  assertEquals(chip.ce.at(-1), 0);
  assertEquals((chip.regs[0x00] ?? 0) & 0x01, 0, "PRIM_RX cleared");
  assertEquals(chip.wide.get(0x0a), [9, 8, 7, 6, 5]);
  assertEquals(chip.regs[0x02], 0x03, "pipe 0 enabled again");
  assertEquals(chip.delays, [5, 1], "power-up settle, then the CE-low delay");
});

Deno.test("drivers rf24: write() succeeds on TX_DS, flushes on MAX_RT, gives up after the timeout", async () => {
  const chip = new DrvRf24Regs();
  const rf = new Rf24(chip.bus(), DRV_RF24_PINS);
  chip.status = () => 0x2e;
  assert(await rf.write(drvText("hi")));
  const payload = chip.frames.find((f) => f[0] === 0xa0) ?? [];
  assertEquals(payload.length, 33, "padded to the 32-byte payload");
  assertEquals(payload.slice(1, 4), [0x68, 0x69, 0]);
  assertEquals(chip.regs[0x07], 0x70, "IRQ flags cleared");

  chip.frames.length = 0;
  chip.status = () => 0x1e;
  assertFalse(await rf.write(drvText("hi"), true));
  assertEquals(chip.commands()[0], 0xb0, "W_TX_PAYLOAD_NO_ACK");
  assert(chip.commands().includes(0xe1), "FLUSH_TX after MAX_RT");

  chip.frames.length = 0;
  chip.delays.length = 0;
  chip.ce.length = 0;
  chip.status = () => 0x0e;
  assertFalse(await rf.write(drvText("lost")));
  assertEquals(chip.delays.length, 95, "1 ms polls up to the 95 ms timeout");
  assertEquals(chip.ce, [1, 0]);
  assertFalse(chip.commands().includes(0xe1));
  assertFalse(chip.frames.some((f) => f[0] === 0x27), "no STATUS write on a timeout");
});

Deno.test("drivers rf24: read() fetches the whole payload but returns the asked length; pipeAvailable reads RX_P_NO", async () => {
  const chip = new DrvRf24Regs();
  const rf = new Rf24(chip.bus(), DRV_RF24_PINS);
  chip.status = () => 0x40 | (2 << 1);
  assertEquals(await rf.pipeAvailable(), 2);
  chip.regs[0x17] = 0x10;
  assert(await rf.available());
  chip.regs[0x17] = 0x11;
  assertFalse(await rf.available());
  const data = await rf.read(4);
  assertEquals(data.length, 4);
  const frame = chip.frames.find((f) => f[0] === 0x61) ?? [];
  assertEquals(frame.length, 33, "all 32 bytes clocked out");
  assertEquals(chip.regs[0x07], 0x40, "RX_DR cleared");
  assertEquals((await rf.read(64)).length, 32);
});

// ── tcp-services.ts: pure functions ─────────────────────────────────────────

Deno.test("drivers tcp: websocketAccept matches the RFC 6455 example", async () => {
  assertEquals(await websocketAccept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

Deno.test("drivers tcp: websocketFrame picks 7-, 16- or 64-bit lengths", () => {
  assertEquals(websocketFrame(0x1, new Uint8Array(125)).subarray(0, 2), Uint8Array.of(0x81, 125));
  assertEquals(
    websocketFrame(0x2, new Uint8Array(126)).subarray(0, 4),
    Uint8Array.of(0x82, 126, 0, 126),
  );
  assertEquals(
    websocketFrame(0x2, new Uint8Array(65535)).subarray(0, 4),
    Uint8Array.of(0x82, 126, 0xff, 0xff),
  );
  const big = websocketFrame(0x2, new Uint8Array(65536));
  assertEquals(big.subarray(0, 10), Uint8Array.of(0x82, 127, 0, 0, 0, 0, 0, 1, 0, 0));
  assertEquals(big.length, 65546);
});

function drvMasked(opcode: number, payload: Uint8Array, fin = true): Uint8Array {
  const mask = [0x37, 0xfa, 0x21, 0x3d];
  const n = payload.length;
  const len = n < 126 ? [0x80 | n] : n < 65536 ? [0x80 | 126, n >>> 8, n & 0xff] : [
    0x80 | 127,
    0,
    0,
    0,
    0,
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ];
  return drvBytes(
    [(fin ? 0x80 : 0) | opcode],
    len,
    mask,
    payload.map((b, i) => b ^ (mask[i % 4] ?? 0)),
  );
}

Deno.test("drivers tcp: parseWebsocketFrame unmasks, and waits for every part of the frame", () => {
  const frame = drvMasked(0x1, drvText("Hello"));
  assertEquals(parseWebsocketFrame(frame), {
    fin: true,
    opcode: 1,
    payload: drvText("Hello"),
    size: 11,
  });
  assertEquals(parseWebsocketFrame(frame.subarray(0, 1)), null);
  assertEquals(parseWebsocketFrame(frame.subarray(0, 10)), null, "payload incomplete");
  const unmasked = parseWebsocketFrame(Uint8Array.of(0x02, 2, 7, 8, 9));
  assertEquals(unmasked, { fin: false, opcode: 2, payload: Uint8Array.of(7, 8), size: 4 });

  const medium = drvMasked(0x2, new Uint8Array(300).fill(1));
  assertEquals(parseWebsocketFrame(medium.subarray(0, 3)), null, "16-bit length incomplete");
  assertEquals(parseWebsocketFrame(medium)?.payload.length, 300);
  assertEquals(parseWebsocketFrame(medium)?.size, 2 + 2 + 4 + 300);

  const large = drvMasked(0x2, new Uint8Array(70_000).fill(2));
  assertEquals(parseWebsocketFrame(large.subarray(0, 9)), null, "64-bit length incomplete");
  assertEquals(parseWebsocketFrame(large.subarray(0, 1000)), null);
  const parsed = parseWebsocketFrame(large);
  assertEquals(parsed?.payload.length, 70_000);
  assertEquals(parsed?.payload[69_999], 2);
  // A frame at an offset in a larger buffer.
  const shifted = drvBytes([0xee], drvMasked(0x1, drvText("x")));
  assertEquals(parseWebsocketFrame(shifted.subarray(1))?.payload, drvText("x"));
  assertEquals(
    parseWebsocketFrame(websocketFrame(0x2, new Uint8Array(65536)))?.payload.length,
    65536,
  );
});

Deno.test("drivers tcp: mqttTopicMatches follows the + and # wildcard rules", () => {
  assert(mqttTopicMatches("a/b", "a/b"));
  assert(mqttTopicMatches("a/+", "a/b"));
  assert(mqttTopicMatches("a/#", "a/b/c"));
  assert(mqttTopicMatches("#", "a"));
  assert(mqttTopicMatches("+/+", "x/y"));
  assertFalse(mqttTopicMatches("a/#/c", "a/b/c"), "# only at the end");
  assertFalse(mqttTopicMatches("a/+/c", "a/b"), "topic shorter than the filter");
  assertFalse(mqttTopicMatches("a/b", "a/b/c"), "topic longer than the filter");
  assertFalse(mqttTopicMatches("a/c", "a/b"));
});

Deno.test("drivers tcp: MQTT packets round-trip with one- and multi-byte remaining lengths", () => {
  const small = mqttPacket(12, 0, []);
  assertEquals(small, Uint8Array.of(0xc0, 0));
  assertEquals(parseMqttPacket(small), { type: 12, flags: 0, body: new Uint8Array(0), size: 2 });
  const body = new Uint8Array(200).fill(7);
  const big = mqttPacket(3, 2, body);
  assertEquals(big.subarray(0, 3), Uint8Array.of(0x32, 0xc8, 0x01), "200 = 0x48 | 0x80, 0x01");
  const parsed = parseMqttPacket(big);
  assertEquals([parsed?.type, parsed?.flags, parsed?.body.length, parsed?.size], [3, 2, 200, 203]);
  assertEquals(parseMqttPacket(big.subarray(0, 100)), null, "body incomplete");
  assertEquals(parseMqttPacket(big.subarray(0, 2)), null, "length continues past the buffer");
  assertEquals(parseMqttPacket(Uint8Array.of(0x30)), null);
  // A remaining length over four bytes is malformed (MQTT 3.1.1 §2.2.3), not incomplete.
  assertThrows(
    () => parseMqttPacket(Uint8Array.of(0x30, 0xff, 0xff, 0xff, 0xff, 0x01)),
    RangeError,
    "remaining length",
  );
  // Four continuation bytes with the fifth not yet arrived are still malformed.
  assertThrows(() => parseMqttPacket(Uint8Array.of(0x30, 0xff, 0xff, 0xff, 0xff)), RangeError);
  // Four bytes, the last without continuation, is the largest legal length: incomplete, not malformed.
  assertEquals(parseMqttPacket(Uint8Array.of(0x30, 0xff, 0xff, 0xff, 0x7f)), null);
  const publish = mqttPublish("t/1", drvText("v"));
  assertEquals(publish, Uint8Array.of(0x30, 6, 0, 3, ...drvText("t/1"), ...drvText("v")));
  assertEquals(
    mqttPacket(3, 0, new Uint8Array(16384)).subarray(1, 4),
    Uint8Array.of(0x80, 0x80, 0x01),
  );
});

// ── tcp-services.ts: serving a connection ───────────────────────────────────

/** A TcpConnection stand-in: what the service writes, and calls to play the peer. */
class DrvConn {
  readonly remote = { ip: "192.168.4.20", port: 50123 };
  readonly local = { ip: "192.168.4.11", port: 80 };
  readonly written: Uint8Array[] = [];
  readonly aborted: string[] = [];
  ended = 0;
  failWrites = false;
  #onData: (bytes: Uint8Array) => void = () => {};
  #onEnd: () => void = () => {};
  #onClose: (error: Error | null) => void = () => {};

  onData(fn: (bytes: Uint8Array) => void): void {
    this.#onData = fn;
  }
  onEnd(fn: () => void): void {
    this.#onEnd = fn;
  }
  onClose(fn: (error: Error | null) => void): void {
    this.#onClose = fn;
  }
  write(bytes: Uint8Array): Promise<void> {
    if (this.failWrites) return Promise.reject(new Error("connection is closed"));
    this.written.push(bytes);
    return Promise.resolve();
  }
  end(): void {
    this.ended++;
  }
  abort(reason = "aborted"): void {
    this.aborted.push(reason);
  }
  /** Peer side. */
  send(bytes: Uint8Array): void {
    this.#onData(bytes);
  }
  peerEnd(): void {
    this.#onEnd();
  }
  close(): void {
    this.#onClose(null);
  }
  text(): string {
    return this.written.map((b) => drvDecoder.decode(b)).join("");
  }
  get conn(): TcpConnection {
    return this as unknown as TcpConnection;
  }
}

function drvServiceCtx(node = "node1") {
  const serial: string[] = [];
  return { serial, ctx: { node, onSerial: (line: string) => serial.push(line) } };
}

/** Let promise chains (writes, then end) run. */
async function drvFlush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

Deno.test("drivers tcp http: a request split across chunks gets one response naming node, method and path", async () => {
  const c = new DrvConn();
  const { serial, ctx } = drvServiceCtx();
  serveHttp(c.conn, ctx);
  c.send(drvText("GET /status HT"));
  assertEquals(c.written.length, 0, "head incomplete");
  c.send(drvText("TP/1.1\r\nHost: node1\r\n\r\n"));
  await drvFlush();
  const response = c.text();
  assert(response.startsWith("HTTP/1.1 200 OK\r\n"));
  assert(response.includes("Content-Length: 19\r\n"));
  assert(response.endsWith("\r\n\r\nnode1: GET /status\n"));
  assertEquals(serial, ["http GET /status from 192.168.4.20"]);
  assertEquals(c.ended, 1, "closed after the response");
  // Anything after the answer is ignored.
  c.send(drvText("GET /again HTTP/1.1\r\n\r\n"));
  await drvFlush();
  assertEquals(serial.length, 1);
  // The peer's FIN is answered with ours; no ws line for plain HTTP.
  c.peerEnd();
  assertEquals(c.ended, 2);
  assertEquals(serial.length, 1);
});

Deno.test("drivers tcp http: a body announced by Content-Length is awaited before answering", async () => {
  const c = new DrvConn();
  const { serial, ctx } = drvServiceCtx();
  serveHttp(c.conn, ctx);
  c.send(drvText("POST /led HTTP/1.1\r\nContent-Length: 5\r\nUpgrade: websocket\r\n\r\nab"));
  await drvFlush();
  assertEquals(
    c.written.length,
    0,
    "3 body bytes still missing; an upgrade without a key is plain HTTP",
  );
  c.send(drvText("cde"));
  await drvFlush();
  assert(c.text().endsWith("node1: POST /led\n"));
  assertEquals(serial, ["http POST /led from 192.168.4.20"]);
});

Deno.test("drivers tcp http: a head over 8 KiB without its end is refused", () => {
  const c = new DrvConn();
  const { serial, ctx } = drvServiceCtx();
  serveHttp(c.conn, ctx);
  c.send(drvText("GET /" + "a".repeat(8000)));
  assertEquals(c.aborted, []);
  c.send(drvText("b".repeat(500)));
  assertEquals(c.aborted, ["bad request"]);
  assertEquals(serial, []);
});

Deno.test("drivers tcp http: a failed write is swallowed, the connection is not ended", async () => {
  const c = new DrvConn();
  c.failWrites = true;
  const { serial, ctx } = drvServiceCtx();
  serveHttp(c.conn, ctx);
  c.send(drvText("GET / HTTP/1.1\r\n\r\n"));
  await drvFlush();
  assertEquals(serial, ["http GET / from 192.168.4.20"]);
  assertEquals(c.ended, 0);
});

async function drvUpgrade(c: DrvConn, extra: Uint8Array = new Uint8Array(0)): Promise<void> {
  c.send(drvBytes(
    drvText(
      "GET /ws HTTP/1.1\r\nHost: node1\r\nUpgrade: WebSocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
    ),
    extra,
  ));
  await drvUntil(() => c.written.length > 0, "the 101 response");
}

Deno.test("drivers tcp ws: the upgrade answers 101 with the accept key, then echoes text and binary", async () => {
  const c = new DrvConn();
  const { serial, ctx } = drvServiceCtx();
  serveHttp(c.conn, ctx);
  // A text frame in the same chunk as the request is echoed right after the 101.
  await drvUpgrade(c, drvMasked(0x1, drvText("early")));
  await drvUntil(() => c.written.length >= 2, "the echo of the early frame");
  const head = drvDecoder.decode(c.written[0]);
  assert(head.startsWith("HTTP/1.1 101 Switching Protocols\r\n"));
  assert(head.includes("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n"));
  assertEquals(c.written[1], websocketFrame(0x1, drvText("early")));
  c.send(drvMasked(0x2, Uint8Array.of(1, 2, 3)));
  assertEquals(c.written[2], websocketFrame(0x2, Uint8Array.of(1, 2, 3)));
  // A frame split in two is echoed once whole.
  const split = drvMasked(0x1, drvText("split"));
  c.send(split.subarray(0, 4));
  assertEquals(c.written.length, 3);
  c.send(split.subarray(4));
  assertEquals(c.written[3], websocketFrame(0x1, drvText("split")));
  // Ping gets pong with the same payload; continuation frames are dropped.
  c.send(drvMasked(0x9, drvText("p")));
  assertEquals(c.written[4], websocketFrame(0xa, drvText("p")));
  c.send(drvMasked(0x0, drvText("cont")));
  assertEquals(c.written.length, 5);
  assertEquals(serial, [
    "ws open /ws from 192.168.4.20",
    'ws rx "early" from 192.168.4.20',
    'ws rx "split" from 192.168.4.20',
  ]);
});

Deno.test("drivers tcp ws: a close frame is answered, logged once, and the peer's FIN adds no second line", async () => {
  const c = new DrvConn();
  const { serial, ctx } = drvServiceCtx();
  serveHttp(c.conn, ctx);
  await drvUpgrade(c);
  c.send(drvMasked(0x8, Uint8Array.of(0x03, 0xe8, 0x62, 0x79, 0x65)));
  await drvFlush();
  assertEquals(
    c.written.at(-1),
    websocketFrame(0x8, Uint8Array.of(0x03, 0xe8)),
    "status code only",
  );
  assertEquals(c.ended, 1);
  c.peerEnd();
  assertEquals(serial.filter((l) => l.startsWith("ws closed")), ["ws closed from 192.168.4.20"]);
});

Deno.test("drivers tcp ws: a peer that leaves without a close frame is logged as closed", async () => {
  const c = new DrvConn();
  const { serial, ctx } = drvServiceCtx();
  serveHttp(c.conn, ctx);
  await drvUpgrade(c);
  c.peerEnd();
  assertEquals(serial, ["ws open /ws from 192.168.4.20", "ws closed from 192.168.4.20"]);
  assertEquals(c.ended, 1);
});

Deno.test("drivers tcp ws: write failures after the upgrade are swallowed", async () => {
  const c = new DrvConn();
  const { serial, ctx } = drvServiceCtx();
  serveHttp(c.conn, ctx);
  c.failWrites = true;
  c.send(drvText("GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nSec-WebSocket-Key: a2V5\r\n\r\n"));
  c.send(drvMasked(0x1, drvText("t")));
  c.send(drvMasked(0x9, drvText("p")));
  c.send(drvMasked(0x8, new Uint8Array(0)));
  await websocketAccept("a2V5");
  await drvFlush();
  assertEquals(c.written.length, 0);
  assertEquals(c.ended, 0);
  assertEquals(serial[0], "ws open /ws from 192.168.4.20");
  assert(serial.includes('ws rx "t" from 192.168.4.20'));
});

function drvMqttString(s: string): number[] {
  const b = drvText(s);
  return [b.length >> 8, b.length & 0xff, ...b];
}

function drvMqttConnect(clientId: string, level = 4, protocol = "MQTT"): Uint8Array {
  return mqttPacket(1, 0, [
    ...drvMqttString(protocol),
    level,
    0x02,
    0,
    60,
    ...drvMqttString(clientId),
  ]);
}

Deno.test("drivers tcp mqtt: connect, subscribe, publish fan-out, QoS 1 ack, ping and disconnect", async () => {
  const { serial, ctx } = drvServiceCtx();
  const broker = new MqttBroker(ctx);
  const sub = new DrvConn();
  const pub = new DrvConn();
  broker.serve(sub.conn);
  broker.serve(pub.conn);
  sub.send(drvMqttConnect("sub"));
  pub.send(drvMqttConnect(""));
  await drvFlush();
  assertEquals(sub.written[0], Uint8Array.of(0x20, 2, 0, 0));
  assertEquals(pub.written[0], Uint8Array.of(0x20, 2, 0, 0));
  // Two filters in one SUBSCRIBE, sent in two chunks.
  const subscribe = mqttPacket(8, 2, [
    0,
    5,
    ...drvMqttString("room/+"),
    1,
    ...drvMqttString("x/#"),
    0,
  ]);
  sub.send(subscribe.subarray(0, 3));
  sub.send(subscribe.subarray(3));
  await drvFlush();
  assertEquals(sub.written[1], Uint8Array.of(0x90, 4, 0, 5, 0, 0));
  // QoS 1 publish: PUBACK with the packet id, delivered at QoS 0.
  pub.send(mqttPacket(3, 2, [...drvMqttString("room/1"), 0x12, 0x34, ...drvText("21C")]));
  await drvFlush();
  assertEquals(pub.written[1], Uint8Array.of(0x40, 2, 0x12, 0x34));
  assertEquals(sub.written[2], mqttPublish("room/1", drvText("21C")));
  // A topic nobody subscribed to reaches nobody.
  pub.send(mqttPublish("hall/1", drvText("x")));
  await drvFlush();
  assertEquals(sub.written.length, 3);
  // Unsubscribe, then the same topic is no longer delivered.
  sub.send(mqttPacket(10, 2, [0, 6, ...drvMqttString("room/+")]));
  await drvFlush();
  assertEquals(sub.written[3], Uint8Array.of(0xb0, 2, 0, 6));
  pub.send(mqttPublish("room/2", drvText("y")));
  await drvFlush();
  assertEquals(sub.written.length, 4);
  pub.send(mqttPacket(12, 0, []));
  await drvFlush();
  assertEquals(pub.written.at(-1), Uint8Array.of(0xd0, 0));
  pub.send(mqttPacket(14, 0, []));
  assertEquals(pub.ended, 1);
  // Unknown packet types are ignored.
  pub.send(mqttPacket(15, 0, []));
  assertEquals(serial, [
    "mqtt connect sub from 192.168.4.20",
    "mqtt connect client-50123 from 192.168.4.20",
    "mqtt subscribe room/+ from sub",
    "mqtt subscribe x/# from sub",
    'mqtt publish room/1 "21C" from client-50123',
    'mqtt publish hall/1 "x" from client-50123',
    'mqtt publish room/2 "y" from client-50123',
  ]);
  // A closed session is forgotten: it gets nothing more.
  sub.send(mqttPacket(8, 2, [0, 7, ...drvMqttString("#"), 0]));
  await drvFlush();
  const count = sub.written.length;
  sub.close();
  pub.send(mqttPublish("any", drvText("z")));
  await drvFlush();
  assertEquals(sub.written.length, count);
  sub.peerEnd();
  assertEquals(sub.ended, 1);
});

Deno.test("drivers tcp mqtt: anything before CONNECT aborts; a wrong protocol is refused with code 1", async () => {
  const { serial, ctx } = drvServiceCtx();
  const broker = new MqttBroker(ctx);
  const early = new DrvConn();
  broker.serve(early.conn);
  early.send(drvBytes(mqttPacket(12, 0, []), drvMqttConnect("late")));
  assertEquals(early.aborted, ["MQTT without CONNECT"]);
  assertEquals(early.written, [], "the CONNECT after it is not read");

  for (const [protocol, level] of [["MQTT", 3], ["MQIsdp", 4]] as const) {
    const old = new DrvConn();
    broker.serve(old.conn);
    old.send(drvMqttConnect("c", level, protocol));
    await drvFlush();
    assertEquals(old.written, [Uint8Array.of(0x20, 2, 0, 1)], `${protocol} level ${level}`);
    assertEquals(old.ended, 1);
    // Still not connected: the next packet aborts.
    old.send(mqttPacket(12, 0, []));
    assertEquals(old.aborted, ["MQTT without CONNECT"]);
  }
  assertEquals(serial, []);
});

Deno.test("drivers tcp mqtt: a remaining length over four bytes aborts the connection", () => {
  const { ctx } = drvServiceCtx();
  const broker = new MqttBroker(ctx);
  const conn = new DrvConn();
  broker.serve(conn.conn);
  conn.send(drvMqttConnect("c"));
  conn.send(Uint8Array.of(0x30, 0xff, 0xff, 0xff, 0xff, 0x01));
  assertEquals(conn.aborted, ["malformed MQTT packet"]);
});

Deno.test("drivers tcp mqtt: write failures toward a client are swallowed", async () => {
  const { serial, ctx } = drvServiceCtx();
  const broker = new MqttBroker(ctx);
  const sub = new DrvConn();
  broker.serve(sub.conn);
  sub.send(drvMqttConnect("s"));
  sub.send(mqttPacket(8, 2, [0, 1, ...drvMqttString("t"), 0]));
  sub.failWrites = true;
  sub.send(mqttPublish("t", drvText("v")));
  await drvFlush();
  assertEquals(serial.at(-1), 'mqtt publish t "v" from s');
});

// ── tcp-services.ts: over the engine's TCP ──────────────────────────────────

function drvTcpPair() {
  const clock = new ManualClock();
  const A = { mac: "02:68:7a:62:01:01", ip: "192.168.4.11" };
  const B = { mac: "02:68:7a:62:01:02", ip: "192.168.4.12" };
  const macs = new Map([[A.ip, A.mac], [B.ip, B.mac]]);
  const hosts: TcpHost[] = [];
  const make = (me: typeof A, other: () => TcpHost) =>
    new TcpHost({
      ...me,
      clock,
      send: (frame) => queueMicrotask(() => void other().receive(frame)),
      macFor: (ip) => macs.get(ip) ?? null,
      rng: substream(7, `tcp:${me.ip}`),
    });
  const a = make(A, () => hosts[1] as TcpHost);
  const b = make(B, () => hosts[0] as TcpHost);
  hosts.push(a, b);
  return { clock, a, b, A, B };
}

function drvCollect(conn: TcpConnection) {
  const chunks: Uint8Array[] = [];
  const seen = { ended: false, closed: false };
  conn.onData((bytes) => chunks.push(bytes));
  conn.onEnd(() => (seen.ended = true));
  conn.onClose(() => (seen.closed = true));
  return { seen, bytes: () => drvBytes(...chunks) };
}

Deno.test("drivers tcp: over two TcpHosts, an HTTP GET and a WebSocket echo cross the engine's TCP", async () => {
  const { a, b, B } = drvTcpPair();
  const { serial, ctx } = drvServiceCtx("board-b");
  b.listen(80, (conn) => serveHttp(conn, ctx));
  try {
    const http = await a.connect(B.ip, 80);
    const got = drvCollect(http);
    await http.write(drvText("GET /hello HTTP/1.1\r\nHost: b\r\n\r\n"));
    await drvUntil(() => got.seen.ended, "the HTTP response and FIN");
    assert(drvDecoder.decode(got.bytes()).endsWith("board-b: GET /hello\n"));
    http.end();
    await drvUntil(() => got.seen.closed, "the HTTP connection to close");

    const ws = await a.connect(B.ip, 80);
    const wsGot = drvCollect(ws);
    await ws.write(drvText(
      "GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    ));
    await drvUntil(() => drvDecoder.decode(wsGot.bytes()).includes("\r\n\r\n"), "the 101");
    await ws.write(drvMasked(0x1, drvText("over tcp")));
    const expected = websocketFrame(0x1, drvText("over tcp"));
    const headLength = () => drvDecoder.decode(wsGot.bytes()).indexOf("\r\n\r\n") + 4;
    await drvUntil(() => wsGot.bytes().length >= headLength() + expected.length, "the echo");
    const all = wsGot.bytes();
    assertEquals(all.subarray(headLength(), headLength() + expected.length), expected);
    assertEquals(serial, [
      "http GET /hello from 192.168.4.11",
      "ws open /ws from 192.168.4.11",
      'ws rx "over tcp" from 192.168.4.11',
    ]);
  } finally {
    a.close();
    b.close();
    await drvFlush();
  }
});

// ── scripted-radio.ts ───────────────────────────────────────────────────────

/** A SpiLinkClient stand-in that reaches an in-process chip model. */
class DrvSpiClient {
  readonly device: SpiDevice;
  failTransfers = false;
  closed = false;
  #drive: (gpio: number, level: Level) => void = () => {};

  constructor(device: SpiDevice) {
    this.device = device;
  }
  onDrive(handler: (gpio: number, level: Level) => void): void {
    this.#drive = handler;
  }
  drive(gpio: number, level: Level): void {
    this.#drive(gpio, level);
  }
  digitalWrite(gpio: number, level: Level): Promise<void> {
    this.device.pinChanged(gpio, level);
    return Promise.resolve();
  }
  transfer(mosi: number): Promise<number> {
    if (this.failTransfers) return Promise.reject(new Error("link down"));
    return Promise.resolve(this.device.transfer(mosi));
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  get client(): SpiLinkClient {
    return this as unknown as SpiLinkClient;
  }
}

const DRV_LORA_RADIO: LoraRadio = {
  phy: "lora",
  frequencyHz: 868.1e6,
  sf: 7,
  bandwidthHz: 125e3,
  codingRate: 5,
  syncWord: 0x12,
  preambleLength: 8,
  crc: true,
  txPowerDbm: 14,
  antennaGainDbi: 0,
  pins: { cs: 5, reset: 14, dio0: 26 },
};

const DRV_NRF24_RADIO: Nrf24Radio = {
  phy: "nrf24",
  channel: 90,
  dataRate: 1_000_000,
  txPowerDbm: 0,
  antennaGainDbi: 0,
  autoAck: true,
  retries: 5,
  retryDelayUs: 500,
  pins: { csn: 5, ce: 4, irq: null },
};

function drvSend(
  to: string | null,
  payload: string,
  extra: Partial<ScriptedSend> = {},
): ScriptedSend {
  return { to, via: "udp", everyMs: 100, count: 1, startMs: 10, port: 0, payload, ...extra };
}

function drvNode(
  id: string,
  radio: NodeRadio,
  script: { send?: ScriptedSend[]; listen?: boolean; ble?: BleScript | null } | null,
  index = 1,
): ScenarioNode {
  return {
    id,
    board: "scripted",
    firmware: script
      ? {
        kind: "script",
        send: script.send ?? [],
        serve: [],
        listen: script.listen ?? false,
        ble: script.ble ?? null,
      }
      : { kind: "sketch", path: "fw/sketch.ino" },
    position: { x: index * 10, y: 0 },
    radio,
    ip: `192.168.4.${10 + index}`,
    mac: `02:68:7a:62:01:0${index}`,
    internetGateway: false,
  };
}

function drvBoardCtx(
  node: ScenarioNode,
  clock: ManualClock,
  peers: PeerInfo[] = [],
  nodeIndex = 1,
) {
  const serial: string[] = [];
  const problems: string[] = [];
  const ctx: BoardContext = {
    node,
    nodeIndex,
    netPort: null,
    peers,
    gateway: { ip: "192.168.4.1", mac: "02:68:7a:62:00:01", subnetMask: "255.255.255.0" },
    clock,
    outDir: "/nonexistent/scripted-board-out",
    onSerial: (line) => serial.push(line),
    onProblem: (message) => problems.push(message),
  };
  return { ctx, serial, problems };
}

function drvPeer(id: string, index: number): PeerInfo {
  return { id, index, ip: `192.168.4.${10 + index}`, mac: `02:68:7a:62:01:0${index}` };
}

function drvRadioAir(seed = 9) {
  const clock = new ManualClock();
  const log = new EventLog();
  const air = new AirMedium({
    seed,
    clock,
    log,
    environment: environmentFromPreset("free_space", { shadowingSigmaDb: 0 }),
  });
  return { clock, log, air };
}

Deno.test("drivers scripted-radio: a Wi-Fi radio is refused, and stop() closes the link", async () => {
  const clock = new ManualClock();
  const fake = new DrvSpiClient(new DrvLoraRegs());
  const { ctx, problems, serial } = drvBoardCtx(
    drvNode("w", { phy: "wifi", channel: 6, txPowerDbm: 15, antennaGainDbi: 0 }, {}),
    clock,
  );
  const board = new ScriptedRadioBoard(ctx, fake.client);
  assertEquals(problems, ["w: a scripted radio board needs a LoRa or nRF24 radio"]);
  assert(board.clockDescription.includes("scripted"));
  await board.stop();
  assert(fake.closed);
  assertEquals(serial, []);
});

Deno.test("drivers scripted-radio: LoRa boards send, receive over the air and print what the sketch prints", async () => {
  const { clock, air } = drvRadioAir();
  const boards: ScriptedRadioBoard[] = [];
  const make = (id: string, index: number, script: { send?: ScriptedSend[]; listen?: boolean }) => {
    let fake: DrvSpiClient | null = null;
    const chip = new Sx127x({
      pins: DRV_LORA_RADIO.pins,
      clock,
      transmit: (frame) => air.transmit(id, frame),
      drivePin: (gpio, level) => fake?.drive(gpio, level),
      rng: substream(9, `sx127x:${id}`),
      warn: () => {},
    });
    air.addNode({ id, position: { x: index * 50, y: 0 }, antennaGainDbi: 0 }, chip);
    fake = new DrvSpiClient(chip);
    const radio = { ...DRV_LORA_RADIO, crc: index === 1 };
    const rig = drvBoardCtx(drvNode(id, radio, script, index), clock, [], index);
    boards.push(new ScriptedRadioBoard(rig.ctx, fake.client));
    return { ...rig, fake };
  };
  // The sender also listens, so it goes back to receive after each packet.
  const tx = make("tx", 1, { send: [drvSend(null, "hello", { count: 2 })], listen: true });
  const gw = make("gw", 2, { listen: true });
  try {
    await drvPump(clock, 1000, () => gw.serial.filter((l) => l.startsWith("rx ")).length >= 2);
    assertEquals(tx.serial[0], "radio ready lora 868.1 MHz SF7");
    assertEquals(tx.serial.filter((l) => l.startsWith("tx ")), [
      "tx hello:0 from tx",
      "tx hello:1 from tx",
    ]);
    const rx = gw.serial.filter((l) => l.startsWith("rx "));
    assertEquals(rx.length, 2);
    assert(rx[0]?.startsWith('rx "hello:0 from tx" rssi=-'), rx[0]);
    assert(rx[0]?.includes(" snr="));
    // A DIO0 rise with nothing received, or on another pin, prints nothing.
    gw.fake.drive(26, 1);
    gw.fake.drive(26, 0);
    gw.fake.drive(27, 1);
    await drvPump(clock, 5);
    assertEquals(gw.serial.filter((l) => l.startsWith("rx ")).length, 2);
    assertEquals([...tx.problems, ...gw.problems], []);
  } finally {
    for (const board of boards) await board.stop();
  }
});

Deno.test("drivers scripted-radio: LoRa begin() failing, a busy transmitter and a dropped link are reported or skipped", async () => {
  const clock = new ManualClock();
  // Version register 0: begin() fails and nothing else happens.
  const dead = new DrvLoraRegs();
  dead.regs[0x42] = 0;
  const a = drvBoardCtx(drvNode("a", DRV_LORA_RADIO, { send: [drvSend(null, "x")] }), clock);
  const boardA = new ScriptedRadioBoard(a.ctx, new DrvSpiClient(dead).client);
  // OP_MODE always reads TX: beginPacket() refuses, so no tx line.
  const busy = new DrvLoraRegs();
  busy.overrides.set(0x01, () => 0x83);
  const b = drvBoardCtx(drvNode("b", DRV_LORA_RADIO, { send: [drvSend(null, "y")] }), clock);
  const boardB = new ScriptedRadioBoard(b.ctx, new DrvSpiClient(busy).client);
  // The link fails on the first transfer.
  const broken = new DrvSpiClient(new DrvLoraRegs());
  broken.failTransfers = true;
  const c = drvBoardCtx(drvNode("c", DRV_LORA_RADIO, {}), clock);
  const boardC = new ScriptedRadioBoard(c.ctx, broken.client);
  try {
    await drvPump(
      clock,
      200,
      () => b.serial.length > 0 && a.problems.length > 0 && c.problems.length > 0,
    );
    await drvPump(clock, 50);
    assertEquals(a.problems, ["a: LoRa.begin() failed: the chip did not answer 0x12"]);
    assertEquals(a.serial, []);
    assertEquals(b.serial, ["radio ready lora 868.1 MHz SF7"], "no tx line while the chip is busy");
    assertEquals(b.problems, []);
    assertEquals(c.problems, ["c: scripted driver failed: Error: link down"]);
  } finally {
    await boardA.stop();
    await boardB.stop();
    await boardC.stop();
  }
});

Deno.test("drivers scripted-radio: a board stopped before setup runs nothing, and later DIO0 rises are ignored", async () => {
  const clock = new ManualClock();
  const chip = new DrvLoraRegs();
  const fake = new DrvSpiClient(chip);
  const { ctx, serial, problems } = drvBoardCtx(
    drvNode("s", DRV_LORA_RADIO, { listen: true }),
    clock,
  );
  const board = new ScriptedRadioBoard(ctx, fake.client);
  await board.stop();
  assertEquals(chip.writes.length + chip.reads.length, 0, "setup never ran");
  fake.drive(26, 1);
  await drvPump(clock, 5);
  assertEquals([serial, problems], [[], []]);

  // Stopped while a delay is pending: the delay resolves, and the bus refuses further calls quietly.
  const chip2 = new DrvLoraRegs();
  const fake2 = new DrvSpiClient(chip2);
  const rig2 = drvBoardCtx(drvNode("t", DRV_LORA_RADIO, { listen: true }), clock);
  const board2 = new ScriptedRadioBoard(rig2.ctx, fake2.client);
  await drvUntil(() => chip2.pins.some(([g, l]) => g === 14 && l === 0), "the reset pulse");
  await board2.stop();
  assertEquals(rig2.problems, [], "a stop mid-setup is not a problem");
  assertEquals(rig2.serial, []);
  assertFalse(chip2.reads.includes(0x42), "the version was never read");
});

Deno.test("drivers scripted-radio: nRF24 boards send to a peer's address and the listener reads it on pipe 1", async () => {
  const { clock, air } = drvRadioAir(13);
  const boards: ScriptedRadioBoard[] = [];
  const peers = [drvPeer("tx", 1), drvPeer("gw", 2)];
  const make = (id: string, index: number, script: { send?: ScriptedSend[]; listen?: boolean }) => {
    const chip = new Nrf24l01({
      pins: { csn: 5, ce: 4, irq: 26 },
      clock,
      transmit: (frame) => air.transmit(id, frame),
      drivePin: () => {},
      warn: () => {},
    });
    air.addNode({ id, position: { x: index * 10, y: 0 }, antennaGainDbi: 0 }, chip);
    const rig = drvBoardCtx(
      drvNode(id, DRV_NRF24_RADIO, script, index),
      clock,
      peers.filter((p) => p.id !== id),
      index,
    );
    boards.push(new ScriptedRadioBoard(rig.ctx, new DrvSpiClient(chip).client));
    return rig;
  };
  const tx = make("tx", 1, {
    send: [drvSend("gw", "ping"), drvSend("ghost", "lost", { startMs: 20 })],
    listen: true,
  });
  const gw = make("gw", 2, { listen: true });
  try {
    await drvPump(clock, 300, () => gw.serial.some((l) => l.startsWith("rx ")));
    await drvPump(clock, 30);
    assertEquals(
      tx.serial,
      ["radio ready nrf24 ch 90", "tx ping:0 from tx ok"],
      "nothing sent to ghost",
    );
    assertEquals(gw.serial, ["radio ready nrf24 ch 90", 'rx "ping:0 from tx" pipe=1']);
    assertEquals([...tx.problems, ...gw.problems], []);
  } finally {
    for (const board of boards) await board.stop();
  }
});

Deno.test("drivers scripted-radio: nRF24 begin() failing is reported; 250 kbps and 2 Mbps rates are set", async () => {
  const clock = new ManualClock();
  const dead = new DrvRf24Regs();
  dead.readHooks.set(0x00, () => 0);
  const a = drvBoardCtx(drvNode("a", DRV_NRF24_RADIO, { send: [drvSend("b", "x")] }), clock);
  const boardA = new ScriptedRadioBoard(a.ctx, new DrvSpiClient(dead).client);
  const slow = new DrvRf24Regs();
  const b = drvBoardCtx(drvNode("b", { ...DRV_NRF24_RADIO, dataRate: 250_000 }, {}), clock);
  const boardB = new ScriptedRadioBoard(b.ctx, new DrvSpiClient(slow).client);
  const fast = new DrvRf24Regs();
  const c = drvBoardCtx(
    drvNode("c", { ...DRV_NRF24_RADIO, dataRate: 2_000_000, txPowerDbm: -18 }, null),
    clock,
  );
  const boardC = new ScriptedRadioBoard(c.ctx, new DrvSpiClient(fast).client);
  try {
    await drvPump(
      clock,
      100,
      () => a.problems.length > 0 && b.serial.length > 0 && c.serial.length > 0,
    );
    assertEquals(a.problems, ["a: RF24 begin() failed: CONFIG did not read back"]);
    assertEquals(b.serial, ["radio ready nrf24 ch 90"]);
    assertEquals((slow.regs[0x06] ?? 0) & 0x28, 0x20, "250 kbps");
    assertEquals((slow.regs[0x06] ?? 0) & 0x06, 0x06, "0 dBm");
    assertEquals(slow.regs[0x04], 0x15, "ARD 500 us, 5 retries");
    assertEquals((fast.regs[0x06] ?? 0) & 0x28, 0x08, "2 Mbps");
    assertEquals((fast.regs[0x06] ?? 0) & 0x06, 0, "-18 dBm");
    assertEquals((fast.regs[0x00] ?? 0) & 0x01, 0, "a sketch firmware does not listen");
  } finally {
    await boardA.stop();
    await boardB.stop();
    await boardC.stop();
  }
});

Deno.test("drivers scripted-radio: startScriptedRadioBoard speaks spi-link to the adapter, and a closed link is a problem", async () => {
  const clock = new ManualClock();
  const adapter = new SpiLinkAdapter();
  const attachment = adapter.listen("n1", (drive) =>
    new Sx127x({
      pins: DRV_LORA_RADIO.pins,
      clock,
      transmit: () => {},
      drivePin: drive,
      rng: substream(1, "sx127x:n1"),
      warn: () => {},
    }));
  const { ctx, serial, problems } = drvBoardCtx(
    drvNode("n1", DRV_LORA_RADIO, { send: [drvSend(null, "late", { startMs: 50 })] }),
    clock,
  );
  const board = await startScriptedRadioBoard(ctx, attachment.port);
  try {
    await drvUntil(() => {
      if (clock.nextDueMs() !== null) clock.advanceBy(1);
      return serial.length > 0 || problems.length > 0;
    }, "the board's setup over the socket");
    assertEquals(serial, ["radio ready lora 868.1 MHz SF7"]);
    assertEquals(attachment.device.mode, 1, "standby, as begin() leaves it");
    await adapter.close();
    clock.advanceBy(60);
    await drvUntil(() => problems.length > 0, "the failed send");
    assertEquals(problems.length, 1);
    // "spi-link connection closed" or the socket's own error, depending on which side notices first.
    assert(problems[0]?.startsWith("n1: scripted driver failed: "), problems[0]);
  } finally {
    await board.stop();
    await adapter.close();
  }
});

// ── scripted-ble.ts ─────────────────────────────────────────────────────────

const DRV_BLE_RADIO: NodeRadio = { phy: "ble", txPowerDbm: 0, antennaGainDbi: 0, hciUart: 1 };

/** A fake controller on a loopback port: answers every command, records commands and ACL, injects events. */
class DrvHciServer {
  readonly listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  readonly commands: { op: number; params: Uint8Array }[] = [];
  readonly acl: { handle: number; pdu: Uint8Array }[] = [];
  reply: (op: number) => Uint8Array | null = drvDefaultReply;
  conn: Deno.TcpConn | null = null;
  readonly #loop: Promise<void>;

  constructor() {
    this.#loop = this.#run();
  }

  get port(): number {
    return (this.listener.addr as Deno.NetAddr).port;
  }

  ops(): number[] {
    return this.commands.map((c) => c.op);
  }

  async #run(): Promise<void> {
    try {
      const conn = await this.listener.accept();
      this.conn = conn;
      const decoder = new H4Decoder();
      const buffer = new Uint8Array(4096);
      for (;;) {
        const n = await conn.read(buffer);
        if (n === null) break;
        for (const packet of decoder.push(buffer.slice(0, n))) {
          if (packet.type === "command") {
            this.commands.push({ op: packet.opcode, params: packet.params });
            const answer = this.reply(packet.opcode);
            if (answer) await this.send(answer);
          } else if (packet.type === "acl") {
            this.acl.push({ handle: packet.handle, pdu: packet.data.slice(4) });
            // Give the buffer back, as a controller does once the packet is on the air.
            await this.send(
              drvEvent(EVT.numberOfCompletedPackets, [1, ...drvU16(packet.handle), ...drvU16(1)]),
            );
          }
        }
      }
    } catch {
      // Closed by close().
    }
  }

  async send(bytes: Uint8Array): Promise<void> {
    const conn = this.conn;
    if (!conn) throw new Error("no board connected");
    let written = 0;
    while (written < bytes.length) written += await conn.write(bytes.subarray(written));
  }

  /** Close the board's connection from this side, keeping the listener. */
  hangUp(): void {
    try {
      this.conn?.close();
    } catch {
      // Already closed.
    }
  }

  /** Send FIN: the board reads end of stream. */
  async finish(): Promise<void> {
    await this.conn?.closeWrite();
  }

  async close(): Promise<void> {
    try {
      this.listener.close();
    } catch {
      // Already closed.
    }
    this.hangUp();
    await this.#loop;
  }
}

const DRV_PHONE = drvPeer("phone", 2);
const DRV_WATCH = drvPeer("watch", 3);

Deno.test("drivers scripted-ble: a peripheral advertises, logs scans, serves GATT writes and reads, and notifies", async () => {
  const server = new DrvHciServer();
  const clock = new ManualClock();
  const { ctx, serial, problems } = drvBoardCtx(
    drvNode("sensor", DRV_BLE_RADIO, {
      // A third send, due at 300 ms, is still pending when the board stops.
      send: [drvSend("phone", "t", { via: "gatt", count: 3, startMs: 100, everyMs: 100 })],
      ble: { advertise: { name: "sensor-1", intervalMs: 100 }, connect: null, scan: true },
    }),
    clock,
    [DRV_PHONE, DRV_WATCH],
  );
  const board = await startScriptedBleBoard(ctx, server.port);
  try {
    await drvUntil(() => serial.includes("ble advertising as sensor-1"), "advertising");
    assertEquals(serial.slice(0, 2), [
      `ble ready addr=${DRV_HCI_ADDRESS}`,
      "ble advertising as sensor-1",
    ]);
    assertEquals(server.ops(), [
      OP.reset,
      OP.setEventMask,
      OP.leSetEventMask,
      OP.leReadBufferSize,
      OP.readBdAddr,
      OP.leSetScanParams,
      OP.leSetScanEnable,
      OP.leSetAdvParams,
      OP.leSetAdvData,
      OP.leSetAdvEnable,
    ]);
    // Scan reports: named ones are printed with the node id, or the address for a stranger.
    await server.send(drvAdvReport(DRV_PHONE.mac, [6, 0x09, ...drvText("phone")], -61));
    await server.send(drvAdvReport(DRV_WATCH.mac, [2, 0x01, 0x06], -50));
    await server.send(drvAdvReport("02:68:7a:62:01:0a", [4, 0x08, ...drvText("abc")], -90));
    await drvUntil(
      () => serial.filter((l) => l.startsWith('ble adv "')).length === 2,
      () => `two adv lines, serial: ${JSON.stringify(serial)}`,
    );
    assertEquals(serial.filter((l) => l.startsWith('ble adv "')), [
      'ble adv "phone" from phone rssi=-61',
      'ble adv "abc" from 02:68:7a:62:01:0a rssi=-90',
    ]);
    // The first send is due before anyone connected.
    clock.advanceBy(100);
    assert(serial.includes("ble tx t:0 to phone skipped: not connected"));

    await server.send(drvConnectionComplete(0x40, 1, DRV_PHONE.mac));
    await drvUntil(() => serial.includes("ble connected to phone as peripheral"), "the connection");
    // A Write Request on the value handle is printed and acknowledged; a read returns it.
    await server.send(
      drvAclAtt(0x40, [ATT.writeReq, SCRIPTED_ATT_HANDLE, 0, ...drvText("led=on")]),
    );
    await drvUntil(() => server.acl.length === 1, "the write response");
    assertEquals(server.acl[0]?.pdu, Uint8Array.of(ATT.writeRsp));
    assert(serial.includes('ble rx "led=on" from phone'));
    await server.send(drvAclAtt(0x40, [ATT.readReq, SCRIPTED_ATT_HANDLE, 0]));
    await drvUntil(() => server.acl.length === 2, "the read response");
    assertEquals(server.acl[1]?.pdu, drvBytes([ATT.readRsp], drvText("led=on")));
    // A write on another handle (the CCCD) is not a serial line; a Write Command needs no answer.
    await server.send(drvAclAtt(0x40, [ATT.writeReq, 0x11, 0, 1, 0]));
    await server.send(drvAclAtt(0x40, [ATT.writeCmd, SCRIPTED_ATT_HANDLE, 0, ...drvText("cmd")]));
    await drvUntil(() => serial.includes('ble rx "cmd" from phone'), "the write command");
    await drvUntil(() => server.acl.length === 3, "the CCCD write response");
    assertEquals(server.acl[2]?.pdu, Uint8Array.of(ATT.writeRsp));

    // The second send goes out as a notification on 0x0010, and the value is readable.
    clock.advanceBy(100);
    assert(serial.includes("ble tx t:1 to phone"));
    await drvUntil(() => server.acl.length === 4, "the notification");
    assertEquals(server.acl[3]?.pdu, drvBytes([ATT.notify, 0x10, 0x00], drvText("t:1")));

    // The central leaves: the peripheral advertises again.
    const before = server.commands.length;
    await server.send(drvEvent(EVT.disconnectionComplete, [0, ...drvU16(0x40), 0x13]));
    await drvUntil(() => server.commands.length >= before + 3, "advertising again");
    assertEquals(server.ops().slice(before), [
      OP.leSetAdvParams,
      OP.leSetAdvData,
      OP.leSetAdvEnable,
    ]);
    assert(serial.includes("ble disconnected from phone reason=0x13"));
    assertEquals(problems, []);
    await board.stop();
    clock.advanceBy(500);
    assertFalse(serial.some((l) => l.includes("t:2")), "stop() cancels the pending send");
  } finally {
    await board.stop();
    await server.close();
  }
});

Deno.test("drivers scripted-ble: a central connects through the accept list, re-initiates, and answers ATT", async () => {
  const server = new DrvHciServer();
  let cancelStatus: number = STATUS.unknownConnection;
  server.reply = (op) =>
    op === OP.leCreateConnectionCancel ? drvCommandComplete(op, cancelStatus) : drvDefaultReply(op);
  const clock = new ManualClock();
  const { ctx, serial, problems } = drvBoardCtx(
    drvNode("hub", DRV_BLE_RADIO, {
      send: [drvSend("phone", "w", { via: "gatt", startMs: 50 })],
      ble: {
        advertise: null,
        connect: { peers: ["phone", "watch"], intervalMs: 30, timeoutMs: 1000 },
        scan: false,
      },
    }),
    clock,
    [DRV_PHONE, DRV_WATCH],
  );
  const board = await startScriptedBleBoard(ctx, server.port);
  try {
    await drvUntil(
      () => server.ops().includes(OP.leCreateConnection),
      "the first Create Connection",
    );
    assertEquals(server.ops().slice(5), [
      OP.leClearAcceptList,
      OP.leAddToAcceptList,
      OP.leAddToAcceptList,
      OP.leCreateConnection,
    ]);
    assertEquals(server.commands[6]?.params.subarray(1), addressToBytes(DRV_PHONE.mac));
    assertEquals(server.commands[7]?.params.subarray(1), addressToBytes(DRV_WATCH.mac));
    // A failed connection attempt prints nothing.
    await server.send(
      drvConnectionComplete(0, 0, DRV_PHONE.mac, STATUS.connectionFailedToEstablish),
    );
    // phone connects: the board starts over for watch alone.
    const before = server.commands.length;
    await server.send(drvConnectionComplete(0x40, 0, DRV_PHONE.mac));
    await drvUntil(() => server.commands.length >= before + 3, "initiating for watch");
    assertEquals(server.ops().slice(before), [
      OP.leClearAcceptList,
      OP.leAddToAcceptList,
      OP.leCreateConnection,
    ]);
    assertEquals(server.commands[before + 1]?.params.subarray(1), addressToBytes(DRV_WATCH.mac));
    assertEquals(serial.filter((l) => l.startsWith("ble connected")), [
      "ble connected to phone as central",
    ]);

    // ATT from the peripheral: notify and indicate are printed, the indication confirmed;
    // a request is refused; a response and a write command on an unknown handle are handled too.
    await server.send(drvAclAtt(0x40, [ATT.notify, 0x10, 0, ...drvText("n1")]));
    await server.send(drvAclAtt(0x40, [ATT.indicate, 0x10, 0, ...drvText("i1")]));
    await server.send(drvAclAtt(0x40, [ATT.readReq, 0x10, 0]));
    await server.send(drvAclAtt(0x40, [ATT.readRsp, 1]));
    await server.send(drvAclAtt(0x77, [ATT.writeCmd, 0x10, 0, ...drvText("c")]));
    await drvUntil(() => server.acl.length === 2, "the confirm and the error");
    assertEquals(server.acl[0]?.pdu, Uint8Array.of(ATT.confirm));
    assertEquals(server.acl[1]?.pdu, Uint8Array.of(ATT.errorRsp, ATT.readReq, 0, 0, 0x06));
    await drvUntil(() => serial.includes('ble rx "c" from handle 119'), "the write command line");
    assert(serial.includes('ble rx "n1" from phone'));
    assert(serial.includes('ble rx "i1" from phone'));

    // The send goes out as a Write Command.
    clock.advanceBy(50);
    assert(serial.includes("ble tx w:0 to phone"));
    await drvUntil(() => server.acl.length === 3, "the write command");
    assertEquals(server.acl[2]?.pdu, drvBytes([ATT.writeCmd, 0x10, 0], drvText("w:0")));

    // phone drops while initiating for watch: the cancel fails, so the board keeps waiting.
    let mark = server.commands.length;
    await server.send(drvEvent(EVT.disconnectionComplete, [0, ...drvU16(0x40), 0x08]));
    await drvUntil(
      () => server.ops().slice(mark).includes(OP.leCreateConnectionCancel),
      "the cancel",
    );
    await drvUntil(() => serial.includes("ble disconnected from phone reason=0x08"), "the line");
    // An unknown handle drops: the cancel works this time, and both peers are wanted again.
    cancelStatus = STATUS.success;
    mark = server.commands.length;
    await server.send(drvEvent(EVT.disconnectionComplete, [0, ...drvU16(0x99), 0x16]));
    await drvUntil(
      () => server.ops().slice(mark).includes(OP.leCreateConnection),
      "the new attempt",
    );
    assertEquals(server.ops().slice(mark), [
      OP.leCreateConnectionCancel,
      OP.leClearAcceptList,
      OP.leAddToAcceptList,
      OP.leAddToAcceptList,
      OP.leCreateConnection,
    ]);
    assert(serial.includes("ble disconnected from handle 153 reason=0x16"));
    assertEquals(problems, []);
  } finally {
    await board.stop();
    await server.close();
  }
});

Deno.test("drivers scripted-ble: a failing Reset is a problem; a board without a BLE script only comes up", async () => {
  const failing = new DrvHciServer();
  failing.reply = (op) => drvCommandComplete(op, STATUS.unknownCommand);
  const clock = new ManualClock();
  const a = drvBoardCtx(drvNode("a", DRV_BLE_RADIO, {}), clock);
  const boardA = await startScriptedBleBoard(a.ctx, failing.port);
  const plain = new DrvHciServer();
  const b = drvBoardCtx(drvNode("b", DRV_BLE_RADIO, null), clock, [DRV_PHONE]);
  const boardB = await startScriptedBleBoard(b.ctx, plain.port);
  try {
    await drvUntil(() => a.problems.length > 0, "the reset failure");
    assertEquals(a.problems, [
      "a: scripted BLE host failed: Error: HCI Reset failed with status 0x1",
    ]);
    assertEquals(a.serial, []);
    await drvUntil(() => b.serial.length > 0, "ready");
    assertEquals(b.serial, [`ble ready addr=${DRV_HCI_ADDRESS}`]);
    assertEquals(plain.commands.length, 5, "init only: no scan, advertising or connection");
    // No script: a connection from a central is still printed, and nothing is sent.
    await plain.send(drvConnectionComplete(0x41, 1, DRV_PHONE.mac));
    await drvUntil(() => b.serial.length === 2, "the connection line");
    assertEquals(b.serial[1], "ble connected to phone as peripheral");
    // No GATT table on a non-advertiser: a request is refused.
    await plain.send(drvAclAtt(0x41, [ATT.writeReq, 0x10, 0, 1]));
    await drvUntil(() => plain.acl.length === 1, "the error response");
    assertEquals(plain.acl[0]?.pdu, Uint8Array.of(ATT.errorRsp, ATT.writeReq, 0, 0, 0x06));
    assertEquals(b.problems, []);
  } finally {
    await boardA.stop();
    await boardB.stop();
    await failing.close();
    await plain.close();
  }
});

Deno.test("drivers scripted-ble: stopped while setup waits, queued jobs do not run; stop() twice is safe", async () => {
  const server = new DrvHciServer();
  server.reply = () => null; // never answers Reset
  const clock = new ManualClock();
  const { ctx, serial, problems } = drvBoardCtx(
    drvNode("p", DRV_BLE_RADIO, {
      ble: { advertise: { name: "p", intervalMs: 100 }, connect: null, scan: false },
    }),
    clock,
  );
  const board = await startScriptedBleBoard(ctx, server.port);
  try {
    await drvUntil(() => server.commands.length === 1, "the reset command");
    // A disconnection while setup still waits: it is printed, and the re-advertise job waits in line.
    await server.send(drvEvent(EVT.disconnectionComplete, [0, ...drvU16(5), 0x08]));
    await drvUntil(() => serial.length === 1, "the disconnection line");
    assertEquals(serial, ["ble disconnected from handle 5 reason=0x08"]);
    await board.stop();
    await board.stop();
    assertEquals(problems, [], "a stop is not a host failure");
    assertEquals(server.ops(), [OP.reset], "the queued advertising never ran");
  } finally {
    await server.close();
  }
});

Deno.test("drivers scripted-ble: the controller hanging up ends the read loop without a problem", async () => {
  const server = new DrvHciServer();
  const clock = new ManualClock();
  const { ctx, serial, problems } = drvBoardCtx(
    drvNode("q", DRV_BLE_RADIO, {
      send: [drvSend("phone", "late", { via: "gatt", startMs: 10 })],
      ble: { advertise: { name: "q", intervalMs: 100 }, connect: null, scan: false },
    }),
    clock,
    [DRV_PHONE],
  );
  const board = await startScriptedBleBoard(ctx, server.port);
  try {
    await drvUntil(() => serial.includes("ble advertising as q"), "advertising");
    await server.finish();
    // The read loop ends and fails the host: a later connection event can no longer arrive.
    await server.close();
    clock.advanceBy(10);
    assertEquals(serial.at(-1), "ble tx late:0 to phone skipped: not connected");
    await board.stop();
    assertEquals(problems, []);
  } finally {
    await board.stop();
  }
});

Deno.test("drivers scripted-ble: a central whose only peer connected does not initiate again", async () => {
  const server = new DrvHciServer();
  const clock = new ManualClock();
  const { ctx, serial, problems } = drvBoardCtx(
    drvNode("hub", DRV_BLE_RADIO, {
      ble: {
        advertise: null,
        connect: { peers: ["phone"], intervalMs: 30, timeoutMs: 1000 },
        scan: false,
      },
    }),
    clock,
    [DRV_PHONE],
  );
  const board = await startScriptedBleBoard(ctx, server.port);
  try {
    await drvUntil(() => server.ops().includes(OP.leCreateConnection), "Create Connection");
    const count = server.commands.length;
    await server.send(drvConnectionComplete(0x40, 0, DRV_PHONE.mac));
    await drvUntil(() => serial.includes("ble connected to phone as central"), "the connection");
    // The link drops: the job queued after the connection ran first, so whatever it sent comes before this attempt.
    await server.send(drvEvent(EVT.disconnectionComplete, [0, ...drvU16(0x40), 0x08]));
    await drvUntil(
      () => server.ops().slice(count).includes(OP.leCreateConnection),
      "the attempt after the drop",
    );
    assertEquals(
      server.ops().slice(count),
      [OP.leClearAcceptList, OP.leAddToAcceptList, OP.leCreateConnection],
      "nothing was sent while the only peer was connected",
    );
    assertEquals(problems, []);
  } finally {
    await board.stop();
    await server.close();
  }
});
