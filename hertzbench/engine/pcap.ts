// Classic libpcap writer. One record per frame put on the air, stamped with
// engine time. Losses are not in the capture (pcap has no way to say
// "dropped"); they are in the event log and metrics.json.
//
// A classic capture has one link type. The runner writes every frame as the
// netdev carries it to an Ethernet capture, and ESP-NOW frames a second time,
// converted to 802.11 (espnowToRadiotap), to a radiotap capture: in the first
// they are the fork's pseudo-Ethernet, which Wireshark cannot decode.

const GLOBAL_HEADER_BYTES = 24;
const RECORD_HEADER_BYTES = 16;
export const LINKTYPE_ETHERNET = 1;
export const LINKTYPE_IEEE802_11_RADIOTAP = 127;
const SNAPLEN = 65535;

export class PcapWriter {
  readonly #epochMs: number;
  readonly #chunks: Uint8Array[] = [];
  #packets = 0;

  /** `epochMs` is the Unix time of engine time 0, so the capture has real-looking timestamps. */
  constructor(epochMs: number, linkType = LINKTYPE_ETHERNET) {
    this.#epochMs = epochMs;
    const header = new DataView(new ArrayBuffer(GLOBAL_HEADER_BYTES));
    header.setUint32(0, 0xa1b2c3d4, true); // magic, microsecond timestamps
    header.setUint16(4, 2, true);
    header.setUint16(6, 4, true);
    header.setInt32(8, 0, true); // timezone offset
    header.setUint32(12, 0, true); // timestamp accuracy
    header.setUint32(16, SNAPLEN, true);
    header.setUint32(20, linkType, true);
    this.#chunks.push(new Uint8Array(header.buffer));
  }

  get packetCount(): number {
    return this.#packets;
  }

  addFrame(tMs: number, frame: Uint8Array): void {
    const totalUs = Math.round((this.#epochMs + tMs) * 1000);
    const captured = Math.min(frame.length, SNAPLEN);
    const header = new DataView(new ArrayBuffer(RECORD_HEADER_BYTES));
    header.setUint32(0, Math.floor(totalUs / 1_000_000), true);
    header.setUint32(4, totalUs % 1_000_000, true);
    header.setUint32(8, captured, true);
    header.setUint32(12, frame.length, true);
    this.#chunks.push(new Uint8Array(header.buffer), frame.slice(0, captured));
    this.#packets++;
  }

  toBytes(): Uint8Array {
    const size = this.#chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}
