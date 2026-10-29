// A scripted board: NOT firmware and NOT an emulator. It plays the network side
// of a board (DHCP, then UDP datagrams or ESP-NOW frames on a schedule, a pong
// for every ping) over the same QEMU-stream framing a real board uses. Its
// ESP-NOW goes through a model of the QEMU fork's MAC (espnow-fork-model.ts),
// so the frames and ACKs on the wire are the fork's. The adapter, engine,
// metrics, pcap and assertions can run end to end on a machine without libqemu.
// Its `serve` entries are TCP servers (drivers/tcp-services.ts) on the engine's
// small TCP, for the IP bridge to reach.
// Fidelity: none. Use it to develop scenarios and to test the engine; use the
// esp32 board for anything that claims to be about firmware.

import {
  BROADCAST_MAC,
  buildArp,
  buildDhcpClientMessage,
  buildEspNowBody,
  buildUdp,
  createRng,
  DHCPDISCOVER,
  DHCPREQUEST,
  ESPNOW_ACK_TIMEOUT_MS,
  ipToString,
  parseArp,
  parseEspNowBody,
  parseEthernet,
  parseIpv4,
  parseUdp,
  TcpHost,
} from "../../engine/mod.ts";
import { encodeFrame, FrameDecoder, LOOPBACK } from "../../adapters/qemu-wifi-l2/mod.ts";
import { BROADCAST_TARGET } from "../scenario.ts";
import { type BoardContext, BoardError, type BoardLauncher, type RunningBoard } from "./board.ts";
import { EspNowForkModel, type EspNowTxStatus } from "./espnow-fork-model.ts";
import { startScriptedBleBoard } from "./scripted-ble.ts";
import { startScriptedRadioBoard } from "./scripted-radio.ts";
import { MqttBroker, serveHttp } from "./drivers/tcp-services.ts";

const DHCP_RETRY_MS = 1000;
const DHCP_MAX_TRIES = 10;
/**
 * The engine judges an ESP-NOW ACK against the fork's 10 ms from the moment the frame reaches
 * the medium. A scripted board's wait starts at its own send, so it also spends the loopback
 * hop out and the one back (each several ms under load, on the first frame or on a busy CI
 * runner), and a board that waited exactly 10 ms would give up on ACKs the engine counted.
 * The board waits the fork's window plus this allowance: the ACK is then the engine's verdict,
 * and silence still fails the send. ponytail: a fixed allowance, raise it if a runner's hops
 * ever exceed it; the real fix would hand the board the engine's outcome.
 */
const ESPNOW_HOP_ALLOWANCE_MS = 30;
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
  readonly #espnow: EspNowForkModel;
  /** ESP-NOW frames go one at a time, as the driver sends them: the fork has one ACK timer. */
  readonly #espnowQueue: { dst: string; label: string; body: Uint8Array }[] = [];
  #espnowInFlight: string | null = null;
  /** Once bound: the TCP the `serve` entries listen on. */
  #tcp: TcpHost | null = null;
  /** Addresses learned from the frames that arrive, for TCP replies. */
  readonly #neighbors = new Map<string, string>();

  constructor(ctx: BoardContext, conn: Deno.TcpConn, channel: number) {
    this.#ctx = ctx;
    this.#conn = conn;
    this.#xid = Number.parseInt(ctx.node.mac.slice(-2), 16) * 0x10001 + 0xc0de0000;
    this.#espnow = new EspNowForkModel({
      mac: ctx.node.mac,
      channel,
      clock: ctx.clock,
      ackTimeoutMs: ESPNOW_ACK_TIMEOUT_MS + ESPNOW_HOP_ALLOWANCE_MS,
      output: (frame) => this.#send(frame),
      onReceive: (src, _dst, body) => {
        const payload = parseEspNowBody(body);
        const text = payload ? new TextDecoder().decode(payload) : "(not ESP-NOW)";
        ctx.onSerial(`espnow rx ${text} from ${this.#peerName(src)}`);
      },
      onTxDone: (status) => this.#espnowDone(status),
    });
    this.#reading = this.#readLoop();
    this.#discover();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#espnow.stop();
    this.#tcp?.close();
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

  #peerName(mac: string): string {
    return this.#ctx.peers.find((p) => p.mac === mac)?.id ?? mac;
  }

  #espnowSend(dst: string, label: string, body: Uint8Array): void {
    this.#espnowQueue.push({ dst, label, body });
    if (this.#espnowInFlight === null) this.#espnowNext();
  }

  #espnowNext(): void {
    const next = this.#espnowQueue.shift();
    if (!next || this.#stopped) return;
    this.#espnowInFlight = next.label;
    this.#espnow.send(next.dst, next.body);
  }

  #espnowDone(status: EspNowTxStatus): void {
    if (this.#stopped) return;
    if (this.#espnowInFlight === null) {
      // A completion with nothing sent: the fork re-armed its ACK timer for an ACK that came late.
      this.#ctx.onSerial(`espnow tx done (${status}) with nothing in flight`);
      return;
    }
    this.#ctx.onSerial(`espnow tx ${status === "ack" ? "ok" : "fail"} to ${this.#espnowInFlight}`);
    this.#espnowInFlight = null;
    this.#espnowNext();
  }

  #receive(frame: Uint8Array): void {
    if (this.#espnow.receive(frame)) return;
    const ip = parseIpv4(frame);
    const eth = parseEthernet(frame);
    if (ip && eth && ip.src !== "0.0.0.0") this.#neighbors.set(ip.src, eth.src);
    if (this.#tcp?.receive(frame)) return; // it answers ARP for the lease itself when it serves
    if (this.#answerArp(frame)) return;
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

  /** Who-has for the leased address: a guest cannot send to a board that never says where it is. */
  #answerArp(frame: Uint8Array): boolean {
    const arp = parseArp(frame);
    if (!arp || arp.operation !== 1 || this.#ip === null || arp.targetIp !== this.#ip) return false;
    this.#send(buildArp({
      operation: 2,
      senderMac: this.#ctx.node.mac,
      senderIp: this.#ip,
      targetMac: arp.senderMac,
      targetIp: arp.senderIp,
    }));
    return true;
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
      this.#startServers(offered);
      this.#startScript();
    }
  }

  #startServers(ip: string): void {
    const { node, clock } = this.#ctx;
    if (node.firmware.kind !== "script" || node.firmware.serve.length === 0) return;
    const tcp = new TcpHost({
      mac: node.mac,
      ip,
      clock,
      send: (frame) => this.#send(frame),
      macFor: (peer) => this.#neighbors.get(peer) ?? null,
      rng: createRng(`scripted-tcp:${node.id}`),
    });
    const ctx = { node: node.id, onSerial: (line: string) => this.#ctx.onSerial(line) };
    for (const service of node.firmware.serve) {
      if (service.protocol === "http") tcp.listen(service.port, (conn) => serveHttp(conn, ctx));
      else {
        const broker = new MqttBroker(ctx);
        tcp.listen(service.port, (conn) => broker.serve(conn));
      }
      this.#ctx.onSerial(`tcp listening on ${service.port} (${service.protocol})`);
    }
    this.#tcp = tcp;
  }

  #startScript(): void {
    const { node, peers, clock } = this.#ctx;
    if (node.firmware.kind !== "script") return;
    const bound = clock.now();
    for (const send of node.firmware.send) {
      const peer = send.to === BROADCAST_TARGET ? null : peers.find((p) => p.id === send.to);
      if (peer === undefined) {
        this.#ctx.onProblem(`${node.id}: scripted send to unknown peer ${send.to}`);
        continue;
      }
      const transmit = (seq: number) => {
        const payload = new TextEncoder().encode(`${send.payload}:${seq}`);
        if (send.via === "espnow") {
          // The random field of the ESP-NOW header, made from the node and sequence for a stable capture.
          const random = Number.parseInt(node.mac.slice(-2), 16) << 24 | seq;
          this.#espnowSend(
            peer?.mac ?? BROADCAST_MAC,
            peer?.id ?? BROADCAST_TARGET,
            buildEspNowBody(payload, random),
          );
        } else if (peer && this.#ip !== null) {
          this.#send(buildUdp({
            srcMac: node.mac,
            dstMac: peer.mac,
            srcIp: this.#ip,
            dstIp: peer.ip,
            srcPort: send.port,
            dstPort: send.port,
            payload,
          }));
        }
      };
      // One timer at a time: the next one is scheduled when this one goes.
      const sendNext = (seq: number) => {
        transmit(seq);
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
    if (ctx.node.radio.phy === "ble") return await startScriptedBleBoard(ctx, ctx.netPort);
    if (ctx.node.radio.phy !== "wifi") return await startScriptedRadioBoard(ctx, ctx.netPort);
    const conn = await Deno.connect({ hostname: LOOPBACK, port: ctx.netPort });
    conn.setNoDelay(true);
    return new ScriptedBoard(ctx, conn, ctx.node.radio.channel);
  },
};
