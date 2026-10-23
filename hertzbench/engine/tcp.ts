// A small TCP for stations the engine itself plays on the switch: the mobile
// bridge (Phase 5a), which opens connections to a board's server, and the
// scripted boards, which serve them. A QEMU board's lwIP is on the other end
// of a real run, so the segments are real TCP: checksums over the pseudo
// header, the MSS option, retransmission on a timer, the peer's window, FIN
// in both directions and RST. Frames cross the medium like any other, so the
// channel model's loss turns into retransmissions and its delay into latency.
//
// ponytail: no congestion control, fast retransmit, SACK, window scaling,
// timestamps or TIME_WAIT. A lost segment is recovered by go-back-N on the
// retransmission timer; received data is handed over at once, so the window
// this side advertises is always the maximum. Enough for HTTP, WebSocket and
// MQTT between a phone and a microcontroller; not a general stack.

import type { Clock } from "./clock.ts";
import {
  buildArp,
  buildEthernet,
  ETHERTYPE_IPV4,
  internetChecksum,
  ipToBytes,
  type Ipv4Packet,
  parseArp,
  parseIpv4,
} from "./packet.ts";
import type { Rng } from "./rng.ts";

export const TCP_FLAG = { fin: 0x01, syn: 0x02, rst: 0x04, psh: 0x08, ack: 0x10 } as const;

const IPV4_HEADER_BYTES = 20;
const TCP_HEADER_BYTES = 20;
const TCP_PROTOCOL = 6;
/** What this side accepts per segment: an Ethernet MTU less the IPv4 and TCP headers. */
export const TCP_MSS = 1460;
/** RFC 9293 §3.7.1: the peer's MSS when its SYN carries none. */
const DEFAULT_PEER_MSS = 536;
const MAX_WINDOW = 65535;
/** RFC 6298 §2.1 initial RTO; Linux's floor; the RFC's ceiling. */
const INITIAL_RTO_MS = 1000;
const MIN_RTO_MS = 200;
const MAX_RTO_MS = 60_000;
/** SYN tries before a connect gives up: 1 + 2 + 4 + 8 + 16 s with the initial RTO. */
const MAX_SYN_TRIES = 5;
/** Retransmissions of the same data before the connection is declared dead. */
const MAX_RETRANSMISSIONS = 10;
/** Segments in flight at most, whatever window the peer offers. */
const MAX_IN_FLIGHT_SEGMENTS = 8;
/** `write` resolves once less than this is waiting to be acknowledged. */
const SEND_HIGH_WATER = 64 * 1024;
const FIRST_EPHEMERAL_PORT = 49152;

// ── segments ────────────────────────────────────────────────────────────────

export interface TcpSegment {
  srcPort: number;
  dstPort: number;
  seq: number;
  ack: number;
  flags: number;
  window: number;
  /** The MSS option, read from a SYN; null when absent. */
  mss: number | null;
  payload: Uint8Array;
}

const u32 = (n: number) => n >>> 0;
/** a < b in sequence space (RFC 9293 §3.4). */
const before = (a: number, b: number) => ((a - b) | 0) < 0;
const atOrBefore = (a: number, b: number) => ((a - b) | 0) <= 0;

/** The checksum of a TCP segment (header with a zero checksum field, and payload) over the IPv4 pseudo header. */
export function tcpChecksum(srcIp: string, dstIp: string, segment: Uint8Array): number {
  const pseudo = new Uint8Array(12 + segment.length + (segment.length & 1));
  pseudo.set(ipToBytes(srcIp), 0);
  pseudo.set(ipToBytes(dstIp), 4);
  pseudo[9] = TCP_PROTOCOL;
  pseudo[10] = segment.length >>> 8;
  pseudo[11] = segment.length & 0xff;
  pseudo.set(segment, 12);
  return internetChecksum(pseudo);
}

/** The TCP segment in `frame`; null when it is not TCP, is truncated, or fails its checksum. */
export function parseTcp(frame: Uint8Array, ip: Ipv4Packet): TcpSegment | null {
  if (ip.protocol !== TCP_PROTOCOL) return null;
  const segment = frame.subarray(ip.payloadOffset, ip.payloadEnd);
  if (segment.length < TCP_HEADER_BYTES) return null;
  const view = new DataView(segment.buffer, segment.byteOffset, segment.length);
  const headerBytes = (view.getUint8(12) >>> 4) * 4;
  if (headerBytes < TCP_HEADER_BYTES || headerBytes > segment.length) return null;
  // A correct checksum sums, with the field itself, to zero.
  if (tcpChecksum(ip.src, ip.dst, segment) !== 0) return null;
  let mss: number | null = null;
  for (let i = TCP_HEADER_BYTES; i < headerBytes;) {
    const kind = segment[i] ?? 0;
    if (kind === 0) break;
    if (kind === 1) {
      i++;
      continue;
    }
    const length = segment[i + 1] ?? 0;
    if (length < 2 || i + length > headerBytes) break;
    if (kind === 2 && length === 4) mss = view.getUint16(i + 2);
    i += length;
  }
  return {
    srcPort: view.getUint16(0),
    dstPort: view.getUint16(2),
    seq: view.getUint32(4),
    ack: view.getUint32(8),
    flags: view.getUint8(13) & 0x3f,
    window: view.getUint16(14),
    mss,
    payload: segment.slice(headerBytes),
  };
}

export interface TcpFrameSpec extends Omit<TcpSegment, "mss"> {
  srcMac: string;
  dstMac: string;
  srcIp: string;
  dstIp: string;
  /** The MSS option, for a SYN. */
  mss?: number;
}

/** Ethernet + IPv4 + TCP, every checksum filled in. */
export function buildTcpFrame(spec: TcpFrameSpec): Uint8Array {
  const optionBytes = spec.mss === undefined ? 0 : 4;
  const headerBytes = TCP_HEADER_BYTES + optionBytes;
  const segment = new Uint8Array(headerBytes + spec.payload.length);
  const view = new DataView(segment.buffer);
  view.setUint16(0, spec.srcPort);
  view.setUint16(2, spec.dstPort);
  view.setUint32(4, u32(spec.seq));
  view.setUint32(8, u32(spec.ack));
  view.setUint8(12, (headerBytes / 4) << 4);
  view.setUint8(13, spec.flags);
  view.setUint16(14, spec.window);
  if (spec.mss !== undefined) {
    segment.set([2, 4], TCP_HEADER_BYTES);
    view.setUint16(TCP_HEADER_BYTES + 2, spec.mss);
  }
  segment.set(spec.payload, headerBytes);
  view.setUint16(16, tcpChecksum(spec.srcIp, spec.dstIp, segment));

  const packet = new Uint8Array(IPV4_HEADER_BYTES + segment.length);
  packet[0] = 0x45;
  packet[2] = packet.length >>> 8;
  packet[3] = packet.length & 0xff;
  packet[6] = 0x40; // don't fragment
  packet[8] = 64; // TTL
  packet[9] = TCP_PROTOCOL;
  packet.set(ipToBytes(spec.srcIp), 12);
  packet.set(ipToBytes(spec.dstIp), 16);
  const checksum = internetChecksum(packet.subarray(0, IPV4_HEADER_BYTES));
  packet[10] = checksum >>> 8;
  packet[11] = checksum & 0xff;
  packet.set(segment, IPV4_HEADER_BYTES);
  return buildEthernet(spec.dstMac, spec.srcMac, ETHERTYPE_IPV4, packet);
}

// ── the host ────────────────────────────────────────────────────────────────

export class TcpError extends Error {
  override name = "TcpError";
}

export interface TcpHostOptions {
  mac: string;
  ip: string;
  clock: Clock;
  /** Put a frame on the medium. */
  send(frame: Uint8Array): void;
  /**
   * The MAC to reach an address on the link with; null when unknown. The
   * owner knows its peers (from the scenario, or from the frames they sent);
   * this host answers ARP for its own address but never asks.
   */
  macFor(ip: string): string | null;
  /** Initial sequence numbers and the first ephemeral port. */
  rng: Rng;
}

type State =
  | "syn-sent"
  | "syn-received"
  | "established"
  | "fin-wait-1"
  | "fin-wait-2"
  | "close-wait"
  | "closing"
  | "last-ack"
  | "closed";

export interface TcpEndpoint {
  ip: string;
  port: number;
}

/** One connection. Bytes in and out, half-close with `end`, abort with `abort`. */
export class TcpConnection {
  readonly local: TcpEndpoint;
  readonly remote: TcpEndpoint;
  readonly #host: TcpHost;
  readonly #remoteMac: string;
  #state: State;
  // Send side. #out holds every byte from #sndUna on, sent or not.
  readonly #iss: number;
  #sndUna: number;
  #sndNxt: number;
  /** Highest sequence number sent so far; acks up to it are good after a go-back-N. */
  #sndMax: number;
  #sndWnd = DEFAULT_PEER_MSS;
  #peerMss = DEFAULT_PEER_MSS;
  #out = new Uint8Array(0);
  #finQueued = false;
  /** The FIN is on the wire past #sndNxt's last go-back, or acknowledged. */
  #finSent = false;
  /** Sequence number of our FIN, once sent: writes stop at `end`, so it never moves. */
  #finSeq: number | null = null;
  #finAcked = false;
  // Receive side.
  #rcvNxt = 0;
  // Timers.
  #rtoMs = INITIAL_RTO_MS;
  #srtt: number | null = null;
  #rttvar = 0;
  #rttSample: { seq: number; sentAt: number } | null = null;
  #retransmissions = 0;
  #cancelTimer: (() => void) | null = null;
  // The owner's side.
  #onData: ((bytes: Uint8Array) => void) | null = null;
  #onEnd: (() => void) | null = null;
  #onClose: ((error: TcpError | null) => void) | null = null;
  readonly #inbox: Uint8Array[] = [];
  #peerEnded = false;
  #closedWith: { error: TcpError | null } | null = null;
  #drainWaiters: (() => void)[] = [];
  #established: { resolve: () => void; reject: (e: TcpError) => void } | null = null;
  /** Bytes the peer acknowledged, and bytes it sent, for the bridge's log. */
  bytesSent = 0;
  bytesReceived = 0;

  constructor(
    host: TcpHost,
    local: TcpEndpoint,
    remote: TcpEndpoint,
    remoteMac: string,
    iss: number,
    state: "syn-sent" | "syn-received",
  ) {
    this.#host = host;
    this.local = local;
    this.remote = remote;
    this.#remoteMac = remoteMac;
    this.#iss = iss;
    this.#sndUna = iss;
    this.#sndNxt = iss;
    this.#sndMax = iss;
    this.#state = state;
  }

  get state(): State {
    return this.#state;
  }

  /** Bytes written and not yet acknowledged. */
  get buffered(): number {
    return this.#out.length;
  }

  /** Hand each received chunk to `fn`, starting with anything that arrived before. */
  onData(fn: (bytes: Uint8Array) => void): void {
    this.#onData = fn;
    for (const chunk of this.#inbox.splice(0)) fn(chunk);
  }

  /** The peer sent FIN: it will send nothing more. */
  onEnd(fn: () => void): void {
    this.#onEnd = fn;
    if (this.#peerEnded && this.#inbox.length === 0) fn();
  }

  /** Both directions are done (error null), or the connection was reset or timed out. */
  onClose(fn: (error: TcpError | null) => void): void {
    this.#onClose = fn;
    if (this.#closedWith) fn(this.#closedWith.error);
  }

  /** Queue bytes; resolves when less than 64 KiB waits for acknowledgement. */
  write(bytes: Uint8Array): Promise<void> {
    if (this.#closedWith) return Promise.reject(new TcpError("connection is closed"));
    if (this.#finQueued) return Promise.reject(new TcpError("write after end"));
    if (bytes.length > 0) {
      const joined = new Uint8Array(this.#out.length + bytes.length);
      joined.set(this.#out, 0);
      joined.set(bytes, this.#out.length);
      this.#out = joined;
      this.#pump();
    }
    if (this.#out.length < SEND_HIGH_WATER) return Promise.resolve();
    return new Promise((resolve) => this.#drainWaiters.push(resolve));
  }

  /** Send FIN once everything written so far is sent. */
  end(): void {
    if (this.#finQueued || this.#closedWith) return;
    this.#finQueued = true;
    this.#pump();
  }

  /** Send RST and forget the connection. */
  abort(reason = "aborted"): void {
    if (this.#closedWith) return;
    if (this.#state !== "syn-sent") {
      this.#segment(TCP_FLAG.rst | TCP_FLAG.ack, this.#sndNxt, new Uint8Array(0));
    }
    this.#finish(new TcpError(reason));
  }

  /** Resolves when the three-way handshake completes. */
  established(): Promise<void> {
    if (this.#state !== "syn-sent" && this.#state !== "syn-received") {
      return this.#closedWith?.error ? Promise.reject(this.#closedWith.error) : Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.#established = { resolve, reject };
    });
  }

  /** Active open: send the SYN. */
  open(): void {
    this.#sendSyn();
  }

  /** Passive open: the peer's SYN arrived. */
  accept(syn: TcpSegment): void {
    this.#rcvNxt = u32(syn.seq + 1);
    this.#sndWnd = syn.window;
    this.#peerMss = syn.mss ?? DEFAULT_PEER_MSS;
    this.#sendSyn();
  }

  #sendSyn(): void {
    const flags = this.#state === "syn-sent" ? TCP_FLAG.syn : TCP_FLAG.syn | TCP_FLAG.ack;
    this.#segment(flags, this.#iss, new Uint8Array(0), TCP_MSS);
    this.#sndNxt = u32(this.#iss + 1);
    if (before(this.#sndMax, this.#sndNxt)) this.#sndMax = this.#sndNxt;
    this.#armTimer();
  }

  #segment(flags: number, seq: number, payload: Uint8Array, mss?: number): void {
    const host = this.#host;
    host.sendFrame(buildTcpFrame({
      srcMac: host.mac,
      dstMac: this.#remoteMac,
      srcIp: this.local.ip,
      dstIp: this.remote.ip,
      srcPort: this.local.port,
      dstPort: this.remote.port,
      seq,
      ack: flags & TCP_FLAG.ack ? this.#rcvNxt : 0,
      flags,
      window: MAX_WINDOW,
      payload,
      ...(mss === undefined ? {} : { mss }),
    }));
  }

  #sendAck(): void {
    this.#segment(TCP_FLAG.ack, this.#sndNxt, new Uint8Array(0));
  }

  /** Bytes of #out already sent; the FIN takes a sequence number but is not a byte of #out. */
  #sentBytes(): number {
    const span = u32(this.#sndNxt - this.#sndUna);
    const fin = this.#finSeq;
    const finInSpan = fin !== null && atOrBefore(this.#sndUna, fin) && before(fin, this.#sndNxt);
    return span - (finInSpan ? 1 : 0);
  }

  #pump(): void {
    const sending = this.#state === "established" || this.#state === "close-wait" ||
      this.#state === "fin-wait-1" || this.#state === "last-ack" || this.#state === "closing";
    if (!sending) return;
    const limit = Math.min(this.#sndWnd, MAX_IN_FLIGHT_SEGMENTS * this.#peerMss);
    while (!this.#finSent) {
      const sent = this.#sentBytes();
      const inFlight = u32(this.#sndNxt - this.#sndUna);
      const room = limit - inFlight;
      const unsent = this.#out.length - sent;
      if (unsent > 0 && room > 0) {
        const size = Math.min(unsent, room, this.#peerMss);
        const payload = this.#out.slice(sent, sent + size);
        const last = size === unsent;
        this.#segment(TCP_FLAG.ack | (last ? TCP_FLAG.psh : 0), this.#sndNxt, payload);
        if (this.#rttSample === null && this.#sndNxt === this.#sndMax) {
          this.#rttSample = { seq: u32(this.#sndNxt + size), sentAt: this.#host.now() };
        }
        this.#sndNxt = u32(this.#sndNxt + size);
        if (before(this.#sndMax, this.#sndNxt)) this.#sndMax = this.#sndNxt;
        continue;
      }
      if (unsent === 0 && this.#finQueued) {
        this.#segment(TCP_FLAG.fin | TCP_FLAG.ack, this.#sndNxt, new Uint8Array(0));
        this.#finSeq = this.#sndNxt;
        this.#finSent = true;
        this.#sndNxt = u32(this.#sndNxt + 1);
        if (before(this.#sndMax, this.#sndNxt)) this.#sndMax = this.#sndNxt;
        if (this.#state === "established") this.#state = "fin-wait-1";
        else if (this.#state === "close-wait") this.#state = "last-ack";
      }
      break;
    }
    // A zero window with data waiting needs the timer too: it sends the probe.
    if (this.#sndNxt !== this.#sndUna || this.#out.length > this.#sentBytes()) this.#armTimer();
  }

  #armTimer(): void {
    if (this.#cancelTimer) return;
    const host = this.#host;
    this.#cancelTimer = host.clock.schedule(host.now() + this.#rtoMs, () => {
      this.#cancelTimer = null;
      this.#onTimeout();
    });
  }

  #stopTimer(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
  }

  #onTimeout(): void {
    if (this.#closedWith) return;
    this.#retransmissions++;
    this.#rttSample = null; // Karn: never time a retransmitted segment
    this.#rtoMs = Math.min(this.#rtoMs * 2, MAX_RTO_MS);
    if (this.#state === "syn-sent" || this.#state === "syn-received") {
      if (this.#retransmissions >= MAX_SYN_TRIES) {
        return this.#finish(
          new TcpError(`no answer from ${this.remote.ip}:${this.remote.port}`),
        );
      }
      return this.#sendSyn();
    }
    if (this.#retransmissions > MAX_RETRANSMISSIONS) {
      return this.abort(`${this.remote.ip}:${this.remote.port} stopped acknowledging`);
    }
    if (this.#sndNxt === this.#sndUna && this.#sndWnd === 0 && this.#out.length > 0) {
      // Zero-window probe: one byte past the window.
      this.#segment(TCP_FLAG.ack, this.#sndNxt, this.#out.slice(0, 1));
      this.#sndNxt = u32(this.#sndNxt + 1);
      if (before(this.#sndMax, this.#sndNxt)) this.#sndMax = this.#sndNxt;
      return this.#armTimer();
    }
    // Go back to the first unacknowledged byte and send again from there.
    this.#sndNxt = this.#sndUna;
    this.#finSent = this.#finAcked;
    this.#pump();
  }

  #onAck(ack: number, window: number): void {
    if (before(this.#sndMax, ack)) {
      // Acknowledges something never sent (RFC 9293 §3.10.7.4): answer with an ACK, ignore it.
      this.#sendAck();
      return;
    }
    if (atOrBefore(ack, this.#sndUna)) {
      if (ack === this.#sndUna) this.#sndWnd = window;
      return;
    }
    let acked = u32(ack - this.#sndUna);
    const fin = this.#finSeq;
    const finAcked = !this.#finAcked && fin !== null && atOrBefore(u32(fin + 1), ack);
    if (this.#state === "syn-sent" || this.#state === "syn-received") acked--; // the SYN
    if (finAcked) {
      acked--;
      this.#finAcked = true;
      this.#finSent = true;
    }
    acked = Math.max(0, Math.min(acked, this.#out.length));
    this.#out = this.#out.slice(acked);
    this.bytesSent += acked;
    this.#sndUna = ack;
    if (before(this.#sndNxt, ack)) this.#sndNxt = ack;
    this.#sndWnd = window;
    if (this.#rttSample && atOrBefore(this.#rttSample.seq, ack)) {
      this.#updateRto(this.#host.now() - this.#rttSample.sentAt);
      this.#rttSample = null;
    } else {
      // New data acknowledged: drop the backoff, as Linux does, so one loss does not slow the rest.
      this.#rtoMs = this.#baseRto();
    }
    this.#retransmissions = 0;
    this.#stopTimer();
    if (this.#out.length < SEND_HIGH_WATER) {
      for (const resolve of this.#drainWaiters.splice(0)) resolve();
    }
    if (finAcked) {
      if (this.#state === "fin-wait-1") this.#state = "fin-wait-2";
      else if (this.#state === "closing" || this.#state === "last-ack") return this.#finish(null);
    }
  }

  /** RFC 6298 §2. */
  #updateRto(sampleMs: number): void {
    if (this.#srtt === null) {
      this.#srtt = sampleMs;
      this.#rttvar = sampleMs / 2;
    } else {
      this.#rttvar = 0.75 * this.#rttvar + 0.25 * Math.abs(this.#srtt - sampleMs);
      this.#srtt = 0.875 * this.#srtt + 0.125 * sampleMs;
    }
    this.#rtoMs = this.#baseRto();
  }

  #baseRto(): number {
    if (this.#srtt === null) return INITIAL_RTO_MS;
    return Math.min(MAX_RTO_MS, Math.max(MIN_RTO_MS, this.#srtt + Math.max(1, 4 * this.#rttvar)));
  }

  /** A segment for this connection arrived. */
  receive(seg: TcpSegment): void {
    if (this.#closedWith) return;
    if (seg.flags & TCP_FLAG.rst) {
      // Only a reset inside the window is believed (RFC 5961 §3), or one that answers our SYN.
      const answersSyn = this.#state === "syn-sent" && seg.flags & TCP_FLAG.ack &&
        seg.ack === u32(this.#iss + 1);
      if (answersSyn || (this.#state !== "syn-sent" && seg.seq === this.#rcvNxt)) {
        this.#finish(
          new TcpError(
            this.#state === "syn-sent"
              ? `${this.remote.ip}:${this.remote.port} refused the connection`
              : `${this.remote.ip}:${this.remote.port} reset the connection`,
          ),
        );
      }
      return;
    }
    if (this.#state === "syn-sent") {
      const synAck = (seg.flags & (TCP_FLAG.syn | TCP_FLAG.ack)) === (TCP_FLAG.syn | TCP_FLAG.ack);
      if (!synAck || seg.ack !== u32(this.#iss + 1)) return;
      this.#rcvNxt = u32(seg.seq + 1);
      this.#peerMss = seg.mss ?? DEFAULT_PEER_MSS;
      this.#onAck(seg.ack, seg.window);
      this.#state = "established";
      this.#sendAck();
      this.#established?.resolve();
      this.#established = null;
      this.#pump();
      return;
    }
    if (seg.flags & TCP_FLAG.syn) {
      // A retransmitted SYN or SYN-ACK: our answer was lost. Answer again.
      if (this.#state === "syn-received") this.#sendSyn();
      else this.#sendAck();
      return;
    }
    if (!(seg.flags & TCP_FLAG.ack)) return;
    const wasHandshake = this.#state === "syn-received";
    this.#onAck(seg.ack, seg.window);
    if (this.#closedWith) return;
    if (wasHandshake) {
      if (this.#sndUna !== u32(this.#iss + 1)) return;
      this.#state = "established";
      this.#host.accepted(this);
      this.#established?.resolve();
      this.#established = null;
    }
    this.#receiveData(seg);
    this.#pump();
  }

  #receiveData(seg: TcpSegment): void {
    const fin = (seg.flags & TCP_FLAG.fin) !== 0;
    if (seg.payload.length === 0 && !fin) return;
    const offset = u32(this.#rcvNxt - seg.seq);
    if (before(this.#rcvNxt, seg.seq) || offset > seg.payload.length) {
      // Ahead of what we expect (an earlier segment was lost), or wholly old: re-ACK.
      this.#sendAck();
      return;
    }
    if (this.#peerEnded) {
      this.#sendAck(); // the peer's FIN again: our ACK of it was lost
      return;
    }
    const fresh = seg.payload.subarray(offset);
    if (fresh.length > 0) {
      this.#rcvNxt = u32(this.#rcvNxt + fresh.length);
      this.bytesReceived += fresh.length;
      const copy = fresh.slice();
      if (this.#onData) this.#onData(copy);
      else this.#inbox.push(copy);
    }
    if (fin) {
      this.#rcvNxt = u32(this.#rcvNxt + 1);
      this.#peerEnded = true;
      if (this.#state === "established") this.#state = "close-wait";
      else if (this.#state === "fin-wait-1") this.#state = "closing";
      this.#sendAck();
      if (this.#inbox.length === 0) this.#onEnd?.();
      if (this.#state === "fin-wait-2") this.#finish(null);
      return;
    }
    this.#sendAck();
  }

  #finish(error: TcpError | null): void {
    if (this.#closedWith) return;
    this.#state = "closed";
    this.#stopTimer();
    this.#closedWith = { error };
    this.#host.forget(this);
    if (error) {
      this.#established?.reject(error);
      this.#established = null;
    }
    for (const resolve of this.#drainWaiters.splice(0)) resolve();
    this.#onClose?.(error);
  }
}

const key = (localPort: number, remote: TcpEndpoint) => `${localPort}|${remote.ip}:${remote.port}`;

/** The TCP of one station: its connections, its listeners, and ARP for its own address. */
export class TcpHost {
  readonly mac: string;
  readonly ip: string;
  readonly clock: Clock;
  readonly #opts: TcpHostOptions;
  readonly #connections = new Map<string, TcpConnection>();
  readonly #listeners = new Map<number, (conn: TcpConnection) => void>();
  #nextPort: number;

  constructor(opts: TcpHostOptions) {
    this.mac = opts.mac;
    this.ip = opts.ip;
    this.clock = opts.clock;
    this.#opts = opts;
    this.#nextPort = FIRST_EPHEMERAL_PORT + opts.rng.int(10_000);
  }

  now(): number {
    return this.clock.now();
  }

  sendFrame(frame: Uint8Array): void {
    this.#opts.send(frame);
  }

  /** Open a connection; resolves once established, rejects when refused or unanswered. */
  async connect(ip: string, port: number): Promise<TcpConnection> {
    const mac = this.#opts.macFor(ip);
    if (mac === null) throw new TcpError(`no station with address ${ip} on the medium`);
    let localPort = 0;
    do {
      localPort = this.#nextPort;
      this.#nextPort = this.#nextPort >= 65535 ? FIRST_EPHEMERAL_PORT : this.#nextPort + 1;
    } while (this.#connections.has(key(localPort, { ip, port })));
    const conn = new TcpConnection(
      this,
      { ip: this.ip, port: localPort },
      { ip, port },
      mac,
      this.#iss(),
      "syn-sent",
    );
    this.#connections.set(key(localPort, conn.remote), conn);
    const established = conn.established();
    conn.open();
    await established;
    return conn;
  }

  /** Accept connections to `port`; `onConnection` gets each one once it is established. */
  listen(port: number, onConnection: (conn: TcpConnection) => void): void {
    if (this.#listeners.has(port)) throw new TcpError(`port ${port} is already listening`);
    this.#listeners.set(port, onConnection);
  }

  /** Reset every connection. */
  close(): void {
    for (const conn of [...this.#connections.values()]) conn.abort("the station shut down");
    this.#listeners.clear();
  }

  /** A frame for this station. True when it was ARP for our address or TCP to it. */
  receive(frame: Uint8Array): boolean {
    const arp = parseArp(frame);
    if (arp) {
      if (arp.operation !== 1 || arp.targetIp !== this.ip) return false;
      this.#opts.send(buildArp({
        operation: 2,
        senderMac: this.mac,
        senderIp: this.ip,
        targetMac: arp.senderMac,
        targetIp: arp.senderIp,
      }));
      return true;
    }
    const ip = parseIpv4(frame);
    if (!ip || ip.dst !== this.ip) return false;
    const seg = parseTcp(frame, ip);
    if (!seg) return ip.protocol === TCP_PROTOCOL; // a bad checksum is dropped, as a stack does
    const remote = { ip: ip.src, port: seg.srcPort };
    const conn = this.#connections.get(key(seg.dstPort, remote));
    if (conn) {
      conn.receive(seg);
      return true;
    }
    const onConnection = this.#listeners.get(seg.dstPort);
    const isSyn = (seg.flags & (TCP_FLAG.syn | TCP_FLAG.ack | TCP_FLAG.rst)) === TCP_FLAG.syn;
    const mac = this.#opts.macFor(ip.src);
    if (onConnection && isSyn && mac !== null) {
      const accepted = new TcpConnection(
        this,
        { ip: this.ip, port: seg.dstPort },
        remote,
        mac,
        this.#iss(),
        "syn-received",
      );
      this.#connections.set(key(seg.dstPort, remote), accepted);
      accepted.accept(seg);
      return true;
    }
    if (!(seg.flags & TCP_FLAG.rst) && mac !== null) this.#reset(seg, ip.src, mac);
    return true;
  }

  /** Called by a passive connection when its handshake completes. */
  accepted(conn: TcpConnection): void {
    this.#listeners.get(conn.local.port)?.(conn);
  }

  forget(conn: TcpConnection): void {
    this.#connections.delete(key(conn.local.port, conn.remote));
  }

  #iss(): number {
    return this.#opts.rng.int(2 ** 32) >>> 0;
  }

  /** RFC 9293 §3.10.7.1: the answer to a segment for no connection. */
  #reset(seg: TcpSegment, srcIp: string, srcMac: string): void {
    const hasAck = (seg.flags & TCP_FLAG.ack) !== 0;
    const length = seg.payload.length + (seg.flags & TCP_FLAG.syn ? 1 : 0) +
      (seg.flags & TCP_FLAG.fin ? 1 : 0);
    this.#opts.send(buildTcpFrame({
      srcMac: this.mac,
      dstMac: srcMac,
      srcIp: this.ip,
      dstIp: srcIp,
      srcPort: seg.dstPort,
      dstPort: seg.srcPort,
      seq: hasAck ? seg.ack : 0,
      ack: hasAck ? 0 : u32(seg.seq + length),
      flags: hasAck ? TCP_FLAG.rst : TCP_FLAG.rst | TCP_FLAG.ack,
      window: 0,
      payload: new Uint8Array(0),
    }));
  }
}
