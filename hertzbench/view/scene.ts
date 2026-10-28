// What the map and the packet timeline show, computed here on the server from
// the run's event log and link budgets, so the browser only draws. Quality
// buckets come from the channel model's own rate table (Wi-Fi) and error curve
// (LoRa, nRF24, BLE), not from numbers made up for the picture.

import {
  chipPacketErrorRate,
  type ChipSignal,
  type EngineEvent,
  type InterferenceSource,
  type LinkBudget,
  linkStats,
  type Obstacle,
  pickRate,
  type Position,
  WIFI_RATES,
} from "../engine/mod.ts";
import type { Session } from "../mcp/session.ts";

/** How a link is drawn. `idle` is a loss bucket only: no frame in the window. */
export type Quality = "good" | "fair" | "poor" | "bad" | "idle";

/** The packet error rate on the map is over this much recent engine time, so a move shows within seconds. */
export const LOSS_WINDOW_MS = 2000;

const FASTEST = WIFI_RATES[WIFI_RATES.length - 1]!;
const SLOWEST = WIFI_RATES[0]!;
const MIDDLE = WIFI_RATES.find((rate) => rate.mbps === 24)!;

/**
 * good: the link carries the fastest rate (54 Mbit/s). fair: 24 Mbit/s or
 * more. poor: only the slow rates decode. bad: below the slowest rate's
 * threshold, where the loss climbs from a few percent to every frame within
 * about 4 dB.
 */
export function signalQuality(snrDb: number): Exclude<Quality, "idle"> {
  if (snrDb >= FASTEST.minSnrDb) return "good";
  if (snrDb >= MIDDLE.minSnrDb) return "fair";
  if (snrDb >= SLOWEST.minSnrDb) return "poor";
  return "bad";
}

/**
 * A chip-level link (LoRa, nRF24, BLE) by the share of reference-length frames
 * its SNR alone would lose, on the same buckets as the measured loss: good
 * under 1%, fair under 10% (10% is the PHY's demodulation floor), poor under
 * 50%, bad from 50%.
 */
export function chipSignalQuality(snrDb: number, signal: ChipSignal): Exclude<Quality, "idle"> {
  const per = chipPacketErrorRate(
    snrDb,
    signal.requiredSnrDb,
    signal.referenceBytes,
    signal.referenceBytes,
  );
  return lossQuality(per * 100) as Exclude<Quality, "idle">;
}

/** good under 1% lost, fair under 10%, poor under 50%, bad from 50%; idle with no frame. */
export function lossQuality(lossPct: number | null): Quality {
  if (lossPct === null) return "idle";
  if (lossPct < 1) return "good";
  if (lossPct < 10) return "fair";
  if (lossPct < 50) return "poor";
  return "bad";
}

export interface DirectedBudget {
  from: string;
  to: string;
  /** On the chip-level air, with the signal it was read against. */
  budget: LinkBudget & { signal?: ChipSignal };
}

export interface SceneLink {
  from: string;
  to: string;
  distance_m: number;
  rssi_dbm: number;
  snr_db: number;
  /** Wi-Fi: the rate the channel model picks at this SNR. LoRa, nRF24, BLE: the radio's bit rate. */
  rate_bps: number;
  /** The SNR a chip-level PHY needs (10% loss at its reference length); null on Wi-Fi, which picks a rate instead. */
  required_snr_db: number | null;
  signal: Exclude<Quality, "idle">;
  /** Frames with an outcome on this link in the last LOSS_WINDOW_MS. */
  window_frames: number;
  /** Null when the window holds no frame. */
  window_loss_pct: number | null;
  loss: Quality;
  /** The forced loss and latency now in force on this link, if any. */
  override: {
    extra_loss_pct: number;
    extra_latency_ms: number;
    extra_jitter_ms: number;
    interference_db: number;
  } | null;
}

/** Every directed link as the map draws it now. `events` must be timed from time zero. */
export function sceneLinks(
  budgets: readonly DirectedBudget[],
  events: readonly EngineEvent[],
  nowMs: number,
): SceneLink[] {
  const recent = new Map(
    linkStats(events, { fromMs: nowMs - LOSS_WINDOW_MS }).map((s) => [`${s.from}>${s.to}`, s]),
  );
  const overrides = new Map<string, SceneLink["override"]>();
  for (const event of events) {
    if (event.type !== "link-override") continue;
    const cleared = event.extraLossPct === 0 && event.extraLatencyMs === 0 &&
      !event.extraJitterMs && !event.interferenceDb;
    overrides.set(
      `${event.from}>${event.to}`,
      cleared ? null : {
        extra_loss_pct: event.extraLossPct,
        extra_latency_ms: event.extraLatencyMs,
        extra_jitter_ms: event.extraJitterMs ?? 0,
        interference_db: event.interferenceDb ?? 0,
      },
    );
  }
  return budgets.map(({ from, to, budget }) => {
    const stats = recent.get(`${from}>${to}`);
    const lossPct = stats && stats.sent > 0 ? stats.lossPct : null;
    return {
      from,
      to,
      distance_m: round(budget.distanceM),
      rssi_dbm: round(budget.rssiDbm),
      snr_db: round(budget.snrDb),
      rate_bps: budget.signal ? round(budget.signal.rateBps) : pickRate(budget.snrDb).mbps * 1e6,
      required_snr_db: budget.signal ? round(budget.signal.requiredSnrDb) : null,
      signal: budget.signal
        ? chipSignalQuality(budget.snrDb, budget.signal)
        : signalQuality(budget.snrDb),
      window_frames: stats?.sent ?? 0,
      window_loss_pct: lossPct === null ? null : round(lossPct),
      loss: lossQuality(lossPct),
      override: overrides.get(`${from}>${to}`) ?? null,
    };
  });
}

/**
 * One mark on the packet timeline. Serial lines, raw transmissions, ESP-NOW
 * round trips, BLE link changes, channel and radio changes and warnings are
 * left out.
 */
export type TimelineEntry =
  | {
    seq: number;
    t_ms: number;
    type: "deliver";
    from: string;
    to: string;
    kind: string;
    bytes: number;
    delay_ms: number;
    attempts: number;
  }
  | {
    seq: number;
    t_ms: number;
    type: "drop";
    from: string;
    to: string;
    kind: string;
    bytes: number;
    reason: string;
    attempts: number;
  }
  | { seq: number; t_ms: number; type: "move"; node: string; position: Position }
  | { seq: number; t_ms: number; type: "phase"; label: string }
  | {
    seq: number;
    t_ms: number;
    type: "link-override";
    from: string;
    to: string;
    extra_loss_pct: number;
    extra_latency_ms: number;
    extra_jitter_ms: number;
    interference_db: number;
  };

/** At most this many entries per answer; a client that fell further behind gets the newest. */
export const TIMELINE_CAP = 4000;

/**
 * Timeline entries with a sequence number above `since` (-1 for all), the
 * newest `cap` of them, and the sequence number to pass back next time.
 */
export function timelineSince(
  events: readonly EngineEvent[],
  since: number,
  cap = TIMELINE_CAP,
): { entries: TimelineEntry[]; next_since: number; truncated: boolean } {
  const entries: TimelineEntry[] = [];
  let next = since;
  for (const event of events) {
    if (event.seq <= since) continue;
    next = Math.max(next, event.seq);
    const entry = toEntry(event);
    if (entry) entries.push(entry);
  }
  // Not slice(-cap): with a cap of 0 that is slice(0), every entry.
  const shown = entries.length > cap ? entries.slice(entries.length - cap) : entries;
  return { entries: shown, next_since: next, truncated: shown.length < entries.length };
}

function toEntry(event: EngineEvent): TimelineEntry | null {
  const base = { seq: event.seq, t_ms: round(event.t) };
  switch (event.type) {
    case "deliver":
      return {
        ...base,
        type: "deliver",
        from: event.from,
        to: event.to,
        kind: event.kind,
        bytes: event.bytes,
        delay_ms: round(event.delayMs),
        attempts: event.attempts,
      };
    case "drop":
      return {
        ...base,
        type: "drop",
        from: event.from,
        to: event.to,
        kind: event.kind,
        bytes: event.bytes,
        reason: event.reason,
        attempts: event.attempts,
      };
    case "move":
      return { ...base, type: "move", node: event.node, position: event.position };
    case "phase":
      return { ...base, type: "phase", label: event.label };
    case "link-override":
      return {
        ...base,
        type: "link-override",
        from: event.from,
        to: event.to,
        extra_loss_pct: event.extraLossPct,
        extra_latency_ms: event.extraLatencyMs,
        extra_jitter_ms: event.extraJitterMs ?? 0,
        interference_db: event.interferenceDb ?? 0,
      };
    case "tx":
    case "service":
    case "serial":
    case "espnow-send":
    case "ble-link":
    case "channel":
    case "interference":
    case "radio":
    case "warning":
      return null;
  }
}

/**
 * What the map draws now: the run's status, its links with their live budgets
 * and recent loss, its walls, and the timeline entries after `since` (-1 for
 * all). `scene` and `timeline` are null before the first run.
 */
export function viewState(session: Session, since: number) {
  const status = session.status();
  const run = session.run;
  if (!run) return { status, scene: null, timeline: null };
  const events = session.events(run);
  const now = session.elapsedMs(run);
  // The live model, so a door that opened shows as open and a source shows whether it is on.
  const environment = run.live?.environment() ?? run.loaded.scenario.environment;
  return {
    status,
    scene: {
      phy: run.loaded.scenario.phy,
      obstacles: sceneObstacles(environment.obstacles),
      interference: sceneInterference(environment.interference),
      window_ms: LOSS_WINDOW_MS,
      links: now === null ? [] : sceneLinks(session.linkBudgets(run), events, now),
    },
    timeline: timelineSince(events, since),
  };
}

/** Walls as segments in metres, for the map. */
export function sceneObstacles(obstacles: readonly Obstacle[]) {
  return obstacles.map((o) => ({
    ...(o.id !== undefined ? { id: o.id } : {}),
    from: o.from,
    to: o.to,
    attenuation_db: o.attenuationDb,
  }));
}

/** Noise sources as points in metres, with whether each is on now. */
export function sceneInterference(sources: readonly InterferenceSource[]) {
  return sources.map((s) => ({
    id: s.id,
    position: [s.position.x, s.position.y],
    power_dbm: s.powerDbm,
    band: s.band,
    active: s.active,
  }));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
