// The virtual gateway: the one wired, ideal "infrastructure" station on the
// switch. A QEMU socket netdev has no DHCP, ARP or DNS peer (SLIRP provides
// them today), so this answers the two things a board needs to get an address:
// ARP for the gateway IP and DHCP with a static lease per board MAC. The leases
// come from the scenario, so addresses stay fixed. There is no DNS.
//
// Frames to and from the gateway bypass the channel model: they carry no
// payload a scenario measures, and losing them would make a far node fail to
// boot instead of losing UDP datagrams.

import {
  buildArp,
  buildEthernet,
  ETHERTYPE_IPV4,
  internetChecksum,
  ipToBytes,
  ipToString,
  macToBytes,
  macToString,
  parseArp,
  parseIpv4,
  parseUdp,
} from "./packet.ts";

const DHCP_SERVER_PORT = 67;
const DHCP_CLIENT_PORT = 68;
const BOOTP_FIXED_BYTES = 236;
const DHCP_MAGIC_COOKIE = [99, 130, 83, 99];
const MIN_DHCP_BYTES = 300;

const DHCPDISCOVER = 1;
const DHCPOFFER = 2;
const DHCPREQUEST = 3;
const DHCPACK = 5;
const DHCPNAK = 6;

export interface GatewayConfig {
  mac: string;
  ip: string;
  /** Dotted-quad subnet mask, e.g. 255.255.255.0. */
  subnetMask: string;
  /** Client station MAC to the IPv4 address it is handed. */
  leases: ReadonlyMap<string, string>;
  leaseSeconds?: number;
}

export interface GatewayResult {
  /** Frames to send back to the station that asked. */
  replies: Uint8Array[];
  /** One line for the event log. */
  detail: string;
  service: "arp" | "dhcp";
}

interface DhcpRequest {
  xid: Uint8Array;
  flags: Uint8Array;
  clientMac: string;
  messageType: number;
  requestedIp: string | null;
}

function parseDhcp(payload: Uint8Array): DhcpRequest | null {
  if (payload.length < BOOTP_FIXED_BYTES + 4 || payload[0] !== 1 || payload[1] !== 1) return null;
  if (payload[2] !== 6) return null; // hardware address length
  if (DHCP_MAGIC_COOKIE.some((b, i) => payload[BOOTP_FIXED_BYTES + i] !== b)) return null;
  let messageType = 0;
  let requestedIp: string | null = null;
  let i = BOOTP_FIXED_BYTES + 4;
  while (i < payload.length) {
    const code = payload[i] ?? 255;
    if (code === 255) break;
    if (code === 0) {
      i++;
      continue;
    }
    const length = payload[i + 1] ?? 0;
    const start = i + 2;
    if (start + length > payload.length) return null; // truncated option
    if (code === 53 && length === 1) messageType = payload[start] ?? 0;
    if (code === 50 && length === 4) requestedIp = ipToString(payload, start);
    i = start + length;
  }
  if (messageType === 0) return null;
  return {
    xid: payload.slice(4, 8),
    flags: payload.slice(10, 12),
    clientMac: macToString(payload, 28),
    messageType,
    requestedIp,
  };
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

export class VirtualGateway {
  readonly mac: string;
  readonly ip: string;
  readonly #config: GatewayConfig;

  constructor(config: GatewayConfig) {
    macToBytes(config.mac);
    ipToBytes(config.ip);
    ipToBytes(config.subnetMask);
    this.mac = config.mac;
    this.ip = config.ip;
    this.#config = config;
  }

  /** The station MAC whose lease is `ip`, if any. */
  stationForIp(ip: string): string | undefined {
    for (const [mac, leased] of this.#config.leases) if (leased === ip) return mac;
    return undefined;
  }

  /** The gateway's answer to `frame`, or null when the frame is not addressed to it. */
  handle(frame: Uint8Array): GatewayResult | null {
    const arp = parseArp(frame);
    if (arp) {
      if (arp.operation !== 1 || arp.targetIp !== this.ip) return null;
      return {
        service: "arp",
        detail: `${this.ip} is-at ${this.mac} for ${arp.senderIp}`,
        replies: [buildArp({
          operation: 2,
          senderMac: this.mac,
          senderIp: this.ip,
          targetMac: arp.senderMac,
          targetIp: arp.senderIp,
        })],
      };
    }
    const ip = parseIpv4(frame);
    if (!ip) return null;
    const udp = parseUdp(frame, ip);
    if (!udp || udp.dstPort !== DHCP_SERVER_PORT) return null;
    const request = parseDhcp(udp.payload);
    if (!request) return { service: "dhcp", detail: "ignored malformed DHCP message", replies: [] };
    return this.#answerDhcp(request);
  }

  #answerDhcp(request: DhcpRequest): GatewayResult {
    const lease = this.#config.leases.get(request.clientMac);
    if (!lease) {
      return {
        service: "dhcp",
        detail: `no lease configured for ${request.clientMac}`,
        replies: [],
      };
    }
    if (request.messageType === DHCPDISCOVER) {
      return {
        service: "dhcp",
        detail: `offer ${lease} to ${request.clientMac}`,
        replies: [this.#dhcpReply(request, DHCPOFFER, lease)],
      };
    }
    if (request.messageType === DHCPREQUEST) {
      const wanted = request.requestedIp;
      if (wanted !== null && wanted !== lease) {
        return {
          service: "dhcp",
          detail: `nak ${wanted} to ${request.clientMac}, its lease is ${lease}`,
          replies: [this.#dhcpReply(request, DHCPNAK, "0.0.0.0")],
        };
      }
      return {
        service: "dhcp",
        detail: `ack ${lease} to ${request.clientMac}`,
        replies: [this.#dhcpReply(request, DHCPACK, lease)],
      };
    }
    return {
      service: "dhcp",
      detail: `ignored DHCP message type ${request.messageType} from ${request.clientMac}`,
      replies: [],
    };
  }

  #dhcpReply(request: DhcpRequest, type: number, yourIp: string): Uint8Array {
    const options: number[] = [53, 1, type, 54, 4, ...ipToBytes(this.ip)];
    if (type !== DHCPNAK) {
      options.push(
        51,
        4,
        ...u32(this.#config.leaseSeconds ?? 86400),
        1,
        4,
        ...ipToBytes(this.#config.subnetMask),
        3,
        4,
        ...ipToBytes(this.ip),
      );
    }
    options.push(255);
    const body = new Uint8Array(Math.max(MIN_DHCP_BYTES, BOOTP_FIXED_BYTES + 4 + options.length));
    body[0] = 2; // BOOTREPLY
    body[1] = 1; // Ethernet
    body[2] = 6;
    body.set(request.xid, 4);
    body.set(request.flags, 10);
    body.set(ipToBytes(yourIp), 16);
    body.set(ipToBytes(this.ip), 20); // siaddr
    body.set(macToBytes(request.clientMac), 28);
    body.set(DHCP_MAGIC_COOKIE, BOOTP_FIXED_BYTES);
    body.set(options, BOOTP_FIXED_BYTES + 4);

    // IP destination 255.255.255.255 is accepted by a client that has no
    // address yet; the Ethernet destination is the client's own MAC.
    const udpLength = 8 + body.length;
    const packet = new Uint8Array(20 + udpLength);
    packet[0] = 0x45;
    packet[2] = packet.length >>> 8;
    packet[3] = packet.length & 0xff;
    packet[8] = 64;
    packet[9] = 17;
    packet.set(ipToBytes(this.ip), 12);
    packet.set([255, 255, 255, 255], 16);
    const checksum = internetChecksum(packet.subarray(0, 20));
    packet[10] = checksum >>> 8;
    packet[11] = checksum & 0xff;
    packet[20] = DHCP_SERVER_PORT >>> 8;
    packet[21] = DHCP_SERVER_PORT & 0xff;
    packet[22] = DHCP_CLIENT_PORT >>> 8;
    packet[23] = DHCP_CLIENT_PORT & 0xff;
    packet[24] = udpLength >>> 8;
    packet[25] = udpLength & 0xff;
    packet.set(body, 28);
    return buildEthernet(request.clientMac, this.mac, ETHERTYPE_IPV4, packet);
  }
}
