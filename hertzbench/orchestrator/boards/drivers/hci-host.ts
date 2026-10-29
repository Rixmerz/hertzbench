// A minimal BLE host over HCI, in TypeScript, for scripted boards and tests:
// NOT a Bluetooth stack. It sends the commands a host sends to bring a
// controller up, advertise, scan and connect, keeps the controller's ACL
// buffer credits, and carries ATT over L2CAP's fixed channel 4. It plays the
// part the firmware's Bluedroid or NimBLE plays in a real run, so the
// controller, the air and the metrics can be exercised without libqemu.

import {
  addressToBytes,
  addressToString,
  encodeHci,
  EVT,
  H4Decoder,
  LE_SUBEVENT,
  OP,
  readU16,
  STATUS,
  u16,
} from "../../../adapters/ble-hci/hci.ts";

export interface CommandResult {
  status: number;
  /** Return parameters after the status byte (Command Complete), empty for Command Status. */
  params: Uint8Array;
}

export interface AdvertisingReport {
  eventType: number;
  random: boolean;
  address: string;
  data: Uint8Array;
  rssi: number;
}

export interface HostEvents {
  connected?(handle: number, role: "central" | "peripheral", peer: string, status: number): void;
  disconnected?(handle: number, reason: number): void;
  advertisingReport?(report: AdvertisingReport): void;
  /** One L2CAP basic frame, reassembled, on fixed channel 4 (ATT). */
  att?(handle: number, pdu: Uint8Array): void;
}

/** L2CAP fixed channel of the Attribute Protocol. */
const ATT_CID = 0x0004;

export class HciHost {
  readonly #write: (bytes: Uint8Array) => Promise<void>;
  readonly #decoder = new H4Decoder();
  readonly #events: HostEvents;
  #pending: { op: number; resolve: (r: CommandResult) => void; reject: (e: Error) => void } | null =
    null;
  #commands: Promise<unknown> = Promise.resolve();
  #credits = 0;
  readonly #aclQueue: { handle: number; data: Uint8Array }[] = [];
  /** Partial L2CAP frames by connection handle. */
  readonly #reassembly = new Map<number, Uint8Array>();
  #closed: Error | null = null;
  address = "";

  constructor(write: (bytes: Uint8Array) => Promise<void>, events: HostEvents) {
    this.#write = write;
    this.#events = events;
  }

  /** Bytes from the controller. */
  feed(chunk: Uint8Array): void {
    for (const packet of this.#decoder.push(chunk)) {
      if (packet.type === "event") this.#onEvent(packet.code, packet.params);
      else if (packet.type === "acl") this.#onAcl(packet.handle, packet.pb, packet.data);
    }
  }

  /** The transport closed: every pending and later command fails. */
  fail(error: Error): void {
    this.#closed = error;
    this.#pending?.reject(error);
    this.#pending = null;
  }

  /** One command at a time, as a host does when the controller allows one outstanding command. */
  command(op: number, params: ArrayLike<number> = []): Promise<CommandResult> {
    const run = async () => {
      if (this.#closed) throw this.#closed;
      const result = new Promise<CommandResult>((resolve, reject) => {
        this.#pending = { op, resolve, reject };
      });
      const mine = this.#pending;
      try {
        await this.#write(
          encodeHci({ type: "command", opcode: op, params: Uint8Array.from(params) }),
        );
      } catch (error) {
        // Nobody will await `result`: free the slot so a later fail() does not reject it unheard.
        if (this.#pending === mine) this.#pending = null;
        result.catch(() => {});
        throw error;
      }
      return await result;
    };
    const next = this.#commands.then(run, run);
    this.#commands = next.catch(() => {});
    return next;
  }

  /** Like `command`, but a status other than success is an error naming the command. */
  async ok(op: number, params: ArrayLike<number> = [], what = `0x${op.toString(16)}`) {
    const result = await this.command(op, params);
    if (result.status !== STATUS.success) {
      throw new Error(`HCI ${what} failed with status 0x${result.status.toString(16)}`);
    }
    return result.params;
  }

  /** Reset, then read what a host reads before it uses LE. */
  async init(): Promise<void> {
    await this.ok(OP.reset, [], "Reset");
    await this.ok(
      OP.setEventMask,
      [0xff, 0xff, 0xff, 0xff, 0xff, 0x1f, 0xff, 0x20],
      "Set Event Mask",
    );
    await this.ok(OP.leSetEventMask, [0x1f, 0, 0, 0, 0, 0, 0, 0], "LE Set Event Mask");
    const buffers = await this.ok(OP.leReadBufferSize, [], "LE Read Buffer Size");
    this.#credits = buffers[2] ?? 0;
    if (this.#credits === 0) {
      // Zero means the LE link shares the BR/EDR buffers (Vol 4 Part E §7.8.2): ask that count.
      const shared = await this.ok(OP.readBufferSize, [], "Read Buffer Size");
      this.#credits = readU16(shared, 3);
    }
    this.address = addressToString(await this.ok(OP.readBdAddr, [], "Read BD_ADDR"));
  }

  /**
   * Advertise connectable. With `serviceUuid` (as `uuidToBytes` gives it) the advertising data
   * carries that service and the name moves to the scan response: flags, a 128-bit UUID and a
   * 26-byte name do not fit in the 31 bytes of one.
   */
  async advertise(name: string, intervalMs: number, serviceUuid?: Uint8Array): Promise<void> {
    const units = Math.round(intervalMs / 0.625);
    await this.ok(OP.leSetAdvParams, [
      ...u16(units),
      ...u16(units),
      0x00, // ADV_IND
      0x00, // public address
      0x00,
      0,
      0,
      0,
      0,
      0,
      0,
      0x07, // channels 37, 38, 39
      0x00,
    ], "LE Set Advertising Parameters");
    const nameBytes = new TextEncoder().encode(name).slice(0, 26);
    const flags = [2, 0x01, 0x06]; // LE General Discoverable, BR/EDR not supported
    const nameField = [nameBytes.length + 1, 0x09, ...nameBytes]; // complete local name
    // Complete list of 16-bit (0x03) or 128-bit (0x07) service UUIDs.
    const service = serviceUuid
      ? [serviceUuid.length + 1, serviceUuid.length === 2 ? 0x03 : 0x07, ...serviceUuid]
      : [];
    const advData = serviceUuid ? [...flags, ...service] : [...flags, ...nameField];
    await this.ok(OP.leSetAdvData, paddedAdvData(advData), "LE Set Advertising Data");
    if (serviceUuid) {
      await this.ok(OP.leSetScanRspData, paddedAdvData(nameField), "LE Set Scan Response Data");
    }
    await this.ok(OP.leSetAdvEnable, [1], "LE Set Advertising Enable");
  }

  async scan(
    active: boolean,
    intervalMs: number,
    windowMs: number,
    filterDuplicates = false,
  ): Promise<void> {
    await this.ok(OP.leSetScanParams, [
      active ? 1 : 0,
      ...u16(Math.round(intervalMs / 0.625)),
      ...u16(Math.round(windowMs / 0.625)),
      0,
      0,
    ], "LE Set Scan Parameters");
    await this.ok(OP.leSetScanEnable, [1, filterDuplicates ? 1 : 0], "LE Set Scan Enable");
  }

  async setAcceptList(addresses: readonly string[]): Promise<void> {
    await this.ok(OP.leClearAcceptList, [], "LE Clear Filter Accept List");
    for (const address of addresses) {
      await this.ok(OP.leAddToAcceptList, [0, ...addressToBytes(address)], "LE Add To Accept List");
    }
  }

  /** Connect to any device on the accept list; LE Connection Complete arrives through `connected`. */
  async connectAcceptList(intervalMs: number, timeoutMs: number): Promise<void> {
    const interval = Math.round(intervalMs / 1.25);
    const scan = Math.round(intervalMs / 0.625);
    const result = await this.command(OP.leCreateConnection, [
      ...u16(scan),
      ...u16(scan),
      0x01, // initiator filter policy: the accept list
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0x00,
      ...u16(interval),
      ...u16(interval),
      ...u16(0),
      ...u16(Math.round(timeoutMs / 10)),
      ...u16(0),
      ...u16(0),
    ]);
    if (result.status !== STATUS.success) {
      throw new Error(
        `HCI LE Create Connection failed with status 0x${result.status.toString(16)}`,
      );
    }
  }

  /** An ATT PDU in one L2CAP basic frame; queued while the controller has no free buffer. */
  sendAtt(handle: number, pdu: Uint8Array): void {
    const frame = Uint8Array.from([...u16(pdu.length), ...u16(ATT_CID), ...pdu]);
    this.#aclQueue.push({ handle, data: frame });
    this.#pumpAcl();
  }

  /** Data waiting for a controller buffer on a connection that ended is dropped, as a host does. */
  forget(handle: number): void {
    for (let i = this.#aclQueue.length - 1; i >= 0; i--) {
      if (this.#aclQueue[i]?.handle === handle) this.#aclQueue.splice(i, 1);
    }
    this.#reassembly.delete(handle);
  }

  #pumpAcl(): void {
    while (this.#credits > 0 && this.#aclQueue.length > 0 && !this.#closed) {
      const next = this.#aclQueue.shift() as { handle: number; data: Uint8Array };
      this.#credits--;
      this.#write(encodeHci({ type: "acl", handle: next.handle, pb: 0, data: next.data })).catch(
        (error) => this.fail(error instanceof Error ? error : new Error(String(error))),
      );
    }
  }

  #onEvent(code: number, p: Uint8Array): void {
    if (code === EVT.commandComplete || code === EVT.commandStatus) {
      const op = readU16(p, code === EVT.commandComplete ? 1 : 2);
      const pending = this.#pending;
      if (!pending || pending.op !== op) return;
      this.#pending = null;
      pending.resolve(
        code === EVT.commandComplete
          ? { status: p[3] ?? 0xff, params: p.slice(4) }
          : { status: p[0] ?? 0xff, params: new Uint8Array(0) },
      );
    } else if (code === EVT.numberOfCompletedPackets) {
      const n = p[0] ?? 0;
      for (let i = 0; i < n; i++) this.#credits += readU16(p, 1 + 4 * i + 2);
      this.#pumpAcl();
    } else if (code === EVT.disconnectionComplete) {
      const handle = readU16(p, 1);
      this.forget(handle);
      this.#events.disconnected?.(handle, p[3] ?? 0);
    } else if (code === EVT.leMeta) this.#onLeMeta(p[0] ?? 0, p.subarray(1));
  }

  #onLeMeta(subevent: number, p: Uint8Array): void {
    if (subevent === LE_SUBEVENT.connectionComplete) {
      this.#events.connected?.(
        readU16(p, 1),
        p[3] === 0 ? "central" : "peripheral",
        addressToString(p.subarray(5, 11)),
        p[0] ?? 0xff,
      );
    } else if (subevent === LE_SUBEVENT.advertisingReport) {
      const length = p[9] ?? 0;
      this.#events.advertisingReport?.({
        eventType: p[1] ?? 0,
        random: p[2] === 1,
        address: addressToString(p.subarray(3, 9)),
        data: p.slice(10, 10 + length),
        rssi: ((p[10 + length] ?? 0) << 24) >> 24,
      });
    }
  }

  #onAcl(handle: number, pb: number, data: Uint8Array): void {
    const pending = pb === 1 ? this.#reassembly.get(handle) : undefined;
    const joined = pending ? Uint8Array.from([...pending, ...data]) : data;
    const length = readU16(joined, 0);
    if (joined.length < 4 + length) {
      this.#reassembly.set(handle, joined);
      return;
    }
    this.#reassembly.delete(handle);
    if (readU16(joined, 2) === ATT_CID) this.#events.att?.(handle, joined.slice(4, 4 + length));
  }
}

/** Advertising or scan response data as the commands carry it: a length byte, then 31 bytes. */
function paddedAdvData(data: number[]): Uint8Array {
  const padded = new Uint8Array(32);
  padded[0] = data.length;
  padded.set(data, 1);
  return padded;
}

/** The complete local name in advertising data, or null. */
export function advertisedName(data: Uint8Array): string | null {
  let i = 0;
  while (i < data.length) {
    const length = data[i] ?? 0;
    if (length === 0) break;
    if (data[i + 1] === 0x09 || data[i + 1] === 0x08) {
      return new TextDecoder().decode(data.subarray(i + 2, i + 1 + length));
    }
    i += 1 + length;
  }
  return null;
}
