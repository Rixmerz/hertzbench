// A scripted board: NOT firmware and NOT an emulator. It plays the network side
// of a board (DHCP, then UDP datagrams on a schedule, a pong for every ping)
// over the same QEMU-stream framing a real board uses, so the adapter, engine,
// metrics, pcap and assertions can run end to end on a machine without libqemu.
// Fidelity: none. Use it to develop scenarios and to test the engine; use the
// esp32 board for anything that claims to be about firmware.

import {
  buildDhcpClientMessage,
  buildUdp,
  DHCPDISCOVER,
  DHCPREQUEST,
  ipToString,
  parseIpv4,
  parseUdp,
} from "../../engine/mod.ts";
import { encodeFrame, FrameDecoder, LOOPBACK } from "../../adapters/qemu-wifi-l2/mod.ts";
import { type BoardContext, BoardError, type BoardLauncher, type RunningBoard } from "./board.ts";
import { startScriptedRadioBoard } from "./scripted-radio.ts";

const DHCP_RETRY_MS = 1000;
const DHCP_MAX_TRIES = 10;
const DHCPOFFER = 2;
const DHCPACK = 5;

function dhcpMessageType(bootp: Uint8Array): number {
  let i = 240;
  while (i + 1 < bootp.length && bootp[i] !== 255) {
    if (bootp[i] === 0) {
      i++;
      continue;
    }
    if (bootp[i] === 53) return bootp[i + 2] ?? 0;
    i += 2 + (bootp[i + 1] ?? 0);
  }
  return 0;
}

class ScriptedBoard implements RunningBoard {
  readonly clockDescription = "wall clock (scripted board, no guest time)";
  readonly #ctx: BoardContext;
  readonly #conn: Deno.TcpConn;
  readonly #decoder = new FrameDecoder();
  readonly #cancels = new Set<() => void>();
  readonly #reading: Promise<void>;
  readonly #xid: number;
  #writes: Promise<void> = Promise.resolve();
  #ip: string | null = null;
  #stopped = false;
  #dhcpTries = 0;

  constructor(ctx: BoardContext, conn: Deno.TcpConn) {
    this.#ctx = ctx;
    this.#conn = conn;
    this.#xid = Number.parseInt(ctx.node.mac.slice(-2), 16) * 0x10001 + 0xc0de0000;
    this.#reading = this.#readLoop();
    this.#discover();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const cancel of this.#cancels) cancel();
    this.#cancels.clear();
    try {
      this.#conn.close();
    } catch {
      // The adapter may have closed it first on shutdown.
    }
    await this.#reading;
    await this.#writes;
  }

  #schedule(atMs: number, fn: () => void): void {
    const cancel = this.#ctx.clock.schedule(atMs, () => {
      this.#cancels.delete(cancel);
      if (!this.#stopped) fn();
    });
    this.#cancels.add(cancel);
  }

  #send(frame: Uint8Array): void {
    const bytes = encodeFrame(frame);
    this.#writes = this.#writes.then(async () => {
      try {
        let written = 0;
        while (written < bytes.length) written += await this.#conn.write(bytes.subarray(written));
      } catch {
        // The adapter closed the connection while the run was ending.
      }
    });
  }

  #discover(): void {
    if (this.#ip !== null || this.#stopped) return;
    if (++this.#dhcpTries > DHCP_MAX_TRIES) {
      this.#ctx.onProblem(`${this.#ctx.node.id}: no DHCP answer after ${DHCP_MAX_TRIES} tries`);
      return;
    }
    this.#send(buildDhcpClientMessage(this.#ctx.node.mac, DHCPDISCOVER, this.#xid));
    this.#schedule(this.#ctx.clock.now() + DHCP_RETRY_MS, () => this.#discover());
  }

  async #readLoop(): Promise<void> {
    const buffer = new Uint8Array(65536);
    try {
      for (;;) {
        const n = await this.#conn.read(buffer);
        if (n === null) return;
        for (const frame of this.#decoder.push(buffer.subarray(0, n))) this.#receive(frame);
      }
    } catch {
      // Closed by stop() or by the adapter at the end of the run.
    }
  }

  #receive(frame: Uint8Array): void {
    const ip = parseIpv4(frame);
    if (!ip) return;
    const udp = parseUdp(frame, ip);
    if (!udp) return;
    if (udp.srcPort === 67 && udp.dstPort === 68) return this.#onDhcp(udp.payload);
    if (this.#ip === null || ip.dst !== this.#ip) return;
    const text = new TextDecoder().decode(udp.payload);
    const peer = this.#ctx.peers.find((p) => p.ip === ip.src);
    this.#ctx.onSerial(`rx ${text} from ${peer?.id ?? ip.src}`);
    if (text.startsWith("ping") && peer) {
      this.#send(buildUdp({
        srcMac: this.#ctx.node.mac,
        dstMac: peer.mac,
        srcIp: this.#ip,
        dstIp: peer.ip,
        srcPort: udp.dstPort,
        dstPort: udp.srcPort,
        payload: new TextEncoder().encode(`pong${text.slice(4)}`),
      }));
    }
  }

  #onDhcp(bootp: Uint8Array): void {
    if (
      bootp.length < 244 || new DataView(bootp.buffer, bootp.byteOffset).getUint32(4) !== this.#xid
    ) {
      return; // not an answer to this board's request
    }
    const type = dhcpMessageType(bootp);
    const offered = ipToString(bootp, 16);
    if (type === DHCPOFFER && this.#ip === null) {
      this.#send(buildDhcpClientMessage(this.#ctx.node.mac, DHCPREQUEST, this.#xid, offered));
    } else if (type === DHCPACK && this.#ip === null) {
      this.#ip = offered;
      this.#ctx.onSerial(`dhcp bound ip=${offered}`);
      this.#startScript();
    }
  }

  #startScript(): void {
    const { node, peers, clock } = this.#ctx;
    if (node.firmware.kind !== "script") return;
    const bound = clock.now();
    for (const send of node.firmware.send) {
      const peer = peers.find((p) => p.id === send.to);
      if (!peer) {
        this.#ctx.onProblem(`${node.id}: scripted send to unknown peer ${send.to}`);
        continue;
      }
      // One timer at a time: the next datagram is scheduled when this one goes.
      const sendNext = (seq: number) => {
        if (this.#ip === null) return;
        this.#send(buildUdp({
          srcMac: node.mac,
          dstMac: peer.mac,
          srcIp: this.#ip,
          dstIp: peer.ip,
          srcPort: send.port,
          dstPort: send.port,
          payload: new TextEncoder().encode(`${send.payload}:${seq}`),
        }));
        if (seq + 1 < send.count) {
          this.#schedule(bound + send.startMs + (seq + 1) * send.everyMs, () => sendNext(seq + 1));
        }
      };
      this.#schedule(bound + send.startMs, () => sendNext(0));
    }
  }
}

export const scriptedLauncher: BoardLauncher = {
  fidelity: "none: scripted traffic generator, not firmware",
  async start(ctx) {
    if (ctx.netPort === null) {
      throw new BoardError(`${ctx.node.id}: a scripted board needs a medium port`);
    }
    if (ctx.node.radio.phy !== "wifi") return await startScriptedRadioBoard(ctx, ctx.netPort);
    const conn = await Deno.connect({ hostname: LOOPBACK, port: ctx.netPort });
    conn.setNoDelay(true);
    return new ScriptedBoard(ctx, conn);
  },
};
