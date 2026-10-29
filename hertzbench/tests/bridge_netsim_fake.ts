// A fake netsimd HCI port for the netsim bridge tests: an H4 controller on loopback that answers a
// host's bring-up, and the app's Bluetooth stack on the other side of it (it reports a connection
// and sends ATT requests). No emulator is involved.

import {
  addressToBytes,
  encodeHci,
  EVT,
  H4Decoder,
  type HciPacket,
  LE_SUBEVENT,
  OP,
} from "../adapters/ble-hci/hci.ts";

const u16 = (n: number) => [n & 0xff, n >> 8];

/** What a host does to the fake's connection, as the fake sees it. */
export interface FakeOptions {
  /** LE Read Buffer Size's packet count; 0 makes the host ask Read Buffer Size instead. */
  leCredits?: number;
  classicCredits?: number;
}

/** netsimd's HCI port, and the app on the other side of the controller it gives a host. */
export class FakeNetsim {
  readonly listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  readonly port = (this.listener.addr as Deno.NetAddr).port;
  /** Every opcode the host sent, in order. */
  readonly opcodes: number[] = [];
  /** The last data the host set, by opcode. */
  readonly data = new Map<number, Uint8Array>();
  readonly #options: FakeOptions;
  #conn: Deno.TcpConn | null = null;
  #serving: Promise<void>;
  /** ATT PDUs the host sent the app, oldest first, and who waits for the next. */
  readonly #att: Uint8Array[] = [];
  #waiting: ((pdu: Uint8Array) => void) | null = null;
  /** Handle Value Notifications the host sent the app, and who waits for the next. */
  readonly #notifications: Uint8Array[] = [];
  #notified: (() => void) | null = null;

  constructor(options: FakeOptions = {}) {
    this.#options = options;
    this.#serving = this.#accept();
  }

  async #accept(): Promise<void> {
    let conn: Deno.TcpConn;
    try {
      conn = await this.listener.accept();
    } catch {
      return; // closed before the host came
    }
    this.#conn = conn;
    const decoder = new H4Decoder();
    const buffer = new Uint8Array(4096);
    try {
      for (;;) {
        const n = await conn.read(buffer);
        if (n === null) break;
        for (const packet of decoder.push(buffer.slice(0, n))) await this.#onPacket(packet);
      }
    } catch {
      // the host closed
    }
  }

  async #send(packet: HciPacket): Promise<void> {
    await this.#conn?.write(encodeHci(packet));
  }

  #complete(opcode: number, ...returned: number[]): Promise<void> {
    return this.#send({
      type: "event",
      code: EVT.commandComplete,
      params: Uint8Array.of(1, ...u16(opcode), 0, ...returned),
    });
  }

  async #onPacket(packet: HciPacket): Promise<void> {
    if (packet.type === "acl") {
      const pdu = packet.data.slice(4);
      // The controller frees the buffer once the packet is on the air.
      await this.#send({
        type: "event",
        code: EVT.numberOfCompletedPackets,
        params: Uint8Array.of(1, ...u16(packet.handle), 1, 0),
      });
      // A notification is nobody's answer: the node sends them whenever it likes.
      if (pdu[0] === 0x1b) {
        this.#notifications.push(pdu);
        this.#notified?.();
      } else if (this.#waiting) {
        const resolve = this.#waiting;
        this.#waiting = null;
        resolve(pdu);
      } else this.#att.push(pdu);
      return;
    }
    if (packet.type !== "command") return;
    const { opcode, params } = packet;
    this.opcodes.push(opcode);
    this.data.set(opcode, params);
    switch (opcode) {
      case OP.leReadBufferSize:
        return await this.#complete(opcode, ...u16(27), this.#options.leCredits ?? 4);
      case OP.readBufferSize:
        return await this.#complete(
          opcode,
          ...u16(255),
          0,
          ...u16(this.#options.classicCredits ?? 0),
          ...u16(0),
        );
      case OP.readBdAddr:
        return await this.#complete(opcode, ...addressToBytes("c0:de:00:00:00:01"));
      default:
        return await this.#complete(opcode);
    }
  }

  /** The app connected to the host's advertisement. */
  connectApp(handle: number): Promise<void> {
    return this.#send({
      type: "event",
      code: EVT.leMeta,
      params: Uint8Array.of(
        LE_SUBEVENT.connectionComplete,
        0, // status
        ...u16(handle),
        1, // role: peripheral
        0,
        ...addressToBytes("aa:bb:cc:dd:ee:01"),
        ...u16(24),
        ...u16(0),
        ...u16(200),
        0,
      ),
    });
  }

  disconnectApp(handle: number, reason: number): Promise<void> {
    return this.#send({
      type: "event",
      code: EVT.disconnectionComplete,
      params: Uint8Array.of(0, ...u16(handle), reason),
    });
  }

  /** Sends one ATT PDU from the app and resolves with the host's next ATT PDU. */
  async ask(handle: number, pdu: Uint8Array): Promise<Uint8Array> {
    const answer = this.nextAtt();
    await this.send(handle, pdu);
    return await answer;
  }

  send(handle: number, pdu: Uint8Array): Promise<void> {
    return this.#send({
      type: "acl",
      handle,
      pb: 2,
      data: Uint8Array.of(...u16(pdu.length), ...u16(4), ...pdu),
    });
  }

  nextAtt(): Promise<Uint8Array> {
    const queued = this.#att.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => (this.#waiting = resolve));
  }

  /** The next notification the host sent the app. */
  async nextNotification(): Promise<Uint8Array> {
    while (this.#notifications.length === 0) {
      await new Promise<void>((resolve) => (this.#notified = resolve));
    }
    this.#notified = null;
    return this.#notifications.shift()!;
  }

  /** netsimd going away under the host. */
  dropConnection(): void {
    this.#conn?.close();
  }

  async close(): Promise<void> {
    this.listener.close();
    try {
      this.#conn?.close();
    } catch {
      // the host or dropConnection() closed it first
    }
    await this.#serving;
  }
}
