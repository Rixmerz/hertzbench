// mDNS / DNS-SD for the IP bridge (RFC 6762, RFC 6763): a phone browsing the
// LAN finds each exposed node as a service, `web-80._http._tcp.local` at
// `hzb-web.local:8080`, without typing the host's address.
//
// The responder answers questions for its own records and announces them at
// start and with a TTL of 0 at the end. The DNS codec and the responder are
// pure and take a transport, so they are tested without a network; the UDP
// transport (multicast on 224.0.0.251:5353) is the host-dependent part.
//
// ponytail: no probing and no conflict resolution (RFC 6762 §8.1, §9): the
// names carry the node id and "hzb-", so a clash on a home LAN is unlikely,
// and a clash only costs a phone the second answer. No known-answer
// suppression either; a phone just hears an answer it already had.

import dgram from "node:dgram";
import type { IpBridgeSpec } from "../../orchestrator/scenario.ts";
import type { BridgeEndpoint, EndpointPublisher } from "./proxy.ts";

export const MDNS_GROUP = "224.0.0.251";
export const MDNS_PORT = 5353;

export const RR = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 } as const;
const CLASS_IN = 1;
/** In a question: the asker wants a unicast answer. In a record: replace what the cache holds. */
const TOP_BIT = 0x8000;
/** RFC 6762 §10: host records live 120 s, the others 75 minutes. */
const HOST_TTL = 120;
const OTHER_TTL = 4500;
/** RFC 6762 §6.7: a legacy unicast answer carries a TTL of at most 10 s. */
const LEGACY_TTL = 10;

export interface DnsQuestion {
  name: string;
  type: number;
  /** The QU bit: answer by unicast. */
  unicast: boolean;
}

export type RData =
  | { type: typeof RR.A; address: string }
  | { type: typeof RR.PTR; target: string }
  | { type: typeof RR.TXT; entries: string[] }
  | { type: typeof RR.SRV; priority: number; weight: number; port: number; target: string };

export interface DnsRecord {
  name: string;
  ttl: number;
  /** The cache-flush bit: set on records this host alone answers for. */
  unique: boolean;
  data: RData;
}

export interface DnsMessage {
  id: number;
  response: boolean;
  questions: DnsQuestion[];
  answers: DnsRecord[];
  additionals: DnsRecord[];
}

export class DnsFormatError extends Error {
  override name = "DnsFormatError";
}

// ── codec ───────────────────────────────────────────────────────────────────

function encodeName(name: string): number[] {
  const out: number[] = [];
  for (const label of name.replace(/\.$/, "").split(".")) {
    const bytes = new TextEncoder().encode(label);
    if (bytes.length === 0 || bytes.length > 63) {
      throw new DnsFormatError(`bad DNS label in ${JSON.stringify(name)}`);
    }
    out.push(bytes.length, ...bytes);
  }
  out.push(0);
  return out;
}

/** A name at `offset`, following compression pointers (RFC 1035 §4.1.4). */
function decodeName(buf: Uint8Array, offset: number): [string, number] {
  const labels: string[] = [];
  let end = -1;
  let jumps = 0;
  for (let i = offset;;) {
    if (i >= buf.length) throw new DnsFormatError("name runs past the end of the message");
    const length = buf[i] as number;
    if (length === 0) {
      if (end < 0) end = i + 1;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      if (i + 1 >= buf.length) throw new DnsFormatError("truncated compression pointer");
      if (++jumps > 32) throw new DnsFormatError("compression pointer loop");
      if (end < 0) end = i + 2;
      i = ((length & 0x3f) << 8) | (buf[i + 1] as number);
      continue;
    }
    if (length > 63 || i + 1 + length > buf.length) throw new DnsFormatError("bad label");
    labels.push(new TextDecoder().decode(buf.subarray(i + 1, i + 1 + length)));
    i += 1 + length;
  }
  return [labels.join("."), end];
}

function u16(n: number): number[] {
  return [(n >>> 8) & 0xff, n & 0xff];
}

function encodeRecord(record: DnsRecord): number[] {
  const d = record.data;
  let rdata: number[];
  switch (d.type) {
    case RR.A:
      rdata = d.address.split(".").map(Number);
      break;
    case RR.PTR:
      rdata = encodeName(d.target);
      break;
    case RR.TXT:
      rdata = d.entries.length === 0 ? [0] : d.entries.flatMap((entry) => {
        const bytes = new TextEncoder().encode(entry).slice(0, 255);
        return [bytes.length, ...bytes];
      });
      break;
    case RR.SRV:
      rdata = [...u16(d.priority), ...u16(d.weight), ...u16(d.port), ...encodeName(d.target)];
      break;
  }
  const ttl = record.ttl >>> 0;
  return [
    ...encodeName(record.name),
    ...u16(d.type),
    ...u16(CLASS_IN | (record.unique ? TOP_BIT : 0)),
    (ttl >>> 24) & 0xff,
    (ttl >>> 16) & 0xff,
    (ttl >>> 8) & 0xff,
    ttl & 0xff,
    ...u16(rdata.length),
    ...rdata,
  ];
}

export function encodeMessage(message: DnsMessage): Uint8Array {
  const out = [
    ...u16(message.id),
    ...u16(message.response ? 0x8400 : 0), // QR and AA: an authoritative answer
    ...u16(message.questions.length),
    ...u16(message.answers.length),
    ...u16(0),
    ...u16(message.additionals.length),
  ];
  for (const q of message.questions) {
    out.push(...encodeName(q.name), ...u16(q.type), ...u16(CLASS_IN | (q.unicast ? TOP_BIT : 0)));
  }
  for (const r of [...message.answers, ...message.additionals]) out.push(...encodeRecord(r));
  return Uint8Array.from(out);
}

/** Questions and the records this module knows; records of other types are skipped. */
export function decodeMessage(buf: Uint8Array): DnsMessage {
  if (buf.length < 12) throw new DnsFormatError("shorter than a DNS header");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.length);
  const counts = [view.getUint16(4), view.getUint16(6), view.getUint16(8), view.getUint16(10)];
  let offset = 12;
  const questions: DnsQuestion[] = [];
  for (let i = 0; i < (counts[0] as number); i++) {
    const [name, next] = decodeName(buf, offset);
    if (next + 4 > buf.length) throw new DnsFormatError("truncated question");
    const qclass = view.getUint16(next + 2);
    questions.push({ name, type: view.getUint16(next), unicast: (qclass & TOP_BIT) !== 0 });
    offset = next + 4;
  }
  const sections: DnsRecord[][] = [[], [], []];
  for (const [section, count] of [counts[1], counts[2], counts[3]].entries()) {
    for (let i = 0; i < (count as number); i++) {
      const [name, next] = decodeName(buf, offset);
      if (next + 10 > buf.length) throw new DnsFormatError("truncated record");
      const type = view.getUint16(next);
      const rclass = view.getUint16(next + 2);
      const length = view.getUint16(next + 8);
      const start = next + 10;
      if (start + length > buf.length) throw new DnsFormatError("truncated record data");
      const data = decodeRData(buf, type, start, length);
      const ttl = view.getUint32(next + 4);
      if (data) sections[section]?.push({ name, ttl, unique: (rclass & TOP_BIT) !== 0, data });
      offset = start + length;
    }
  }
  return {
    id: view.getUint16(0),
    response: (view.getUint16(2) & 0x8000) !== 0,
    questions,
    answers: sections[0] as DnsRecord[],
    // The authority section only matters while probing, which this responder does not do.
    additionals: sections[2] as DnsRecord[],
  };
}

function decodeRData(buf: Uint8Array, type: number, start: number, length: number): RData | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.length);
  switch (type) {
    case RR.A:
      return length === 4
        ? { type: RR.A, address: Array.from(buf.subarray(start, start + 4)).join(".") }
        : null;
    case RR.PTR:
      return { type: RR.PTR, target: decodeName(buf, start)[0] };
    case RR.TXT: {
      const entries: string[] = [];
      for (let i = start; i < start + length;) {
        const n = buf[i] as number;
        if (n > 0) entries.push(new TextDecoder().decode(buf.subarray(i + 1, i + 1 + n)));
        i += 1 + n;
      }
      return { type: RR.TXT, entries };
    }
    case RR.SRV:
      return {
        type: RR.SRV,
        priority: view.getUint16(start),
        weight: view.getUint16(start + 2),
        port: view.getUint16(start + 4),
        target: decodeName(buf, start + 6)[0],
      };
  }
  return null;
}

// ── the bridge's records ────────────────────────────────────────────────────

/** DNS-SD service type per bridged protocol. `_ws._tcp` is a convention, not IANA-registered. */
export const SERVICE_TYPES: Record<BridgeEndpoint["service"], string> = {
  http: "_http._tcp.local",
  websocket: "_ws._tcp.local",
  mqtt: "_mqtt._tcp.local",
};

/** The host name a node's services point at. */
export function hostNameFor(node: string): string {
  return `hzb-${node.toLowerCase().replace(/[^a-z0-9-]/g, "-")}.local`;
}

/** PTR, SRV, TXT and A records for each endpoint, all on `hostIp`. */
export function bridgeRecords(endpoints: readonly BridgeEndpoint[], hostIp: string): DnsRecord[] {
  const records: DnsRecord[] = [];
  const seen = new Set<string>();
  const add = (record: DnsRecord) => {
    const key = `${record.name.toLowerCase()}|${record.data.type}|${JSON.stringify(record.data)}`;
    if (!seen.has(key)) records.push(record);
    seen.add(key);
  };
  for (const e of endpoints) {
    const type = SERVICE_TYPES[e.service];
    const instance = `${e.node}-${e.port}.${type}`;
    const host = hostNameFor(e.node);
    add({
      name: "_services._dns-sd._udp.local",
      ttl: OTHER_TTL,
      unique: false,
      data: { type: RR.PTR, target: type },
    });
    add({ name: type, ttl: OTHER_TTL, unique: false, data: { type: RR.PTR, target: instance } });
    add({
      name: instance,
      ttl: HOST_TTL,
      unique: true,
      data: { type: RR.SRV, priority: 0, weight: 0, port: e.hostPort, target: host },
    });
    add({
      name: instance,
      ttl: OTHER_TTL,
      unique: true,
      data: {
        type: RR.TXT,
        entries: [
          `node=${e.node}`,
          `port=${e.port}`,
          "via=hertzbench",
          ...(e.service === "mqtt" ? [] : ["path=/"]),
        ],
      },
    });
    add({ name: host, ttl: HOST_TTL, unique: true, data: { type: RR.A, address: hostIp } });
  }
  return records;
}

// ── the responder ───────────────────────────────────────────────────────────

export interface Peer {
  address: string;
  port: number;
}

export interface MdnsTransport {
  /** To the multicast group when `to` is absent. */
  send(message: Uint8Array, to?: Peer): Promise<void>;
  onMessage(fn: (message: Uint8Array, from: Peer) => void): void;
  close(): Promise<void>;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export class MdnsResponder {
  readonly #records: DnsRecord[];
  readonly #transport: MdnsTransport;
  readonly #sleep: (ms: number) => Promise<void>;
  #closed = false;

  constructor(
    records: DnsRecord[],
    transport: MdnsTransport,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.#records = records;
    this.#transport = transport;
    this.#sleep = sleep;
    transport.onMessage((message, from) => void this.#onMessage(message, from));
  }

  /** RFC 6762 §8.3: announce twice, one second apart. Resolves after the first. */
  async announce(): Promise<void> {
    await this.#send(this.#unsolicited(this.#records));
    void this.#sleep(1000).then(() => {
      if (!this.#closed) return this.#send(this.#unsolicited(this.#records));
    });
  }

  /** RFC 6762 §10.1: say goodbye with a TTL of 0, then stop answering. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#send(this.#unsolicited(this.#records.map((r) => ({ ...r, ttl: 0 }))));
    await this.#transport.close();
  }

  /** The answer to `query` from `from`, with where to send it; null when no record matches. */
  answer(query: DnsMessage, from: Peer): { message: DnsMessage; to?: Peer } | null {
    if (query.response) return null;
    const answers: DnsRecord[] = [];
    for (const q of query.questions) {
      for (const r of this.#records) {
        if (same(r.name, q.name) && (q.type === RR.ANY || q.type === r.data.type)) {
          if (!answers.includes(r)) answers.push(r);
        }
      }
    }
    if (answers.length === 0) return null;
    const additionals: DnsRecord[] = [];
    const addFor = (name: string, types: number[]) => {
      for (const r of this.#records) {
        if (same(r.name, name) && types.includes(r.data.type) && !answers.includes(r)) {
          if (!additionals.includes(r)) additionals.push(r);
        }
      }
    };
    // RFC 6763 §12: a PTR answer brings its SRV, TXT and address; an SRV its address.
    for (const r of answers) {
      if (r.data.type === RR.PTR) addFor(r.data.target, [RR.SRV, RR.TXT]);
    }
    for (const r of [...answers, ...additionals]) {
      if (r.data.type === RR.SRV) addFor(r.data.target, [RR.A]);
    }
    const legacy = from.port !== MDNS_PORT;
    if (legacy) {
      // RFC 6762 §6.7: a resolver that is not mDNS gets a plain DNS answer back to its port.
      const plain = (r: DnsRecord) => ({ ...r, unique: false, ttl: Math.min(r.ttl, LEGACY_TTL) });
      return {
        message: {
          id: query.id,
          response: true,
          questions: query.questions,
          answers: answers.map(plain),
          additionals: additionals.map(plain),
        },
        to: from,
      };
    }
    const unicast = query.questions.every((q) => q.unicast);
    return {
      message: { id: 0, response: true, questions: [], answers, additionals },
      ...(unicast ? { to: from } : {}),
    };
  }

  async #onMessage(bytes: Uint8Array, from: Peer): Promise<void> {
    if (this.#closed) return;
    let query: DnsMessage;
    try {
      query = decodeMessage(bytes);
    } catch {
      return; // not DNS, or not well formed: other hosts' business
    }
    const reply = this.answer(query, from);
    if (reply) await this.#send(reply.message, reply.to);
  }

  #unsolicited(records: DnsRecord[]): DnsMessage {
    return { id: 0, response: true, questions: [], answers: records, additionals: [] };
  }

  async #send(message: DnsMessage, to?: Peer): Promise<void> {
    try {
      await this.#transport.send(encodeMessage(message), to);
    } catch {
      // A lost announcement is repeated by the next query; the run does not depend on it.
    }
  }
}

// ── the UDP transport ───────────────────────────────────────────────────────

export interface UdpTransportOptions {
  /** Address to bind; default 0.0.0.0. */
  bind?: string;
  /** Port to bind; default 5353. */
  port?: number;
  /** Multicast group to join and to send to; null for a plain unicast socket (tests). */
  group?: string | null;
}

/** mDNS over UDP with node:dgram, which joins the group without Deno's unstable flag. */
export function udpTransport(
  options: UdpTransportOptions = {},
): Promise<MdnsTransport & { readonly port: number }> {
  const group = options.group === undefined ? MDNS_GROUP : options.group;
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const handlers: ((message: Uint8Array, from: Peer) => void)[] = [];
  socket.on("message", (message: Uint8Array, rinfo: { address: string; port: number }) => {
    for (const fn of handlers) fn(new Uint8Array(message), rinfo);
  });
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(options.port ?? MDNS_PORT, options.bind ?? "0.0.0.0", () => {
      socket.off("error", reject);
      // Errors after the bind (a send to an unreachable network) are reported by send.
      socket.on("error", () => {});
      try {
        if (group) {
          socket.addMembership(group);
          socket.setMulticastTTL(255); // RFC 6762 §11
          socket.setMulticastLoopback(true);
        }
      } catch (error) {
        socket.close();
        return reject(error);
      }
      resolve({
        port: socket.address().port,
        send: (message, to) =>
          new Promise<void>((done, fail) => {
            const target = to ?? (group ? { address: group, port: MDNS_PORT } : null);
            if (!target) return fail(new Error("no multicast group to send to"));
            socket.send(message, target.port, target.address, (error: unknown) =>
              error ? fail(error) : done());
          }),
        onMessage: (fn) => handlers.push(fn),
        close: () => new Promise<void>((done) => socket.close(() => done())),
      });
    });
  });
}

// Adapters that only reach this host or its VMs: VirtualBox, VMware, Hyper-V/WSL, Docker, libvirt.
// A phone on the LAN cannot reach them, so they are advertised only when nothing else exists.
const VIRTUAL_NAME = /virtualbox|vbox|vmware|vmnet|vethernet|hyper-v|wsl|docker|^br-|^veth|virbr/i;
const VIRTUAL_MAC = /^(0a:00:27|08:00:27|00:50:56|00:0c:29|00:05:69|00:1c:14|00:15:5d|02:42:)/i;

function isVirtual(i: Deno.NetworkInterfaceInfo): boolean {
  return VIRTUAL_NAME.test(i.name) || VIRTUAL_MAC.test(i.mac);
}

/**
 * The host's LAN IPv4 address, or why it cannot be read: the first non-loopback one, skipping
 * link-local (169.254/16) and virtual adapters unless nothing else is left.
 */
export function firstLanAddress(): string | Error {
  try {
    const candidates = Deno.networkInterfaces().filter((i) =>
      i.family === "IPv4" && !i.address.startsWith("127.")
    );
    const rank = (i: Deno.NetworkInterfaceInfo) =>
      (isVirtual(i) ? 2 : 0) + (i.address.startsWith("169.254.") ? 1 : 0);
    const found = candidates.reduce<Deno.NetworkInterfaceInfo | undefined>(
      (best, i) => (best === undefined || rank(i) < rank(best) ? i : best),
      undefined,
    );
    return found ? found.address : new Error("the host has no non-loopback IPv4 address");
  } catch (error) {
    if (error instanceof Deno.errors.NotCapable || error instanceof Deno.errors.PermissionDenied) {
      return new Error(
        "reading the host's addresses needs --allow-sys=networkInterfaces (deno task lan); " +
          "or set bridge.advertise_ip",
      );
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}

export interface MdnsPublisherOptions {
  spec: IpBridgeSpec;
  transport?: () => Promise<MdnsTransport>;
  hostAddress?: () => string | Error;
}

/** The bridge's EndpointPublisher: mDNS on the LAN. A failure is a line in the report, never the run's end. */
export class MdnsPublisher implements EndpointPublisher {
  readonly #opts: MdnsPublisherOptions;
  #responder: MdnsResponder | null = null;

  constructor(opts: MdnsPublisherOptions) {
    this.#opts = opts;
  }

  async publish(endpoints: readonly BridgeEndpoint[]): Promise<string> {
    const { spec } = this.#opts;
    const specific = spec.listen !== "0.0.0.0" && !spec.listen.startsWith("127.");
    const address = spec.advertiseIp ??
      (specific ? spec.listen : (this.#opts.hostAddress ?? firstLanAddress)());
    if (address instanceof Error) return `not advertised: ${address.message}`;
    let transport: MdnsTransport;
    try {
      transport = await (this.#opts.transport ?? udpTransport)();
    } catch (error) {
      return `not advertised: cannot open ${MDNS_GROUP}:${MDNS_PORT} (${
        error instanceof Error ? error.message : error
      }); run with \`deno task lan\``;
    }
    this.#responder = new MdnsResponder(bridgeRecords(endpoints, address), transport);
    await this.#responder.announce();
    const names = endpoints.map((e) =>
      `${e.node}-${e.port}.${SERVICE_TYPES[e.service]} -> ${hostNameFor(e.node)}:${e.hostPort}`
    );
    return `advertising ${names.join(", ")} at ${address}`;
  }

  async close(): Promise<void> {
    await this.#responder?.close();
    this.#responder = null;
  }
}
