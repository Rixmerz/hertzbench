// The Attribute Protocol and the GATT procedures on top of it (Core v5.x,
// Vol 3 Parts F and G), as much as a scripted peripheral needs to serve one
// service and the BLE bridge needs to discover, read, write and subscribe to
// one: NOT a Bluetooth stack. Both run over HciHost's fixed channel 4 at the
// default ATT_MTU of 23, which is all the virtual controller carries without
// fragmenting (no data length extension).

import type { Clock } from "../../../engine/mod.ts";

export const ATT = {
  errorRsp: 0x01,
  mtuReq: 0x02,
  mtuRsp: 0x03,
  findInfoReq: 0x04,
  findInfoRsp: 0x05,
  readByTypeReq: 0x08,
  readByTypeRsp: 0x09,
  readReq: 0x0a,
  readRsp: 0x0b,
  readByGroupReq: 0x10,
  readByGroupRsp: 0x11,
  writeReq: 0x12,
  writeRsp: 0x13,
  notify: 0x1b,
  indicate: 0x1d,
  confirm: 0x1e,
  writeCmd: 0x52,
} as const;

export const ATT_ERROR = {
  invalidHandle: 0x01,
  readNotPermitted: 0x02,
  writeNotPermitted: 0x03,
  requestNotSupported: 0x06,
  attributeNotFound: 0x0a,
  invalidLength: 0x0d,
} as const;

/** The default ATT_MTU; a value read or written whole fits in MTU - 3 bytes. */
export const ATT_MTU = 23;
export const MAX_VALUE_BYTES = ATT_MTU - 3;
/** ATT transaction timeout (Vol 3 Part F §3.3.3). */
const ATT_TIMEOUT_MS = 30_000;

export const GATT_UUID = {
  primaryService: 0x2800,
  characteristic: 0x2803,
  cccd: 0x2902,
} as const;

export const PROPERTY = {
  read: 0x02,
  writeWithoutResponse: 0x04,
  write: 0x08,
  notify: 0x10,
  indicate: 0x20,
} as const;

const PROPERTY_NAMES: [number, string][] = [
  [PROPERTY.read, "read"],
  [PROPERTY.writeWithoutResponse, "write-without-response"],
  [PROPERTY.write, "write"],
  [PROPERTY.notify, "notify"],
  [PROPERTY.indicate, "indicate"],
];

export function propertyNames(properties: number): string[] {
  return PROPERTY_NAMES.flatMap(([bit, name]) => (properties & bit ? [name] : []));
}

const BASE_UUID_TAIL = "-0000-1000-8000-00805f9b34fb";

/** A UUID on the wire (2 or 16 bytes, little-endian) as its canonical 128-bit text. */
export function uuidToString(bytes: Uint8Array): string {
  if (bytes.length === 2) {
    const short = ((bytes[1] as number) << 8) | (bytes[0] as number);
    return `0000${short.toString(16).padStart(4, "0")}${BASE_UUID_TAIL}`;
  }
  const hex = Array.from(bytes).reverse().map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${
    hex.slice(20)
  }`;
}

const u16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
const readU16 = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);

export function errorRsp(request: number, handle: number, code: number): Uint8Array {
  return Uint8Array.of(ATT.errorRsp, request, ...u16(handle), code);
}

// ── server ──────────────────────────────────────────────────────────────────

interface Attribute {
  handle: number;
  /** 16-bit UUID of the attribute type. */
  type: number;
  value: Uint8Array;
  readable: boolean;
  writable: boolean;
}

export interface ServiceDefinition {
  /** 16-bit service UUID. */
  uuid: number;
  /** Handle of the service declaration; the characteristic follows it. */
  firstHandle: number;
  characteristic: { uuid: number; properties: number };
}

/**
 * One primary service with one characteristic and its CCCD, laid out as
 * declaration, characteristic declaration, value, CCCD from `firstHandle`.
 */
export class GattServer {
  readonly valueHandle: number;
  readonly cccdHandle: number;
  readonly #attributes: Attribute[];
  readonly #onWrite: (value: Uint8Array) => void;

  constructor(service: ServiceDefinition, onWrite: (value: Uint8Array) => void) {
    const h = service.firstHandle;
    this.valueHandle = h + 2;
    this.cccdHandle = h + 3;
    const props = service.characteristic.properties;
    const writable = (props & (PROPERTY.write | PROPERTY.writeWithoutResponse)) !== 0;
    this.#attributes = [
      {
        handle: h,
        type: GATT_UUID.primaryService,
        value: Uint8Array.from(u16(service.uuid)),
        readable: true,
        writable: false,
      },
      {
        handle: h + 1,
        type: GATT_UUID.characteristic,
        value: Uint8Array.of(props, ...u16(this.valueHandle), ...u16(service.characteristic.uuid)),
        readable: true,
        writable: false,
      },
      {
        handle: this.valueHandle,
        type: service.characteristic.uuid,
        value: new Uint8Array(0),
        readable: (props & PROPERTY.read) !== 0,
        writable,
      },
      {
        handle: this.cccdHandle,
        type: GATT_UUID.cccd,
        value: new Uint8Array(2),
        readable: true,
        writable: true,
      },
    ];
    this.#onWrite = onWrite;
  }

  /** The characteristic's value, as a read returns it. */
  setValue(value: Uint8Array): void {
    (this.#attributes[2] as Attribute).value = value.slice(0, MAX_VALUE_BYTES);
  }

  /** The answer to one client PDU; null for a command or a PDU that needs none. */
  handle(pdu: Uint8Array): Uint8Array | null {
    const op = pdu[0] ?? 0;
    switch (op) {
      case ATT.mtuReq:
        return Uint8Array.of(ATT.mtuRsp, ...u16(ATT_MTU));
      case ATT.readByGroupReq:
        return this.#readByGroup(pdu);
      case ATT.readByTypeReq:
        return this.#readByType(pdu);
      case ATT.findInfoReq:
        return this.#findInfo(pdu);
      case ATT.readReq: {
        const handle = readU16(pdu, 1);
        const attr = this.#attributes.find((a) => a.handle === handle);
        if (!attr) return errorRsp(op, handle, ATT_ERROR.invalidHandle);
        if (!attr.readable) return errorRsp(op, handle, ATT_ERROR.readNotPermitted);
        return Uint8Array.of(ATT.readRsp, ...attr.value.slice(0, MAX_VALUE_BYTES));
      }
      case ATT.writeReq:
      case ATT.writeCmd: {
        const handle = readU16(pdu, 1);
        const attr = this.#attributes.find((a) => a.handle === handle);
        const answer = (code: number) => (op === ATT.writeReq ? errorRsp(op, handle, code) : null);
        if (!attr) return answer(ATT_ERROR.invalidHandle);
        if (!attr.writable) return answer(ATT_ERROR.writeNotPermitted);
        const value = pdu.slice(3);
        if (attr.type === GATT_UUID.cccd && value.length !== 2) {
          return answer(ATT_ERROR.invalidLength);
        }
        attr.value = value;
        if (attr.handle === this.valueHandle) this.#onWrite(value);
        return op === ATT.writeReq ? Uint8Array.of(ATT.writeRsp) : null;
      }
      case ATT.confirm:
      case ATT.notify:
      case ATT.indicate:
        return null;
      default:
        // Commands (bit 6 set) are ignored; any other request is not supported (Vol 3 Part F §3.4.1.1).
        return op & 0x40 ? null : errorRsp(op, 0, ATT_ERROR.requestNotSupported);
    }
  }

  #range(pdu: Uint8Array): [number, number] {
    return [readU16(pdu, 1), readU16(pdu, 3)];
  }

  #readByGroup(pdu: Uint8Array): Uint8Array {
    const [start, end] = this.#range(pdu);
    const type = pdu.length === 7 ? readU16(pdu, 5) : -1;
    if (type !== GATT_UUID.primaryService) {
      return errorRsp(ATT.readByGroupReq, start, ATT_ERROR.attributeNotFound);
    }
    const decl = this.#attributes[0] as Attribute;
    if (decl.handle < start || decl.handle > end) {
      return errorRsp(ATT.readByGroupReq, start, ATT_ERROR.attributeNotFound);
    }
    return Uint8Array.of(
      ATT.readByGroupRsp,
      6,
      ...u16(decl.handle),
      ...u16(this.cccdHandle),
      ...decl.value,
    );
  }

  #readByType(pdu: Uint8Array): Uint8Array {
    const [start, end] = this.#range(pdu);
    const type = pdu.length === 7 ? readU16(pdu, 5) : -1;
    const found = this.#attributes.filter((a) =>
      a.type === type && a.handle >= start && a.handle <= end
    );
    if (found.length === 0) return errorRsp(ATT.readByTypeReq, start, ATT_ERROR.attributeNotFound);
    // Every pair in one response has the same length: take the first and the ones like it.
    const first = found[0] as Attribute;
    const same = found.filter((a) => a.value.length === first.value.length);
    const room = Math.floor((ATT_MTU - 2) / (first.value.length + 2));
    return Uint8Array.of(
      ATT.readByTypeRsp,
      first.value.length + 2,
      ...same.slice(0, room).flatMap((a) => [...u16(a.handle), ...a.value]),
    );
  }

  #findInfo(pdu: Uint8Array): Uint8Array {
    const [start, end] = this.#range(pdu);
    const found = this.#attributes.filter((a) => a.handle >= start && a.handle <= end);
    if (found.length === 0) return errorRsp(ATT.findInfoReq, start, ATT_ERROR.attributeNotFound);
    return Uint8Array.of(
      ATT.findInfoRsp,
      1,
      ...found.slice(0, 5).flatMap((a) => [...u16(a.handle), ...u16(a.type)]),
    );
  }
}

// ── client ──────────────────────────────────────────────────────────────────

export class AttError extends Error {
  override name = "AttError";
  /** The ATT error code; 0 when the request never got an answer. */
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

export interface DiscoveredCharacteristic {
  uuid: string;
  declarationHandle: number;
  valueHandle: number;
  properties: number;
  /** The Client Characteristic Configuration descriptor; null when it has none. */
  cccdHandle: number | null;
}

export interface DiscoveredService {
  uuid: string;
  startHandle: number;
  endHandle: number;
  characteristics: DiscoveredCharacteristic[];
}

/** One ATT bearer, client side: one request in flight, with its 30 s timeout. */
export class AttClient {
  readonly #send: (pdu: Uint8Array) => void;
  readonly #clock: Clock;
  #pending: {
    response: number;
    request: number;
    resolve: (pdu: Uint8Array) => void;
    reject: (e: AttError) => void;
    cancel: () => void;
  } | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #closed: AttError | null = null;
  onNotification: (handle: number, value: Uint8Array) => void = () => {};

  constructor(send: (pdu: Uint8Array) => void, clock: Clock) {
    this.#send = send;
    this.#clock = clock;
  }

  /** A PDU from the server; true when it was a response, a notification or an indication. */
  handle(pdu: Uint8Array): boolean {
    const op = pdu[0] ?? 0;
    if (op === ATT.notify || op === ATT.indicate) {
      if (op === ATT.indicate) this.#send(Uint8Array.of(ATT.confirm));
      this.onNotification(readU16(pdu, 1), pdu.slice(3));
      return true;
    }
    const pending = this.#pending;
    if (!pending) return false;
    if (op === ATT.errorRsp && pdu[1] === pending.request) {
      this.#settle();
      pending.reject(
        new AttError(`ATT error 0x${(pdu[4] ?? 0).toString(16).padStart(2, "0")}`, pdu[4] ?? 0),
      );
      return true;
    }
    if (op !== pending.response) return false;
    this.#settle();
    pending.resolve(pdu);
    return true;
  }

  /** The bearer is gone: every request in flight and to come fails. */
  close(reason: string): void {
    this.#closed = new AttError(reason, 0);
    const pending = this.#pending;
    this.#settle();
    pending?.reject(this.#closed);
  }

  request(pdu: Uint8Array, response: number): Promise<Uint8Array> {
    const run = () =>
      new Promise<Uint8Array>((resolve, reject) => {
        if (this.#closed) return reject(this.#closed);
        const cancel = this.#clock.schedule(this.#clock.now() + ATT_TIMEOUT_MS, () => {
          this.#settle();
          reject(new AttError("the node did not answer within the ATT timeout of 30 s", 0));
        });
        this.#pending = { response, request: pdu[0] ?? 0, resolve, reject, cancel };
        this.#send(pdu);
      });
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => {});
    return next;
  }

  #settle(): void {
    this.#pending?.cancel();
    this.#pending = null;
  }

  async read(handle: number): Promise<Uint8Array> {
    return (await this.request(Uint8Array.of(ATT.readReq, ...u16(handle)), ATT.readRsp)).slice(1);
  }

  async write(handle: number, value: Uint8Array, withResponse: boolean): Promise<void> {
    if (value.length > MAX_VALUE_BYTES) {
      throw new AttError(
        `a value of ${value.length} bytes needs a larger ATT MTU, which the bridge does not negotiate (at most ${MAX_VALUE_BYTES})`,
        ATT_ERROR.invalidLength,
      );
    }
    const op = withResponse ? ATT.writeReq : ATT.writeCmd;
    const pdu = Uint8Array.of(op, ...u16(handle), ...value);
    if (withResponse) await this.request(pdu, ATT.writeRsp);
    else if (this.#closed) throw this.#closed;
    else this.#send(pdu);
  }

  /** Primary services, their characteristics and CCCDs (Vol 3 Part G §4.4.1, §4.6.1, §4.7.1). */
  async discover(): Promise<DiscoveredService[]> {
    const services: DiscoveredService[] = [];
    for (let start = 1; start <= 0xffff;) {
      const rsp = await this.#orNotFound(
        Uint8Array.of(
          ATT.readByGroupReq,
          ...u16(start),
          ...u16(0xffff),
          ...u16(GATT_UUID.primaryService),
        ),
        ATT.readByGroupRsp,
      );
      if (!rsp) break;
      const size = rsp[1] ?? 0;
      let last = start;
      for (let i = 2; i + size <= rsp.length; i += size) {
        const endHandle = readU16(rsp, i + 2);
        services.push({
          uuid: uuidToString(rsp.slice(i + 4, i + size)),
          startHandle: readU16(rsp, i),
          endHandle,
          characteristics: [],
        });
        last = endHandle;
      }
      if (size === 0 || last >= 0xffff) break;
      start = last + 1;
    }
    for (const service of services) {
      for (let start = service.startHandle; start <= service.endHandle;) {
        const rsp = await this.#orNotFound(
          Uint8Array.of(
            ATT.readByTypeReq,
            ...u16(start),
            ...u16(service.endHandle),
            ...u16(GATT_UUID.characteristic),
          ),
          ATT.readByTypeRsp,
        );
        if (!rsp) break;
        const size = rsp[1] ?? 0;
        let last = start;
        for (let i = 2; i + size <= rsp.length; i += size) {
          const declarationHandle = readU16(rsp, i);
          service.characteristics.push({
            uuid: uuidToString(rsp.slice(i + 5, i + size)),
            declarationHandle,
            valueHandle: readU16(rsp, i + 3),
            properties: rsp[i + 2] ?? 0,
            cccdHandle: null,
          });
          last = declarationHandle;
        }
        if (size === 0) break;
        start = last + 1;
      }
      const chars = service.characteristics;
      for (const [i, char] of chars.entries()) {
        const end = (chars[i + 1]?.declarationHandle ?? service.endHandle + 1) - 1;
        for (let start = char.valueHandle + 1; start <= end;) {
          const rsp = await this.#orNotFound(
            Uint8Array.of(ATT.findInfoReq, ...u16(start), ...u16(end)),
            ATT.findInfoRsp,
          );
          if (!rsp) break;
          const size = rsp[1] === 1 ? 4 : 18;
          let last = start;
          for (let j = 2; j + size <= rsp.length; j += size) {
            last = readU16(rsp, j);
            if (size === 4 && readU16(rsp, j + 2) === GATT_UUID.cccd) char.cccdHandle = last;
          }
          start = last + 1;
        }
      }
    }
    return services;
  }

  async #orNotFound(pdu: Uint8Array, response: number): Promise<Uint8Array | null> {
    try {
      return await this.request(pdu, response);
    } catch (error) {
      if (error instanceof AttError && error.code === ATT_ERROR.attributeNotFound) return null;
      throw error;
    }
  }
}
