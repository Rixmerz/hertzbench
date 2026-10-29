// The shared medium: nodes with positions and radios, a static layer-2 switch
// between their stations, and the channel model applied per link per frame.
//
// The switch never learns addresses. Every QEMU board's embedded access point
// uses the same AP MAC (hw/misc/esp32_wifi_ap.c:517), so source-MAC learning
// would see one MAC on every port. The scenario assigns each board a station
// MAC and the table is built from that.
//
// ESP-NOW (ADR 0001) crosses the switch as the fork's pseudo-Ethernet. Action
// frames take the channel model like any frame, on the channel the guest wrote
// into byte 12. The fork's ACK for a unicast one is not a frame of its own on
// the channel model: the action frame's MAC outcome already includes it. It is
// delayed by its fixed time on the air and dropped when it would reach its
// sender after the fork's 10 ms wait. The fork does not check which frame an
// ACK answers (hw/misc/esp32_wifi_ap.c:465-476), so a late ACK would complete
// the sender's next frame, or re-arm a timer that already fired; no real
// radio sends a late ACK.
import {
  ACK_AIRTIME_US,
  type ChipSignal,
  type Environment,
  type LinkBudget,
  linkBudget,
  type Position,
  type RadioConfig,
  SIFS_US,
  simulateFrame,
  SPEED_OF_LIGHT_M_S,
  withInterference,
  withSourceActive,
  withWallAttenuation,
} from "./channel.ts";
import type { Clock } from "./clock.ts";
import { ESPNOW_ACK_TIMEOUT_MS, type EspNowFrame, parseEspNow } from "./espnow.ts";
import type { ChannelChanges, DropReason, EspNowOutcome, EventLog, FrameKind } from "./events.ts";
import type { VirtualGateway } from "./gateway.ts";
import { classifyFrame, isGroupMac, macToBytes, parseEthernet, parseIpv4 } from "./packet.ts";
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

/** Chaos on one directed link. All zero clears it. */
export interface LinkOverride {
  extraLossPct: number;
  extraLatencyMs: number;
  /** Extra latency drawn uniformly from 0 to this, per frame. Default 0. */
  extraJitterMs?: number;
  /** Noise rise at the receiver from an interferer, in dB: the link's SNR falls by as much. Default 0. */
  interferenceDb?: number;
}

/** What the runner and the timeline do to a medium, whichever PHY it carries. */
export interface MediumControl {
  moveNode(id: string, position: Position): void;
  setLinkOverride(from: string, to: string, override: LinkOverride): void;
  startPhase(label: string): void;
  node(id: string): Readonly<{ position: Position }>;
  /**
   * The budget of a directed link now. On the chip-level air it carries the
   * signal it was read against: the sender's last frame, or its declared radio.
   */
  budget(from: string, to: string): LinkBudget & { signal?: ChipSignal };
  setEnvironment(changes: ChannelChanges): void;
  /**
   * Set the attenuation of every wall named `id` (a door opening or closing);
   * every later frame and budget uses it. A warning is logged when no wall has
   * that id any more, since a live `setEnvironment` may have replaced the walls.
   */
  setObstacleAttenuation(id: string, attenuationDb: number): void;
  /** Switch an interference source on or off, with the same warning for an unknown id. */
  setInterference(id: string, active: boolean): void;
  /** The channel model as it is now, walls and interference states included. */
  environment(): Environment;
  /** Change a station's radio as the medium models it; each medium names what it accepts. */
  setRadio(id: string, changes: Partial<RadioConfig>): void;
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

/** A unicast ESP-NOW frame whose sender waits for the ACK. */
interface PendingEspNow {
  txAtMs: number;
  /** Set when the receiver has the frame; an ACK before then answers an older one. */
  delivered: boolean;
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
  #environment: Environment;
  /** Keyed `sender>receiver`. The fork has one ACK timer, so one frame waits per pair. */
  readonly #espnowPending = new Map<string, PendingEspNow>();
  readonly #channelWarned = new Set<string>();

  constructor(opts: MediumOptions) {
    this.#opts = opts;
    this.#environment = opts.environment;
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

  /** Change channel-model parameters now; every later frame and budget uses them. */
  setEnvironment(changes: ChannelChanges): void {
    this.#environment = { ...this.#environment, ...changes };
    this.#opts.log.append({ type: "channel", t: this.#opts.clock.now(), changes });
  }

  setObstacleAttenuation(id: string, attenuationDb: number): void {
    const next = withWallAttenuation(this.#environment, id, attenuationDb);
    if (!next) return this.#warnUnknown("obstacle", id);
    this.#environment = next;
    this.#opts.log.append({
      type: "channel",
      t: this.#opts.clock.now(),
      changes: { obstacles: next.obstacles },
    });
  }

  setInterference(id: string, active: boolean): void {
    const next = withSourceActive(this.#environment, id, active);
    if (!next) return this.#warnUnknown("interference source", id);
    this.#environment = next;
    this.#opts.log.append({ type: "interference", t: this.#opts.clock.now(), id, active });
  }

  environment(): Environment {
    return this.#environment;
  }

  #warnUnknown(what: string, id: string): void {
    this.#opts.log.append({
      type: "warning",
      t: this.#opts.clock.now(),
      text: `no ${what} named ${JSON.stringify(id)} any more; the change was ignored`,
    });
  }

  /**
   * Change a station's radio as the medium models it: the channel it hears
   * on, its transmit power and antenna gain. The firmware is not told.
   */
  setRadio(id: string, changes: Partial<RadioConfig>): void {
    const node = this.#requireNode(id);
    node.radio = { ...node.radio, ...changes };
    this.#opts.log.append({ type: "radio", t: this.#opts.clock.now(), node: id, changes });
  }

  /** Start a new metrics window. Metrics are reported per window as well as in total. */
  startPhase(label: string): void {
    this.#opts.log.append({ type: "phase", t: this.#opts.clock.now(), label });
  }

  /** Current budget of the directed link, e.g. for the report. */
  budget(from: string, to: string): LinkBudget {
    const tx = this.#requireNode(from);
    const rx = this.#requireNode(to);
    return withInterference(
      linkBudget(this.#environment, tx, rx, this.#shadowingDb(from, to)),
      this.#overrides.get(`${from}>${to}`)?.interferenceDb ?? 0,
    );
  }

  /**
   * Stop deliveries that have not happened yet. A unicast ESP-NOW frame whose
   * ACK window has passed with no ACK is recorded as `no_ack`; one still inside
   * its window was cut off by the end of the run and is not counted.
   */
  close(): void {
    for (const cancel of this.#cancels) cancel();
    this.#cancels.clear();
    const now = this.#opts.clock.now();
    for (const [key, pending] of this.#espnowPending) {
      if (now - pending.txAtMs < ESPNOW_ACK_TIMEOUT_MS) continue;
      const [from, to] = key.split(">") as [string, string];
      this.#espnowOutcome(from, to, "no_ack", null);
    }
    this.#espnowPending.clear();
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

    const espnow = parseEspNow(frame);
    if (espnow?.type === "ack") return this.#forwardEspNowAck(sender, espnow, frame);
    if (espnow && espnow.channel !== sender.radio.channel && !this.#channelWarned.has(from)) {
      this.#channelWarned.add(from);
      log.append({
        type: "warning",
        t: clock.now(),
        text: `node ${from} sends ESP-NOW on channel ${espnow.channel} but the scenario puts ` +
          `its radio on channel ${sender.radio.channel}; only nodes on channel ` +
          `${espnow.channel} hear it`,
      });
    }

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
    const ownerId = group ? undefined : this.#idByMac.get(eth.dst);
    const holderId = group || ownerId !== undefined ? undefined : this.#leaseHolderOf(frame);
    const targetId = ownerId ?? holderId;
    // A station accepts only frames addressed to its own MAC. The one that
    // went by its lease carries the fork's AP MAC instead, so it is readdressed
    // here; an Android guest drops it otherwise, and its TCP handshake never
    // completes.
    const delivered = holderId === undefined ? frame : this.#readdressed(frame, holderId);
    // Group addresses and addresses nobody owns reach every other station on
    // the air, the way a broadcast does. Neither is acknowledged.
    const unacked = group || targetId === undefined;
    const receivers = targetId !== undefined ? [targetId] : [...this.#nodes.keys()];
    for (const toId of receivers) {
      if (toId === from) continue;
      this.#crossLink(
        sender,
        this.#requireNode(toId),
        delivered,
        kind,
        unacked,
        targetId !== undefined,
        espnow?.channel ?? sender.radio.channel,
      );
    }
  }

  /**
   * The node an IPv4 frame is for when its destination MAC names no node.
   * The QEMU fork's Wi-Fi MAC writes its access point's MAC
   * (10:01:00:c4:0a:51 for "Espressif") as the Ethernet destination of every
   * frame a station sends (hw/misc/esp32_wifi_ap.c), so on real firmware the
   * peer is only known from the destination IP and the lease that holds it.
   */
  #leaseHolderOf(frame: Uint8Array): string | undefined {
    const ip = parseIpv4(frame);
    if (!ip) return undefined;
    const mac = this.#opts.gateway?.stationForIp(ip.dst);
    return mac === undefined ? undefined : this.#idByMac.get(mac);
  }

  /** A copy of `frame` addressed to the station of node `id`. */
  #readdressed(frame: Uint8Array, id: string): Uint8Array {
    const copy = frame.slice();
    copy.set(macToBytes(this.#requireNode(id).mac), 0);
    return copy;
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
    channel: number,
  ): void {
    const { clock, log, seed } = this.#opts;
    const environment = this.#environment;
    const linkKey = `${sender.id}>${receiver.id}`;
    const budget = this.budget(sender.id, receiver.id);
    const base = { from: sender.id, to: receiver.id, bytes: frame.length, kind };
    const awaitsAck = kind === "espnow" && addressed;
    const drop = (reason: DropReason, attempts: number) => {
      log.append({
        type: "drop",
        t: clock.now(),
        ...base,
        reason,
        attempts,
        rssiDbm: budget.rssiDbm,
        snrDb: budget.snrDb,
      });
      if (awaitsAck) this.#espnowOutcome(sender.id, receiver.id, "frame_lost", null);
    };
    // A frame still waiting for its ACK when the next one goes never got one.
    if (awaitsAck && this.#espnowPending.has(linkKey)) {
      this.#espnowOutcome(sender.id, receiver.id, "no_ack", null);
    }

    if (channel !== receiver.radio.channel) {
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
        extraJitterMs: override?.extraJitterMs ?? 0,
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
    if (!awaitsAck) {
      this.#after(outcome.delayMs, () => receiver.sink.deliver(copy, sender.id));
      return;
    }
    const pending: PendingEspNow = { txAtMs: clock.now(), delivered: false };
    this.#espnowPending.set(linkKey, pending);
    this.#after(outcome.delayMs, () => {
      pending.delivered = true;
      receiver.sink.deliver(copy, sender.id);
    });
  }

  /** `acker` answered a unicast ESP-NOW frame; carry the ACK back if the sender still waits. */
  #forwardEspNowAck(acker: NodeState, ack: EspNowFrame, frame: Uint8Array): void {
    const { clock, log } = this.#opts;
    const senderId = this.#idByMac.get(ack.dst);
    if (senderId === undefined || senderId === acker.id) return; // answers nobody on the medium
    const sender = this.#requireNode(senderId);
    const budget = this.budget(acker.id, sender.id);
    const base = {
      from: acker.id,
      to: sender.id,
      bytes: frame.length,
      kind: "espnow-ack" as const,
      attempts: 1,
      rssiDbm: budget.rssiDbm,
      snrDb: budget.snrDb,
    };
    const drop = (reason: DropReason) =>
      log.append({ type: "drop", t: clock.now(), ...base, reason });

    if (ack.channel !== sender.radio.channel) return drop("channel_mismatch");
    if (!sender.sink.ready()) return drop("no_peer");
    const key = `${sender.id}>${acker.id}`;
    const pending = this.#espnowPending.get(key);
    if (!pending?.delivered) return drop("ack_unmatched");

    // SIFS, the ACK on the air and propagation. No loss and no retries: the
    // action frame's MAC outcome already counted this ACK.
    const delayMs = (SIFS_US + ACK_AIRTIME_US) / 1000 +
      (budget.distanceM / SPEED_OF_LIGHT_M_S) * 1000 +
      (this.#overrides.get(`${acker.id}>${sender.id}`)?.extraLatencyMs ?? 0);
    const roundTripMs = clock.now() + delayMs - pending.txAtMs;
    if (roundTripMs > ESPNOW_ACK_TIMEOUT_MS) {
      drop("ack_timeout");
      this.#espnowOutcome(sender.id, acker.id, "ack_timeout", roundTripMs);
      return;
    }
    log.append({ type: "deliver", t: clock.now(), ...base, delayMs, rateMbps: 6 });
    this.#espnowOutcome(sender.id, acker.id, "acked", roundTripMs);
    const copy = frame.slice();
    this.#after(delayMs, () => sender.sink.deliver(copy, acker.id));
  }

  #espnowOutcome(
    from: string,
    to: string,
    outcome: EspNowOutcome,
    roundTripMs: number | null,
  ): void {
    this.#espnowPending.delete(`${from}>${to}`);
    this.#opts.log.append({
      type: "espnow-send",
      t: this.#opts.clock.now(),
      from,
      to,
      outcome,
      roundTripMs,
    });
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
      value = substream(this.#opts.seed, `shadow:${key}`).gaussian();
      this.#shadowing.set(key, value);
    }
    // The draw is kept unscaled, so a sigma changed mid-run applies to every pair at once.
    return this.#environment.shadowingSigmaDb * value;
  }

  #requireNode(id: string): NodeState {
    const node = this.#nodes.get(id);
    if (!node) throw new Error(`unknown node ${JSON.stringify(id)}`);
    return node;
  }
}
