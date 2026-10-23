// Assertions are judged after the run, from the event log and the metrics, so a
// verdict can be reproduced from the files the run wrote.

import { type EngineEvent, type LinkStats, linkStats, type PhaseStats } from "../engine/mod.ts";
import { type Assertion, matchesPattern, type MetricCheck, type MetricField } from "./scenario.ts";

export interface AssertionResult {
  description: string;
  passed: boolean;
  detail: string;
}

function metricValue(stats: LinkStats, field: MetricField): number | null {
  switch (field) {
    case "sent":
      return stats.sent;
    case "delivered":
      return stats.delivered;
    case "loss_pct":
      return stats.lossPct;
    case "latency_p50_ms":
      return stats.latencyMs?.p50 ?? null;
    case "latency_p95_ms":
      return stats.latencyMs?.p95 ?? null;
    case "latency_p99_ms":
      return stats.latencyMs?.p99 ?? null;
    case "latency_mean_ms":
      return stats.latencyMs?.mean ?? null;
    case "rssi_dbm":
      return stats.rssiDbm;
    case "snr_db":
      return stats.snrDb;
    case "mean_attempts":
      return stats.meanAttempts;
    case "acked_pct":
      return stats.espnow?.ackedPct ?? null;
    case "ack_rtt_p95_ms":
      return stats.espnow?.roundTripMs?.p95 ?? null;
    default:
      return assertNever(field);
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled metric field ${String(value)}`);
}

function compare(actual: number, check: MetricCheck): boolean {
  switch (check.op) {
    case "lt":
      return actual < check.value;
    case "lte":
      return actual <= check.value;
    case "gt":
      return actual > check.value;
    case "gte":
      return actual >= check.value;
    case "eq":
      return actual === check.value;
    default:
      return assertNever(check.op);
  }
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(3));

function describe(assertion: Assertion): string {
  if (assertion.kind === "serial") {
    const within = assertion.withinMs === null ? "" : ` within ${assertion.withinMs} ms`;
    return `serial ${assertion.node} contains ${JSON.stringify(assertion.contains)}${within}`;
  }
  const where = [
    assertion.phase ? `phase ${assertion.phase}` : null,
    assertion.frameKind ? `${assertion.frameKind} frames` : null,
  ].filter(Boolean).join(", ");
  const checks = assertion.checks.map((c) => `${c.field} ${c.op} ${fmt(c.value)}`).join(", ");
  return `metric ${assertion.link}${where ? ` (${where})` : ""}: ${checks}`;
}

export function evaluateAssertions(
  assertions: readonly Assertion[],
  events: readonly EngineEvent[],
  phases: readonly PhaseStats[],
): AssertionResult[] {
  return assertions.map((assertion): AssertionResult => {
    const description = describe(assertion);
    if (assertion.kind === "serial") {
      const hit = events.find((e) =>
        e.type === "serial" && e.node === assertion.node && e.text.includes(assertion.contains) &&
        (assertion.withinMs === null || e.t <= assertion.withinMs)
      );
      return hit
        ? { description, passed: true, detail: `seen at ${fmt(hit.t)} ms` }
        : { description, passed: false, detail: "never seen" };
    }

    // Events logged before time zero (boards still starting) are not measured.
    let window: { fromMs?: number; toMs?: number } = { fromMs: 0 };
    if (assertion.phase !== null) {
      const index = phases.findIndex((p) => p.label === assertion.phase);
      const phase = phases[index];
      if (!phase) {
        return { description, passed: false, detail: `no phase named ${assertion.phase}` };
      }
      window = { fromMs: phase.fromMs, ...(index < phases.length - 1 ? { toMs: phase.toMs } : {}) };
    }
    const [fromPattern, toPattern] = assertion.link.split("->") as [string, string];
    const links = linkStats(events, {
      ...window,
      ...(assertion.frameKind ? { kind: assertion.frameKind } : {}),
    })
      .filter((l) => matchesPattern(fromPattern, l.from) && matchesPattern(toPattern, l.to));
    if (links.length === 0) {
      return { description, passed: false, detail: "no frames crossed a matching link" };
    }
    const failures: string[] = [];
    for (const link of links) {
      for (const check of assertion.checks) {
        const actual = metricValue(link, check.field);
        if (actual === null) {
          const why = check.field.startsWith("ack")
            ? "no unicast ESP-NOW frame was acknowledged or resolved"
            : "nothing was delivered";
          failures.push(`${link.from}->${link.to} ${check.field}: ${why}`);
        } else if (!compare(actual, check)) {
          failures.push(`${link.from}->${link.to} ${check.field} = ${fmt(actual)}`);
        }
      }
    }
    return failures.length === 0
      ? { description, passed: true, detail: `${links.length} link(s) satisfy it` }
      : { description, passed: false, detail: failures.join("; ") };
  });
}
