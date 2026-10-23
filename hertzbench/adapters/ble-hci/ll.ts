// Link-layer PDUs of the 1M PHY (Core v5.x, Vol 6 Part B §2.3 and §2.4): the
// advertising-channel PDUs a legacy advertiser, scanner and initiator exchange,
// and the data-channel PDUs of a connection. Encode and parse only; the state
// machines are in controller.ts.

import { readU16, u16 } from "./hci.ts";

export const ADV_PDU = {
  advInd: 0,
  advDirectInd: 1,
  advNonconnInd: 2,
  scanReq: 3,
  scanRsp: 4,
  connectInd: 5,
  advScanInd: 6,
} as const;

export interface AdvPdu {
  type: number;
  /** TxAdd: the first address in the payload is random. */
  txRandom: boolean;
  /** RxAdd: the second address is random. */
  rxRandom: boolean;
  payload: Uint8Array;
}

export function encodeAdvPdu(pdu: AdvPdu): Uint8Array {
  const out = new Uint8Array(2 + pdu.payload.length);
  out[0] = (pdu.type & 0x0f) | (pdu.txRandom ? 0x40 : 0) | (pdu.rxRandom ? 0x80 : 0);
  out[1] = pdu.payload.length;
  out.set(pdu.payload, 2);
  return out;
}

export function parseAdvPdu(bytes: Uint8Array): AdvPdu | null {
  if (bytes.length < 2 || bytes.length !== 2 + (bytes[1] as number)) return null;
  const h = bytes[0] as number;
  return {
    type: h & 0x0f,
    txRandom: (h & 0x40) !== 0,
    rxRandom: (h & 0x80) !== 0,
    payload: bytes.slice(2),
  };
}

/** The connection parameters a CONNECT_IND carries (its LLData). Times in link-layer units. */
export interface ConnectParams {
  accessAddress: number;
  crcInit: number;
  /** 1.25 ms units. */
  winSize: number;
  winOffset: number;
  interval: number;
  latency: number;
  /** 10 ms units. */
  timeout: number;
  /** Used data channels, ascending. */
  channelMap: number[];
  hop: number;
  sca: number;
}

export function encodeConnectInd(
  initA: Uint8Array,
  advA: Uint8Array,
  params: ConnectParams,
): Uint8Array {
  const chm = new Uint8Array(5);
  for (const ch of params.channelMap) chm[ch >> 3] = (chm[ch >> 3] as number) | (1 << (ch & 7));
  const aa = params.accessAddress >>> 0;
  return Uint8Array.from([
    ...initA,
    ...advA,
    aa & 0xff,
    (aa >>> 8) & 0xff,
    (aa >>> 16) & 0xff,
    aa >>> 24,
    params.crcInit & 0xff,
    (params.crcInit >> 8) & 0xff,
    (params.crcInit >> 16) & 0xff,
    params.winSize,
    ...u16(params.winOffset),
    ...u16(params.interval),
    ...u16(params.latency),
    ...u16(params.timeout),
    ...chm,
    (params.hop & 0x1f) | ((params.sca & 7) << 5),
  ]);
}

export function parseConnectInd(
  payload: Uint8Array,
): { initA: Uint8Array; advA: Uint8Array; params: ConnectParams } | null {
  if (payload.length !== 34) return null;
  const ll = payload.subarray(12);
  const channelMap: number[] = [];
  for (let ch = 0; ch < 37; ch++) {
    if (((ll[16 + (ch >> 3)] as number) >> (ch & 7)) & 1) channelMap.push(ch);
  }
  return {
    initA: payload.slice(0, 6),
    advA: payload.slice(6, 12),
    params: {
      accessAddress: (readU16(ll, 0) | (readU16(ll, 2) << 16)) >>> 0,
      crcInit: (ll[4] as number) | ((ll[5] as number) << 8) | ((ll[6] as number) << 16),
      winSize: ll[7] as number,
      winOffset: readU16(ll, 8),
      interval: readU16(ll, 10),
      latency: readU16(ll, 12),
      timeout: readU16(ll, 14),
      channelMap,
      hop: (ll[21] as number) & 0x1f,
      sca: (ll[21] as number) >> 5,
    },
  };
}

// ── data channel ────────────────────────────────────────────────────────────

/** LLID: continuation fragment or empty PDU, start of an L2CAP message, control PDU. */
export const LLID = { continuation: 1, start: 2, control: 3 } as const;

export interface DataPdu {
  llid: number;
  nesn: number;
  sn: number;
  md: boolean;
  payload: Uint8Array;
}

export function encodeDataPdu(pdu: DataPdu): Uint8Array {
  const out = new Uint8Array(2 + pdu.payload.length);
  out[0] = (pdu.llid & 3) | ((pdu.nesn & 1) << 2) | ((pdu.sn & 1) << 3) | (pdu.md ? 0x10 : 0);
  out[1] = pdu.payload.length;
  out.set(pdu.payload, 2);
  return out;
}

export function parseDataPdu(bytes: Uint8Array): DataPdu | null {
  if (bytes.length < 2 || bytes.length !== 2 + (bytes[1] as number)) return null;
  const h = bytes[0] as number;
  return {
    llid: h & 3,
    nesn: (h >> 2) & 1,
    sn: (h >> 3) & 1,
    md: (h & 0x10) !== 0,
    payload: bytes.slice(2),
  };
}

/** Link-layer control opcodes (Vol 6 Part B §2.4.2). */
export const LL_CTRL = {
  connectionUpdateInd: 0x00,
  terminateInd: 0x02,
  unknownRsp: 0x07,
  featureReq: 0x08,
  featureRsp: 0x09,
  versionInd: 0x0c,
  peripheralFeatureReq: 0x0e,
} as const;
