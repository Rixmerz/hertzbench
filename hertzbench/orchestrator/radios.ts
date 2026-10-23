// The `radios:` entry of a scenario node: one radio per node, Wi-Fi (Phase 1),
// a chip-level radio on the board's SPI bus (Phase 3: LoRa SX127x, nRF24L01+),
// or BLE through a virtual controller on an HCI UART (Phase 6).
//
// For a chip radio the scenario's modem settings are what a scripted board
// programs. Real firmware programs its own chip; for it the scenario's values
// are the declared configuration, and the run warns when the firmware put
// something else in the registers (orchestrator/runner.ts).

import type { RadioConfig } from "../engine/channel.ts";
import { isNrf24DataRate, type Nrf24DataRate } from "../engine/nrf24.ts";
import { bandwidthCode, LORA_BANDWIDTHS_HZ } from "../engine/lora.ts";

export type Phy = "wifi" | "lora" | "nrf24" | "ble";
export const PHYS: readonly Phy[] = ["wifi", "lora", "nrf24", "ble"];

export interface WifiRadio extends RadioConfig {
  phy: "wifi";
}

export interface LoraRadio {
  phy: "lora";
  frequencyHz: number;
  sf: number;
  bandwidthHz: number;
  /** Denominator of the coding rate: 5 for 4/5 up to 8 for 4/8. */
  codingRate: number;
  syncWord: number;
  preambleLength: number;
  crc: boolean;
  txPowerDbm: number;
  antennaGainDbi: number;
  /** ESP32 GPIO numbers the chip is wired to. */
  pins: { cs: number; reset: number | null; dio0: number | null };
}

export interface Nrf24Radio {
  phy: "nrf24";
  channel: number;
  dataRate: Nrf24DataRate;
  /** -18, -12, -6 or 0 dBm: the four RF_PWR steps. */
  txPowerDbm: number;
  antennaGainDbi: number;
  autoAck: boolean;
  /** Auto-retransmit count (ARC), 0-15. */
  retries: number;
  /** Auto-retransmit delay (ARD), 250-4000 us in 250 us steps. */
  retryDelayUs: number;
  pins: { csn: number; ce: number; irq: number | null };
}

export interface BleRadio {
  phy: "ble";
  txPowerDbm: number;
  antennaGainDbi: number;
  /** The UART the firmware's host stack writes HCI to. UART0 is the serial console. */
  hciUart: 1 | 2;
}

export type NodeRadio = WifiRadio | LoraRadio | Nrf24Radio | BleRadio;

type Obj = Record<string, unknown>;
type Fail = (path: string, message: string) => never;

export const DEFAULT_WIFI: WifiRadio = {
  phy: "wifi",
  channel: 6,
  txPowerDbm: 15,
  antennaGainDbi: 0,
};

/** Readers shared with scenario.ts, passed in so this module adds no second set of them. */
export interface FieldReaders {
  fail: Fail;
  record(value: unknown, path: string): Obj;
  num(value: unknown, path: string, min?: number, max?: number): number;
  int(value: unknown, path: string, min: number, max?: number): number;
  known(obj: Obj, allowed: readonly string[], path: string): void;
}

function bool(r: FieldReaders, value: unknown, fallback: boolean, path: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") r.fail(path, "expected true or false");
  return value;
}

function gpio(r: FieldReaders, value: unknown, fallback: number | null, path: string) {
  if (value === undefined) return fallback;
  if (value === null) return null;
  return r.int(value, path, 0, 39);
}

const WIFI_FIELDS = ["phy", "channel", "tx_power_dbm", "antenna_gain_dbi"] as const;
const LORA_FIELDS = [
  "phy",
  "frequency_mhz",
  "sf",
  "bw_khz",
  "cr",
  "sync_word",
  "preamble",
  "crc",
  "tx_power_dbm",
  "antenna_gain_dbi",
  "pins",
] as const;
const NRF24_FIELDS = [
  "phy",
  "channel",
  "data_rate_kbps",
  "tx_power_dbm",
  "antenna_gain_dbi",
  "auto_ack",
  "retries",
  "retry_delay_us",
  "pins",
] as const;

const BLE_FIELDS = ["phy", "tx_power_dbm", "antenna_gain_dbi", "hci_uart"] as const;

function parseBle(r: FieldReaders, radio: Obj, path: string): BleRadio {
  r.known(radio, BLE_FIELDS, path);
  const uart = r.int(radio.hci_uart ?? 1, `${path}.hci_uart`, 0, 2);
  if (uart === 0) {
    r.fail(
      `${path}.hci_uart`,
      "UART0 is the serial console; HCI bytes there would corrupt it. Use 1 or 2",
    );
  }
  return {
    phy: "ble",
    // The ESP32's BLE transmitter range is -12 to +9 dBm; other boards may differ.
    txPowerDbm: r.num(radio.tx_power_dbm ?? 0, `${path}.tx_power_dbm`, -20, 20),
    antennaGainDbi: r.num(radio.antenna_gain_dbi ?? 0, `${path}.antenna_gain_dbi`, -20, 30),
    hciUart: uart as 1 | 2,
  };
}

function parseCodingRate(r: FieldReaders, value: unknown, path: string): number {
  if (value === undefined) return 5;
  if (typeof value === "string") {
    const match = /^4\/([5-8])$/.exec(value.trim());
    if (!match) {
      r.fail(path, `expected a coding rate from "4/5" to "4/8", got ${JSON.stringify(value)}`);
    }
    return Number(match[1]);
  }
  return r.int(value, path, 5, 8);
}

function parseLora(r: FieldReaders, radio: Obj, path: string): LoraRadio {
  r.known(radio, LORA_FIELDS, path);
  const bwKhz = r.num(radio.bw_khz ?? 125, `${path}.bw_khz`);
  if (bandwidthCode(bwKhz * 1000) < 0) {
    r.fail(
      `${path}.bw_khz`,
      `the SX127x has no ${bwKhz} kHz bandwidth (${
        LORA_BANDWIDTHS_HZ.map((b) => b / 1000).join(", ")
      })`,
    );
  }
  const sf = r.int(radio.sf ?? 7, `${path}.sf`, 6, 12);
  const pins = radio.pins === undefined ? {} : r.record(radio.pins, `${path}.pins`);
  r.known(pins, ["cs", "reset", "dio0"], `${path}.pins`);
  return {
    phy: "lora",
    // 137-1020 MHz: the tuning range of the SX1276.
    frequencyHz: Math.round(
      r.num(radio.frequency_mhz ?? 868.1, `${path}.frequency_mhz`, 137, 1020) * 1e6,
    ),
    sf,
    bandwidthHz: bwKhz * 1000,
    codingRate: parseCodingRate(r, radio.cr, `${path}.cr`),
    syncWord: r.int(radio.sync_word ?? 0x12, `${path}.sync_word`, 0, 255),
    preambleLength: r.int(radio.preamble ?? 8, `${path}.preamble`, 6, 65535),
    crc: bool(r, radio.crc, true, `${path}.crc`),
    txPowerDbm: r.int(radio.tx_power_dbm ?? 14, `${path}.tx_power_dbm`, 2, 20),
    antennaGainDbi: r.num(radio.antenna_gain_dbi ?? 0, `${path}.antenna_gain_dbi`, -20, 30),
    pins: {
      cs: gpio(r, pins.cs, 5, `${path}.pins.cs`) ??
        r.fail(`${path}.pins.cs`, "the chip select must be wired"),
      reset: gpio(r, pins.reset, 14, `${path}.pins.reset`),
      dio0: gpio(r, pins.dio0, 26, `${path}.pins.dio0`),
    },
  };
}

function parseNrf24(r: FieldReaders, radio: Obj, path: string): Nrf24Radio {
  r.known(radio, NRF24_FIELDS, path);
  const rate = r.int(radio.data_rate_kbps ?? 1000, `${path}.data_rate_kbps`, 250, 2000) * 1000;
  if (!isNrf24DataRate(rate)) r.fail(`${path}.data_rate_kbps`, "must be 250, 1000 or 2000");
  const power = r.int(radio.tx_power_dbm ?? 0, `${path}.tx_power_dbm`, -18, 0);
  if (![-18, -12, -6, 0].includes(power)) {
    r.fail(`${path}.tx_power_dbm`, "the nRF24L01+ transmits at -18, -12, -6 or 0 dBm");
  }
  const delay = r.int(radio.retry_delay_us ?? 1500, `${path}.retry_delay_us`, 250, 4000);
  if (delay % 250 !== 0) r.fail(`${path}.retry_delay_us`, "must be a multiple of 250");
  const pins = radio.pins === undefined ? {} : r.record(radio.pins, `${path}.pins`);
  r.known(pins, ["csn", "ce", "irq"], `${path}.pins`);
  return {
    phy: "nrf24",
    channel: r.int(radio.channel ?? 76, `${path}.channel`, 0, 125),
    dataRate: rate,
    txPowerDbm: power,
    antennaGainDbi: r.num(radio.antenna_gain_dbi ?? 0, `${path}.antenna_gain_dbi`, -20, 30),
    autoAck: bool(r, radio.auto_ack, true, `${path}.auto_ack`),
    retries: r.int(radio.retries ?? 15, `${path}.retries`, 0, 15),
    retryDelayUs: delay,
    pins: {
      csn: gpio(r, pins.csn, 5, `${path}.pins.csn`) ??
        r.fail(`${path}.pins.csn`, "CSN must be wired"),
      ce: gpio(r, pins.ce, 4, `${path}.pins.ce`) ?? r.fail(`${path}.pins.ce`, "CE must be wired"),
      irq: gpio(r, pins.irq, null, `${path}.pins.irq`),
    },
  };
}

export function parseNodeRadio(r: FieldReaders, value: unknown, path: string): NodeRadio {
  if (value === undefined) return DEFAULT_WIFI;
  if (!Array.isArray(value)) r.fail(path, "expected a list");
  if (value.length !== 1) r.fail(path, "a node has exactly one radio");
  const radio = r.record(value[0], `${path}[0]`);
  const phy = radio.phy;
  if (phy === "lora") return parseLora(r, radio, `${path}[0]`);
  if (phy === "nrf24") return parseNrf24(r, radio, `${path}[0]`);
  if (phy === "ble") return parseBle(r, radio, `${path}[0]`);
  if (phy !== "wifi") r.fail(`${path}[0].phy`, `expected one of ${PHYS.join(", ")}`);
  r.known(radio, WIFI_FIELDS, `${path}[0]`);
  return {
    phy: "wifi",
    channel: r.int(radio.channel ?? 6, `${path}[0].channel`, 1, 14),
    txPowerDbm: r.num(radio.tx_power_dbm ?? 15, `${path}[0].tx_power_dbm`, -20, 30),
    antennaGainDbi: r.num(radio.antenna_gain_dbi ?? 0, `${path}[0].antenna_gain_dbi`, -20, 30),
  };
}

/** One line for the report: "wifi ch 5", "lora 868.1 MHz SF7 BW125 CR4/5", "nrf24 ch 76 1 Mbit/s", "ble 1M, HCI on UART1". */
export function describeRadio(radio: NodeRadio): string {
  switch (radio.phy) {
    case "wifi":
      return `wifi ch ${radio.channel}`;
    case "lora":
      return `lora ${Number((radio.frequencyHz / 1e6).toFixed(3))} MHz SF${radio.sf} BW${
        radio.bandwidthHz / 1000
      } CR4/${radio.codingRate}`;
    case "nrf24":
      return `nrf24 ch ${radio.channel} ${
        radio.dataRate === 250_000 ? "250 kbit/s" : `${radio.dataRate / 1e6} Mbit/s`
      }`;
    case "ble":
      return `ble 1M ${radio.txPowerDbm} dBm, HCI on UART${radio.hciUart}`;
  }
}

/**
 * Receive address of a node on nRF24, from its 1-based position in the
 * scenario: "HZB" + 0x00 + index, least significant byte first on the wire,
 * as RF24 writes addresses. Scripted boards use it; firmware uses its own.
 */
export function nrf24AddressFor(index: number): Uint8Array {
  return Uint8Array.of(index & 0xff, 0x00, 0x42, 0x5a, 0x48);
}
