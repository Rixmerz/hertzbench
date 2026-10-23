// The air for chip-level radios (LoRa, nRF24): frames, not Ethernet. A radio
// model puts a frame on the air with its own modem settings and time on air;
// every other node's model says whether it is listening for it; the medium
// computes each receiver's budget, tracks what overlaps at that receiver, and
// when the frame ends decides delivery: collision, then error rate, then the
// scenario's chaos override, then whether the receiver is still listening.
//
// PLAN.md §8: collisions on the same channel lose both frames unless one is
// at least the PHY's capture threshold stronger. Half-duplex is the models'
// job: a radio that is transmitting is not in a receive state.

import { type Environment, linkBudgetAt, type Position } from "./channel.ts";
import { chipPacketErrorRate } from "./channel.ts";
import type { Clock } from "./clock.ts";
import type { DropReason, EventLog, FrameKind } from "./events.ts";
import type { LinkOverride, MediumControl } from "./medium.ts";
import { substream } from "./rng.ts";
import { SPEED_OF_LIGHT_M_S } from "./channel.ts";

export interface AirFrame<H = unknown> {
  kind: FrameKind;
  /** What the receiving chip puts in its FIFO. Its length drives the error-rate draw. */
  payload: Uint8Array;
  airtimeMs: number;
  frequencyHz: number;
  /** Receiver bandwidth for the noise floor. */
  bandwidthHz: number;
  noiseFigureDb: number;
  /** SNR at which a frame of `referenceBytes` is lost 10% of the time. */
  requiredSnrDb: number;
  referenceBytes: number;
  /** A frame survives an overlap only when this much stronger than the other one. */
  captureDb: number;
  txPowerDbm: number;
  /** Frames interfere only when their keys are equal (LoRa: channel and SF; nRF24: RF channel). */
  interferenceKey: string;
  /** Raw bit rate, for the deliver event. */
  rateBps: number;
  /** Addresses for the log; "" where the PHY has none. */
  dst: string;
  src: string;
  /** Effective modem settings, logged on the tx event. */
  params: Record<string, string | number | boolean>;
  /** PHY header fields the receiving model needs. Opaque to the medium. */
  header: H;
}

/**
 * `listen`: in a receive state and able to decode this frame (it becomes a
 * reception); `mismatch`: listening on the channel with settings that cannot
 * decode it, logged as a drop; `deaf`: not a receiver of it at all (another
 * channel, another address, transmitting, asleep), not logged.
 */
export type Hearing = "listen" | "mismatch" | "deaf";

export interface ReceptionQuality {
  rssiDbm: number;
  snrDb: number;
}

export interface AirReceiver {
  /** Asked when the frame's preamble reaches the radio. */
  hear(frame: AirFrame, from: string): Hearing;
  /** The frame ended and decoded. False when the radio had left its receive state. */
  receive(frame: AirFrame, from: string, quality: ReceptionQuality): boolean;
}

export interface AirNode {
  id: string;
  position: Position;
  antennaGainDbi: number;
}

export type AirTap = (tMs: number, node: string, frame: AirFrame) => void;

export interface AirMediumOptions {
  seed: number;
  environment: Environment;
  clock: Clock;
  log: EventLog;
  tap?: AirTap;
}

interface Signal {
  frame: AirFrame;
  from: string;
  rssiDbm: number;
  endMs: number;
  /** Set when an overlapping signal on the same key was not `captureDb` weaker. */
  collided: boolean;
  wanted: boolean;
}

interface NodeState extends AirNode {
  receiver: AirReceiver;
  /** Signals currently arriving at this node. */
  arriving: Signal[];
}

export class AirMedium implements MediumControl {
  readonly #opts: AirMediumOptions;
  readonly #nodes = new Map<string, NodeState>();
  readonly #overrides = new Map<string, LinkOverride>();
  readonly #ordinals = new Map<string, number>();
  readonly #shadowing = new Map<string, number>();
  readonly #cancels = new Set<() => void>();

  constructor(opts: AirMediumOptions) {
    this.#opts = opts;
  }

  addNode(node: AirNode, receiver: AirReceiver): void {
    if (this.#nodes.has(node.id)) throw new Error(`duplicate node id ${JSON.stringify(node.id)}`);
    this.#nodes.set(node.id, { ...node, receiver, arriving: [] });
  }

  get nodeIds(): string[] {
    return [...this.#nodes.keys()];
  }

  node(id: string): Readonly<AirNode> {
    return this.#requireNode(id);
  }

  moveNode(id: string, position: Position): void {
    this.#requireNode(id).position = position;
    this.#opts.log.append({ type: "move", t: this.#opts.clock.now(), node: id, position });
  }

  setLinkOverride(from: string, to: string, override: LinkOverride): void {
    this.#requireNode(from);
    this.#requireNode(to);
    this.#overrides.set(`${from}>${to}`, override);
    this.#opts.log.append({
      type: "link-override",
      t: this.#opts.clock.now(),
      from,
      to,
      ...override,
    });
  }

  startPhase(label: string): void {
    this.#opts.log.append({ type: "phase", t: this.#opts.clock.now(), label });
  }

  close(): void {
    for (const cancel of this.#cancels) cancel();
    this.#cancels.clear();
  }

  /** A radio model started sending `frame`. Its own TxDone is the model's business. */
  transmit(from: string, frame: AirFrame): void {
    const sender = this.#requireNode(from);
    const { clock, log, environment } = this.#opts;
    const now = clock.now();
    log.append({
      type: "tx",
      t: now,
      node: from,
      bytes: frame.payload.length,
      kind: frame.kind,
      dst: frame.dst,
      src: frame.src,
      airtimeMs: frame.airtimeMs,
      radio: frame.params,
    });
    this.#opts.tap?.(now, from, frame);

    for (const receiver of this.#nodes.values()) {
      if (receiver.id === from) continue;
      const budget = linkBudgetAt(
        environment,
        {
          position: sender.position,
          txPowerDbm: frame.txPowerDbm,
          antennaGainDbi: sender.antennaGainDbi,
        },
        receiver,
        frame,
        this.#shadowingDb(from, receiver.id),
      );
      receiver.arriving = receiver.arriving.filter((s) => s.endMs > now);
      const hearing = receiver.receiver.hear(frame, from);
      const signal: Signal = {
        frame,
        from,
        rssiDbm: budget.rssiDbm,
        endMs: now + frame.airtimeMs,
        collided: false,
        wanted: hearing === "listen",
      };
      for (const other of receiver.arriving) {
        if (other.frame.interferenceKey !== frame.interferenceKey) continue;
        if (other.wanted && signal.rssiDbm > other.rssiDbm - other.frame.captureDb) {
          other.collided = true;
        }
        if (other.rssiDbm > signal.rssiDbm - frame.captureDb) signal.collided = true;
      }
      receiver.arriving.push(signal);

      const base = { from, to: receiver.id, bytes: frame.payload.length, kind: frame.kind };
      const drop = (reason: DropReason) =>
        log.append({
          type: "drop",
          t: clock.now(),
          ...base,
          reason,
          attempts: 1,
          rssiDbm: budget.rssiDbm,
          snrDb: budget.snrDb,
        });
      if (hearing === "deaf") continue;
      if (hearing === "mismatch") {
        drop("phy_mismatch");
        continue;
      }

      const linkKey = `${from}>${receiver.id}`;
      const ordinal = this.#ordinals.get(linkKey) ?? 0;
      this.#ordinals.set(linkKey, ordinal + 1);
      const override = this.#overrides.get(linkKey);
      // Drawn now, in a fixed order, so the outcome depends only on the link and its count.
      const rng = substream(this.#opts.seed, `${frame.kind}:${linkKey}#${ordinal}`);
      const per = chipPacketErrorRate(
        budget.snrDb,
        frame.requiredSnrDb,
        frame.payload.length,
        frame.referenceBytes,
      );
      const lostToNoise = rng.next() < per;
      const extraLoss = (override?.extraLossPct ?? 0) > 0 &&
        rng.next() * 100 < (override?.extraLossPct ?? 0);
      const delayMs = frame.airtimeMs + (budget.distanceM / SPEED_OF_LIGHT_M_S) * 1000 +
        environment.baseLatencyMs + (override?.extraLatencyMs ?? 0);
      const payload = frame.payload.slice();

      this.#after(delayMs, () => {
        if (signal.collided) return drop("collision");
        if (lostToNoise) return drop("noise");
        if (extraLoss) return drop("extra_loss");
        const quality = { rssiDbm: budget.rssiDbm, snrDb: budget.snrDb };
        if (!receiver.receiver.receive({ ...frame, payload }, from, quality)) {
          return drop("not_listening");
        }
        log.append({
          type: "deliver",
          t: clock.now(),
          ...base,
          delayMs,
          attempts: 1,
          rateMbps: frame.rateBps / 1e6,
          rssiDbm: budget.rssiDbm,
          snrDb: budget.snrDb,
        });
      });
    }
  }

  #after(delayMs: number, fn: () => void): void {
    const cancel = this.#opts.clock.schedule(this.#opts.clock.now() + delayMs, () => {
      this.#cancels.delete(cancel);
      fn();
    });
    this.#cancels.add(cancel);
  }

  /** Shadowing is a property of the pair, drawn once, so moving a node does not reroll it. */
  #shadowingDb(a: string, b: string): number {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    let value = this.#shadowing.get(key);
    if (value === undefined) {
      value = this.#opts.environment.shadowingSigmaDb *
        substream(this.#opts.seed, `shadow:${key}`).gaussian();
      this.#shadowing.set(key, value);
    }
    return value;
  }

  #requireNode(id: string): NodeState {
    const node = this.#nodes.get(id);
    if (!node) throw new Error(`unknown node ${JSON.stringify(id)}`);
    return node;
  }
}
