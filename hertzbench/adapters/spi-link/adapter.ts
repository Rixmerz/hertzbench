// spi-link adapter: connects each board's SPI bus to its radio chip model.
//
// One loopback TCP listener per node (adapters/loopback-ports.ts). The board
// (the patched Velxio ESP32 worker, or a scripted board) connects as the
// client and speaks protocol.ts: every XFER is answered by the model's MISO,
// PIN messages move the chip's input lines, and the model's output lines go
// back as DRIVE messages.
//
// Fidelity F1 for the radio: the firmware's own driver runs unmodified
// against a register-level model of the chip.

import { LoopbackPorts } from "../loopback-ports.ts";
import type { PinDriver, SpiDevice } from "./device.ts";
import { encode, MessageDecoder, type SpiLinkMessage } from "./protocol.ts";

export interface SpiAttachment<D extends SpiDevice> {
  nodeId: string;
  /** Port the board connects to. */
  port: number;
  device: D;
}

export class SpiLinkAdapter {
  readonly #ports: LoopbackPorts;

  constructor(onProblem: (nodeId: string, message: string) => void = () => {}) {
    this.#ports = new LoopbackPorts(onProblem);
  }

  /**
   * Listen for a node's board. `makeDevice` builds the chip model with the
   * function it drives the board's input pins through.
   */
  listen<D extends SpiDevice>(
    nodeId: string,
    makeDevice: (drive: PinDriver) => D,
  ): SpiAttachment<D> {
    const device = makeDevice((gpio, level) => {
      this.#ports.send(nodeId, encode({ op: "drive", gpio, level }));
    });
    const port = this.#ports.listen(nodeId, () => {
      const decoder = new MessageDecoder();
      return (chunk) => {
        const replies: Uint8Array[] = [];
        for (const message of decoder.push(chunk)) {
          const reply = handle(device, message);
          if (reply) replies.push(reply);
        }
        if (replies.length > 0) this.#ports.send(nodeId, concat(replies));
      };
    });
    return { nodeId, port, device };
  }

  isConnected(nodeId: string): boolean {
    return this.#ports.isConnected(nodeId);
  }

  waitConnected(nodeId: string, timeoutMs: number): Promise<void> {
    return this.#ports.waitConnected(nodeId, timeoutMs);
  }

  close(): Promise<void> {
    return this.#ports.close();
  }
}

function handle(device: SpiDevice, message: SpiLinkMessage): Uint8Array | null {
  switch (message.op) {
    case "xfer":
      return encode({ op: "miso", miso: device.transfer(message.mosi) & 0xff });
    case "pin":
      device.pinChanged(message.gpio, message.level);
      return null;
    default:
      throw new Error(`spi-link: a board sent ${message.op}, which only the engine sends`);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
