// What the map and the packet timeline show, computed here on the server from
// the run's event log and link budgets, so the browser only draws. Quality
// buckets come from the channel model's own rate table, not from numbers made
// up for the picture.

import {
  type EngineEvent,
  type LinkBudget,
  linkStats,
  type Obstacle,
  pickRate,
  type Position,
  WIFI_RATES,
} from "../engine/mod.ts";

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
  budget: LinkBudget;
}

export interface SceneLink {
  from: string;
  to: string;
  distance_m: number;
  rssi_dbm: number;
  snr_db: number;
  /** The rate the channel model picks at this SNR. */
  rate_mbps: number;
  signal: Exclude<Quality, "idle">;
  /** Frames with an outcome on this link in the last LOSS_WINDOW_MS. */
  window_frames: number;
  /** Null when the window holds no frame. */
  window_loss_pct: number | null;
  loss: Quality;
  /** The forced loss and latency now in force on this link, if any. */
  override: { extra_loss_pct: number; extra_latency_ms: number } | null;
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
    const cleared = event.extraLossPct === 0 && event.extraLatencyMs === 0;
    overrides.set(
      `${event.from}>${event.to}`,
      cleared
        ? null
        : { extra_loss_pct: event.extraLossPct, extra_latency_ms: event.extraLatencyMs },
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
      rate_mbps: pickRate(budget.snrDb).mbps,
      signal: signalQuality(budget.snrDb),
      window_frames: stats?.sent ?? 0,
      window_loss_pct: lossPct === null ? null : round(lossPct),
      loss: lossQuality(lossPct),
      override: overrides.get(`${from}>${to}`) ?? null,
    };
  });
}

/** One mark on the packet timeline. Serial lines and raw transmissions are left out. */
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
  const shown = entries.length > cap ? entries.slice(-cap) : entries;
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
      };
    case "tx":
    case "service":
    case "serial":
      return null;
  }
}

/** Walls as segments in metres, for the map. */
export function sceneObstacles(obstacles: readonly Obstacle[]) {
  return obstacles.map((o) => ({ from: o.from, to: o.to, attenuation_db: o.attenuationDb }));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
