// Just enough Ethernet / ARP / IPv4 / UDP to classify frames and to let the
// virtual gateway answer ARP and DHCP. Everything else is carried as opaque bytes.

import type { FrameKind } from "./events.ts";

export const ETHERTYPE_IPV4 = 0x0800;
export const ETHERTYPE_ARP = 0x0806;
export const BROADCAST_MAC = "ff:ff:ff:ff:ff:ff";

const ETHERNET_HEADER_BYTES = 14;
const IPV4_MIN_HEADER_BYTES = 20;
const UDP_HEADER_BYTES = 8;

export function macToBytes(mac: string): Uint8Array {
  const parts = mac.split(":");
  const bytes = parts.map((p) => Number.parseInt(p, 16));
  if (
    parts.length !== 6 ||
    bytes.some((b, i) => !Number.isInteger(b) || b < 0 || b > 255 || (parts[i] ?? "").length !== 2)
  ) {
    throw new TypeError(`not a MAC address: ${JSON.stringify(mac)}`);
  }
  return Uint8Array.from(bytes);
}

export function macToString(bytes: Uint8Array, offset = 0): string {
  return Array.from(bytes.subarray(offset, offset + 6), (b) => b.toString(16).padStart(2, "0"))
    .join(":");
}

export function ipToBytes(ip: string): Uint8Array {
  const parts = ip.split(".");
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (parts.length !== 4 || bytes.some((b) => !(b >= 0 && b <= 255))) {
    throw new TypeError(`not an IPv4 address: ${JSON.stringify(ip)}`);
  }
  return Uint8Array.from(bytes);
}

export function ipToString(bytes: Uint8Array, offset = 0): string {
  return Array.from(bytes.subarray(offset, offset + 4)).join(".");
}

/** True for multicast and broadcast destinations (group bit of the first octet). */
export function isGroupMac(mac: string): boolean {
  return (Number.parseInt(mac.slice(0, 2), 16) & 1) === 1;
}

export interface EthernetHeader {
  dst: string;
  src: string;
  etherType: number;
}

export function parseEthernet(frame: Uint8Array): EthernetHeader | null {
  if (frame.length < ETHERNET_HEADER_BYTES) return null;
  return {
    dst: macToString(frame, 0),
    src: macToString(frame, 6),
    etherType: (frame[12] ?? 0) << 8 | (frame[13] ?? 0),
  };
}

export interface Ipv4Packet {
  protocol: number;
  src: string;
  dst: string;
  /** Offset of the IP payload inside the Ethernet frame. */
  payloadOffset: number;
  payloadEnd: number;
}

export function parseIpv4(frame: Uint8Array): Ipv4Packet | null {
  const eth = parseEthernet(frame);
  if (!eth || eth.etherType !== ETHERTYPE_IPV4) return null;
  const base = ETHERNET_HEADER_BYTES;
  if (frame.length < base + IPV4_MIN_HEADER_BYTES) return null;
  const headerBytes = ((frame[base] ?? 0) & 0x0f) * 4;
  const totalBytes = (frame[base + 2] ?? 0) << 8 | (frame[base + 3] ?? 0);
  if (headerBytes < IPV4_MIN_HEADER_BYTES || base + headerBytes > frame.length) return null;
  const end = Math.min(frame.length, base + totalBytes);
  return {
    protocol: frame[base + 9] ?? 0,
    src: ipToString(frame, base + 12),
    dst: ipToString(frame, base + 16),
    payloadOffset: base + headerBytes,
    payloadEnd: end,
  };
}

export interface UdpDatagram {
  srcPort: number;
  dstPort: number;
  payload: Uint8Array;
}

export function parseUdp(frame: Uint8Array, ip: Ipv4Packet): UdpDatagram | null {
  if (ip.protocol !== 17 || ip.payloadEnd - ip.payloadOffset < UDP_HEADER_BYTES) return null;
  const o = ip.payloadOffset;
  return {
    srcPort: (frame[o] ?? 0) << 8 | (frame[o + 1] ?? 0),
    dstPort: (frame[o + 2] ?? 0) << 8 | (frame[o + 3] ?? 0),
    payload: frame.subarray(o + UDP_HEADER_BYTES, ip.payloadEnd),
  };
}

// Pseudo-Ethernet that the lcgamboa fork uses for ESP-NOW action frames and
// their ACKs: ethertype bytes are [0xE0 | channel, type/subtype] (ADR 0001).
function isEspNowPseudoEthernet(frame: Uint8Array): boolean {
  return ((frame[12] ?? 0) & 0xf0) === 0xe0;
}

export function classifyFrame(frame: Uint8Array): FrameKind {
  if (isEspNowPseudoEthernet(frame)) return "espnow-pseudo-ethernet";
  const eth = parseEthernet(frame);
  if (!eth) return "other";
  if (eth.etherType === ETHERTYPE_ARP) return "arp";
  const ip = parseIpv4(frame);
  if (!ip) return "other";
  if (ip.protocol === 17) {
    const udp = parseUdp(frame, ip);
    if (udp && (udp.dstPort === 67 || udp.dstPort === 68)) return "dhcp";
    return "udp";
  }
  if (ip.protocol === 6) return "tcp";
  if (ip.protocol === 1) return "icmp";
  return "ipv4";
}

// ── builders ────────────────────────────────────────────────────────────────

/** Internet checksum (RFC 1071) over `data`. */
export function internetChecksum(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 2) sum += ((data[i] ?? 0) << 8) | (data[i + 1] ?? 0);
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}

export function buildEthernet(dst: string, src: string, etherType: number, payload: Uint8Array) {
  const frame = new Uint8Array(ETHERNET_HEADER_BYTES + payload.length);
  frame.set(macToBytes(dst), 0);
  frame.set(macToBytes(src), 6);
  frame[12] = etherType >>> 8;
  frame[13] = etherType & 0xff;
  frame.set(payload, ETHERNET_HEADER_BYTES);
  return frame;
}

export interface ArpMessage {
  operation: 1 | 2;
  senderMac: string;
  senderIp: string;
  targetMac: string;
  targetIp: string;
}

export function parseArp(frame: Uint8Array): ArpMessage | null {
  const eth = parseEthernet(frame);
  if (!eth || eth.etherType !== ETHERTYPE_ARP || frame.length < ETHERNET_HEADER_BYTES + 28) {
    return null;
  }
  const o = ETHERNET_HEADER_BYTES;
  const operation = (frame[o + 6] ?? 0) << 8 | (frame[o + 7] ?? 0);
  if (operation !== 1 && operation !== 2) return null;
  return {
    operation,
    senderMac: macToString(frame, o + 8),
    senderIp: ipToString(frame, o + 14),
    targetMac: macToString(frame, o + 18),
    targetIp: ipToString(frame, o + 24),
  };
}

export function buildArp(message: ArpMessage): Uint8Array {
  const body = new Uint8Array(28);
  body.set([0, 1, 0x08, 0x00, 6, 4, 0, message.operation], 0);
  body.set(macToBytes(message.senderMac), 8);
  body.set(ipToBytes(message.senderIp), 14);
  body.set(macToBytes(message.targetMac), 18);
  body.set(ipToBytes(message.targetIp), 24);
  const dst = message.operation === 1 ? BROADCAST_MAC : message.targetMac;
  return buildEthernet(dst, message.senderMac, ETHERTYPE_ARP, body);
}

export interface UdpSpec {
  srcMac: string;
  dstMac: string;
  srcIp: string;
  dstIp: string;
  srcPort: number;
  dstPort: number;
  payload: Uint8Array;
}

/** Ethernet + IPv4 + UDP. The UDP checksum is left 0, which IPv4 allows. */
export function buildUdp(spec: UdpSpec): Uint8Array {
  const udpLength = UDP_HEADER_BYTES + spec.payload.length;
  const packet = new Uint8Array(IPV4_MIN_HEADER_BYTES + udpLength);
  const totalLength = packet.length;
  packet[0] = 0x45;
  packet[2] = totalLength >>> 8;
  packet[3] = totalLength & 0xff;
  packet[8] = 64; // TTL
  packet[9] = 17; // UDP
  packet.set(ipToBytes(spec.srcIp), 12);
  packet.set(ipToBytes(spec.dstIp), 16);
  const checksum = internetChecksum(packet.subarray(0, IPV4_MIN_HEADER_BYTES));
  packet[10] = checksum >>> 8;
  packet[11] = checksum & 0xff;
  const u = IPV4_MIN_HEADER_BYTES;
  packet[u] = spec.srcPort >>> 8;
  packet[u + 1] = spec.srcPort & 0xff;
  packet[u + 2] = spec.dstPort >>> 8;
  packet[u + 3] = spec.dstPort & 0xff;
  packet[u + 4] = udpLength >>> 8;
  packet[u + 5] = udpLength & 0xff;
  packet.set(spec.payload, u + UDP_HEADER_BYTES);
  return buildEthernet(spec.dstMac, spec.srcMac, ETHERTYPE_IPV4, packet);
}
