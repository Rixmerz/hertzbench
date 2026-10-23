// nRF24L01+ PHY arithmetic: channel frequency, packet length on the air and
// receiver sensitivity per data rate. Pure functions, no state.
//
// Source: Nordic nRF24L01+ product specification v1.0: §6.3 (RF channel),
// §7.3 (Enhanced ShockBurst packet format), table 13 (sensitivity), §6.1.7
// (130 us TX/RX settling).

import { noiseFloorDbm } from "./channel.ts";

export type Nrf24DataRate = 250_000 | 1_000_000 | 2_000_000;

export const NRF24_DATA_RATES: readonly Nrf24DataRate[] = [250_000, 1_000_000, 2_000_000];

/** Receiver sensitivity at 0.1% bit error rate (table 13). */
const SENSITIVITY_DBM: Record<Nrf24DataRate, number> = {
  250_000: -94,
  1_000_000: -85,
  2_000_000: -82,
};

/** PLL settling before every transmission and receive (Tstby2a, §6.1.7). */
export const NRF24_SETTLE_US = 130;

/** Noise figure used with the receiver bandwidth below to place the floor; only the difference to sensitivity matters. */
export const NRF24_NOISE_FIGURE_DB = 10;

/** GFSK co-channel rejection: the stronger packet survives an overlap when this much above the other (C/I co-channel, table 13). */
export const NRF24_CAPTURE_DB = 9;

/** The payload length sensitivity is specified for (the maximum). */
export const NRF24_REFERENCE_BYTES = 32;

export function isNrf24DataRate(value: number): value is Nrf24DataRate {
  return (NRF24_DATA_RATES as readonly number[]).includes(value);
}

/** F0 = 2400 + RF_CH MHz. */
export function nrf24ChannelFrequencyHz(channel: number): number {
  if (!Number.isInteger(channel) || channel < 0 || channel > 125) {
    throw new RangeError(`nRF24 channel must be 0-125, got ${channel}`);
  }
  return (2400 + channel) * 1e6;
}

/** Occupied bandwidth: 1 MHz at 250 kbit/s and 1 Mbit/s, 2 MHz at 2 Mbit/s. */
export function nrf24BandwidthHz(rate: Nrf24DataRate): number {
  return rate === 2_000_000 ? 2e6 : 1e6;
}

export function nrf24SensitivityDbm(rate: Nrf24DataRate): number {
  return SENSITIVITY_DBM[rate];
}

/** SNR the receiver needs, derived from the sensitivity and the floor the engine computes. */
export function nrf24RequiredSnrDb(rate: Nrf24DataRate): number {
  return SENSITIVITY_DBM[rate] - noiseFloorDbm(NRF24_NOISE_FIGURE_DB, nrf24BandwidthHz(rate));
}

/**
 * Enhanced ShockBurst packet on the air (§7.3): 1-byte preamble, 3-5 byte
 * address, 9-bit packet control field, payload, 0-2 byte CRC. Microseconds,
 * not counting the 130 us settling before it.
 */
export function nrf24AirtimeUs(
  addressBytes: number,
  payloadBytes: number,
  crcBytes: number,
  rate: Nrf24DataRate,
): number {
  const bits = 8 + 8 * addressBytes + 9 + 8 * payloadBytes + 8 * crcBytes;
  return (bits / rate) * 1e6;
}

/** RF_SETUP RF_PWR (bits 2:1): 0, 1, 2, 3 for -18, -12, -6 and 0 dBm. */
export function nrf24TxPowerDbm(rfPwr: number): number {
  return -18 + 6 * (rfPwr & 3);
}
