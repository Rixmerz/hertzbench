// A TypeScript replay of nRF24/RF24 1.4 (RF24.cpp, GPL-2.0 upstream; this is
// an independent re-statement of its SPI sequences, not a copy): the same
// commands in the same order for begin, the pipe setup, startListening,
// stopListening, write, available and read, so a scripted board drives the
// nRF24L01+ model the way a sketch using RF24.h does. Not firmware.

import type { Level } from "../../../adapters/spi-link/device.ts";
import type { DriverBus } from "./bus.ts";

const CONFIG = 0x00;
const EN_AA = 0x01;
const EN_RXADDR = 0x02;
const SETUP_AW = 0x03;
const SETUP_RETR = 0x04;
const RF_CH = 0x05;
const RF_SETUP = 0x06;
const STATUS = 0x07;
const RX_ADDR_P0 = 0x0a;
const TX_ADDR = 0x10;
const RX_PW_P0 = 0x11;
const FIFO_STATUS = 0x17;
const DYNPD = 0x1c;
const FEATURE = 0x1d;

const W_REGISTER = 0x20;
const ACTIVATE = 0x50;
const R_RX_PAYLOAD = 0x61;
const W_TX_PAYLOAD = 0xa0;
const W_TX_PAYLOAD_NO_ACK = 0xb0;
const FLUSH_TX = 0xe1;
const FLUSH_RX = 0xe2;
const NOP = 0xff;

const RX_DR = 0x40;
const TX_DS = 0x20;
const MAX_RT = 0x10;
const IRQ_ALL = RX_DR | TX_DS | MAX_RT;
const PRIM_RX = 0x01;
const PWR_UP = 0x02;
const CRCO = 0x04;
const EN_CRC = 0x08;
const MASKS = 0x70;

/** RF24_PA_MIN..RF24_PA_MAX map to RF_PWR 0..3; the LNA bit rides along. */
export type PaLevel = 0 | 1 | 2 | 3;
export type DataRateKbps = 250 | 1000 | 2000;

export interface Rf24Pins {
  ce: number;
  csn: number;
}

/** write() gives up after this long without TX_DS or MAX_RT, as the library's timeout does. */
const WRITE_TIMEOUT_MS = 95;
const POLL_MS = 1;

export class Rf24 {
  readonly #bus: DriverBus;
  readonly #pins: Rf24Pins;
  #status = 0;
  #configReg = 0;
  #payloadSize = 32;
  #addrWidth = 5;
  #pipe0Writing = new Uint8Array(5);
  #pipe0Reading: Uint8Array | null = null;

  constructor(bus: DriverBus, pins: Rf24Pins) {
    this.#bus = bus;
    this.#pins = pins;
  }

  get status(): number {
    return this.#status;
  }

  async begin(): Promise<boolean> {
    await this.#ce(0);
    await this.#bus.digitalWrite(this.#pins.csn, 1);
    await this.#bus.delay(5);
    await this.setRetries(5, 15);
    await this.setDataRate(1000);
    const before = await this.readRegister(FEATURE);
    await this.#toggleFeatures();
    const after = await this.readRegister(FEATURE);
    if (after) {
      if (before === after) await this.#toggleFeatures();
      await this.writeRegister(FEATURE, 0);
    }
    await this.writeRegister(DYNPD, 0);
    await this.writeRegister(EN_AA, 0x3f);
    await this.writeRegister(EN_RXADDR, 3);
    await this.setPayloadSize(32);
    await this.writeRegister(SETUP_AW, this.#addrWidth - 2);
    await this.setChannel(76);
    await this.writeRegister(STATUS, IRQ_ALL);
    await this.#command(FLUSH_RX);
    await this.#command(FLUSH_TX);
    await this.writeRegister(CONFIG, EN_CRC | CRCO | MASKS);
    this.#configReg = await this.readRegister(CONFIG);
    await this.powerUp();
    return this.#configReg === (EN_CRC | CRCO | PWR_UP | MASKS);
  }

  async isChipConnected(): Promise<boolean> {
    return await this.readRegister(SETUP_AW) === this.#addrWidth - 2;
  }

  async powerUp(): Promise<void> {
    if (!(this.#configReg & PWR_UP)) {
      this.#configReg |= PWR_UP;
      await this.writeRegister(CONFIG, this.#configReg);
      await this.#bus.delay(5);
    }
  }

  async setChannel(channel: number): Promise<void> {
    await this.writeRegister(RF_CH, Math.min(channel, 125));
  }

  async setPayloadSize(size: number): Promise<void> {
    this.#payloadSize = Math.max(1, Math.min(32, size));
    for (let i = 0; i < 6; i++) await this.writeRegister(RX_PW_P0 + i, this.#payloadSize);
  }

  async setRetries(delay: number, count: number): Promise<void> {
    await this.writeRegister(SETUP_RETR, (Math.min(15, delay) << 4) | Math.min(15, count));
  }

  async setDataRate(kbps: DataRateKbps): Promise<boolean> {
    let setup = await this.readRegister(RF_SETUP);
    setup &= ~(0x20 | 0x08);
    setup |= kbps === 250 ? 0x20 : kbps === 2000 ? 0x08 : 0;
    await this.writeRegister(RF_SETUP, setup);
    return await this.readRegister(RF_SETUP) === setup;
  }

  async setPALevel(level: PaLevel, lnaEnable = true): Promise<void> {
    const setup = (await this.readRegister(RF_SETUP)) & 0xf8;
    await this.writeRegister(RF_SETUP, setup | (level << 1) | (lnaEnable ? 1 : 0));
  }

  async setAutoAck(enable: boolean): Promise<void> {
    await this.writeRegister(EN_AA, enable ? 0x3f : 0);
  }

  async openWritingPipe(address: Uint8Array): Promise<void> {
    const a = address.slice(0, this.#addrWidth);
    await this.writeRegister(RX_ADDR_P0, a);
    await this.writeRegister(TX_ADDR, a);
    this.#pipe0Writing = a;
  }

  async openReadingPipe(child: number, address: Uint8Array): Promise<void> {
    const a = address.slice(0, this.#addrWidth);
    if (child === 0) this.#pipe0Reading = a;
    if (child > 5) return;
    if (child > 1) await this.writeRegister(RX_ADDR_P0 + child, a.slice(0, 1));
    else if ((this.#configReg & PRIM_RX) || child !== 0) {
      await this.writeRegister(RX_ADDR_P0 + child, a);
    }
    await this.writeRegister(EN_RXADDR, (await this.readRegister(EN_RXADDR)) | (1 << child));
  }

  async startListening(): Promise<void> {
    await this.powerUp();
    this.#configReg |= PRIM_RX;
    await this.writeRegister(CONFIG, this.#configReg);
    await this.writeRegister(STATUS, IRQ_ALL);
    await this.#ce(1);
    if (this.#pipe0Reading) await this.writeRegister(RX_ADDR_P0, this.#pipe0Reading);
    else {
      await this.writeRegister(EN_RXADDR, (await this.readRegister(EN_RXADDR)) & ~1);
    }
  }

  async stopListening(): Promise<void> {
    await this.#ce(0);
    await this.#bus.delay(1);
    this.#configReg &= ~PRIM_RX;
    await this.writeRegister(CONFIG, this.#configReg);
    await this.writeRegister(RX_ADDR_P0, this.#pipe0Writing);
    await this.writeRegister(EN_RXADDR, (await this.readRegister(EN_RXADDR)) | 1);
  }

  /** Blocking write: true when the receiver acknowledged (or no ACK was asked for). */
  async write(buffer: Uint8Array, multicast = false): Promise<boolean> {
    await this.#writePayload(buffer, multicast ? W_TX_PAYLOAD_NO_ACK : W_TX_PAYLOAD);
    await this.#ce(1);
    let waited = 0;
    while (!((await this.update()) & (TX_DS | MAX_RT))) {
      if (waited >= WRITE_TIMEOUT_MS) {
        await this.#ce(0);
        return false;
      }
      await this.#bus.delay(POLL_MS);
      waited += POLL_MS;
    }
    await this.#ce(0);
    await this.writeRegister(STATUS, IRQ_ALL);
    if (this.#status & MAX_RT) {
      await this.#command(FLUSH_TX);
      return false;
    }
    return true;
  }

  async available(): Promise<boolean> {
    return ((await this.readRegister(FIFO_STATUS)) & 1) === 0;
  }

  /** Which pipe the next payload came in on (STATUS RX_P_NO). */
  async pipeAvailable(): Promise<number> {
    return ((await this.update()) >> 1) & 0x07;
  }

  async read(length = this.#payloadSize): Promise<Uint8Array> {
    const out = new Uint8Array(Math.min(length, this.#payloadSize));
    await this.#bus.digitalWrite(this.#pins.csn, 0);
    this.#status = await this.#bus.transfer(R_RX_PAYLOAD);
    for (let i = 0; i < this.#payloadSize; i++) {
      const b = await this.#bus.transfer(0xff);
      if (i < out.length) out[i] = b;
    }
    await this.#bus.digitalWrite(this.#pins.csn, 1);
    await this.writeRegister(STATUS, RX_DR);
    return out;
  }

  async update(): Promise<number> {
    return await this.#command(NOP);
  }

  async readRegister(reg: number): Promise<number> {
    await this.#bus.digitalWrite(this.#pins.csn, 0);
    this.#status = await this.#bus.transfer(reg & 0x1f);
    const value = await this.#bus.transfer(0xff);
    await this.#bus.digitalWrite(this.#pins.csn, 1);
    return value;
  }

  async writeRegister(reg: number, value: number | Uint8Array): Promise<void> {
    const bytes = typeof value === "number" ? [value & 0xff] : Array.from(value);
    await this.#bus.digitalWrite(this.#pins.csn, 0);
    this.#status = await this.#bus.transfer(W_REGISTER | (reg & 0x1f));
    for (const b of bytes) await this.#bus.transfer(b);
    await this.#bus.digitalWrite(this.#pins.csn, 1);
  }

  /** Static payloads are padded with zeros to the payload size, as the library does. */
  async #writePayload(buffer: Uint8Array, command: number): Promise<void> {
    const data = buffer.slice(0, this.#payloadSize);
    await this.#bus.digitalWrite(this.#pins.csn, 0);
    this.#status = await this.#bus.transfer(command);
    for (let i = 0; i < this.#payloadSize; i++) await this.#bus.transfer(data[i] ?? 0);
    await this.#bus.digitalWrite(this.#pins.csn, 1);
  }

  async #command(cmd: number): Promise<number> {
    await this.#bus.digitalWrite(this.#pins.csn, 0);
    this.#status = await this.#bus.transfer(cmd);
    await this.#bus.digitalWrite(this.#pins.csn, 1);
    return this.#status;
  }

  async #toggleFeatures(): Promise<void> {
    await this.#bus.digitalWrite(this.#pins.csn, 0);
    this.#status = await this.#bus.transfer(ACTIVATE);
    await this.#bus.transfer(0x73);
    await this.#bus.digitalWrite(this.#pins.csn, 1);
  }

  async #ce(level: Level): Promise<void> {
    await this.#bus.digitalWrite(this.#pins.ce, level);
  }
}
