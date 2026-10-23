// A TypeScript replay of sandeepmistry/arduino-LoRa 0.8 (src/LoRa.cpp, MIT):
// the same register reads and writes in the same order, method by method, so
// a scripted board drives the SX127x model the way a sketch using LoRa.h does.
// Not firmware; a stand-in that keeps the model honest on hosts without QEMU.

import { hzToFrf } from "../../../engine/mod.ts";
import type { DriverBus } from "./bus.ts";

const REG_FIFO = 0x00;
const REG_OP_MODE = 0x01;
const REG_FRF_MSB = 0x06;
const REG_FRF_MID = 0x07;
const REG_FRF_LSB = 0x08;
const REG_PA_CONFIG = 0x09;
const REG_OCP = 0x0b;
const REG_LNA = 0x0c;
const REG_FIFO_ADDR_PTR = 0x0d;
const REG_FIFO_TX_BASE_ADDR = 0x0e;
const REG_FIFO_RX_BASE_ADDR = 0x0f;
const REG_FIFO_RX_CURRENT_ADDR = 0x10;
const REG_IRQ_FLAGS = 0x12;
const REG_RX_NB_BYTES = 0x13;
const REG_PKT_SNR_VALUE = 0x19;
const REG_PKT_RSSI_VALUE = 0x1a;
const REG_MODEM_CONFIG_1 = 0x1d;
const REG_MODEM_CONFIG_2 = 0x1e;
const REG_PREAMBLE_MSB = 0x20;
const REG_PREAMBLE_LSB = 0x21;
const REG_PAYLOAD_LENGTH = 0x22;
const REG_MODEM_CONFIG_3 = 0x26;
const REG_DETECTION_OPTIMIZE = 0x31;
const REG_DETECTION_THRESHOLD = 0x37;
const REG_SYNC_WORD = 0x39;
const REG_DIO_MAPPING_1 = 0x40;
const REG_VERSION = 0x42;
const REG_PA_DAC = 0x4d;

const MODE_LONG_RANGE_MODE = 0x80;
const MODE_SLEEP = 0x00;
const MODE_STDBY = 0x01;
const MODE_TX = 0x03;
const MODE_RX_CONTINUOUS = 0x05;
const MODE_RX_SINGLE = 0x06;
const PA_BOOST = 0x80;
const IRQ_TX_DONE_MASK = 0x08;
const IRQ_PAYLOAD_CRC_ERROR_MASK = 0x20;
const IRQ_RX_DONE_MASK = 0x40;
const RF_MID_BAND_THRESHOLD = 525e6;
const RSSI_OFFSET_HF_PORT = 157;
const RSSI_OFFSET_LF_PORT = 164;
const MAX_PKT_LENGTH = 255;

const BANDWIDTHS = [7.8e3, 10.4e3, 15.6e3, 20.8e3, 31.25e3, 41.7e3, 62.5e3, 125e3, 250e3, 500e3];

export interface LoraPins {
  ss: number;
  reset: number | null;
  dio0: number | null;
}

/** How often endPacket polls RegIrqFlags. The library spins; a scripted board waits a little between reads. */
const POLL_MS = 1;

export class ArduinoLora {
  readonly #bus: DriverBus;
  readonly #pins: LoraPins;
  #frequency = 0;
  #packetIndex = 0;
  #implicitHeaderMode = false;

  constructor(bus: DriverBus, pins: LoraPins) {
    this.#bus = bus;
    this.#pins = pins;
  }

  async begin(frequency: number): Promise<boolean> {
    await this.#bus.digitalWrite(this.#pins.ss, 1);
    if (this.#pins.reset !== null) {
      await this.#bus.digitalWrite(this.#pins.reset, 0);
      await this.#bus.delay(10);
      await this.#bus.digitalWrite(this.#pins.reset, 1);
      await this.#bus.delay(10);
    }
    if (await this.readRegister(REG_VERSION) !== 0x12) return false;
    await this.sleep();
    await this.setFrequency(frequency);
    await this.writeRegister(REG_FIFO_TX_BASE_ADDR, 0);
    await this.writeRegister(REG_FIFO_RX_BASE_ADDR, 0);
    await this.writeRegister(REG_LNA, await this.readRegister(REG_LNA) | 0x03);
    await this.writeRegister(REG_MODEM_CONFIG_3, 0x04);
    await this.setTxPower(17);
    await this.idle();
    return true;
  }

  async beginPacket(implicitHeader = false): Promise<boolean> {
    if (await this.isTransmitting()) return false;
    await this.idle();
    if (implicitHeader) await this.#implicitHeader();
    else await this.#explicitHeader();
    await this.writeRegister(REG_FIFO_ADDR_PTR, 0);
    await this.writeRegister(REG_PAYLOAD_LENGTH, 0);
    return true;
  }

  /** Blocking form: polls RegIrqFlags until TxDone, then clears it. */
  async endPacket(): Promise<void> {
    await this.writeRegister(REG_OP_MODE, MODE_LONG_RANGE_MODE | MODE_TX);
    while ((await this.readRegister(REG_IRQ_FLAGS) & IRQ_TX_DONE_MASK) === 0) {
      await this.#bus.delay(POLL_MS);
    }
    await this.writeRegister(REG_IRQ_FLAGS, IRQ_TX_DONE_MASK);
  }

  async isTransmitting(): Promise<boolean> {
    if ((await this.readRegister(REG_OP_MODE) & MODE_TX) === MODE_TX) return true;
    if (await this.readRegister(REG_IRQ_FLAGS) & IRQ_TX_DONE_MASK) {
      await this.writeRegister(REG_IRQ_FLAGS, IRQ_TX_DONE_MASK);
    }
    return false;
  }

  /** Polling receive in RX single mode; returns the packet length or 0. */
  async parsePacket(size = 0): Promise<number> {
    let packetLength = 0;
    const irqFlags = await this.readRegister(REG_IRQ_FLAGS);
    if (size > 0) {
      await this.#implicitHeader();
      await this.writeRegister(REG_PAYLOAD_LENGTH, size & 0xff);
    } else {
      await this.#explicitHeader();
    }
    await this.writeRegister(REG_IRQ_FLAGS, irqFlags);
    if ((irqFlags & IRQ_RX_DONE_MASK) && (irqFlags & IRQ_PAYLOAD_CRC_ERROR_MASK) === 0) {
      this.#packetIndex = 0;
      packetLength = this.#implicitHeaderMode
        ? await this.readRegister(REG_PAYLOAD_LENGTH)
        : await this.readRegister(REG_RX_NB_BYTES);
      await this.writeRegister(
        REG_FIFO_ADDR_PTR,
        await this.readRegister(REG_FIFO_RX_CURRENT_ADDR),
      );
      await this.idle();
    } else if (await this.readRegister(REG_OP_MODE) !== (MODE_LONG_RANGE_MODE | MODE_RX_SINGLE)) {
      await this.writeRegister(REG_FIFO_ADDR_PTR, 0);
      await this.writeRegister(REG_OP_MODE, MODE_LONG_RANGE_MODE | MODE_RX_SINGLE);
    }
    return packetLength;
  }

  /** onReceive-style: what handleDio0Rise does after DIO0 rose. Returns the packet length or 0. */
  async handleDio0Rise(): Promise<number> {
    const irqFlags = await this.readRegister(REG_IRQ_FLAGS);
    await this.writeRegister(REG_IRQ_FLAGS, irqFlags);
    if ((irqFlags & IRQ_PAYLOAD_CRC_ERROR_MASK) !== 0 || (irqFlags & IRQ_RX_DONE_MASK) === 0) {
      return 0;
    }
    this.#packetIndex = 0;
    const packetLength = this.#implicitHeaderMode
      ? await this.readRegister(REG_PAYLOAD_LENGTH)
      : await this.readRegister(REG_RX_NB_BYTES);
    await this.writeRegister(REG_FIFO_ADDR_PTR, await this.readRegister(REG_FIFO_RX_CURRENT_ADDR));
    return packetLength;
  }

  async packetRssi(): Promise<number> {
    return await this.readRegister(REG_PKT_RSSI_VALUE) -
      (this.#frequency < RF_MID_BAND_THRESHOLD ? RSSI_OFFSET_LF_PORT : RSSI_OFFSET_HF_PORT);
  }

  async packetSnr(): Promise<number> {
    const raw = await this.readRegister(REG_PKT_SNR_VALUE);
    return (raw > 127 ? raw - 256 : raw) * 0.25;
  }

  async write(buffer: Uint8Array): Promise<number> {
    const currentLength = await this.readRegister(REG_PAYLOAD_LENGTH);
    const size = Math.min(buffer.length, MAX_PKT_LENGTH - currentLength);
    for (let i = 0; i < size; i++) await this.writeRegister(REG_FIFO, buffer[i] ?? 0);
    await this.writeRegister(REG_PAYLOAD_LENGTH, currentLength + size);
    return size;
  }

  async available(): Promise<number> {
    return await this.readRegister(REG_RX_NB_BYTES) - this.#packetIndex;
  }

  async read(): Promise<number> {
    if (!(await this.available())) return -1;
    this.#packetIndex++;
    return await this.readRegister(REG_FIFO);
  }

  /** Reads what available() reports, the way `while (LoRa.available()) LoRa.read()` does. */
  async readAll(): Promise<Uint8Array> {
    const bytes: number[] = [];
    while (await this.available() > 0) bytes.push(await this.read());
    return Uint8Array.from(bytes);
  }

  async receive(size = 0): Promise<void> {
    await this.writeRegister(REG_DIO_MAPPING_1, 0x00);
    if (size > 0) {
      await this.#implicitHeader();
      await this.writeRegister(REG_PAYLOAD_LENGTH, size & 0xff);
    } else {
      await this.#explicitHeader();
    }
    await this.writeRegister(REG_OP_MODE, MODE_LONG_RANGE_MODE | MODE_RX_CONTINUOUS);
  }

  async idle(): Promise<void> {
    await this.writeRegister(REG_OP_MODE, MODE_LONG_RANGE_MODE | MODE_STDBY);
  }

  async sleep(): Promise<void> {
    await this.writeRegister(REG_OP_MODE, MODE_LONG_RANGE_MODE | MODE_SLEEP);
  }

  /** PA_BOOST output, as the library's default `setTxPower(level)`. */
  async setTxPower(level: number): Promise<void> {
    if (level > 17) {
      level = Math.min(level, 20) - 3;
      await this.writeRegister(REG_PA_DAC, 0x87);
      await this.#setOcp(140);
    } else {
      level = Math.max(level, 2);
      await this.writeRegister(REG_PA_DAC, 0x84);
      await this.#setOcp(100);
    }
    await this.writeRegister(REG_PA_CONFIG, PA_BOOST | (level - 2));
  }

  async setFrequency(frequency: number): Promise<void> {
    this.#frequency = frequency;
    const frf = hzToFrf(frequency);
    await this.writeRegister(REG_FRF_MSB, (frf >> 16) & 0xff);
    await this.writeRegister(REG_FRF_MID, (frf >> 8) & 0xff);
    await this.writeRegister(REG_FRF_LSB, frf & 0xff);
  }

  async getSpreadingFactor(): Promise<number> {
    return await this.readRegister(REG_MODEM_CONFIG_2) >> 4;
  }

  async setSpreadingFactor(sf: number): Promise<void> {
    sf = Math.min(12, Math.max(6, sf));
    if (sf === 6) {
      await this.writeRegister(REG_DETECTION_OPTIMIZE, 0xc5);
      await this.writeRegister(REG_DETECTION_THRESHOLD, 0x0c);
    } else {
      await this.writeRegister(REG_DETECTION_OPTIMIZE, 0xc3);
      await this.writeRegister(REG_DETECTION_THRESHOLD, 0x0a);
    }
    await this.writeRegister(
      REG_MODEM_CONFIG_2,
      (await this.readRegister(REG_MODEM_CONFIG_2) & 0x0f) | ((sf << 4) & 0xf0),
    );
    await this.#setLdoFlag();
  }

  async getSignalBandwidth(): Promise<number> {
    return BANDWIDTHS[await this.readRegister(REG_MODEM_CONFIG_1) >> 4] ?? -1;
  }

  async setSignalBandwidth(sbw: number): Promise<void> {
    let bw = BANDWIDTHS.findIndex((b) => sbw <= b);
    if (bw < 0) bw = 9;
    await this.writeRegister(
      REG_MODEM_CONFIG_1,
      (await this.readRegister(REG_MODEM_CONFIG_1) & 0x0f) | (bw << 4),
    );
    await this.#setLdoFlag();
  }

  async setCodingRate4(denominator: number): Promise<void> {
    const cr = Math.min(8, Math.max(5, denominator)) - 4;
    await this.writeRegister(
      REG_MODEM_CONFIG_1,
      (await this.readRegister(REG_MODEM_CONFIG_1) & 0xf1) | (cr << 1),
    );
  }

  async setPreambleLength(length: number): Promise<void> {
    await this.writeRegister(REG_PREAMBLE_MSB, (length >> 8) & 0xff);
    await this.writeRegister(REG_PREAMBLE_LSB, length & 0xff);
  }

  async setSyncWord(sw: number): Promise<void> {
    await this.writeRegister(REG_SYNC_WORD, sw);
  }

  async enableCrc(): Promise<void> {
    await this.writeRegister(
      REG_MODEM_CONFIG_2,
      await this.readRegister(REG_MODEM_CONFIG_2) | 0x04,
    );
  }

  async disableCrc(): Promise<void> {
    await this.writeRegister(
      REG_MODEM_CONFIG_2,
      await this.readRegister(REG_MODEM_CONFIG_2) & 0xfb,
    );
  }

  /** Section 4.1.1.6: LowDataRateOptimize on when a symbol lasts more than 16 ms. */
  async #setLdoFlag(): Promise<void> {
    const bw = await this.getSignalBandwidth();
    const sf = await this.getSpreadingFactor();
    // Integer arithmetic as in the C++ (`long`): SF11 at 125 kHz gives 16, so LDO stays off.
    const symbolDuration = Math.trunc(1000 / Math.trunc(bw / 2 ** sf));
    const config3 = await this.readRegister(REG_MODEM_CONFIG_3);
    await this.writeRegister(
      REG_MODEM_CONFIG_3,
      symbolDuration > 16 ? config3 | 0x08 : config3 & ~0x08,
    );
  }

  async #setOcp(mA: number): Promise<void> {
    let ocpTrim = 27;
    if (mA <= 120) ocpTrim = Math.trunc((mA - 45) / 5);
    else if (mA <= 240) ocpTrim = Math.trunc((mA + 30) / 10);
    await this.writeRegister(REG_OCP, 0x20 | (0x1f & ocpTrim));
  }

  async #explicitHeader(): Promise<void> {
    this.#implicitHeaderMode = false;
    await this.writeRegister(
      REG_MODEM_CONFIG_1,
      await this.readRegister(REG_MODEM_CONFIG_1) & 0xfe,
    );
  }

  async #implicitHeader(): Promise<void> {
    this.#implicitHeaderMode = true;
    await this.writeRegister(
      REG_MODEM_CONFIG_1,
      await this.readRegister(REG_MODEM_CONFIG_1) | 0x01,
    );
  }

  async readRegister(address: number): Promise<number> {
    return await this.#singleTransfer(address & 0x7f, 0x00);
  }

  async writeRegister(address: number, value: number): Promise<void> {
    await this.#singleTransfer(address | 0x80, value & 0xff);
  }

  async #singleTransfer(address: number, value: number): Promise<number> {
    await this.#bus.digitalWrite(this.#pins.ss, 0);
    await this.#bus.transfer(address);
    const response = await this.#bus.transfer(value);
    await this.#bus.digitalWrite(this.#pins.ss, 1);
    return response;
  }
}
