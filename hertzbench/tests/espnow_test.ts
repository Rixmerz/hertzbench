import { fileURLToPath } from "node:url";
import { ackWindowTest } from "./platform.ts";
import { assert, assertEquals } from "@std/assert";
import {
  ACK_AIRTIME_US,
  BROADCAST_MAC,
  buildEspNowAck,
  buildEspNowAction,
  buildEspNowBody,
  classifyFrame,
  computeMetrics,
  type EngineEvent,
  environmentFromPreset,
  ESPNOW_ACK_TIMEOUT_MS,
  espnowToRadiotap,
  type FrameSink,
  macToBytes,
  ManualClock,
  parseEspNow,
  parseEspNowBody,
  SIFS_US,
} from "../engine/mod.ts";
import { EventLog, Medium } from "../engine/mod.ts";
import { EspNowForkModel, type EspNowTxStatus } from "../orchestrator/boards/espnow-fork-model.ts";
import {
  dot11CapturePath,
  evaluateAssertions,
  loadScenario,
  type RunResult,
  runScenario,
} from "../orchestrator/mod.ts";
import { macFor, simulateEspNowTraffic } from "./helpers.ts";

const A = macFor(1);
const B = macFor(2);

/** A frame the way the fork writes it to the netdev, byte for byte. */
function forkBytes(dst: string, src: string, b12: number, b13: number, body: number[] = []) {
  return Uint8Array.from([...macToBytes(dst), ...macToBytes(src), b12, b13, ...body]);
}

// ── the fork's encoding ──────────────────────────────────────────────────────

Deno.test("espnow: classifies the fork's pseudo-Ethernet by its own checks", () => {
  // Action: (b12 & 0xE0) == 0xA0 and b13 == 0x0d, so the protected marker 0xB0 counts.
  assertEquals(classifyFrame(forkBytes(B, A, 0xa5, 0x0d, [127])), "espnow");
  assertEquals(classifyFrame(forkBytes(B, A, 0xb5, 0x0d, [127])), "espnow");
  // ACK: (b12 & 0xF0) == 0xA0 and b13 == 0x1d, so 0xB0 is not an ACK.
  assertEquals(classifyFrame(forkBytes(A, B, 0xa5, 0x1d)), "espnow-ack");
  assertEquals(classifyFrame(forkBytes(A, B, 0xb5, 0x1d)), "other");
  // Not the fork's marker: 0xE0 is the mask, not the value.
  assertEquals(classifyFrame(forkBytes(B, A, 0xe6, 0xd0)), "other");
  assertEquals(classifyFrame(forkBytes(B, A, 0xa5, 0x0e)), "other");

  const parsed = parseEspNow(forkBytes(B, A, 0xb9, 0x0d, [1, 2, 3]))!;
  assertEquals(parsed, {
    type: "action",
    dst: B,
    src: A,
    channel: 9,
    protected: true,
    body: Uint8Array.of(1, 2, 3),
  });
});

Deno.test("espnow: built frames are the fork's bytes, and the body round-trips its payload", () => {
  const body = buildEspNowBody(new TextEncoder().encode("temp=21"), 0x01020304);
  assertEquals(Array.from(body.subarray(0, 8)), [127, 0x18, 0xfe, 0x34, 1, 2, 3, 4]);
  assertEquals(Array.from(body.subarray(8, 15)), [0xdd, 5 + 7, 0x18, 0xfe, 0x34, 4, 1]);
  assertEquals(new TextDecoder().decode(parseEspNowBody(body)!), "temp=21");
  assertEquals(parseEspNowBody(Uint8Array.of(127, 0x18, 0xfe)), null);

  const action = buildEspNowAction({ dst: B, src: A, channel: 5, body });
  assertEquals(Array.from(action), Array.from(forkBytes(B, A, 0xa5, 0x0d, Array.from(body))));
  assertEquals(
    Array.from(buildEspNowAck({ dst: A, src: B, channel: 5 })),
    Array.from(forkBytes(A, B, 0xa5, 0x1d)),
  );
});

Deno.test("espnow: the 802.11 view of an action frame and its ACK, behind radiotap", () => {
  const action = espnowToRadiotap(forkBytes(B, A, 0xb6, 0x0d, [127, 9, 9]))!;
  assertEquals(Array.from(action), [
    // radiotap: version 0, pad, length 12, present = channel; 2437 MHz, 2 GHz
    0,
    0,
    12,
    0,
    0x08,
    0,
    0,
    0,
    0x85,
    0x09,
    0x80,
    0x00,
    // 802.11: action, protected; duration 0; dst; src; BSSID broadcast; sequence 0
    0xd0,
    0x40,
    0,
    0,
    ...macToBytes(B),
    ...macToBytes(A),
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0,
    0,
    127,
    9,
    9,
  ]);
  const ack = espnowToRadiotap(forkBytes(A, B, 0xa1, 0x1d))!;
  assertEquals(Array.from(ack), [
    0,
    0,
    12,
    0,
    0x08,
    0,
    0,
    0,
    0x6c,
    0x09,
    0x80,
    0x00, // 2412 MHz
    0xd4,
    0,
    0,
    0,
    ...macToBytes(A),
  ]);
  assertEquals(espnowToRadiotap(new Uint8Array(60)), null);
});

// ── the fork model ───────────────────────────────────────────────────────────

interface ModelProbe {
  model: EspNowForkModel;
  out: Uint8Array[];
  rx: { src: string; payload: string }[];
  done: { atMs: number; status: EspNowTxStatus }[];
}

function probe(clock: ManualClock, mac: string, channel = 5, output?: (f: Uint8Array) => void) {
  const p: ModelProbe = { out: [], rx: [], done: [], model: undefined as never };
  p.model = new EspNowForkModel({
    mac,
    channel,
    clock,
    output: (frame) => {
      p.out.push(frame);
      output?.(frame);
    },
    onReceive: (src, _dst, body) =>
      p.rx.push({ src, payload: new TextDecoder().decode(parseEspNowBody(body)!) }),
    onTxDone: (status) => p.done.push({ atMs: clock.now(), status }),
  });
  return p;
}

const body = (text: string) => buildEspNowBody(new TextEncoder().encode(text));

Deno.test("fork model: drops its own source MAC, other channels and other destinations", () => {
  const clock = new ManualClock();
  const b = probe(clock, B);
  // Same MAC on both boards: B drops A's frame, which is why each board needs its own.
  b.model.receive(buildEspNowAction({ dst: B, src: B, channel: 5, body: body("x") }));
  b.model.receive(buildEspNowAction({ dst: B, src: A, channel: 6, body: body("x") }));
  b.model.receive(buildEspNowAction({ dst: macFor(3), src: A, channel: 5, body: body("x") }));
  assertEquals(b.rx.length, 0);
  assertEquals(b.out.length, 0);

  b.model.receive(buildEspNowAction({ dst: B, src: A, channel: 5, body: body("uni") }));
  b.model.receive(buildEspNowAction({ dst: BROADCAST_MAC, src: A, channel: 5, body: body("bc") }));
  assertEquals(b.rx, [{ src: A, payload: "uni" }, { src: A, payload: "bc" }]);
  assertEquals(b.out.length, 1, "only the unicast frame is acknowledged");
  assertEquals(Array.from(b.out[0]!), Array.from(buildEspNowAck({ dst: A, src: B, channel: 5 })));
  assertEquals(b.model.receive(new Uint8Array(60)), false, "not ESP-NOW: not the model's");
});

Deno.test("fork model: one 10 ms ACK timer; an ACK pulls it in; a late ACK re-arms it", () => {
  const clock = new ManualClock();
  const a = probe(clock, A);
  a.model.send(B, body("one"));
  clock.advanceTo(3);
  a.model.receive(buildEspNowAck({ dst: A, src: B, channel: 5 }));
  clock.advanceTo(20);
  assertEquals(a.done, [{ atMs: 3, status: "ack" }]);

  a.model.send(B, body("two"));
  clock.advanceTo(40);
  assertEquals(a.done[1], { atMs: 30, status: "nack" });
  // The fork does not check which frame an ACK answers: a late one completes again.
  a.model.receive(buildEspNowAck({ dst: A, src: B, channel: 5 }));
  clock.advanceTo(41);
  assertEquals(a.done[2], { atMs: 40, status: "ack" });

  a.model.send(BROADCAST_MAC, body("all"));
  clock.advanceTo(42);
  assertEquals(a.done[3], { atMs: 41, status: "ack" }, "a broadcast completes at once");
});

Deno.test("fork model: ackTimeoutMs moves the timer, so an ACK after 10 ms still completes the send", () => {
  const clock = new ManualClock();
  const done: { atMs: number; status: string }[] = [];
  const model = new EspNowForkModel({
    mac: A,
    channel: 5,
    clock,
    ackTimeoutMs: 40,
    output: () => {},
    onReceive: () => {},
    onTxDone: (status) => done.push({ atMs: clock.now(), status }),
  });
  model.send(B, body("one"));
  clock.advanceTo(12);
  assertEquals(done, [], "the fork's 10 ms has passed and the send is still waiting");
  model.receive(buildEspNowAck({ dst: A, src: B, channel: 5 }));
  clock.advanceTo(60);
  assertEquals(done, [{ atMs: 12, status: "ack" }], "one completion, no stray one at 40 ms");

  model.send(B, body("two"));
  clock.advanceTo(100);
  assertEquals(
    done[1],
    { atMs: 100, status: "nack" },
    "silence still fails, after the longer wait",
  );
});

// ── fork models on the medium ────────────────────────────────────────────────

interface Pair {
  clock: ManualClock;
  log: EventLog;
  medium: Medium;
  a: ModelProbe;
  b: ModelProbe;
}

/** Two fork models on a medium: a at the origin, b `distance` metres away, both on channel 5. */
function forkPair(distance: number, options: { seed?: number; bGuestChannel?: number } = {}): Pair {
  const clock = new ManualClock();
  const log = new EventLog();
  const medium = new Medium({
    seed: options.seed ?? 7,
    environment: environmentFromPreset("indoor_office", { shadowingSigmaDb: 0 }),
    clock,
    log,
  });
  const a = probe(clock, A, 5, (frame) => medium.transmit("a", frame));
  const b = probe(clock, B, options.bGuestChannel ?? 5, (frame) => medium.transmit("b", frame));
  const sink = (p: ModelProbe): FrameSink => ({
    ready: () => true,
    deliver: (frame) => p.model.receive(frame),
  });
  const radio = { channel: 5, txPowerDbm: 15, antennaGainDbi: 0 };
  medium.addNode({ id: "a", mac: A, position: { x: 0, y: 0 }, radio }, sink(a));
  medium.addNode({ id: "b", mac: B, position: { x: distance, y: 0 }, radio }, sink(b));
  return { clock, log, medium, a, b };
}

const sends = (events: readonly EngineEvent[]) =>
  events.filter((e): e is Extract<EngineEvent, { type: "espnow-send" }> =>
    e.type === "espnow-send"
  );

Deno.test("espnow on the medium: distinct MACs, one frame, one ACK back inside the window", () => {
  const { clock, log, a, b } = forkPair(5);
  a.model.send(B, body("hello"));
  clock.runAll();
  assertEquals(b.rx, [{ src: A, payload: "hello" }]);
  assertEquals(a.done.map((d) => d.status), ["ack"]);
  const [send] = sends(log.events);
  assertEquals(send?.outcome, "acked");
  assert(send!.roundTripMs! > 0 && send!.roundTripMs! < 1, `round trip ${send!.roundTripMs}`);
  // The ACK takes no channel-model draw and no retry: one attempt, SIFS + airtime + propagation.
  const ack = log.events.find((e) => e.type === "deliver" && e.kind === "espnow-ack");
  assert(ack && ack.type === "deliver");
  assertEquals(ack.attempts, 1);
  const propagationMs = (5 / 299_792_458) * 1000;
  assertEquals(ack.delayMs, (SIFS_US + ACK_AIRTIME_US) / 1000 + propagationMs);
  assertEquals(a.done[0]!.atMs, ack.t + ack.delayMs);
});

Deno.test("espnow on the medium: broadcasts are not acknowledged and leave no pending send", () => {
  const { clock, log, a, b } = forkPair(5);
  a.model.send(BROADCAST_MAC, body("beacon"));
  clock.runAll();
  b.model.send(BROADCAST_MAC, body("beacon"));
  clock.runAll();
  assertEquals(a.rx.length + b.rx.length, 2);
  assertEquals(log.events.filter((e) => e.type === "tx" && e.kind === "espnow-ack").length, 0);
  assertEquals(sends(log.events).length, 0);
});

/**
 * The latency sweep. The fork waits 10 ms of guest time for the ACK; the round
 * trip is the action frame's modelled delay plus the ACK's. Extra latency on
 * either leg moves the round trip; the sender must see ACK exactly when the
 * engine says the round trip fits, NACK otherwise, and never a completion it
 * did not earn.
 */
for (const leg of ["a->b", "b->a"] as const) {
  Deno.test(`espnow latency sweep on the ${leg} leg: ACK iff the round trip fits in 10 ms`, () => {
    const roundTrips: { rt: number; outcome: string; status: EspNowTxStatus }[] = [];
    for (let extraMs = 0; extraMs <= 14; extraMs += 0.5) {
      const { clock, log, medium, a, b } = forkPair(20, { seed: 11 });
      const [from, to] = leg === "a->b" ? ["a", "b"] : ["b", "a"];
      medium.setLinkOverride(from, to, { extraLossPct: 0, extraLatencyMs: extraMs });
      const frames = 20;
      for (let i = 0; i < frames; i++) {
        clock.advanceTo(i * 50);
        a.model.send(B, body(`n${i}`));
      }
      clock.advanceTo(frames * 50 + 100);
      medium.close();

      const outcomes = sends(log.events);
      assertEquals(b.rx.length, frames, "every frame reaches b whatever the latency");
      assertEquals(outcomes.length, frames, `extra ${extraMs} ms: one outcome per send`);
      assertEquals(a.done.length, frames, `extra ${extraMs} ms: one completion per send`);
      outcomes.forEach((send, i) => {
        const done = a.done[i]!;
        roundTrips.push({ rt: send.roundTripMs!, outcome: send.outcome, status: done.status });
        // The sender completes at its own 10 ms timer on a NACK, at the ACK's arrival otherwise.
        if (send.outcome === "acked") {
          assert(send.roundTripMs! <= ESPNOW_ACK_TIMEOUT_MS);
          assertEquals(done.status, "ack");
          assertEquals(done.atMs, i * 50 + send.roundTripMs!);
        } else {
          assertEquals(send.outcome, "ack_timeout");
          assert(send.roundTripMs! > ESPNOW_ACK_TIMEOUT_MS);
          assertEquals(done, { atMs: i * 50 + ESPNOW_ACK_TIMEOUT_MS, status: "nack" });
        }
      });
      const late = outcomes.filter((s) => s.outcome === "ack_timeout").length;
      const metrics = computeMetrics(log.events, clock.now());
      const link = metrics.total.find((l) => l.from === "a" && l.to === "b")!;
      assertEquals(link.espnow!.sends, frames);
      assertEquals(link.espnow!.acked, frames - late);
      assertEquals(metrics.warnings.length, late > 0 ? 1 : 0);
    }
    // The sweep crossed the boundary, and the boundary sits at 10 ms of round trip.
    const acked = roundTrips.filter((r) => r.outcome === "acked");
    const late = roundTrips.filter((r) => r.outcome === "ack_timeout");
    assert(acked.length > 0 && late.length > 0, "the sweep must cross the ACK window");
    assert(Math.max(...acked.map((r) => r.rt)) <= ESPNOW_ACK_TIMEOUT_MS);
    assert(Math.min(...late.map((r) => r.rt)) > ESPNOW_ACK_TIMEOUT_MS);
    assert(Math.max(...acked.map((r) => r.rt)) > ESPNOW_ACK_TIMEOUT_MS - 1, "acked up to the edge");
  });
}

Deno.test("espnow: a lost frame is frame_lost, and an ACK answering nothing is dropped", () => {
  const { clock, log, medium, a, b } = forkPair(5);
  medium.setLinkOverride("a", "b", { extraLossPct: 100, extraLatencyMs: 0 });
  a.model.send(B, body("gone"));
  clock.runAll();
  assertEquals(b.rx.length, 0);
  assertEquals(a.done.map((d) => d.status), ["nack"]);
  assertEquals(sends(log.events).map((s) => s.outcome), ["frame_lost"]);

  // b answers a frame a never sent; the engine does not hand a an ACK it cannot place.
  medium.transmit("b", buildEspNowAck({ dst: A, src: B, channel: 5 }));
  clock.runAll();
  assertEquals(a.done.length, 1);
  const drop = log.events.findLast((e) => e.type === "drop");
  assert(drop && drop.type === "drop");
  assertEquals([drop.kind, drop.reason, drop.from, drop.to], [
    "espnow-ack",
    "ack_unmatched",
    "b",
    "a",
  ]);
});

Deno.test("espnow: a frame the receiver never answers is no_ack, at the next send or at close", () => {
  // b's guest is on channel 6 while the scenario says 5: the engine delivers,
  // b's fork drops the frame and stays silent.
  const { clock, log, medium, a, b } = forkPair(5, { bGuestChannel: 6 });
  a.model.send(B, body("one"));
  clock.advanceBy(50);
  a.model.send(B, body("two"));
  clock.advanceBy(50);
  medium.close();
  assertEquals(b.rx.length, 0);
  assertEquals(a.done.map((d) => d.status), ["nack", "nack"]);
  assertEquals(sends(log.events).map((s) => s.outcome), ["no_ack", "no_ack"]);
});

Deno.test("espnow: the channel is the one the guest wrote into byte 12", () => {
  const { clock, log, medium, b } = forkPair(5);
  // The scenario says channel 5, the guest transmits on 6: b (on 5) does not hear it.
  medium.transmit("a", buildEspNowAction({ dst: B, src: A, channel: 6, body: body("x") }));
  medium.transmit("a", buildEspNowAction({ dst: B, src: A, channel: 6, body: body("y") }));
  clock.runAll();
  assertEquals(b.rx.length, 0);
  const drops = log.events.filter((e) => e.type === "drop");
  assertEquals(drops.map((d) => d.type === "drop" && d.reason), [
    "channel_mismatch",
    "channel_mismatch",
  ]);
  const warnings = computeMetrics(log.events, clock.now()).warnings;
  assertEquals(warnings.length, 1, "warned once per node");
  assert(warnings[0]!.includes("channel 6"));
});

// ── scripted ESP-NOW boards through the adapter, on the wall clock ───────────

/** Run a scenario; returns its result and the 802.11 capture, read before the files go. */
async function runYaml(yaml: string): Promise<{ result: RunResult; dot11: Uint8Array | null }> {
  const dir = await Deno.makeTempDir({ prefix: "hzb-espnow-" });
  try {
    await Deno.writeTextFile(`${dir}/s.yaml`, yaml);
    const loaded = await loadScenario(`${dir}/s.yaml`, `${dir}/out`);
    const result = await runScenario(loaded.scenario, {
      outDir: loaded.outDir,
      outputs: loaded.outputs,
    });
    const dot11Path = dot11CapturePath(loaded.outputs.pcap);
    const dot11 = result.files.includes(dot11Path) ? await Deno.readFile(dot11Path) : null;
    return { result, dot11 };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const serial = (result: RunResult, node: string) =>
  result.events.flatMap((e) => (e.type === "serial" && e.node === node ? [e.text] : []));

function espnowPair(extraLatencyMs: number, assertions = "") {
  return `
name: espnow-pair
seed: 5
duration: 2s
environment: { shadowing_sigma_db: 0 }
nodes:
  - id: a
    board: scripted
    position: [0, 0]
    firmware: { send: [{ to: b, via: espnow, every: 50ms, count: 20, payload: hello }] }
  - id: b
    board: scripted
    position: [6, 0]
    firmware: { send: [{ to: broadcast, via: espnow, every: 100ms, count: 5, payload: beacon }] }
links:
  - { from: a, to: b, extra_latency_ms: ${extraLatencyMs} }
${assertions}`;
}

ackWindowTest(
  "runner: scripted ESP-NOW unicast is acknowledged, broadcast is heard, metrics count both",
  async () => {
    const { result, dot11 } = await runYaml(espnowPair(
      0,
      `assertions:
  - serial: { node: b, contains: "espnow rx hello:0 from a" }
  - serial: { node: a, contains: "espnow rx beacon:0 from b" }
  - metric: { link: "a->b", kind: espnow, sent: { eq: 20 }, acked_pct: { gt: 50 }, ack_rtt_p95_ms: { lt: 10 } }
`,
    ));
    for (const a of result.assertions) assert(a.passed, `${a.description}: ${a.detail}`);
    assertEquals(result.problems, []);
    const link = result.metrics.total.find((l) => l.from === "a" && l.to === "b")!;
    assertEquals(link.espnow!.sends, 20);
    // Wall clock: two timers and loopback TCP per round trip, so not every ACK is
    // promised; the engine and the sender's model must agree on each one.
    const ok = serial(result, "a").filter((t) => t === "espnow tx ok to b").length;
    assertEquals(ok, link.espnow!.acked);
    assertEquals(serial(result, "b").filter((t) => t.startsWith("espnow rx hello")).length, 20);
    assertEquals(serial(result, "b").filter((t) => t === "espnow tx ok to broadcast").length, 5);
    assert(
      !result.events.some((e) => e.type === "tx" && e.node === "a" && e.kind === "espnow-ack"),
    );

    // Every ESP-NOW frame and ACK on the air is in the 802.11 capture, as radiotap.
    assert(dot11, "an ESP-NOW run writes the 802.11 capture");
    const view = new DataView(dot11.buffer);
    assertEquals(view.getUint32(20, true), 127);
    let records = 0;
    for (let offset = 24; offset < dot11.length; records++) {
      offset += 16 + view.getUint32(offset + 8, true);
    }
    const onAir = result.events.filter((e) =>
      e.type === "tx" && (e.kind === "espnow" || e.kind === "espnow-ack")
    );
    assertEquals(records, onAir.length);
  },
);

ackWindowTest(
  "runner: 7 ms more on the a->b leg leaves 3 ms of margin, and the sender still sees every ACK the engine counted",
  async () => {
    const { result } = await runYaml(espnowPair(7));
    const link = result.metrics.total.find((l) => l.from === "a" && l.to === "b")!;
    const lines = serial(result, "a");
    // The engine times the round trip from the medium; the board's wait starts at its own
    // send, one loopback hop earlier, and the ACK needs another to get back. Those hops
    // take about as long as the margin, so a board that waited exactly 10 ms would report
    // "fail" for ACKs the engine counted, and the ACK would land as a stray completion.
    assert(link.espnow!.acked > 0, "the engine must count ACKs for this to prove anything");
    assertEquals(lines.filter((t) => t === "espnow tx ok to b").length, link.espnow!.acked);
    assert(!lines.some((t) => t.includes("nothing in flight")), "no ACK landed after the wait");
  },
);

Deno.test("runner: 15 ms more on the a->b leg fails every ESP-NOW send at the sender, and says why", async () => {
  const { result } = await runYaml(espnowPair(15));
  const link = result.metrics.total.find((l) => l.from === "a" && l.to === "b")!;
  assertEquals(link.espnow!.sends, 20);
  assertEquals(link.espnow!.outcomes, { ack_timeout: 20 });
  assertEquals(serial(result, "a").filter((t) => t === "espnow tx fail to b").length, 20);
  assert(
    !serial(result, "a").some((t) => t.includes("tx ok to b") || t.includes("nothing in flight")),
  );
  // The frames themselves arrived: the failure is the ACK window, not the radio.
  assertEquals(serial(result, "b").filter((t) => t.startsWith("espnow rx hello")).length, 20);
  assert(result.metrics.warnings.some((w) => w.includes("a->b") && w.includes("10 ms ACK wait")));
});

// ── the example scenarios' geometry, judged by the engine alone ──────────────

const EXAMPLES = fileURLToPath(new URL("../scenarios/examples/", import.meta.url));

for (
  const [file, sensorEveryMs] of [
    ["espnow-mesh-scripted.yaml", 100],
    ["espnow-mesh-5-nodes.yaml", 500],
  ] as const
) {
  Deno.test(`example ${file}: readings are acknowledged until sensor-4 walks away`, async () => {
    const { scenario } = await loadScenario(`${EXAMPLES}${file}`);
    // What the sketches and scripts send: each sensor to the gateway, the gateway's beacon.
    const traffic = [1, 2, 3, 4].map((i) => ({
      from: `sensor-${i}`,
      to: "gw",
      everyMs: sensorEveryMs,
    }));
    const log = simulateEspNowTraffic(scenario, [
      ...traffic,
      { from: "gw", to: "broadcast", everyMs: 1000 },
    ]);
    const metrics = computeMetrics(log.events, scenario.durationMs);
    const metricAssertions = scenario.assertions.filter((a) => a.kind === "metric");
    assert(metricAssertions.length >= 3, "the example should assert on the experiment");
    const results = evaluateAssertions(metricAssertions, log.events, metrics.phases);
    for (const r of results) assert(r.passed, `${r.description}: ${r.detail}`);

    const far = metrics.phases.find((p) => p.label === "far")!.links.find((l) =>
      l.from === "sensor-4" && l.to === "gw"
    )!;
    const near = metrics.phases.find((p) => p.label === "start")!.links.find((l) =>
      l.from === "sensor-4" && l.to === "gw"
    )!;
    assert(far.rssiDbm < near.rssiDbm - 10, `rssi ${near.rssiDbm} -> ${far.rssiDbm}`);
    assert(far.espnow!.ackedPct < near.espnow!.ackedPct - 40);
  });
}

// The real-firmware run (docs/e2e-esp32.md) boots the boards seconds apart. A
// sensor that sends before the gateway is up gets no ACK, its driver resends
// dozens of times a second, and phase "start" then measures the boot order.
Deno.test("example espnow-sensor sketch: sends readings only after it has heard the gateway", async () => {
  const sketch = await Deno.readTextFile(`${EXAMPLES}fw/espnow-sensor/espnow-sensor.ino`);
  const receive = sketch.slice(sketch.indexOf("static void handleReceive("));
  const receiveBody = receive.slice(0, receive.indexOf("\n}\n"));
  assert(
    /if \(fromGateway\) gatewayHeard = true;/.test(receiveBody),
    "a gateway frame opens the gate",
  );
  const loop = sketch.slice(sketch.indexOf("void loop()"));
  const gate = loop.indexOf("if (gatewayHeard &&");
  const send = loop.indexOf("esp_now_send(GATEWAY");
  assert(gate !== -1 && send > gate, "loop() sends to the gateway only behind the gate");
  assertEquals(sketch.split("esp_now_send(").length - 1, 1, "no other send bypasses it");
});
