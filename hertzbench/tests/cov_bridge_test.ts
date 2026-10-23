// The mobile bridge's edges, each part on its own harness: the IP proxy
// against an engine TCP station wired straight to it (no medium, no board),
// the mDNS codec, responder, UDP transport and publisher with stand-ins for
// the network, the BlueZ side against a small helper written by the test, and
// the BLE mirror against a fake controller that serves a real GattServer.
// Nothing here listens beyond 127.0.0.1, joins a multicast group or reads the
// host's interfaces: those go through the modules' hooks or a stub.

import {
  assert,
  assertEquals,
  assertFalse,
  assertInstanceOf,
  assertMatch,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import dgram from "node:dgram";
import {
  BleBridge,
  BluezPeripheral,
  BluezStartError,
  type BridgeEndpoint,
  bridgeLines,
  bridgeRecords,
  BridgeStartError,
  decodeMessage,
  DnsFormatError,
  type DnsMessage,
  type DnsRecord,
  encodeMessage,
  type EndpointPublisher,
  firstLanAddress,
  GattOperationError,
  type GattPeripheral,
  hostNameFor,
  IpBridge,
  MDNS_GROUP,
  MDNS_PORT,
  MdnsPublisher,
  MdnsResponder,
  type MdnsTransport,
  type Peer,
  type PeripheralHandlers,
  RR,
  udpTransport,
} from "../bridge/mod.ts";
import {
  buildTcpFrame,
  createRng,
  ManualClock,
  TCP_FLAG,
  type TcpConnection,
  TcpHost,
} from "../engine/mod.ts";
import {
  addressToBytes,
  type BleController,
  encodeHci,
  EVT,
  H4Decoder,
  LE_SUBEVENT,
  OP,
  u16,
} from "../adapters/ble-hci/mod.ts";
import {
  ATT,
  type DiscoveredService,
  GattServer,
  PROPERTY,
} from "../orchestrator/boards/drivers/att.ts";
import type { BleBridgeSpec, ExposedService, IpBridgeSpec } from "../orchestrator/scenario.ts";
import { parseScenario } from "../orchestrator/mod.ts";
import { until } from "./helpers.ts";

const enc = (text: string) => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const b64 = (text: string) => btoa(text);

/** Let every queued microtask and the I/O they started settle once. */
const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── the IP proxy ────────────────────────────────────────────────────────────

const IP_BASE = parseScenario(`
name: cov-bridge-ip
duration: 1s
nodes:
  - id: web
    board: scripted
    position: [0, 0]
    radios: [{ phy: wifi, channel: 5 }]
    firmware: { serve: [{ port: 80, protocol: http }] }
  - id: other
    board: scripted
    position: [5, 0]
    radios: [{ phy: wifi, channel: 5 }]
bridge:
  position: [1, 0]
  expose: [{ node: web, port: 80, service: http }]
`).bridge as IpBridgeSpec;

const NODE_IP = "192.168.4.11";
const NODE_MAC = "02:68:7a:62:01:01";

interface IpRig {
  bridge: IpBridge;
  node: TcpHost;
  lines: string[];
  /** Every frame the bridge's station put on the "medium". */
  sent: Uint8Array[];
}

/**
 * An IpBridge whose station is wired to one engine TCP station, the node.
 * Each frame crosses on its own microtask, as it would through the medium.
 * The clock never moves: a lossless wire needs no retransmission.
 */
function ipRig(
  expose: ExposedService[],
  opts: { publisher?: EndpointPublisher; dropToNode?: boolean } = {},
): IpRig {
  const clock = new ManualClock();
  const lines: string[] = [];
  const sent: Uint8Array[] = [];
  const holder: { bridge: IpBridge | null } = { bridge: null };
  const node = new TcpHost({
    mac: NODE_MAC,
    ip: NODE_IP,
    clock,
    rng: createRng("cov-node"),
    macFor: (ip) => (ip === IP_BASE.ip ? IP_BASE.mac : null),
    send: (frame) => queueMicrotask(() => holder.bridge?.sink.deliver(frame, "web")),
  });
  const bridge = new IpBridge({
    spec: { ...IP_BASE, expose },
    nodes: new Map([["web", { ip: NODE_IP, mac: NODE_MAC }]]),
    clock,
    rng: createRng("cov-bridge"),
    log: (line) => lines.push(line),
    transmit: (frame) => {
      sent.push(frame);
      if (!opts.dropToNode) queueMicrotask(() => node.receive(frame));
    },
    ...(opts.publisher ? { publisher: opts.publisher } : {}),
  });
  holder.bridge = bridge;
  return { bridge, node, lines, sent };
}

const http = (port: number, listenPort = 0, node = "web"): ExposedService => ({
  node,
  port,
  service: "http",
  listenPort,
});

/** Read until EOF; a reset after the data counts as the end too. */
async function readAll(conn: Deno.Conn): Promise<{ text: string; reset: boolean }> {
  const bytes: number[] = [];
  const buffer = new Uint8Array(1024);
  try {
    for (;;) {
      const n = await conn.read(buffer);
      if (n === null) return { text: dec(Uint8Array.from(bytes)), reset: false };
      bytes.push(...buffer.subarray(0, n));
    }
  } catch (error) {
    if (error instanceof Deno.errors.ConnectionReset) {
      return { text: dec(Uint8Array.from(bytes)), reset: true };
    }
    throw error;
  }
}

function endpointPort(rig: IpRig, index = 0): number {
  const report = rig.bridge.report();
  assert(report.kind === "ip");
  const port = report.endpoints[index]?.hostPort;
  assert(port !== undefined && port > 0, "the endpoint has a bound host port");
  return port;
}

const hasLine = (rig: IpRig, pattern: RegExp) => rig.lines.some((l) => pattern.test(l));

Deno.test("proxy: a phone's half-close reaches the node and the echo comes back whole", async () => {
  const rig = ipRig([http(80)]);
  rig.node.listen(80, (conn) => {
    conn.onData((bytes) => void conn.write(bytes));
    conn.onEnd(() => conn.end());
  });
  await rig.bridge.start();
  const phone = await Deno.connect({ hostname: "127.0.0.1", port: endpointPort(rig) });
  await phone.write(enc("hello"));
  await phone.closeWrite();
  const got = await readAll(phone);
  phone.close();
  await until(() => hasLine(rig, /closed: /), "the relay's closing line");
  await rig.bridge.close();

  assertEquals(got, { text: "hello", reset: false });
  assert(hasLine(rig, /^bridge listening on 127\.0\.0\.1:\d+ for web:80 \(http\)$/));
  assert(hasLine(rig, /^bridge 127\.0\.0\.1:\d+ -> web:80 connecting$/));
  assert(hasLine(rig, /-> web:80 connected$/));
  assert(hasLine(rig, /-> web:80 closed: 5 B to the node, 5 B from it$/), rig.lines.join("\n"));
});

Deno.test("proxy: a node that answers and ends first closes the phone's read side cleanly", async () => {
  const rig = ipRig([http(84)]);
  rig.node.listen(84, (conn) => {
    void conn.write(enc("bye"));
    conn.end();
  });
  await rig.bridge.start();
  const phone = await Deno.connect({ hostname: "127.0.0.1", port: endpointPort(rig) });
  const got = await readAll(phone);
  phone.close();
  await until(() => hasLine(rig, /closed/), "the relay's closing line");
  await rig.bridge.close();

  assertEquals(got, { text: "bye", reset: false });
  const closing = rig.lines.find((l) => l.includes("closed")) ?? "";
  assertMatch(closing, /closed: 0 B to the node, 3 B from it$/);
  assertFalse(closing.includes("("), "a clean close carries no reason");
});

Deno.test("proxy: a reset from the node ends the phone's connection and is logged with its reason", async () => {
  const rig = ipRig([http(81)]);
  const nodeSide: TcpConnection[] = [];
  rig.node.listen(81, (conn) => {
    nodeSide.push(conn);
    conn.onData(() => conn.abort("the node gave up"));
  });
  await rig.bridge.start();
  const phone = await Deno.connect({ hostname: "127.0.0.1", port: endpointPort(rig) });
  await phone.write(enc("x"));
  const got = await readAll(phone);
  phone.close();
  await until(() => hasLine(rig, /closed \(/), "the relay's closing line");
  await rig.bridge.close();

  assertEquals(got.text, "", "the node sent nothing before its reset");
  assertEquals(nodeSide.length, 1);
  const closing = rig.lines.find((l) => l.includes("closed (")) ?? "";
  assertStringIncludes(closing, `${NODE_IP}:81 reset the connection`);
  // The node reset before acknowledging the byte: the count is of bytes the node acknowledged.
  assertMatch(closing, /: 0 B to the node, 0 B from it$/);
});

Deno.test("proxy: a port the node does not listen on is refused and logged as a failure", async () => {
  const rig = ipRig([http(82)]);
  await rig.bridge.start();
  const phone = await Deno.connect({ hostname: "127.0.0.1", port: endpointPort(rig) });
  const got = await readAll(phone);
  phone.close();
  await until(() => hasLine(rig, /failed:/), "the failure line");
  await rig.bridge.close();

  assertEquals(got.text, "");
  assert(hasLine(rig, new RegExp(`-> web:82 failed: ${NODE_IP}:82 refused the connection$`)));
  assertFalse(hasLine(rig, /connected$/));
});

Deno.test("proxy: an exposed node that is not on the medium fails the phone's connection", async () => {
  const rig = ipRig([http(80, 0, "ghost")]);
  await rig.bridge.start();
  const phone = await Deno.connect({ hostname: "127.0.0.1", port: endpointPort(rig) });
  const got = await readAll(phone);
  phone.close();
  await until(() => hasLine(rig, /failed:/), "the failure line");
  await rig.bridge.close();

  assertEquals(got.text, "");
  assert(hasLine(rig, /-> ghost:80 failed: ghost is not on the medium$/), rig.lines.join("\n"));
  assertFalse(hasLine(rig, /connecting$/), "no connection is attempted to an unknown node");
  assertEquals(rig.sent.length, 0, "nothing went on the medium");
});

Deno.test("proxy: closing the bridge resets a live relay on both sides", async () => {
  const rig = ipRig([http(83)]);
  let nodeError: string | null = null;
  rig.node.listen(83, (conn) => conn.onClose((error) => (nodeError = error?.message ?? "clean")));
  await rig.bridge.start();
  const phone = await Deno.connect({ hostname: "127.0.0.1", port: endpointPort(rig) });
  await until(() => hasLine(rig, /connected$/), "the relay to connect");
  assert(rig.bridge.sink.ready(), "the bridge's station takes frames while it runs");

  await rig.bridge.close();
  const got = await readAll(phone);
  phone.close();
  await until(() => nodeError !== null, "the node to see the reset");

  assertEquals(got.text, "");
  assertFalse(rig.bridge.sink.ready(), "a closed bridge takes no frames");
  assert(hasLine(rig, /-> web:83 closed \(the bridge shut down\)/), rig.lines.join("\n"));
  assertStringIncludes(nodeError ?? "", "reset the connection");
  // Closing again is a no-op: nothing more is logged and it does not throw.
  const before = rig.lines.length;
  await rig.bridge.close();
  assertEquals(rig.lines.length, before);
});

Deno.test("proxy: closing while the node never answers the SYN fails the pending connection", async () => {
  const rig = ipRig([http(85)], { dropToNode: true });
  await rig.bridge.start();
  const phone = await Deno.connect({ hostname: "127.0.0.1", port: endpointPort(rig) });
  await until(() => hasLine(rig, /connecting$/) && rig.sent.length > 0, "the SYN to go out");
  await rig.bridge.close();
  const got = await readAll(phone);
  phone.close();

  assertEquals(got.text, "");
  assert(hasLine(rig, /-> web:85 failed: the station shut down$/), rig.lines.join("\n"));
  assertFalse(hasLine(rig, /connected$/));
});

Deno.test("proxy: a segment from an address not among the nodes gets no reset", () => {
  const rig = ipRig([http(80)]);
  const segment = (srcIp: string) =>
    buildTcpFrame({
      srcMac: "02:00:00:00:00:99",
      dstMac: IP_BASE.mac,
      srcIp,
      dstIp: IP_BASE.ip,
      srcPort: 40000,
      dstPort: 5555,
      seq: 1,
      ack: 0,
      flags: TCP_FLAG.syn,
      window: 1024,
      payload: new Uint8Array(0),
    });
  rig.bridge.sink.deliver(segment("10.9.9.9"), "stranger");
  assertEquals(rig.sent.length, 0, "the bridge cannot address a station it does not know");
  // The same SYN from a known node is answered with a reset (no listener on the bridge).
  rig.bridge.sink.deliver(segment(NODE_IP), "web");
  assertEquals(rig.sent.length, 1);
});

Deno.test("proxy: a port already in use stops the start and frees the ports opened before it", async () => {
  const held = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const heldPort = (held.addr as Deno.NetAddr).port;
  const rig = ipRig([http(80), http(1883, heldPort)]);
  try {
    const error = await assertRejects(() => rig.bridge.start(), BridgeStartError);
    assertEquals(error.name, "BridgeStartError");
    assertStringIncludes(error.message, `127.0.0.1:${heldPort}`);
    assertStringIncludes(error.message, "already in use");
    const firstPort = endpointPort(rig, 0);
    // The first listener was closed by the failed start: its port can be bound again.
    const again = Deno.listen({ hostname: "127.0.0.1", port: firstPort });
    again.close();
  } finally {
    held.close();
  }
});

Deno.test("proxy: a port out of range is refused with Deno's reason", async () => {
  const rig = ipRig([http(80, 70000)]);
  const error = await assertRejects(() => rig.bridge.start(), BridgeStartError);
  assertStringIncludes(error.message, "cannot listen on 127.0.0.1:70000");
  assertStringIncludes(error.message, "out of range");
  assertEquals(rig.bridge.report().kind === "ip" && rig.bridge.report(), {
    kind: "ip",
    id: "phone",
    endpoints: [],
    mdns: "off (the scenario turned it off, or the proxy listens on loopback only)",
  });
});

Deno.test("proxy: an address the host lacks, or may not use, names the fix", async () => {
  // 192.0.2.1 is TEST-NET-1: never a host address. Without the permission Deno refuses it first.
  const granted = Deno.permissions.querySync({ name: "net", host: "192.0.2.1" }).state ===
    "granted";
  const clock = new ManualClock();
  const bridge = new IpBridge({
    spec: { ...IP_BASE, listen: "192.0.2.1", expose: [http(80)] },
    nodes: new Map(),
    clock,
    rng: createRng(1),
    log: () => {},
    transmit: () => {},
  });
  const error = await assertRejects(() => bridge.start(), BridgeStartError);
  assertStringIncludes(error.message, "192.0.2.1:<any port>");
  if (granted) {
    assertStringIncludes(error.message, "the host has no such address");
  } else {
    assertStringIncludes(error.message, "limited to 127.0.0.1");
    assertStringIncludes(error.message, "deno task lan");
  }
});

Deno.test("proxy: the publisher gets the bound endpoints and its line is the report's mDNS", async () => {
  const published: BridgeEndpoint[][] = [];
  let closed = 0;
  const publisher: EndpointPublisher = {
    publish: (endpoints) => {
      published.push([...endpoints]);
      return Promise.resolve("advertising by a stand-in");
    },
    close: () => {
      closed++;
      return Promise.resolve();
    },
  };
  const rig = ipRig([http(80)], { publisher });
  await rig.bridge.start();
  const report = rig.bridge.report();
  await rig.bridge.close();
  await rig.bridge.close();

  assert(report.kind === "ip");
  assertEquals(report.mdns, "advertising by a stand-in");
  assertEquals(published, [report.endpoints]);
  assertEquals(closed, 1, "the publisher is closed once, by the first close");
  const port = report.endpoints[0]?.hostPort;
  assertEquals(bridgeLines(report), [
    `bridge phone: http web:80 at 127.0.0.1:${port}`,
    "bridge phone: mDNS advertising by a stand-in",
  ]);
});

// ── mDNS: the codec ─────────────────────────────────────────────────────────

const label = (text: string) => [text.length, ...enc(text)];
const header = (qd: number, an: number, ns = 0, ar = 0) => [
  0,
  0,
  0,
  0,
  ...[qd >> 8, qd & 0xff],
  ...[an >> 8, an & 0xff],
  ...[ns >> 8, ns & 0xff],
  ...[ar >> 8, ar & 0xff],
];
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const NAME = [...label("hzb-web"), ...label("local"), 0];
/** A resource record on hzb-web.local with raw type and rdata. */
const rawRecord = (type: number, rdata: number[]) => [
  ...NAME,
  ...be16(type),
  ...be16(1),
  0,
  0,
  0,
  60,
  ...be16(rdata.length),
  ...rdata,
];

const message = (answers: DnsRecord[], additionals: DnsRecord[] = []): DnsMessage => ({
  id: 0,
  response: true,
  questions: [],
  answers,
  additionals,
});

Deno.test("mdns codec: a name with an empty or a 64-byte label is refused", () => {
  const withName = (name: string): DnsMessage => ({
    id: 0,
    response: false,
    questions: [{ name, type: RR.A, unicast: false }],
    answers: [],
    additionals: [],
  });
  assertThrows(() => encodeMessage(withName("hzb..local")), DnsFormatError, "bad DNS label");
  assertThrows(
    () => encodeMessage(withName(`${"a".repeat(64)}.local`)),
    DnsFormatError,
    "bad DNS label",
  );
  // The QU bit survives a round trip.
  assertEquals(
    decodeMessage(
      encodeMessage({
        ...withName("hzb-web.local"),
        questions: [{ name: "hzb-web.local", type: RR.SRV, unicast: true }],
      }),
    ).questions,
    [{ name: "hzb-web.local", type: RR.SRV, unicast: true }],
  );
  // 63 bytes is the limit, and a trailing dot is the same name.
  const longest = `${"a".repeat(63)}.local`;
  assertEquals(decodeMessage(encodeMessage(withName(longest))).questions[0]?.name, longest);
  assertEquals(
    [...encodeMessage(withName("hzb-web.local."))],
    [...encodeMessage(withName("hzb-web.local"))],
  );
});

Deno.test("mdns codec: every kind of malformed message is a DnsFormatError naming the fault", () => {
  const cases: [number[], string][] = [
    [[0, 0, 0], "shorter than a DNS header"],
    [header(1, 0), "runs past the end"],
    [[...header(1, 0), 0xc0], "truncated compression pointer"],
    [[...header(1, 0), 0xc0, 12], "compression pointer loop"],
    [[...header(1, 0), 0x40, 97, 0], "bad label"],
    [[...header(1, 0), 5, 97, 98], "bad label"],
    [[...header(1, 0), ...NAME, 0, 1], "truncated question"],
    [[...header(0, 1), ...NAME, 0, 1, 0, 1, 0, 0], "truncated record"],
    [[...header(0, 1), ...NAME, ...be16(RR.A), ...be16(1), 0, 0, 0, 60, 0, 4, 10, 0], "data"],
  ];
  for (const [bytes, fault] of cases) {
    assertThrows(() => decodeMessage(Uint8Array.from(bytes)), DnsFormatError, fault);
  }
});

Deno.test("mdns codec: records of unknown types and A records of the wrong size are skipped", () => {
  const bytes = Uint8Array.from([
    ...header(0, 3),
    ...rawRecord(RR.A, [10, 0, 0, 1, 0, 0]), // six bytes: not an IPv4 address
    ...rawRecord(28, new Array(16).fill(0)), // AAAA: not a type this module reads
    ...rawRecord(RR.A, [10, 0, 0, 2]),
  ]);
  const decoded = decodeMessage(bytes);
  assertEquals(decoded.answers, [
    { name: "hzb-web.local", ttl: 60, unique: false, data: { type: RR.A, address: "10.0.0.2" } },
  ]);
});

Deno.test("mdns codec: the authority section is read past and dropped, additionals are kept", () => {
  const a = (address: string): DnsRecord => ({
    name: "hzb-web.local",
    ttl: 120,
    unique: true,
    data: { type: RR.A, address },
  });
  const bytes = encodeMessage(message([a("10.0.0.1")], [a("10.0.0.2")]));
  // Move the answer count to the authority count: the same record is now in the authority section.
  bytes[7] = 0;
  bytes[9] = 1;
  const decoded = decodeMessage(bytes);
  assertEquals(decoded.answers, []);
  assertEquals(decoded.additionals, [a("10.0.0.2")]);
  assertEquals(decoded.response, true);
});

Deno.test("mdns codec: the bridge's records survive a round trip, TXT edge cases included", () => {
  const endpoints: BridgeEndpoint[] = [
    {
      node: "Web_Node",
      port: 80,
      service: "http",
      listenPort: 0,
      host: "0.0.0.0",
      hostPort: 18080,
    },
    {
      node: "Web_Node",
      port: 81,
      service: "websocket",
      listenPort: 0,
      host: "0.0.0.0",
      hostPort: 18081,
    },
    {
      node: "Web_Node",
      port: 82,
      service: "http",
      listenPort: 0,
      host: "0.0.0.0",
      hostPort: 18082,
    },
    {
      node: "broker",
      port: 1883,
      service: "mqtt",
      listenPort: 0,
      host: "0.0.0.0",
      hostPort: 11883,
    },
  ];
  const records = bridgeRecords(endpoints, "192.168.1.20");
  const names = records.map((r) => `${r.name} ${r.data.type}`);
  // One A record per host and one _services PTR per service type, however many endpoints share them.
  assertEquals(names.filter((n) => n === "hzb-web-node.local 1").length, 1);
  assertEquals(names.filter((n) => n.startsWith("_services._dns-sd._udp.local")).length, 3);
  assertEquals(hostNameFor("Web_Node"), "hzb-web-node.local");
  const mqttTxt = records.find((r) =>
    r.name === "broker-1883._mqtt._tcp.local" && r.data.type === RR.TXT
  );
  assertEquals(mqttTxt?.data, {
    type: RR.TXT,
    entries: ["node=broker", "port=1883", "via=hertzbench"],
  });

  const decoded = decodeMessage(encodeMessage(message(records)));
  assertEquals(decoded.answers, records);

  const txt = (entries: string[]): DnsRecord => ({
    name: "x.local",
    ttl: 1,
    unique: false,
    data: { type: RR.TXT, entries },
  });
  const [empty, long] =
    decodeMessage(encodeMessage(message([txt([]), txt(["k=" + "v".repeat(298)])])))
      .answers;
  assertEquals(empty?.data, { type: RR.TXT, entries: [] }, "an empty TXT is one zero byte");
  assert(long?.data.type === RR.TXT);
  assertEquals(long.data.entries[0]?.length, 255, "a TXT string stops at 255 bytes");
});

// ── mDNS: the responder ─────────────────────────────────────────────────────

class FakeTransport implements MdnsTransport {
  readonly sent: { message: DnsMessage; to?: Peer }[] = [];
  #handler: (message: Uint8Array, from: Peer) => void = () => {};
  closes = 0;
  failSends = false;
  send(bytes: Uint8Array, to?: Peer): Promise<void> {
    if (this.failSends) return Promise.reject(new Error("network unreachable"));
    this.sent.push({ message: decodeMessage(bytes), ...(to ? { to } : {}) });
    return Promise.resolve();
  }
  onMessage(fn: (message: Uint8Array, from: Peer) => void): void {
    this.#handler = fn;
  }
  close(): Promise<void> {
    this.closes++;
    return Promise.resolve();
  }
  receive(bytes: Uint8Array, from: Peer): void {
    this.#handler(bytes, from);
  }
}

const ENDPOINTS: BridgeEndpoint[] = [
  { node: "web", port: 80, service: "http", listenPort: 0, host: "0.0.0.0", hostPort: 8080 },
];
const PHONE: Peer = { address: "192.168.1.50", port: MDNS_PORT };
const query = (questions: DnsMessage["questions"], id = 0): DnsMessage => ({
  id,
  response: false,
  questions,
  answers: [],
  additionals: [],
});
const never = () => new Promise<void>(() => {});

Deno.test("mdns responder: a response is never answered, and a query for nothing gets nothing", () => {
  const responder = new MdnsResponder(
    bridgeRecords(ENDPOINTS, "10.0.0.1"),
    new FakeTransport(),
    never,
  );
  assertEquals(
    responder.answer({
      ...query([{ name: "hzb-web.local", type: RR.A, unicast: false }]),
      response: true,
    }, PHONE),
    null,
  );
  assertEquals(
    responder.answer(query([{ name: "hzb-web.local", type: RR.TXT, unicast: false }]), PHONE),
    null,
  );
  assertEquals(responder.answer(query([]), PHONE), null);
});

Deno.test("mdns responder: ANY on an instance answers SRV and TXT once, with the host's address", () => {
  const responder = new MdnsResponder(
    bridgeRecords(ENDPOINTS, "10.0.0.1"),
    new FakeTransport(),
    never,
  );
  const instance = "web-80._http._tcp.local";
  const reply = responder.answer(
    query([
      { name: instance, type: RR.ANY, unicast: true },
      { name: instance.toUpperCase(), type: RR.SRV, unicast: false }, // the same record again
    ]),
    PHONE,
  );
  assert(reply);
  assertEquals(reply.to, undefined, "one question without the QU bit makes the answer multicast");
  assertEquals(reply.message.id, 0);
  assertEquals(reply.message.answers.map((r) => r.data.type), [RR.SRV, RR.TXT]);
  assertEquals(reply.message.additionals.map((r) => r.data), [{ type: RR.A, address: "10.0.0.1" }]);
  // Every question with the QU bit: back to the asker.
  const unicast = responder.answer(query([{ name: instance, type: RR.SRV, unicast: true }]), PHONE);
  assertEquals(unicast?.to, PHONE);
});

Deno.test("mdns responder: junk, and anything after the goodbye, is not answered", async () => {
  const transport = new FakeTransport();
  const responder = new MdnsResponder(bridgeRecords(ENDPOINTS, "10.0.0.1"), transport, never);
  const ask = encodeMessage(query([{ name: "hzb-web.local", type: RR.A, unicast: false }]));

  transport.receive(Uint8Array.of(1, 2, 3), PHONE);
  await drain();
  assertEquals(transport.sent.length, 0, "bytes that are not DNS are another host's business");

  transport.receive(ask, PHONE);
  await drain();
  assertEquals(transport.sent.length, 1);

  await responder.close();
  await responder.close();
  assertEquals(transport.sent.length, 2, "one goodbye, however many closes");
  assert(transport.sent[1]?.message.answers.every((r) => r.ttl === 0));
  assertEquals(transport.closes, 1);

  transport.receive(ask, PHONE);
  await drain();
  assertEquals(transport.sent.length, 2, "a closed responder stays silent");
});

Deno.test("mdns responder: the second announcement goes out a second later, unless closed by then", async () => {
  const wakers: (() => void)[] = [];
  const sleeps: number[] = [];
  const sleep = (ms: number) => {
    sleeps.push(ms);
    return new Promise<void>((resolve) => wakers.push(resolve));
  };
  const open = new FakeTransport();
  await new MdnsResponder(bridgeRecords(ENDPOINTS, "10.0.0.1"), open, sleep).announce();
  assertEquals(open.sent.length, 1);
  wakers.shift()?.();
  await until(() => open.sent.length === 2, "the repeated announcement");
  assert(open.sent.every((s) => s.to === undefined && s.message.answers.every((r) => r.ttl > 0)));

  const closing = new FakeTransport();
  const responder = new MdnsResponder(bridgeRecords(ENDPOINTS, "10.0.0.1"), closing, sleep);
  await responder.announce();
  await responder.close();
  wakers.shift()?.();
  await drain();
  assertEquals(closing.sent.length, 2, "the announcement and the goodbye, no repeat after it");
  assert(closing.sent[1]?.message.answers.every((r) => r.ttl === 0));
  assertEquals(sleeps, [1000, 1000]);
});

Deno.test("mdns responder: a transport that cannot send costs the announcement, not the run", async () => {
  const transport = new FakeTransport();
  transport.failSends = true;
  const responder = new MdnsResponder(bridgeRecords(ENDPOINTS, "10.0.0.1"), transport, never);
  await responder.announce();
  await responder.close();
  assertEquals(transport.sent.length, 0);
  assertEquals(transport.closes, 1);
});

// ── mDNS: the UDP transport ─────────────────────────────────────────────────

Deno.test("mdns udp: a legacy query on loopback is answered to the asker's port", async () => {
  const transport = await udpTransport({ bind: "127.0.0.1", port: 0, group: null });
  const responder = new MdnsResponder(bridgeRecords(ENDPOINTS, "10.0.0.1"), transport, never);
  const client = dgram.createSocket("udp4");
  const answer = new Promise<Uint8Array>((resolve) =>
    client.on("message", (m: Uint8Array) => resolve(new Uint8Array(m)))
  );
  await new Promise<void>((resolve) => client.bind(0, "127.0.0.1", () => resolve()));
  client.send(
    encodeMessage(query([{ name: "hzb-web.local", type: RR.A, unicast: false }], 0x2a)),
    transport.port,
    "127.0.0.1",
  );
  const reply = decodeMessage(await answer);
  await new Promise<void>((resolve) => client.close(() => resolve()));
  await responder.close();

  assertEquals(reply.id, 0x2a);
  assertEquals(reply.answers.map((r) => [r.ttl, r.unique, r.data]), [
    [10, false, { type: RR.A, address: "10.0.0.1" }],
  ]);
});

Deno.test("mdns udp: without a group there is nowhere to multicast to", async () => {
  const transport = await udpTransport({ bind: "127.0.0.1", port: 0, group: null });
  try {
    await assertRejects(() => transport.send(Uint8Array.of(0)), Error, "no multicast group");
  } finally {
    await transport.close();
  }
});

Deno.test("mdns udp: a group that is not multicast is refused and the socket released", async () => {
  const error = await assertRejects(() =>
    udpTransport({ bind: "127.0.0.1", port: 0, group: "127.0.0.1" })
  );
  assertInstanceOf(error, Error);
  assertStringIncludes(error.message, "EINVAL");
});

Deno.test("mdns udp: a port held without address reuse fails the bind", async () => {
  const holder = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => holder.bind(0, "127.0.0.1", () => resolve()));
  const port = holder.address().port;
  try {
    const error = await assertRejects(() => udpTransport({ bind: "127.0.0.1", port, group: null }));
    assertInstanceOf(error, Error);
    assertStringIncludes(error.message, "EADDRINUSE");
  } finally {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
  }
});

// ── mDNS: the host's address and the publisher ──────────────────────────────

type Interfaces = typeof Deno.networkInterfaces;

/** Run `fn` with Deno.networkInterfaces replaced: the host's real interfaces are never read. */
async function withInterfaces<T>(stub: Interfaces, fn: () => T | Promise<T>): Promise<T> {
  const original = Deno.networkInterfaces;
  (Deno as { networkInterfaces: Interfaces }).networkInterfaces = stub;
  try {
    return await fn();
  } finally {
    (Deno as { networkInterfaces: Interfaces }).networkInterfaces = original;
  }
}

const iface = (family: "IPv4" | "IPv6", address: string): Deno.NetworkInterfaceInfo =>
  ({
    family,
    address,
    name: "eth0",
    netmask: "",
    scopeid: null,
    cidr: "",
    mac: "",
  }) as Deno.NetworkInterfaceInfo;

Deno.test("mdns host address: the first non-loopback IPv4 address, or why there is none", async () => {
  const pick = (list: Deno.NetworkInterfaceInfo[]) => withInterfaces(() => list, firstLanAddress);
  assertEquals(
    await pick([
      iface("IPv4", "127.0.0.1"),
      iface("IPv6", "fe80::1"),
      iface("IPv4", "192.168.1.7"),
    ]),
    "192.168.1.7",
  );
  const none = await pick([iface("IPv4", "127.0.0.1"), iface("IPv6", "::1")]);
  assertInstanceOf(none, Error);
  assertStringIncludes(none.message, "no non-loopback IPv4 address");

  for (
    const refusal of [new Deno.errors.NotCapable("sys"), new Deno.errors.PermissionDenied("sys")]
  ) {
    const result = await withInterfaces(() => {
      throw refusal;
    }, firstLanAddress);
    assertInstanceOf(result, Error);
    assertStringIncludes(result.message, "--allow-sys=networkInterfaces");
    assertStringIncludes(result.message, "advertise_ip");
  }
  const other = new TypeError("interfaces unavailable");
  assertEquals(
    await withInterfaces(() => {
      throw other;
    }, firstLanAddress),
    other,
  );
  const odd = await withInterfaces(() => {
    throw "not an error";
  }, firstLanAddress);
  assertInstanceOf(odd, Error);
  assertEquals(odd.message, "not an error");
});

Deno.test("mdns publisher: no address, or no socket, is one line in the report and nothing sent", async () => {
  let opened = 0;
  const noAddress = new MdnsPublisher({
    spec: { ...IP_BASE, listen: "0.0.0.0", mdns: true },
    hostAddress: () => new Error("the host has no non-loopback IPv4 address"),
    transport: () => {
      opened++;
      return Promise.resolve(new FakeTransport());
    },
  });
  assertEquals(
    await noAddress.publish(ENDPOINTS),
    "not advertised: the host has no non-loopback IPv4 address",
  );
  assertEquals(opened, 0, "no socket is opened without an address to advertise");
  await noAddress.close();

  const busy = new MdnsPublisher({
    spec: { ...IP_BASE, listen: "0.0.0.0", mdns: true },
    hostAddress: () => "10.0.0.1",
    transport: () => Promise.reject("port busy"),
  });
  const line = await busy.publish(ENDPOINTS);
  assertStringIncludes(line, `cannot open ${MDNS_GROUP}:${MDNS_PORT} (port busy)`);
  assertStringIncludes(line, "deno task lan");
  await busy.close();

  const held = new MdnsPublisher({
    spec: { ...IP_BASE, listen: "0.0.0.0", mdns: true },
    hostAddress: () => "10.0.0.1",
    transport: () => Promise.reject(new Error("bind EADDRINUSE 0.0.0.0:5353")),
  });
  assertStringIncludes(await held.publish(ENDPOINTS), "(bind EADDRINUSE 0.0.0.0:5353)");
  await held.close();
});

Deno.test("mdns publisher: the advertised address is advertise_ip, then a specific listen, then the host's", async () => {
  const unused = () => {
    throw new Error("the host's address must not be looked up");
  };
  const cases: { spec: IpBridgeSpec; hostAddress?: () => string | Error; expect: string }[] = [
    {
      spec: { ...IP_BASE, listen: "0.0.0.0", advertiseIp: "10.1.1.1" },
      hostAddress: unused,
      expect: "10.1.1.1",
    },
    { spec: { ...IP_BASE, listen: "192.168.7.9" }, hostAddress: unused, expect: "192.168.7.9" },
    {
      spec: { ...IP_BASE, listen: "127.0.0.2" },
      hostAddress: () => "10.2.2.2",
      expect: "10.2.2.2",
    },
    // No hook: the default reads the (stubbed) interfaces.
    { spec: { ...IP_BASE, listen: "0.0.0.0" }, expect: "192.168.1.7" },
  ];
  const transports = cases.map(() => new FakeTransport());
  const publishers = cases.map((c, i) =>
    new MdnsPublisher({
      spec: c.spec,
      ...(c.hostAddress ? { hostAddress: c.hostAddress } : {}),
      transport: () => Promise.resolve(transports[i] as FakeTransport),
    })
  );
  const lines = await withInterfaces(
    () => [iface("IPv4", "127.0.0.1"), iface("IPv4", "192.168.1.7")],
    () => Promise.all(publishers.map((p) => p.publish(ENDPOINTS))),
  );
  // The responder repeats its announcement after a real second; let it, so no timer is left behind.
  await until(
    () => transports.every((t) => t.sent.length >= 2),
    "the repeated announcements",
    3000,
  );
  await Promise.all(publishers.map((p) => p.close()));

  cases.forEach((c, i) => {
    assertEquals(
      lines[i],
      `advertising web-80._http._tcp.local -> hzb-web.local:8080 at ${c.expect}`,
    );
    const a = transports[i]?.sent[0]?.message.answers.find((r) => r.data.type === RR.A);
    assertEquals(a?.data, { type: RR.A, address: c.expect });
    assertEquals(transports[i]?.closes, 1);
    assert(transports[i]?.sent.at(-1)?.message.answers.every((r) => r.ttl === 0), "a goodbye last");
  });
});

// ── BlueZ: the helper's protocol ────────────────────────────────────────────

const SERVICES: DiscoveredService[] = [{
  uuid: "0000ff00-0000-1000-8000-00805f9b34fb",
  startHandle: 0x0e,
  endHandle: 0x11,
  characteristics: [{
    uuid: "0000ff01-0000-1000-8000-00805f9b34fb",
    declarationHandle: 0x0f,
    valueHandle: 0x10,
    properties: 0x1e,
    cccdHandle: 0x11,
  }],
}];

/**
 * A stand-in for bluez_gatt.py: it records every line it reads, answers
 * "start" per its mode, then plays the scripted events.
 *   script:   blank line, stray print, ready, the events; exits on stop
 *   error:    an error event; waits for stop, then exits 1
 *   stubborn: ready; ignores stop and EOF; records SIGTERM
 *   crash:    four lines on stderr, exit 3
 *   silent:   exit 4, nothing said
 */
const HELPER = `
import json, signal, sys, time
mode, report = sys.argv[1], sys.argv[2]
events = json.loads(sys.argv[3]) if len(sys.argv) > 3 else []

def record(text):
    with open(report, "a") as f:
        f.write(text + "\\n")

def emit(value):
    sys.stdout.write((value if isinstance(value, str) else json.dumps(value)) + "\\n")
    sys.stdout.flush()

def terminated(*_):
    record("terminated")
    sys.exit(0)

if mode == "stubborn":
    signal.signal(signal.SIGTERM, terminated)
for line in sys.stdin:
    record(line.rstrip("\\n"))
    op = json.loads(line).get("op")
    if op == "start":
        if mode == "crash":
            sys.stderr.write("one\\ntwo\\nthree\\nfour\\n")
            sys.stderr.flush()
            sys.exit(3)
        if mode == "silent":
            sys.exit(4)
        if mode == "error":
            emit({"event": "error", "message": "org.bluez.Error.NotReady: hci0 is powered off"})
        else:
            emit("")
            emit("a stray print from a library {")
            emit({"event": "ready"})
            for event in events:
                emit(event)
    elif op == "stop" and mode != "stubborn":
        break
if mode == "stubborn":
    while True:
        time.sleep(60)
sys.exit(1 if mode == "error" else 0)
`;

async function helperDir(): Promise<{ dir: string; script: string; report: string }> {
  const dir = await Deno.makeTempDir({ prefix: "hzb-cov-bluez-" });
  const script = `${dir}/helper.py`;
  await Deno.writeTextFile(script, HELPER);
  await Deno.chmod(script, 0o755);
  return { dir, script, report: `${dir}/report.jsonl` };
}

async function reportLines(path: string): Promise<string[]> {
  try {
    return (await Deno.readTextFile(path)).split("\n").filter((l) => l !== "");
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
}

const parsedLines = async (path: string) =>
  (await reportLines(path)).flatMap((l) => {
    try {
      return [JSON.parse(l) as Record<string, unknown>];
    } catch {
      return [];
    }
  });

const idleHandlers: PeripheralHandlers = {
  read: () => Promise.resolve(new Uint8Array(0)),
  write: () => Promise.resolve(),
  subscribe: () => Promise.resolve(),
};

Deno.test("bluez: a missing program is named; any other spawn failure is passed through", async () => {
  const missing = new BluezPeripheral({ adapter: "hci9", command: ["/nonexistent/hzb-python"] });
  assertEquals(missing.description, "BlueZ on hci9");
  const error = await assertRejects(
    () => missing.start(SERVICES, "x", idleHandlers),
    BluezStartError,
  );
  assertStringIncludes(error.message, "/nonexistent/hzb-python is not installed");

  const dir = await Deno.makeTempDir({ prefix: "hzb-cov-bluez-" });
  try {
    const notExecutable = `${dir}/helper`;
    await Deno.writeTextFile(notExecutable, "#!/bin/sh\n");
    await Deno.chmod(notExecutable, 0o644);
    const refused = new BluezPeripheral({ adapter: "hci0", command: [notExecutable] });
    const passed = await assertRejects(() => refused.start(SERVICES, "x", idleHandlers));
    assertInstanceOf(passed, Deno.errors.PermissionDenied);
    assertFalse(passed instanceof BluezStartError);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bluez: close and notify before start do nothing", async () => {
  const peripheral = new BluezPeripheral({ adapter: "hci0", command: ["/nonexistent/hzb-python"] });
  peripheral.notify(0x10, enc("early"));
  await peripheral.close();
  await peripheral.close();
});

Deno.test("bluez: an error event from the helper fails start with BlueZ's reason", async () => {
  const { dir, script, report } = await helperDir();
  try {
    const peripheral = new BluezPeripheral({
      adapter: "hci0",
      command: ["python3", "-I", script, "error", report],
    });
    const error = await assertRejects(
      () => peripheral.start(SERVICES, "sensor", idleHandlers),
      BluezStartError,
    );
    assertStringIncludes(error.message, "org.bluez.Error.NotReady");
    const ops = (await parsedLines(report)).map((l) => l.op);
    assertEquals(ops, ["start", "stop"], "the failed start still tells the helper to stop");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bluez: a helper that dies before ready fails start with its code and last words", async () => {
  const { dir, script, report } = await helperDir();
  try {
    const crash = new BluezPeripheral({
      adapter: "hci0",
      command: ["python3", "-I", script, "crash", report],
    });
    const crashed = await assertRejects(
      () => crash.start(SERVICES, "x", idleHandlers),
      BluezStartError,
    );
    assertStringIncludes(crashed.message, "exited with code 3 before BlueZ accepted");
    assertStringIncludes(crashed.message, ": two | three | four", "the last three lines of stderr");
    assertFalse(crashed.message.includes("one"));

    const silent = new BluezPeripheral({
      adapter: "hci0",
      command: ["python3", "-I", script, "silent", report],
    });
    const quiet = await assertRejects(
      () => silent.start(SERVICES, "x", idleHandlers),
      BluezStartError,
    );
    assertMatch(quiet.message, /exited with code 4 before BlueZ accepted the GATT application$/);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bluez: each phone operation gets its reply, errors mapped, stray output ignored", async () => {
  const { dir, script, report } = await helperDir();
  const events = [
    { event: "read", id: 1, char: 16 },
    { event: "write", id: null, char: 16, value: b64("cmd") },
    { event: "write", id: 2, char: 16, value: b64("nope") },
    { event: "read", id: 3, char: 99 },
    { event: "read", id: 4, char: 98 },
    { event: "write", id: 5, char: 16, value: b64("ok") },
    { event: "subscribe", char: 16, enabled: true },
  ];
  const seen: string[] = [];
  const handlers: PeripheralHandlers = {
    read: (handle) => {
      seen.push(`read ${handle}`);
      if (handle === 99) return Promise.reject(new Error("the node did not answer"));
      if (handle === 98) return Promise.reject("a bare string");
      return Promise.resolve(enc("reading:7"));
    },
    write: (handle, value, withResponse) => {
      seen.push(`write ${handle} ${dec(value)} ${withResponse}`);
      if (dec(value) === "nope") {
        return Promise.reject(new GattOperationError("the node refused it", "not-permitted"));
      }
      // A write command's failure has nobody to go to: it must not escape.
      if (!withResponse) return Promise.reject(new Error("lost on the air"));
      return Promise.resolve();
    },
    subscribe: (handle, enabled) => {
      seen.push(`subscribe ${handle} ${enabled}`);
      return Promise.reject(new Error("not connected"));
    },
  };
  const peripheral = new BluezPeripheral({
    adapter: "hci0",
    command: ["python3", "-I", script, "script", report, JSON.stringify(events)],
  });
  try {
    await peripheral.start(SERVICES, "hzb sensor", handlers);
    const replies = async () => (await parsedLines(report)).filter((l) => l.op === "reply");
    let got: Record<string, unknown>[] = [];
    await until(() => seen.includes("subscribe 16 true"), "the subscription", 5000);
    for (const deadline = Date.now() + 5000; (got = await replies()).length < 5;) {
      if (Date.now() > deadline) throw new Error(`only ${got.length} replies reached the helper`);
      await drain();
    }
    peripheral.notify(16, enc("reading:8"));
    await peripheral.close();
    const lines = await parsedLines(report);

    assertEquals(seen, [
      "read 16",
      "write 16 cmd false",
      "write 16 nope true",
      "read 99",
      "read 98",
      "write 16 ok true",
      "subscribe 16 true",
    ]);
    const byId = new Map(got.map((r) => [r.id, r]));
    assertEquals(byId.get(1), { op: "reply", id: 1, value: b64("reading:7") });
    assertEquals(byId.get(2), {
      op: "reply",
      id: 2,
      error: "not-permitted",
      message: "the node refused it",
    });
    assertEquals(byId.get(3), {
      op: "reply",
      id: 3,
      error: "failed",
      message: "the node did not answer",
    });
    assertEquals(byId.get(4), { op: "reply", id: 4, error: "failed", message: "a bare string" });
    assertEquals(byId.get(5), { op: "reply", id: 5, value: "" });
    assertEquals(lines[0], {
      op: "start",
      name: "hzb sensor",
      services: [{
        uuid: "0000ff00-0000-1000-8000-00805f9b34fb",
        characteristics: [{
          id: 16,
          uuid: "0000ff01-0000-1000-8000-00805f9b34fb",
          flags: ["read", "write-without-response", "write", "notify"],
        }],
      }],
    });
    assertEquals(lines.at(-2), { op: "notify", char: 16, value: b64("reading:8") });
    assertEquals(lines.at(-1), { op: "stop" });
  } finally {
    await peripheral.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bluez: a helper that ignores stop is terminated after the grace period", async () => {
  const { dir, script, report } = await helperDir();
  try {
    const peripheral = new BluezPeripheral({
      adapter: "hci0",
      command: ["python3", "-I", script, "stubborn", report],
    });
    await peripheral.start(SERVICES, "sensor", idleHandlers);
    await peripheral.close();
    const lines = await reportLines(report);
    assertEquals(lines.at(-1), "terminated", "the helper got SIGTERM");
    assertEquals(JSON.parse(lines.at(-2) ?? "null"), { op: "stop" }, "stop was sent first");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── the BLE mirror ──────────────────────────────────────────────────────────

const BLE_BASE = parseScenario(`
name: cov-bridge-ble
duration: 1s
nodes:
  - id: sensor
    board: scripted
    position: [0, 0]
    radios: [{ phy: ble }]
    firmware: { advertise: true }
  - id: gw
    board: scripted
    position: [5, 0]
    radios: [{ phy: ble }]
    firmware: { connect: { peers: [sensor] } }
bridge:
  position: [1, 0]
  mirror: sensor
`).bridge as BleBridgeSpec;

const MIRROR = "02:68:7a:62:01:01";
const BRIDGE_ADDR = "02:68:7a:62:02:01";

/**
 * The bridge's controller, faked at the HCI level: every command succeeds,
 * connections and disconnections happen when the test says, and ATT on a
 * connection is served by a real GattServer.
 */
class FakeController {
  readonly commands: number[] = [];
  readonly pdus: { handle: number; pdu: Uint8Array }[] = [];
  readonly cccdWrites: number[][] = [];
  readonly written: string[] = [];
  /** Take ATT requests but answer none of them. */
  hold = false;
  readonly server: GattServer;
  readonly #decoder = new H4Decoder();
  #toHost: (bytes: Uint8Array) => void = () => {};

  constructor(properties: number) {
    this.server = new GattServer(
      { uuid: 0xff00, firstHandle: 0x0e, characteristic: { uuid: 0xff01, properties } },
      (value) => this.written.push(dec(value)),
    );
  }

  attach(toHost: (bytes: Uint8Array) => void): BleController {
    this.#toHost = toHost;
    return this as unknown as BleController;
  }

  fromHost(chunk: Uint8Array): void {
    for (const packet of this.#decoder.push(chunk)) {
      if (packet.type === "command") this.#command(packet.opcode);
      else if (packet.type === "acl") this.#acl(packet.handle, packet.data);
    }
  }

  count(op: number): number {
    return this.commands.filter((c) => c === op).length;
  }

  connected(handle: number, opts: { role?: number; status?: number; peer?: string } = {}): void {
    this.#event(EVT.leMeta, [
      LE_SUBEVENT.connectionComplete,
      opts.status ?? 0,
      ...u16(handle),
      opts.role ?? 0,
      0,
      ...addressToBytes(opts.peer ?? MIRROR),
      ...u16(24),
      ...u16(0),
      ...u16(100),
      0,
    ]);
  }

  disconnected(handle: number, reason: number): void {
    this.#event(EVT.disconnectionComplete, [0, ...u16(handle), reason]);
  }

  att(handle: number, pdu: number[]): void {
    this.#toHost(encodeHci({
      type: "acl",
      handle,
      pb: 2,
      data: Uint8Array.from([...u16(pdu.length), ...u16(4), ...pdu]),
    }));
  }

  #event(code: number, params: number[]): void {
    this.#toHost(encodeHci({ type: "event", code, params: Uint8Array.from(params) }));
  }

  #command(op: number): void {
    this.commands.push(op);
    if (op === OP.leCreateConnection) {
      this.#event(EVT.commandStatus, [0, 1, ...u16(op)]);
      return;
    }
    const ret = op === OP.leReadBufferSize
      ? [27, 0, 8]
      : op === OP.readBdAddr
      ? [...addressToBytes(BRIDGE_ADDR)]
      : [];
    this.#event(EVT.commandComplete, [1, ...u16(op), 0, ...ret]);
  }

  #acl(handle: number, data: Uint8Array): void {
    const pdu = data.slice(4);
    this.pdus.push({ handle, pdu });
    this.#event(EVT.numberOfCompletedPackets, [1, ...u16(handle), ...u16(1)]);
    const target = (pdu[1] ?? 0) | ((pdu[2] ?? 0) << 8);
    if (pdu[0] === ATT.writeReq && target === this.server.cccdHandle) {
      this.cccdWrites.push([...pdu.slice(3)]);
    }
    if (this.hold) return;
    const rsp = this.server.handle(pdu);
    if (rsp) this.att(handle, [...rsp]);
  }
}

/** The host's peripheral, as the bridge sees it. */
class PhoneStandIn implements GattPeripheral {
  readonly description = "a stand-in for BlueZ";
  handlers: PeripheralHandlers | null = null;
  services: DiscoveredService[] = [];
  starts = 0;
  closed = false;
  readonly notified: string[] = [];
  /** What start rejects with, while set. */
  refuse: unknown = null;

  start(services: DiscoveredService[], _name: string, handlers: PeripheralHandlers) {
    this.starts++;
    if (this.refuse !== null) return Promise.reject(this.refuse);
    this.services = services;
    this.handlers = handlers;
    return Promise.resolve();
  }
  notify(_handle: number, value: Uint8Array): void {
    this.notified.push(dec(value));
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

interface BleRig {
  bridge: BleBridge;
  fake: FakeController;
  phone: PhoneStandIn;
  lines: string[];
  problems: string[];
}

async function bleRig(properties = 0x1e): Promise<BleRig> {
  const fake = new FakeController(properties);
  const phone = new PhoneStandIn();
  const lines: string[] = [];
  const problems: string[] = [];
  const bridge = new BleBridge({
    spec: BLE_BASE,
    mirrorAddress: MIRROR,
    clock: new ManualClock(),
    makeController: (toHost) => fake.attach(toHost),
    peripheral: phone,
    log: (line) => lines.push(line),
    onProblem: (message) => problems.push(message),
  });
  await bridge.start();
  return { bridge, fake, phone, lines, problems };
}

/** Connect on `handle` and wait for the table to reach the phone. */
async function published(rig: BleRig, handle: number): Promise<PeripheralHandlers> {
  rig.fake.connected(handle);
  await until(() => rig.phone.handlers !== null, "the table to reach the phone");
  return rig.phone.handlers as PeripheralHandlers;
}

async function refusal(op: () => Promise<unknown>): Promise<GattOperationError> {
  const error = await assertRejects(op, GattOperationError);
  return error;
}

Deno.test("mirror: only a central connection to the mirrored node is taken", async () => {
  const rig = await bleRig();
  assertEquals(rig.lines, [`bridge ready addr=${BRIDGE_ADDR}`, "bridge connecting to sensor"]);
  assertEquals(rig.fake.count(OP.leCreateConnection), 1);
  const empty = rig.bridge.report();
  assert(empty.kind === "ble");
  assertEquals(empty.services, [], "nothing is mirrored before the first connection");

  rig.fake.connected(0x40, { role: 1 }); // the bridge as a peripheral
  rig.fake.connected(0x41, { status: 0x3e }); // failed to establish
  rig.fake.connected(0x42, { peer: "aa:bb:cc:dd:ee:ff" }); // someone else
  await published(rig, 0x43);
  await rig.bridge.close();

  assertEquals(new Set(rig.fake.pdus.map((p) => p.handle)), new Set([0x43]));
  assertEquals(rig.lines.filter((l) => l === "bridge connected to sensor").length, 1);
  assert(
    rig.lines.includes(
      "bridge discovered service 0000ff00-0000-1000-8000-00805f9b34fb with 1 characteristic(s)",
    ),
  );
  assert(
    rig.lines.includes(`bridge advertising "${BLE_BASE.name}" to the phone (a stand-in for BlueZ)`),
  );
  const report = rig.bridge.report();
  assert(report.kind === "ble");
  assertEquals(report.services, [{
    uuid: "0000ff00-0000-1000-8000-00805f9b34fb",
    characteristics: [{
      uuid: "0000ff01-0000-1000-8000-00805f9b34fb",
      handle: 0x10,
      properties: ["read", "write-without-response", "write", "notify"],
    }],
  }]);
  assertEquals(bridgeLines(report), [
    `bridge phone: mirrors sensor's GATT server as "${BLE_BASE.name}" on hci0 (a stand-in for BlueZ)`,
  ]);
  assertEquals(rig.problems, []);
  assert(rig.phone.closed);
});

Deno.test("mirror: the node's refusals reach the phone as not-permitted, the rest as failed", async () => {
  const rig = await bleRig();
  const handlers = await published(rig, 0x40);
  rig.fake.server.setValue(enc("reading:1"));

  assertEquals(dec(await handlers.read(0x10)), "reading:1");
  await handlers.write(0x10, enc("cmd"), false);
  await handlers.write(0x10, enc("req"), true);

  const declaration = await refusal(() => handlers.write(0x0e, enc("x"), true));
  assertEquals(declaration.kind, "not-permitted");
  const unknown = await refusal(() => handlers.read(0x99));
  assertEquals(unknown.kind, "failed");
  assertStringIncludes(unknown.message, "ATT error 0x01");
  const long = await refusal(() => handlers.write(0x10, new Uint8Array(21), true));
  assertEquals(long.kind, "failed");
  assertStringIncludes(long.message, "larger ATT MTU");
  await rig.bridge.close();

  assertEquals(rig.fake.written, ["cmd", "req"]);
  assert(rig.lines.includes('bridge phone read 0000ff01-0000-1000-8000-00805f9b34fb: "reading:1"'));
  assert(rig.lines.includes('bridge phone wrote 0000ff01-0000-1000-8000-00805f9b34fb: "req"'));
  assert(rig.lines.includes("bridge phone write handle 0x000e failed: ATT error 0x03"));
  assert(rig.lines.includes("bridge phone read handle 0x0099 failed: ATT error 0x01"));
  assertEquals(rig.problems, []);
});

Deno.test("mirror: subscribing writes the CCCD, unsubscribing clears it and stops the forwarding", async () => {
  const rig = await bleRig();
  const handlers = await published(rig, 0x40);

  await handlers.subscribe(0x99, true); // no such characteristic: nothing to write
  assertEquals(rig.fake.cccdWrites, []);
  await handlers.subscribe(0x10, true);
  rig.fake.att(0x40, [ATT.notify, ...u16(0x10), ...enc("n1")]);
  await until(() => rig.phone.notified.length === 1, "the notification");
  await handlers.subscribe(0x10, false);
  rig.fake.att(0x40, [ATT.notify, ...u16(0x10), ...enc("n2")]);
  await handlers.read(0x10); // a round trip: the notification before it has been handled
  await rig.bridge.close();

  assertEquals(rig.fake.cccdWrites, [[1, 0], [0, 0]]);
  assertEquals(rig.phone.notified, ["n1"], "nothing is forwarded after the unsubscribe");
  assert(rig.lines.includes("bridge phone subscribed to handle 0x0099"));
  assert(
    rig.lines.includes('bridge notify 0000ff01-0000-1000-8000-00805f9b34fb "n1" to the phone'),
  );
  assert(rig.lines.includes("bridge phone unsubscribed from 0000ff01-0000-1000-8000-00805f9b34fb"));
});

Deno.test("mirror: an indicate-only, write-only characteristic is subscribed with indications", async () => {
  const rig = await bleRig(PROPERTY.write | PROPERTY.indicate);
  const handlers = await published(rig, 0x40);

  const read = await refusal(() => handlers.read(0x10));
  assertEquals(read.kind, "not-permitted");
  assertStringIncludes(read.message, "ATT error 0x02");
  await handlers.subscribe(0x10, true);
  rig.fake.att(0x40, [ATT.indicate, ...u16(0x10), ...enc("i1")]);
  await until(() => rig.phone.notified.length === 1, "the indication");
  await until(() => rig.fake.pdus.some((p) => p.pdu[0] === ATT.confirm), "the confirmation");
  await rig.bridge.close();

  assertEquals(rig.fake.cccdWrites, [[2, 0]]);
  assertEquals(rig.phone.notified, ["i1"]);
});

Deno.test("mirror: after a drop the bridge reconnects and turns the phone's subscriptions back on", async () => {
  const rig = await bleRig();
  const handlers = await published(rig, 0x40);
  await handlers.subscribe(0x10, true);

  rig.fake.disconnected(0x77, 0x13); // not the bridge's connection
  await handlers.read(0x10);
  assertFalse(rig.lines.some((l) => l.includes("disconnected")));

  rig.fake.disconnected(0x40, 0x08);
  await until(() => rig.fake.count(OP.leCreateConnection) === 2, "the reconnection");
  const offline = await refusal(() => handlers.read(0x10));
  assertEquals(offline.kind, "failed");
  assertStringIncludes(offline.message, "not connected to sensor");

  rig.fake.connected(0x41);
  await until(() => rig.fake.cccdWrites.length === 2, "the CCCD to be written again");
  rig.fake.att(0x40, [ATT.notify, ...u16(0x10), ...enc("stale")]); // the old connection
  rig.fake.att(0x41, [ATT.notify, ...u16(0x10), ...enc("fresh")]);
  await until(() => rig.phone.notified.length > 0, "the notification on the new connection");
  await rig.bridge.close();

  assertEquals(rig.fake.cccdWrites, [[1, 0], [1, 0]]);
  assertEquals(rig.phone.notified, ["fresh"]);
  assertEquals(rig.phone.starts, 1, "the table is published once");
  assertEquals(
    rig.fake.pdus.filter((p) => p.pdu[0] === ATT.readByGroupReq).length,
    2,
    "discovery is not repeated on the reconnection",
  );
  assert(rig.lines.includes("bridge disconnected from sensor reason=0x08"));
  assert(
    rig.lines.includes(
      "bridge phone read 0000ff01-0000-1000-8000-00805f9b34fb failed: not connected to sensor",
    ),
  );
  assertEquals(rig.problems, []);
});

Deno.test("mirror: a peripheral that refuses the table is a problem, and the next connection retries", async () => {
  for (const reason of [new Error("BlueZ refused the application"), "a bare refusal"]) {
    const rig = await bleRig();
    rig.phone.refuse = reason;
    rig.fake.connected(0x40);
    await until(() => rig.problems.length === 1, "the problem");
    rig.phone.refuse = null;
    rig.fake.disconnected(0x40, 0x08);
    await published(rig, 0x41);
    await rig.bridge.close();

    assertEquals(rig.problems, [reason instanceof Error ? reason.message : reason]);
    assertEquals(rig.phone.starts, 2);
  }
});

Deno.test("mirror: closing during discovery, or right after a drop, reports nothing", async () => {
  const during = await bleRig();
  during.fake.hold = true;
  during.fake.connected(0x40);
  await until(() => during.fake.pdus.length > 0, "the discovery to start");
  await during.bridge.close();
  assertEquals(during.problems, []);
  assertEquals(during.phone.starts, 0, "nothing is published");
  assert(during.phone.closed);

  const dropped = await bleRig();
  dropped.fake.hold = true;
  dropped.fake.connected(0x40);
  await until(() => dropped.fake.pdus.length > 0, "the discovery to start");
  // The drop is handled on the next microtask; the close follows it at once.
  let closing: Promise<void> = Promise.resolve();
  dropped.fake.disconnected(0x40, 0x08);
  queueMicrotask(() => (closing = dropped.bridge.close()));
  await until(() => dropped.lines.some((l) => l.includes("disconnected")), "the drop");
  await closing;
  assertEquals(
    dropped.problems,
    [],
    "the discovery cut short by the drop is not a problem once closed",
  );
  assertEquals(dropped.fake.count(OP.leCreateConnection), 1, "no reconnection after close");
  assertEquals(dropped.lines.filter((l) => l === "bridge connecting to sensor").length, 1);
});
