// The BLE bridge's second host side: the Android emulator's netsim instead of BlueZ
// (docs/android-device-plan.md, section 3). netsimd offers an HCI TCP port; a host that
// connects there gets a controller on netsim's air, which the emulated phone's own Bluetooth
// scans, connects to and runs GATT against. This side is that host: it advertises the mirrored
// name and first service, and serves the table the bridge discovered on the simulated node.
// Each operation the app sends reaches the bridge's handlers, which replay it on the
// simulated air, exactly as BlueZ's D-Bus callbacks do.
//
// Not modelled (docs/mobile-bridge.md): netsim's own radio between the app and this host, ATT
// MTU above 23, long reads and writes, security, and more than one app connection at a time.

import { STATUS } from "../../adapters/ble-hci/hci.ts";
import {
  ATT,
  ATT_ERROR,
  ATT_MTU,
  type DiscoveredCharacteristic,
  type DiscoveredService,
  errorRsp,
  GATT_UUID,
  PROPERTY,
  uuidToBytes,
  uuidToString,
} from "../../orchestrator/boards/drivers/att.ts";
import { HciHost } from "../../orchestrator/boards/drivers/hci-host.ts";
import { BridgeStartError } from "../ip/proxy.ts";
import { GattOperationError, type GattPeripheral, type PeripheralHandlers } from "./peripheral.ts";

/** How long netsim gets to answer the first HCI command. */
const OPEN_TIMEOUT_MS = 10_000;
/** The advertising interval of the host's controller. */
const ADVERTISING_INTERVAL_MS = 100;
/** ATT_ERROR has no "unlikely error"; it is what a request that failed for no ATT reason gets. */
const UNLIKELY_ERROR = 0x0e;
const INVALID_PDU = 0x04;
const UNSUPPORTED_GROUP_TYPE = 0x10;

const u16 = (n: number) => [n & 0xff, (n >>> 8) & 0xff];
const readU16 = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);

type Attribute =
  | { handle: number; type: string; kind: "fixed"; value: Uint8Array }
  | { handle: number; type: string; kind: "value"; char: DiscoveredCharacteristic }
  | { handle: number; type: string; kind: "cccd"; char: DiscoveredCharacteristic };

const uuid16 = (short: number) => uuidToString(Uint8Array.from(u16(short)));

/**
 * The attribute table of the discovered services, at the node's own handles, answered as an ATT
 * server. Reads and writes of a characteristic's value go to `handlers`; everything else is
 * answered here. A phone keeps a CCCD per connection, so `reset()` forgets them.
 */
export class GattTable {
  readonly #attributes: Attribute[] = [];
  readonly #services: DiscoveredService[];
  readonly #handlers: PeripheralHandlers;
  /** CCCD bits by characteristic value handle: 1 notifications, 2 indications. */
  readonly #cccd = new Map<number, number>();

  constructor(services: DiscoveredService[], handlers: PeripheralHandlers) {
    this.#services = services;
    this.#handlers = handlers;
    for (const service of services) {
      this.#attributes.push({
        handle: service.startHandle,
        type: uuid16(GATT_UUID.primaryService),
        kind: "fixed",
        value: uuidToBytes(service.uuid),
      });
      for (const char of service.characteristics) {
        this.#attributes.push({
          handle: char.declarationHandle,
          type: uuid16(GATT_UUID.characteristic),
          kind: "fixed",
          value: Uint8Array.of(
            char.properties,
            ...u16(char.valueHandle),
            ...uuidToBytes(char.uuid),
          ),
        }, { handle: char.valueHandle, type: char.uuid.toLowerCase(), kind: "value", char });
        if (char.cccdHandle !== null) {
          this.#attributes.push({
            handle: char.cccdHandle,
            type: uuid16(GATT_UUID.cccd),
            kind: "cccd",
            char,
          });
        }
      }
    }
    this.#attributes.sort((a, b) => a.handle - b.handle);
  }

  /** The value handle and CCCD bits of every characteristic the phone is subscribed to. */
  subscriptions(): ReadonlyMap<number, number> {
    return this.#cccd;
  }

  /** The phone disconnected: its CCCDs are off again. Returns the value handles that were on. */
  reset(): number[] {
    const subscribed = [...this.#cccd.keys()];
    this.#cccd.clear();
    return subscribed;
  }

  /** The answer to one PDU from the phone; null for a command, a confirmation or an ignored PDU. */
  async handle(pdu: Uint8Array): Promise<Uint8Array | null> {
    const op = pdu[0] ?? 0;
    switch (op) {
      case ATT.mtuReq:
        return Uint8Array.of(ATT.mtuRsp, ...u16(ATT_MTU));
      case ATT.readByGroupReq:
        return this.#readByGroup(pdu);
      case ATT.readByTypeReq:
        return await this.#readByType(pdu);
      case ATT.findInfoReq:
        return this.#findInfo(pdu);
      case ATT.readReq:
        return await this.#read(pdu);
      case ATT.writeReq:
      case ATT.writeCmd:
        return await this.#write(pdu);
      case ATT.confirm:
      case ATT.notify:
      case ATT.indicate:
        return null;
      default:
        // Commands (bit 6 set) are ignored; any other request is not supported (Vol 3 Part F §3.4.1.1).
        return op & 0x40 ? null : errorRsp(op, 0, ATT_ERROR.requestNotSupported);
    }
  }

  /** The PDU that passes the node's notification or indication to the phone, if it subscribed. */
  notification(valueHandle: number, value: Uint8Array): Uint8Array | null {
    const bits = this.#cccd.get(valueHandle) ?? 0;
    if (bits === 0) return null;
    // ponytail: an indication is not waited on for its confirmation; the node's own
    // acknowledgements already crossed the simulated air. Revisit if a phone needs the pacing.
    return Uint8Array.of(
      bits & 1 ? ATT.notify : ATT.indicate,
      ...u16(valueHandle),
      ...value.slice(0, ATT_MTU - 3),
    );
  }

  /** `[start, end]` of a request, or the error response when the range is not valid (§3.4.1.1). */
  #range(pdu: Uint8Array): [number, number] | Uint8Array {
    const start = readU16(pdu, 1);
    const end = readU16(pdu, 3);
    return start === 0 || start > end ? errorRsp(pdu[0] ?? 0, start, ATT_ERROR.invalidHandle) : [
      start,
      end,
    ];
  }

  #readByGroup(pdu: Uint8Array): Uint8Array {
    const range = this.#range(pdu);
    if (range instanceof Uint8Array) return range;
    const [start, end] = range;
    const type = pdu.length === 7 ? readU16(pdu, 5) : -1;
    if (type !== GATT_UUID.primaryService) {
      return errorRsp(ATT.readByGroupReq, start, UNSUPPORTED_GROUP_TYPE);
    }
    const found = this.#services.filter((s) => s.startHandle >= start && s.startHandle <= end);
    if (found.length === 0) return errorRsp(ATT.readByGroupReq, start, ATT_ERROR.attributeNotFound);
    // Every entry of a response has the same length, and the client resumes after the last one it
    // got: stop at the first that differs rather than skip it, or it would never be asked for.
    const size = 4 + uuidToBytes((found[0] as DiscoveredService).uuid).length;
    const run: DiscoveredService[] = [];
    for (const s of found) {
      if (4 + uuidToBytes(s.uuid).length !== size) break;
      run.push(s);
    }
    return Uint8Array.of(
      ATT.readByGroupRsp,
      size,
      ...run.slice(0, Math.floor((ATT_MTU - 2) / size)).flatMap((s) => [
        ...u16(s.startHandle),
        ...u16(s.endHandle),
        ...uuidToBytes(s.uuid),
      ]),
    );
  }

  async #readByType(pdu: Uint8Array): Promise<Uint8Array> {
    const range = this.#range(pdu);
    if (range instanceof Uint8Array) return range;
    const [start, end] = range;
    if (pdu.length !== 7 && pdu.length !== 21) {
      return errorRsp(ATT.readByTypeReq, start, INVALID_PDU);
    }
    const type = uuidToString(pdu.slice(5));
    const found = this.#attributes.filter((a) =>
      a.type === type && a.handle >= start && a.handle <= end
    );
    const first = found[0];
    if (first === undefined) {
      return errorRsp(ATT.readByTypeReq, start, ATT_ERROR.attributeNotFound);
    }
    // A characteristic's value or CCCD is read for the one handle; declarations come in runs.
    if (first.kind !== "fixed") {
      return await this.#answer(ATT.readByTypeReq, first.handle, async () => {
        const value = await this.#valueOf(first);
        return Uint8Array.of(ATT.readByTypeRsp, value.length + 2, ...u16(first.handle), ...value);
      });
    }
    const length = first.value.length;
    const run: Attribute[] = [];
    for (const a of found) {
      if (a.kind !== "fixed" || a.value.length !== length) break;
      run.push(a);
    }
    return Uint8Array.of(
      ATT.readByTypeRsp,
      length + 2,
      ...run.slice(0, Math.floor((ATT_MTU - 2) / (length + 2))).flatMap((
        a,
      ) => [...u16(a.handle), ...(a as { value: Uint8Array }).value]),
    );
  }

  #findInfo(pdu: Uint8Array): Uint8Array {
    const range = this.#range(pdu);
    if (range instanceof Uint8Array) return range;
    const [start, end] = range;
    const found = this.#attributes.filter((a) => a.handle >= start && a.handle <= end);
    if (found.length === 0) return errorRsp(ATT.findInfoReq, start, ATT_ERROR.attributeNotFound);
    // One format per response, 16-bit or 128-bit: stop at the first of the other (see #readByGroup).
    const short = uuidToBytes((found[0] as Attribute).type).length === 2;
    const run: Attribute[] = [];
    for (const a of found) {
      if ((uuidToBytes(a.type).length === 2) !== short) break;
      run.push(a);
    }
    return Uint8Array.of(
      ATT.findInfoRsp,
      short ? 1 : 2,
      ...run.slice(0, Math.floor((ATT_MTU - 2) / (short ? 4 : 18))).flatMap((a) => [
        ...u16(a.handle),
        ...uuidToBytes(a.type),
      ]),
    );
  }

  /** The attribute's value: the CCCD as the phone set it, a characteristic's from the node. */
  async #valueOf(attribute: Attribute): Promise<Uint8Array> {
    if (attribute.kind === "fixed") return attribute.value;
    if (attribute.kind === "cccd") {
      return Uint8Array.from(u16(this.#cccd.get(attribute.char.valueHandle) ?? 0));
    }
    return await this.#handlers.read(attribute.handle);
  }

  async #read(pdu: Uint8Array): Promise<Uint8Array> {
    const handle = readU16(pdu, 1);
    const attribute = this.#attributes.find((a) => a.handle === handle);
    if (attribute === undefined) return errorRsp(ATT.readReq, handle, ATT_ERROR.invalidHandle);
    if (attribute.kind === "value" && !(attribute.char.properties & PROPERTY.read)) {
      return errorRsp(ATT.readReq, handle, ATT_ERROR.readNotPermitted);
    }
    return await this.#answer(
      ATT.readReq,
      handle,
      async () =>
        Uint8Array.of(ATT.readRsp, ...(await this.#valueOf(attribute)).slice(0, ATT_MTU - 1)),
    );
  }

  async #write(pdu: Uint8Array): Promise<Uint8Array | null> {
    const op = pdu[0] ?? 0;
    const withResponse = op === ATT.writeReq;
    const handle = readU16(pdu, 1);
    const value = pdu.slice(3);
    // A command has no answer, not even an error.
    const refuse = (code: number) => (withResponse ? errorRsp(op, handle, code) : null);
    const attribute = this.#attributes.find((a) => a.handle === handle);
    if (attribute === undefined) return refuse(ATT_ERROR.invalidHandle);
    if (attribute.kind === "fixed") return refuse(ATT_ERROR.writeNotPermitted);
    const { properties } = attribute.char;
    if (attribute.kind === "cccd") {
      if (!withResponse) return null;
      if (value.length !== 2) return refuse(ATT_ERROR.invalidLength);
      const bits = readU16(value, 0);
      const allowed = (properties & PROPERTY.notify ? 1 : 0) |
        (properties & PROPERTY.indicate ? 2 : 0);
      if (bits & ~allowed || bits === 3) return refuse(ATT_ERROR.writeNotPermitted);
      return await this.#answer(op, handle, async () => {
        await this.#handlers.subscribe(attribute.char.valueHandle, bits !== 0);
        if (bits === 0) this.#cccd.delete(attribute.char.valueHandle);
        else this.#cccd.set(attribute.char.valueHandle, bits);
        return Uint8Array.of(ATT.writeRsp);
      });
    }
    const allowed = withResponse ? PROPERTY.write : PROPERTY.writeWithoutResponse;
    if (!(properties & allowed)) return refuse(ATT_ERROR.writeNotPermitted);
    if (!withResponse) {
      await this.#handlers.write(handle, value, false).catch(() => {}); // the bridge logs a refusal
      return null;
    }
    return await this.#answer(op, handle, async () => {
      await this.#handlers.write(handle, value, true);
      return Uint8Array.of(ATT.writeRsp);
    });
  }

  /** Run what answers a request; what the bridge refused becomes the ATT error the phone gets. */
  async #answer(
    request: number,
    handle: number,
    run: () => Promise<Uint8Array>,
  ): Promise<Uint8Array> {
    try {
      return await run();
    } catch (error) {
      const refused = error instanceof GattOperationError && error.kind === "not-permitted";
      const reading = request === ATT.readReq || request === ATT.readByTypeReq;
      const code = !refused
        ? UNLIKELY_ERROR
        : reading
        ? ATT_ERROR.readNotPermitted
        : ATT_ERROR.writeNotPermitted;
      return errorRsp(request, handle, code);
    }
  }
}

export interface NetsimPeripheralOptions {
  /** Where netsimd's HCI port listens: 127.0.0.1:6402 for the emulator's own. */
  host: string;
  port: number;
  /** A line for the bridge's log (the phone connected, or left). */
  log?(line: string): void;
  /** Something went wrong after start that the report must show. */
  onProblem?(message: string): void;
}

export class NetsimPeripheral implements GattPeripheral {
  readonly description: string;
  readonly #opts: NetsimPeripheralOptions;
  #conn: Deno.TcpConn | null = null;
  #host: HciHost | null = null;
  #reading: Promise<void> = Promise.resolve();
  #writes: Promise<void> = Promise.resolve();
  #jobs: Promise<void> = Promise.resolve();
  #table: GattTable | null = null;
  #handlers: PeripheralHandlers | null = null;
  #name = "";
  #serviceUuid: Uint8Array | undefined;
  /** The connection handle of the app that is connected, if any. */
  #phone: number | null = null;
  #ended = false;

  constructor(opts: NetsimPeripheralOptions) {
    this.#opts = opts;
    this.description = `netsim HCI port ${opts.host}:${opts.port}`;
  }

  /** Connect to netsim's HCI port and bring the controller it gives us up. */
  async open(): Promise<void> {
    const { host, port } = this.#opts;
    const where = `${host}:${port}`;
    try {
      this.#conn = await Deno.connect({ hostname: host, port });
    } catch (error) {
      throw new BridgeStartError(
        `cannot reach netsim's HCI port at ${where}: ${
          error instanceof Error ? error.message : error
        }. The emulator starts netsimd (an android: section starts the emulator); ` +
          `a netsimd of your own needs --hci-port ${port}`,
      );
    }
    this.#conn.setNoDelay(true);
    const conn = this.#conn;
    const hci = new HciHost((bytes) => this.#write(conn, bytes), {
      connected: (handle, role, _peer, status) => this.#onConnected(handle, role, status),
      disconnected: (handle, reason) => this.#onDisconnected(handle, reason),
      att: (handle, pdu) => this.#onAtt(handle, pdu),
    });
    this.#host = hci;
    this.#reading = this.#readLoop(conn, hci);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        hci.init(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`no answer to HCI Reset within ${OPEN_TIMEOUT_MS / 1000} s`)),
            OPEN_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      await this.close();
      throw new BridgeStartError(
        `netsim's HCI port at ${where} is not a Bluetooth controller: ${
          error instanceof Error ? error.message : error
        }`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async start(
    services: DiscoveredService[],
    name: string,
    handlers: PeripheralHandlers,
  ): Promise<void> {
    if (this.#host === null) await this.open();
    this.#table = new GattTable(services, handlers);
    this.#handlers = handlers;
    this.#name = name;
    const first = services[0];
    this.#serviceUuid = first ? uuidToBytes(first.uuid) : undefined;
    await this.#host!.advertise(name, ADVERTISING_INTERVAL_MS, this.#serviceUuid);
  }

  notify(handle: number, value: Uint8Array): void {
    const pdu = this.#table?.notification(handle, value);
    if (pdu && this.#phone !== null) this.#host?.sendAtt(this.#phone, pdu);
  }

  async close(): Promise<void> {
    this.#ended = true;
    this.#host?.fail(new Error("the bridge shut down"));
    try {
      this.#conn?.close();
    } catch {
      // netsim closed its end first (the emulator stopped before the bridge did)
    }
    this.#conn = null;
    await this.#reading;
    await this.#jobs;
  }

  async #write(conn: Deno.TcpConn, bytes: Uint8Array): Promise<void> {
    const next = this.#writes.then(async () => {
      let written = 0;
      while (written < bytes.length) written += await conn.write(bytes.subarray(written));
    });
    this.#writes = next.catch(() => {});
    await next;
  }

  async #readLoop(conn: Deno.TcpConn, hci: HciHost): Promise<void> {
    const buffer = new Uint8Array(4096);
    try {
      for (;;) {
        const n = await conn.read(buffer);
        if (n === null) break;
        hci.feed(buffer.slice(0, n));
      }
    } catch {
      // closed by close(), or reset by netsim; either way the loop ends below
    }
    if (!this.#ended) {
      this.#ended = true;
      // Not a problem of the run: stopping the emulator ends netsimd before the bridge closes.
      this.#opts.log?.("bridge netsim closed the HCI connection (the emulator stopped?)");
    }
    hci.fail(new Error("netsim closed the HCI connection"));
  }

  /** One job at a time, in the order the events arrived. */
  #run(job: () => Promise<void>): void {
    this.#jobs = this.#jobs.then(async () => {
      if (this.#ended) return;
      try {
        await job();
      } catch (error) {
        if (!this.#ended) {
          this.#opts.onProblem?.(error instanceof Error ? error.message : String(error));
        }
      }
    });
  }

  #onConnected(handle: number, role: "central" | "peripheral", status: number): void {
    if (role !== "peripheral") return;
    if (status !== STATUS.success) {
      // The attempt failed: advertising is off again until we say so.
      this.#run(() => this.#advertise());
      return;
    }
    this.#phone = handle;
    this.#opts.log?.("bridge phone connected");
  }

  #onDisconnected(handle: number, reason: number): void {
    if (handle !== this.#phone) return;
    this.#phone = null;
    this.#opts.log?.(
      `bridge phone disconnected reason=0x${reason.toString(16).padStart(2, "0")}`,
    );
    const table = this.#table;
    const subscribed = table?.reset() ?? [];
    this.#run(async () => {
      // The node keeps notifying a CCCD nobody listens to otherwise; BlueZ ends it the same way.
      await Promise.all(subscribed.map((h) => this.#handlers?.subscribe(h, false).catch(() => {})));
      await this.#advertise();
    });
  }

  #onAtt(handle: number, pdu: Uint8Array): void {
    if (handle !== this.#phone) return;
    this.#run(async () => {
      const answer = await this.#table?.handle(pdu);
      if (answer && handle === this.#phone) this.#host?.sendAtt(handle, answer);
    });
  }

  async #advertise(): Promise<void> {
    await this.#host?.advertise(this.#name, ADVERTISING_INTERVAL_MS, this.#serviceUuid);
  }
}
