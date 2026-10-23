// Metrics are a pure function of the event log. Latency here is MODELLED: it is
// the delay the channel model assigned to a frame, not something measured on a
// guest clock (PLAN.md §8; Xtensa QEMU runs on wall-clock time).

import type { DropReason, EngineEvent, FrameKind } from "./events.ts";

export interface LatencyStats {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  max: number;
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

export function linkStats(events: readonly EngineEvent[], filter: StatsFilter = {}): LinkStats[] {
  const links = new Map<string, Accumulator>();
  for (const event of events) {
    if (event.type !== "deliver" && event.type !== "drop") continue;
    if (filter.fromMs !== undefined && event.t < filter.fromMs) continue;
    if (filter.toMs !== undefined && event.t >= filter.toMs) continue;
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
  return [...links.values()]
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
    .map(finish);
}

function finish(acc: Accumulator): LinkStats {
  const dropped = Object.values(acc.dropped).reduce((sum, n) => sum + n, 0);
  const sent = acc.delivered + dropped;
  const sorted = [...acc.latencies].sort((a, b) => a - b);
  const latencyMs: LatencyStats | null = sorted.length === 0 ? null : {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    mean: sorted.reduce((sum, v) => sum + v, 0) / sorted.length,
    max: sorted[sorted.length - 1] as number,
  };
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
  };
}

/** One-way delay above which the 10 ms Wi-Fi ACK round trip cannot fit (ADR 0001). */
export const ACK_ONE_WAY_BUDGET_MS = 5;

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

  const warnings: string[] = [];
  for (const link of linkStats(events, { fromMs: 0, kind: "espnow-pseudo-ethernet" })) {
    if (link.latencyMs && link.latencyMs.p95 > ACK_ONE_WAY_BUDGET_MS) {
      warnings.push(
        `link ${link.from}->${link.to}: ESP-NOW p95 one-way delay ${
          link.latencyMs.p95.toFixed(2)
        } ms ` +
          `is over ${ACK_ONE_WAY_BUDGET_MS} ms, so the 10 ms ACK round trip of the Wi-Fi MAC will time out`,
      );
    }
  }
  return { total: linkStats(events, { fromMs: 0 }), phases, warnings };
}
