// A per-board eFuse image carrying the board's station MAC.
//
// Without one, every instance of the lcgamboa ESP32 machine takes the same
// default station MAC from hw/nvram/esp32_efuse.c (10:01:00:c4:0a:24), and the
// fork drops frames whose source is its own MAC (hw/misc/esp32_wifi_ap.c:405,
// :471), so two boards could not hear each other.
//
// The image is the Esp32EfuseRegs struct of the fork, read from offset 0
// (include/hw/nvram/esp32_efuse.h). Only blk0 words 1 and 2 are written; the
// rest stays zero, which is what a board without an image has today.

import { macToBytes } from "../../engine/mod.ts";

/** Room for sizeof(Esp32EfuseRegs) = 124 bytes, rounded to a block-device sector. */
export const EFUSE_IMAGE_BYTES = 512;

/** CRC-8 with the reflected 0x31 polynomial (Dallas/Maxim), init 0: the check ESP-IDF runs on the base MAC. */
export function efuseMacCrc8(mac: Uint8Array): number {
  let crc = 0;
  for (const byte of mac) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0x8c : crc >>> 1;
  }
  return crc;
}

/**
 * blk0[1] holds mac[2..5] reversed; blk0[2] holds mac[0] and mac[1] in bits
 * 15:0 and the CRC in bits 23:16. The fork rebuilds the MAC from the raw
 * bytes in reverse order (hw/xtensa/esp32_picsimlab.c:1070-1075).
 */
export function buildEfuseImage(mac: string): Uint8Array {
  const m = macToBytes(mac);
  const image = new Uint8Array(EFUSE_IMAGE_BYTES);
  const view = new DataView(image.buffer);
  view.setUint32(4, ((m[2]! << 24) | (m[3]! << 16) | (m[4]! << 8) | m[5]!) >>> 0, true);
  view.setUint32(8, ((efuseMacCrc8(m) << 16) | (m[0]! << 8) | m[1]!) >>> 0, true);
  return image;
}
