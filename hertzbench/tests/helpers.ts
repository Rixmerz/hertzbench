import {
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

/** A hand-built DHCPDISCOVER or DHCPREQUEST (RFC 2131), the way a client with no address sends it. */
export function dhcpClientMessage(
  clientMac: string,
  type: 1 | 3,
  xid: number,
  requestedIp?: string,
): Uint8Array {
  const body = new Uint8Array(300);
  body[0] = 1; // BOOTREQUEST
  body[1] = 1; // Ethernet
  body[2] = 6;
  new DataView(body.buffer).setUint32(4, xid);
  body[10] = 0x80; // broadcast flag
  clientMac.split(":").forEach((b, i) => body[28 + i] = Number.parseInt(b, 16));
  body.set([99, 130, 83, 99], 236);
  const options = [53, 1, type];
  if (requestedIp) options.push(50, 4, ...requestedIp.split(".").map(Number));
  options.push(255);
  body.set(options, 240);
  return buildUdp({
    srcMac: clientMac,
    dstMac: "ff:ff:ff:ff:ff:ff",
    srcIp: "0.0.0.0",
    dstIp: "255.255.255.255",
    srcPort: 68,
    dstPort: 67,
    payload: body,
  });
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
