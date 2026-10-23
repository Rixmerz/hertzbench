// QEMU's `stream` (and legacy TCP `socket`) netdev frames every Ethernet frame
// with a 4-byte big-endian length. TCP, not UDP, so a burst on loopback can
// never be dropped by a socket buffer and show up as modelled loss.

/** Largest frame accepted. QEMU netdev frames never exceed a jumbo frame; this guards a corrupt length prefix. */
export const MAX_FRAME_BYTES = 65535;

export class FramingError extends Error {
  override name = "FramingError";
}

export function encodeFrame(frame: Uint8Array): Uint8Array {
  if (frame.length > MAX_FRAME_BYTES) {
    throw new RangeError(`frame of ${frame.length} bytes exceeds ${MAX_FRAME_BYTES}`);
  }
  const out = new Uint8Array(4 + frame.length);
  new DataView(out.buffer).setUint32(0, frame.length);
  out.set(frame, 4);
  return out;
}

/** Reassembles frames from arbitrary TCP chunks. */
export class FrameDecoder {
  #pending: Uint8Array = new Uint8Array(0);

  /** Feed bytes; get back every complete frame they finished, in order. */
  push(chunk: Uint8Array): Uint8Array[] {
    if (this.#pending.length === 0) {
      this.#pending = chunk.slice();
    } else {
      const joined = new Uint8Array(this.#pending.length + chunk.length);
      joined.set(this.#pending, 0);
      joined.set(chunk, this.#pending.length);
      this.#pending = joined;
    }
    const frames: Uint8Array[] = [];
    let offset = 0;
    while (this.#pending.length - offset >= 4) {
      const length = new DataView(this.#pending.buffer, this.#pending.byteOffset + offset)
        .getUint32(0);
      if (length > MAX_FRAME_BYTES) {
        throw new FramingError(
          `frame length ${length} exceeds ${MAX_FRAME_BYTES}; stream is corrupt`,
        );
      }
      if (this.#pending.length - offset - 4 < length) break;
      if (length > 0) frames.push(this.#pending.slice(offset + 4, offset + 4 + length));
      offset += 4 + length;
    }
    this.#pending = this.#pending.slice(offset);
    return frames;
  }
}
