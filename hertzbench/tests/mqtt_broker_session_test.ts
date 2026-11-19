// The scripted MQTT broker's session rules, on a hand-driven clock: keep-alive expiry, the Last
// Will, and client-id takeover (MQTT 3.1.1 §3.1.2.10, §3.1.2.5, MQTT-3.1.4-2).

import { assert, assertEquals } from "@std/assert";
import { createRng, ManualClock, type TcpConnection, TcpHost } from "../engine/mod.ts";
import {
  MqttBroker,
  mqttPacket,
  mqttPublish,
  mqttString,
  parseMqttPacket,
  readString,
} from "../orchestrator/boards/drivers/tcp-services.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CONNECT = 1;
const SUBSCRIBE = 8;
const DISCONNECT = 14;

interface Wire {
  clock: ManualClock;
  /** Frames from the clients' side are dropped while true. */
  cut: boolean;
  broker: TcpHost;
  client: TcpHost;
  log: string[];
}

/** A broker node and a client node joined by a wire that delivers a frame 1 ms after it is sent. */
function setup(): Wire {
  const clock = new ManualClock();
  const macs = { broker: "02:68:7a:62:01:01", client: "02:68:7a:62:01:02" };
  const ips = { broker: "192.168.4.11", client: "192.168.4.12" };
  const w = { clock, cut: false, log: [] as string[] } as Wire;
  const station = (me: "broker" | "client", other: "broker" | "client") =>
    new TcpHost({
      mac: macs[me],
      ip: ips[me],
      clock,
      send: (frame) => {
        if (w.cut && me === "client") return;
        clock.schedule(clock.now() + 1, () => void w[other].receive(frame));
      },
      macFor: (ip) => (ip === ips[other] ? macs[other] : null),
      rng: createRng(`mqtt-session-test:${me}`),
    });
  w.broker = station("broker", "client");
  w.client = station("client", "broker");
  const broker = new MqttBroker({ node: "broker", onSerial: (l) => w.log.push(l), clock });
  w.broker.listen(1883, (conn) => broker.serve(conn));
  return w;
}

async function run(clock: ManualClock, ms: number, stepMs = 50): Promise<void> {
  const end = clock.now() + ms;
  while (clock.now() < end) {
    clock.advanceTo(Math.min(end, clock.now() + stepMs));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

interface Will {
  topic: string;
  message: string;
  retain?: boolean;
}

function connectPacket(clientId: string, keepAliveSeconds: number, will?: Will): Uint8Array {
  const flags = 0x02 | (will ? 0x04 | (will.retain ? 0x20 : 0) : 0);
  const message = will ? encoder.encode(will.message) : new Uint8Array(0);
  return mqttPacket(CONNECT, 0, [
    ...mqttString("MQTT"),
    4,
    flags,
    keepAliveSeconds >>> 8,
    keepAliveSeconds & 0xff,
    ...mqttString(clientId),
    ...(will
      ? [...mqttString(will.topic), message.length >>> 8, message.length & 0xff, ...message]
      : []),
  ]);
}

/** A raw client: bytes in, the PUBLISH messages it receives out. */
class Raw {
  readonly received: string[] = [];
  closed = false;
  constructor(readonly conn: TcpConnection) {
    let buffer = new Uint8Array(0);
    conn.onData((chunk) => {
      buffer = Uint8Array.from([...buffer, ...chunk]);
      for (let p = parseMqttPacket(buffer); p; p = parseMqttPacket(buffer)) {
        buffer = buffer.slice(p.size);
        if (p.type === 3) {
          const [topic, after] = readString(p.body, 0);
          this.received.push(`${topic}=${decoder.decode(p.body.subarray(after))}`);
        }
      }
    });
    conn.onClose(() => (this.closed = true));
  }
  send(bytes: Uint8Array): void {
    void this.conn.write(bytes).catch(() => {});
  }
  subscribe(filter: string): void {
    this.send(mqttPacket(SUBSCRIBE, 2, [0, 1, ...mqttString(filter), 0]));
  }
}

async function open(w: Wire, clientId: string, keepAlive: number, will?: Will): Promise<Raw> {
  let conn: TcpConnection | null = null;
  void w.client.connect("192.168.4.11", 1883).then((c) => (conn = c));
  while (conn === null) await run(w.clock, 50);
  const raw = new Raw(conn as TcpConnection);
  raw.send(connectPacket(clientId, keepAlive, will));
  await run(w.clock, 100);
  return raw;
}

const WILL: Will = { topic: "riego/estado", message: "ESTADO;enlace;CAIDO" };

Deno.test("mqtt broker: a silent client is closed after 1.5 keep-alives and its will is published", async () => {
  const w = setup();
  const panel = await open(w, "panel", 0);
  panel.subscribe("riego/#");
  await open(w, "nodo", 5, WILL);
  await run(w.clock, 200);

  w.cut = true; // the node goes silent
  await run(w.clock, 7_000); // 7 s < 7.5 s: still alive
  assertEquals(w.log.some((l) => l.startsWith("mqtt keep-alive expired")), false);
  assertEquals(panel.received, []);

  await run(w.clock, 1_000); // past 7.5 s of silence
  assertEquals(
    w.log.filter((l) => l.startsWith("mqtt keep-alive") || l.startsWith("mqtt will")),
    ["mqtt keep-alive expired nodo", "mqtt will riego/estado from nodo"],
  );
  assert(w.log.includes('mqtt publish riego/estado "ESTADO;enlace;CAIDO" from nodo'));
  w.cut = false;
  await run(w.clock, 200);
  assertEquals(panel.received, ["riego/estado=ESTADO;enlace;CAIDO"]);
  assertEquals(panel.closed, false, "a client with keep-alive 0 is never expired");
});

Deno.test("mqtt broker: traffic from the client keeps its keep-alive alive", async () => {
  const w = setup();
  const node = await open(w, "nodo", 5, WILL);
  for (let i = 0; i < 4; i++) {
    await run(w.clock, 5_000);
    node.send(mqttPacket(12, 0, [])); // PINGREQ
  }
  await run(w.clock, 200);
  assertEquals(w.log.some((l) => l.includes("keep-alive expired") || l.includes("will")), false);
});

Deno.test("mqtt broker: a clean DISCONNECT discards the will", async () => {
  const w = setup();
  const panel = await open(w, "panel", 0);
  panel.subscribe("riego/#");
  const node = await open(w, "nodo", 5, WILL);
  node.send(mqttPacket(DISCONNECT, 0, []));
  await run(w.clock, 20_000);
  assertEquals(
    w.log.some((l) => l.startsWith("mqtt will") || l.includes("keep-alive expired")),
    false,
  );
  assertEquals(panel.received, []);
});

Deno.test("mqtt broker: the will is published when the socket closes without DISCONNECT, and kept if retained", async () => {
  const w = setup();
  const panel = await open(w, "panel", 0);
  panel.subscribe("riego/#");
  const node = await open(w, "nodo", 0, { ...WILL, retain: true });
  node.conn.abort("link lost");
  await run(w.clock, 200);
  assertEquals(panel.received, ["riego/estado=ESTADO;enlace;CAIDO"]);
  // A late subscriber gets the retained will.
  const late = await open(w, "late", 0);
  late.subscribe("riego/estado");
  await run(w.clock, 200);
  assertEquals(late.received, ["riego/estado=ESTADO;enlace;CAIDO"]);
});

Deno.test("mqtt broker: a repeated client id closes the old connection and drops its late frames", async () => {
  const w = setup();
  const panel = await open(w, "panel", 0);
  panel.subscribe("riego/#");
  const old = await open(w, "nodo", 0, WILL);
  // The old link stalls: this frame is written but the broker has it only after the takeover.
  w.cut = true;
  old.send(mqttPublish("riego/estado", encoder.encode("STALE")));
  await run(w.clock, 100);
  w.cut = false;
  const fresh = await open(w, "nodo", 0);
  assertEquals(w.log.filter((l) => l === "mqtt takeover nodo"), ["mqtt takeover nodo"]);
  assert(
    w.log.indexOf("mqtt takeover nodo") < w.log.lastIndexOf("mqtt connect nodo from 192.168.4.12"),
    "the old connection is closed before the new CONNECT is accepted",
  );
  await run(w.clock, 20_000); // the stalled frame is retransmitted and reaches the broker
  assertEquals(old.closed, true);
  assertEquals(fresh.closed, false);
  assertEquals(
    w.log.some((l) => l.includes("STALE")),
    false,
    "no frame of the old connection is published",
  );
  // The takeover ends the old session without DISCONNECT, so its will went out once.
  assertEquals(panel.received, ["riego/estado=ESTADO;enlace;CAIDO"]);
});
