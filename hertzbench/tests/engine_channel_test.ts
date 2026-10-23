import {
  assert,
  assertAlmostEquals,
  assertEquals,
  assertNotEquals,
  assertThrows,
} from "@std/assert";
import {
  ACK_AIRTIME_US,
  ACK_TIMEOUT_US,
  airtimeUs,
  createRng,
  DIFS_US,
  distanceM,
  environmentFromPreset,
  freeSpaceLossDb,
  linkBudget,
  noiseFloorDbm,
  packetErrorRate,
  pathLossDb,
  pickRate,
  segmentsIntersect,
  simulateFrame,
  substream,
  type TxParams,
  WIFI_RATES,
  wifiChannelFrequencyHz,
} from "../engine/mod.ts";

const RATE_6 = WIFI_RATES[0]!;
const RATE_54 = WIFI_RATES[7]!;
const CHANNEL_6_HZ = 2.437e9;

Deno.test("rng: same seed repeats, golden first values stay put", () => {
  const a = createRng(42);
  const b = createRng(42);
  const first = [a.next(), a.next(), a.next()];
  assertEquals(first, [b.next(), b.next(), b.next()]);
  // Frozen from the first implementation: a change here changes every seeded run.
  assertAlmostEquals(first[0]!, 0.1327915932, 1e-9);
  assertAlmostEquals(first[1]!, 0.6235251611, 1e-9);
  assertAlmostEquals(first[2]!, 0.5126558258, 1e-9);
});

Deno.test("rng: different seeds and different substream labels diverge", () => {
  assertNotEquals(createRng(1).next(), createRng(2).next());
  assertNotEquals(substream(7, "a>b#0").next(), substream(7, "a>b#1").next());
  assertEquals(substream(7, "a>b#0").next(), substream(7, "a>b#0").next());
});

Deno.test("rng: values are in range and roughly uniform and normal", () => {
  const rng = createRng("stats");
  let sum = 0;
  let sumSquares = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) {
    const u = rng.next();
    assert(u >= 0 && u < 1);
    sum += u;
    const g = rng.gaussian();
    sumSquares += g * g;
  }
  assertAlmostEquals(sum / n, 0.5, 0.01);
  assertAlmostEquals(sumSquares / n, 1, 0.05);
  for (let i = 0; i < 1000; i++) assert(rng.int(7) >= 0 && rng.int(7) < 7);
  assertThrows(() => rng.int(0), RangeError);
});

Deno.test("propagation: free-space loss at 1 m on channel 6 is 40.18 dB", () => {
  assertAlmostEquals(freeSpaceLossDb(wifiChannelFrequencyHz(6), 1), 40.1849, 1e-3);
  assertEquals(wifiChannelFrequencyHz(1), 2.412e9);
  assertEquals(wifiChannelFrequencyHz(14), 2.484e9);
  assertThrows(() => wifiChannelFrequencyHz(15), RangeError);
});

Deno.test("propagation: log-distance loss follows the exponent of the preset", () => {
  const free = environmentFromPreset("free_space");
  const office = environmentFromPreset("indoor_office");
  // +20 dB per decade at n=2, +30 dB at n=3, from the same 1 m reference.
  assertAlmostEquals(pathLossDb(free, CHANNEL_6_HZ, 10), 40.1849 + 20, 1e-3);
  assertAlmostEquals(pathLossDb(office, CHANNEL_6_HZ, 10), 40.1849 + 30, 1e-3);
  assertAlmostEquals(pathLossDb(office, CHANNEL_6_HZ, 100), 40.1849 + 60, 1e-3);
  // Inside d0 the loss does not go below the reference.
  assertAlmostEquals(pathLossDb(office, CHANNEL_6_HZ, 0.1), 40.1849, 1e-3);
});

Deno.test("propagation: noise floor of a 20 MHz channel with a 10 dB noise figure", () => {
  assertAlmostEquals(noiseFloorDbm(10), -90.9897, 1e-3);
});

Deno.test("link budget: RSSI = tx power - path loss - shadowing - walls", () => {
  const env = environmentFromPreset("free_space", {
    obstacles: [{ from: [5, -5], to: [5, 5], attenuationDb: 12 }],
  });
  const radio = { channel: 6, txPowerDbm: 20, antennaGainDbi: 0 };
  const tx = { position: { x: 0, y: 0 }, radio };
  const through = linkBudget(env, tx, { position: { x: 10, y: 0 }, radio }, 0);
  assertAlmostEquals(through.distanceM, 10);
  assertEquals(through.obstacleLossDb, 12);
  assertAlmostEquals(through.rssiDbm, 20 - (40.1849 + 20) - 12, 1e-3);
  assertAlmostEquals(through.snrDb, through.rssiDbm + 90.9897, 1e-3);

  const clear = linkBudget(env, tx, { position: { x: 0, y: 10 }, radio }, 0);
  assertEquals(clear.obstacleLossDb, 0);

  const shadowed = linkBudget(env, tx, { position: { x: 0, y: 10 }, radio }, 5);
  assertAlmostEquals(shadowed.rssiDbm, clear.rssiDbm - 5, 1e-9);
});

Deno.test("geometry: distance and segment intersection", () => {
  assertAlmostEquals(distanceM({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  assertAlmostEquals(distanceM({ x: 0, y: 0, z: 0 }, { x: 0, y: 3, z: 4 }), 5);
  assert(segmentsIntersect([0, 0], [10, 0], [5, -1], [5, 1]));
  assert(!segmentsIntersect([0, 0], [4, 0], [5, -1], [5, 1]));
  assert(segmentsIntersect([0, 0], [10, 0], [5, 0], [5, 3])); // touching counts
});

Deno.test("rate selection: highest rate the SNR supports, else the basic rate", () => {
  assertEquals(pickRate(40).mbps, 54);
  assertEquals(pickRate(26).mbps, 54);
  assertEquals(pickRate(25.9).mbps, 48);
  assertEquals(pickRate(17).mbps, 24);
  assertEquals(pickRate(9).mbps, 6);
  assertEquals(pickRate(-5).mbps, 6);
});

Deno.test("error rate: 10% at the rate's threshold for 1000 bytes, a cliff below it", () => {
  assertAlmostEquals(packetErrorRate(26, RATE_54, 1000), 0.1, 1e-12);
  // Shorter frames survive more, longer ones less.
  assert(packetErrorRate(26, RATE_54, 100) < 0.02);
  assert(packetErrorRate(26, RATE_54, 1500) > 0.1);
  // 3 dB under the threshold a 100 byte frame is lost about 65% of the time.
  assertAlmostEquals(packetErrorRate(23, RATE_54, 100), 0.6513, 1e-3);
  // Monotone in SNR.
  let previous = 1;
  for (let snr = -10; snr <= 40; snr += 0.5) {
    const per = packetErrorRate(snr, RATE_54, 300);
    assert(per <= previous + 1e-12, `PER rose at ${snr} dB`);
    previous = per;
  }
  assert(packetErrorRate(60, RATE_54, 1500) < 1e-9);
  assertEquals(packetErrorRate(-30, RATE_6, 100), 1);
});

Deno.test("airtime: hand-computed 802.11g values", () => {
  // 1014 byte Ethernet frame = 1000 B payload + 36 B of MAC/LLC/FCS = 1036 B PSDU.
  // (16 + 8*1036 + 6) / 216 bits per symbol = 38.5 -> 39 symbols; 20 us preamble + 39*4.
  assertEquals(airtimeUs(1014, RATE_54), 176);
  assertEquals(ACK_AIRTIME_US, 44);
  assertEquals(ACK_TIMEOUT_US, 69);
  assertEquals(DIFS_US, 34);
  assert(airtimeUs(1014, RATE_6) > airtimeUs(1014, RATE_54));
});

const unicast: TxParams = {
  frameBytes: 120,
  broadcast: false,
  retryLimit: 7,
  extraLossPct: 0,
  extraLatencyMs: 0,
};

function budgetAt(distance: number, shadowingDb = 0) {
  const env = environmentFromPreset("indoor_office");
  const radio = { channel: 6, txPowerDbm: 8, antennaGainDbi: 0 };
  return {
    env,
    budget: linkBudget(
      env,
      { position: { x: 0, y: 0 }, radio },
      { position: { x: distance, y: 0 }, radio },
      shadowingDb,
    ),
  };
}

function runFrames(distance: number, count: number, params: TxParams = unicast) {
  const { env, budget } = budgetAt(distance);
  let delivered = 0;
  let attempts = 0;
  const delays: number[] = [];
  for (let i = 0; i < count; i++) {
    const outcome = simulateFrame(env, budget, params, substream(99, `d${distance}#${i}`));
    attempts += outcome.attempts;
    if (outcome.delivered) {
      delivered++;
      delays.push(outcome.delayMs);
    }
  }
  delays.sort((a, b) => a - b);
  return { loss: 1 - delivered / count, meanAttempts: attempts / count, delays };
}

Deno.test("frame simulation: a close link delivers everything in one attempt, fast", () => {
  const near = runFrames(10, 400);
  assertEquals(near.loss, 0);
  assertAlmostEquals(near.meanAttempts, 1, 0.01);
  assert(near.delays[near.delays.length - 1]! < 1, "a 10 m link should stay under 1 ms");
});

Deno.test("frame simulation: moving the receiver far raises latency, then loss", () => {
  // 8 dBm in an indoor office: the lowest rate stops holding around 55 m.
  const near = runFrames(10, 400);
  const mid = runFrames(50, 400);
  const cliff = runFrames(60, 400);
  const beyond = runFrames(70, 400);
  const medianOf = (r: { delays: number[] }) => r.delays[Math.floor(r.delays.length / 2)]!;
  const p95Of = (r: { delays: number[] }) => r.delays[Math.floor(r.delays.length * 0.95)]!;
  // Latency climbs first: the rate falls back from 54 to 6 Mbit/s well before any loss.
  assertEquals(mid.loss, 0);
  assert(medianOf(mid) > 1.5 * medianOf(near), "rate fallback should show in the median");
  // Past the cliff retries pile up, then every frame is lost.
  assert(cliff.loss > 0.3 && cliff.loss < 0.95, `loss at the cliff was ${cliff.loss}`);
  assert(cliff.meanAttempts > 3);
  assert(p95Of(cliff) > 5 * p95Of(near));
  assertEquals(beyond.loss, 1);
});

Deno.test("frame simulation: same stream, same outcome", () => {
  const { env, budget } = budgetAt(80);
  const a = simulateFrame(env, budget, unicast, substream(5, "x"));
  const b = simulateFrame(env, budget, unicast, substream(5, "x"));
  assertEquals(a, b);
});

Deno.test("frame simulation: broadcast makes one attempt at the basic rate", () => {
  const { env, budget } = budgetAt(10);
  const outcome = simulateFrame(env, budget, { ...unicast, broadcast: true }, substream(1, "b"));
  assertEquals(outcome.attempts, 1);
  assertEquals(outcome.rateMbps, 6);
});

Deno.test("frame simulation: chaos overrides add loss and latency", () => {
  const dropAll = runFrames(10, 200, { ...unicast, extraLossPct: 100 });
  assertEquals(dropAll.loss, 1);
  const half = runFrames(10, 2000, { ...unicast, extraLossPct: 50 });
  assertAlmostEquals(half.loss, 0.5, 0.05);
  const slow = runFrames(10, 50, { ...unicast, extraLatencyMs: 25 });
  assert(slow.delays[0]! >= 25);
});
