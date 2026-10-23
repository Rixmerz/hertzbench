// The chip-level air on a manual clock: timing, collisions, capture,
// half-duplex through the receiver's answer, and seeded determinism.

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  type AirFrame,
  AirMedium,
  type AirReceiver,
  environmentFromPreset,
  EventLog,
  type Hearing,
  ManualClock,
  PacedClock,
  type Position,
  type ReceptionQuality,
} from "../engine/mod.ts";

function frame(over: Partial<AirFrame> = {}): AirFrame {
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
    ...over,
  };
}

class FakeRadio implements AirReceiver {
  hearing: Hearing = "listen";
  stillListening = true;
  got: { from: string; text: string; quality: ReceptionQuality; t: number }[] = [];
  constructor(readonly clock: ManualClock) {}
  hear(): Hearing {
    return this.hearing;
  }
  receive(f: AirFrame, from: string, quality: ReceptionQuality): boolean {
    if (!this.stillListening) return false;
    this.got.push({
      from,
      text: new TextDecoder().decode(f.payload),
      quality,
      t: this.clock.now(),
    });
    return true;
  }
}

function rig(positions: Record<string, Position>, seed = 7) {
  const clock = new ManualClock();
  const log = new EventLog();
  const air = new AirMedium({
    seed,
    clock,
    log,
    environment: environmentFromPreset("free_space", { shadowingSigmaDb: 0 }),
  });
  const radios = new Map<string, FakeRadio>();
  for (const [id, position] of Object.entries(positions)) {
    const radio = new FakeRadio(clock);
    radios.set(id, radio);
    air.addNode({ id, position, antennaGainDbi: 0 }, radio);
  }
  const radio = (id: string) => radios.get(id)!;
  const outcomes = () =>
    log.events.flatMap((e) =>
      e.type === "deliver"
        ? [`${e.from}>${e.to} deliver`]
        : e.type === "drop"
        ? [`${e.from}>${e.to} ${e.reason}`]
        : []
    );
  return { clock, log, air, radio, outcomes };
}

Deno.test("air: a frame reaches a listening node when its airtime ends, with the budget", () => {
  const r = rig({ a: { x: 0, y: 0 }, gw: { x: 100, y: 0 } });
  r.air.transmit("a", frame());
  r.clock.advanceTo(49);
  assertEquals(r.radio("gw").got.length, 0);
  r.clock.advanceTo(51);
  const got = r.radio("gw").got;
  assertEquals(got.length, 1);
  assertEquals(got[0]!.text, "hello world 12345678");
  // 14 dBm minus 71.21 dB of free space at 100 m and 868.1 MHz
  assert(Math.abs(got[0]!.quality.rssiDbm - (14 - 71.21)) < 0.02);
  assertEquals(r.outcomes(), ["a>gw deliver"]);
  const tx = r.log.events.find((e) => e.type === "tx");
  assert(tx?.type === "tx" && tx.airtimeMs === 50 && tx.radio?.sf === 7);
});

Deno.test("air: a link's budget reads the declared signal, then the sender's last frame", () => {
  const r = rig({ gw: { x: 100, y: 0 } });
  const declared = {
    frequencyHz: 868.1e6,
    bandwidthHz: 125e3,
    noiseFigureDb: 6,
    txPowerDbm: 20,
    requiredSnrDb: -7.5,
    referenceBytes: 20,
    rateBps: 5468.75,
  };
  r.air.addNode(
    { id: "a", position: { x: 0, y: 0 }, antennaGainDbi: 0, signal: declared },
    new FakeRadio(r.clock),
  );
  const before = r.air.budget("a", "gw");
  assertEquals(before.signal, declared);
  assert(Math.abs(before.rssiDbm - (20 - 71.21)) < 0.02);
  // Firmware is the truth: once it transmits at 14 dBm, the budget follows the frame.
  r.air.transmit("a", frame({ txPowerDbm: 14 }));
  const after = r.air.budget("a", "gw");
  assertEquals(after.signal.txPowerDbm, 14);
  assert(Math.abs(after.rssiDbm - (14 - 71.21)) < 0.02);
  r.clock.runAll();
  const delivered = r.log.events.find((e) => e.type === "deliver");
  assert(delivered?.type === "deliver" && delivered.rssiDbm === after.rssiDbm);
  // A node that has neither sent nor declared a signal has no budget yet.
  assertThrows(() => r.air.budget("gw", "a"), Error, "no budget yet");
});

Deno.test("air: deaf radios log nothing, mismatched ones log phy_mismatch", () => {
  const r = rig({ a: { x: 0, y: 0 }, deaf: { x: 5, y: 0 }, other: { x: 6, y: 0 } });
  r.radio("deaf").hearing = "deaf";
  r.radio("other").hearing = "mismatch";
  r.air.transmit("a", frame());
  r.clock.runAll();
  assertEquals(r.outcomes(), ["a>other phy_mismatch"]);
});

Deno.test("air: equal-power overlap on one channel loses both frames", () => {
  const r = rig({ a: { x: -50, y: 0 }, b: { x: 50, y: 0 }, gw: { x: 0, y: 0 } });
  r.radio("a").hearing = "deaf";
  r.radio("b").hearing = "deaf";
  r.air.transmit("a", frame());
  r.clock.advanceTo(20);
  r.air.transmit("b", frame());
  r.clock.runAll();
  assertEquals(r.outcomes(), ["a>gw collision", "b>gw collision"]);
});

Deno.test("air: the stronger frame is captured when 6 dB above the other", () => {
  // 10 m against 100 m in free space: 20 dB apart.
  const r = rig({ near: { x: 10, y: 0 }, far: { x: 100, y: 0 }, gw: { x: 0, y: 0 } });
  r.radio("near").hearing = "deaf";
  r.radio("far").hearing = "deaf";
  r.air.transmit("far", frame());
  r.clock.advanceTo(10);
  r.air.transmit("near", frame());
  r.clock.runAll();
  assertEquals(r.outcomes(), ["far>gw collision", "near>gw deliver"]);
});

Deno.test("air: an interferer the receiver is deaf to still collides with a wanted frame", () => {
  const r = rig({ a: { x: -50, y: 0 }, b: { x: 50, y: 0 }, gw: { x: 0, y: 0 } });
  r.radio("a").hearing = "deaf";
  r.radio("b").hearing = "deaf";
  const gw = r.radio("gw");
  r.air.transmit("a", frame());
  gw.hearing = "deaf"; // e.g. an nRF24 frame for another address
  r.air.transmit("b", frame());
  r.clock.runAll();
  assertEquals(r.outcomes(), ["a>gw collision"]);
});

Deno.test("air: frames on different interference keys do not collide", () => {
  const r = rig({ a: { x: -50, y: 0 }, b: { x: 50, y: 0 }, gw: { x: 0, y: 0 } });
  r.radio("a").hearing = "deaf";
  r.radio("b").hearing = "deaf";
  r.air.transmit("a", frame());
  r.air.transmit("b", frame({ interferenceKey: "868.1/9" }));
  r.clock.runAll();
  assertEquals(r.outcomes(), ["a>gw deliver", "b>gw deliver"]);
});

Deno.test("air: frames that do not overlap in time do not collide", () => {
  const r = rig({ a: { x: -50, y: 0 }, b: { x: 50, y: 0 }, gw: { x: 0, y: 0 } });
  r.radio("a").hearing = "deaf";
  r.radio("b").hearing = "deaf";
  r.air.transmit("a", frame());
  r.clock.advanceTo(51);
  r.air.transmit("b", frame());
  r.clock.runAll();
  assertEquals(r.outcomes(), ["a>gw deliver", "b>gw deliver"]);
});

Deno.test("air: below the SNR floor the frame is lost to noise; a receiver that left RX drops it", () => {
  // 20 km of free space at 868 MHz: 117 dB, so -103 dBm against a -117 dBm floor
  // is +14 dB SNR. Ask for 40 dB to put it far below the floor. The node at
  // 10 m has 80 dB of SNR and decodes it, but has left its receive state.
  const r = rig({ a: { x: 0, y: 0 }, gw: { x: 20_000, y: 0 }, gone: { x: 10, y: 0 } });
  r.radio("gone").stillListening = false;
  r.air.transmit("a", frame({ requiredSnrDb: 40 }));
  r.clock.runAll();
  assertEquals(r.outcomes(), ["a>gone not_listening", "a>gw noise"]);
  r.air.transmit("a", frame());
  r.clock.runAll();
  assertEquals(r.outcomes().slice(2), ["a>gone not_listening", "a>gw deliver"]);
});

Deno.test("air: a 100% loss override drops every frame on that link only", () => {
  const r = rig({ a: { x: 0, y: 0 }, gw: { x: 10, y: 0 }, c: { x: 0, y: 10 } });
  r.air.setLinkOverride("a", "gw", { extraLossPct: 100, extraLatencyMs: 0 });
  r.air.transmit("a", frame());
  r.clock.runAll();
  assertEquals(r.outcomes(), ["a>gw extra_loss", "a>c deliver"]);
});

Deno.test("air: interference lowers the link's SNR in its budget and its frames; jitter delays them", () => {
  const r = rig({ a: { x: 0, y: 0 }, gw: { x: 100, y: 0 } });
  r.air.addNode({ id: "b", position: { x: 0, y: 100 }, antennaGainDbi: 0 }, new FakeRadio(r.clock));
  r.air.transmit("a", frame());
  r.clock.runAll();
  const clean = r.air.budget("a", "gw");
  // 59.8 dB of SNR at 100 m; 70 dB of noise rise puts it far under the -7.5 dB floor.
  r.air.setLinkOverride("a", "gw", { extraLossPct: 0, extraLatencyMs: 0, interferenceDb: 70 });
  assertEquals(r.air.budget("a", "gw").snrDb, clean.snrDb - 70);
  assertEquals(r.air.budget("a", "b").snrDb, clean.snrDb, "only the overridden link");
  r.air.transmit("a", frame());
  r.clock.runAll();
  assertEquals(r.outcomes().slice(2), ["a>gw noise", "a>b deliver"]);

  r.air.setLinkOverride("a", "b", { extraLossPct: 0, extraLatencyMs: 0, extraJitterMs: 30 });
  for (let i = 0; i < 10; i++) {
    r.air.transmit("a", frame());
    r.clock.advanceBy(60);
  }
  r.clock.runAll();
  const toB = r.log.events.flatMap((e) => e.type === "deliver" && e.to === "b" ? [e.delayMs] : [])
    .slice(2); // the two frames above reached b before the jitter
  assertEquals(toB.length, 10);
  assert(toB.every((d) => d >= 50 && d < 80.01), JSON.stringify(toB));
  assert(Math.max(...toB) - Math.min(...toB) > 10, JSON.stringify(toB));
});

Deno.test("air: same seed, same outcomes at a marginal SNR; another seed differs", () => {
  const run = (seed: number) => {
    const r = rig({ a: { x: 0, y: 0 }, gw: { x: 100, y: 0 } }, seed);
    for (let i = 0; i < 40; i++) {
      // 59.8 dB of SNR at 100 m; a 61 dB floor makes it about a coin toss.
      r.air.transmit("a", frame({ requiredSnrDb: 61 }));
      r.clock.advanceBy(60);
    }
    r.clock.runAll();
    return r.outcomes();
  };
  const first = run(1);
  assertEquals(run(1), first);
  assert(first.some((o) => o.endsWith("deliver")) && first.some((o) => o.endsWith("noise")));
  assert(JSON.stringify(run(2)) !== JSON.stringify(first));
});

Deno.test("paced clock: a sub-millisecond chain beats a later deadline even when the timer fires late", async () => {
  const clock = new PacedClock();
  const seen: string[] = [];
  const dueAndNow: [number, number][] = [];
  const start = clock.now();
  await new Promise<void>((resolve) => {
    clock.schedule(start + 1.5, () => {
      seen.push("deadline");
      resolve();
    });
    clock.schedule(start + 0.33, () => {
      dueAndNow.push([start + 0.33, clock.now()]);
      seen.push("end of packet");
      const ack = clock.now() + 0.13;
      clock.schedule(ack, () => {
        dueAndNow.push([ack, clock.now()]);
        seen.push("ack sent");
        const ackEnd = clock.now() + 0.07;
        clock.schedule(ackEnd, () => {
          dueAndNow.push([ackEnd, clock.now()]);
          seen.push("ack received");
        });
      });
    });
  });
  assertEquals(seen, ["end of packet", "ack sent", "ack received", "deadline"]);
  for (const [due, now] of dueAndNow) assertEquals(now, due);
  // Outside a callback it is real time again, which never runs behind.
  assert(clock.now() >= start + 1.5);
  clock.cancelAll();
});
