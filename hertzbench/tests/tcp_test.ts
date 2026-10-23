// The engine's small TCP (engine/tcp.ts): segments a real stack accepts, and
// connections that survive the channel model's loss by retransmitting.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  buildArp,
  buildTcpFrame,
  environmentFromPreset,
  EventLog,
  ManualClock,
  Medium,
  parseArp,
  parseIpv4,
  parseTcp,
  substream,
  TCP_FLAG,
  type TcpConnection,
  TcpHost,
} from "../engine/mod.ts";

const A = { id: "a", mac: "02:68:7a:62:01:01", ip: "192.168.4.11" };
const B = { id: "b", mac: "02:68:7a:62:01:02", ip: "192.168.4.12" };

Deno.test("tcp: the checksums agree with an independent implementation", async () => {
  const frame = buildTcpFrame({
    srcMac: A.mac,
    dstMac: B.mac,
    srcIp: A.ip,
    dstIp: B.ip,
    srcPort: 49152,
    dstPort: 80,
    seq: 0x01020304,
    ack: 0,
    flags: TCP_FLAG.syn,
    window: 65535,
    mss: 1460,
    payload: new TextEncoder().encode("odd"), // an odd length exercises the padding byte
  });
  // RFC 1071 and RFC 9293 §3.1, written again in Python from the RFCs.
  const script = `
import sys
f = bytes.fromhex(sys.argv[1])
ip, tcp = f[14:34], f[34:]
def csum(b):
    if len(b) % 2: b += b"\\0"
    s = sum((b[i] << 8) | b[i + 1] for i in range(0, len(b), 2))
    while s >> 16: s = (s & 0xffff) + (s >> 16)
    return ~s & 0xffff
zeroed_ip = ip[:10] + b"\\0\\0" + ip[12:]
zeroed_tcp = tcp[:16] + b"\\0\\0" + tcp[18:]
pseudo = ip[12:20] + bytes([0, 6]) + len(tcp).to_bytes(2, "big")
print(csum(zeroed_ip) == int.from_bytes(ip[10:12], "big"),
      csum(pseudo + zeroed_tcp) == int.from_bytes(tcp[16:18], "big"))
`;
  const hex = Array.from(frame, (b) => b.toString(16).padStart(2, "0")).join("");
  const out = await new Deno.Command("python3", { args: ["-I", "-c", script, hex] }).output();
  assertEquals(new TextDecoder().decode(out.stdout).trim(), "True True");

  const ip = parseIpv4(frame);
  assert(ip);
  const seg = parseTcp(frame, ip);
  assertEquals(seg && { ...seg, payload: new TextDecoder().decode(seg.payload) }, {
    srcPort: 49152,
    dstPort: 80,
    seq: 0x01020304,
    ack: 0,
    flags: TCP_FLAG.syn,
    window: 65535,
    mss: 1460,
    payload: "odd",
  });
  const corrupt = frame.slice();
  corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] as number) ^ 0x01;
  assertEquals(parseTcp(corrupt, ip), null);
});

interface Pair {
  clock: ManualClock;
  log: EventLog;
  medium: Medium;
  a: TcpHost;
  b: TcpHost;
}

function pair(distanceM = 5): Pair {
  const clock = new ManualClock();
  const log = new EventLog();
  const medium = new Medium({
    seed: 3,
    environment: { ...environmentFromPreset("indoor_office"), shadowingSigmaDb: 0 },
    clock,
    log,
  });
  const radio = { channel: 6, txPowerDbm: 15, antennaGainDbi: 0 };
  const macs = new Map([[A.ip, A.mac], [B.ip, B.mac]]);
  const host = (node: typeof A) =>
    new TcpHost({
      mac: node.mac,
      ip: node.ip,
      clock,
      send: (frame) => medium.transmit(node.id, frame),
      macFor: (ip) => macs.get(ip) ?? null,
      rng: substream(1, `tcp:${node.id}`),
    });
  const a = host(A);
  const b = host(B);
  medium.addNode({ ...A, position: { x: 0, y: 0 }, radio }, {
    ready: () => true,
    deliver: (frame) => void a.receive(frame),
  });
  medium.addNode({ ...B, position: { x: distanceM, y: 0 }, radio }, {
    ready: () => true,
    deliver: (frame) => void b.receive(frame),
  });
  return { clock, log, medium, a, b };
}

/** Let time pass in small steps, running promise callbacks between them, until `done` or `ms` passed. */
async function run(clock: ManualClock, ms: number, stepMs = 1, done = () => false): Promise<void> {
  const end = clock.now() + ms;
  while (clock.now() < end && !done()) {
    clock.advanceTo(Math.min(end, clock.now() + stepMs));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function collect(conn: TcpConnection) {
  const chunks: Uint8Array[] = [];
  const seen = { ended: false, closed: false as boolean, error: null as string | null };
  conn.onData((bytes) => chunks.push(bytes));
  conn.onEnd(() => (seen.ended = true));
  conn.onClose((error) => {
    seen.closed = true;
    seen.error = error?.message ?? null;
  });
  const text = () => new TextDecoder().decode(Uint8Array.from(chunks.flatMap((c) => [...c])));
  return { chunks, seen, text };
}

Deno.test("tcp: connect, talk both ways, half-close, then close cleanly", async () => {
  const { clock, a, b, log } = pair();
  let server: ReturnType<typeof collect> | null = null;
  b.listen(80, (conn) => {
    server = collect(conn);
    conn.onData((bytes) => {
      server?.chunks.push(bytes);
      void conn.write(new TextEncoder().encode(`echo ${new TextDecoder().decode(bytes)}`));
    });
    conn.onEnd(() => conn.end());
  });
  const connecting = a.connect(B.ip, 80);
  await run(clock, 20);
  const conn = await connecting;
  const client = collect(conn);
  await conn.write(new TextEncoder().encode("hello"));
  await run(clock, 20);
  assertEquals(client.text(), "echo hello");
  conn.end();
  await run(clock, 20);
  assertEquals(client.seen, { ended: true, closed: true, error: null });
  assertEquals((server as ReturnType<typeof collect> | null)?.seen.closed, true);
  assertEquals(conn.state, "closed");
  // Every segment crossed the medium as TCP and was judged by the channel model.
  const tcp = log.events.filter((e) => e.type === "deliver" && e.kind === "tcp");
  assert(tcp.length >= 8, `expected the handshake, data, ACKs and FINs, got ${tcp.length}`);
});

Deno.test("tcp: 20 KB arrive intact and in order through 30% loss each way", async () => {
  const { clock, a, b, medium, log } = pair();
  medium.setLinkOverride("a", "b", { extraLossPct: 30, extraLatencyMs: 2 });
  medium.setLinkOverride("b", "a", { extraLossPct: 30, extraLatencyMs: 2 });
  let received: ReturnType<typeof collect> | null = null;
  b.listen(9000, (conn) => {
    received = collect(conn);
  });
  let connected = false;
  const connecting = a.connect(B.ip, 9000).finally(() => (connected = true));
  await run(clock, 20_000, 5, () => connected);
  const conn = await connecting;
  const payload = Uint8Array.from({ length: 20_000 }, (_, i) => (i * 7) & 0xff);
  await conn.write(payload);
  conn.end();
  const server = () => received as ReturnType<typeof collect> | null;
  await run(clock, 120_000, 20, () => server()?.seen.ended === true);
  const got = server();
  assert(got, "the server accepted no connection");
  const joined = Uint8Array.from(got.chunks.flatMap((c) => [...c]));
  assertEquals(joined.length, payload.length);
  assertEquals(joined, payload);
  assertEquals(got.seen.ended, true);
  const lost = log.events.filter((e) => e.type === "drop" && e.kind === "tcp").length;
  assert(lost > 10, `the override should have cost segments, lost ${lost}`);
});

Deno.test("tcp: a closed port refuses, and a station that never answers times out", async () => {
  const { clock, a, b, medium } = pair();
  const refused = a.connect(B.ip, 81);
  const refusedCheck = assertRejects(
    () => refused,
    Error,
    "192.168.4.12:81 refused the connection",
  );
  await run(clock, 20);
  await refusedCheck;

  b.listen(80, () => {});
  medium.setLinkOverride("a", "b", { extraLossPct: 100, extraLatencyMs: 0 });
  const silent = a.connect(B.ip, 80);
  const silentCheck = assertRejects(() => silent, Error, "no answer from 192.168.4.12:80");
  await run(clock, 40_000, 250);
  await silentCheck;
});

Deno.test("tcp: a host answers ARP for its own address only", () => {
  const sent: Uint8Array[] = [];
  const host = new TcpHost({
    mac: A.mac,
    ip: A.ip,
    clock: new ManualClock(),
    send: (frame) => sent.push(frame),
    macFor: () => null,
    rng: substream(1, "arp"),
  });
  const ask = (targetIp: string) =>
    buildArp({
      operation: 1,
      senderMac: B.mac,
      senderIp: B.ip,
      targetMac: "00:00:00:00:00:00",
      targetIp,
    });
  assertEquals(host.receive(ask("192.168.4.99")), false);
  assertEquals(sent.length, 0);
  assertEquals(host.receive(ask(A.ip)), true);
  assertEquals(parseArp(sent[0] as Uint8Array), {
    operation: 2,
    senderMac: A.mac,
    senderIp: A.ip,
    targetMac: B.mac,
    targetIp: B.ip,
  });
});
