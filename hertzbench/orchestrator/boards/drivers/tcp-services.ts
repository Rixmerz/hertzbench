// The TCP servers a scripted Wi-Fi board runs (`firmware.serve`), so the IP
// bridge has something real to reach without libqemu: NOT firmware.
//
// - http: answers every request with a line naming the node, the method and
//   the path, then closes, as a small ESP32 web server does; a request with
//   `Upgrade: websocket` becomes a WebSocket (RFC 6455) that echoes each text
//   or binary message.
// - mqtt: a broker for MQTT 3.1.1 at QoS 0: CONNECT, SUBSCRIBE (with + and #),
//   UNSUBSCRIBE, PUBLISH fanned out to every matching subscription, PINGREQ
//   and DISCONNECT. A QoS 1 PUBLISH is acknowledged and delivered at QoS 0.
//   No retained messages, no will, no sessions.
//
// Serial lines, for `serial:` assertions:
//   http <METHOD> <path> from <ip>
//   ws open <path> from <ip> / ws rx "<text>" from <ip> / ws closed from <ip>
//   mqtt connect <client id> from <ip> / mqtt subscribe <filter> from <client id>
//   mqtt publish <topic> "<payload>" from <client id>

import type { TcpConnection } from "../../../engine/mod.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC11B65";
/** A request head larger than this is refused rather than buffered. */
const MAX_HEAD_BYTES = 8192;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Sec-WebSocket-Accept for a Sec-WebSocket-Key (RFC 6455 §4.2.2). */
export async function websocketAccept(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", encoder.encode(key + WEBSOCKET_GUID));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

/** One WebSocket frame from the server: never masked (RFC 6455 §5.1). */
export function websocketFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const n = payload.length;
  const head = n < 126
    ? [0x80 | opcode, n]
    : n < 65536
    ? [0x80 | opcode, 126, n >>> 8, n & 0xff]
    : [
      0x80 | opcode,
      127,
      0,
      0,
      0,
      0,
      (n >>> 24) & 0xff,
      (n >>> 16) & 0xff,
      (n >>> 8) & 0xff,
      n & 0xff,
    ];
  return concat(Uint8Array.from(head), payload);
}

interface WsFrame {
  fin: boolean;
  opcode: number;
  payload: Uint8Array;
  size: number;
}

/** The first complete frame in `buf`, unmasked; null until it has all arrived. */
export function parseWebsocketFrame(buf: Uint8Array): WsFrame | null {
  if (buf.length < 2) return null;
  const b0 = buf[0] as number;
  const b1 = buf[1] as number;
  let length = b1 & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buf.length < 4) return null;
    length = ((buf[2] as number) << 8) | (buf[3] as number);
    offset = 4;
  } else if (length === 127) {
    if (buf.length < 10) return null;
    length = new DataView(buf.buffer, buf.byteOffset + 2, 8).getUint32(4);
    offset = 10;
  }
  const masked = (b1 & 0x80) !== 0;
  const mask = masked ? buf.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;
  if (buf.length < offset + length) return null;
  const payload = buf.slice(offset, offset + length);
  if (mask) { for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4] as number; }
  return { fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload, size: offset + length };
}

export interface ServiceContext {
  node: string;
  onSerial(line: string): void;
}

/** Serve one HTTP connection: one response, or a WebSocket echo after an upgrade. */
export function serveHttp(conn: TcpConnection, ctx: ServiceContext): void {
  const peer = conn.remote.ip;
  let buffer: Uint8Array = new Uint8Array(0);
  let websocket = false;
  let answered = false;
  const fail = () => conn.abort("bad request");
  conn.onData((chunk) => {
    buffer = concat(buffer, chunk);
    if (websocket) return void echoFrames();
    if (answered) return;
    const text = decoder.decode(buffer);
    const end = text.indexOf("\r\n\r\n");
    if (end < 0) {
      if (buffer.length > MAX_HEAD_BYTES) fail();
      return;
    }
    const [requestLine = "", ...headerLines] = text.slice(0, end).split("\r\n");
    const [method = "", path = ""] = requestLine.split(" ");
    const headers = new Map(headerLines.map((line) => {
      const colon = line.indexOf(":");
      return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
    }));
    const key = headers.get("sec-websocket-key");
    if (headers.get("upgrade")?.toLowerCase() === "websocket" && key) {
      answered = true;
      websocket = true;
      buffer = buffer.slice(encoder.encode(text.slice(0, end + 4)).length);
      ctx.onSerial(`ws open ${path} from ${peer}`);
      void websocketAccept(key).then((accept) =>
        conn.write(encoder.encode(
          "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        ))
      ).then(echoFrames).catch(() => {});
      return;
    }
    const bodyBytes = Number(headers.get("content-length") ?? 0);
    const headBytes = encoder.encode(text.slice(0, end + 4)).length;
    if (buffer.length < headBytes + bodyBytes) return;
    answered = true;
    ctx.onSerial(`http ${method} ${path} from ${peer}`);
    const body = encoder.encode(`${ctx.node}: ${method} ${path}\n`);
    void conn.write(concat(
      encoder.encode(
        `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\n` +
          "Connection: close\r\n\r\n",
      ),
      body,
    )).then(() => conn.end()).catch(() => {});
  });
  conn.onEnd(() => {
    if (websocket) ctx.onSerial(`ws closed from ${peer}`);
    conn.end();
  });

  function echoFrames(): void {
    for (;;) {
      const frame = parseWebsocketFrame(buffer);
      if (!frame) return;
      buffer = buffer.slice(frame.size);
      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        if (frame.opcode === 0x1) {
          ctx.onSerial(`ws rx "${decoder.decode(frame.payload)}" from ${peer}`);
        }
        void conn.write(websocketFrame(frame.opcode, frame.payload)).catch(() => {});
      } else if (frame.opcode === 0x9) {
        void conn.write(websocketFrame(0xa, frame.payload)).catch(() => {});
      } else if (frame.opcode === 0x8) {
        ctx.onSerial(`ws closed from ${peer}`);
        void conn.write(websocketFrame(0x8, frame.payload.slice(0, 2))).then(() => conn.end())
          .catch(() => {});
        return;
      }
    }
  }
}

// ── MQTT ────────────────────────────────────────────────────────────────────

const MQTT = {
  connect: 1,
  connack: 2,
  publish: 3,
  puback: 4,
  subscribe: 8,
  suback: 9,
  unsubscribe: 10,
  unsuback: 11,
  pingreq: 12,
  pingresp: 13,
  disconnect: 14,
} as const;

/** `+` matches one level, a trailing `#` any number (MQTT 3.1.1 §4.7). */
export function mqttTopicMatches(filter: string, topic: string): boolean {
  const f = filter.split("/");
  const t = topic.split("/");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return i === f.length - 1;
    if (i >= t.length) return false;
    if (f[i] !== "+" && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

function remainingLength(n: number): number[] {
  const out: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return out;
}

export function mqttPacket(type: number, flags: number, body: ArrayLike<number>): Uint8Array {
  return Uint8Array.from([
    (type << 4) | flags,
    ...remainingLength(body.length),
    ...Array.from(body),
  ]);
}

function mqttString(text: string): number[] {
  const bytes = encoder.encode(text);
  return [bytes.length >>> 8, bytes.length & 0xff, ...bytes];
}

export function mqttPublish(topic: string, payload: Uint8Array): Uint8Array {
  return mqttPacket(MQTT.publish, 0, [...mqttString(topic), ...payload]);
}

/** The first complete packet in `buf`; null until it has all arrived. */
export function parseMqttPacket(
  buf: Uint8Array,
): { type: number; flags: number; body: Uint8Array; size: number } | null {
  if (buf.length < 2) return null;
  let length = 0;
  let multiplier = 1;
  let i = 1;
  for (;; i++) {
    if (i >= buf.length || i > 4) return null;
    const byte = buf[i] as number;
    length += (byte & 0x7f) * multiplier;
    multiplier *= 128;
    if ((byte & 0x80) === 0) break;
  }
  const start = i + 1;
  if (buf.length < start + length) return null;
  return {
    type: (buf[0] as number) >>> 4,
    flags: (buf[0] as number) & 0x0f,
    body: buf.slice(start, start + length),
    size: start + length,
  };
}

function readString(body: Uint8Array, offset: number): [string, number] {
  const length = ((body[offset] ?? 0) << 8) | (body[offset + 1] ?? 0);
  return [decoder.decode(body.subarray(offset + 2, offset + 2 + length)), offset + 2 + length];
}

interface MqttSession {
  conn: TcpConnection;
  clientId: string;
  filters: Set<string>;
}

/** One broker per node, shared by every connection to its MQTT port. */
export class MqttBroker {
  readonly #sessions = new Set<MqttSession>();
  readonly #ctx: ServiceContext;

  constructor(ctx: ServiceContext) {
    this.#ctx = ctx;
  }

  serve(conn: TcpConnection): void {
    const session: MqttSession = { conn, clientId: "", filters: new Set() };
    let buffer: Uint8Array = new Uint8Array(0);
    let connected = false;
    const send = (packet: Uint8Array) => void conn.write(packet).catch(() => {});
    conn.onData((chunk) => {
      buffer = concat(buffer, chunk);
      for (;;) {
        const packet = parseMqttPacket(buffer);
        if (!packet) return;
        buffer = buffer.slice(packet.size);
        if (!connected && packet.type !== MQTT.connect) return conn.abort("MQTT without CONNECT");
        this.#handle(session, packet, send, () => {
          connected = true;
          this.#sessions.add(session);
        });
      }
    });
    conn.onEnd(() => conn.end());
    conn.onClose(() => this.#sessions.delete(session));
  }

  #handle(
    session: MqttSession,
    packet: { type: number; flags: number; body: Uint8Array },
    send: (packet: Uint8Array) => void,
    onConnect: () => void,
  ): void {
    const { body } = packet;
    switch (packet.type) {
      case MQTT.connect: {
        const [protocol, afterName] = readString(body, 0);
        // Level at afterName, flags, keep-alive (2 bytes), then the client id.
        const [clientId] = readString(body, afterName + 4);
        if (protocol !== "MQTT" || body[afterName] !== 4) {
          send(mqttPacket(MQTT.connack, 0, [0, 0x01])); // unacceptable protocol version
          session.conn.end();
          return;
        }
        session.clientId = clientId || `client-${session.conn.remote.port}`;
        onConnect();
        this.#ctx.onSerial(`mqtt connect ${session.clientId} from ${session.conn.remote.ip}`);
        send(mqttPacket(MQTT.connack, 0, [0, 0]));
        return;
      }
      case MQTT.publish: {
        const qos = (packet.flags >>> 1) & 0x03;
        const [topic, afterTopic] = readString(body, 0);
        const payloadStart = qos > 0 ? afterTopic + 2 : afterTopic;
        const payload = body.slice(payloadStart);
        if (qos === 1) send(mqttPacket(MQTT.puback, 0, body.subarray(afterTopic, afterTopic + 2)));
        this.#ctx.onSerial(
          `mqtt publish ${topic} "${decoder.decode(payload)}" from ${session.clientId}`,
        );
        for (const other of this.#sessions) {
          if ([...other.filters].some((filter) => mqttTopicMatches(filter, topic))) {
            void other.conn.write(mqttPublish(topic, payload)).catch(() => {});
          }
        }
        return;
      }
      case MQTT.subscribe:
      case MQTT.unsubscribe: {
        const granted: number[] = [];
        let offset = 2;
        while (offset < body.length) {
          const [filter, next] = readString(body, offset);
          offset = next;
          if (packet.type === MQTT.subscribe) {
            offset++; // requested QoS: everything is delivered at 0
            session.filters.add(filter);
            granted.push(0);
            this.#ctx.onSerial(`mqtt subscribe ${filter} from ${session.clientId}`);
          } else {
            session.filters.delete(filter);
          }
        }
        const id = [body[0] ?? 0, body[1] ?? 0];
        send(
          packet.type === MQTT.subscribe
            ? mqttPacket(MQTT.suback, 0, [...id, ...granted])
            : mqttPacket(MQTT.unsuback, 0, id),
        );
        return;
      }
      case MQTT.pingreq:
        send(mqttPacket(MQTT.pingresp, 0, []));
        return;
      case MQTT.disconnect:
        session.conn.end();
        return;
    }
  }
}
