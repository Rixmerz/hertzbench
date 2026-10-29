// The event log: one append-only record of everything the engine decided.
// Metrics, the report and the assertions are all computed from it, so what the
// run says and what the log says cannot disagree.

import type { Environment, Position, RadioConfig } from "./channel.ts";

export type DropReason =
  | "retry_exhausted" // every MAC attempt failed on the channel
  | "extra_loss" // the scenario's per-link loss override
  | "channel_mismatch" // sender and receiver radios are on different channels
  | "no_peer" // the receiving board had not connected to its adapter port
  | "collision" // another frame on the same channel overlapped it and was not 6 dB weaker
  | "noise" // the chip-level PHY lost it to the error rate at its SNR
  | "phy_mismatch" // the receiver listened on the channel with other modem settings
  | "not_listening" // the receiver left its receive state before the frame ended
  | "ack_timeout" // an ESP-NOW ACK that would reach its sender after the fork's 10 ms wait
  | "ack_unmatched" // an ESP-NOW ACK for no frame its receiver holds that still waits for one
  | "link_lost"; // BLE ACL data still queued when its connection ended

/**
 * How a unicast ESP-NOW frame ended, as the sending fork sees it: its ACK came
 * back in time, the frame never reached the receiver, the ACK came too late,
 * or the receiver never answered (its fork filtered the frame).
 */
export type EspNowOutcome = "acked" | "frame_lost" | "ack_timeout" | "no_ack";

export type FrameKind =
  | "arp"
  | "dhcp"
  | "udp"
  | "tcp"
  | "icmp"
  | "ipv4"
  | "espnow" // an ESP-NOW action frame, in the QEMU fork's pseudo-Ethernet
  | "espnow-ack" // the fork's ACK for a unicast one
  | "lora"
  | "nrf24"
  | "nrf24-ack"
  | "ble-adv" // a BLE advertising-channel packet: ADV_IND, SCAN_REQ, SCAN_RSP, CONNECT_IND
  | "ble-data" // a BLE data-channel packet: data, empty or control PDU of a connection
  | "ble-acl" // one HCI ACL packet carried host to host; its delay includes waiting and retries
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
    /** Chip-level PHYs: time on air and the modem settings the chip used, read from its registers. */
    airtimeMs?: number;
    radio?: Record<string, string | number | boolean>;
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
    extraJitterMs?: number;
    interferenceDb?: number;
  })
  | (Stamped & {
    type: "espnow-send";
    from: string;
    to: string;
    outcome: EspNowOutcome;
    /** From the frame going on the air to its ACK reaching the sender; null when no ACK came. */
    roundTripMs: number | null;
  })
  | (Stamped & {
    type: "ble-link";
    /** The node whose controller saw the change; each side of a connection logs its own. */
    node: string;
    peer: string;
    role: "central" | "peripheral";
    state: "up" | "down";
    /** HCI error code of the disconnection (0x08 supervision timeout, 0x13 remote user, ...); null when up. */
    reason: number | null;
    intervalMs: number;
  })
  /** Channel-model parameters changed while the run plays. */
  | (Stamped & { type: "channel"; changes: ChannelChanges })
  /** An interference source switched on or off, by the scenario's schedule or its timeline. */
  | (Stamped & { type: "interference"; id: string; active: boolean })
  /** A station's radio, as the medium models it, changed while the run plays. */
  | (Stamped & { type: "radio"; node: string; changes: Partial<RadioConfig> })
  | (Stamped & { type: "warning"; text: string })
  | (Stamped & { type: "phase"; label: string })
  | (Stamped & { type: "serial"; node: string; text: string });

/** The channel-model parameters a run can change while it plays. */
export type ChannelChanges = Partial<
  Pick<
    Environment,
    "pathLossExponent" | "shadowingSigmaDb" | "noiseFigureDb" | "baseLatencyMs" | "obstacles"
  >
>;

// A record, not a list, so adding an event type without naming it here fails the type check.
const EVENT_TYPE_SET: Record<EngineEvent["type"], true> = {
  tx: true,
  deliver: true,
  drop: true,
  service: true,
  move: true,
  "link-override": true,
  "espnow-send": true,
  "ble-link": true,
  channel: true,
  interference: true,
  radio: true,
  warning: true,
  phase: true,
  serial: true,
};

/** Every event type, for callers that filter the log by name. */
export const EVENT_TYPES = Object.keys(EVENT_TYPE_SET) as EngineEvent["type"][];

/** Event without the fields the log fills in. Distributes over the union so each variant keeps its own shape. */
export type NewEvent = EngineEvent extends infer E ? E extends EngineEvent ? Omit<E, "seq">
  : never
  : never;

export class EventLog {
  readonly #events: EngineEvent[] = [];
  #lastT = -Infinity;
  #listener: ((event: EngineEvent) => void) | null = null;

  /**
   * Times never step backwards: with a paced clock an event logged from a
   * timer carries its due time, which can be earlier than an I/O event logged
   * just before it; such an event is stamped with the later time.
   */
  append(event: NewEvent): void {
    const t = Math.max(event.t, this.#lastT);
    this.#lastT = t;
    const stamped = { ...event, t, seq: this.#events.length } as EngineEvent;
    this.#events.push(stamped);
    this.#listener?.(stamped);
  }

  /** Calls `listener` with each event appended from now on, as the log holds it. One listener at a time. */
  listen(listener: (event: EngineEvent) => void): void {
    this.#listener = listener;
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
