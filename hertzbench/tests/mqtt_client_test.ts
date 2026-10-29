// A scripted Wi-Fi board as an MQTT client (`via: mqtt` sends and `subscribe`): the schema, the
// session that survives a dropped link, and the whole thing through the engine and the IP bridge.

import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { createRng, ManualClock, type TcpConnection, TcpHost } from "../engine/mod.ts";
import {
  BoardError,
  type LiveRun,
  loadScenario,
  parseScenario,
  runScenario,
  ScenarioError,
} from "../orchestrator/mod.ts";
import { MqttBroker, MqttClient } from "../orchestrator/boards/drivers/tcp-services.ts";

const EXAMPLES = fileURLToPath(new URL("../scenarios/examples/", import.meta.url));

// ── schema ──────────────────────────────────────────────────────────────────

function scenarioWith(firmware: string, extraNode = ""): string {
  return `
name: mqtt
duration: 5s
nodes:
  - id: broker
    board: scripted
    position: [0, 0]
    radios: [{ phy: wifi, channel: 5 }]
    firmware: { serve: [{ port: 1883, protocol: mqtt }, { port: 80, protocol: http }] }
  - id: client
    board: scripted
    position: [5, 0]
    radios: [{ phy: wifi, channel: 5 }]
    firmware: ${firmware}
${extraNode}`;
}

function refuses(firmware: string, message: string, extraNode = ""): void {
  assertThrows(() => parseScenario(scenarioWith(firmware, extraNode)), ScenarioError, message);
}

Deno.test("mqtt schema: the issue's send and a subscribe parse, with the defaults", () => {
  const scenario = parseScenario(scenarioWith(
    "{ send: [{ to: broker, via: mqtt, topic: riego/estado, every: 10s, payload: [ON, OFF] }], " +
      "subscribe: [{ to: broker, topic: riego/cmd }] }",
  ));
  const fw = scenario.nodes[1]?.firmware;
  assert(fw?.kind === "script");
  assertEquals(fw.send, [{
    to: "broker",
    via: "mqtt",
    everyMs: 10_000,
    count: 100_000,
    startMs: 0,
    port: 1883,
    payload: "ON",
    topic: "riego/estado",
    payloads: ["ON", "OFF"],
  }]);
  assertEquals(fw.subscribe, [{ to: "broker", port: 1883, topic: "riego/cmd" }]);
});

Deno.test("mqtt schema: a single string payload is a list of one, and a filter may use wildcards", () => {
  const scenario = parseScenario(scenarioWith(
    "{ send: [{ to: broker, via: mqtt, topic: a/b, every: 1s, count: 3, payload: hi }], " +
      "subscribe: [{ to: broker, topic: 'a/+/c/#' }] }",
  ));
  const fw = scenario.nodes[1]?.firmware;
  assert(fw?.kind === "script");
  assertEquals(fw.send[0]?.payloads, ["hi"]);
  assertEquals(fw.send[0]?.count, 3);
});

Deno.test("mqtt schema: refusals name the field", () => {
  const send = (entry: string) => `{ send: [{ to: broker, via: mqtt, every: 1s, ${entry} }] }`;
  refuses(send("payload: x"), "nodes[1].firmware.send[0].topic: is required with via: mqtt");
  refuses(
    send("topic: a/+, payload: x"),
    "send[0].topic: a publish topic takes no + or # wildcard",
  );
  refuses(send("topic: '', payload: x"), "send[0].topic: expected a non-empty string");
  refuses(send("topic: a, payload: []"), "send[0].payload: names no payload to publish");
  refuses(send("topic: a, payload: [x, 1]"), "send[0].payload[1]");
  refuses(send("topic: a, payload: x, port: 1884"), "broker serves no MQTT broker on port 1884");
  refuses(send("topic: a, payload: x, port: 80"), "broker serves no MQTT broker on port 80");
  refuses(
    "{ send: [{ to: broker, every: 1s, count: 2, topic: a, payload: x }] }",
    "send[0].topic: needs via: mqtt",
  );
  refuses(
    "{ send: [{ to: broker, every: 1s, count: 2, payload: [a, b] }] }",
    "send[0].payload: expected a non-empty string",
  );
  refuses(
    "{ send: [{ to: broker, via: mqtt, topic: a, payload: x }] }",
    "send[0].every",
  );
  refuses(
    "{ send: [{ to: client, via: mqtt, topic: a, every: 1s, payload: x }] }",
    "a node cannot send to itself",
  );
  refuses(
    "{ send: [{ to: nobody, via: mqtt, topic: a, every: 1s, payload: x }] }",
    'send[0].to: no node named "nobody"',
  );
  refuses(
    "{ send: [{ to: broadcast, via: mqtt, topic: a, every: 1s, payload: x }] }",
    'send[0].to: "broadcast" needs via: espnow',
  );
});

Deno.test("mqtt schema: subscribe refusals name the field", () => {
  const sub = (entry: string) => `{ subscribe: [${entry}] }`;
  refuses(sub("{ topic: a }"), "subscribe[0].to");
  refuses(sub("{ to: broker }"), "subscribe[0].topic");
  refuses(
    sub("{ to: broker, topic: 'a/#/b' }"),
    "subscribe[0].topic: # must be the whole last level",
  );
  refuses(sub("{ to: broker, topic: 'a#' }"), "subscribe[0].topic: # must be the whole last level");
  refuses(sub("{ to: broker, topic: a, qos: 1 }"), "subscribe[0].qos");
  refuses(sub("{ to: broker, topic: a, port: 1884 }"), "broker serves no MQTT broker on port 1884");
  refuses(sub("{ to: client, topic: a }"), "a node cannot subscribe to itself");
  refuses(sub("{ to: nobody, topic: a }"), 'subscribe[0].to: no node named "nobody"');
  refuses("{ subscribe: {} }", "nodes[1].firmware.subscribe");
});

Deno.test("mqtt schema: MQTT needs a wifi radio", () => {
  const lora = `
name: m
duration: 5s
nodes:
  - id: a
    board: scripted
    position: [0, 0]
    radios: [{ phy: lora }]
    firmware: { subscribe: [{ to: b, topic: t }] }
  - id: b
    board: scripted
    position: [5, 0]
    radios: [{ phy: lora }]
`;
  assertThrows(() => parseScenario(lora), ScenarioError, "nodes[0].firmware.subscribe: is a Wi-Fi");
  assertThrows(
    () =>
      parseScenario(
        lora.replace(
          "subscribe: [{ to: b, topic: t }]",
          "send: [{ via: mqtt, topic: t, every: 1s, payload: x }]",
        ),
      ),
    ScenarioError,
    "send[0].via: MQTT needs a wifi radio",
  );
});

Deno.test("mqtt schema: the example scenario is valid", async () => {
  const loaded = await loadScenario(`${EXAMPLES}mqtt-clients-scripted.yaml`);
  assertEquals(loaded.scenario.nodes.map((n) => n.id), ["broker", "valve", "panel"]);
});

// ── the session, on a hand-driven clock ─────────────────────────────────────

interface Wire {
  clock: ManualClock;
  cut: boolean;
  broker: TcpHost;
  client: TcpHost;
}

/** Two stations joined by a wire that delivers a frame 1 ms after it is sent, unless `cut`. */
function wire(): Wire {
  const clock = new ManualClock();
  const macs = { broker: "02:68:7a:62:01:01", client: "02:68:7a:62:01:02" };
  const ips = { broker: "192.168.4.11", client: "192.168.4.12" };
  const w = { clock, cut: false } as Wire;
  const station = (me: "broker" | "client", other: "broker" | "client") =>
    new TcpHost({
      mac: macs[me],
      ip: ips[me],
      clock,
      send: (frame) => {
        if (w.cut) return;
        clock.schedule(clock.now() + 1, () => void w[other].receive(frame));
      },
      macFor: (ip) => (ip === ips[other] ? macs[other] : null),
      rng: createRng(`mqtt-test:${me}`),
    });
  w.broker = station("broker", "client");
  w.client = station("client", "broker");
  return w;
}

/** Let time pass in small steps, running promise callbacks between them. */
async function run(clock: ManualClock, ms: number, stepMs = 50): Promise<void> {
  const end = clock.now() + ms;
  while (clock.now() < end) {
    clock.advanceTo(Math.min(end, clock.now() + stepMs));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

Deno.test("mqtt client: it subscribes, receives, publishes, and reconnects after the link drops", async () => {
  const w = wire();
  const brokerLog: string[] = [];
  const broker = new MqttBroker({ node: "broker", onSerial: (l) => brokerLog.push(l) });
  w.broker.listen(1883, (conn) => broker.serve(conn));
  const states: boolean[] = [];
  const messages: string[] = [];
  const client = new MqttClient({
    clientId: "valve",
    filters: ["riego/cmd"],
    clock: w.clock,
    connect: () => w.client.connect("192.168.4.11", 1883),
    onMessage: (topic, payload) => messages.push(`${topic}=${new TextDecoder().decode(payload)}`),
    onState: (up) => states.push(up),
  });
  assertEquals(client.publish("riego/estado", new Uint8Array()), false, "no session yet");
  client.start();
  await run(w.clock, 200);
  assertEquals(states, [true]);
  assertEquals(brokerLog, [
    "mqtt connect valve from 192.168.4.12",
    "mqtt subscribe riego/cmd from valve",
  ]);

  assert(client.publish("riego/estado", new TextEncoder().encode("ON")));
  await run(w.clock, 100);
  assertStringIncludes(brokerLog.join("\n"), 'mqtt publish riego/estado "ON" from valve');

  // A second client publishes to the topic the first one subscribed to.
  const other = new MqttClient({
    clientId: "panel",
    filters: [],
    clock: w.clock,
    connect: () => w.client.connect("192.168.4.11", 1883),
    onMessage: () => {},
    onState: () => {},
  });
  other.start();
  await run(w.clock, 200);
  assert(other.publish("riego/cmd", new TextEncoder().encode("OPEN")));
  await run(w.clock, 100);
  assertEquals(messages, ["riego/cmd=OPEN"]);

  // The link goes dark: nothing is acknowledged, nothing arrives. The client notices after 1.5 keep-alives.
  w.cut = true;
  await run(w.clock, 20_000);
  assertEquals(states, [true, false]);
  assertEquals(client.publish("riego/estado", new Uint8Array()), false, "down: nothing sent");

  // The link returns: it connects again, subscribes again, and a command reaches it.
  w.cut = false;
  await run(w.clock, 40_000);
  assertEquals(states, [true, false, true]);
  assertEquals(brokerLog.filter((l) => l === "mqtt subscribe riego/cmd from valve").length, 2);
  messages.length = 0;
  assert(other.publish("riego/cmd", new TextEncoder().encode("CLOSE")));
  await run(w.clock, 100);
  assertEquals(messages.includes("riego/cmd=CLOSE"), true);

  client.stop();
  other.stop();
  await run(w.clock, 100);
});

Deno.test("mqtt client: a broker that refuses the connection is dialled again", async () => {
  const w = wire();
  let attempts = 0;
  const client = new MqttClient({
    clientId: "valve",
    filters: [],
    clock: w.clock,
    connect: () => {
      attempts++;
      return w.client.connect("192.168.4.11", 1883) as Promise<TcpConnection>;
    },
    onMessage: () => {},
    onState: () => {},
  });
  client.start();
  await run(w.clock, 5_000); // nothing listens on 1883: the broker station answers RST
  assert(attempts >= 3, `expected repeated attempts, got ${attempts}`);
  client.stop();
  await run(w.clock, 100);
});

// ── end to end: the engine, two scripted clients and a phone through the IP bridge ──────

const SCENARIO = `
name: mqtt-clients
seed: 5
duration: 10s
environment: { preset: indoor_office, shadowing_sigma_db: 0 }
nodes:
  - id: broker
    board: scripted
    position: [0, 0]
    radios: [{ phy: wifi, channel: 5 }]
    firmware: { serve: [{ port: 1883, protocol: mqtt }] }
  - id: valve
    board: scripted
    position: [6, 0]
    radios: [{ phy: wifi, channel: 5 }]
    firmware:
      send: [{ to: broker, via: mqtt, topic: riego/estado, every: 500ms, payload: [ON, OFF] }]
      subscribe: [{ to: broker, topic: riego/cmd }]
  - id: panel
    board: scripted
    position: [-6, 0]
    radios: [{ phy: wifi, channel: 5 }]
    firmware:
      send: [{ to: broker, via: mqtt, topic: riego/cmd, every: 500ms, start: 1s, payload: [OPEN, CLOSE] }]
      subscribe: [{ to: broker, topic: 'riego/#' }]
bridge:
  position: [3, 3]
  expose:
    - { node: broker, port: 1883, service: mqtt }
assertions:
  - serial: { node: valve, contains: "mqtt rx riego/cmd OPEN", within: 8s }
  - serial: { node: panel, contains: "mqtt rx riego/estado ON", within: 8s }
`;

/** MQTT 3.1.1 written byte by byte, so the broker and the clients are not checked against their own encoder. */
class RawMqtt {
  #buffer: number[] = [];
  /** The RETAIN flag of the PUBLISH `nextPublish` returned last. */
  lastRetain = false;
  constructor(readonly conn: Deno.TcpConn) {}

  async #fill(): Promise<void> {
    const chunk = new Uint8Array(1024);
    const n = await this.conn.read(chunk);
    if (n === null) throw new Error("broker closed the connection");
    this.#buffer.push(...chunk.subarray(0, n));
  }

  /** The next PUBLISH as `topic=payload`, skipping CONNACK, SUBACK and anything else. */
  async nextPublish(): Promise<string> {
    for (;;) {
      while (this.#buffer.length < 2) await this.#fill();
      const length = this.#buffer[1] as number; // every packet here is under 128 bytes
      while (this.#buffer.length < 2 + length) await this.#fill();
      const packet = this.#buffer.splice(0, 2 + length);
      if (((packet[0] as number) & 0xf0) !== 0x30) continue;
      this.lastRetain = ((packet[0] as number) & 1) === 1;
      const topicLength = ((packet[2] as number) << 8) | (packet[3] as number);
      const text = (bytes: number[]) => new TextDecoder().decode(Uint8Array.from(bytes));
      return `${text(packet.slice(4, 4 + topicLength))}=${text(packet.slice(4 + topicLength))}`;
    }
  }
}

const utf8 = (text: string) => [0, text.length, ...new TextEncoder().encode(text)];

Deno.test("mqtt clients: publishes reach subscribers and a phone through the bridge, and the phone's publish is logged", async () => {
  const out = await Deno.makeTempDir({ prefix: "hzb-mqtt-" });
  let underway: (live: LiveRun) => void = () => {};
  const live = new Promise<LiveRun>((resolve) => (underway = resolve));
  const run = runScenario(parseScenario(SCENARIO), {
    outDir: out,
    outputs: {
      metrics: `${out}/metrics.json`,
      pcap: `${out}/air.pcap`,
      events: `${out}/events.jsonl`,
    },
    onUnderway: underway,
  });
  const control = await live;
  const bridge = control.bridge();
  assert(bridge?.kind === "ip");
  const endpoint = bridge.endpoints[0];
  assert(endpoint && endpoint.hostPort > 0);

  const conn = await Deno.connect({ hostname: "127.0.0.1", port: endpoint.hostPort });
  const phone = new RawMqtt(conn);
  // CONNECT as "ph", then SUBSCRIBE id 1 to "riego/#" at QoS 0.
  const connect = [0, 4, 77, 81, 84, 84, 4, 2, 0, 60, ...utf8("ph")];
  await conn.write(Uint8Array.of(0x10, connect.length, ...connect));
  const subscribe = [0, 1, ...utf8("riego/#"), 0];
  await conn.write(Uint8Array.of(0x82, subscribe.length, ...subscribe));
  // The phone sees what the valve publishes, ON and then OFF in turn.
  const seen = new Set<string>();
  const deadline = Date.now() + 8000;
  while (!(seen.has("riego/estado=ON") && seen.has("riego/estado=OFF"))) {
    if (Date.now() > deadline) throw new Error(`the phone saw only ${[...seen].join(", ")}`);
    seen.add(await phone.nextPublish());
  }
  // And the phone publishes to the topic the valve subscribed to.
  const publish = [...utf8("riego/cmd"), ...new TextEncoder().encode("HOST")];
  await conn.write(Uint8Array.of(0x30, publish.length, ...publish));
  const waitFor = async (node: string, line: string) => {
    for (const until = Date.now() + 5000; Date.now() < until;) {
      const found = control.events().some((e) =>
        e.type === "serial" && e.node === node && e.text === line
      );
      if (found) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`${node} never logged ${line}`);
  };
  await waitFor("valve", "mqtt rx riego/cmd HOST");
  conn.close();

  const result = await run;
  const serial = (node: string) =>
    result.events.flatMap((e) => (e.type === "serial" && e.node === node ? [e.text] : []));
  assertEquals(result.problems, []);
  assertEquals(result.passed, true);
  assert(serial("valve").includes("mqtt connected to broker"));
  assert(serial("valve").includes("mqtt rx riego/cmd OPEN"));
  assert(serial("panel").includes("mqtt rx riego/estado ON"));
  assert(serial("panel").includes("mqtt rx riego/estado OFF"));
  assertStringIncludes(serial("broker").join("\n"), 'mqtt publish riego/estado "ON" from valve');
  assertStringIncludes(serial("broker").join("\n"), 'mqtt publish riego/cmd "HOST" from ph');
  await Deno.remove(out, { recursive: true });
});

// ── live publish through the broker node (the mqtt_publish tool) ────────────────────────────

const LIVE_SCENARIO = `
name: mqtt-live
seed: 5
duration: 20s
environment: { preset: indoor_office, shadowing_sigma_db: 0 }
nodes:
  - id: broker
    board: scripted
    position: [0, 0]
    radios: [{ phy: wifi, channel: 5 }]
    firmware: { serve: [{ port: 1883, protocol: mqtt }, { port: 80, protocol: http }] }
  - id: valve
    board: scripted
    position: [6, 0]
    radios: [{ phy: wifi, channel: 5 }]
    firmware: { subscribe: [{ to: broker, topic: 'riego/#' }] }
bridge:
  position: [3, 3]
  expose:
    - { node: broker, port: 1883, service: mqtt }
`;

/** Runs LIVE_SCENARIO and hands `body` the live run, once every board is up; stops the run after. */
async function withLiveRun(body: (control: LiveRun) => Promise<void>): Promise<void> {
  const out = await Deno.makeTempDir({ prefix: "hzb-mqtt-live-" });
  const abort = new AbortController();
  let underway: (live: LiveRun) => void = () => {};
  const live = new Promise<LiveRun>((resolve) => (underway = resolve));
  const run = runScenario(parseScenario(LIVE_SCENARIO), {
    outDir: out,
    outputs: {
      metrics: `${out}/metrics.json`,
      pcap: `${out}/air.pcap`,
      events: `${out}/events.jsonl`,
    },
    onUnderway: underway,
    signal: abort.signal,
  });
  run.catch(() => {}); // an aborted run rejects; the test is over by then
  try {
    await body(await live);
  } finally {
    abort.abort();
    await run.catch(() => {});
    await Deno.remove(out, { recursive: true });
  }
}

async function waitForSerial(control: LiveRun, node: string, line: string): Promise<void> {
  for (const until = Date.now() + 8000; Date.now() < until;) {
    if (control.events().some((e) => e.type === "serial" && e.node === node && e.text === line)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${node} never logged ${line}`);
}

/** A phone on the IP bridge: connects as `id` and subscribes to `filter`. */
async function phoneOn(control: LiveRun, id: string, filter: string) {
  const bridge = control.bridge();
  assert(bridge?.kind === "ip");
  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: (bridge.endpoints[0] as { hostPort: number }).hostPort,
  });
  const connect = [0, 4, 77, 81, 84, 84, 4, 2, 0, 60, ...utf8(id)];
  await conn.write(Uint8Array.of(0x10, connect.length, ...connect));
  const subscribe = [0, 1, ...utf8(filter), 0];
  await conn.write(Uint8Array.of(0x82, subscribe.length, ...subscribe));
  await waitForSerial(control, "broker", `mqtt subscribe ${filter} from ${id}`);
  return { conn, phone: new RawMqtt(conn) };
}

const bytes = (text: string) => new TextEncoder().encode(text);

Deno.test("mqtt publish: a message from the broker node reaches a scripted subscriber and a phone on the bridge", async () => {
  await withLiveRun(async (control) => {
    await waitForSerial(control, "valve", "mqtt connected to broker");
    const { conn, phone } = await phoneOn(control, "ph", "riego/#");

    const reached = control.publishMqtt("broker", {
      topic: "riego/bomba",
      payload: bytes("ON"),
      retain: false,
      port: null,
    });
    assertEquals(reached, 2, "the valve's session and the phone's");
    assertEquals(await phone.nextPublish(), "riego/bomba=ON");
    assertEquals(phone.lastRetain, false, "a live delivery never carries the RETAIN flag");
    await waitForSerial(control, "valve", "mqtt rx riego/bomba ON");
    await waitForSerial(control, "broker", 'mqtt publish riego/bomba "ON" from mcp');

    // A topic nobody subscribed to reaches no one, and is not an error.
    assertEquals(
      control.publishMqtt("broker", {
        topic: "otro/tema",
        payload: bytes("x"),
        retain: false,
        port: 1883,
      }),
      0,
    );
    conn.close();
  });
});

Deno.test("mqtt publish: a retained message waits for a later subscriber, and an empty one clears it", async () => {
  await withLiveRun(async (control) => {
    await waitForSerial(control, "valve", "mqtt connected to broker");
    const retained = (payload: string) =>
      control.publishMqtt("broker", {
        topic: "riego/estado",
        payload: bytes(payload),
        retain: true,
        port: null,
      });
    assertEquals(retained("ON"), 1, "the valve is subscribed to riego/#, so it hears it now");
    await waitForSerial(control, "valve", "mqtt rx riego/estado ON");

    const late = await phoneOn(control, "late", "riego/+");
    assertEquals(await late.phone.nextPublish(), "riego/estado=ON");
    assertEquals(late.phone.lastRetain, true, "stored messages go out flagged as retained");
    late.conn.close();

    retained(""); // an empty retained payload clears the topic
    const after = await phoneOn(control, "after", "riego/+");
    // Nothing is stored now: the next thing this phone hears is a message published after it.
    control.publishMqtt("broker", {
      topic: "riego/estado",
      payload: bytes("OFF"),
      retain: false,
      port: null,
    });
    assertEquals(await after.phone.nextPublish(), "riego/estado=OFF");
    assertEquals(after.phone.lastRetain, false);
    after.conn.close();
  });
});

Deno.test("mqtt publish: a PUBLISH a client sends with RETAIN is kept for later subscribers", async () => {
  await withLiveRun(async (control) => {
    const sender = await phoneOn(control, "pub", "nada/#");
    const publish = [...utf8("riego/modo"), ...bytes("AUTO")];
    await sender.conn.write(Uint8Array.of(0x31, publish.length, ...publish));
    await waitForSerial(control, "broker", 'mqtt publish riego/modo "AUTO" from pub');
    const late = await phoneOn(control, "late", "riego/modo");
    assertEquals(await late.phone.nextPublish(), "riego/modo=AUTO");
    assertEquals(late.phone.lastRetain, true);
    sender.conn.close();
    late.conn.close();
  });
});

Deno.test("mqtt publish: a node that is not a broker refuses, naming why", async () => {
  await withLiveRun((control) => {
    const publish = { topic: "t", payload: bytes("x"), retain: false, port: null };
    assertThrows(
      () => control.publishMqtt("valve", publish),
      BoardError,
      "valve serves no MQTT broker",
    );
    assertThrows(
      () => control.publishMqtt("broker", { ...publish, port: 80 }),
      BoardError,
      "broker serves no MQTT broker on port 80 (its MQTT ports: 1883)",
    );
    assertThrows(() => control.publishMqtt("nobody", publish), BoardError, "not a board");
    return Promise.resolve();
  });
});
