// Golden values for the LoRa and nRF24 PHY arithmetic. Each expected number
// is worked out by hand from the formula in the datasheet, in the comment
// next to it, so a change to the code cannot quietly move it.

import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import {
  bandwidthCode,
  chipPacketErrorRate,
  environmentFromPreset,
  frfToHz,
  hzToFrf,
  linkBudgetAt,
  LORA_NOISE_FIGURE_DB,
  loraAirtimeMs,
  loraBitRate,
  type LoraModulation,
  loraSensitivityDbm,
  lowDataRateOptimizeRequired,
  nrf24AirtimeUs,
  nrf24ChannelFrequencyHz,
  nrf24RequiredSnrDb,
  nrf24TxPowerDbm,
  sameLoraChannel,
  symbolTimeMs,
} from "../engine/mod.ts";

const SF7: LoraModulation = {
  frequencyHz: 868.1e6,
  sf: 7,
  bandwidthHz: 125e3,
  codingRate: 1,
  preambleLength: 8,
  explicitHeader: true,
  crc: true,
  lowDataRateOptimize: false,
  syncWord: 0x12,
  invertIq: false,
};
const SF12: LoraModulation = { ...SF7, sf: 12, lowDataRateOptimize: true };

Deno.test("lora: symbol time is 2^SF / BW", () => {
  assertAlmostEquals(symbolTimeMs(7, 125e3), 1.024, 1e-12);
  assertAlmostEquals(symbolTimeMs(12, 125e3), 32.768, 1e-12);
  // LDO is required above 16 ms per symbol: SF11 and SF12 at 125 kHz, not SF10.
  assert(lowDataRateOptimizeRequired(11, 125e3));
  assert(!lowDataRateOptimizeRequired(10, 125e3));
});

Deno.test("lora: time on air, SF7 BW125 CR4/5, 8-symbol preamble, explicit header, CRC, 20 bytes", () => {
  // Tpre = 12.25 * 1.024 = 12.544 ms
  // ceil((160 - 28 + 28 + 16) / 28) = ceil(6.29) = 7; 7 * 5 + 8 = 43 symbols = 44.032 ms
  assertAlmostEquals(loraAirtimeMs(SF7, 20), 56.576, 1e-9);
});

Deno.test("lora: time on air, SF12 with LowDataRateOptimize, 20 bytes", () => {
  // Tpre = 12.25 * 32.768 = 401.408 ms
  // ceil((160 - 48 + 28 + 16) / (4 * 10)) = ceil(3.9) = 4; 4 * 5 + 8 = 28 symbols = 917.504 ms
  assertAlmostEquals(loraAirtimeMs(SF12, 20), 1318.912, 1e-9);
});

Deno.test("lora: the LowDataRateOptimize branch changes the symbol count", () => {
  // 50 bytes: numerator 400 - 48 + 28 + 16 = 396.
  // DE=1: ceil(396 / 40) = 10 -> 58 symbols; DE=0: ceil(396 / 48) = 9 -> 53 symbols.
  assertAlmostEquals(loraAirtimeMs(SF12, 50), (12.25 + 58) * 32.768, 1e-9);
  assertAlmostEquals(
    loraAirtimeMs({ ...SF12, lowDataRateOptimize: false }, 50),
    (12.25 + 53) * 32.768,
    1e-9,
  );
});

Deno.test("lora: the max(..., 0) branch leaves the 8 header symbols", () => {
  // Implicit header, no CRC, empty payload: 0 - 48 + 28 + 0 - 20 = -40 -> 0.
  const mod = { ...SF12, explicitHeader: false, crc: false };
  assertAlmostEquals(loraAirtimeMs(mod, 0), (12.25 + 8) * 32.768, 1e-9);
});

Deno.test("lora: coding rate and preamble lengthen the packet", () => {
  // CR4/8: 7 * 8 + 8 = 64 symbols; preamble 12.25 -> 76.25 * 1.024
  assertAlmostEquals(loraAirtimeMs({ ...SF7, codingRate: 4 }, 20), 76.25 * 1.024, 1e-9);
  // A 16-symbol preamble adds 8 symbols.
  assertAlmostEquals(loraAirtimeMs({ ...SF7, preambleLength: 16 }, 20), 56.576 + 8 * 1.024, 1e-9);
});

Deno.test("lora: bit rate, sensitivity and Frf encoding", () => {
  // SF7 BW125 CR4/5: 7 * 125000 / 128 * 4/5 = 5468.75 bit/s
  assertAlmostEquals(loraBitRate(SF7), 5468.75, 1e-9);
  // -174 + 10 log10(125e3) + 6 - 20 = -137.03 dBm, the SX1276 datasheet figure
  assertEquals(LORA_NOISE_FIGURE_DB, 6);
  assertAlmostEquals(loraSensitivityDbm(12, 125e3), -137.03, 0.01);
  assertAlmostEquals(loraSensitivityDbm(7, 125e3), -124.53, 0.01);
  // arduino-LoRa: frf = (868.1e6 << 19) / 32e6 = 14222950 (0xd90666)
  assertEquals(hzToFrf(868.1e6), 0xd90666);
  assertAlmostEquals(frfToHz(0xd90666), 868_099_975.59, 0.01);
  assertEquals(bandwidthCode(125e3), 7);
  assertEquals(bandwidthCode(100e3), -1);
  assertThrows(() => loraSensitivityDbm(13, 125e3), RangeError);
});

Deno.test("lora: channels match within a quarter of the bandwidth", () => {
  assert(sameLoraChannel(SF7, { frequencyHz: 868.1e6 + 31e3, bandwidthHz: 125e3 }));
  assert(!sameLoraChannel(SF7, { frequencyHz: 868.1e6 + 32e3, bandwidthHz: 125e3 }));
  assert(!sameLoraChannel(SF7, { frequencyHz: 868.1e6, bandwidthHz: 250e3 }));
});

Deno.test("nrf24: channel, airtime, power and required SNR", () => {
  assertEquals(nrf24ChannelFrequencyHz(76), 2.476e9);
  assertThrows(() => nrf24ChannelFrequencyHz(126), RangeError);
  // 8 + 40 + 9 + 256 + 16 = 329 bits
  assertAlmostEquals(nrf24AirtimeUs(5, 32, 2, 1_000_000), 329, 1e-9);
  assertAlmostEquals(nrf24AirtimeUs(5, 32, 2, 2_000_000), 164.5, 1e-9);
  // An empty ACK, 3-byte address, 1-byte CRC at 250 kbit/s: 8 + 24 + 9 + 8 = 49 bits
  assertAlmostEquals(nrf24AirtimeUs(3, 0, 1, 250_000), 196, 1e-9);
  assertEquals([0, 1, 2, 3].map(nrf24TxPowerDbm), [-18, -12, -6, 0]);
  // -85 dBm sensitivity over a -104 dBm floor (1 MHz, NF 10 dB)
  assertAlmostEquals(nrf24RequiredSnrDb(1_000_000), 19, 0.01);
});

Deno.test("chip PER: 10% at the floor for the reference length, a cliff either side", () => {
  assertAlmostEquals(chipPacketErrorRate(-7.5, -7.5, 20, 20), 0.1, 1e-12);
  assert(chipPacketErrorRate(-3.5, -7.5, 20, 20) < 0.001);
  assert(chipPacketErrorRate(-11.5, -7.5, 20, 20) > 0.99);
});

Deno.test("linkBudgetAt: a sub-GHz carrier loses 9 dB less at 1 m than 2.4 GHz", () => {
  const env = environmentFromPreset("free_space", { shadowingSigmaDb: 0 });
  const tx = { position: { x: 0, y: 0 }, txPowerDbm: 14, antennaGainDbi: 0 };
  const rx = { position: { x: 100, y: 0 }, antennaGainDbi: 0 };
  const lora = linkBudgetAt(env, tx, rx, {
    frequencyHz: 868e6,
    bandwidthHz: 125e3,
    noiseFigureDb: 6,
  }, 0);
  const wifi = linkBudgetAt(env, tx, rx, {
    frequencyHz: 2.437e9,
    bandwidthHz: 20e6,
    noiseFigureDb: 10,
  }, 0);
  // 20 log10(2437 / 868) = 8.97 dB
  assertAlmostEquals(wifi.pathLossDb - lora.pathLossDb, 8.97, 0.01);
  // Free space at 100 m and 868 MHz: 20 log10(4 pi 100 868e6 / c) = 71.21 dB
  assertAlmostEquals(lora.rssiDbm, 14 - 71.21, 0.01);
  assertAlmostEquals(lora.noiseFloorDbm, -174 + 50.97 + 6, 0.01);
});
