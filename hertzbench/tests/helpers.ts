import {
  buildDhcpClientMessage,
  buildEspNowBody,
  buildEthernet,
  buildUdp,
  type Clock,
  type Environment,
  environmentFromPreset,
  EventLog,
  type FrameSink,
  ManualClock,
  Medium,
  type MediumNode,
  type MediumOptions,
  type VirtualGateway,
} from "../engine/mod.ts";
import { expandLinkRule, type LinkRule, type Scenario } from "../orchestrator/mod.ts";
import { EspNowForkModel } from "../orchestrator/boards/espnow-fork-model.ts";

export const GATEWAY_MAC = "02:68:7a:62:00:01";
export const GATEWAY_IP = "192.168.4.1";

export function macFor(index: number): string {
  return `02:68:7a:62:01:${index.toString(16).padStart(2, "0")}`;
}

export function ipFor(index: number): string {
  return `192.168.4.${10 + index}`;
}

/** A sink that remembers what it was given. */
export class RecordingSink implements FrameSink {
  readonly frames: { frame: Uint8Array; from: string; atMs: number }[] = [];
  connected = true;
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  ready(): boolean {
    return this.connected;
  }

  deliver(frame: Uint8Array, from: string): void {
    this.frames.push({ frame, from, atMs: this.#clock.now() });
  }
}

export interface Rig {
  clock: ManualClock;
  log: EventLog;
  medium: Medium;
  sinks: Map<string, RecordingSink>;
  nodes: MediumNode[];
}

export interface RigOptions {
  seed?: number;
  environment?: Environment;
  /** Node positions by id; MAC and radio are filled in. */
  positions: Record<string, { x: number; y: number }>;
  channel?: number;
  txPowerDbm?: number;
  gateway?: VirtualGateway;
  channels?: Record<string, number>;
  mediumOptions?: Partial<MediumOptions>;
}

export function makeRig(options: RigOptions): Rig {
  const clock = new ManualClock();
  const log = new EventLog();
  const medium = new Medium({
    seed: options.seed ?? 1,
    environment: options.environment ?? environmentFromPreset("indoor_office"),
    clock,
    log,
    gateway: options.gateway,
    ...options.mediumOptions,
  });
  const sinks = new Map<string, RecordingSink>();
  const nodes: MediumNode[] = [];
  Object.entries(options.positions).forEach(([id, position], i) => {
    const node: MediumNode = {
      id,
      mac: macFor(i + 1),
      position,
      radio: {
        channel: options.channels?.[id] ?? options.channel ?? 6,
        txPowerDbm: options.txPowerDbm ?? 15,
        antennaGainDbi: 0,
      },
    };
    const sink = new RecordingSink(clock);
    sinks.set(id, sink);
    nodes.push(node);
    medium.addNode(node, sink);
  });
  return { clock, log, medium, sinks, nodes };
}

export function macOf(rig: Rig, id: string): string {
  const node = rig.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node.mac;
}

/** A small UDP datagram from one rig node to another. */
export function udpFrame(rig: Rig, from: string, to: string, payload = "ping"): Uint8Array {
  const fromIndex = rig.nodes.findIndex((n) => n.id === from) + 1;
  const toIndex = rig.nodes.findIndex((n) => n.id === to) + 1;
  return buildUdp({
    srcMac: macFor(fromIndex),
    dstMac: macFor(toIndex),
    srcIp: ipFor(fromIndex),
    dstIp: ipFor(toIndex),
    srcPort: 5000,
    dstPort: 5000,
    payload: new TextEncoder().encode(payload),
  });
}

export function broadcastFrame(srcMac: string): Uint8Array {
  return buildEthernet("ff:ff:ff:ff:ff:ff", srcMac, 0x0842, new Uint8Array(40));
}

/** A DHCPDISCOVER (1) or DHCPREQUEST (3), built by the same code the scripted board uses. */
export function dhcpClientMessage(
  clientMac: string,
  type: 1 | 3,
  xid: number,
  requestedIp?: string,
): Uint8Array {
  return buildDhcpClientMessage(clientMac, type, xid, requestedIp);
}

/** Poll until `condition` holds. Fails the test after `timeoutMs` instead of hanging it. */
export async function until(
  condition: () => boolean,
  what: string,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/**
 * Plays a scenario's geometry and timeline on a manual clock with synthetic UDP
 * traffic (every node pings every other node), so a scenario's metric
 * assertions can be checked without any board. Serial assertions cannot be.
 */
export function simulateScenarioTraffic(
  scenario: Scenario,
  options: { everyMs: number; payloadBytes: number },
): Rig {
  const onMedium = scenario.nodes.filter((n) => !n.internetGateway);
  const clock = new ManualClock();
  const log = new EventLog();
  const medium = new Medium({
    seed: scenario.seed,
    environment: scenario.environment,
    clock,
    log,
    retryLimit: scenario.retryLimit,
  });
  const sinks = new Map<string, RecordingSink>();
  for (const node of onMedium) {
    if (node.radio.phy !== "wifi") throw new Error(`${node.id}: this rig is Wi-Fi only`);
    const sink = new RecordingSink(clock);
    sinks.set(node.id, sink);
    medium.addNode(
      { id: node.id, mac: node.mac, position: node.position, radio: node.radio },
      sink,
    );
  }
  const payload = new Uint8Array(options.payloadBytes).fill(0x61);
  for (const event of scenario.timeline) {
    clock.schedule(event.atMs, () => {
      if (event.label !== null) medium.startPhase(event.label);
      for (const action of event.actions) {
        if (action.kind === "move") medium.moveNode(action.node, action.to);
      }
    });
  }
  for (let t = 0; t < scenario.durationMs; t += options.everyMs) {
    clock.advanceTo(t);
    for (const from of onMedium) {
      for (const to of onMedium) {
        if (from === to) continue;
        medium.transmit(
          from.id,
          buildUdp({
            srcMac: from.mac,
            dstMac: to.mac,
            srcIp: from.ip,
            dstIp: to.ip,
            srcPort: 5000,
            dstPort: 5000,
            payload,
          }),
        );
      }
    }
  }
  clock.advanceTo(scenario.durationMs);
  clock.runAll();
  return { clock, log, medium, sinks, nodes: [] };
}

/** One stream of ESP-NOW frames: a node id to a node id or "broadcast", one frame per period. */
export interface EspNowTraffic {
  from: string;
  to: string;
  everyMs: number;
}

/**
 * Plays a scenario's geometry, link rules and timeline on a manual clock with
 * ESP-NOW traffic between fork models (the scripted board's model of the QEMU
 * fork's MAC), so a scenario's ESP-NOW metric assertions can be checked
 * without any board and without wall-clock timing. Serial assertions cannot be.
 */
export function simulateEspNowTraffic(scenario: Scenario, traffic: EspNowTraffic[]): EventLog {
  const onMedium = scenario.nodes.filter((n) => !n.internetGateway);
  const clock = new ManualClock();
  const log = new EventLog();
  const medium = new Medium({
    seed: scenario.seed,
    environment: scenario.environment,
    clock,
    log,
    retryLimit: scenario.retryLimit,
  });
  const models = new Map<string, EspNowForkModel>();
  for (const node of onMedium) {
    if (node.radio.phy !== "wifi") throw new Error(`${node.id}: ESP-NOW needs a Wi-Fi node`);
    const model = new EspNowForkModel({
      mac: node.mac,
      channel: node.radio.channel,
      clock,
      output: (frame) => medium.transmit(node.id, frame),
      onReceive: () => {},
      onTxDone: () => {},
    });
    models.set(node.id, model);
    medium.addNode(
      { id: node.id, mac: node.mac, position: node.position, radio: node.radio },
      { ready: () => true, deliver: (frame) => model.receive(frame) },
    );
  }
  const ids = onMedium.map((n) => n.id);
  const applyRule = (rule: LinkRule) => {
    for (const [from, to] of expandLinkRule(rule, ids)) {
      medium.setLinkOverride(from, to, {
        extraLossPct: rule.extraLossPct,
        extraLatencyMs: rule.extraLatencyMs,
      });
    }
  };
  for (const rule of scenario.links) applyRule(rule);
  for (const event of scenario.timeline) {
    clock.schedule(event.atMs, () => {
      if (event.label !== null) medium.startPhase(event.label);
      for (const action of event.actions) {
        if (action.kind === "move") medium.moveNode(action.node, action.to);
        else applyRule(action.rule);
      }
    });
  }
  const payload = buildEspNowBody(new TextEncoder().encode("reading:0"));
  for (const stream of traffic) {
    const dst = stream.to === "broadcast"
      ? "ff:ff:ff:ff:ff:ff"
      : onMedium.find((n) => n.id === stream.to)!.mac;
    for (let t = 0; t < scenario.durationMs; t += stream.everyMs) {
      clock.schedule(t, () => models.get(stream.from)!.send(dst, payload));
    }
  }
  clock.advanceTo(scenario.durationMs);
  medium.close();
  return log;
}
