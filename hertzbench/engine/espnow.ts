// The pseudo-Ethernet encoding the lcgamboa QEMU fork uses to put ESP-NOW on its
// netdev (ADR 0001), and the ESP-NOW vendor-specific action body inside it.
//
// The fork's access-point model turns each 802.11 action frame the guest sends
// into: dst MAC (6), src MAC (6), byte 12 = 0xA0 | channel (0xB0 | channel when
// protected), byte 13 = 0x0d, then the 802.11 frame body. The receiver answers
// a unicast one with a 14-byte ACK: dst = the sender, src = itself, byte 12 =
// 0xA0 | channel, byte 13 = 0x1d (hw/misc/esp32_wifi_ap.c:396-476, :608-645;
// constants in hw/misc/esp32_wlan.h). The checks below are the fork's own.

import { macToBytes, macToString } from "./packet.ts";

/** IEEE80211_ENCAPSULATED: high nibble of byte 12. */
const ENCAPSULATED = 0xa0;
/** IEEE80211_ENCAPSULATED_PROTECTED. */
const ENCAPSULATED_PROTECTED = 0xb0;
/** (IEEE80211_TYPE_MGT << 4) | IEEE80211_TYPE_MGT_SUBTYPE_ACTION. */
const ACTION_TYPE = 0x0d;
/** (IEEE80211_TYPE_CTL << 4) | IEEE80211_TYPE_CTL_SUBTYPE_ACK. */
const ACK_TYPE = 0x1d;
const HEADER_BYTES = 14;

/** WAIT_ACK_TIMEOUT of the fork: a unicast sender waits this long, in guest time, for the ACK. */
export const ESPNOW_ACK_TIMEOUT_MS = 10;

export interface EspNowFrame {
  type: "action" | "ack";
  dst: string;
  src: string;
  /** The guest's Wi-Fi channel when it sent the frame. The receiving fork drops any other. */
  channel: number;
  protected: boolean;
  /** The 802.11 frame body (empty for an ACK). */
  body: Uint8Array;
}

/** The fork's ESP-NOW pseudo-Ethernet, or null for anything else. */
export function parseEspNow(frame: Uint8Array): EspNowFrame | null {
  if (frame.length < HEADER_BYTES) return null;
  const marker = frame[12] as number;
  const type = frame[13] as number;
  // The action check masks with 0xE0 so the protected marker 0xB0 matches too;
  // the ACK check masks with 0xF0 (esp32_wifi_ap.c:396, :465).
  const action = (marker & 0xe0) === ENCAPSULATED && type === ACTION_TYPE;
  const ack = (marker & 0xf0) === ENCAPSULATED && type === ACK_TYPE;
  if (!action && !ack) return null;
  return {
    type: action ? "action" : "ack",
    dst: macToString(frame, 0),
    src: macToString(frame, 6),
    channel: marker & 0x0f,
    protected: action && (marker & 0xf0) === ENCAPSULATED_PROTECTED,
    body: frame.subarray(HEADER_BYTES),
  };
}

function header(dst: string, src: string, marker: number, type: number, bodyBytes: number) {
  const frame = new Uint8Array(HEADER_BYTES + bodyBytes);
  frame.set(macToBytes(dst), 0);
  frame.set(macToBytes(src), 6);
  frame[12] = marker;
  frame[13] = type;
  return frame;
}

function checkChannel(channel: number): void {
  if (!Number.isInteger(channel) || channel < 0 || channel > 15) {
    throw new RangeError(`ESP-NOW channel must fit in 4 bits, got ${channel}`);
  }
}

export function buildEspNowAction(
  spec: { dst: string; src: string; channel: number; body: Uint8Array; protected?: boolean },
): Uint8Array {
  checkChannel(spec.channel);
  const marker = (spec.protected ? ENCAPSULATED_PROTECTED : ENCAPSULATED) | spec.channel;
  const frame = header(spec.dst, spec.src, marker, ACTION_TYPE, spec.body.length);
  frame.set(spec.body, HEADER_BYTES);
  return frame;
}

export function buildEspNowAck(spec: { dst: string; src: string; channel: number }): Uint8Array {
  checkChannel(spec.channel);
  return header(spec.dst, spec.src, ENCAPSULATED | spec.channel, ACK_TYPE, 0);
}

// ── the ESP-NOW action body ─────────────────────────────────────────────────
// Category 127 (vendor specific), Espressif OUI, 4 random bytes, then one
// vendor element: 0xdd, length, OUI, type 4 (ESP-NOW), version, payload.

const ESPRESSIF_OUI = [0x18, 0xfe, 0x34] as const;
const VENDOR_CATEGORY = 127;
const ELEMENT_ID = 0xdd;
const ESPNOW_TYPE = 4;
const ESPNOW_VERSION = 1;
const BODY_FIXED_BYTES = 1 + 3 + 4;
const ELEMENT_FIXED_BYTES = 2 + 3 + 1 + 1;
/** ESP-NOW's own payload limit (ESP_NOW_MAX_DATA_LEN). */
export const ESPNOW_MAX_PAYLOAD_BYTES = 250;

export function buildEspNowBody(payload: Uint8Array, random = 0): Uint8Array {
  if (payload.length > ESPNOW_MAX_PAYLOAD_BYTES) {
    throw new RangeError(
      `ESP-NOW payload of ${payload.length} bytes exceeds ${ESPNOW_MAX_PAYLOAD_BYTES}`,
    );
  }
  const body = new Uint8Array(BODY_FIXED_BYTES + ELEMENT_FIXED_BYTES + payload.length);
  body[0] = VENDOR_CATEGORY;
  body.set(ESPRESSIF_OUI, 1);
  new DataView(body.buffer).setUint32(4, random >>> 0);
  const e = BODY_FIXED_BYTES;
  body[e] = ELEMENT_ID;
  body[e + 1] = 3 + 1 + 1 + payload.length; // OUI, type, version, payload
  body.set(ESPRESSIF_OUI, e + 2);
  body[e + 5] = ESPNOW_TYPE;
  body[e + 6] = ESPNOW_VERSION;
  body.set(payload, e + ELEMENT_FIXED_BYTES);
  return body;
}

/** The payload of an ESP-NOW action body, or null when the body is not ESP-NOW. */
export function parseEspNowBody(body: Uint8Array): Uint8Array | null {
  const e = BODY_FIXED_BYTES;
  if (body.length < e + ELEMENT_FIXED_BYTES || body[0] !== VENDOR_CATEGORY) return null;
  if (body[e] !== ELEMENT_ID || body[e + 5] !== ESPNOW_TYPE) return null;
  const length = (body[e + 1] as number) - 5;
  if (length < 0 || e + ELEMENT_FIXED_BYTES + length > body.length) return null;
  return body.subarray(e + ELEMENT_FIXED_BYTES, e + ELEMENT_FIXED_BYTES + length);
}

// ── the same frames as 802.11, for Wireshark ────────────────────────────────

/** Radiotap header with one field, the channel: version, pad, length, present, then freq and flags. */
const RADIOTAP_BYTES = 12;
const RADIOTAP_PRESENT_CHANNEL = 1 << 3;
const RADIOTAP_CHANNEL_2GHZ = 0x0080;
const DOT11_HEADER_BYTES = 24;
const DOT11_ACK_BYTES = 10;

/**
 * An ESP-NOW pseudo-Ethernet frame as the 802.11 frame it stands for, behind a
 * radiotap header (pcap link type 127). The action frame's BSSID is the
 * broadcast address and its sequence number is 0: the fork does not carry
 * either. Whether the guest's frame body ends in an FCS is not known (the fork
 * passes the DMA length through), so the radiotap header does not claim one.
 */
export function espnowToRadiotap(frame: Uint8Array): Uint8Array | null {
  const espnow = parseEspNow(frame);
  if (!espnow) return null;
  const dot11Bytes = espnow.type === "action"
    ? DOT11_HEADER_BYTES + espnow.body.length
    : DOT11_ACK_BYTES;
  const out = new Uint8Array(RADIOTAP_BYTES + dot11Bytes);
  const view = new DataView(out.buffer);
  view.setUint16(2, RADIOTAP_BYTES, true);
  view.setUint32(4, RADIOTAP_PRESENT_CHANNEL, true);
  const mhz = espnow.channel === 14
    ? 2484
    : espnow.channel >= 1 && espnow.channel <= 13
    ? 2407 + 5 * espnow.channel
    : 0;
  view.setUint16(8, mhz, true);
  view.setUint16(10, RADIOTAP_CHANNEL_2GHZ, true);

  const d = RADIOTAP_BYTES;
  if (espnow.type === "ack") {
    out[d] = 0xd4; // control frame, subtype ACK
    out.set(macToBytes(espnow.dst), d + 4);
    return out;
  }
  out[d] = 0xd0; // management frame, subtype action
  out[d + 1] = espnow.protected ? 0x40 : 0;
  out.set(macToBytes(espnow.dst), d + 4);
  out.set(macToBytes(espnow.src), d + 10);
  out.fill(0xff, d + 16, d + 22);
  out.set(espnow.body, d + DOT11_HEADER_BYTES);
  return out;
}
