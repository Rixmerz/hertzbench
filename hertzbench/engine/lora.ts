// LoRa PHY arithmetic: time on air, symbol time, demodulation floor and the
// register encodings the SX127x uses for them. Pure functions, no state.
//
// Sources: Semtech SX1276/77/78/79 datasheet rev. 7, §4.1.1 (time on air,
// eq. in 4.1.1.6), table 13 (SNR floor per spreading factor) and §6.4
// (register map), and Semtech AN1200.13 (LoRa modem designer's guide).

import { noiseFloorDbm } from "./channel.ts";

/** Crystal of every SX127x module in circulation; Frf = F_XOSC * frf / 2^19. */
export const SX127X_FXOSC_HZ = 32e6;
const FRF_SCALE = 2 ** 19;

/** RegModemConfig1 bits 7:4 to Hz (SX1276/77/78/79). */
export const LORA_BANDWIDTHS_HZ: readonly number[] = [
  7.8e3,
  10.4e3,
  15.6e3,
  20.8e3,
  31.25e3,
  41.7e3,
  62.5e3,
  125e3,
  250e3,
  500e3,
];

/**
 * SNR below which the modem cannot demodulate, per spreading factor
 * (datasheet table 13). SF6 is the datasheet's -5 dB.
 */
export const LORA_REQUIRED_SNR_DB: Readonly<Record<number, number>> = {
  6: -5,
  7: -7.5,
  8: -10,
  9: -12.5,
  10: -15,
  11: -17.5,
  12: -20,
};

/**
 * Receiver noise figure that reproduces the datasheet sensitivity: with 6 dB,
 * SF12 at 125 kHz gives -174 + 51 + 6 - 20 = -137 dBm, the figure the
 * SX1276 datasheet lists (LnaBoost on).
 */
export const LORA_NOISE_FIGURE_DB = 6;

/**
 * A packet survives a same-channel, same-SF overlap only when it is this much
 * stronger than the other one (LoRa co-channel rejection; AN1200.22 and the
 * capture-effect literature put it at about 6 dB).
 */
export const LORA_CAPTURE_DB = 6;

/** Payload length at which the waterfall puts 10% loss exactly at the SNR floor. */
export const LORA_REFERENCE_BYTES = 20;

export interface LoraModulation {
  frequencyHz: number;
  /** Spreading factor, 6-12. */
  sf: number;
  bandwidthHz: number;
  /** 1-4, meaning coding rate 4/5 to 4/8 (the CodingRate field of RegModemConfig1). */
  codingRate: number;
  /** Programmed preamble length in symbols (RegPreamble); the modem adds 4.25. */
  preambleLength: number;
  explicitHeader: boolean;
  crc: boolean;
  lowDataRateOptimize: boolean;
  syncWord: number;
  /** I/Q inverted on the air (LoRaWAN downlinks). */
  invertIq: boolean;
}

export function frfToHz(frf: number): number {
  return (frf * SX127X_FXOSC_HZ) / FRF_SCALE;
}

/** The value arduino-LoRa's setFrequency writes: floor(f * 2^19 / F_XOSC). */
export function hzToFrf(hz: number): number {
  return Math.floor((hz * FRF_SCALE) / SX127X_FXOSC_HZ);
}

/** Register code of a bandwidth, or -1 when the chip has no such setting. */
export function bandwidthCode(hz: number): number {
  return LORA_BANDWIDTHS_HZ.indexOf(hz);
}

export function symbolTimeMs(sf: number, bandwidthHz: number): number {
  return (2 ** sf / bandwidthHz) * 1000;
}

/** The datasheet asks for LowDataRateOptimize when a symbol lasts longer than 16 ms. */
export function lowDataRateOptimizeRequired(sf: number, bandwidthHz: number): boolean {
  return symbolTimeMs(sf, bandwidthHz) > 16;
}

/**
 * Time on air of a LoRa packet (datasheet §4.1.1.6):
 *
 *   Tpreamble = (nPreamble + 4.25) * Tsym
 *   nPayload  = 8 + max(ceil((8PL - 4SF + 28 + 16CRC - 20IH) / (4(SF - 2DE))) * (CR + 4), 0)
 *
 * with IH = 1 for an implicit header and DE = 1 with LowDataRateOptimize.
 */
export function loraAirtimeMs(mod: LoraModulation, payloadBytes: number): number {
  const tsym = symbolTimeMs(mod.sf, mod.bandwidthHz);
  const preamble = (mod.preambleLength + 4.25) * tsym;
  const ih = mod.explicitHeader ? 0 : 1;
  const de = mod.lowDataRateOptimize ? 1 : 0;
  const crc = mod.crc ? 1 : 0;
  const numerator = 8 * payloadBytes - 4 * mod.sf + 28 + 16 * crc - 20 * ih;
  const symbols = 8 +
    Math.max(Math.ceil(numerator / (4 * (mod.sf - 2 * de))) * (mod.codingRate + 4), 0);
  return preamble + symbols * tsym;
}

/** Useful bit rate: SF * BW / 2^SF * 4 / (4 + CR). */
export function loraBitRate(mod: Pick<LoraModulation, "sf" | "bandwidthHz" | "codingRate">) {
  return (mod.sf * mod.bandwidthHz / 2 ** mod.sf) * (4 / (4 + mod.codingRate));
}

export function loraRequiredSnrDb(sf: number): number {
  const snr = LORA_REQUIRED_SNR_DB[sf];
  if (snr === undefined) throw new RangeError(`LoRa spreading factor must be 6-12, got ${sf}`);
  return snr;
}

export function loraSensitivityDbm(sf: number, bandwidthHz: number): number {
  return noiseFloorDbm(LORA_NOISE_FIGURE_DB, bandwidthHz) + loraRequiredSnrDb(sf);
}

/**
 * Two radios share a LoRa channel when their bandwidths match and their
 * centres are within a quarter of it: the modem tolerates a carrier offset of
 * up to 25% of the bandwidth (AN1200.13).
 */
export function sameLoraChannel(
  a: Pick<LoraModulation, "frequencyHz" | "bandwidthHz">,
  b: Pick<LoraModulation, "frequencyHz" | "bandwidthHz">,
): boolean {
  return a.bandwidthHz === b.bandwidthHz &&
    Math.abs(a.frequencyHz - b.frequencyHz) <= a.bandwidthHz / 4;
}

/** "868.1 MHz SF7 BW125 CR4/5", for reports and logs. */
export function describeLora(
  mod: Pick<LoraModulation, "frequencyHz" | "sf" | "bandwidthHz" | "codingRate">,
): string {
  const mhz = Number((mod.frequencyHz / 1e6).toFixed(3));
  return `${mhz} MHz SF${mod.sf} BW${mod.bandwidthHz / 1000} CR4/${mod.codingRate + 4}`;
}
