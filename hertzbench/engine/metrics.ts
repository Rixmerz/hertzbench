// Metrics are a pure function of the event log. Latency here is MODELLED: it is
// the delay the channel model assigned to a frame, not something measured on a
// guest clock (PLAN.md §8; Xtensa QEMU runs on wall-clock time).

import { ESPNOW_ACK_TIMEOUT_MS } from "./espnow.ts";
import type { DropReason, EngineEvent, EspNowOutcome, FrameKind } from "./events.ts";

export interface LatencyStats {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  max: number;
}

/** Unicast ESP-NOW frames on one link, judged the way the sending fork judges them. */
export interface EspNowSendStats {
  sends: number;
  acked: number;
  outcomes: Partial<Record<EspNowOutcome, number>>;
  ackedPct: number;
  /** Over the sends whose ACK came back, in time or late. Null when none did. */
  roundTripMs: LatencyStats | null;
}

export interface LinkStats {
  from: string;
  to: string;
  /** Frames that reached an outcome on this link: delivered plus dropped. */
  sent: number;
  delivered: number;
  dropped: Partial<Record<DropReason, number>>;
  lossPct: number;
  /** Null when nothing was delivered. */
  latencyMs: LatencyStats | null;
  /** Mean over every outcome, delivered or not. */
  rssiDbm: number;
  snrDb: number;
  meanAttempts: number;
  bytesDelivered: number;
  /** Null when no unicast ESP-NOW frame on this link was resolved in the window. */
  espnow: EspNowSendStats | null;
}

export interface PhaseStats {
  label: string;
  fromMs: number;
  toMs: number;
  links: LinkStats[];
}

export interface MetricsReport {
  total: LinkStats[];
  phases: PhaseStats[];
  warnings: string[];
}

export interface StatsFilter {
  fromMs?: number;
  /** Exclusive. */
  toMs?: number;
  kind?: FrameKind;
}

/** Nearest-rank percentile of an ascending-sorted list. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new RangeError("percentile of an empty list");
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number;
}

interface Accumulator {
  from: string;
  to: string;
  delivered: number;
  dropped: Partial<Record<DropReason, number>>;
  latencies: number[];
  rssiSum: number;
  snrSum: number;
  attemptsSum: number;
  bytesDelivered: number;
}

interface EspNowAccumulator {
  outcomes: Partial<Record<EspNowOutcome, number>>;
  roundTrips: number[];
}

function latencyStats(values: readonly number[]): LatencyStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    mean: sorted.reduce((sum, v) => sum + v, 0) / sorted.length,
    max: sorted[sorted.length - 1] as number,
  };
}

function espnowStats(acc: EspNowAccumulator | undefined): EspNowSendStats | null {
  if (!acc) return null;
  const sends = Object.values(acc.outcomes).reduce((sum, n) => sum + n, 0);
  const acked = acc.outcomes.acked ?? 0;
  return {
    sends,
    acked,
    outcomes: acc.outcomes,
    ackedPct: (acked / sends) * 100,
    roundTripMs: latencyStats(acc.roundTrips),
  };
}

export function linkStats(events: readonly EngineEvent[], filter: StatsFilter = {}): LinkStats[] {
  const links = new Map<string, Accumulator>();
  const espnow = new Map<string, EspNowAccumulator>();
  const inWindow = (t: number) =>
    (filter.fromMs === undefined || t >= filter.fromMs) &&
    (filter.toMs === undefined || t < filter.toMs);
  for (const event of events) {
    if (event.type === "espnow-send") {
      if (!inWindow(event.t) || (filter.kind !== undefined && filter.kind !== "espnow")) continue;
      const key = `${event.from}>${event.to}`;
      const acc = espnow.get(key) ?? { outcomes: {}, roundTrips: [] };
      acc.outcomes[event.outcome] = (acc.outcomes[event.outcome] ?? 0) + 1;
      if (event.roundTripMs !== null) acc.roundTrips.push(event.roundTripMs);
      espnow.set(key, acc);
      continue;
    }
    if (event.type !== "deliver" && event.type !== "drop") continue;
    if (!inWindow(event.t)) continue;
    if (filter.kind !== undefined && event.kind !== filter.kind) continue;
    const key = `${event.from}>${event.to}`;
    let acc = links.get(key);
    if (!acc) {
      acc = {
        from: event.from,
        to: event.to,
        delivered: 0,
        dropped: {},
        latencies: [],
        rssiSum: 0,
        snrSum: 0,
        attemptsSum: 0,
        bytesDelivered: 0,
      };
      links.set(key, acc);
    }
    acc.rssiSum += event.rssiDbm;
    acc.snrSum += event.snrDb;
    acc.attemptsSum += event.attempts;
    if (event.type === "deliver") {
      acc.delivered++;
      acc.latencies.push(event.delayMs);
      acc.bytesDelivered += event.bytes;
    } else {
      acc.dropped[event.reason] = (acc.dropped[event.reason] ?? 0) + 1;
    }
  }
  // A send is resolved after its frame crossed the link, so a send resolved in
  // a window whose link carried no frame is not reported for that window.
  return [...links.values()]
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
    .map((acc) => finish(acc, espnowStats(espnow.get(`${acc.from}>${acc.to}`))));
}

function finish(acc: Accumulator, espnow: EspNowSendStats | null): LinkStats {
  const dropped = Object.values(acc.dropped).reduce((sum, n) => sum + n, 0);
  const sent = acc.delivered + dropped;
  const latencyMs = latencyStats(acc.latencies);
  return {
    from: acc.from,
    to: acc.to,
    sent,
    delivered: acc.delivered,
    dropped: acc.dropped,
    lossPct: sent === 0 ? 0 : (dropped / sent) * 100,
    latencyMs,
    rssiDbm: acc.rssiSum / sent,
    snrDb: acc.snrSum / sent,
    meanAttempts: acc.attemptsSum / sent,
    bytesDelivered: acc.bytesDelivered,
    espnow,
  };
}

export function computeMetrics(events: readonly EngineEvent[], endMs: number): MetricsReport {
  const boundaries: { label: string; fromMs: number }[] = [{ label: "start", fromMs: 0 }];
  for (const event of events) {
    if (event.type === "phase") boundaries.push({ label: event.label, fromMs: event.t });
  }
  const phases = boundaries.map((b, i): PhaseStats => {
    const toMs = boundaries[i + 1]?.fromMs ?? Math.max(endMs, b.fromMs);
    const last = i === boundaries.length - 1;
    return {
      label: b.label,
      fromMs: b.fromMs,
      toMs,
      // The last window keeps events stamped exactly at the end of the run.
      links: linkStats(events, { fromMs: b.fromMs, ...(last ? {} : { toMs }) }),
    };
  });

  const warnings = events.flatMap((e) => (e.type === "warning" ? [e.text] : []));
  const total = linkStats(events, { fromMs: 0 });
  for (const link of total) {
    const late = link.espnow?.outcomes.ack_timeout ?? 0;
    if (!link.espnow || late === 0) continue;
    warnings.push(
      `link ${link.from}->${link.to}: ${late} of ${link.espnow.sends} unicast ESP-NOW sends ` +
        `missed the fork's ${ESPNOW_ACK_TIMEOUT_MS} ms ACK wait (slowest round trip ` +
        `${link.espnow.roundTripMs?.max.toFixed(2)} ms), so the sender's firmware saw them fail`,
    );
  }
  return { total, phases, warnings };
}
