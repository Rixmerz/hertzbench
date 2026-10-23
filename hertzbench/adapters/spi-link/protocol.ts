// spi-link: the byte protocol between a board and a radio chip model over one
// ordered TCP stream (loopback, one port per node). Fixed-size messages:
//
//   board -> engine
//     0x01 mosi            XFER   one SPI byte; the engine answers with MISO
//     0x02 gpio level      PIN    the board drove a pin wired to the chip
//   engine -> board
//     0x81 miso            MISO   the answer to the XFER before it
//     0x03 gpio level      DRIVE  the chip drives a board input (DIO0, IRQ)
//
// XFER is synchronous: the board sends the next one only after its MISO came
// back, which keeps chip-select edges and bytes in the order the guest made
// them. DRIVE may arrive at any time, also between an XFER and its MISO.
// The Python side is backend/app/services/esp32_worker.py (RadioSpiLink).

import type { Level } from "./device.ts";

export const OP_XFER = 0x01;
export const OP_PIN = 0x02;
export const OP_DRIVE = 0x03;
export const OP_MISO = 0x81;

const LENGTHS: Readonly<Record<number, number>> = {
  [OP_XFER]: 2,
  [OP_PIN]: 3,
  [OP_DRIVE]: 3,
  [OP_MISO]: 2,
};

export type SpiLinkMessage =
  | { op: "xfer"; mosi: number }
  | { op: "pin"; gpio: number; level: Level }
  | { op: "drive"; gpio: number; level: Level }
  | { op: "miso"; miso: number };

export class ProtocolError extends Error {
  override name = "ProtocolError";
}

function byte(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`${what} must be a byte, got ${value}`);
  }
  return value;
}

export function encode(message: SpiLinkMessage): Uint8Array {
  switch (message.op) {
    case "xfer":
      return Uint8Array.of(OP_XFER, byte(message.mosi, "mosi"));
    case "miso":
      return Uint8Array.of(OP_MISO, byte(message.miso, "miso"));
    case "pin":
      return Uint8Array.of(OP_PIN, byte(message.gpio, "gpio"), message.level);
    case "drive":
      return Uint8Array.of(OP_DRIVE, byte(message.gpio, "gpio"), message.level);
  }
}

/** Reassembles messages from arbitrary TCP chunks. */
export class MessageDecoder {
  #pending: number[] = [];

  push(chunk: Uint8Array): SpiLinkMessage[] {
    for (const b of chunk) this.#pending.push(b);
    const out: SpiLinkMessage[] = [];
    let offset = 0;
    while (offset < this.#pending.length) {
      const op = this.#pending[offset] as number;
      const length = LENGTHS[op];
      if (length === undefined) {
        throw new ProtocolError(
          `spi-link: unknown message 0x${op.toString(16)}; stream is corrupt`,
        );
      }
      if (this.#pending.length - offset < length) break;
      const a = this.#pending[offset + 1] as number;
      const b = this.#pending[offset + 2] ?? 0;
      if ((op === OP_PIN || op === OP_DRIVE) && b > 1) {
        throw new ProtocolError(`spi-link: pin level ${b} is not 0 or 1; stream is corrupt`);
      }
      const level = b as Level;
      out.push(
        op === OP_XFER
          ? { op: "xfer", mosi: a }
          : op === OP_MISO
          ? { op: "miso", miso: a }
          : op === OP_PIN
          ? { op: "pin", gpio: a, level }
          : { op: "drive", gpio: a, level },
      );
      offset += length;
    }
    this.#pending = this.#pending.slice(offset);
    return out;
  }
}
