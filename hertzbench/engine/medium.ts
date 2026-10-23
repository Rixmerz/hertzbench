// The shared medium: nodes with positions and radios, a static layer-2 switch
// between their stations, and the channel model applied per link per frame.
//
// The switch never learns addresses. Every QEMU board's embedded access point
// uses the same AP MAC (hw/misc/esp32_wifi_ap.c:517), so source-MAC learning
// would see one MAC on every port. The scenario assigns each board a station
// MAC and the table is built from that.

import {
  type Environment,
  type LinkBudget,
  linkBudget,
  type Position,
  type RadioConfig,
  simulateFrame,
} from "./channel.ts";
import type { Clock } from "./clock.ts";
import type { DropReason, EventLog, FrameKind } from "./events.ts";
import type { VirtualGateway } from "./gateway.ts";
import { classifyFrame, isGroupMac, parseEthernet } from "./packet.ts";
import { substream } from "./rng.ts";

export interface MediumNode {
  id: string;
  /** Station MAC the board's firmware uses on the wire. Unique per node. */
  mac: string;
  position: Position;
  radio: RadioConfig;
}

/** The far side of a node: whatever carries frames to the emulated board. */
export interface FrameSink {
  /** False while the board has not connected yet; frames to it are dropped as `no_peer`. */
  ready(): boolean;
  deliver(frame: Uint8Array, from: string): void;
}

/** Sees every frame put on the air, with the engine time it was sent. Feeds the pcap. */
export type FrameTap = (tMs: number, node: string, frame: Uint8Array) => void;

export interface LinkOverride {
  extraLossPct: number;
  extraLatencyMs: number;
}

/** What the runner and the timeline do to a medium, whichever PHY it carries. */
export interface MediumControl {
  moveNode(id: string, position: Position): void;
  setLinkOverride(from: string, to: string, override: LinkOverride): void;
  startPhase(label: string): void;
  node(id: string): Readonly<{ position: Position }>;
  /** The link budget between two nodes; only media with a fixed PHY answer it. */
  budget?(from: string, to: string): LinkBudget;
  close(): void;
}

export interface MediumOptions {
  seed: number;
  environment: Environment;
  clock: Clock;
  log: EventLog;
  gateway?: VirtualGateway;
  /** Transmit attempts for a unicast frame before the sender gives up. Default 7. */
  retryLimit?: number;
  tap?: FrameTap;
}

interface NodeState extends MediumNode {
  sink: FrameSink;
}

export const GATEWAY_NODE_ID = "gateway";

export class Medium {
  readonly #opts: MediumOptions;
  readonly #nodes = new Map<string, NodeState>();
  readonly #idByMac = new Map<string, string>();
  readonly #overrides = new Map<string, LinkOverride>();
  readonly #ordinals = new Map<string, number>();
  readonly #shadowing = new Map<string, number>();
  readonly #cancels = new Set<() => void>();

  constructor(opts: MediumOptions) {
    this.#opts = opts;
  }

  addNode(node: MediumNode, sink: FrameSink): void {
    if (this.#nodes.has(node.id)) throw new Error(`duplicate node id ${JSON.stringify(node.id)}`);
    const owner = this.#idByMac.get(node.mac);
    if (owner !== undefined) {
      throw new Error(`node ${node.id} has the same MAC ${node.mac} as ${owner}`);
    }
    this.#nodes.set(node.id, { ...node, sink });
    this.#idByMac.set(node.mac, node.id);
  }

  get nodeIds(): string[] {
    return [...this.#nodes.keys()];
  }

  node(id: string): Readonly<MediumNode> {
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

  /** Start a new metrics window. Metrics are reported per window as well as in total. */
  startPhase(label: string): void {
    this.#opts.log.append({ type: "phase", t: this.#opts.clock.now(), label });
  }

  /** Current budget of the directed link, e.g. for the report. */
  budget(from: string, to: string): LinkBudget {
    const tx = this.#requireNode(from);
    const rx = this.#requireNode(to);
    return linkBudget(this.#opts.environment, tx, rx, this.#shadowingDb(from, to));
  }

  /** Stop deliveries that have not happened yet. */
  close(): void {
    for (const cancel of this.#cancels) cancel();
    this.#cancels.clear();
  }

  /** A board put `frame` on the air. */
  transmit(from: string, frame: Uint8Array): void {
    const sender = this.#requireNode(from);
    const eth = parseEthernet(frame);
    if (!eth) return; // shorter than an Ethernet header: nothing to switch on
    const { clock, log } = this.#opts;
    const kind = classifyFrame(frame);
    log.append({
      type: "tx",
      t: clock.now(),
      node: from,
      bytes: frame.length,
      kind,
      dst: eth.dst,
      src: eth.src,
    });
    this.#opts.tap?.(clock.now(), from, frame);

    const gateway = this.#opts.gateway;
    if (gateway) {
      const answer = gateway.handle(frame);
      if (answer) {
        log.append({
          type: "service",
          t: clock.now(),
          service: answer.service,
          detail: answer.detail,
        });
        for (const reply of answer.replies) this.#replyFromGateway(sender, reply);
        return;
      }
      if (eth.dst === gateway.mac) return; // addressed to the gateway, which has nothing to say
    }

    const group = isGroupMac(eth.dst);
    const targetId = group ? undefined : this.#idByMac.get(eth.dst);
    // Group addresses and addresses nobody owns reach every other station on
    // the air, the way a broadcast does. Neither is acknowledged.
    const unacked = group || targetId === undefined;
    const receivers = targetId !== undefined ? [targetId] : [...this.#nodes.keys()];
    for (const toId of receivers) {
      if (toId === from) continue;
      this.#crossLink(
        sender,
        this.#requireNode(toId),
        frame,
        kind,
        unacked,
        targetId !== undefined,
      );
    }
  }

  #replyFromGateway(to: NodeState, reply: Uint8Array): void {
    const { clock } = this.#opts;
    const eth = parseEthernet(reply);
    this.#opts.tap?.(clock.now(), GATEWAY_NODE_ID, reply);
    this.#opts.log.append({
      type: "tx",
      t: clock.now(),
      node: GATEWAY_NODE_ID,
      bytes: reply.length,
      kind: classifyFrame(reply),
      dst: eth?.dst ?? "",
      src: eth?.src ?? "",
    });
    this.#after(0, () => {
      if (to.sink.ready()) to.sink.deliver(reply.slice(), GATEWAY_NODE_ID);
    });
  }

  #crossLink(
    sender: NodeState,
    receiver: NodeState,
    frame: Uint8Array,
    kind: FrameKind,
    unacked: boolean,
    addressed: boolean,
  ): void {
    const { clock, log, environment, seed } = this.#opts;
    const linkKey = `${sender.id}>${receiver.id}`;
    const budget = this.budget(sender.id, receiver.id);
    const base = { from: sender.id, to: receiver.id, bytes: frame.length, kind };
    const drop = (reason: DropReason, attempts: number) =>
      log.append({
        type: "drop",
        t: clock.now(),
        ...base,
        reason,
        attempts,
        rssiDbm: budget.rssiDbm,
        snrDb: budget.snrDb,
      });

    if (sender.radio.channel !== receiver.radio.channel) {
      // Out of earshot. A frame for a specific station is a loss worth
      // reporting; a broadcast simply is not heard by that station.
      if (addressed) drop("channel_mismatch", 0);
      return;
    }
    if (!receiver.sink.ready()) {
      if (addressed) drop("no_peer", 0);
      return;
    }

    const ordinal = this.#ordinals.get(linkKey) ?? 0;
    this.#ordinals.set(linkKey, ordinal + 1);
    const override = this.#overrides.get(linkKey);
    const outcome = simulateFrame(
      environment,
      budget,
      {
        frameBytes: frame.length,
        broadcast: unacked,
        retryLimit: this.#opts.retryLimit ?? 7,
        extraLossPct: override?.extraLossPct ?? 0,
        extraLatencyMs: override?.extraLatencyMs ?? 0,
      },
      substream(seed, `frame:${linkKey}#${ordinal}`),
    );
    if (!outcome.delivered) {
      drop(outcome.reason ?? "retry_exhausted", outcome.attempts);
      return;
    }
    log.append({
      type: "deliver",
      t: clock.now(),
      ...base,
      delayMs: outcome.delayMs,
      attempts: outcome.attempts,
      rateMbps: outcome.rateMbps,
      rssiDbm: budget.rssiDbm,
      snrDb: budget.snrDb,
    });
    const copy = frame.slice();
    this.#after(outcome.delayMs, () => receiver.sink.deliver(copy, sender.id));
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
