// Doors (obstacles with an id that the timeline changes) and interference
// (noise sources): the channel model, the mediums, the scenario format and the
// bundled example that proves both change delivery.

import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { fileURLToPath } from "node:url";
import {
  type AirFrame,
  AirMedium,
  type AirReceiver,
  computeMetrics,
  type EngineEvent,
  environmentFromPreset,
  EventLog,
  interferenceRiseDb,
  type InterferenceSource,
  linkBudget,
  ManualClock,
  noiseFloorDbm,
  type Obstacle,
  pathLossDb,
  wifiChannelFrequencyHz,
  withSourceActive,
  withWallAttenuation,
} from "../engine/mod.ts";
import {
  evaluateAssertions,
  interferenceSchedule,
  type LiveRun,
  loadScenario,
  parseScenario,
  runScenario,
  ScenarioError,
} from "../orchestrator/mod.ts";
import { makeRig, simulateEspNowTraffic, simulateScenarioTraffic, udpFrame } from "./helpers.ts";

const EXAMPLE = fileURLToPath(
  new URL("../scenarios/examples/door-and-interference-scripted.yaml", import.meta.url),
);

// ── channel model ───────────────────────────────────────────────────────────

const WIFI_HZ = wifiChannelFrequencyHz(5);
const RX = { position: { x: 0, y: 0 }, antennaGainDbi: 0 };
const RF = { frequencyHz: WIFI_HZ, bandwidthHz: 20e6, noiseFigureDb: 10 };
const THERMAL_DBM = noiseFloorDbm(RF.noiseFigureDb);

function source(over: Partial<InterferenceSource> = {}): InterferenceSource {
  return {
    id: "oven",
    position: { x: 10, y: 0 },
    powerDbm: 0,
    band: "2.4ghz",
    active: true,
    ...over,
  };
}

const freeSpace = (over = {}) =>
  environmentFromPreset("free_space", { shadowingSigmaDb: 0, ...over });

Deno.test("interference: a source that arrives at the thermal floor doubles the noise, +3.01 dB", () => {
  const env = freeSpace();
  const loss = pathLossDb(env, WIFI_HZ, 10);
  assertAlmostEquals(loss, 60.17, 0.01); // 20 log10(4 pi 10 m 2.432 GHz / c)
  const level = THERMAL_DBM + loss; // power that arrives at exactly -91 dBm
  const withOven = { ...env, interference: [source({ powerDbm: level })] };
  assertAlmostEquals(interferenceRiseDb(withOven, RX, RF, THERMAL_DBM), 3.0103, 1e-3);
});

Deno.test("interference: inactive, out-of-band and absent sources add nothing, and the budget is unchanged", () => {
  const quiet = freeSpace();
  const loud = (over: Partial<InterferenceSource>) => ({
    ...quiet,
    interference: [source({ powerDbm: 30, ...over })],
  });
  assertEquals(interferenceRiseDb(quiet, RX, RF, THERMAL_DBM), 0);
  assertEquals(interferenceRiseDb(loud({ active: false }), RX, RF, THERMAL_DBM), 0);
  assertEquals(interferenceRiseDb(loud({ band: "868mhz" }), RX, RF, THERMAL_DBM), 0);
  assert(interferenceRiseDb(loud({}), RX, RF, THERMAL_DBM) > 20);

  const tx = { position: { x: 5, y: 0 }, radio: { channel: 5, txPowerDbm: 15, antennaGainDbi: 0 } };
  const rx = { position: { x: 0, y: 0 }, radio: { channel: 5, txPowerDbm: 15, antennaGainDbi: 0 } };
  assertEquals(linkBudget(loud({ active: false }), tx, rx, 0), linkBudget(quiet, tx, rx, 0));
});

Deno.test("interference: the band is read off the receiver's frequency, not its PHY", () => {
  const env = (band: "2.4ghz" | "868mhz") => ({
    ...freeSpace(),
    interference: [source({ powerDbm: 20, band })],
  });
  const at = (frequencyHz: number, band: "2.4ghz" | "868mhz") =>
    interferenceRiseDb(env(band), RX, { ...RF, frequencyHz }, THERMAL_DBM);
  // Wi-Fi channel 1 and 14, the nRF24 and BLE ends of the band.
  for (const hz of [2412e6, 2484e6, 2400e6, 2480e6]) {
    assert(at(hz, "2.4ghz") > 0, `${hz}`);
    assertEquals(at(hz, "868mhz"), 0, `${hz}`);
  }
  // LoRa in the EU 868 band hears it; at 433 and 915 MHz it does not.
  assert(at(868.1e6, "868mhz") > 0);
  assertEquals(at(868.1e6, "2.4ghz"), 0);
  assertEquals(at(433e6, "868mhz"), 0);
  assertEquals(at(915e6, "868mhz"), 0);
});

Deno.test("interference: it reaches the receiver through the same walls a signal crosses", () => {
  const level = THERMAL_DBM + pathLossDb(freeSpace(), WIFI_HZ, 10);
  const wall: Obstacle = { from: [5, -5], to: [5, 5], attenuationDb: 20 };
  const open = { ...freeSpace(), interference: [source({ powerDbm: level + 20 })] };
  const walled = { ...open, obstacles: [wall] };
  // +20 dB of source power arrives at +20 dB over the floor: 10 log10(1 + 100).
  assertAlmostEquals(interferenceRiseDb(open, RX, RF, THERMAL_DBM), 20.043, 1e-3);
  // The 20 dB wall puts it back at the floor: 3.01 dB.
  assertAlmostEquals(interferenceRiseDb(walled, RX, RF, THERMAL_DBM), 3.0103, 1e-3);
  // A wall that is not between the source and the receiver costs it nothing.
  const behind: Obstacle = { from: [-5, -5], to: [-5, 5], attenuationDb: 20 };
  const elsewhere = { ...open, obstacles: [behind] };
  assertAlmostEquals(interferenceRiseDb(elsewhere, RX, RF, THERMAL_DBM), 20.043, 1e-3);
});

Deno.test("interference: sources add in power, and the receiver's antenna gain counts", () => {
  const level = THERMAL_DBM + pathLossDb(freeSpace(), WIFI_HZ, 10);
  const two = {
    ...freeSpace(),
    interference: [
      source({ id: "a", powerDbm: level }),
      source({ id: "b", powerDbm: level, position: { x: 0, y: 10 } }),
    ],
  };
  assertAlmostEquals(interferenceRiseDb(two, RX, RF, THERMAL_DBM), 4.7712, 1e-3); // 10 log10(3)
  const one = { ...freeSpace(), interference: [source({ powerDbm: level })] };
  const gain = interferenceRiseDb(one, { ...RX, antennaGainDbi: 10 }, RF, THERMAL_DBM);
  assertAlmostEquals(gain, 10 * Math.log10(1 + 10), 1e-3);
});

Deno.test("interference: SNR falls by the rise, RSSI and the signal's path do not move", () => {
  const tx = {
    position: { x: 20, y: 0 },
    radio: { channel: 5, txPowerDbm: 15, antennaGainDbi: 0 },
  };
  const rx = { position: { x: 0, y: 0 }, radio: { channel: 5, txPowerDbm: 15, antennaGainDbi: 0 } };
  const env = freeSpace({ interference: [source({ powerDbm: 10 })] });
  const quiet = linkBudget({ ...env, interference: [] }, tx, rx, 0);
  const noisy = linkBudget(env, tx, rx, 0);
  const rise = interferenceRiseDb(env, { ...rx.radio, position: rx.position }, RF, THERMAL_DBM);
  assert(rise > 10);
  assertEquals(noisy.rssiDbm, quiet.rssiDbm);
  assertAlmostEquals(noisy.noiseFloorDbm, quiet.noiseFloorDbm + rise, 1e-9);
  assertAlmostEquals(noisy.snrDb, quiet.snrDb - rise, 1e-9);
});

Deno.test("environment helpers change a copy, and say so when the id is unknown", () => {
  const env = freeSpace({
    obstacles: [
      { id: "door", from: [0, 0], to: [0, 5], attenuationDb: 12 },
      { id: "door", from: [0, 5], to: [4, 5], attenuationDb: 12 },
      { from: [9, 9], to: [9, 12], attenuationDb: 6 },
    ],
    interference: [source()],
  });
  const opened = withWallAttenuation(env, "door", 0)!;
  assertEquals(opened.obstacles.map((o) => o.attenuationDb), [0, 0, 6]);
  assertEquals(env.obstacles.map((o) => o.attenuationDb), [12, 12, 6]);
  assertEquals(withWallAttenuation(env, "window", 0), null);
  assertEquals(withSourceActive(env, "oven", false)!.interference[0]!.active, false);
  assertEquals(env.interference[0]!.active, true);
  assertEquals(withSourceActive(env, "toaster", true), null);
});

// ── the Wi-Fi medium ────────────────────────────────────────────────────────

const lossDrops = (events: readonly EngineEvent[]) =>
  events.flatMap((e) => (e.type === "drop" ? [e.reason] : []));
const delivered = (events: readonly EngineEvent[]) => events.filter((e) => e.type === "deliver");

Deno.test("medium: a door that opens lets the next frame through, and only the next ones", () => {
  // 53 m at 15 dBm leaves 14 dB of SNR; a 12 dB door takes it under what any rate decodes.
  const rig = makeRig({
    positions: { a: { x: 0, y: 0 }, b: { x: 53, y: 0 } },
    environment: environmentFromPreset("indoor_office", {
      shadowingSigmaDb: 0,
      obstacles: [{ id: "door", from: [26, -5], to: [26, 5], attenuationDb: 12 }],
    }),
  });
  const send = () => rig.medium.transmit("a", udpFrame(rig, "a", "b"));
  for (let i = 0; i < 3; i++) send();
  rig.clock.runAll();
  assertEquals(lossDrops(rig.log.events), [
    "retry_exhausted",
    "retry_exhausted",
    "retry_exhausted",
  ]);
  assertEquals(delivered(rig.log.events).length, 0);

  rig.medium.setObstacleAttenuation("door", 0);
  for (let i = 0; i < 3; i++) send();
  rig.clock.runAll();
  assertEquals(delivered(rig.log.events).length, 3);
  assertEquals(rig.sinks.get("b")!.frames.length, 3);
  assertEquals(lossDrops(rig.log.events).length, 3, "no new drops");

  const channel = rig.log.events.filter((e) => e.type === "channel");
  assertEquals(channel.length, 1);
  assert(channel[0]!.type === "channel" && channel[0]!.changes.obstacles![0]!.attenuationDb === 0);

  rig.medium.setObstacleAttenuation("door", 12);
  send();
  rig.clock.runAll();
  assertEquals(lossDrops(rig.log.events).length, 4, "closed again");
});

Deno.test("medium: an unknown door or source is a warning, not a crash and not a change", () => {
  const rig = makeRig({ positions: { a: { x: 0, y: 0 }, b: { x: 5, y: 0 } } });
  rig.medium.setObstacleAttenuation("gone", 0);
  rig.medium.setInterference("gone", true);
  const warnings = rig.log.events.flatMap((e) => (e.type === "warning" ? [e.text] : []));
  assertEquals(warnings.length, 2);
  assert(warnings[0]!.includes('"gone"') && warnings[0]!.includes("obstacle"));
  assert(warnings[1]!.includes("interference source"));
  assertEquals(rig.log.events.filter((e) => e.type === "channel" || e.type === "interference"), []);
});

Deno.test("medium: a source that switches on costs SNR and frames, and off gives them back", () => {
  const rig = makeRig({
    positions: { a: { x: 0, y: 0 }, b: { x: 20, y: 0 } },
    environment: environmentFromPreset("indoor_office", {
      shadowingSigmaDb: 0,
      interference: [source({ position: { x: 22, y: 0 }, powerDbm: 0, active: false })],
    }),
  });
  const snr = () => rig.medium.budget("a", "b").snrDb;
  const quiet = snr();
  const send = () => {
    rig.medium.transmit("a", udpFrame(rig, "a", "b"));
    rig.clock.runAll();
  };
  send();
  assertEquals(delivered(rig.log.events).length, 1);

  rig.medium.setInterference("oven", true);
  assert(snr() < quiet - 20, `${quiet} -> ${snr()}`);
  // The noise is at b, 2 m from the oven; a hears b from 22 m away and is hit far less.
  const reverse = rig.medium.budget("b", "a").snrDb;
  assert(reverse > snr() + 20, `${reverse} against ${snr()}`);
  send();
  assertEquals(lossDrops(rig.log.events), ["retry_exhausted"]);
  const drop = rig.log.events.find((e) => e.type === "drop")!;
  assert(drop.type === "drop" && drop.snrDb < 0 && drop.reason === "retry_exhausted");

  rig.medium.setInterference("oven", false);
  assertEquals(snr(), quiet);
  send();
  assertEquals(delivered(rig.log.events).length, 2);
  assertEquals(
    rig.log.events.flatMap((e) => (e.type === "interference" ? [e.active] : [])),
    [true, false],
  );
});

Deno.test("medium: a link override's interference_db stacks on the sources' noise", () => {
  const rig = makeRig({
    positions: { a: { x: 0, y: 0 }, b: { x: 20, y: 0 } },
    environment: environmentFromPreset("indoor_office", {
      shadowingSigmaDb: 0,
      interference: [source({ position: { x: 22, y: 0 }, powerDbm: -40 })],
    }),
  });
  const before = rig.medium.budget("a", "b");
  rig.medium.setLinkOverride("a", "b", { extraLossPct: 0, extraLatencyMs: 0, interferenceDb: 6 });
  const after = rig.medium.budget("a", "b");
  assertAlmostEquals(after.snrDb, before.snrDb - 6, 1e-9);
});

// ── the chip-level air ──────────────────────────────────────────────────────

function loraFrame(): AirFrame {
  return {
    kind: "lora",
    payload: new TextEncoder().encode("hello world 12345678"),
    airtimeMs: 50,
    frequencyHz: 868.1e6,
    bandwidthHz: 125e3,
    noiseFigureDb: 6,
    requiredSnrDb: -7.5,
    referenceBytes: 20,
    captureDb: 6,
    txPowerDbm: 14,
    interferenceKey: "868.1/7",
    rateBps: 5468.75,
    dst: "",
    src: "",
    params: { sf: 7 },
    header: null,
  };
}

function airOutcomes(band: "2.4ghz" | "868mhz", active: boolean) {
  const clock = new ManualClock();
  const log = new EventLog();
  const air = new AirMedium({
    seed: 7,
    clock,
    log,
    environment: environmentFromPreset("free_space", {
      shadowingSigmaDb: 0,
      interference: [source({ position: { x: 1000, y: 10 }, powerDbm: 20, band, active })],
    }),
  });
  const listening: AirReceiver = { hear: () => "listen", receive: () => true };
  air.addNode({ id: "a", position: { x: 0, y: 0 }, antennaGainDbi: 0 }, listening);
  air.addNode({ id: "gw", position: { x: 1000, y: 0 }, antennaGainDbi: 0 }, listening);
  for (let i = 0; i < 5; i++) {
    air.transmit("a", loraFrame());
    clock.advanceTo(clock.now() + 100);
  }
  return log.events.flatMap((e) =>
    e.type === "drop" ? [e.reason] : e.type === "deliver" ? ["deliver"] : []
  );
}

Deno.test("air: an 868 MHz source costs a LoRa receiver its frames as noise; a 2.4 GHz one does not", () => {
  // 1 km of free space leaves a LoRa frame well above its -7.5 dB floor...
  assertEquals(airOutcomes("868mhz", false), Array(5).fill("deliver"));
  assertEquals(airOutcomes("2.4ghz", true), Array(5).fill("deliver"));
  // ...and a 20 dBm source 10 m from the gateway buries it.
  assertEquals(airOutcomes("868mhz", true), Array(5).fill("noise"));
});

function loraRig() {
  const clock = new ManualClock();
  const log = new EventLog();
  const air = new AirMedium({
    seed: 7,
    clock,
    log,
    environment: environmentFromPreset("free_space", {
      shadowingSigmaDb: 0,
      obstacles: [{ id: "door", from: [500, -5], to: [500, 5], attenuationDb: 30 }],
      interference: [
        source({ position: { x: 1000, y: 10 }, powerDbm: 20, band: "868mhz", active: false }),
      ],
    }),
  });
  const listening: AirReceiver = { hear: () => "listen", receive: () => true };
  air.addNode({ id: "a", position: { x: 0, y: 0 }, antennaGainDbi: 0 }, listening);
  air.addNode({ id: "gw", position: { x: 1000, y: 0 }, antennaGainDbi: 0 }, listening);
  const send = () => {
    air.transmit("a", loraFrame());
    clock.advanceTo(clock.now() + 100);
  };
  const outcomes = () =>
    log.events.flatMap((e) =>
      e.type === "drop" ? [e.reason] : e.type === "deliver" ? ["deliver"] : []
    );
  return { air, log, send, outcomes };
}

Deno.test("air: a door and a source changed while the run plays reach the next frame, and an unknown id warns", () => {
  const r = loraRig();
  r.send();
  const closed = r.air.budget("a", "gw").rssiDbm;
  r.air.setObstacleAttenuation("door", 0);
  assertAlmostEquals(r.air.budget("a", "gw").rssiDbm, closed + 30, 1e-9);
  r.air.setObstacleAttenuation("door", 30);
  assertAlmostEquals(r.air.budget("a", "gw").rssiDbm, closed, 1e-9);

  r.air.setInterference("oven", true);
  r.send();
  r.air.setInterference("oven", false);
  r.send();
  assertEquals(r.outcomes(), ["deliver", "noise", "deliver"]);
  assertEquals(
    r.log.events.flatMap((e) => (e.type === "interference" ? [e.active] : [])),
    [true, false],
  );

  r.air.setObstacleAttenuation("gone", 0);
  r.air.setInterference("gone", true);
  assertEquals(r.log.events.filter((e) => e.type === "warning").length, 2);
});

// ── scenario format ─────────────────────────────────────────────────────────

const BASE = `
name: t
duration: 10s
nodes:
  - { id: a, board: scripted, position: [0, 0] }
  - { id: b, board: scripted, position: [5, 0] }
`;

/** BASE with extra top-level YAML before `nodes:`. */
const withSections = (sections: string) => BASE.replace("nodes:", `${sections}\nnodes:`);

function expectError(yaml: string, field: string): void {
  const error = assertThrows(() => parseScenario(yaml), ScenarioError);
  assert(error.message.startsWith(field), `expected "${field}" first in: ${error.message}`);
}

Deno.test("scenario: obstacles carry an id, and a polygon's every edge carries it", () => {
  const s = parseScenario(withSections(`environment:
  obstacles:
    - { id: front-door, polygon: [[0, 0], [4, 0], [4, 4]], attenuation_db: 12 }
    - { polygon: [[9, 0], [9, 4]], attenuation_db: 6 }`));
  assertEquals(s.environment.obstacles.map((o) => o.id), [
    "front-door",
    "front-door",
    "front-door",
    undefined,
  ]);
  assert(!("id" in s.environment.obstacles[3]!), "an unnamed wall has no id key at all");
});

Deno.test("scenario: interference sources parse, start off, and window from time zero by default", () => {
  const s = parseScenario(withSections(`environment:
  interference:
    - { id: oven, position: [3, 4], power_dbm: 20, band: 2.4ghz }
    - { id: ap, position: [1, 2, 3], power_dbm: -10, band: 868mhz, from: 2s, to: 9s }`));
  assertEquals(s.environment.interference, [
    { id: "oven", position: { x: 3, y: 4 }, powerDbm: 20, band: "2.4ghz", active: false },
    { id: "ap", position: { x: 1, y: 2, z: 3 }, powerDbm: -10, band: "868mhz", active: false },
  ]);
  assertEquals(s.interferenceWindows, [
    { id: "oven", fromMs: 0, toMs: null },
    { id: "ap", fromMs: 2000, toMs: 9000 },
  ]);
  assertEquals(interferenceSchedule(s.interferenceWindows), [
    { id: "oven", on: true, atMs: 0 },
    { id: "ap", on: true, atMs: 2000 },
    { id: "ap", on: false, atMs: 9000 },
  ]);
});

Deno.test("scenario: a scenario without them has neither, and walls keep their meaning", () => {
  const s = parseScenario(withSections(`environment:
  obstacles:
    - { polygon: [[5, 0], [5, 10]], attenuation_db: 12 }`));
  assertEquals(s.environment.interference, []);
  assertEquals(s.interferenceWindows, []);
  assertEquals(s.environment.obstacles, [{ from: [5, 0], to: [5, 10], attenuationDb: 12 }]);
});

Deno.test("scenario: timeline entries change a door and switch a source, in time order", () => {
  const s = parseScenario(
    withSections(`environment:
  obstacles: [{ id: door, polygon: [[2, -5], [2, 5]], attenuation_db: 12 }]
  interference: [{ id: oven, position: [3, 3], power_dbm: 20, band: 2.4ghz }]
timeline:
  - { at: 8s, obstacle: { id: door, attenuation_db: 12 } }
  - { at: 3s, label: opened, obstacle: { id: door, attenuation_db: 0 }, interference: { id: oven, on: false } }`),
  );
  assertEquals(s.timeline.map((e) => [e.atMs, e.label]), [[3000, "opened"], [8000, null]]);
  assertEquals(s.timeline[0]!.actions, [
    { kind: "obstacle", id: "door", attenuationDb: 0 },
    { kind: "interference", id: "oven", on: false },
  ]);
});

const DOOR = "obstacles: [{ id: door, polygon: [[2, -5], [2, 5]], attenuation_db: 12 }]";
const OVEN = "interference: [{ id: oven, position: [3, 3], power_dbm: 20, band: 2.4ghz }]";
const env = (...lines: string[]) => withSections(`environment:\n  ${lines.join("\n  ")}`);

const INVALID: [string, string, string][] = [
  [
    "obstacle id with a space",
    env("obstacles: [{ id: 'a b', polygon: [[0, 0], [1, 1]], attenuation_db: 1 }]"),
    "environment.obstacles[0].id",
  ],
  [
    "obstacle id empty",
    env("obstacles: [{ id: '', polygon: [[0, 0], [1, 1]], attenuation_db: 1 }]"),
    "environment.obstacles[0].id",
  ],
  [
    "obstacle id twice",
    env(
      "obstacles:",
      "  - { id: d, polygon: [[0, 0], [1, 1]], attenuation_db: 1 }",
      "  - { id: d, polygon: [[2, 0], [3, 1]], attenuation_db: 1 }",
    ),
    "environment.obstacles[1].id",
  ],
  ["interference not a list", env("interference: oven"), "environment.interference"],
  [
    "source without id",
    env("interference: [{ position: [0, 0], power_dbm: 1, band: 2.4ghz }]"),
    "environment.interference[0].id",
  ],
  [
    "source id twice",
    env(
      "interference:",
      "  - { id: o, position: [0, 0], power_dbm: 1, band: 2.4ghz }",
      "  - { id: o, position: [1, 0], power_dbm: 1, band: 2.4ghz }",
    ),
    "environment.interference[1].id",
  ],
  [
    "source without position",
    env("interference: [{ id: o, power_dbm: 1, band: 2.4ghz }]"),
    "environment.interference[0].position",
  ],
  [
    "source position of one number",
    env("interference: [{ id: o, position: [1], power_dbm: 1, band: 2.4ghz }]"),
    "environment.interference[0].position",
  ],
  [
    "source without power",
    env("interference: [{ id: o, position: [0, 0], band: 2.4ghz }]"),
    "environment.interference[0].power_dbm",
  ],
  [
    "source too loud",
    env("interference: [{ id: o, position: [0, 0], power_dbm: 200, band: 2.4ghz }]"),
    "environment.interference[0].power_dbm",
  ],
  [
    "source without band",
    env("interference: [{ id: o, position: [0, 0], power_dbm: 1 }]"),
    "environment.interference[0].band",
  ],
  [
    "source band unknown",
    env("interference: [{ id: o, position: [0, 0], power_dbm: 1, band: 5ghz }]"),
    "environment.interference[0].band",
  ],
  [
    "source field unknown",
    env("interference: [{ id: o, position: [0, 0], power_dbm: 1, band: 2.4ghz, duty: 50 }]"),
    "environment.interference[0].duty",
  ],
  [
    "source from without a unit",
    env("interference: [{ id: o, position: [0, 0], power_dbm: 1, band: 2.4ghz, from: 5 }]"),
    "environment.interference[0].from",
  ],
  [
    "source to before from",
    env(
      "interference: [{ id: o, position: [0, 0], power_dbm: 1, band: 2.4ghz, from: 5s, to: 5s }]",
    ),
    "environment.interference[0].to",
  ],
  [
    "source from after the run",
    env("interference: [{ id: o, position: [0, 0], power_dbm: 1, band: 2.4ghz, from: 11s }]"),
    "environment.interference[0].from",
  ],
  [
    "source to after the run",
    env("interference: [{ id: o, position: [0, 0], power_dbm: 1, band: 2.4ghz, to: 11s }]"),
    "environment.interference[0].to",
  ],
  [
    "door change for an unknown id",
    withSections(
      `environment:\n  ${DOOR}\ntimeline:\n  - { at: 1s, obstacle: { id: window, attenuation_db: 0 } }`,
    ),
    "timeline[0].obstacle.id",
  ],
  [
    "door change when no wall has an id",
    withSections(`timeline:\n  - { at: 1s, obstacle: { id: door, attenuation_db: 0 } }`),
    "timeline[0].obstacle.id",
  ],
  [
    "door change without an id",
    withSections(
      `environment:\n  ${DOOR}\ntimeline:\n  - { at: 1s, obstacle: { attenuation_db: 0 } }`,
    ),
    "timeline[0].obstacle.id",
  ],
  [
    "door change without attenuation",
    withSections(`environment:\n  ${DOOR}\ntimeline:\n  - { at: 1s, obstacle: { id: door } }`),
    "timeline[0].obstacle.attenuation_db",
  ],
  [
    "door change with negative attenuation",
    withSections(
      `environment:\n  ${DOOR}\ntimeline:\n  - { at: 1s, obstacle: { id: door, attenuation_db: -3 } }`,
    ),
    "timeline[0].obstacle.attenuation_db",
  ],
  [
    "door change with an unknown field",
    withSections(
      `environment:\n  ${DOOR}\ntimeline:\n  - { at: 1s, obstacle: { id: door, attenuation_db: 0, open: true } }`,
    ),
    "timeline[0].obstacle.open",
  ],
  [
    "source switch for an unknown id",
    withSections(
      `environment:\n  ${OVEN}\ntimeline:\n  - { at: 1s, interference: { id: toaster, on: true } }`,
    ),
    "timeline[0].interference.id",
  ],
  [
    "source switch without on",
    withSections(`environment:\n  ${OVEN}\ntimeline:\n  - { at: 1s, interference: { id: oven } }`),
    "timeline[0].interference.on",
  ],
  [
    "source switch with on a string",
    withSections(
      `environment:\n  ${OVEN}\ntimeline:\n  - { at: 1s, interference: { id: oven, on: 'yes' } }`,
    ),
    "timeline[0].interference.on",
  ],
  [
    "the entry named is the one in the file, not the one in time order",
    withSections(
      `environment:\n  ${DOOR}\ntimeline:\n  - { at: 8s, obstacle: { id: nope, attenuation_db: 0 } }\n  - { at: 1s, label: early }`,
    ),
    "timeline[0].obstacle.id",
  ],
];

for (const [name, yaml, field] of INVALID) {
  Deno.test(`scenario: ${name} is refused at ${field}`, () => expectError(yaml, field));
}

Deno.test("scenario: an unknown id names the ids that do exist", () => {
  const error = assertThrows(
    () =>
      parseScenario(
        withSections(
          `environment:\n  ${DOOR}\ntimeline:\n  - { at: 1s, obstacle: { id: window, attenuation_db: 0 } }`,
        ),
      ),
    ScenarioError,
  );
  assert(error.message.includes('"window"') && error.message.includes("door"), error.message);
});

// ── the effect on a whole run ───────────────────────────────────────────────

Deno.test("a door entry opens a metrics phase only when it has a label", () => {
  const yaml = (label: string) =>
    withSections(`environment:
  shadowing_sigma_db: 0
  ${DOOR}
timeline:
  - { at: 4s, ${label}obstacle: { id: door, attenuation_db: 0 } }`).replace(
      "[5, 0]",
      "[53, 0]",
    );
  const labels = (label: string) =>
    computeMetrics(
      simulateScenarioTraffic(parseScenario(yaml(label)), { everyMs: 100, payloadBytes: 10 }).log
        .events,
      10_000,
    ).phases.map((p) => p.label);
  assertEquals(labels(""), ["start"]);
  assertEquals(labels("label: door-open, "), ["start", "door-open"]);
});

Deno.test("example: the door and the oven each change delivery, and the same seed gives the same run", async () => {
  const { scenario } = await loadScenario(EXAMPLE);
  const play = (s = scenario) => simulateScenarioTraffic(s, { everyMs: 100, payloadBytes: 10 });
  const rig = play();
  const metrics = computeMetrics(rig.log.events, scenario.durationMs);
  const results = evaluateAssertions(
    scenario.assertions.filter((a) => a.kind === "metric"),
    rig.log.events,
    metrics.phases,
  );
  assert(results.length >= 5);
  for (const r of results) assert(r.passed, `${r.description}: ${r.detail}`);

  const link = (phase: string, from: string, to: string) =>
    metrics.phases.find((p) => p.label === phase)!.links.find((l) =>
      l.from === from && l.to === to
    )!;
  assertEquals(link("start", "a", "b").delivered, 0, "door closed");
  assertEquals(link("door-open", "a", "b").lossPct, 0, "door open");
  assertEquals(link("oven-on", "a", "b").delivered, 0, "oven on, at the receiver");
  assertEquals(link("oven-on", "b", "a").lossPct, 0, "oven on, far from the receiver");
  assertEquals(link("oven-off", "a", "b").lossPct, 0, "oven off");
  assertEquals(link("oven-on", "a", "b").dropped.retry_exhausted, 20);
  assert(link("oven-on", "a", "b").snrDb < link("door-open", "a", "b").snrDb - 10);

  // Same seed, same events, down to the last field.
  assertEquals(JSON.stringify(play().log.events), JSON.stringify(rig.log.events));
});

Deno.test("example: without the door entry or the oven the assertions go red", async () => {
  const { scenario } = await loadScenario(EXAMPLE);
  // Windows checkouts get CRLF line endings, which the line regexes below do not expect.
  const text = (await Deno.readTextFile(EXAMPLE)).replaceAll("\r\n", "\n");
  const failing = (yaml: string) => {
    const s = parseScenario(yaml);
    const rig = simulateScenarioTraffic(s, { everyMs: 100, payloadBytes: 10 });
    const phases = computeMetrics(rig.log.events, s.durationMs).phases;
    return evaluateAssertions(
      s.assertions.filter((a) => a.kind === "metric"),
      rig.log.events,
      phases,
    )
      .filter((r) => !r.passed).map((r) => r.description);
  };
  assertEquals(failing(text), []);
  // The door never opens: the door-open and later phases lose everything.
  const doorStaysShut = text.replace("obstacle: { id: front-door, attenuation_db: 0 }", "");
  assert(doorStaysShut !== text);
  assert(failing(doorStaysShut).some((d) => d.includes("door-open")));
  // No oven: a->b is clean while the oven is "on".
  const noOven = text.replace(/ {2}interference:\n.*\n/, "").replace(
    "interference: { id: oven, on: false }",
    "",
  );
  assert(noOven !== text && !noOven.includes("oven, position"));
  assert(failing(noOven).some((d) => d.includes("oven-on")));
  assertEquals(scenario.timeline.length, 3);
});

Deno.test("example: a real run on scripted boards passes, and leaves the door open and the oven off", async () => {
  const dir = await Deno.makeTempDir({ prefix: "hzb-door-" });
  try {
    const loaded = await loadScenario(EXAMPLE, `${dir}/out`);
    let live: LiveRun | undefined;
    let startOven: boolean | undefined;
    const result = await runScenario(loaded.scenario, {
      outDir: loaded.outDir,
      outputs: loaded.outputs,
      onUnderway: (run) => {
        live = run;
        const environment = run.environment();
        startOven = environment.interference[0]!.active;
      },
    });
    for (const a of result.assertions) assert(a.passed, `${a.description}: ${a.detail}`);
    assert(result.passed, JSON.stringify(result.problems));
    // An oven with a `from` is off at time zero.
    assertEquals(startOven, false);
    const final = live!.environment();
    assertEquals(final.obstacles.map((o) => o.attenuationDb), [0]);
    assertEquals(final.interference.map((s) => s.active), [false]);
    const switched = result.events.flatMap((e) =>
      e.type === "interference" ? [[Math.round(e.t / 100) * 100, e.active]] : []
    );
    assertEquals(switched, [[4000, true], [6000, false]]);
    assertEquals(
      result.metrics.phases.map((p) => p.label),
      ["start", "door-open", "oven-on", "oven-off"],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an interferer at time zero is on before the first frame; a later one is scheduled", async () => {
  const dir = await Deno.makeTempDir({ prefix: "hzb-oven-" });
  try {
    const file = `${dir}/s.yaml`;
    await Deno.writeTextFile(
      file,
      `name: oven
duration: 600ms
environment:
  shadowing_sigma_db: 0
  interference: [{ id: oven, position: [5, 1], power_dbm: 10, band: 2.4ghz }]
nodes:
  - { id: a, board: scripted, position: [0, 0], firmware: { send: [{ to: b, every: 100ms, count: 5 }] } }
  - { id: b, board: scripted, position: [5, 0], firmware: {} }
assertions:
  - metric: { link: "a->b", kind: udp, loss_pct: { gt: 99 } }
`,
    );
    const loaded = await loadScenario(file, `${dir}/out`);
    const result = await runScenario(loaded.scenario, {
      outDir: loaded.outDir,
      outputs: loaded.outputs,
    });
    for (const a of result.assertions) assert(a.passed, `${a.description}: ${a.detail}`);
    const first = result.events.find((e) => e.type === "interference");
    assert(first && first.type === "interference" && first.active, JSON.stringify(first));
    assert(result.events.find((e) => e.type === "tx" && e.kind === "udp")!.t >= first.t);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("espnow: a source in the band costs ESP-NOW frames as retry_exhausted", () => {
  const text = (interference: string) =>
    `name: en
duration: 1s
environment:
  shadowing_sigma_db: 0
  ${interference}
nodes:
  - { id: a, board: scripted, position: [0, 0], radios: [{ phy: wifi, channel: 6 }], firmware: {} }
  - { id: b, board: scripted, position: [5, 0], radios: [{ phy: wifi, channel: 6 }], firmware: {} }
`;
  const run = (interference: string) =>
    simulateEspNowTraffic(parseScenario(text(interference)), [{ from: "a", to: "b", everyMs: 100 }])
      .events.filter((e) => e.type === "drop" && e.kind === "espnow");
  assertEquals(run("interference: []"), []);
  const hit = run("interference: [{ id: ap, position: [5, 1], power_dbm: 10, band: 2.4ghz }]");
  assert(hit.length > 0);
  assert(hit.every((e) => e.type === "drop" && e.reason === "retry_exhausted"));
  assertEquals(
    run("interference: [{ id: ap, position: [5, 1], power_dbm: 10, band: 868mhz }]"),
    [],
  );
});
