// The virtual BLE controller against the TypeScript HCI host, on the chip-level
// air with a manual clock: what a host stack sees (HCI events), and what the
// engine logs (frames, connections, host-to-host ACL delivery).

import { commandExists } from "./platform.ts";
import { assert, assertAlmostEquals, assertEquals, assertExists } from "@std/assert";
import {
  BleController,
  BtsnoopWriter,
  encodeHci,
  isBleFrame,
  OP,
  STATUS,
  SUPPORTED_COMMAND_BITS,
  supportedCommands,
} from "../adapters/ble-hci/mod.ts";
import {
  AirMedium,
  bleAirtimeUs,
  bleChannelFrequencyHz,
  bleCrc24,
  bleCrcBytes,
  bleNextDataChannel,
  bleRfChannel,
  type EngineEvent,
  environmentFromPreset,
  EventLog,
  linkBudgetAt,
  ManualClock,
  substream,
} from "../engine/mod.ts";
import {
  advertisedName,
  type AdvertisingReport,
  HciHost,
} from "../orchestrator/boards/drivers/hci-host.ts";

// ── PHY ─────────────────────────────────────────────────────────────────────

Deno.test("ble phy: advertising channels sit at 2402, 2426 and 2480 MHz, data channels around them", () => {
  assertEquals(bleChannelFrequencyHz(37), 2402e6);
  assertEquals(bleChannelFrequencyHz(38), 2426e6);
  assertEquals(bleChannelFrequencyHz(39), 2480e6);
  assertEquals(bleChannelFrequencyHz(0), 2404e6);
  assertEquals(bleChannelFrequencyHz(10), 2424e6);
  assertEquals(bleChannelFrequencyHz(11), 2428e6);
  assertEquals(bleChannelFrequencyHz(36), 2478e6);
  assertEquals([37, 0, 10, 38, 11, 36, 39].map(bleRfChannel), [0, 1, 11, 12, 13, 38, 39]);
});

Deno.test("ble phy: a packet is 8 us per byte of preamble, access address, PDU and CRC", () => {
  // An empty data PDU: 1 + 4 + 2 + 3 bytes.
  assertEquals(bleAirtimeUs(2), 80);
  // An ADV_IND with 31 bytes of data: 6 + 31 payload, 2 header.
  assertEquals(bleAirtimeUs(39), 376);
  // CONNECT_IND: 34 bytes of payload.
  assertEquals(bleAirtimeUs(36), 352);
});

Deno.test("ble phy: channel selection #1 adds the hop modulo 37 and remaps unused channels", () => {
  const all = Array.from({ length: 37 }, (_, i) => i);
  let last = 0;
  const seen: number[] = [];
  for (let i = 0; i < 4; i++) {
    const next = bleNextDataChannel(last, 7, all);
    last = next.unmapped;
    seen.push(next.channel);
  }
  assertEquals(seen, [7, 14, 21, 28]);
  // Only channels 1, 3 and 5 used: unmapped 7 -> index 7 % 3 = 1 -> channel 3.
  assertEquals(bleNextDataChannel(0, 7, [1, 3, 5]), { unmapped: 7, channel: 3 });
});

Deno.test("ble phy: the CRC sent after a PDU brings the receiver's register to zero", () => {
  const pdu = Uint8Array.of(0x40, 0x06, 0x05, 0x01, 0x62, 0x7a, 0x68, 0x02);
  for (const init of [0x555555, 0x123456]) {
    const crc = bleCrc24(pdu, init);
    const withCrc = Uint8Array.from([...pdu, ...bleCrcBytes(crc)]);
    assertEquals(bleCrc24(withCrc, init), 0);
  }
  // A one-bit error does not.
  const bad = Uint8Array.from([...pdu, ...bleCrcBytes(bleCrc24(pdu, 0x555555))]);
  bad[2] = (bad[2] as number) ^ 1;
  assert(bleCrc24(bad, 0x555555) !== 0);
});

// ── a rig of controllers and hosts on the air ───────────────────────────────

interface Node {
  id: string;
  controller: BleController;
  host: HciHost;
  connections: { handle: number; role: string; peer: string; status: number }[];
  disconnections: { handle: number; reason: number }[];
  reports: AdvertisingReport[];
  att: { handle: number; text: string }[];
  warnings: string[];
}

function rig(positions: Record<string, [number, number]>, seed = 3) {
  const clock = new ManualClock();
  const log = new EventLog();
  const environment = environmentFromPreset("indoor_office", { shadowingSigmaDb: 0 });
  const air = new AirMedium({ seed, environment, clock, log });
  const nodes = new Map<string, Node>();
  Object.entries(positions).forEach(([id, [x, y]], i) => {
    const node = {
      id,
      connections: [],
      disconnections: [],
      reports: [],
      att: [],
      warnings: [],
    } as unknown as Node;
    const address = `02:68:7a:62:01:0${i + 1}`;
    node.controller = new BleController({
      nodeId: id,
      address,
      txPowerDbm: 0,
      clock,
      log,
      rng: substream(seed, `ble:${id}`),
      transmit: (frame) => air.transmit(id, frame),
      toHost: (bytes) => queueMicrotask(() => node.host.feed(bytes)),
      warn: (message) => node.warnings.push(message),
    });
    node.host = new HciHost((bytes) => {
      node.controller.fromHost(bytes);
      return Promise.resolve();
    }, {
      connected: (handle, role, peer, status) =>
        node.connections.push({ handle, role, peer, status }),
      disconnected: (handle, reason) => node.disconnections.push({ handle, reason }),
      advertisingReport: (report) => node.reports.push(report),
      att: (handle, pdu) =>
        node.att.push({ handle, text: new TextDecoder().decode(pdu.subarray(3)) }),
    });
    air.addNode({ id, position: { x, y }, antennaGainDbi: 0 }, node.controller);
    nodes.set(id, node);
  });
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  /** Advance in small steps so host promises resolve between controller timers. */
  const run = async (ms: number) => {
    const end = clock.now() + ms;
    while (clock.now() < end) {
      await settle();
      clock.advanceTo(Math.min(end, clock.now() + 0.5));
    }
    await settle();
  };
  const node = (id: string) => nodes.get(id) as Node;
  return { clock, log, air, environment, node, run, settle };
}

const kinds = (events: readonly EngineEvent[], kind: string) =>
  events.filter((e) => (e.type === "deliver" || e.type === "drop") && e.kind === kind);

Deno.test("ble controller: init answers what a host reads, and an unknown command once with a warning", async () => {
  const r = rig({ a: [0, 0], b: [5, 0] });
  const a = r.node("a");
  const done = a.host.init();
  await r.settle();
  await done;
  assertEquals(a.host.address, "02:68:7a:62:01:01");
  const version = await a.host.ok(OP.readLocalVersion);
  assertEquals(version[0], 0x08);
  const unknown1 = await a.host.command(0xfc01);
  const unknown2 = await a.host.command(0xfc01);
  assertEquals([unknown1.status, unknown2.status], [STATUS.unknownCommand, STATUS.unknownCommand]);
  assertEquals(a.warnings.length, 1);
  assert(a.warnings[0]?.includes("0xfc01"), a.warnings[0]);
  // Too short: Read RSSI needs a handle.
  assertEquals((await a.host.command(OP.readRssi, [1])).status, STATUS.invalidParameters);
});

Deno.test("ble controller: a passive scanner reports the advertiser's name with the RSSI the engine computed", async () => {
  const r = rig({ adv: [0, 0], scanner: [10, 0] });
  const adv = r.node("adv");
  const scanner = r.node("scanner");
  const setup = Promise.all([adv.host.init(), scanner.host.init()]);
  await r.settle();
  await setup;
  const started = Promise.all([
    adv.host.advertise("sensor-1", 50),
    scanner.host.scan(false, 30, 30),
  ]);
  await r.settle();
  await started;
  await r.run(400);

  assert(scanner.reports.length >= 5, `reports: ${scanner.reports.length}`);
  const report = scanner.reports[0] as AdvertisingReport;
  assertEquals(report.address, "02:68:7a:62:01:01");
  assertEquals(report.eventType, 0x00);
  assertEquals(advertisedName(report.data), "sensor-1");
  const budget = linkBudgetAt(
    r.environment,
    { position: { x: 0, y: 0 }, txPowerDbm: 0, antennaGainDbi: 0 },
    { position: { x: 10, y: 0 }, antennaGainDbi: 0 },
    { frequencyHz: bleChannelFrequencyHz(37), bandwidthHz: 1e6, noiseFigureDb: 10 },
    0,
  );
  assertEquals(report.rssi, Math.round(budget.rssiDbm));
  // Every advertising event goes out on all three channels.
  const channels = new Set(
    r.log.events.flatMap((e) => (e.type === "tx" && e.node === "adv" ? [e.radio?.channel] : [])),
  );
  assertEquals([...channels].sort(), [37, 38, 39]);
  assert(kinds(r.log.events, "ble-adv").length > 0);
});

Deno.test("ble controller: an active scanner gets the scan response too", async () => {
  const r = rig({ adv: [0, 0], scanner: [3, 0] });
  const adv = r.node("adv");
  const scanner = r.node("scanner");
  const setup = Promise.all([adv.host.init(), scanner.host.init()]);
  await r.settle();
  await setup;
  const scanRsp = new Uint8Array(32);
  scanRsp.set([4, 3, 0x09, 0x68, 0x7a], 0);
  await Promise.all([
    adv.host.advertise("a", 40).then(() => adv.host.ok(OP.leSetScanRspData, scanRsp)),
    scanner.host.scan(true, 20, 20),
  ]);
  await r.run(300);
  const types = new Set(scanner.reports.map((rep) => rep.eventType));
  assert(types.has(0x00) && types.has(0x04), `event types ${[...types]}`);
  const tx = r.log.events.flatMap((e) => (e.type === "tx" ? [e.radio?.pdu] : []));
  assert(tx.includes("SCAN_REQ") && tx.includes("SCAN_RSP"), tx.join(","));
});

async function connected(r: ReturnType<typeof rig>, intervalMs = 30, timeoutMs = 500) {
  const gw = r.node("gw");
  const sensor = r.node("sensor");
  const setup = Promise.all([gw.host.init(), sensor.host.init()]);
  await r.settle();
  await setup;
  await sensor.host.advertise("sensor", 40);
  await gw.host.setAcceptList([sensor.host.address]);
  await gw.host.connectAcceptList(intervalMs, timeoutMs);
  await r.run(200);
  assertEquals(gw.connections.length, 1, "the central connected");
  assertEquals(sensor.connections.length, 1, "the peripheral connected");
  return { gw, sensor };
}

function att(text: string): Uint8Array {
  // ATT Handle Value Notification on handle 0x0010.
  return Uint8Array.from([0x1b, 0x10, 0x00, ...new TextEncoder().encode(text)]);
}

Deno.test("ble controller: a connection carries ATT both ways, every packet once, within a few intervals", async () => {
  const r = rig({ gw: [0, 0], sensor: [4, 0] });
  const { gw, sensor } = await connected(r);
  assertEquals(gw.connections[0]?.role, "central");
  assertEquals(gw.connections[0]?.peer, "02:68:7a:62:01:02");
  assertEquals(sensor.connections[0]?.role, "peripheral");
  assertEquals(sensor.connections[0]?.peer, "02:68:7a:62:01:01");
  // More packets than the controller has buffers: the host must get its credits back.
  for (let i = 0; i < 25; i++) sensor.host.sendAtt(sensor.connections[0]!.handle, att(`r${i}`));
  gw.host.sendAtt(gw.connections[0]!.handle, att("cmd"));
  await r.run(1000);
  assertEquals(gw.att.map((a) => a.text), Array.from({ length: 25 }, (_, i) => `r${i}`));
  assertEquals(sensor.att.map((a) => a.text), ["cmd"]);

  const acl = kinds(r.log.events, "ble-acl");
  assertEquals(acl.length, 26);
  assert(acl.every((e) => e.type === "deliver"));
  for (const e of acl) if (e.type === "deliver") assert(e.delayMs < 200, `delay ${e.delayMs}`);
  const links = r.log.events.filter((e) => e.type === "ble-link");
  assertEquals(links.length, 2);
  // Data packets cross the 37 data channels, never the advertising ones.
  const dataChannels = new Set(
    r.log.events.flatMap((
      e,
    ) => (e.type === "tx" && e.kind === "ble-data" ? [e.radio?.channel] : [])),
  );
  assert(dataChannels.size > 10 && ![...dataChannels].some((c) => Number(c) > 36));
  const rssi = await gw.host.ok(OP.readRssi, [gw.connections[0]!.handle, 0]);
  assert(((rssi[2]! << 24) >> 24) < -40, "Read RSSI reports the engine's level");
});

Deno.test("ble controller: a peripheral that walks out of range is lost to the supervision timeout on both sides", async () => {
  const r = rig({ gw: [0, 0], sensor: [4, 0] });
  const { gw, sensor } = await connected(r, 30, 500);
  r.air.moveNode("sensor", { x: 400, y: 0 });
  const handle = sensor.connections[0]!.handle;
  for (let i = 0; i < 3; i++) sensor.host.sendAtt(handle, att(`lost${i}`));
  await r.run(700);
  assertEquals(gw.disconnections.map((d) => d.reason), [STATUS.connectionTimeout]);
  assertEquals(sensor.disconnections.map((d) => d.reason), [STATUS.connectionTimeout]);
  const down = r.log.events.filter((e) => e.type === "ble-link" && e.state === "down");
  assertEquals(down.length, 2);
  // The lost connection's data is counted as lost, not silently forgotten.
  const lost = kinds(r.log.events, "ble-acl").filter((e) => e.type === "drop");
  assertEquals(lost.length, 3);
  assert(lost.every((e) => e.type === "drop" && e.reason === "link_lost"));
  // The timeout took the 500 ms the central asked for, give or take one interval.
  const moved = r.log.events.find((e) => e.type === "move")!.t;
  const gwDown = down.find((e) => e.type === "ble-link" && e.node === "gw")!;
  assertAlmostEquals(gwDown.t - moved, 500, 40);
});

Deno.test("ble controller: a host disconnect reaches the peer as 'remote user terminated'", async () => {
  const r = rig({ gw: [0, 0], sensor: [4, 0] });
  const { gw, sensor } = await connected(r);
  const status = await gw.host.command(OP.disconnect, [...[gw.connections[0]!.handle, 0], 0x13]);
  assertEquals(status.status, STATUS.success);
  await r.run(200);
  assertEquals(gw.disconnections.map((d) => d.reason), [STATUS.localHostTerminated]);
  assertEquals(sensor.disconnections.map((d) => d.reason), [STATUS.remoteUserTerminated]);
});

Deno.test("ble controller: version exchange and connection update go over the air", async () => {
  const r = rig({ gw: [0, 0], sensor: [4, 0] });
  const { gw, sensor } = await connected(r, 30, 1000);
  const handle = gw.connections[0]!.handle;
  assertEquals((await gw.host.command(OP.readRemoteVersion, [handle, 0])).status, STATUS.success);
  // Interval 60 ms (48 units), latency 0, timeout 2 s.
  const update = await gw.host.command(OP.leConnectionUpdate, [
    handle,
    0,
    48,
    0,
    48,
    0,
    0,
    0,
    200,
    0,
    0,
    0,
    0,
    0,
  ]);
  assertEquals(update.status, STATUS.success);
  await r.run(600);
  const ctrl = r.log.events.filter((e) => e.type === "tx" && e.kind === "ble-data" && e.bytes > 2);
  assert(ctrl.length >= 3, "LL_VERSION_IND both ways and LL_CONNECTION_UPDATE_IND");
  // After the update, connection events are 60 ms apart.
  const centralTx = r.log.events.filter((e) =>
    e.type === "tx" && e.node === "gw" && e.kind === "ble-data"
  );
  const gaps = centralTx.slice(-4).map((e, i, all) => (i ? e.t - all[i - 1]!.t : 0)).slice(1);
  for (const gap of gaps) assertAlmostEquals(gap, 60, 1);
  // The peripheral kept up: still connected.
  assertEquals(sensor.disconnections.length, 0);
  assertExists(gw.connections[0]);
});

Deno.test("ble controller: frames on the air are BLE frames with the PHY's airtime", () => {
  const frame = {
    kind: "ble-adv" as const,
    payload: new Uint8Array(8),
    airtimeMs: 0.128,
    frequencyHz: 2402e6,
    bandwidthHz: 1e6,
    noiseFigureDb: 10,
    requiredSnrDb: 0,
    referenceBytes: 39,
    captureDb: 10,
    txPowerDbm: 0,
    interferenceKey: "ble:37",
    rateBps: 1e6,
    dst: "",
    src: "",
    params: {},
    header: { channel: 37, accessAddress: 0x8e89bed6, crcInit: 0x555555, acl: null },
  };
  assert(isBleFrame(frame));
  assert(!isBleFrame({ ...frame, kind: "lora" }));
});

Deno.test({
  name:
    "ble hci: BlueZ's btmon reads the Supported Commands bitmap back as the commands the controller answers",
  ignore: !(await commandExists("btmon", ["--version"])),
  fn: async () => {
    const snoop = new BtsnoopWriter(0);
    snoop.add(
      0,
      "host-to-controller",
      encodeHci({ type: "command", opcode: OP.readLocalCommands, params: new Uint8Array() }),
    );
    snoop.add(
      1,
      "controller-to-host",
      encodeHci({
        type: "event",
        code: 0x0e,
        params: Uint8Array.from([
          1,
          OP.readLocalCommands & 0xff,
          OP.readLocalCommands >> 8,
          0,
          ...supportedCommands(),
        ]),
      }),
    );
    const file = await Deno.makeTempFile({ suffix: ".btsnoop" });
    try {
      await Deno.writeFile(file, snoop.toBytes());
      const out = new TextDecoder().decode(
        (await new Deno.Command("btmon", { args: ["-r", file] }).output()).stdout,
      );
      assert(out.includes(`Commands: ${SUPPORTED_COMMAND_BITS.length} entries`), out);
      for (
        const name of [
          "Reset (Octet 5 - Bit 7)",
          "LE Create Connection (Octet 26 - Bit 4)",
          "LE Read Supported States (Octet 28 - Bit 3)",
        ]
      ) {
        assert(out.includes(name), `${name} missing from:\n${out}`);
      }
    } finally {
      await Deno.remove(file);
    }
  },
});

Deno.test("ble controller: on a lossy link every packet still arrives once and in order, after retransmissions", async () => {
  const r = rig({ gw: [0, 0], sensor: [4, 0] });
  const { gw, sensor } = await connected(r, 30, 2000);
  r.air.setLinkOverride("sensor", "gw", { extraLossPct: 30, extraLatencyMs: 0 });
  r.air.setLinkOverride("gw", "sensor", { extraLossPct: 30, extraLatencyMs: 0 });
  for (let i = 0; i < 20; i++) sensor.host.sendAtt(sensor.connections[0]!.handle, att(`r${i}`));
  await r.run(3000);
  assertEquals(gw.att.map((a) => a.text), Array.from({ length: 20 }, (_, i) => `r${i}`));
  const acl = kinds(r.log.events, "ble-acl");
  assertEquals(acl.length, 20);
  const retried = acl.filter((e) => e.type === "deliver" && e.attempts > 1);
  assert(retried.length > 0, "some packets needed more than one transmission");
  const lostOnAir = kinds(r.log.events, "ble-data").filter((e) => e.type === "drop");
  assert(lostOnAir.length > 10, `air drops: ${lostOnAir.length}`);
  assertEquals(gw.disconnections.length, 0);
});
