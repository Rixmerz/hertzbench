// The board side of spi-link in TypeScript, for scripted boards and tests: a
// DriverBus whose pins and bytes travel to the chip model over the socket,
// with the chip's DRIVE messages handed to `onDrive`.

import type { Level } from "./device.ts";
import { encode, MessageDecoder } from "./protocol.ts";

export class SpiLinkClient {
  readonly #conn: Deno.TcpConn;
  readonly #decoder = new MessageDecoder();
  readonly #misos: number[] = [];
  readonly #reading: Promise<void>;
  #waiter: ((miso: number) => void) | null = null;
  #failed: Error | null = null;
  #onDrive: (gpio: number, level: Level) => void = () => {};

  private constructor(conn: Deno.TcpConn) {
    this.#conn = conn;
    this.#reading = this.#readLoop();
  }

  static async connect(port: number): Promise<SpiLinkClient> {
    const conn = await Deno.connect({ hostname: "127.0.0.1", port });
    conn.setNoDelay(true);
    return new SpiLinkClient(conn);
  }

  onDrive(handler: (gpio: number, level: Level) => void): void {
    this.#onDrive = handler;
  }

  async digitalWrite(gpio: number, level: Level): Promise<void> {
    await this.#write(encode({ op: "pin", gpio, level }));
  }

  async transfer(mosi: number): Promise<number> {
    await this.#write(encode({ op: "xfer", mosi }));
    const ready = this.#misos.shift();
    if (ready !== undefined) return ready;
    if (this.#failed) throw this.#failed;
    return await new Promise<number>((resolve) => {
      this.#waiter = resolve;
    });
  }

  async close(): Promise<void> {
    try {
      this.#conn.close();
    } catch {
      // The adapter closed it first at the end of the run.
    }
    await this.#reading;
  }

  async #write(bytes: Uint8Array): Promise<void> {
    if (this.#failed) throw this.#failed;
    let written = 0;
    while (written < bytes.length) written += await this.#conn.write(bytes.subarray(written));
  }

  async #readLoop(): Promise<void> {
    const buffer = new Uint8Array(4096);
    try {
      for (;;) {
        const n = await this.#conn.read(buffer);
        if (n === null) break;
        for (const message of this.#decoder.push(buffer.subarray(0, n))) {
          if (message.op === "drive") this.#onDrive(message.gpio, message.level);
          else if (message.op === "miso") {
            const waiter = this.#waiter;
            this.#waiter = null;
            if (waiter) waiter(message.miso);
            else this.#misos.push(message.miso);
          }
        }
      }
    } catch {
      // Closed by close() or by the adapter at the end of the run.
    }
    this.#failed = new Error("spi-link connection closed");
    // A transfer still waiting would hang the scripted board: answer it as a floating bus.
    this.#waiter?.(0xff);
    this.#waiter = null;
  }
}
