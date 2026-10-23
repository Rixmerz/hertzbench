// mDNS for the IP bridge: the DNS codec against bytes written by hand, the
// responder's answers to the three kinds of asker, the announcement and the
// goodbye, the real UDP transport on loopback, and the run's report line.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import dgram from "node:dgram";
import {
  type BridgeEndpoint,
  bridgeRecords,
  decodeMessage,
  encodeMessage,
  MDNS_PORT,
  MdnsPublisher,
  MdnsResponder,
  type MdnsTransport,
  type Peer,
  RR,
  udpTransport,
} from "../bridge/mod.ts";
import { parseScenario, runScenario } from "../orchestrator/mod.ts";

const ENDPOINTS: BridgeEndpoint[] = [
  { node: "web", port: 80, service: "http", listenPort: 0, host: "0.0.0.0", hostPort: 8080 },
  { node: "web", port: 1883, service: "mqtt", listenPort: 0, host: "0.0.0.0", hostPort: 1883 },
];

const label = (text: string) => [text.length, ...new TextEncoder().encode(text)];

Deno.test("mdns: a phone's query, with a compressed name and the QU bit, decodes", () => {
  // Two questions, as iOS sends them: the second name points back into the first.
  const query = Uint8Array.from([
    0,
    0,
    0,
    0,
    0,
    2,
    0,
    0,
    0,
    0,
    0,
    0,
    ...label("_http"),
    ...label("_tcp"),
    ...label("local"),
    0,
    0,
    12,
    0x80,
    1, // offset 12
    ...label("_mqtt"),
    0xc0,
    18,
    0,
    12,
    0,
    1, // "_tcp.local" starts at 12 + 6
  ]);
  assertEquals(decodeMessage(query).questions, [
    { name: "_http._tcp.local", type: RR.PTR, unicast: true },
    { name: "_mqtt._tcp.local", type: RR.PTR, unicast: false },
  ]);
});

Deno.test("mdns: an A record encodes to the RFC 1035 bytes", () => {
  const bytes = encodeMessage({
    id: 0,
    response: true,
    questions: [],
    answers: [{
      name: "hzb-web.local",
      ttl: 120,
      unique: true,
      data: { type: RR.A, address: "192.168.1.20" },
    }],
    additionals: [],
  });
  assertEquals([...bytes], [
    0,
    0,
    0x84,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    ...label("hzb-web"),
    ...label("local"),
    0,
    0,
    1,
    0x80,
    1,
    0,
    0,
    0,
    120,
    0,
    4,
    192,
    168,
    1,
    20,
  ]);
});

class FakeTransport implements MdnsTransport {
  readonly sent: { message: ReturnType<typeof decodeMessage>; to?: Peer }[] = [];
  #handler: (message: Uint8Array, from: Peer) => void = () => {};
  closed = false;
  send(message: Uint8Array, to?: Peer): Promise<void> {
    this.sent.push({ message: decodeMessage(message), ...(to ? { to } : {}) });
    return Promise.resolve();
  }
  onMessage(fn: (message: Uint8Array, from: Peer) => void): void {
    this.#handler = fn;
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  ask(name: string, type: number, from: Peer, unicast = false, id = 0): void {
    this.#handler(
      encodeMessage({
        id,
        response: false,
        questions: [{ name, type, unicast }],
        answers: [],
        additionals: [],
      }),
      from,
    );
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

Deno.test("mdns: a browse gets the PTR with SRV, TXT and A, by multicast, QU or legacy unicast", async () => {
  const transport = new FakeTransport();
  new MdnsResponder(
    bridgeRecords(ENDPOINTS, "192.168.1.20"),
    transport,
    () => new Promise(() => {}),
  );
  const phone = { address: "192.168.1.50", port: MDNS_PORT };

  transport.ask("_HTTP._tcp.local", RR.PTR, phone);
  await flush();
  const multicast = transport.sent.shift();
  assertEquals(multicast?.to, undefined);
  assertEquals(multicast?.message.answers.map((r) => r.data), [
    { type: RR.PTR, target: "web-80._http._tcp.local" },
  ]);
  assertEquals(multicast?.message.additionals.map((r) => r.data), [
    { type: RR.SRV, priority: 0, weight: 0, port: 8080, target: "hzb-web.local" },
    { type: RR.TXT, entries: ["node=web", "port=80", "via=hertzbench", "path=/"] },
    { type: RR.A, address: "192.168.1.20" },
  ]);

  transport.ask("hzb-web.local", RR.A, phone, true);
  await flush();
  assertEquals(transport.sent.shift()?.to, phone);

  const dig = { address: "192.168.1.50", port: 40000 };
  transport.ask("web-1883._mqtt._tcp.local", RR.SRV, dig, false, 0x1234);
  await flush();
  const legacy = transport.sent.shift();
  assertEquals(legacy?.to, dig);
  assertEquals(legacy?.message.id, 0x1234);
  assertEquals(legacy?.message.questions.length, 1);
  assertEquals(legacy?.message.answers.map((r) => [r.ttl, r.unique, r.data]), [
    [10, false, { type: RR.SRV, priority: 0, weight: 0, port: 1883, target: "hzb-web.local" }],
  ]);

  transport.ask("printer.local", RR.A, phone);
  await flush();
  assertEquals(transport.sent.length, 0, "a name the bridge does not own gets no answer");
});

Deno.test("mdns: records are announced at start and withdrawn with TTL 0 at the end", async () => {
  const transport = new FakeTransport();
  const responder = new MdnsResponder(
    bridgeRecords(ENDPOINTS, "192.168.1.20"),
    transport,
    () => new Promise(() => {}),
  );
  await responder.announce();
  await responder.close();
  assertEquals(transport.sent.length, 2);
  const [hello, goodbye] = transport.sent;
  assert(hello && hello.message.answers.every((r) => r.ttl > 0));
  assertEquals(hello.message.answers.length, goodbye?.message.answers.length);
  assert(goodbye?.message.answers.every((r) => r.ttl === 0));
  assertEquals(transport.closed, true);
});

Deno.test("mdns: the UDP transport answers a legacy query on loopback", async () => {
  const transport = await udpTransport({ bind: "127.0.0.1", port: 0, group: null });
  const responder = new MdnsResponder(
    bridgeRecords(ENDPOINTS, "192.168.1.20"),
    transport,
    () => new Promise(() => {}),
  );
  const client = dgram.createSocket("udp4");
  const answer = new Promise<Uint8Array>((resolve) =>
    client.on("message", (m: Uint8Array) => resolve(new Uint8Array(m)))
  );
  await new Promise<void>((resolve) => client.bind(0, "127.0.0.1", () => resolve()));
  const port = transport.port;
  assert(port > 0, "udpTransport reports the port it bound");
  const query = encodeMessage({
    id: 7,
    response: false,
    questions: [{ name: "hzb-web.local", type: RR.A, unicast: false }],
    answers: [],
    additionals: [],
  });
  client.send(query, port, "127.0.0.1");
  const reply = decodeMessage(await answer);
  assertEquals(reply.id, 7);
  assertEquals(reply.answers.map((r) => r.data), [{ type: RR.A, address: "192.168.1.20" }]);
  await new Promise<void>((resolve) => client.close(() => resolve()));
  await responder.close();
});

const SCENARIO = `
name: bridge-mdns
duration: 1s
nodes:
  - { id: web, board: scripted, position: [0, 0], firmware: { serve: [{ port: 80, protocol: http }] } }
  - { id: other, board: scripted, position: [5, 0] }
bridge:
  position: [1, 0]
  mdns: true
  expose: [{ node: web, port: 80, service: http }]
`;

Deno.test("mdns: the run reports what it advertised, and a closed socket only costs the line", async () => {
  for (const broken of [false, true]) {
    const out = await Deno.makeTempDir({ prefix: "hzb-mdns-" });
    const transport = new FakeTransport();
    const result = await runScenario(parseScenario(SCENARIO), {
      outDir: out,
      outputs: { metrics: `${out}/m.json`, pcap: `${out}/a.pcap`, events: `${out}/e.jsonl` },
      bridge: {
        publisher: (spec) =>
          new MdnsPublisher({
            spec,
            hostAddress: () => "192.168.1.20",
            transport: () =>
              broken ? Promise.reject(new Error("EADDRINUSE")) : Promise.resolve(transport),
          }),
      },
    });
    const report = result.bridge;
    assert(report?.kind === "ip");
    const port = report.endpoints[0]?.hostPort;
    if (broken) {
      assertStringIncludes(
        report.mdns,
        "not advertised: cannot open 224.0.0.251:5353 (EADDRINUSE)",
      );
    } else {
      assertEquals(
        report.mdns,
        `advertising web-80._http._tcp.local -> hzb-web.local:${port} at 192.168.1.20`,
      );
      assertEquals(transport.closed, true, "the goodbye went out when the run ended");
    }
    assertEquals(result.passed, true);
    await Deno.remove(out, { recursive: true });
  }
});
