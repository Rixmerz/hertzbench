// Channel model v1 (PLAN.md §8): log-distance path loss with seeded shadowing,
// obstacle attenuation, SNR to packet error rate, and a simple 802.11 MAC
// (rate pick by SNR, backoff, retries). No collisions and no carrier-sense
// contention: each link is simulated alone. docs/fidelity.md lists the limits.

import type { Rng } from "./rng.ts";

export const SPEED_OF_LIGHT_M_S = 299_792_458;

/** Metres. `z` is optional; obstacles are 2D and ignore it. */
export interface Position {
  x: number;
  y: number;
  z?: number;
}

export type Point2 = readonly [number, number];

/** A wall: a line segment that costs `attenuationDb` when the direct path crosses it. */
export interface Obstacle {
  from: Point2;
  to: Point2;
  attenuationDb: number;
}

export interface RadioConfig {
  /** 2.4 GHz Wi-Fi channel, 1-14. */
  channel: number;
  txPowerDbm: number;
  antennaGainDbi: number;
}

/** Defaults per environment preset. Typical textbook values, meant to be overridden per scenario. */
export const ENVIRONMENT_PRESETS = {
  free_space: {
    pathLossExponent: 2.0,
    shadowingSigmaDb: 0,
    jitterBaseMs: 0.05,
    jitterPerMeterMs: 0.001,
  },
  indoor_office: {
    pathLossExponent: 3.0,
    shadowingSigmaDb: 4,
    jitterBaseMs: 0.3,
    jitterPerMeterMs: 0.005,
  },
  urban: {
    pathLossExponent: 3.5,
    shadowingSigmaDb: 6,
    jitterBaseMs: 0.5,
    jitterPerMeterMs: 0.005,
  },
  rural: {
    pathLossExponent: 2.2,
    shadowingSigmaDb: 3,
    jitterBaseMs: 0.1,
    jitterPerMeterMs: 0.002,
  },
} as const;

export type PresetName = keyof typeof ENVIRONMENT_PRESETS;

export function isPresetName(value: string): value is PresetName {
  return Object.hasOwn(ENVIRONMENT_PRESETS, value);
}

export interface Environment {
  preset: PresetName;
  pathLossExponent: number;
  shadowingSigmaDb: number;
  /** Distance below which the path loss stops falling (d0 of the log-distance model). */
  referenceDistanceM: number;
  noiseFigureDb: number;
  jitterBaseMs: number;
  jitterPerMeterMs: number;
  /** Fixed latency added to every frame (driver and stack time the model does not simulate). */
  baseLatencyMs: number;
  obstacles: readonly Obstacle[];
}

export function environmentFromPreset(
  preset: PresetName,
  overrides: Partial<Omit<Environment, "preset">> = {},
): Environment {
  return {
    preset,
    ...ENVIRONMENT_PRESETS[preset],
    referenceDistanceM: 1,
    noiseFigureDb: 10,
    baseLatencyMs: 0,
    obstacles: [],
    ...overrides,
  };
}

// ── geometry ────────────────────────────────────────────────────────────────

export function distanceM(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}

function orientation(a: Point2, b: Point2, c: Point2): number {
  return Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
}

function onSegment(a: Point2, b: Point2, p: Point2): boolean {
  return Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);
}

/** True when segment a-b touches segment c-d. */
export function segmentsIntersect(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && onSegment(a, b, c)) || (o2 === 0 && onSegment(a, b, d)) ||
    (o3 === 0 && onSegment(c, d, a)) || (o4 === 0 && onSegment(c, d, b));
}

export function obstacleLossDb(a: Position, b: Position, obstacles: readonly Obstacle[]): number {
  let loss = 0;
  for (const wall of obstacles) {
    if (segmentsIntersect([a.x, a.y], [b.x, b.y], wall.from, wall.to)) loss += wall.attenuationDb;
  }
  return loss;
}

// ── propagation ─────────────────────────────────────────────────────────────

/** Centre frequency of a 2.4 GHz Wi-Fi channel. */
export function wifiChannelFrequencyHz(channel: number): number {
  if (!Number.isInteger(channel) || channel < 1 || channel > 14) {
    throw new RangeError(`2.4 GHz Wi-Fi channel must be 1-14, got ${channel}`);
  }
  return (channel === 14 ? 2484 : 2407 + 5 * channel) * 1e6;
}

/** Free-space loss at distance `d`: 20 log10(4 pi d f / c). */
export function freeSpaceLossDb(frequencyHz: number, distance: number): number {
  return 20 * Math.log10((4 * Math.PI * distance * frequencyHz) / SPEED_OF_LIGHT_M_S);
}

/** PL(d) = PL(d0) + 10 n log10(d / d0), with PL(d0) the free-space loss at d0. Shadowing is added separately. */
export function pathLossDb(env: Environment, frequencyHz: number, distance: number): number {
  const d0 = env.referenceDistanceM;
  const d = Math.max(distance, d0);
  return freeSpaceLossDb(frequencyHz, d0) + 10 * env.pathLossExponent * Math.log10(d / d0);
}

/** Thermal noise in a 20 MHz channel plus the receiver noise figure. */
export function noiseFloorDbm(noiseFigureDb: number, bandwidthHz = 20e6): number {
  return -174 + 10 * Math.log10(bandwidthHz) + noiseFigureDb;
}

export interface LinkBudget {
  distanceM: number;
  pathLossDb: number;
  obstacleLossDb: number;
  shadowingDb: number;
  rssiDbm: number;
  noiseFloorDbm: number;
  snrDb: number;
}

export interface Endpoint {
  position: Position;
  radio: RadioConfig;
}

/** What the budget needs to know about the signal, whatever the PHY. */
export interface RfParams {
  frequencyHz: number;
  /** Receiver bandwidth: sets the thermal noise floor. */
  bandwidthHz: number;
  noiseFigureDb: number;
}

/**
 * A chip-level PHY's signal (LoRa, nRF24, BLE): what a link budget is read
 * against between frames, and what says how good that budget is.
 */
export interface ChipSignal extends RfParams {
  txPowerDbm: number;
  /** SNR at which a frame of `referenceBytes` is lost 10% of the time. */
  requiredSnrDb: number;
  referenceBytes: number;
  /** Raw bit rate on the air. */
  rateBps: number;
}

export interface Transmitter {
  position: Position;
  txPowerDbm: number;
  antennaGainDbi: number;
}

export interface Receiver {
  position: Position;
  antennaGainDbi: number;
}

/**
 * RSSI = txPower + gains - pathLoss - shadowing - obstacleLoss. `shadowingDb`
 * is the seeded Gaussian sample X-sigma, positive meaning extra loss.
 */
export function linkBudgetAt(
  env: Environment,
  tx: Transmitter,
  rx: Receiver,
  rf: RfParams,
  shadowingDb: number,
): LinkBudget {
  const distance = distanceM(tx.position, rx.position);
  const pl = pathLossDb(env, rf.frequencyHz, distance);
  const walls = obstacleLossDb(tx.position, rx.position, env.obstacles);
  const rssi = tx.txPowerDbm + tx.antennaGainDbi + rx.antennaGainDbi - pl - shadowingDb - walls;
  const noise = noiseFloorDbm(rf.noiseFigureDb, rf.bandwidthHz);
  return {
    distanceM: distance,
    pathLossDb: pl,
    obstacleLossDb: walls,
    shadowingDb,
    rssiDbm: rssi,
    noiseFloorDbm: noise,
    snrDb: rssi - noise,
  };
}

/** The 2.4 GHz Wi-Fi budget: 20 MHz channel, the environment's noise figure. */
export function linkBudget(
  env: Environment,
  tx: Endpoint,
  rx: Endpoint,
  shadowingDb: number,
): LinkBudget {
  return linkBudgetAt(
    env,
    { position: tx.position, ...tx.radio },
    { position: rx.position, antennaGainDbi: rx.radio.antennaGainDbi },
    {
      frequencyHz: wifiChannelFrequencyHz(tx.radio.channel),
      bandwidthHz: 20e6,
      noiseFigureDb: env.noiseFigureDb,
    },
    shadowingDb,
  );
}

// ── PHY: rates, error rate, airtime ─────────────────────────────────────────

export interface WifiRate {
  mbps: number;
  /** SNR at which a 1000-byte frame is lost 10% of the time. */
  minSnrDb: number;
  /** Data bits per 4 microsecond OFDM symbol. */
  bitsPerSymbol: number;
}

/**
 * 802.11g OFDM rates. `minSnrDb` is the 802.11 minimum receiver sensitivity
 * (-82 dBm at 6 Mbit/s up to -65 dBm at 54 Mbit/s) minus a -91 dBm noise floor
 * (20 MHz, 10 dB noise figure). Conservative; replace the table to model a chip.
 */
export const WIFI_RATES: readonly WifiRate[] = [
  { mbps: 6, minSnrDb: 9, bitsPerSymbol: 24 },
  { mbps: 9, minSnrDb: 10, bitsPerSymbol: 36 },
  { mbps: 12, minSnrDb: 12, bitsPerSymbol: 48 },
  { mbps: 18, minSnrDb: 14, bitsPerSymbol: 72 },
  { mbps: 24, minSnrDb: 17, bitsPerSymbol: 96 },
  { mbps: 36, minSnrDb: 21, bitsPerSymbol: 144 },
  { mbps: 48, minSnrDb: 25, bitsPerSymbol: 192 },
  { mbps: 54, minSnrDb: 26, bitsPerSymbol: 216 },
];

const BASIC_RATE: WifiRate = WIFI_RATES[0] as WifiRate;

/** Highest rate the SNR supports, or the lowest rate when none does. */
export function pickRate(snrDb: number): WifiRate {
  let best = BASIC_RATE;
  for (const rate of WIFI_RATES) if (snrDb >= rate.minSnrDb) best = rate;
  return best;
}

/** The bit error rate falls tenfold for every this many dB of extra SNR (the steep part of a waterfall curve). */
const BER_DECADE_DB = 1.5;
const REFERENCE_FRAME_BYTES = 1000;
/** Survival probability of a reference frame exactly at `minSnrDb`. */
const SURVIVAL_AT_MIN_SNR = 0.9;

/**
 * Frame error rate for a frame of `bytes` at `snrDb` on `rate`. The bit error
 * rate grows tenfold per 1.5 dB below the rate's `minSnrDb`, and a frame
 * survives only if every bit does, so the loss curve is a cliff: a 100-byte
 * frame goes from about 1% to certain loss within roughly 4 dB. At `minSnrDb`
 * a 1000-byte frame is lost 10% of the time.
 */
export function packetErrorRate(snrDb: number, rate: WifiRate, bytes: number): number {
  const lambda = -Math.log(SURVIVAL_AT_MIN_SNR);
  const exponent = lambda * (bytes / REFERENCE_FRAME_BYTES) *
    10 ** ((rate.minSnrDb - snrDb) / BER_DECADE_DB);
  return 1 - Math.exp(-exponent);
}

/**
 * Frame error rate of a chip-level PHY (LoRa, nRF24) on the same waterfall:
 * the bit error rate falls tenfold per 1.5 dB of margin over `requiredSnrDb`,
 * and at that SNR a frame of `referenceBytes` is lost 10% of the time.
 */
export function chipPacketErrorRate(
  snrDb: number,
  requiredSnrDb: number,
  bytes: number,
  referenceBytes: number,
): number {
  const lambda = -Math.log(SURVIVAL_AT_MIN_SNR);
  const exponent = lambda * (Math.max(bytes, 1) / referenceBytes) *
    10 ** ((requiredSnrDb - snrDb) / BER_DECADE_DB);
  return 1 - Math.exp(-exponent);
}

const PREAMBLE_US = 20;
const SYMBOL_US = 4;
/** 802.11 MAC header (24) + LLC/SNAP (8) + FCS (4), replacing the 14-byte Ethernet header. */
const MAC_OVERHEAD_BYTES = 36;
const ETHERNET_HEADER_BYTES = 14;
const ACK_BYTES = 14;

export const SIFS_US = 16;
export const SLOT_US = 9;
export const DIFS_US = SIFS_US + 2 * SLOT_US;
const CW_MIN = 15;
const CW_MAX = 1023;

function ofdmAirtimeUs(psduBytes: number, rate: WifiRate): number {
  const bits = 16 + 8 * psduBytes + 6;
  return PREAMBLE_US + SYMBOL_US * Math.ceil(bits / rate.bitsPerSymbol);
}

/** Time on air of an Ethernet frame re-encapsulated as 802.11 data, in microseconds. */
export function airtimeUs(ethernetBytes: number, rate: WifiRate): number {
  const payload = Math.max(0, ethernetBytes - ETHERNET_HEADER_BYTES);
  return ofdmAirtimeUs(payload + MAC_OVERHEAD_BYTES, rate);
}

export const ACK_AIRTIME_US = ofdmAirtimeUs(ACK_BYTES, BASIC_RATE);
export const ACK_TIMEOUT_US = SIFS_US + SLOT_US + ACK_AIRTIME_US;

// ── one frame over one link ─────────────────────────────────────────────────

export interface TxParams {
  frameBytes: number;
  /** Broadcast and multicast: basic rate, one attempt, no ACK. */
  broadcast: boolean;
  /** Total transmit attempts for a unicast frame (802.11 short retry limit). */
  retryLimit: number;
  /** Chaos override: extra loss applied after the MAC succeeded, 0-100. */
  extraLossPct: number;
  extraLatencyMs: number;
}

export interface FrameOutcome {
  delivered: boolean;
  reason: "retry_exhausted" | "extra_loss" | null;
  attempts: number;
  rateMbps: number;
  /** Time from the sender starting to the receiver having the frame (or the sender giving up). */
  delayMs: number;
}

/**
 * Simulate one frame crossing one link. Draws only from `rng`, in a fixed
 * order, so the same rng stream and budget always give the same outcome.
 * The receiver gets the frame when the successful attempt ends; the ACK that
 * follows only matters to the sender, so it adds no delay to delivery.
 */
export function simulateFrame(
  env: Environment,
  budget: LinkBudget,
  params: TxParams,
  rng: Rng,
): FrameOutcome {
  const rate = params.broadcast ? BASIC_RATE : pickRate(budget.snrDb);
  const per = packetErrorRate(budget.snrDb, rate, params.frameBytes);
  const maxAttempts = params.broadcast ? 1 : Math.max(1, params.retryLimit);
  const onAir = airtimeUs(params.frameBytes, rate);

  let elapsedUs = 0;
  let attempts = 0;
  let received = false;
  while (attempts < maxAttempts && !received) {
    const window = Math.min(CW_MAX, (CW_MIN + 1) * 2 ** attempts - 1);
    elapsedUs += DIFS_US + rng.int(window + 1) * SLOT_US + onAir;
    attempts++;
    received = rng.next() >= per;
    if (!received && !params.broadcast) elapsedUs += ACK_TIMEOUT_US;
  }

  const propagationMs = (budget.distanceM / SPEED_OF_LIGHT_M_S) * 1000;
  const jitterMs = rng.next() * (env.jitterBaseMs + env.jitterPerMeterMs * budget.distanceM);
  const delayMs = elapsedUs / 1000 + propagationMs + env.baseLatencyMs + params.extraLatencyMs +
    jitterMs;
  const extraLoss = params.extraLossPct > 0 && rng.next() * 100 < params.extraLossPct;

  if (!received) {
    return { delivered: false, reason: "retry_exhausted", attempts, rateMbps: rate.mbps, delayMs };
  }
  if (extraLoss) {
    return { delivered: false, reason: "extra_loss", attempts, rateMbps: rate.mbps, delayMs };
  }
  return { delivered: true, reason: null, attempts, rateMbps: rate.mbps, delayMs };
}
