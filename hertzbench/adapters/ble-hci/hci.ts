// HCI as it crosses a UART: the H4 transport (one indicator byte, then the
// packet) and the commands and events the virtual controller speaks. Opcodes
// and event codes match the Bluetooth Core Specification v5.x, Vol 4 Part E
// §7, and BlueZ's lib/hci.h.

export const H4_COMMAND = 0x01;
export const H4_ACL = 0x02;
export const H4_EVENT = 0x04;

export type HciPacket =
  | { type: "command"; opcode: number; params: Uint8Array }
  | {
    type: "acl";
    handle: number;
    /** Packet boundary flag: 0b00 first non-flushable, 0b01 continuation, 0b10 first flushable. */
    pb: number;
    data: Uint8Array;
  }
  | { type: "event"; code: number; params: Uint8Array };

export class HciProtocolError extends Error {
  override name = "HciProtocolError";
}

export function opcode(ogf: number, ocf: number): number {
  return (ogf << 10) | ocf;
}

export const OP = {
  disconnect: opcode(0x01, 0x0006),
  readRemoteVersion: opcode(0x01, 0x001d),
  setEventMask: opcode(0x03, 0x0001),
  reset: opcode(0x03, 0x0003),
  setControllerToHostFlowControl: opcode(0x03, 0x0031),
  hostBufferSize: opcode(0x03, 0x0033),
  hostNumberOfCompletedPackets: opcode(0x03, 0x0035),
  setEventMaskPage2: opcode(0x03, 0x0063),
  readLeHostSupport: opcode(0x03, 0x006c),
  writeLeHostSupport: opcode(0x03, 0x006d),
  readLocalVersion: opcode(0x04, 0x0001),
  readLocalCommands: opcode(0x04, 0x0002),
  readLocalFeatures: opcode(0x04, 0x0003),
  readLocalExtendedFeatures: opcode(0x04, 0x0004),
  readBufferSize: opcode(0x04, 0x0005),
  readBdAddr: opcode(0x04, 0x0009),
  readRssi: opcode(0x05, 0x0005),
  leSetEventMask: opcode(0x08, 0x0001),
  leReadBufferSize: opcode(0x08, 0x0002),
  leReadLocalFeatures: opcode(0x08, 0x0003),
  leSetRandomAddress: opcode(0x08, 0x0005),
  leSetAdvParams: opcode(0x08, 0x0006),
  leReadAdvTxPower: opcode(0x08, 0x0007),
  leSetAdvData: opcode(0x08, 0x0008),
  leSetScanRspData: opcode(0x08, 0x0009),
  leSetAdvEnable: opcode(0x08, 0x000a),
  leSetScanParams: opcode(0x08, 0x000b),
  leSetScanEnable: opcode(0x08, 0x000c),
  leCreateConnection: opcode(0x08, 0x000d),
  leCreateConnectionCancel: opcode(0x08, 0x000e),
  leReadAcceptListSize: opcode(0x08, 0x000f),
  leClearAcceptList: opcode(0x08, 0x0010),
  leAddToAcceptList: opcode(0x08, 0x0011),
  leRemoveFromAcceptList: opcode(0x08, 0x0012),
  leConnectionUpdate: opcode(0x08, 0x0013),
  leReadRemoteFeatures: opcode(0x08, 0x0016),
  leEncrypt: opcode(0x08, 0x0017),
  leRand: opcode(0x08, 0x0018),
  leReadSupportedStates: opcode(0x08, 0x001c),
} as const;

export const EVT = {
  disconnectionComplete: 0x05,
  readRemoteVersionComplete: 0x0c,
  commandComplete: 0x0e,
  commandStatus: 0x0f,
  numberOfCompletedPackets: 0x13,
  leMeta: 0x3e,
} as const;

export const LE_SUBEVENT = {
  connectionComplete: 0x01,
  advertisingReport: 0x02,
  connectionUpdateComplete: 0x03,
  readRemoteFeaturesComplete: 0x04,
} as const;

/** HCI error codes (Vol 1 Part F). */
export const STATUS = {
  success: 0x00,
  unknownCommand: 0x01,
  unknownConnection: 0x02,
  commandDisallowed: 0x0c,
  unsupportedParameter: 0x11,
  invalidParameters: 0x12,
  remoteUserTerminated: 0x13,
  localHostTerminated: 0x16,
  unsupportedRemoteFeature: 0x1a,
  instantPassed: 0x28,
  connectionTimeout: 0x08,
  connectionFailedToEstablish: 0x3e,
} as const;

/**
 * The Supported_Commands bitmap (Vol 4 Part E §6.27): octet and bit of each
 * command this controller answers. Read Local Supported Commands itself has
 * no bit. A host reads this to decide what it may send, so it must list
 * exactly what the controller implements; tests/ble_hci_test.ts has btmon
 * decode it back to command names.
 */
export const SUPPORTED_COMMAND_BITS: ReadonlyArray<readonly [octet: number, bit: number]> = [
  [0, 5], // Disconnect
  [2, 7], // Read Remote Version Information
  [5, 6], // Set Event Mask
  [5, 7], // Reset
  [10, 5], // Set Controller To Host Flow Control
  [10, 6], // Host Buffer Size
  [10, 7], // Host Number Of Completed Packets
  [14, 3], // Read Local Version Information
  [14, 5], // Read Local Supported Features
  [14, 6], // Read Local Extended Features
  [14, 7], // Read Buffer Size
  [15, 1], // Read BD_ADDR
  [15, 5], // Read RSSI
  [22, 2], // Set Event Mask Page 2
  [24, 5], // Read LE Host Support
  [24, 6], // Write LE Host Support
  [25, 0], // LE Set Event Mask
  [25, 1], // LE Read Buffer Size
  [25, 2], // LE Read Local Supported Features
  [25, 4], // LE Set Random Address
  [25, 5], // LE Set Advertising Parameters
  [25, 6], // LE Read Advertising Channel TX Power
  [25, 7], // LE Set Advertising Data
  [26, 0], // LE Set Scan Response Data
  [26, 1], // LE Set Advertising Enable
  [26, 2], // LE Set Scan Parameters
  [26, 3], // LE Set Scan Enable
  [26, 4], // LE Create Connection
  [26, 5], // LE Create Connection Cancel
  [26, 6], // LE Read Filter Accept List Size
  [26, 7], // LE Clear Filter Accept List
  [27, 0], // LE Add Device To Filter Accept List
  [27, 1], // LE Remove Device From Filter Accept List
  [27, 2], // LE Connection Update
  [27, 5], // LE Read Remote Features
  [27, 6], // LE Encrypt
  [27, 7], // LE Rand
  [28, 3], // LE Read Supported States
];

export function supportedCommands(): Uint8Array {
  const bitmap = new Uint8Array(64);
  for (const [octet, bit] of SUPPORTED_COMMAND_BITS) {
    bitmap[octet] = (bitmap[octet] as number) | (1 << bit);
  }
  return bitmap;
}

// ── encoding ────────────────────────────────────────────────────────────────

export function encodeHci(packet: HciPacket): Uint8Array {
  switch (packet.type) {
    case "command": {
      if (packet.params.length > 255) throw new RangeError("command parameters over 255 bytes");
      const out = new Uint8Array(4 + packet.params.length);
      out[0] = H4_COMMAND;
      out[1] = packet.opcode & 0xff;
      out[2] = packet.opcode >> 8;
      out[3] = packet.params.length;
      out.set(packet.params, 4);
      return out;
    }
    case "acl": {
      const out = new Uint8Array(5 + packet.data.length);
      const word = (packet.handle & 0x0fff) | ((packet.pb & 3) << 12);
      out[0] = H4_ACL;
      out[1] = word & 0xff;
      out[2] = word >> 8;
      out[3] = packet.data.length & 0xff;
      out[4] = packet.data.length >> 8;
      out.set(packet.data, 5);
      return out;
    }
    case "event": {
      if (packet.params.length > 255) throw new RangeError("event parameters over 255 bytes");
      const out = new Uint8Array(3 + packet.params.length);
      out[0] = H4_EVENT;
      out[1] = packet.code;
      out[2] = packet.params.length;
      out.set(packet.params, 3);
      return out;
    }
  }
}

/** Reassembles H4 packets from arbitrary chunks of a byte stream. */
export class H4Decoder {
  #pending = new Uint8Array(0);

  push(chunk: Uint8Array): HciPacket[] {
    const joined = new Uint8Array(this.#pending.length + chunk.length);
    joined.set(this.#pending);
    joined.set(chunk, this.#pending.length);
    const out: HciPacket[] = [];
    let offset = 0;
    for (;;) {
      const rest = joined.length - offset;
      if (rest < 1) break;
      const type = joined[offset] as number;
      const headerLength = type === H4_COMMAND
        ? 3
        : type === H4_ACL
        ? 4
        : type === H4_EVENT
        ? 2
        : -1;
      if (headerLength < 0) {
        throw new HciProtocolError(
          `ble-hci: unknown H4 packet indicator 0x${
            type.toString(16).padStart(2, "0")
          }; the stream is corrupt or not HCI`,
        );
      }
      if (rest < 1 + headerLength) break;
      const h = offset + 1;
      const b = (i: number) => joined[h + i] as number;
      const bodyLength = type === H4_COMMAND ? b(2) : type === H4_ACL ? b(2) | (b(3) << 8) : b(1);
      if (rest < 1 + headerLength + bodyLength) break;
      const body = joined.slice(h + headerLength, h + headerLength + bodyLength);
      if (type === H4_COMMAND) {
        out.push({ type: "command", opcode: b(0) | (b(1) << 8), params: body });
      } else if (type === H4_ACL) {
        const word = b(0) | (b(1) << 8);
        out.push({ type: "acl", handle: word & 0x0fff, pb: (word >> 12) & 3, data: body });
      } else out.push({ type: "event", code: b(0), params: body });
      offset += 1 + headerLength + bodyLength;
    }
    this.#pending = joined.slice(offset);
    return out;
  }
}

// ── small byte helpers shared by the controller and the scripted host ───────

export function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

export function readU16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0;
}

/** "02:68:7a:62:01:05" to the 6 bytes HCI and the air carry, least significant first. */
export function addressToBytes(address: string): Uint8Array {
  const parts = address.split(":");
  if (parts.length !== 6 || parts.some((p) => !/^[0-9a-fA-F]{2}$/.test(p))) {
    throw new RangeError(`not a Bluetooth device address: ${JSON.stringify(address)}`);
  }
  return Uint8Array.from(parts.reverse().map((p) => Number.parseInt(p, 16)));
}

export function addressToString(bytes: Uint8Array): string {
  return [...bytes.slice(0, 6)].reverse().map((b) => b.toString(16).padStart(2, "0")).join(":");
}
