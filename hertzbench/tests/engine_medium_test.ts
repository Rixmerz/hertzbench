import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import {
  buildArp,
  computeMetrics,
  type EngineEvent,
  environmentFromPreset,
  EventLog,
  linkStats,
  macToString,
  PcapWriter,
  VirtualGateway,
} from "../engine/mod.ts";
import {
  broadcastFrame,
  dhcpClientMessage,
  GATEWAY_IP,
  GATEWAY_MAC,
  ipFor,
  macFor,
  macOf,
  makeRig,
  RecordingSink,
  udpFrame,
} from "./helpers.ts";

const outcomes = (log: EventLog) =>
  log.events.filter((e) => e.type === "deliver" || e.type === "drop");

Deno.test("unicast: delivered to the owner of the MAC only, after the modelled delay", () => {
  const rig = makeRig({
    positions: { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, c: { x: 5, y: 5 } },
  });
  rig.medium.transmit("a", udpFrame(rig, "a", "b"));
  assertEquals(rig.sinks.get("b")!.frames.length, 0, "nothing arrives before time passes");
  rig.clock.runAll();
  assertEquals(rig.sinks.get("b")!.frames.length, 1);
  assertEquals(rig.sinks.get("b")!.frames[0]!.from, "a");
  assertEquals(rig.sinks.get("c")!.frames.length, 0);
  assertEquals(rig.sinks.get("a")!.frames.length, 0);
  const deliver = rig.log.events.find((e) => e.type === "deliver");
  assert(deliver && deliver.type === "deliver");
  assertEquals(rig.sinks.get("b")!.frames[0]!.atMs, deliver.delayMs);
  assert(deliver.delayMs > 0);
});

Deno.test("broadcast: reaches every other station on the channel, not the sender, not other channels", () => {
  const rig = makeRig({
    positions: { a: { x: 0, y: 0 }, b: { x: 5, y: 0 }, c: { x: 0, y: 5 }, d: { x: 3, y: 3 } },
    channels: { d: 11 },
  });
  rig.medium.transmit("a", broadcastFrame(macOf(rig, "a")));
  rig.clock.runAll();
  assertEquals(rig.sinks.get("b")!.frames.length, 1);
  assertEquals(rig.sinks.get("c")!.frames.length, 1);
  assertEquals(rig.sinks.get("a")!.frames.length, 0);
  assertEquals(rig.sinks.get("d")!.frames.length, 0);
  // The station on another channel never heard it, so it is not even a loss.
  assert(!outcomes(rig.log).some((e) => "to" in e && e.to === "d"));
});

Deno.test("unicast across channels is reported as a channel_mismatch drop", () => {
  const rig = makeRig({
    positions: { a: { x: 0, y: 0 }, b: { x: 5, y: 0 } },
    channels: { b: 1 },
  });
  rig.medium.transmit("a", udpFrame(rig, "a", "b"));
  rig.clock.runAll();
  assertEquals(rig.sinks.get("b")!.frames.length, 0);
  const drop = rig.log.events.find((e) => e.type === "drop");
  assert(drop && drop.type === "drop");
  assertEquals(drop.reason, "channel_mismatch");
});

Deno.test("unicast to a board that has not connected is a no_peer drop; broadcast skips it", () => {
  const rig = makeRig({ positions: { a: { x: 0, y: 0 }, b: { x: 5, y: 0 } } });
  rig.sinks.get("b")!.connected = false;
  rig.medium.transmit("a", udpFrame(rig, "a", "b"));
  rig.medium.transmit("a", broadcastFrame(macOf(rig, "a")));
  rig.clock.runAll();
  const drops = rig.log.events.filter((e) => e.type === "drop");
  assertEquals(drops.length, 1);
  assertEquals(drops[0]!.type === "drop" && drops[0]!.reason, "no_peer");
});

Deno.test("an address nobody owns is flooded, as a switch does, and never learned", () => {
  const rig = makeRig({ positions: { a: { x: 0, y: 0 }, b: { x: 5, y: 0 }, c: { x: 0, y: 5 } } });
  const stray = udpFrame(rig, "a", "b");
  stray.set([0x02, 0x99, 0, 0, 0, 1], 0); // destination MAC that no board has
  rig.medium.transmit("a", stray);
  rig.clock.runAll();
  assertEquals(rig.sinks.get("b")!.frames.length, 1);
  assertEquals(rig.sinks.get("c")!.frames.length, 1);

  // A frame that claims another source MAC changes nothing: the table is static.
  const spoofed = udpFrame(rig, "a", "b");
  spoofed.set(Uint8Array.from([0x02, 0x68, 0x7a, 0x62, 0x01, 0x03]), 6);
  rig.medium.transmit("a", spoofed);
  rig.clock.runAll();
  assertEquals(rig.sinks.get("b")!.frames.length, 2);
  assertEquals(rig.sinks.get("c")!.frames.length, 1);
});

Deno.test("a frame to the QEMU fork's AP MAC goes, acknowledged, to the holder of its destination IP", () => {
  // The fork writes its access point's MAC as the Ethernet destination of
  // every frame a station sends, so only the IP says who the peer is.
  const gateway = new VirtualGateway({
    mac: GATEWAY_MAC,
    ip: GATEWAY_IP,
    subnetMask: "255.255.255.0",
    leases: new Map([1, 2, 3].map((i) => [macFor(i), ipFor(i)])),
  });
  const rig = makeRig({
    gateway,
    positions: { a: { x: 0, y: 0 }, b: { x: 5, y: 0 }, c: { x: 0, y: 5 } },
  });
  const toB = udpFrame(rig, "a", "b");
  toB.set([0x10, 0x01, 0x00, 0xc4, 0x0a, 0x51], 0);
  rig.medium.transmit("a", toB);
  rig.clock.runAll();
  assertEquals(rig.sinks.get("b")!.frames.length, 1);
  assertEquals(rig.sinks.get("c")!.frames.length, 0, "not flooded");
  const deliver = rig.log.events.find((e) => e.type === "deliver");
  assert(deliver && deliver.type === "deliver");
  assertEquals(deliver.to, "b");
});

Deno.test("a frame that went by lease reaches its station addressed to the station's own MAC", () => {
  // Issue #74: the SYN-ACK from an esp32 to an android node kept the fork's AP
  // MAC as its destination, so the phone, which takes only its own MAC, never saw it.
  const gateway = new VirtualGateway({
    mac: GATEWAY_MAC,
    ip: GATEWAY_IP,
    subnetMask: "255.255.255.0",
    leases: new Map([1, 2].map((i) => [macFor(i), ipFor(i)])),
  });
  const rig = makeRig({ gateway, positions: { a: { x: 0, y: 0 }, b: { x: 5, y: 0 } } });
  const apMac = [0x10, 0x01, 0x00, 0xc4, 0x0a, 0x51];
  const toB = udpFrame(rig, "a", "b");
  toB.set(apMac, 0);
  toB.set(apMac, 6); // the fork writes the AP MAC as the source too
  rig.medium.transmit("a", toB);
  rig.clock.runAll();

  const [got] = rig.sinks.get("b")!.frames;
  assertEquals(macToString(got!.frame, 0), macOf(rig, "b"));
  assertEquals(
    macToString(got!.frame, 6),
    "10:01:00:c4:0a:51",
    "only the destination is rewritten",
  );
  assertEquals(toB.slice(0, 6), Uint8Array.from(apMac), "the sender's own buffer is untouched");
  assertEquals(
    got!.frame.slice(12),
    toB.slice(12),
    "and so is everything after the Ethernet addresses",
  );
});

Deno.test("two stations with the same MAC cannot join", () => {
  const rig = makeRig({ positions: { a: { x: 0, y: 0 } } });
  assertThrows(
    () =>
      rig.medium.addNode(
        { id: "dup", mac: macOf(rig, "a"), position: { x: 1, y: 1 }, radio: rig.nodes[0]!.radio },
        new RecordingSink(rig.clock),
      ),
    Error,
    "same MAC",
  );
});

// No shadowing, so where the cliff sits does not depend on the seed's draw:
// with 8 dBm and small frames, 62 m loses a bit under half of the frames.
const NO_SHADOWING = environmentFromPreset("indoor_office", { shadowingSigmaDb: 0 });

function floodLink(seed: number, interleave: boolean) {
  const rig = makeRig({
    seed,
    environment: NO_SHADOWING,
    positions: { a: { x: 0, y: 0 }, b: { x: 62, y: 0 }, c: { x: 0, y: 62 } },
    txPowerDbm: 8,
  });
  for (let i = 0; i < 80; i++) {
    rig.medium.transmit("a", udpFrame(rig, "a", "b"));
    if (interleave) rig.medium.transmit("c", udpFrame(rig, "c", "b"));
    rig.clock.advanceBy(10);
  }
  rig.clock.runAll();
  return linkStats(rig.log.events).find((l) => l.from === "a" && l.to === "b")!;
}

Deno.test("determinism: same seed gives identical stats; another seed gives different ones", () => {
  const first = floodLink(7, false);
  const again = floodLink(7, false);
  assertEquals(first, again);
  assert(first.sent === 80);
  assert(
    first.lossPct > 10 && first.lossPct < 90,
    `the 62 m link sits on the cliff: ${first.lossPct}`,
  );
  assert(JSON.stringify(floodLink(8, false)) !== JSON.stringify(first));
});

Deno.test("determinism: a link's outcomes do not depend on traffic on other links", () => {
  assertEquals(floodLink(7, true), floodLink(7, false));
});

Deno.test("determinism: the whole event log is reproducible", () => {
  const run = () => {
    const rig = makeRig({
      seed: 3,
      environment: NO_SHADOWING,
      positions: { a: { x: 0, y: 0 }, b: { x: 62, y: 0 } },
      txPowerDbm: 8,
    });
    for (let i = 0; i < 30; i++) {
      rig.medium.transmit("a", udpFrame(rig, "a", "b"));
      rig.clock.advanceBy(5);
    }
    rig.clock.runAll();
    return rig.log.toJsonl();
  };
  assertEquals(run(), run());
});

Deno.test("shadowing is a property of the pair: moving a node does not reroll it", () => {
  const rig = makeRig({ positions: { a: { x: 0, y: 0 }, b: { x: 20, y: 0 } } });
  const before = rig.medium.budget("a", "b");
  rig.medium.moveNode("b", { x: 40, y: 0 });
  const after = rig.medium.budget("a", "b");
  assertEquals(after.shadowingDb, before.shadowingDb);
  assertEquals(rig.medium.budget("b", "a").shadowingDb, before.shadowingDb); // reciprocal
  assert(after.rssiDbm < before.rssiDbm);
  assert(rig.log.events.some((e) => e.type === "move" && e.node === "b"));
});

Deno.test("link override: forced loss and extra latency apply to that direction only", () => {
  const rig = makeRig({ positions: { a: { x: 0, y: 0 }, b: { x: 5, y: 0 } } });
  rig.medium.setLinkOverride("a", "b", { extraLossPct: 100, extraLatencyMs: 0 });
  rig.medium.transmit("a", udpFrame(rig, "a", "b"));
  rig.medium.transmit("b", udpFrame(rig, "b", "a"));
  rig.clock.runAll();
  assertEquals(rig.sinks.get("b")!.frames.length, 0);
  assertEquals(rig.sinks.get("a")!.frames.length, 1);
  const drop = rig.log.events.find((e) => e.type === "drop");
  assert(drop && drop.type === "drop" && drop.reason === "extra_loss");
});

Deno.test("link override: interference lowers that link's SNR and costs it frames; jitter spreads its delay", () => {
  const rig = makeRig({ positions: { a: { x: 0, y: 0 }, b: { x: 5, y: 0 } } });
  const clean = rig.medium.budget("a", "b");
  rig.medium.setLinkOverride("a", "b", { extraLossPct: 0, extraLatencyMs: 0, interferenceDb: 70 });
  const noisy = rig.medium.budget("a", "b");
  assertEquals(noisy.rssiDbm, clean.rssiDbm);
  assertEquals(noisy.noiseFloorDbm, clean.noiseFloorDbm + 70);
  assertEquals(noisy.snrDb, clean.snrDb - 70);
  assertEquals(rig.medium.budget("b", "a").snrDb, clean.snrDb, "the other direction is untouched");
  // 70 dB of noise rise leaves no rate that decodes: the MAC gives up by itself.
  rig.medium.transmit("a", udpFrame(rig, "a", "b"));
  rig.clock.runAll();
  const drop = rig.log.events.find((e) => e.type === "drop");
  assert(drop?.type === "drop" && drop.reason === "retry_exhausted", JSON.stringify(drop));

  const delays = (jitterMs: number) => {
    const r = makeRig({ positions: { a: { x: 0, y: 0 }, b: { x: 5, y: 0 } } });
    r.medium.setLinkOverride("a", "b", {
      extraLossPct: 0,
      extraLatencyMs: 0,
      extraJitterMs: jitterMs,
    });
    for (let i = 0; i < 30; i++) r.medium.transmit("a", udpFrame(r, "a", "b"));
    r.clock.runAll();
    return r.log.events.flatMap((e) => e.type === "deliver" ? [e.delayMs] : []);
  };
  const steady = delays(0);
  const jittery = delays(40);
  assertEquals(jittery.length, 30);
  const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
  assert(spread(steady) < 5, `without jitter: ${spread(steady)} ms`);
  assert(spread(jittery) > 20, `with up to 40 ms of jitter: ${spread(jittery)} ms`);
  assert(Math.max(...jittery) < Math.max(...steady) + 40);
});

Deno.test("live channel and radio: sigma rescales each pair's draw, power moves RSSI, a channel change deafens", () => {
  const rig = makeRig({ positions: { a: { x: 0, y: 0 }, b: { x: 20, y: 0 } } });
  const before = rig.medium.budget("a", "b");
  assert(before.shadowingDb !== 0, "indoor_office draws shadowing");
  rig.medium.setEnvironment({ shadowingSigmaDb: 8, pathLossExponent: 3.5 });
  const after = rig.medium.budget("a", "b");
  // indoor_office's sigma is 4 dB: the same draw, twice as large.
  assertAlmostEquals(after.shadowingDb, before.shadowingDb * 2, 1e-9);
  assert(after.pathLossDb > before.pathLossDb);

  rig.medium.setRadio("a", { txPowerDbm: 5 });
  assertAlmostEquals(rig.medium.budget("a", "b").rssiDbm, after.rssiDbm - 10, 1e-9);
  rig.medium.setRadio("b", { channel: 11 });
  rig.medium.transmit("a", udpFrame(rig, "a", "b"));
  rig.clock.runAll();
  const drop = rig.log.events.find((e) => e.type === "drop");
  assert(drop?.type === "drop" && drop.reason === "channel_mismatch");
  assertEquals(
    rig.log.events.filter((e) => e.type === "channel" || e.type === "radio").map((e) => e.type),
    ["channel", "radio", "radio"],
  );
});

Deno.test("gateway: DHCP and ARP are answered to the asker only, outside the loss model", () => {
  const gateway = new VirtualGateway({
    mac: GATEWAY_MAC,
    ip: GATEWAY_IP,
    subnetMask: "255.255.255.0",
    leases: new Map([[macFor(1), ipFor(1)]]),
  });
  // 5 km away: any frame through the channel model would be lost.
  const rig = makeRig({
    gateway,
    positions: { a: { x: 0, y: 0 }, b: { x: 5000, y: 0 } },
  });
  rig.medium.transmit("a", dhcpClientMessage(macFor(1), 1, 1));
  rig.medium.transmit(
    "a",
    buildArp({
      operation: 1,
      senderMac: macFor(1),
      senderIp: ipFor(1),
      targetMac: "00:00:00:00:00:00",
      targetIp: GATEWAY_IP,
    }),
  );
  rig.clock.runAll();
  assertEquals(rig.sinks.get("a")!.frames.length, 2);
  assertEquals(rig.sinks.get("a")!.frames[0]!.from, "gateway");
  assertEquals(rig.sinks.get("b")!.frames.length, 0, "service traffic is not flooded to peers");
  assertEquals(outcomes(rig.log).length, 0, "and it never touched the channel");
  assertEquals(rig.log.events.filter((e) => e.type === "service").length, 2);
});

Deno.test("metrics: windows split at phase events and per-link totals add up", () => {
  const rig = makeRig({
    seed: 11,
    environment: NO_SHADOWING,
    positions: { a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },
    txPowerDbm: 8,
  });
  const burst = (n: number) => {
    for (let i = 0; i < n; i++) {
      rig.medium.transmit("a", udpFrame(rig, "a", "b"));
      rig.clock.advanceBy(10);
    }
  };
  burst(40);
  rig.medium.startPhase("far");
  rig.medium.moveNode("b", { x: 64, y: 0 });
  burst(40);
  rig.clock.runAll();

  const metrics = computeMetrics(rig.log.events, rig.clock.now());
  assertEquals(metrics.phases.map((p) => p.label), ["start", "far"]);
  const near = metrics.phases[0]!.links[0]!;
  const far = metrics.phases[1]!.links[0]!;
  assertEquals(near.sent, 40);
  assertEquals(far.sent, 40);
  assertEquals(near.lossPct, 0);
  assert(far.lossPct > 50, `far phase loss was ${far.lossPct}`);
  assert(far.rssiDbm < near.rssiDbm - 10);
  assert(near.latencyMs!.p95 < 1);
  const total = metrics.total[0]!;
  assertEquals(total.sent, 80);
  assertEquals(total.delivered, near.delivered + far.delivered);
});

Deno.test("pcap: global header, record layout, and one record per frame put on the air", () => {
  const pcap = new PcapWriter(1_700_000_000_000);
  const rig = makeRig({
    positions: { a: { x: 0, y: 0 }, b: { x: 5, y: 0 } },
    mediumOptions: { tap: (tMs, _node, frame) => pcap.addFrame(tMs, frame) },
  });
  rig.clock.advanceTo(1.5);
  const frame = udpFrame(rig, "a", "b", "hello");
  rig.medium.transmit("a", frame);
  rig.medium.transmit("a", broadcastFrame(macOf(rig, "a")));
  rig.clock.runAll();

  assertEquals(pcap.packetCount, 2);
  const bytes = pcap.toBytes();
  const view = new DataView(bytes.buffer);
  assertEquals(view.getUint32(0, true), 0xa1b2c3d4);
  assertEquals([view.getUint16(4, true), view.getUint16(6, true)], [2, 4]);
  assertEquals(view.getUint32(20, true), 1); // LINKTYPE_ETHERNET
  assertEquals(view.getUint32(24, true), 1_700_000_000); // seconds
  assertEquals(view.getUint32(28, true), 1500); // microseconds: 1.5 ms after the epoch
  assertEquals(view.getUint32(32, true), frame.length); // captured length
  assertEquals(view.getUint32(36, true), frame.length); // original length
  assertEquals(Array.from(bytes.subarray(40, 40 + frame.length)), Array.from(frame));
});

Deno.test("event log: sequence numbers increase and jsonl has one line per event", () => {
  const rig = makeRig({ positions: { a: { x: 0, y: 0 }, b: { x: 5, y: 0 } } });
  rig.medium.transmit("a", udpFrame(rig, "a", "b"));
  rig.clock.runAll();
  const events: readonly EngineEvent[] = rig.log.events;
  assertEquals(events.map((e) => e.seq), events.map((_, i) => i));
  assertEquals(rig.log.toJsonl().trim().split("\n").length, events.length);
});
