// The event log: one append-only record of everything the engine decided.
// Metrics, the report and the assertions are all computed from it, so what the
// run says and what the log says cannot disagree.

import type { Position } from "./channel.ts";

export type DropReason =
  | "retry_exhausted" // every MAC attempt failed on the channel
  | "extra_loss" // the scenario's per-link loss override
  | "channel_mismatch" // sender and receiver radios are on different channels
  | "no_peer"; // the receiving board had not connected to its adapter port

export type FrameKind =
  | "arp"
  | "dhcp"
  | "udp"
  | "tcp"
  | "icmp"
  | "ipv4"
  | "espnow-pseudo-ethernet"
  | "other";

interface Stamped {
  /** Engine time in milliseconds since the run started. */
  t: number;
  /** Position in the log; unique, increasing. */
  seq: number;
}

export type EngineEvent =
  | (Stamped & {
    type: "tx";
    node: string;
    bytes: number;
    kind: FrameKind;
    dst: string;
    src: string;
  })
  | (Stamped & {
    type: "deliver";
    from: string;
    to: string;
    bytes: number;
    kind: FrameKind;
    delayMs: number;
    attempts: number;
    rateMbps: number;
    rssiDbm: number;
    snrDb: number;
  })
  | (Stamped & {
    type: "drop";
    from: string;
    to: string;
    bytes: number;
    kind: FrameKind;
    reason: DropReason;
    attempts: number;
    rssiDbm: number;
    snrDb: number;
  })
  | (Stamped & { type: "service"; service: "dhcp" | "arp"; detail: string })
  | (Stamped & { type: "move"; node: string; position: Position })
  | (Stamped & {
    type: "link-override";
    from: string;
    to: string;
    extraLossPct: number;
    extraLatencyMs: number;
  })
  | (Stamped & { type: "phase"; label: string })
  | (Stamped & { type: "serial"; node: string; text: string });

/** Event without the fields the log fills in. Distributes over the union so each variant keeps its own shape. */
export type NewEvent = EngineEvent extends infer E ? E extends EngineEvent ? Omit<E, "seq">
  : never
  : never;

export class EventLog {
  readonly #events: EngineEvent[] = [];

  append(event: NewEvent): void {
    this.#events.push({ ...event, seq: this.#events.length } as EngineEvent);
  }

  get events(): readonly EngineEvent[] {
    return this.#events;
  }

  /** One JSON object per line. */
  toJsonl(): string {
    return this.#events.map((e) => JSON.stringify(e)).join("\n") +
      (this.#events.length ? "\n" : "");
  }
}
