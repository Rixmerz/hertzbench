// Bluetooth LE PHY arithmetic for the 1M PHY: channel frequencies, time on air,
// receiver sensitivity, the link-layer CRC and the LE link-layer capture record.
// Pure functions, no state.
//
// Sources: Bluetooth Core Specification v5.x, Vol 6 Part A §2 (RF channels),
// Vol 6 Part B §2.1 (packet format), §3.1.1 (CRC), §4.1 (T_IFS); the ESP32
// datasheet, Bluetooth LE receiver table (sensitivity, co-channel C/I); and
// tcpdump.org's LINKTYPE_BLUETOOTH_LE_LL_WITH_PHDR (256).

import { noiseFloorDbm } from "./channel.ts";

/** Access address of every advertising-channel packet (Vol 6 Part B §2.1.2). */
export const BLE_ADV_ACCESS_ADDRESS = 0x8e89bed6;
/** CRC initial value of every advertising-channel packet (Vol 6 Part B §3.1.1). */
export const BLE_ADV_CRC_INIT = 0x555555;
export const BLE_ADV_CHANNELS: readonly number[] = [37, 38, 39];
/** Inter frame space: a reply starts this long after the packet it answers ends. */
export const BLE_T_IFS_MS = 0.15;
/** 1M PHY: one bit per microsecond. */
export const BLE_RATE_BPS = 1_000_000;
/** Occupied bandwidth used for the noise floor. */
export const BLE_BANDWIDTH_HZ = 1e6;
export const BLE_NOISE_FIGURE_DB = 10;
/** ESP32 datasheet: -97 dBm sensitivity on the 1M PHY. */
export const BLE_SENSITIVITY_DBM = -97;
/** The sensitivity test packet: a 2-byte header and a 37-byte payload. */
export const BLE_REFERENCE_BYTES = 39;
/** ESP32 datasheet: co-channel C/I +10 dB; the stronger packet survives an overlap at that margin. */
export const BLE_CAPTURE_DB = 10;
/** Largest link-layer data payload without the data length extension (Vol 6 Part B §2.4). */
export const BLE_MAX_DATA_PAYLOAD = 27;

/** SNR the receiver needs, from the sensitivity and the floor the engine computes. */
export function bleRequiredSnrDb(): number {
  return BLE_SENSITIVITY_DBM - noiseFloorDbm(BLE_NOISE_FIGURE_DB, BLE_BANDWIDTH_HZ);
}

function checkChannel(channel: number): void {
  if (!Number.isInteger(channel) || channel < 0 || channel > 39) {
    throw new RangeError(`BLE channel index must be 0-39, got ${channel}`);
  }
}

/** Centre frequency of a channel index: 37, 38, 39 advertise at 2402, 2426, 2480 MHz. */
export function bleChannelFrequencyHz(channel: number): number {
  checkChannel(channel);
  if (channel === 37) return 2402e6;
  if (channel === 38) return 2426e6;
  if (channel === 39) return 2480e6;
  return (channel <= 10 ? 2404 + 2 * channel : 2406 + 2 * channel) * 1e6;
}

/** The RF channel (0 at 2402 MHz to 39 at 2480 MHz) that capture formats use. */
export function bleRfChannel(channel: number): number {
  return (bleChannelFrequencyHz(channel) / 1e6 - 2402) / 2;
}

/** 1M PHY packet on the air: preamble 1, access address 4, PDU, CRC 3 bytes, 8 us each. */
export function bleAirtimeUs(pduBytes: number): number {
  return (1 + 4 + pduBytes + 3) * 8;
}

/**
 * Channel selection algorithm #1 (Vol 6 Part B §4.5.8.2): the next unmapped
 * channel is the last one plus the hop increment, modulo 37; an unused one is
 * remapped onto the used channels in ascending order.
 */
export function bleNextDataChannel(
  lastUnmapped: number,
  hop: number,
  used: readonly number[],
): { unmapped: number; channel: number } {
  const unmapped = (lastUnmapped + hop) % 37;
  if (used.includes(unmapped)) return { unmapped, channel: unmapped };
  return { unmapped, channel: used[unmapped % used.length] as number };
}

function reverse8(b: number): number {
  let out = 0;
  for (let i = 0; i < 8; i++) out |= ((b >> i) & 1) << (7 - i);
  return out;
}

/**
 * The link-layer CRC over a PDU (Vol 6 Part B §3.1.1): a 24-bit LFSR with
 * polynomial x^24 + x^10 + x^9 + x^6 + x^4 + x^3 + x + 1, preset with
 * `crcInit` (position 0 its least significant bit), fed the PDU bits in the
 * order they go on the air (least significant bit of each byte first). Returns
 * the register, position 23 in bit 23.
 */
export function bleCrc24(pdu: Uint8Array, crcInit: number): number {
  let state = crcInit & 0xffffff;
  for (const byte of pdu) {
    for (let i = 0; i < 8; i++) {
      const feedback = ((state >> 23) ^ (byte >> i)) & 1;
      state = (state << 1) & 0xffffff;
      if (feedback) state ^= 0x00065b;
    }
  }
  return state;
}

/** The three CRC bytes as they go on the air: position 23 is sent first. */
export function bleCrcBytes(crc: number): Uint8Array {
  return Uint8Array.of(
    reverse8((crc >> 16) & 0xff),
    reverse8((crc >> 8) & 0xff),
    reverse8(crc & 0xff),
  );
}

/**
 * One LINKTYPE_BLUETOOTH_LE_LL_WITH_PHDR record: a 10-byte pseudo-header
 * (RF channel, signal power, noise power, access-address offenses, reference
 * access address, flags), then the packet as on the air without its preamble:
 * access address, PDU and CRC. Flags say "de-whitened" and "signal power
 * valid", and nothing about the CRC, so Wireshark checks it itself.
 */
export function bleLlRecord(
  channel: number,
  accessAddress: number,
  pdu: Uint8Array,
  crcInit: number,
  signalDbm: number,
): Uint8Array {
  const out = new Uint8Array(10 + 4 + pdu.length + 3);
  const view = new DataView(out.buffer);
  view.setUint8(0, bleRfChannel(channel));
  view.setInt8(1, Math.max(-128, Math.min(127, Math.round(signalDbm))));
  view.setInt8(2, 0);
  view.setUint8(3, 0);
  view.setUint32(4, accessAddress >>> 0, true);
  view.setUint16(8, 0x0001 | 0x0002, true);
  view.setUint32(10, accessAddress >>> 0, true);
  out.set(pdu, 14);
  out.set(bleCrcBytes(bleCrc24(pdu, crcInit)), 14 + pdu.length);
  return out;
}
