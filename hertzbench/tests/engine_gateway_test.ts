import { assert, assertEquals } from "@std/assert";
import {
  buildArp,
  internetChecksum,
  parseArp,
  parseEthernet,
  parseIpv4,
  parseUdp,
  VirtualGateway,
} from "../engine/mod.ts";
import {
  dhcpClientMessage,
  GATEWAY_IP,
  GATEWAY_MAC,
  ipFor,
  macFor,
  makeRig,
  udpFrame,
} from "./helpers.ts";

function gateway(): VirtualGateway {
  return new VirtualGateway({
    mac: GATEWAY_MAC,
    ip: GATEWAY_IP,
    subnetMask: "255.255.255.0",
    leases: new Map([[macFor(1), ipFor(1)], [macFor(2), ipFor(2)]]),
  });
}

function options(bootp: Uint8Array): Map<number, Uint8Array> {
  const found = new Map<number, Uint8Array>();
  let i = 240;
  while (i < bootp.length && bootp[i] !== 255) {
    const length = bootp[i + 1]!;
    found.set(bootp[i]!, bootp.slice(i + 2, i + 2 + length));
    i += 2 + length;
  }
  return found;
}

Deno.test("dhcp: DISCOVER gets an OFFER of the board's lease, addressed to its MAC", () => {
  const result = gateway().handle(dhcpClientMessage(macFor(1), 1, 0xdeadbeef));
  assert(result);
  assertEquals(result.replies.length, 1);
  const reply = result.replies[0]!;

  const eth = parseEthernet(reply)!;
  assertEquals(eth.dst, macFor(1)); // L2 destination is the client's chaddr
  assertEquals(eth.src, GATEWAY_MAC);

  const ip = parseIpv4(reply)!;
  assertEquals(ip.dst, "255.255.255.255"); // a client with no address still accepts this
  assertEquals(ip.src, GATEWAY_IP);
  assertEquals(internetChecksum(reply.subarray(14, 34)), 0, "IPv4 header checksum must verify");

  const udp = parseUdp(reply, ip)!;
  assertEquals([udp.srcPort, udp.dstPort], [67, 68]);
  const bootp = udp.payload;
  assertEquals(bootp[0], 2); // BOOTREPLY
  assertEquals(new DataView(bootp.buffer, bootp.byteOffset).getUint32(4), 0xdeadbeef); // xid echoed
  assertEquals(Array.from(bootp.subarray(16, 20)), [192, 168, 4, 11]); // yiaddr
  assertEquals(Array.from(bootp.subarray(236, 240)), [99, 130, 83, 99]);
  const opts = options(bootp);
  assertEquals(Array.from(opts.get(53)!), [2]); // OFFER
  assertEquals(Array.from(opts.get(54)!), [192, 168, 4, 1]); // server identifier
  assertEquals(Array.from(opts.get(1)!), [255, 255, 255, 0]);
  assertEquals(Array.from(opts.get(3)!), [192, 168, 4, 1]); // router
  assert(!opts.has(6), "there is no DNS server to advertise");
  assert(bootp.length >= 300);
});

Deno.test("dhcp: REQUEST for the leased address gets an ACK", () => {
  const result = gateway().handle(dhcpClientMessage(macFor(2), 3, 7, ipFor(2)))!;
  const udp = parseUdp(result.replies[0]!, parseIpv4(result.replies[0]!)!)!;
  assertEquals(Array.from(options(udp.payload).get(53)!), [5]); // ACK
  assertEquals(Array.from(udp.payload.subarray(16, 20)), [192, 168, 4, 12]);
});

Deno.test("dhcp: REQUEST for an address that is not the lease gets a NAK", () => {
  const result = gateway().handle(dhcpClientMessage(macFor(2), 3, 7, "192.168.4.99"))!;
  const udp = parseUdp(result.replies[0]!, parseIpv4(result.replies[0]!)!)!;
  assertEquals(Array.from(options(udp.payload).get(53)!), [6]); // NAK
});

Deno.test("dhcp: a MAC with no lease gets no answer, and a malformed message is ignored", () => {
  const unknown = gateway().handle(dhcpClientMessage("02:00:00:00:00:99", 1, 1))!;
  assertEquals(unknown.replies.length, 0);
  const truncated = dhcpClientMessage(macFor(1), 1, 1).slice(0, 14 + 20 + 8 + 100);
  // Rebuilding the lengths is not worth it: the parser must reject it either way.
  const malformed = gateway().handle(truncated);
  assert(malformed === null || malformed.replies.length === 0);
});

Deno.test("arp: the gateway answers who-has for its own IP only", () => {
  const request = buildArp({
    operation: 1,
    senderMac: macFor(1),
    senderIp: ipFor(1),
    targetMac: "00:00:00:00:00:00",
    targetIp: GATEWAY_IP,
  });
  const result = gateway().handle(request)!;
  const reply = parseArp(result.replies[0]!)!;
  assertEquals(reply.operation, 2);
  assertEquals(reply.senderMac, GATEWAY_MAC);
  assertEquals(reply.senderIp, GATEWAY_IP);
  assertEquals(reply.targetMac, macFor(1));
  assertEquals(parseEthernet(result.replies[0]!)!.dst, macFor(1));

  const other = buildArp({
    operation: 1,
    senderMac: macFor(1),
    senderIp: ipFor(1),
    targetMac: "00:00:00:00:00:00",
    targetIp: ipFor(2),
  });
  assertEquals(gateway().handle(other), null);
});

Deno.test("gateway: ordinary traffic between boards is not its business", () => {
  const rig = makeRig({ positions: { a: { x: 0, y: 0 }, b: { x: 1, y: 0 } } });
  assertEquals(gateway().handle(udpFrame(rig, "a", "b")), null);
});
