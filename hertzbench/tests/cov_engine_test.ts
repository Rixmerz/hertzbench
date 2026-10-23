// Edge cases, invalid input and error paths of the RF engine: packet parsing,
// the event log, the seeded RNG, the clocks, the channel model (path loss,
// jitter, interference, walls), the Wi-Fi medium, ESP-NOW and the chip-level air.

import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import {
  type AirFrame,
  AirMedium,
  type AirReceiver,
  airtimeUs,
  bleChannelFrequencyHz,
  BROADCAST_MAC,
  buildArp,
  buildDhcpClientMessage,
  buildEspNowAck,
  buildEspNowAction,
  buildEspNowBody,
  buildEthernet,
  buildTcpFrame,
  buildUdp,
  chipPacketErrorRate,
  classifyFrame,
  createRng,
  describeLora,
  distanceM,
  environmentFromPreset,
  ESPNOW_MAX_PAYLOAD_BYTES,
  espnowToRadiotap,
  EVENT_TYPES,
  EventLog,
  freeSpaceLossDb,
  type Hearing,
  internetChecksum,
  ipToBytes,
  ipToString,
  isGroupMac,
  isPresetName,
  type LinkBudget,
  linkStats,
  macToBytes,
  macToString,
  ManualClock,
  noiseFloorDbm,
  nrf24BandwidthHz,
  nrf24ChannelFrequencyHz,
  nrf24SensitivityDbm,
  obstacleLossDb,
  PacedClock,
  packetErrorRate,
  parseArp,
  parseEspNow,
  parseEspNowBody,
  parseEthernet,
  parseIpv4,
  parseTcp,
  parseUdp,
  pathLossDb,
  percentile,
  pickRate,
  sameLoraChannel,
  segmentsIntersect,
  simulateFrame,
  substream,
  TCP_FLAG,
  tcpChecksum,
  VirtualGateway,
  WallClock,
  WIFI_RATES,
  wifiChannelFrequencyHz,
  withInterference,
} from "../engine/mod.ts";
import { GATEWAY_IP, GATEWAY_MAC, macOf, makeRig, udpFrame, until } from "./helpers.ts";

const A = "02:68:7a:62:01:01";
const B = "02:68:7a:62:01:02";

/** An Ethernet frame carrying an IPv4 header with the given protocol and fields. */
function ipv4Frame(
  protocol: number,
  opts: { ihl?: number; totalLength?: number; payload?: number[] } = {},
): Uint8Array {
  const payload = opts.payload ?? [];
  const ihl = opts.ihl ?? 5;
  const header = new Uint8Array(20);
  header[0] = 0x40 | ihl;
  const total = opts.totalLength ?? 20 + payload.length;
  header[2] = total >> 8;
  header[3] = total & 0xff;
  header[9] = protocol;
  header.set([10, 0, 0, 1], 12);
  header.set([10, 0, 0, 2], 16);
  return buildEthernet(B, A, 0x0800, Uint8Array.from([...header, ...payload]));
}

// ── packet: addresses ───────────────────────────────────────────────────────

Deno.test("macToBytes: rejects an octet that is not exactly two hex digits", () => {
  for (
    const mac of [
      "0g:00:00:00:00:00",
      "+1:00:00:00:00:00",
      "-0:00:00:00:00:00",
      " 1:00:00:00:00:00",
    ]
  ) {
    assertThrows(() => macToBytes(mac), TypeError, "not a MAC address", mac);
  }
});

Deno.test("macToBytes: five or seven octets, three-digit octets and empty strings are not MACs", () => {
  for (
    const mac of ["", "00:11:22:33:44", "00:11:22:33:44:55:66", "000:11:22:33:44:55", "0:1:2:3:4:5"]
  ) {
    assertThrows(() => macToBytes(mac), TypeError, "not a MAC address", mac);
  }
});

Deno.test("macToBytes: either case is accepted and macToString gives lower case back", () => {
  const bytes = macToBytes("AA:bb:0C:dD:ee:FF");
  assertEquals(Array.from(bytes), [0xaa, 0xbb, 0x0c, 0xdd, 0xee, 0xff]);
  assertEquals(macToString(bytes), "aa:bb:0c:dd:ee:ff");
  assertEquals(macToString(Uint8Array.of(9, 1, 2, 3, 4, 5, 6), 1), "01:02:03:04:05:06");
});

Deno.test("ipToBytes: rejects missing octets, extra octets, signs, letters and values over 255", () => {
  for (
    const ip of [
      "",
      "1.2.3",
      "1.2.3.4.5",
      "256.0.0.1",
      "1.2.3.-4",
      "a.b.c.d",
      "1.2.3.4 ",
      "1..2.3",
      "1000.1.1.1",
    ]
  ) {
    assertThrows(() => ipToBytes(ip), TypeError, "not an IPv4 address", ip);
  }
  assertEquals(Array.from(ipToBytes("0.0.0.0")), [0, 0, 0, 0]);
  assertEquals(Array.from(ipToBytes("255.255.255.255")), [255, 255, 255, 255]);
  assertEquals(ipToString(Uint8Array.of(0, 192, 168, 4, 1), 1), "192.168.4.1");
});

Deno.test("isGroupMac: the low bit of the first octet marks broadcast and multicast", () => {
  assertEquals(isGroupMac(BROADCAST_MAC), true);
  assertEquals(isGroupMac("01:00:5e:00:00:fb"), true);
  assertEquals(isGroupMac("33:33:00:00:00:01"), true);
  assertEquals(isGroupMac(A), false);
});

// ── packet: parsers ─────────────────────────────────────────────────────────

Deno.test("parseEthernet: 13 bytes is too short, 14 is a header", () => {
  assertEquals(parseEthernet(new Uint8Array(13)), null);
  assertEquals(parseEthernet(buildEthernet(B, A, 0x88b5, new Uint8Array(0))), {
    dst: B,
    src: A,
    etherType: 0x88b5,
  });
});

Deno.test("parseIpv4: not IPv4, a truncated header, an IHL under 5 or past the frame are refused", () => {
  assertEquals(parseIpv4(new Uint8Array(10)), null, "shorter than Ethernet");
  assertEquals(parseIpv4(buildEthernet(B, A, 0x0806, new Uint8Array(28))), null, "ARP");
  assertEquals(parseIpv4(buildEthernet(B, A, 0x0800, new Uint8Array(19))), null, "19-byte header");
  assertEquals(parseIpv4(ipv4Frame(17, { ihl: 4 })), null, "IHL 4 is 16 bytes");
  assertEquals(parseIpv4(ipv4Frame(17, { ihl: 15 })), null, "IHL 15 is 60 bytes, frame has 20");
});

Deno.test("parseIpv4: the payload ends at the total length, or at the frame when it claims more", () => {
  const padded = ipv4Frame(17, { payload: [1, 2, 3, 4, 5, 6, 7, 8, 9, 9], totalLength: 28 });
  const ip = parseIpv4(padded)!;
  assertEquals([ip.payloadOffset, ip.payloadEnd], [34, 42], "Ethernet padding is not payload");
  const overlong = parseIpv4(ipv4Frame(17, { payload: [1, 2], totalLength: 1500 }))!;
  assertEquals(overlong.payloadEnd, 36);
  assertEquals([overlong.src, overlong.dst, overlong.protocol], ["10.0.0.1", "10.0.0.2", 17]);
});

Deno.test("parseUdp: another protocol or fewer than 8 bytes of UDP header is not a datagram", () => {
  const tcp = ipv4Frame(6, { payload: new Array(20).fill(0) });
  assertEquals(parseUdp(tcp, parseIpv4(tcp)!), null);
  const short = ipv4Frame(17, { payload: [0, 1, 0, 2, 0, 8, 0] });
  assertEquals(parseUdp(short, parseIpv4(short)!), null);
  const empty = ipv4Frame(17, { payload: [0x13, 0x88, 0x00, 0x35, 0, 8, 0, 0] });
  const udp = parseUdp(empty, parseIpv4(empty)!)!;
  assertEquals([udp.srcPort, udp.dstPort, udp.payload.length], [5000, 53, 0]);
});

Deno.test("classifyFrame: every kind the log knows, and 'other' for what it cannot read", () => {
  assertEquals(classifyFrame(new Uint8Array(5)), "other");
  assertEquals(classifyFrame(buildEthernet(B, A, 0x86dd, new Uint8Array(40))), "other");
  assertEquals(classifyFrame(buildEthernet(B, A, 0x0800, new Uint8Array(4))), "other");
  assertEquals(classifyFrame(buildEthernet(B, A, 0x0806, new Uint8Array(28))), "arp");
  assertEquals(classifyFrame(ipv4Frame(6)), "tcp");
  assertEquals(classifyFrame(ipv4Frame(1)), "icmp");
  assertEquals(classifyFrame(ipv4Frame(47)), "ipv4");
  assertEquals(classifyFrame(ipv4Frame(17, { payload: [0, 1, 0, 2] })), "udp", "truncated UDP");
  const udp = (dstPort: number) =>
    buildUdp({
      srcMac: A,
      dstMac: B,
      srcIp: "10.0.0.1",
      dstIp: "10.0.0.2",
      srcPort: 1234,
      dstPort,
      payload: new Uint8Array(4),
    });
  assertEquals(classifyFrame(udp(67)), "dhcp");
  assertEquals(classifyFrame(udp(68)), "dhcp");
  assertEquals(classifyFrame(udp(69)), "udp");
  assertEquals(
    classifyFrame(
      buildEspNowAction({ dst: B, src: A, channel: 1, body: buildEspNowBody(Uint8Array.of(1)) }),
    ),
    "espnow",
  );
  assertEquals(classifyFrame(buildEspNowAck({ dst: A, src: B, channel: 1 })), "espnow-ack");
});

Deno.test("internetChecksum: an odd trailing byte is padded with zero, and a valid header sums to 0", () => {
  assertEquals(internetChecksum(new Uint8Array(0)), 0xffff);
  assertEquals(internetChecksum(Uint8Array.of(0x01)), 0xfeff);
  assertEquals(internetChecksum(Uint8Array.of(0xff, 0xff, 0xff, 0xff)), 0x0000, "carry folds back");
  const frame = buildUdp({
    srcMac: A,
    dstMac: B,
    srcIp: "192.168.4.10",
    dstIp: "192.168.4.11",
    srcPort: 1,
    dstPort: 2,
    payload: Uint8Array.of(1, 2, 3),
  });
  assertEquals(internetChecksum(frame.subarray(14, 34)), 0);
});

Deno.test("parseArp: not ARP, short, or an operation other than request and reply is refused", () => {
  const request = buildArp({
    operation: 1,
    senderMac: A,
    senderIp: "10.0.0.1",
    targetMac: "00:00:00:00:00:00",
    targetIp: "10.0.0.2",
  });
  assertEquals(parseEthernet(request)!.dst, BROADCAST_MAC, "a request is broadcast");
  assertEquals(parseArp(request)!.targetIp, "10.0.0.2");
  const reply = buildArp({
    operation: 2,
    senderMac: B,
    senderIp: "10.0.0.2",
    targetMac: A,
    targetIp: "10.0.0.1",
  });
  assertEquals(parseEthernet(reply)!.dst, A, "a reply goes to the asker");
  assertEquals(parseArp(reply)!.operation, 2);
  const op3 = request.slice();
  op3[21] = 3;
  assertEquals(parseArp(op3), null);
  assertEquals(parseArp(request.subarray(0, 41)), null, "one byte short");
  assertEquals(parseArp(ipv4Frame(17, { payload: new Array(28).fill(0) })), null);
});

Deno.test("buildDhcpClientMessage: a REQUEST carries option 50 with the address it asks for", () => {
  const frame = buildDhcpClientMessage(A, 3, 0x01020304, "192.168.4.20");
  const ip = parseIpv4(frame)!;
  const body = parseUdp(frame, ip)!.payload;
  assertEquals(Array.from(body.subarray(240, 250)), [53, 1, 3, 50, 4, 192, 168, 4, 20, 255]);
  assertEquals(Array.from(body.subarray(4, 8)), [1, 2, 3, 4]);
  const discover = parseUdp(buildDhcpClientMessage(A, 1, 7), ip)!.payload;
  assertEquals(
    Array.from(discover.subarray(240, 244)),
    [53, 1, 1, 255],
    "no option 50 without an address",
  );
});

// ── events ──────────────────────────────────────────────────────────────────

Deno.test("EventLog: an empty log is an empty JSONL file, a non-empty one ends in a newline", () => {
  const log = new EventLog();
  assertEquals(log.toJsonl(), "");
  log.append({ type: "phase", t: 1, label: "x" });
  assertEquals(log.toJsonl(), '{"type":"phase","t":1,"label":"x","seq":0}\n');
});

Deno.test("EventLog: a time earlier than the last one is stamped with the later time, seq counts up", () => {
  const log = new EventLog();
  log.append({ type: "phase", t: 10, label: "a" });
  log.append({ type: "phase", t: 4, label: "b" });
  log.append({ type: "phase", t: 12, label: "c" });
  assertEquals(log.events.map((e) => [e.t, e.seq]), [[10, 0], [10, 1], [12, 2]]);
  assert(EVENT_TYPES.includes("deliver") && EVENT_TYPES.includes("drop"));
});

// ── rng ─────────────────────────────────────────────────────────────────────

Deno.test("rng: int() refuses a bound that is not a positive integer", () => {
  const rng = createRng(1);
  for (const bound of [0, -1, 1.5, Number.NaN, Infinity]) {
    assertThrows(() => rng.int(bound), RangeError, "positive integer bound", String(bound));
  }
  for (let i = 0; i < 50; i++) assertEquals(rng.int(1), 0);
});

Deno.test("rng: a seed reproduces its stream, a number and its string are the same seed", () => {
  const a = createRng(42);
  const b = createRng("42");
  const c = createRng(43);
  const seqA = Array.from({ length: 20 }, () => a.next());
  assertEquals(Array.from({ length: 20 }, () => b.next()), seqA);
  assert(Array.from({ length: 20 }, () => c.next()).some((v, i) => v !== seqA[i]));
  for (const v of seqA) assert(v >= 0 && v < 1, `${v} out of [0, 1)`);
});

Deno.test("rng: int() covers its whole range and nothing outside it", () => {
  const rng = createRng("cover");
  const seen = new Set<number>();
  for (let i = 0; i < 2000; i++) seen.add(rng.int(7));
  assertEquals([...seen].sort(), [0, 1, 2, 3, 4, 5, 6]);
});

Deno.test("rng: gaussian() has mean 0 and deviation 1, and pairs come from one draw", () => {
  const rng = createRng(7);
  const n = 20000;
  const xs = Array.from({ length: n }, () => rng.gaussian());
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / n);
  assertAlmostEquals(mean, 0, 0.03);
  assertAlmostEquals(sd, 1, 0.03);
  // Box-Muller gives two values per two uniforms: four gaussians use four uniforms.
  const g = createRng(9);
  const u = createRng(9);
  for (let i = 0; i < 4; i++) g.gaussian();
  for (let i = 0; i < 4; i++) u.next();
  assertEquals(g.next(), u.next());
});

Deno.test("rng: substreams are keyed by seed and label, independent of each other", () => {
  const first = substream(5, "frame:a>b#0").next();
  substream(5, "other").next();
  assertEquals(substream(5, "frame:a>b#0").next(), first);
  assertEquals(createRng("5:frame:a>b#0").next(), first);
  assert(substream(5, "frame:a>b#1").next() !== first);
  assert(substream(6, "frame:a>b#0").next() !== first);
});

// ── clocks ──────────────────────────────────────────────────────────────────

Deno.test("ManualClock: time never moves back, and a past deadline runs at the current time", () => {
  const clock = new ManualClock();
  clock.advanceTo(10);
  assertThrows(() => clock.advanceTo(9), RangeError, "cannot move time back");
  const ran: number[] = [];
  clock.schedule(3, () => ran.push(clock.now()));
  clock.advanceBy(0);
  assertEquals(ran, [10]);
});

Deno.test("ManualClock: same-time callbacks run in call order, cancelled ones never, nextDueMs tracks them", () => {
  const clock = new ManualClock();
  assertEquals(clock.nextDueMs(), null);
  const order: string[] = [];
  clock.schedule(5, () => order.push("a"));
  const cancel = clock.schedule(2, () => order.push("cancelled"));
  clock.schedule(5, () => order.push("b"));
  clock.schedule(1, () => order.push("first"));
  assertEquals(clock.nextDueMs(), 1);
  cancel();
  clock.advanceTo(4);
  assertEquals(order, ["first"]);
  assertEquals(clock.nextDueMs(), 5);
  clock.advanceTo(5);
  assertEquals(order, ["first", "a", "b"]);
  clock.schedule(100, () => order.push("late"));
  clock.cancelAll();
  clock.runAll();
  assertEquals(order, ["first", "a", "b"]);
  assertEquals(clock.now(), 5);
});

Deno.test("ManualClock: runAll runs callbacks scheduled by callbacks, however far ahead", () => {
  const clock = new ManualClock();
  const seen: number[] = [];
  clock.schedule(1000, () => {
    seen.push(clock.now());
    clock.schedule(5000, () => seen.push(clock.now()));
  });
  clock.runAll();
  assertEquals(seen, [1000, 5000]);
});

Deno.test("WallClock: a scheduled callback runs, a cancelled one does not, cancelAll clears the rest", async () => {
  const clock = new WallClock();
  assertEquals(clock.kind, "wall");
  let ran = 0;
  let cancelledRan = false;
  clock.schedule(clock.now() + 1, () => ran++);
  clock.schedule(clock.now() + 1, () => (cancelledRan = true))();
  await until(() => ran === 1, "the wall-clock callback");
  clock.schedule(clock.now() + 60_000, () => (cancelledRan = true));
  clock.cancelAll();
  assertEquals(cancelledRan, false);
});

Deno.test("PacedClock: callbacks run in due order and each sees its own due time", async () => {
  const clock = new PacedClock();
  const base = clock.now();
  const seen: [string, number][] = [];
  clock.schedule(base + 3, () => seen.push(["late", clock.now()]));
  clock.schedule(base + 1, () => {
    seen.push(["early", clock.now()]);
    // Sub-millisecond chains keep their order against the later deadline.
    clock.schedule(clock.now() + 0.13, () => seen.push(["chained", clock.now()]));
  });
  const cancel = clock.schedule(base + 2, () => seen.push(["cancelled", clock.now()]));
  cancel();
  await until(() => seen.length === 3, "three paced callbacks");
  assertEquals(seen.map(([name]) => name), ["early", "chained", "late"]);
  assertEquals(seen[0]![1], base + 1);
  assertAlmostEquals(seen[1]![1], base + 1.13, 1e-9);
  assertEquals(seen[2]![1], base + 3);
  assert(clock.now() >= base + 3, "outside a callback now() is real time");
  clock.schedule(clock.now() + 60_000, () => seen.push(["never", 0]));
  clock.cancelAll();
  assertEquals(seen.length, 3);
});

// ── channel: path loss, noise, walls ────────────────────────────────────────

Deno.test("wifiChannelFrequencyHz: channels 1-14 only, 14 off the 5 MHz raster", () => {
  assertEquals(wifiChannelFrequencyHz(1), 2412e6);
  assertEquals(wifiChannelFrequencyHz(13), 2472e6);
  assertEquals(wifiChannelFrequencyHz(14), 2484e6);
  for (const ch of [0, 15, 6.5, -1]) {
    assertThrows(() => wifiChannelFrequencyHz(ch), RangeError, "1-14", String(ch));
  }
});

Deno.test("path loss: flat below the reference distance, +10n dB per decade above it", () => {
  const env = environmentFromPreset("indoor_office", { referenceDistanceM: 1 });
  const f = 2.437e9;
  assertAlmostEquals(freeSpaceLossDb(f, 1), 40.18, 0.01);
  assertEquals(pathLossDb(env, f, 0), pathLossDb(env, f, 1));
  assertEquals(pathLossDb(env, f, 0.3), pathLossDb(env, f, 1));
  assertAlmostEquals(
    pathLossDb(env, f, 10) - pathLossDb(env, f, 1),
    10 * env.pathLossExponent,
    1e-9,
  );
  const far = environmentFromPreset("indoor_office", { referenceDistanceM: 5 });
  assertEquals(pathLossDb(far, f, 2), freeSpaceLossDb(f, 5));
});

Deno.test("noise floor: -174 dBm/Hz over the bandwidth plus the noise figure, 20 MHz by default", () => {
  assertAlmostEquals(noiseFloorDbm(10), -174 + 73.0103 + 10, 1e-3);
  assertAlmostEquals(noiseFloorDbm(6, 125e3), -174 + 50.9691 + 6, 1e-3);
});

Deno.test("distanceM: includes height when either end has one", () => {
  assertEquals(distanceM({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  assertEquals(distanceM({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 2 }), 2);
  assertEquals(distanceM({ x: 0, y: 0 }, { x: 0, y: 0, z: 12 }), 12);
});

Deno.test("walls: each wall the line crosses adds its loss; touching an end counts, collinear apart does not", () => {
  const wall = (from: [number, number], to: [number, number], attenuationDb: number) => ({
    from,
    to,
    attenuationDb,
  });
  const walls = [wall([5, -5], [5, 5], 6), wall([7, -5], [7, 5], 10), wall([20, -5], [20, 5], 99)];
  assertEquals(obstacleLossDb({ x: 0, y: 0 }, { x: 10, y: 0 }, walls), 16);
  assertEquals(obstacleLossDb({ x: 0, y: 0 }, { x: 4, y: 0 }, walls), 0);
  assertEquals(obstacleLossDb({ x: 0, y: 0 }, { x: 5, y: 0 }, walls), 6, "ends on the wall");
  assertEquals(obstacleLossDb({ x: 0, y: 0 }, { x: 10, y: 0 }, []), 0);
  // Collinear segments: overlapping touch, disjoint do not.
  assert(segmentsIntersect([0, 0], [4, 0], [2, 0], [6, 0]));
  assert(segmentsIntersect([2, 0], [6, 0], [0, 0], [4, 0]));
  assert(!segmentsIntersect([0, 0], [1, 0], [2, 0], [3, 0]));
  assert(!segmentsIntersect([0, 0], [1, 1], [0, 1], [1, 2]), "parallel");
  assert(segmentsIntersect([0, 0], [2, 2], [1, 1], [5, -3]), "the end of one lies on the other");
});

Deno.test("presets: names are checked, overrides win over the preset", () => {
  assertEquals(isPresetName("free_space"), true);
  assertEquals(isPresetName("toString"), false, "an inherited key is not a preset");
  assertEquals(isPresetName("mars"), false);
  const env = environmentFromPreset("free_space", { shadowingSigmaDb: 0, baseLatencyMs: 2 });
  assertEquals([env.preset, env.shadowingSigmaDb, env.baseLatencyMs], ["free_space", 0, 2]);
  assertEquals(env.referenceDistanceM, 1);
});

// ── channel: interference, rates, error rate ────────────────────────────────

const budgetAt = (snrDb: number, distance = 10): LinkBudget => ({
  distanceM: distance,
  pathLossDb: 60,
  obstacleLossDb: 0,
  shadowingDb: 0,
  rssiDbm: -91 + snrDb,
  noiseFloorDbm: -91,
  snrDb,
});

Deno.test("interference: zero is the same budget, otherwise the floor rises and the SNR falls by as much", () => {
  const budget = budgetAt(30);
  assert(withInterference(budget, 0) === budget);
  const hit = withInterference(budget, 12);
  assertEquals([hit.rssiDbm, hit.noiseFloorDbm, hit.snrDb], [budget.rssiDbm, -79, 18]);
});

Deno.test("pickRate: the lowest rate below every threshold, each threshold picks its own rate", () => {
  assertEquals(pickRate(-50).mbps, 6);
  assertEquals(pickRate(Number.NEGATIVE_INFINITY).mbps, 6);
  for (const rate of WIFI_RATES) assertEquals(pickRate(rate.minSnrDb).mbps, rate.mbps);
  assertEquals(pickRate(20.99).mbps, 24);
  assertEquals(pickRate(99).mbps, 54);
});

Deno.test("error rate: 10% for a reference frame at threshold, falling with SNR, rising with length", () => {
  const rate = WIFI_RATES[0]!;
  assertAlmostEquals(packetErrorRate(rate.minSnrDb, rate, 1000), 0.1, 1e-12);
  assert(packetErrorRate(rate.minSnrDb + 3, rate, 1000) < 0.01);
  assert(packetErrorRate(rate.minSnrDb - 6, rate, 100) > 0.99);
  assert(packetErrorRate(rate.minSnrDb, rate, 100) < packetErrorRate(rate.minSnrDb, rate, 1000));
  assertAlmostEquals(chipPacketErrorRate(5, 5, 20, 20), 0.1, 1e-12);
  assertEquals(
    chipPacketErrorRate(5, 5, 0, 20),
    chipPacketErrorRate(5, 5, 1, 20),
    "an empty frame counts as one byte",
  );
});

Deno.test("airtimeUs: a frame shorter than an Ethernet header costs the MAC overhead only", () => {
  const rate = WIFI_RATES[0]!;
  assertEquals(airtimeUs(0, rate), airtimeUs(14, rate));
  assert(airtimeUs(1514, rate) > airtimeUs(64, rate));
  assert(airtimeUs(1514, WIFI_RATES[7]!) < airtimeUs(1514, rate));
});

const quietEnv = environmentFromPreset("free_space", { jitterBaseMs: 0, jitterPerMeterMs: 0 });
const tx = (over: Partial<Parameters<typeof simulateFrame>[2]> = {}) => ({
  frameBytes: 100,
  broadcast: false,
  retryLimit: 7,
  extraLossPct: 0,
  extraLatencyMs: 0,
  ...over,
});

Deno.test("simulateFrame: a broadcast goes once at the basic rate, a dead link exhausts every retry", () => {
  const strong = budgetAt(40);
  const bc = simulateFrame(quietEnv, strong, tx({ broadcast: true }), createRng(1));
  assertEquals([bc.delivered, bc.attempts, bc.rateMbps], [true, 1, 6]);
  const dead = simulateFrame(quietEnv, budgetAt(-20), tx({ retryLimit: 4 }), createRng(1));
  assertEquals([dead.delivered, dead.reason, dead.attempts], [false, "retry_exhausted", 4]);
  const once = simulateFrame(quietEnv, budgetAt(-20), tx({ retryLimit: 0 }), createRng(1));
  assertEquals(once.attempts, 1, "a retry limit under 1 still sends once");
  const deadBc = simulateFrame(quietEnv, budgetAt(-20), tx({ broadcast: true }), createRng(1));
  assertEquals([deadBc.reason, deadBc.attempts], ["retry_exhausted", 1]);
});

Deno.test("simulateFrame: 100% extra loss drops a frame the MAC delivered, 0% never does", () => {
  const strong = budgetAt(40);
  const lost = simulateFrame(quietEnv, strong, tx({ extraLossPct: 100 }), createRng(2));
  assertEquals([lost.delivered, lost.reason, lost.attempts], [false, "extra_loss", 1]);
  const kept = simulateFrame(quietEnv, strong, tx({ extraLossPct: 0 }), createRng(2));
  assertEquals(kept.delivered, true);
});

Deno.test("simulateFrame: jitter stays within base plus per-metre, extra latency and jitter add on top", () => {
  const env = environmentFromPreset("free_space", { jitterBaseMs: 2, jitterPerMeterMs: 0.1 });
  const budget = budgetAt(40, 30);
  const floor = simulateFrame(quietEnv, budget, tx(), createRng(3)).delayMs;
  let min = Infinity;
  let max = -Infinity;
  for (let seed = 0; seed < 300; seed++) {
    const d = simulateFrame(env, budget, tx(), createRng(seed)).delayMs;
    min = Math.min(min, d);
    max = Math.max(max, d);
  }
  // Backoff varies too, so bound the jitter loosely: at most 2 + 0.1 * 30 = 5 ms above the floor plus backoff.
  assert(min >= floor - 0.2, `min ${min} below floor ${floor}`);
  assert(max - min > 2, "jitter spreads the delays");
  assert(max < floor + 5 + 0.2, `max ${max}`);
  const plain = simulateFrame(quietEnv, budget, tx(), createRng(4)).delayMs;
  const late = simulateFrame(quietEnv, budget, tx({ extraLatencyMs: 25 }), createRng(4)).delayMs;
  assertAlmostEquals(late - plain, 25, 1e-9);
  const jittered = simulateFrame(quietEnv, budget, tx({ extraJitterMs: 50 }), createRng(4)).delayMs;
  assert(jittered >= plain && jittered <= plain + 50);
});

// ── chip PHYs: LoRa, nRF24, BLE ─────────────────────────────────────────────

Deno.test("lora: same channel needs the same bandwidth and a carrier within a quarter of it", () => {
  const base = { frequencyHz: 868.1e6, bandwidthHz: 125e3 };
  assert(sameLoraChannel(base, { frequencyHz: 868.1e6 + 31.25e3, bandwidthHz: 125e3 }));
  assert(!sameLoraChannel(base, { frequencyHz: 868.1e6 + 31.26e3, bandwidthHz: 125e3 }));
  assert(!sameLoraChannel(base, { frequencyHz: 868.1e6, bandwidthHz: 250e3 }));
  assertEquals(
    describeLora({ frequencyHz: 868.1e6, sf: 9, bandwidthHz: 125e3, codingRate: 3 }),
    "868.1 MHz SF9 BW125 CR4/7",
  );
});

Deno.test("nrf24: channels 0-125, bandwidth and sensitivity per data rate", () => {
  assertEquals(nrf24ChannelFrequencyHz(0), 2400e6);
  assertEquals(nrf24ChannelFrequencyHz(125), 2525e6);
  for (const ch of [-1, 126, 2.5]) {
    assertThrows(() => nrf24ChannelFrequencyHz(ch), RangeError, "0-125", String(ch));
  }
  assertEquals([
    nrf24BandwidthHz(250_000),
    nrf24BandwidthHz(1_000_000),
    nrf24BandwidthHz(2_000_000),
  ], [1e6, 1e6, 2e6]);
  assertEquals([nrf24SensitivityDbm(250_000), nrf24SensitivityDbm(2_000_000)], [-94, -82]);
});

Deno.test("ble: a channel index outside 0-39 is refused", () => {
  for (const ch of [-1, 40, 1.5]) {
    assertThrows(() => bleChannelFrequencyHz(ch), RangeError, "0-39", String(ch));
  }
});

// ── metrics ─────────────────────────────────────────────────────────────────

Deno.test("percentile: nearest rank, clamped to the list, an empty list is an error", () => {
  assertThrows(() => percentile([], 50), RangeError, "empty list");
  assertEquals(percentile([1, 2, 3, 4], 0), 1);
  assertEquals(percentile([1, 2, 3, 4], 50), 2);
  assertEquals(percentile([1, 2, 3, 4], 100), 4);
  assertEquals(percentile([1, 2, 3, 4], 250), 4);
});

Deno.test("linkStats: a kind filter keeps only that kind, a window keeps [from, to)", () => {
  const rig = makeRig({
    positions: { a: { x: 0, y: 0 }, b: { x: 3, y: 0 } },
    environment: quietEnv,
  });
  rig.medium.transmit("a", udpFrame(rig, "a", "b"));
  rig.clock.advanceTo(100);
  rig.medium.transmit(
    "a",
    buildArp({
      operation: 2,
      senderMac: macOf(rig, "a"),
      senderIp: "10.0.0.1",
      targetMac: macOf(rig, "b"),
      targetIp: "10.0.0.2",
    }),
  );
  rig.clock.runAll();
  assertEquals(linkStats(rig.log.events).map((l) => l.sent), [2]);
  assertEquals(linkStats(rig.log.events, { kind: "udp" }).map((l) => l.sent), [1]);
  assertEquals(linkStats(rig.log.events, { kind: "espnow" }), []);
  assertEquals(linkStats(rig.log.events, { fromMs: 50 }).map((l) => l.sent), [1]);
  assertEquals(linkStats(rig.log.events, { toMs: 50 }).map((l) => l.sent), [1]);
  assertEquals(linkStats(rig.log.events, { fromMs: 0, toMs: 0 }), []);
});

// ── medium: invalid input ───────────────────────────────────────────────────

Deno.test("medium: a duplicate id, a duplicate MAC and an unknown node are refused", () => {
  const rig = makeRig({ positions: { a: { x: 0, y: 0 }, b: { x: 3, y: 0 } } });
  const sink = { ready: () => true, deliver: () => {} };
  const radio = { channel: 6, txPowerDbm: 15, antennaGainDbi: 0 };
  assertThrows(
    () =>
      rig.medium.addNode(
        { id: "a", mac: "02:00:00:00:00:99", position: { x: 0, y: 0 }, radio },
        sink,
      ),
    Error,
    'duplicate node id "a"',
  );
  assertThrows(
    () =>
      rig.medium.addNode({ id: "c", mac: macOf(rig, "b"), position: { x: 0, y: 0 }, radio }, sink),
    Error,
    "same MAC",
  );
  assertThrows(() => rig.medium.node("zz"), Error, 'unknown node "zz"');
  assertThrows(() => rig.medium.transmit("zz", udpFrame(rig, "a", "b")), Error, "unknown node");
  assertThrows(() => rig.medium.moveNode("zz", { x: 0, y: 0 }), Error, "unknown node");
  assertThrows(
    () => rig.medium.setLinkOverride("a", "zz", { extraLossPct: 0, extraLatencyMs: 0 }),
    Error,
    "unknown node",
  );
  assertThrows(() => rig.medium.setRadio("zz", { channel: 1 }), Error, "unknown node");
  assertThrows(() => rig.medium.budget("zz", "a"), Error, "unknown node");
  assertEquals(rig.medium.nodeIds, ["a", "b"]);
});

Deno.test("medium: a frame shorter than an Ethernet header is not on the air at all", () => {
  const rig = makeRig({ positions: { a: { x: 0, y: 0 }, b: { x: 3, y: 0 } } });
  rig.medium.transmit("a", new Uint8Array(13));
  rig.clock.runAll();
  assertEquals(rig.log.events.length, 0);
  assertEquals(rig.sinks.get("b")!.frames.length, 0);
});

Deno.test("medium: interference on a link lowers its SNR in the budget and on the frame's events", () => {
  const rig = makeRig({
    positions: { a: { x: 0, y: 0 }, b: { x: 3, y: 0 } },
    environment: quietEnv,
  });
  const clean = rig.medium.budget("a", "b");
  rig.medium.setLinkOverride("a", "b", { extraLossPct: 0, extraLatencyMs: 0, interferenceDb: 20 });
  const noisy = rig.medium.budget("a", "b");
  assertEquals(noisy.rssiDbm, clean.rssiDbm);
  assertAlmostEquals(noisy.snrDb, clean.snrDb - 20, 1e-9);
  assertEquals(rig.medium.budget("b", "a").snrDb, clean.snrDb, "the reverse link is untouched");
  rig.medium.transmit("a", udpFrame(rig, "a", "b"));
  const deliver = rig.log.events.find((e) => e.type === "deliver");
  assert(deliver?.type === "deliver");
  assertAlmostEquals(deliver.snrDb, clean.snrDb - 20, 1e-9);
});

Deno.test("medium: a frame to the gateway's MAC that it does not answer goes nowhere", () => {
  const gateway = new VirtualGateway({
    mac: GATEWAY_MAC,
    ip: GATEWAY_IP,
    subnetMask: "255.255.255.0",
    leases: new Map(),
  });
  const rig = makeRig({ positions: { a: { x: 0, y: 0 }, b: { x: 3, y: 0 } }, gateway });
  rig.medium.transmit("a", buildEthernet(GATEWAY_MAC, macOf(rig, "a"), 0x88b5, new Uint8Array(30)));
  rig.clock.runAll();
  assertEquals(rig.log.events.map((e) => e.type), ["tx"]);
  assertEquals(rig.sinks.get("b")!.frames.length, 0);
});

Deno.test("medium: the gateway's own malformed-DHCP answer is logged and nothing is relayed", () => {
  const gateway = new VirtualGateway({
    mac: GATEWAY_MAC,
    ip: GATEWAY_IP,
    subnetMask: "255.255.255.0",
    leases: new Map(),
  });
  const rig = makeRig({ positions: { a: { x: 0, y: 0 }, b: { x: 3, y: 0 } }, gateway });
  const bad = buildUdp({
    srcMac: macOf(rig, "a"),
    dstMac: BROADCAST_MAC,
    srcIp: "0.0.0.0",
    dstIp: "255.255.255.255",
    srcPort: 68,
    dstPort: 67,
    payload: new Uint8Array(10),
  });
  rig.medium.transmit("a", bad);
  rig.clock.runAll();
  const service = rig.log.events.find((e) => e.type === "service");
  assert(service?.type === "service");
  assert(service.detail.includes("malformed"));
  assertEquals(rig.sinks.get("b")!.frames.length, 0);
});

Deno.test("gateway: ARP for another address, a reply, and DHCP without a lease get no answer frame", () => {
  const leases = new Map([[A, "192.168.4.20"]]);
  const gw = new VirtualGateway({
    mac: GATEWAY_MAC,
    ip: GATEWAY_IP,
    subnetMask: "255.255.255.0",
    leases,
  });
  const arp = (operation: 1 | 2, targetIp: string) =>
    buildArp({
      operation,
      senderMac: A,
      senderIp: "192.168.4.20",
      targetMac: "00:00:00:00:00:00",
      targetIp,
    });
  assertEquals(gw.handle(arp(1, "192.168.4.99")), null);
  assertEquals(gw.handle(arp(2, GATEWAY_IP)), null);
  assertEquals(gw.handle(arp(1, GATEWAY_IP))!.replies.length, 1);
  assertEquals(gw.handle(ipv4Frame(6)), null, "TCP is not for the gateway");
  assertEquals(gw.handle(new Uint8Array(4)), null);
  const unknown = gw.handle(buildDhcpClientMessage(B, 1, 1))!;
  assertEquals([unknown.service, unknown.replies.length], ["dhcp", 0]);
  assert(unknown.detail.includes("no lease"));
  const nak = gw.handle(buildDhcpClientMessage(A, 3, 1, "192.168.4.77"))!;
  assert(nak.detail.startsWith("nak"));
  assertThrows(
    () => new VirtualGateway({ mac: "nope", ip: GATEWAY_IP, subnetMask: "255.255.255.0", leases }),
    TypeError,
  );
  assertThrows(
    () =>
      new VirtualGateway({ mac: GATEWAY_MAC, ip: GATEWAY_IP, subnetMask: "255.255.255", leases }),
    TypeError,
  );
});

// ── medium: ESP-NOW ─────────────────────────────────────────────────────────

function espnowRig(channels: Record<string, number> = {}) {
  const rig = makeRig({
    positions: { a: { x: 0, y: 0 }, b: { x: 3, y: 0 } },
    environment: quietEnv,
    channel: 1,
    channels,
  });
  const action = (from: string, to: string, channel = 1) =>
    buildEspNowAction({
      dst: macOf(rig, to),
      src: macOf(rig, from),
      channel,
      body: buildEspNowBody(Uint8Array.of(1, 2)),
    });
  const ack = (from: string, to: string, channel = 1) =>
    buildEspNowAck({ dst: macOf(rig, to), src: macOf(rig, from), channel });
  const outcomes = () =>
    rig.log.events.flatMap((e) => (e.type === "espnow-send" ? [e.outcome] : []));
  const drops = () =>
    rig.log.events.flatMap((e) => (e.type === "drop" ? [`${e.kind}:${e.reason}`] : []));
  return { ...rig, action, ack, outcomes, drops };
}

Deno.test("espnow medium: a sender on another channel than its radio is warned about once", () => {
  const r = espnowRig();
  r.medium.transmit("a", r.action("a", "b", 6));
  r.medium.transmit("a", r.action("a", "b", 6));
  r.clock.runAll();
  const warnings = r.log.events.filter((e) => e.type === "warning");
  assertEquals(warnings.length, 1);
  assert(warnings[0]?.type === "warning" && warnings[0].text.includes("channel 6"));
  assertEquals(r.drops(), ["espnow:channel_mismatch", "espnow:channel_mismatch"]);
});

Deno.test("espnow medium: an ACK nobody waits for is unmatched, an ACK to a stranger is ignored", () => {
  const r = espnowRig();
  r.medium.transmit("b", r.ack("b", "a"));
  r.medium.transmit(
    "b",
    buildEspNowAck({ dst: "02:00:00:00:00:77", src: macOf(r, "b"), channel: 1 }),
  );
  r.medium.transmit("b", buildEspNowAck({ dst: macOf(r, "b"), src: macOf(r, "b"), channel: 1 }));
  r.clock.runAll();
  assertEquals(r.drops(), ["espnow-ack:ack_unmatched"]);
  assertEquals(r.sinks.get("a")!.frames.length, 0);
});

Deno.test("espnow medium: an ACK on the wrong channel, or to a sender that left, is dropped as such", () => {
  const r = espnowRig();
  r.medium.transmit("a", r.action("a", "b"));
  r.clock.runAll();
  r.medium.transmit("b", r.ack("b", "a", 6));
  r.sinks.get("a")!.connected = false;
  r.medium.transmit("b", r.ack("b", "a"));
  r.clock.runAll();
  assertEquals(r.drops(), ["espnow-ack:channel_mismatch", "espnow-ack:no_peer"]);
  assertEquals(r.outcomes(), [], "the send is still waiting for a real ACK");
  r.clock.advanceBy(20);
  r.medium.close();
  assertEquals(r.outcomes(), ["no_ack"], "closing after the window counts it");
});

Deno.test("espnow medium: a second frame before the first was acknowledged makes the first no_ack", () => {
  const r = espnowRig();
  r.medium.transmit("a", r.action("a", "b"));
  r.medium.transmit("a", r.action("a", "b"));
  r.medium.close();
  assertEquals(
    r.outcomes(),
    ["no_ack"],
    "a send cut off inside its window by close() is not counted",
  );
});

Deno.test("espnow medium: unicast to a receiver that is not connected is frame_lost as no_peer", () => {
  const r = espnowRig();
  r.sinks.get("b")!.connected = false;
  r.medium.transmit("a", r.action("a", "b"));
  r.clock.runAll();
  assertEquals(r.drops(), ["espnow:no_peer"]);
  assertEquals(r.outcomes(), ["frame_lost"]);
});

Deno.test("espnow frames: channels outside 4 bits and payloads over 250 bytes are refused", () => {
  for (const channel of [-1, 16, 1.5]) {
    assertThrows(() => buildEspNowAck({ dst: A, src: B, channel }), RangeError, "4 bits");
    assertThrows(
      () => buildEspNowAction({ dst: A, src: B, channel, body: new Uint8Array(0) }),
      RangeError,
      "4 bits",
    );
  }
  assertThrows(
    () => buildEspNowBody(new Uint8Array(ESPNOW_MAX_PAYLOAD_BYTES + 1)),
    RangeError,
    "exceeds 250",
  );
  assertEquals(
    parseEspNowBody(buildEspNowBody(new Uint8Array(ESPNOW_MAX_PAYLOAD_BYTES))!)?.length,
    250,
  );
});

Deno.test("espnow frames: a body that is not ESP-NOW, or whose element overruns it, parses to null", () => {
  const body = buildEspNowBody(Uint8Array.of(1, 2, 3));
  assertEquals(Array.from(parseEspNowBody(body)!), [1, 2, 3]);
  assertEquals(parseEspNowBody(body.subarray(0, 14)), null, "shorter than the fixed part");
  const category = body.slice();
  category[0] = 4;
  assertEquals(parseEspNowBody(category), null);
  const element = body.slice();
  element[8] = 0xdc;
  assertEquals(parseEspNowBody(element), null);
  const type = body.slice();
  type[13] = 5;
  assertEquals(parseEspNowBody(type), null);
  const overrun = body.slice();
  overrun[9] = 40;
  assertEquals(parseEspNowBody(overrun), null);
  const underrun = body.slice();
  underrun[9] = 4;
  assertEquals(parseEspNowBody(underrun), null, "an element shorter than its own header");
  assertEquals(parseEspNow(new Uint8Array(13)), null);
  assertEquals(parseEspNow(buildEthernet(B, A, 0xa50d, new Uint8Array(0)))?.type, "action");
  assertEquals(parseEspNow(buildEthernet(B, A, 0xa50e, new Uint8Array(0))), null);
});

Deno.test("espnow radiotap: channel 14 and an out-of-band channel get 2484 MHz and 0", () => {
  const freq = (channel: number) => {
    const out = espnowToRadiotap(buildEspNowAck({ dst: A, src: B, channel }))!;
    return new DataView(out.buffer).getUint16(8, true);
  };
  assertEquals([freq(1), freq(13), freq(14), freq(0), freq(15)], [2412, 2472, 2484, 0, 0]);
  const protectedAction = espnowToRadiotap(
    buildEspNowAction({ dst: B, src: A, channel: 1, body: Uint8Array.of(127), protected: true }),
  )!;
  assertEquals(protectedAction[13], 0x40, "the protected bit is set in the 802.11 header");
});

// ── chip-level air ──────────────────────────────────────────────────────────

class ScriptedReceiver implements AirReceiver {
  hearing: Hearing = "listen";
  accept = true;
  readonly received: { from: string; rssiDbm: number }[] = [];
  hear(): Hearing {
    return this.hearing;
  }
  receive(_frame: AirFrame, from: string, quality: { rssiDbm: number }): boolean {
    if (this.accept) this.received.push({ from, rssiDbm: quality.rssiDbm });
    return this.accept;
  }
}

function chipFrame(over: Partial<AirFrame> = {}): AirFrame {
  return {
    kind: "lora",
    payload: new Uint8Array(10),
    airtimeMs: 20,
    frequencyHz: 868e6,
    bandwidthHz: 125e3,
    noiseFigureDb: 6,
    requiredSnrDb: -7.5,
    referenceBytes: 20,
    captureDb: 6,
    txPowerDbm: 14,
    interferenceKey: "k",
    rateBps: 5470,
    dst: "",
    src: "",
    params: {},
    header: null,
    ...over,
  };
}

function airRig(positions: Record<string, [number, number]>) {
  const clock = new ManualClock();
  const log = new EventLog();
  const air = new AirMedium({
    seed: 1,
    clock,
    log,
    environment: environmentFromPreset("free_space", { shadowingSigmaDb: 0 }),
  });
  const rx = new Map<string, ScriptedReceiver>();
  for (const [id, [x, y]] of Object.entries(positions)) {
    const r = new ScriptedReceiver();
    rx.set(id, r);
    air.addNode({ id, position: { x, y }, antennaGainDbi: 0 }, r);
  }
  const drops = () =>
    log.events.flatMap((e) => (e.type === "drop" ? [`${e.from}>${e.to}:${e.reason}`] : []));
  return { clock, log, air, rx: (id: string) => rx.get(id)!, drops };
}

Deno.test("air: duplicate and unknown nodes, a budget before any signal, a radio change it does not model", () => {
  const r = airRig({ a: [0, 0], b: [10, 0] });
  assertThrows(
    () =>
      r.air.addNode(
        { id: "a", position: { x: 0, y: 0 }, antennaGainDbi: 0 },
        new ScriptedReceiver(),
      ),
    Error,
    "duplicate node id",
  );
  assertThrows(() => r.air.node("zz"), Error, 'unknown node "zz"');
  assertThrows(() => r.air.transmit("zz", chipFrame()), Error, "unknown node");
  assertThrows(() => r.air.budget("a", "b"), Error, "declares no signal");
  assertThrows(() => r.air.setRadio("a", { channel: 3 }), Error, "only antennaGainDbi");
  r.air.setRadio("a", { antennaGainDbi: 3 });
  assertEquals(r.air.node("a").antennaGainDbi, 3);
  assertEquals(r.air.nodeIds, ["a", "b"]);
});

Deno.test("air: a receiver that left its receive state by the end of the frame is not_listening", () => {
  const r = airRig({ a: [0, 0], b: [10, 0] });
  r.rx("b").accept = false;
  r.air.transmit("a", chipFrame());
  r.clock.runAll();
  assertEquals(r.drops(), ["a>b:not_listening"]);
});

Deno.test("air: overlapping frames on one key collide unless one is the capture margin stronger", () => {
  const r = airRig({ near: [0, 0], far: [1000, 0], rx: [5, 0], other: [6, 0] });
  r.air.transmit("near", chipFrame());
  r.air.transmit("far", chipFrame());
  r.clock.runAll();
  assertEquals(r.rx("rx").received.map((x) => x.from), ["near"], "the near frame is captured");
  assert(r.drops().includes("far>rx:collision"));

  const s = airRig({ a: [0, 0], b: [10, 0], rx: [5, 0] });
  s.air.transmit("a", chipFrame());
  s.air.transmit("b", chipFrame());
  s.clock.runAll();
  assertEquals(s.rx("rx").received, [], "equal power: both lost");
  assert(s.drops().includes("a>rx:collision") && s.drops().includes("b>rx:collision"));

  const t = airRig({ a: [0, 0], b: [10, 0], rx: [5, 0] });
  t.air.transmit("a", chipFrame({ interferenceKey: "one" }));
  t.air.transmit("b", chipFrame({ interferenceKey: "two" }));
  t.clock.runAll();
  assertEquals(t.rx("rx").received.length, 2, "different keys do not interfere");
});

Deno.test("air: a frame that ended before the next one starts does not collide with it", () => {
  const r = airRig({ a: [0, 0], b: [10, 0], rx: [5, 0] });
  r.air.transmit("a", chipFrame());
  r.clock.advanceBy(25);
  r.air.transmit("b", chipFrame());
  r.clock.runAll();
  assertEquals(r.rx("rx").received.map((x) => x.from), ["a", "b"]);
});

Deno.test("air: 'mismatch' is logged as phy_mismatch, 'deaf' is not logged", () => {
  const r = airRig({ a: [0, 0], b: [10, 0], c: [20, 0] });
  r.rx("b").hearing = "mismatch";
  r.rx("c").hearing = "deaf";
  r.air.transmit("a", chipFrame());
  r.clock.runAll();
  assertEquals(r.drops(), ["a>b:phy_mismatch"]);
});

Deno.test("air: extra loss, latency and jitter overrides apply to the chip-level link", () => {
  const r = airRig({ a: [0, 0], b: [10, 0] });
  r.air.setLinkOverride("a", "b", { extraLossPct: 100, extraLatencyMs: 0 });
  r.air.transmit("a", chipFrame());
  r.clock.runAll();
  assertEquals(r.drops(), ["a>b:extra_loss"]);

  const s = airRig({ a: [0, 0], b: [10, 0] });
  s.air.setLinkOverride("a", "b", { extraLossPct: 0, extraLatencyMs: 30, extraJitterMs: 5 });
  s.air.transmit("a", chipFrame());
  s.clock.runAll();
  const deliver = s.log.events.find((e) => e.type === "deliver");
  assert(deliver?.type === "deliver");
  assert(deliver.delayMs >= 50 && deliver.delayMs <= 55 + 1e-6, `delay ${deliver.delayMs}`);
  assertThrows(
    () => s.air.setLinkOverride("a", "zz", { extraLossPct: 0, extraLatencyMs: 0 }),
    Error,
    "unknown node",
  );
});

Deno.test("air: close() cancels deliveries still in flight", () => {
  const r = airRig({ a: [0, 0], b: [10, 0] });
  r.air.transmit("a", chipFrame());
  r.air.close();
  r.clock.runAll();
  assertEquals(r.rx("b").received, []);
  assertEquals(r.log.events.filter((e) => e.type === "deliver" || e.type === "drop").length, 0);
});

Deno.test("air: the budget after a frame is read against that frame's signal; interference lowers its SNR", () => {
  const r = airRig({ a: [0, 0], b: [10, 0] });
  r.air.transmit("a", chipFrame({ txPowerDbm: 20 }));
  const budget = r.air.budget("a", "b");
  assertEquals(budget.signal.txPowerDbm, 20);
  r.air.setLinkOverride("a", "b", { extraLossPct: 0, extraLatencyMs: 0, interferenceDb: 10 });
  assertAlmostEquals(r.air.budget("a", "b").snrDb, budget.snrDb - 10, 1e-9);
  r.air.setEnvironment({ shadowingSigmaDb: 0, pathLossExponent: 3 });
  assert(r.air.budget("a", "b").rssiDbm < budget.rssiDbm);
});

// ── gateway: malformed DHCP ─────────────────────────────────────────────────

Deno.test("gateway: a DHCP message with a bad header, cookie, option or no type is ignored as malformed", () => {
  const gw = new VirtualGateway({
    mac: GATEWAY_MAC,
    ip: GATEWAY_IP,
    subnetMask: "255.255.255.0",
    leases: new Map([[A, "192.168.4.20"]]),
  });
  // The DHCP body starts after Ethernet (14), IPv4 (20) and UDP (8).
  const body = 42;
  const mutated = (edit: (frame: Uint8Array) => void) => {
    const frame = buildDhcpClientMessage(A, 1, 1);
    edit(frame);
    return gw.handle(frame)!;
  };
  const cases: [string, (f: Uint8Array) => void][] = [
    ["BOOTREPLY", (f) => (f[body] = 2)],
    ["hardware type", (f) => (f[body + 1] = 6)],
    ["hardware length", (f) => (f[body + 2] = 8)],
    ["magic cookie", (f) => (f[body + 236] = 0)],
    ["truncated option", (f) => f.set([12, 200], body + 240)],
    ["no message type", (f) => (f[body + 240] = 255)],
  ];
  for (const [what, edit] of cases) {
    const answer = mutated(edit);
    assertEquals([answer.service, answer.replies.length], ["dhcp", 0], what);
    assert(answer.detail.includes("malformed"), `${what}: ${answer.detail}`);
  }
  const short = buildUdp({
    srcMac: A,
    dstMac: BROADCAST_MAC,
    srcIp: "0.0.0.0",
    dstIp: "255.255.255.255",
    srcPort: 68,
    dstPort: 67,
    payload: new Uint8Array(243),
  });
  assert(
    gw.handle(short)!.detail.includes("malformed"),
    "shorter than the fixed part and the cookie",
  );
});

Deno.test("gateway: pad options are skipped, a REQUEST without option 50 is acked, other types are ignored", () => {
  const gw = new VirtualGateway({
    mac: GATEWAY_MAC,
    ip: GATEWAY_IP,
    subnetMask: "255.255.255.0",
    leases: new Map([[A, "192.168.4.20"]]),
  });
  const body = 42;
  const padded = buildDhcpClientMessage(A, 1, 1);
  padded.set([0, 0, 53, 1, 1, 255], body + 240);
  assert(gw.handle(padded)!.detail.startsWith("offer 192.168.4.20"));
  assert(gw.handle(buildDhcpClientMessage(A, 3, 1))!.detail.startsWith("ack 192.168.4.20"));
  assert(gw.handle(buildDhcpClientMessage(A, 3, 1, "192.168.4.20"))!.detail.startsWith("ack"));
  const release = buildDhcpClientMessage(A, 1, 1);
  release[body + 242] = 7;
  const answer = gw.handle(release)!;
  assertEquals(answer.replies.length, 0);
  assert(answer.detail.includes("message type 7"), answer.detail);
  const notDhcp = buildUdp({
    srcMac: A,
    dstMac: GATEWAY_MAC,
    srcIp: "192.168.4.20",
    dstIp: GATEWAY_IP,
    srcPort: 68,
    dstPort: 53,
    payload: new Uint8Array(8),
  });
  assertEquals(gw.handle(notDhcp), null, "UDP to another port is not the gateway's");
});

// ── tcp: segments that are not TCP ──────────────────────────────────────────

function tcpFrame(over: { mss?: number; payload?: number[] } = {}): Uint8Array {
  return buildTcpFrame({
    srcMac: A,
    dstMac: B,
    srcIp: "10.0.0.1",
    dstIp: "10.0.0.2",
    srcPort: 49152,
    dstPort: 80,
    seq: 1000,
    ack: 0,
    flags: TCP_FLAG.syn,
    window: 65535,
    payload: Uint8Array.from(over.payload ?? []),
    ...(over.mss === undefined ? {} : { mss: over.mss }),
  });
}

/** Rewrite the header length and the options after the fixed header, then fix the checksum. */
function withOptions(frame: Uint8Array, dataOffsetWords: number, options: number[]): Uint8Array {
  const out = frame.slice();
  const tcp = 34;
  out[tcp + 12] = dataOffsetWords << 4;
  out.set(options, tcp + 20);
  out[tcp + 16] = 0;
  out[tcp + 17] = 0;
  const sum = tcpChecksum("10.0.0.1", "10.0.0.2", out.subarray(tcp));
  out[tcp + 16] = sum >> 8;
  out[tcp + 17] = sum & 0xff;
  return out;
}

Deno.test("parseTcp: other protocols, truncated segments, bad header lengths and bad checksums are null", () => {
  const good = tcpFrame({ mss: 1200, payload: [1, 2, 3] });
  const segment = parseTcp(good, parseIpv4(good)!)!;
  assertEquals([segment.mss, segment.flags, segment.seq, Array.from(segment.payload)], [
    1200,
    TCP_FLAG.syn,
    1000,
    [1, 2, 3],
  ]);
  const udp = ipv4Frame(17, { payload: new Array(20).fill(0) });
  assertEquals(parseTcp(udp, parseIpv4(udp)!), null);
  const short = ipv4Frame(6, { payload: new Array(19).fill(0) });
  assertEquals(parseTcp(short, parseIpv4(short)!), null);
  const small = withOptions(good, 4, [2, 4, 4, 0xb0]);
  assertEquals(parseTcp(small, parseIpv4(small)!), null, "data offset under 5 words");
  const huge = withOptions(good, 15, [2, 4, 4, 0xb0]);
  assertEquals(parseTcp(huge, parseIpv4(huge)!), null, "header longer than the segment");
  const corrupt = good.slice();
  corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 0xff;
  assertEquals(parseTcp(corrupt, parseIpv4(corrupt)!), null, "checksum");
});

Deno.test("parseTcp: options - NOP is skipped, EOL and malformed lengths stop, only a 4-byte MSS counts", () => {
  // Four payload bytes become option bytes once the header is 7 words.
  const base = tcpFrame({ mss: 1200, payload: [0, 0, 0, 0] });
  const mssOf = (options: number[]) => {
    const frame = withOptions(base, 7, options);
    return parseTcp(frame, parseIpv4(frame)!)?.mss;
  };
  assertEquals(mssOf([1, 1, 1, 1, 2, 4, 0x05, 0xb4]), 1460);
  assertEquals(mssOf([0, 0, 0, 0, 2, 4, 0x05, 0xb4]), null, "end of options first");
  assertEquals(mssOf([2, 1, 0, 0, 0, 0, 0, 0]), null, "a length under 2 stops");
  assertEquals(mssOf([1, 1, 1, 1, 1, 2, 4, 0x05]), null, "an option past the header stops");
  assertEquals(mssOf([2, 3, 0x05, 1, 1, 1, 1, 1]), null, "an MSS of the wrong length is ignored");
  assertEquals(parseTcp(tcpFrame(), parseIpv4(tcpFrame())!)?.mss, null, "no options");
});
