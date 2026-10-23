// A btsnoop capture of one node's HCI (datalink 1002, "HCI UART (H4)"): every
// packet its host and the virtual controller exchanged, as the Android
// Bluetooth HCI snoop log stores them. Wireshark and BlueZ's `btmon -r` read it.
// Format: RFC 1761 framing as documented by Wireshark (wiki BTSNOOP), big-endian.

import { H4_ACL } from "./hci.ts";

const DATALINK_H4 = 1002;
/** Microseconds from 0000-01-01 to the Unix epoch, the btsnoop time base. */
const EPOCH_DELTA_US = 0x00dcddb30f2f8000n;

export type HciDirection = "host-to-controller" | "controller-to-host";

export class BtsnoopWriter {
  readonly #epochMs: number;
  readonly #chunks: Uint8Array[] = [];
  #packets = 0;
  #lastMs = -Infinity;

  /** `epochMs` is the Unix time of engine time 0. */
  constructor(epochMs: number) {
    this.#epochMs = epochMs;
    const header = new Uint8Array(16);
    header.set(new TextEncoder().encode("btsnoop\0"));
    const view = new DataView(header.buffer);
    view.setUint32(8, 1);
    view.setUint32(12, DATALINK_H4);
    this.#chunks.push(header);
  }

  get packetCount(): number {
    return this.#packets;
  }

  /** One H4 packet, indicator byte included. */
  add(tMs: number, direction: HciDirection, h4: Uint8Array): void {
    tMs = Math.max(tMs, this.#lastMs);
    this.#lastMs = tMs;
    const record = new Uint8Array(24);
    const view = new DataView(record.buffer);
    view.setUint32(0, h4.length);
    view.setUint32(4, h4.length);
    const received = direction === "controller-to-host" ? 1 : 0;
    const commandOrEvent = h4[0] === H4_ACL ? 0 : 2;
    view.setUint32(8, received | commandOrEvent);
    view.setUint32(12, 0);
    view.setBigUint64(16, BigInt(Math.round((this.#epochMs + tMs) * 1000)) + EPOCH_DELTA_US);
    this.#chunks.push(record, h4.slice());
    this.#packets++;
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this.#chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}
