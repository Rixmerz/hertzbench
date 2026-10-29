// A scripted board: NOT firmware and NOT an emulator. It plays the network side
// of a board (DHCP, then UDP datagrams or ESP-NOW frames on a schedule, a pong
// for every ping) over the same QEMU-stream framing a real board uses. Its
// ESP-NOW goes through a model of the QEMU fork's MAC (espnow-fork-model.ts),
// so the frames and ACKs on the wire are the fork's. The adapter, engine,
// metrics, pcap and assertions can run end to end on a machine without libqemu.
// Its `serve` entries are TCP servers (drivers/tcp-services.ts) on the engine's
// small TCP, for the IP bridge to reach; its `via: mqtt` sends and `subscribe` entries make it an
// MQTT client of a broker node over the same TCP.
// Fidelity: none. Use it to develop scenarios and to test the engine; use the
// esp32 board for anything that claims to be about firmware.

import {
  BROADCAST_MAC,
  buildDhcpClientMessage,
  buildEspNowBody,
  buildUdp,
  createRng,
  DHCPDISCOVER,
  DHCPREQUEST,
  ESPNOW_ACK_TIMEOUT_MS,
  ESPNOW_MAX_PAYLOAD_BYTES,
  ipToString,
  parseEspNowBody,
  parseEthernet,
  parseIpv4,
  parseUdp,
  TcpHost,
} from "../../engine/mod.ts";
import { encodeFrame, FrameDecoder, LOOPBACK } from "../../adapters/qemu-wifi-l2/mod.ts";
import { BROADCAST_TARGET, type ScriptedSend } from "../scenario.ts";
import {
  type BoardContext,
  BoardError,
  type BoardLauncher,
  type LiveMqttPublish,
  type LiveSend,
  type PeerInfo,
  type RunningBoard,
} from "./board.ts";
import { EspNowForkModel, type EspNowTxStatus } from "./espnow-fork-model.ts";
import { startScriptedBleBoard } from "./scripted-ble.ts";
import { startScriptedRadioBoard } from "./scripted-radio.ts";
import { MqttBroker, MqttClient, serveHttp } from "./drivers/tcp-services.ts";

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
/** How long a live MQTT send waits for a session it had to open: a few reconnect rounds. */
const MQTT_LIVE_SESSION_WAIT_MS = 5000;
/** Largest UDP payload one Ethernet frame carries (1500 minus the IP and UDP headers). */
const UDP_MAX_PAYLOAD_BYTES = 1472;
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
  /** Once bound: the TCP the `serve` entries listen on and the MQTT clients connect from. */
  #tcp: TcpHost | null = null;
  /** The brokers this board runs, by port, once its lease has started them. */
  readonly #brokers = new Map<number, MqttBroker>();
  /** ESP-NOW header field for live sends, kept clear of the ones scheduled sends derive. */
  #liveRandom = 0x800000;
  /** One MQTT session per broker (node and port), shared by the sends and subscriptions to it. */
  readonly #mqtt = new Map<string, { client: MqttClient; onFirstUp: (() => void)[] }>();
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
    for (const { client } of this.#mqtt.values()) client.stop();
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
    if (this.#tcp?.receive(frame)) return;
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
      this.#startTcp(offered);
      this.#startScript();
    }
  }

  #startTcp(ip: string): void {
    const { node } = this.#ctx;
    if (node.firmware.kind !== "script") return;
    const { serve, send, subscribe } = node.firmware;
    if (serve.length === 0 && subscribe.length === 0 && !send.some((s) => s.via === "mqtt")) return;
    const tcp = this.#openTcp(ip);
    const ctx = { node: node.id, onSerial: (line: string) => this.#ctx.onSerial(line) };
    for (const service of serve) {
      if (service.protocol === "http") tcp.listen(service.port, (conn) => serveHttp(conn, ctx));
      else {
        const broker = new MqttBroker(ctx);
        this.#brokers.set(service.port, broker);
        tcp.listen(service.port, (conn) => broker.serve(conn));
      }
      this.#ctx.onSerial(`tcp listening on ${service.port} (${service.protocol})`);
    }
  }

  /** The board's TCP, bound to its lease; made when a service or a client first needs it. */
  #openTcp(ip: string): TcpHost {
    const { node, clock } = this.#ctx;
    this.#tcp ??= new TcpHost({
      mac: node.mac,
      ip,
      clock,
      send: (frame) => this.#send(frame),
      // A client may dial a broker before any frame from it has arrived: the scenario knows its MAC.
      macFor: (peer) =>
        this.#neighbors.get(peer) ?? this.#ctx.peers.find((p) => p.ip === peer)?.mac ?? null,
      rng: createRng(`scripted-tcp:${node.id}`),
    });
    return this.#tcp;
  }

  /**
   * The client for a broker, made and started on first use: it dials as soon as the board has its
   * lease and again whenever the session drops. `onFirstUp` runs the first time it is up.
   */
  #mqttClient(to: string, port: number, onFirstUp?: () => void) {
    const { node, clock, peers } = this.#ctx;
    const key = `${to}:${port}`;
    let entry = this.#mqtt.get(key);
    if (entry === undefined) {
      const peer = peers.find((p) => p.id === to);
      const tcp = this.#tcp;
      if (peer === undefined || tcp === null) {
        this.#ctx.onProblem(`${node.id}: MQTT broker ${to} is not a known peer`);
        return null;
      }
      const subscribe = node.firmware.kind === "script" ? node.firmware.subscribe : [];
      const pending: (() => void)[] = [];
      let up = false;
      const client = new MqttClient({
        clientId: node.id,
        filters: subscribe.filter((s) => s.to === to && s.port === port).map((s) => s.topic),
        clock,
        connect: () => tcp.connect(peer.ip, port),
        onMessage: (topic, payload) =>
          this.#ctx.onSerial(`mqtt rx ${topic} ${new TextDecoder().decode(payload)}`),
        onState: (connected) => {
          this.#ctx.onSerial(`mqtt ${connected ? "connected to" : "disconnected from"} ${to}`);
          if (connected && !up) {
            up = true;
            for (const fn of pending.splice(0)) fn();
          }
        },
      });
      entry = { client, onFirstUp: pending };
      this.#mqtt.set(key, entry);
      client.start();
    }
    if (onFirstUp) entry.onFirstUp.push(onFirstUp);
    return entry.client;
  }

  #startScript(): void {
    const { node, peers, clock } = this.#ctx;
    if (node.firmware.kind !== "script") return;
    const bound = clock.now();
    for (const send of node.firmware.send) {
      if (send.via === "mqtt") {
        this.#startMqttPublisher(send);
        continue;
      }
      const peer = send.to === BROADCAST_TARGET ? null : peers.find((p) => p.id === send.to);
      if (peer === undefined) {
        this.#ctx.onProblem(`${node.id}: scripted send to unknown peer ${send.to}`);
        continue;
      }
      const transmit = (seq: number) => {
        const payload = new TextEncoder().encode(`${send.payload}:${seq}`);
        if (send.via === "espnow") {
          // The random field of the ESP-NOW header, made from the node and sequence for a stable capture.
          this.#sendEspNow(peer, payload, Number.parseInt(node.mac.slice(-2), 16) << 24 | seq);
        } else if (peer) {
          this.#sendUdp(peer, send.port, payload);
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
    this.#startMqttSubscriptions();
  }

  #sendEspNow(peer: PeerInfo | null, payload: Uint8Array, random: number): void {
    this.#espnowSend(
      peer?.mac ?? BROADCAST_MAC,
      peer?.id ?? BROADCAST_TARGET,
      buildEspNowBody(payload, random),
    );
  }

  /** A datagram from this board's lease; nothing goes before it has one. */
  #sendUdp(peer: PeerInfo, port: number, payload: Uint8Array): void {
    if (this.#ip === null) return;
    this.#send(buildUdp({
      srcMac: this.#ctx.node.mac,
      dstMac: peer.mac,
      srcIp: this.#ip,
      dstIp: peer.ip,
      srcPort: port,
      dstPort: port,
      payload,
    }));
  }

  publishMqtt({ topic, payload, retain, port }: LiveMqttPublish): number {
    const { node } = this.#ctx;
    const served = node.firmware.kind === "script"
      ? node.firmware.serve.filter((s) => s.protocol === "mqtt").map((s) => s.port)
      : [];
    if (served.length === 0) {
      throw new BoardError(
        `${node.id} serves no MQTT broker: its firmware needs serve: [{ port: 1883, protocol: mqtt }]`,
      );
    }
    const chosen = port ?? (served.length === 1 ? served[0] : undefined);
    if (chosen === undefined) {
      throw new BoardError(`${node.id} serves MQTT on ports ${served.join(", ")}: give port`);
    }
    if (!served.includes(chosen)) {
      throw new BoardError(
        `${node.id} serves no MQTT broker on port ${chosen} (its MQTT ports: ${served.join(", ")})`,
      );
    }
    const broker = this.#brokers.get(chosen);
    if (broker === undefined) {
      throw new BoardError(
        `${node.id}'s broker is not up: the board has no DHCP lease yet, so nothing is listening`,
      );
    }
    return broker.publish(topic, payload, retain, "mcp");
  }

  async sendPayload(send: LiveSend): Promise<void> {
    const { node, peers } = this.#ctx;
    if (send.via === "gatt") {
      throw new BoardError(`${node.id} is a Wi-Fi board: it sends udp, espnow or mqtt, not gatt`);
    }
    const peer = send.to === BROADCAST_TARGET ? null : peers.find((p) => p.id === send.to);
    if (peer === undefined) {
      throw new BoardError(`${node.id}: ${send.to} is not a node on its medium`);
    }
    if (send.via === "espnow") {
      if (send.payload.length > ESPNOW_MAX_PAYLOAD_BYTES) {
        throw new BoardError(
          `an ESP-NOW payload carries at most ${ESPNOW_MAX_PAYLOAD_BYTES} bytes, got ${send.payload.length}`,
        );
      }
      this.#sendEspNow(
        peer,
        send.payload,
        (Number.parseInt(node.mac.slice(-2), 16) << 24) | this.#liveRandom++,
      );
      return;
    }
    if (peer === null) throw new BoardError(`"${BROADCAST_TARGET}" needs via: espnow`);
    if (this.#ip === null) {
      throw new BoardError(`${node.id} has no DHCP lease yet: it cannot send over IP`);
    }
    if (send.via === "udp") {
      if (send.payload.length > UDP_MAX_PAYLOAD_BYTES) {
        throw new BoardError(
          `a UDP payload carries at most ${UDP_MAX_PAYLOAD_BYTES} bytes in one frame, got ${send.payload.length}`,
        );
      }
      this.#sendUdp(peer, send.port, send.payload);
      return;
    }
    await this.#publishAsClient(this.#ip, peer, send.port, send.topic as string, send.payload);
  }

  /**
   * Publishes through this board's MQTT session to a broker. A session the script already holds is
   * used as it is; one this call opens is waited for, since the first send would otherwise always
   * race the handshake.
   */
  async #publishAsClient(
    ip: string,
    broker: PeerInfo,
    port: number,
    topic: string,
    payload: Uint8Array,
  ): Promise<void> {
    const fresh = !this.#mqtt.has(`${broker.id}:${port}`);
    this.#openTcp(ip);
    let up = () => {};
    const opened = new Promise<void>((resolve) => (up = resolve));
    const client = this.#mqttClient(broker.id, port, fresh ? up : undefined);
    if (client === null) {
      throw new BoardError(`${this.#ctx.node.id} cannot open an MQTT session to ${broker.id}`);
    }
    if (fresh) {
      let giveUp: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        giveUp = setTimeout(resolve, MQTT_LIVE_SESSION_WAIT_MS);
      });
      await Promise.race([opened, timeout]).finally(() => clearTimeout(giveUp));
    }
    if (!client.publish(topic, payload)) {
      throw new BoardError(
        `${this.#ctx.node.id} is not connected to the broker ${broker.id}:${port}; ` +
          (fresh ? "its session did not come up" : "its session is down and reconnecting"),
      );
    }
  }

  #startMqttSubscriptions(): void {
    const { node } = this.#ctx;
    if (node.firmware.kind !== "script") return;
    for (const sub of node.firmware.subscribe) {
      this.#mqttClient(sub.to, sub.port);
    }
  }

  /**
   * Publishes `topic` to the broker every `everyMs`, cycling through the payloads as given (no
   * sequence suffix). The schedule starts when the session first comes up, so `start` counts from
   * the connection and the first publish is not lost to the handshake; one that falls while the
   * session is down is skipped and logged.
   */
  #startMqttPublisher(send: ScriptedSend): void {
    if (send.to === null || send.topic === undefined) return;
    const topic = send.topic;
    const payloads = send.payloads ?? [send.payload];
    const publish = (seq: number) => {
      const payload = payloads[seq % payloads.length] as string;
      const sent = this.#mqtt.get(`${send.to}:${send.port}`)?.client.publish(
        topic,
        new TextEncoder().encode(payload),
      );
      if (!sent) this.#ctx.onSerial(`mqtt tx ${topic} skipped: not connected to ${send.to}`);
    };
    const publishNext = (seq: number, firstAtMs: number) => {
      publish(seq);
      if (seq + 1 < send.count) {
        this.#schedule(
          firstAtMs + (seq + 1) * send.everyMs,
          () => publishNext(seq + 1, firstAtMs),
        );
      }
    };
    this.#mqttClient(send.to, send.port, () => {
      const firstAtMs = this.#ctx.clock.now() + send.startMs;
      this.#schedule(firstAtMs, () => publishNext(0, firstAtMs));
    });
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
