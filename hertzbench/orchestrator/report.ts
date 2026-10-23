// The two ways a result leaves the program: metrics.json for machines and CI,
// and a plain-text report for the person at the terminal. Both are built from
// the same RunResult.

import type { LinkStats } from "../engine/mod.ts";
import { PRODUCT } from "../brand.ts";
import type { Phy } from "./radios.ts";
import type { RunResult } from "./runner.ts";

/** The protocol path of a run, per PHY (PLAN.md D10: say how faithful the result is). */
const ADAPTER_FIDELITY: Record<
  Phy,
  { component: string; protocol: string; level: string; meaning: string }
> = {
  wifi: {
    component: "qemu-wifi-l2 adapter",
    protocol: "wi-fi/ip",
    level: "F2",
    meaning: "same firmware binary, frames captured at the netdev (layer 2 and up)",
  },
  lora: {
    component: "lora-sx127x model over spi-link",
    protocol: "lora",
    level: "F1",
    meaning: "same firmware binary, the SX127x modelled at its SPI register interface",
  },
  nrf24: {
    component: "nrf24 model over spi-link",
    protocol: "nrf24",
    level: "F1",
    meaning: "same firmware binary, the nRF24L01+ modelled at its SPI command interface",
  },
};

const ESPNOW_FIDELITY: (typeof ADAPTER_FIDELITY)[Phy] = {
  component: "qemu-wifi-l2 adapter",
  protocol: "esp-now",
  level: "F1",
  meaning:
    "same firmware binary, 802.11 action frames bridged by the QEMU fork's MAC model as pseudo-Ethernet",
};

/** The protocol rows that apply to this run: ESP-NOW only when ESP-NOW crossed the medium. */
function protocolFidelity(result: RunResult) {
  const espnow = result.events.some((e) => e.type === "tx" && e.kind === "espnow");
  const phy = ADAPTER_FIDELITY[result.scenario.phy];
  return espnow ? [phy, ESPNOW_FIDELITY] : [phy];
}

export function linkJson(link: LinkStats) {
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
    espnow: link.espnow && {
      sends: link.espnow.sends,
      acked: link.espnow.acked,
      outcomes: link.espnow.outcomes,
      acked_pct: link.espnow.ackedPct,
      round_trip_ms: link.espnow.roundTripMs,
    },
  };
}

/**
 * The contents of metrics.json. `schema` changes if a field is renamed or
 * removed or changes type. 2: `phy` and per-node `radio` added, node `channel`
 * may be null (LoRa has no channel number).
 */
export function metricsDocument(result: RunResult) {
  const { scenario, metrics } = result;
  return {
    schema: 2,
    tool: PRODUCT.slug,
    scenario: scenario.name,
    phy: scenario.phy,
    seed: scenario.seed,
    duration_ms: scenario.durationMs,
    // Latency is the delay the channel model assigned. It is not measured on a guest clock.
    latency: "modelled",
    fidelity: [
      ...protocolFidelity(result),
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
      radio: n.radio,
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

const ESPNOW_HEADER = [
  "link",
  "sends",
  "acked",
  "acked %",
  "frame_lost",
  "ack_timeout",
  "no_ack",
  "rtt p50 ms",
  "rtt max ms",
];

function espnowRows(links: readonly LinkStats[]): string[][] {
  return links.flatMap((l) => {
    const e = l.espnow;
    if (!e) return [];
    return [[
      `${l.from}->${l.to}`,
      String(e.sends),
      String(e.acked),
      `${e.ackedPct.toFixed(1)}%`,
      String(e.outcomes.frame_lost ?? 0),
      String(e.outcomes.ack_timeout ?? 0),
      String(e.outcomes.no_ack ?? 0),
      e.roundTripMs ? ms(e.roundTripMs.p50) : "-",
      e.roundTripMs ? ms(e.roundTripMs.max) : "-",
    ]];
  });
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
  for (const row of protocolFidelity(result)) {
    out.push(`  ${row.protocol}: ${row.level}, ${row.meaning}`);
  }
  for (const line of new Set(result.nodes.map((n) => `${n.board}: ${n.fidelity}`))) {
    out.push(`  ${line}`);
  }
  out.push(
    scenario.phy === "wifi"
      ? "  latency below is MODELLED by the channel model, not measured on a guest clock"
      : "  latency below is MODELLED: time on air from the chip's registers plus propagation",
  );
  out.push("");
  out.push("Nodes");
  out.push(
    ...table(
      ["node", "board", "ip", "radio", "position", "clock"],
      result.nodes.map((n) => [
        n.id,
        n.board,
        scenario.phy === "wifi" ? n.ip : "-",
        n.radio,
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
  const espnowTotal = espnowRows(metrics.total);
  if (espnowTotal.length) {
    out.push("");
    out.push(
      "ESP-NOW unicast sends, as the sending firmware sees them (the fork waits 10 ms for each ACK)",
    );
    out.push(...table(ESPNOW_HEADER, espnowTotal).map((l) => `  ${l}`));
  }
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
      const espnowPhase = espnowRows(phase.links);
      if (espnowPhase.length) {
        out.push(...["", ...table(ESPNOW_HEADER, espnowPhase)].map((l) => l && `  ${l}`));
      }
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
