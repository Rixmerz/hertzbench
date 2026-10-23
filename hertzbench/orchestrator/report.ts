// The two ways a result leaves the program: metrics.json for machines and CI,
// and a plain-text report for the person at the terminal. Both are built from
// the same RunResult.

import type { LinkStats } from "../engine/mod.ts";
import { PRODUCT } from "../brand.ts";
import type { RunResult } from "./runner.ts";

const ADAPTER_FIDELITY = {
  component: "qemu-wifi-l2 adapter",
  protocol: "wi-fi/ip",
  level: "F2",
  meaning: "same firmware binary, frames captured at the netdev (layer 2 and up)",
} as const;

function linkJson(link: LinkStats) {
  return {
    from: link.from,
    to: link.to,
    sent: link.sent,
    delivered: link.delivered,
    dropped: link.dropped,
    loss_pct: link.lossPct,
    latency_ms: link.latencyMs,
    rssi_dbm: link.rssiDbm,
    snr_db: link.snrDb,
    mean_attempts: link.meanAttempts,
    bytes_delivered: link.bytesDelivered,
  };
}

/** The contents of metrics.json. `schema` changes if a field is renamed or removed. */
export function metricsDocument(result: RunResult) {
  const { scenario, metrics } = result;
  return {
    schema: 1,
    tool: PRODUCT.slug,
    scenario: scenario.name,
    seed: scenario.seed,
    duration_ms: scenario.durationMs,
    // Latency is the delay the channel model assigned. It is not measured on a guest clock.
    latency: "modelled",
    fidelity: [
      ADAPTER_FIDELITY,
      ...[...new Set(result.nodes.map((n) => `${n.board}: ${n.fidelity}`))].map((line) => ({
        component: "board",
        description: line,
      })),
    ],
    nodes: result.nodes.map((n) => ({
      id: n.id,
      board: n.board,
      ip: n.ip,
      mac: n.mac,
      position: n.position,
      channel: n.channel,
      on_medium: n.onMedium,
      clock: n.clock,
    })),
    links: metrics.total.map(linkJson),
    phases: metrics.phases.map((p) => ({
      label: p.label,
      from_ms: p.fromMs,
      to_ms: p.toMs,
      links: p.links.map(linkJson),
    })),
    warnings: metrics.warnings,
    problems: result.problems,
    assertions: result.assertions,
    passed: result.passed,
  };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => pad(c, widths[i] ?? 0)).join("  ").trimEnd();
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)];
}

const ms = (n: number) => n.toFixed(2);

function linkRows(links: readonly LinkStats[]): string[][] {
  return links.map((l) => [
    `${l.from}->${l.to}`,
    String(l.sent),
    String(l.delivered),
    `${l.lossPct.toFixed(1)}%`,
    l.latencyMs ? ms(l.latencyMs.p50) : "-",
    l.latencyMs ? ms(l.latencyMs.p95) : "-",
    l.latencyMs ? ms(l.latencyMs.p99) : "-",
    l.rssiDbm.toFixed(1),
    l.snrDb.toFixed(1),
    l.meanAttempts.toFixed(2),
  ]);
}

const LINK_HEADER = [
  "link",
  "sent",
  "delivered",
  "loss",
  "p50 ms",
  "p95 ms",
  "p99 ms",
  "rssi dBm",
  "snr dB",
  "attempts",
];

export function renderReport(result: RunResult): string {
  const { scenario, metrics } = result;
  const out: string[] = [];
  out.push(
    `${PRODUCT.displayName}: ${scenario.name}  (seed ${scenario.seed}, ${scenario.durationMs} ms)`,
  );
  out.push("");
  out.push("Fidelity");
  out.push(
    `  ${ADAPTER_FIDELITY.protocol}: ${ADAPTER_FIDELITY.level}, ${ADAPTER_FIDELITY.meaning}`,
  );
  for (const line of new Set(result.nodes.map((n) => `${n.board}: ${n.fidelity}`))) {
    out.push(`  ${line}`);
  }
  out.push("  latency below is MODELLED by the channel model, not measured on a guest clock");
  out.push("");
  out.push("Nodes");
  out.push(
    ...table(
      ["node", "board", "ip", "channel", "position", "clock"],
      result.nodes.map((n) => [
        n.id,
        n.board,
        n.ip,
        String(n.channel),
        n.onMedium
          ? `(${n.position.x}, ${n.position.y}${
            n.position.z === undefined ? "" : `, ${n.position.z}`
          })`
          : "off the medium (SLIRP)",
        n.clock,
      ]),
    ).map((l) => `  ${l}`),
  );
  out.push("");
  out.push("Links, whole run");
  out.push(
    ...(metrics.total.length
      ? table(LINK_HEADER, linkRows(metrics.total))
      : ["no frames crossed the medium"]).map((l) => `  ${l}`),
  );
  if (metrics.phases.length > 1) {
    for (const phase of metrics.phases) {
      out.push("");
      out.push(
        `Phase "${phase.label}" (${phase.fromMs.toFixed(0)} to ${phase.toMs.toFixed(0)} ms)`,
      );
      out.push(
        ...(phase.links.length ? table(LINK_HEADER, linkRows(phase.links)) : ["no frames"]).map((
          l,
        ) => `  ${l}`),
      );
    }
  }
  if (metrics.warnings.length || result.problems.length) {
    out.push("");
    out.push("Warnings");
    for (const w of metrics.warnings) out.push(`  warning: ${w}`);
    for (const p of result.problems) out.push(`  problem: ${p}`);
  }
  out.push("");
  out.push("Assertions");
  if (result.assertions.length === 0) out.push("  none");
  for (const a of result.assertions) {
    out.push(`  ${a.passed ? "PASS" : "FAIL"}  ${a.description}  (${a.detail})`);
  }
  out.push("");
  out.push(result.passed ? "RESULT: PASS" : "RESULT: FAIL");
  if (result.files.length) {
    out.push("");
    out.push("Files");
    for (const f of result.files) out.push(`  ${f}`);
  }
  return out.join("\n") + "\n";
}
