// Nordic nRF24L01+ modelled at its SPI command interface (fidelity F1: the
// firmware's own driver, e.g. RF24, talks to it unmodified).
//
// What is modelled: the register map with its reset values (5-byte address
// registers included), the SPI commands (R/W_REGISTER, R_RX_PAYLOAD,
// W_TX_PAYLOAD, W_TX_PAYLOAD_NO_ACK, W_ACK_PAYLOAD, R_RX_PL_WID, FLUSH_TX,
// FLUSH_RX, REUSE_TX_PL, ACTIVATE, NOP) with STATUS shifted out on the first
// byte of every command, the 3-deep TX and RX FIFOs, the CE line, power down /
// standby / RX / TX with the 130 us settling, the IRQ line (active low, with
// the CONFIG masks), and Enhanced ShockBurst: packet ID, auto-ACK sent back over
// the air by the receiver, ACK payloads, duplicate suppression, auto-retransmit
// after ARD up to ARC times, MAX_RT, OBSERVE_TX and RPD. Static and dynamic
// payload lengths; CRC forced on when auto-ACK is enabled.
//
// Not modelled, reported once through `warn`: constant carrier (CONT_WAVE).
// Register map and timing: nRF24L01+ product specification v1.0, §7 and §9.

import {
  type AirFrame,
  type AirReceiver,
  type Clock,
  type Hearing,
  NRF24_CAPTURE_DB,
  NRF24_NOISE_FIGURE_DB,
  NRF24_REFERENCE_BYTES,
  NRF24_SETTLE_US,
  nrf24AirtimeUs,
  nrf24BandwidthHz,
  nrf24ChannelFrequencyHz,
  type Nrf24DataRate,
  nrf24RequiredSnrDb,
  nrf24TxPowerDbm,
  type ReceptionQuality,
} from "../../engine/mod.ts";
import type { Level, PinDriver, SpiDevice } from "../spi-link/device.ts";

export const NRF_REG = {
  CONFIG: 0x00,
  EN_AA: 0x01,
  EN_RXADDR: 0x02,
  SETUP_AW: 0x03,
  SETUP_RETR: 0x04,
  RF_CH: 0x05,
  RF_SETUP: 0x06,
  STATUS: 0x07,
  OBSERVE_TX: 0x08,
  RPD: 0x09,
  RX_ADDR_P0: 0x0a,
  RX_ADDR_P1: 0x0b,
  TX_ADDR: 0x10,
  RX_PW_P0: 0x11,
  FIFO_STATUS: 0x17,
  DYNPD: 0x1c,
  FEATURE: 0x1d,
} as const;

export const NRF_CMD = {
  R_REGISTER: 0x00,
  W_REGISTER: 0x20,
  ACTIVATE: 0x50,
  R_RX_PL_WID: 0x60,
  R_RX_PAYLOAD: 0x61,
  W_TX_PAYLOAD: 0xa0,
  W_ACK_PAYLOAD: 0xa8,
  W_TX_PAYLOAD_NO_ACK: 0xb0,
  FLUSH_TX: 0xe1,
  FLUSH_RX: 0xe2,
  REUSE_TX_PL: 0xe3,
  NOP: 0xff,
} as const;

const RX_DR = 0x40;
const TX_DS = 0x20;
const MAX_RT = 0x10;
const FIFO_DEPTH = 3;
const MAX_PAYLOAD = 32;
const SETTLE_MS = NRF24_SETTLE_US / 1000;
/** RPD is set when the last packet arrived above this level (§6.4). */
const RPD_THRESHOLD_DBM = -64;

/** The 5-byte registers; everything else in 0x00-0x1d is one byte. */
const ADDRESS_REGS = new Set<number>([NRF_REG.RX_ADDR_P0, NRF_REG.RX_ADDR_P1, NRF_REG.TX_ADDR]);

const RESET_VALUES: ReadonlyArray<readonly [number, readonly number[]]> = [
  [NRF_REG.CONFIG, [0x08]],
  [NRF_REG.EN_AA, [0x3f]],
  [NRF_REG.EN_RXADDR, [0x03]],
  [NRF_REG.SETUP_AW, [0x03]],
  [NRF_REG.SETUP_RETR, [0x03]],
  [NRF_REG.RF_CH, [0x02]],
  [NRF_REG.RF_SETUP, [0x0e]],
  [NRF_REG.STATUS, [0x0e]],
  [NRF_REG.RX_ADDR_P0, [0xe7, 0xe7, 0xe7, 0xe7, 0xe7]],
  [NRF_REG.RX_ADDR_P1, [0xc2, 0xc2, 0xc2, 0xc2, 0xc2]],
  [0x0c, [0xc3]],
  [0x0d, [0xc4]],
  [0x0e, [0xc5]],
  [0x0f, [0xc6]],
  [NRF_REG.TX_ADDR, [0xe7, 0xe7, 0xe7, 0xe7, 0xe7]],
  [NRF_REG.FIFO_STATUS, [0x11]],
];

/** What an nRF24 frame carries on the air besides its payload. */
export interface Nrf24Header {
  channel: number;
  dataRate: Nrf24DataRate;
  /** As in the address registers: least significant byte first. */
  address: Uint8Array;
  pid: number;
  noAck: boolean;
  crcBytes: number;
  /** Payload length carried in the packet control field (dynamic payload length). */
  dynamic: boolean;
  /** An auto-acknowledgement sent back by a receiver. */
  ack: boolean;
}

export function isNrf24Frame(frame: AirFrame): frame is AirFrame<Nrf24Header> {
  return frame.kind === "nrf24" || frame.kind === "nrf24-ack";
}

/** RF24 writes an address as a little-endian uint64; show it the way a sketch writes it. */
export function addressHex(address: Uint8Array): string {
  return "0x" + Array.from(address).reverse().map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export interface Nrf24Pins {
  csn: number;
  ce: number;
  /** IRQ output, active low; null when not wired. */
  irq: number | null;
}

export interface Nrf24Options {
  pins: Nrf24Pins;
  clock: Clock;
  transmit(frame: AirFrame<Nrf24Header>): void;
  drivePin: PinDriver;
  warn(message: string): void;
}

interface TxEntry {
  payload: Uint8Array;
  noAck: boolean;
  /** Set for W_ACK_PAYLOAD: the pipe whose next ACK carries it. */
  ackPipe: number | null;
}

interface RxEntry {
  payload: Uint8Array;
  pipe: number;
}

type State = "power_down" | "standby" | "rx" | "tx_settle" | "tx_air" | "tx_wait_ack";

export class Nrf24l01 implements SpiDevice, AirReceiver {
  readonly #opts: Nrf24Options;
  /** Single-byte registers; the address registers live in #addresses. */
  readonly #regs = new Uint8Array(0x20);
  readonly #addresses = new Map<number, Uint8Array>();
  readonly #warned = new Set<string>();
  #tx: TxEntry[] = [];
  #rx: RxEntry[] = [];
  #lastSent: TxEntry | null = null;
  #reuse = false;
  #ce: Level = 0;
  #selected = false;
  #command: number | null = null;
  #index = 0;
  #pendingWrite: number[] = [];
  #state: State = "power_down";
  #rxReadyAt = 0;
  #ackingUntil = 0;
  #pid = 0;
  #retransmits = 0;
  #timer: (() => void) | null = null;
  #irq: Level = 1;
  /** Per pipe: the last packet ID and payload, to drop retransmissions of a packet already taken. */
  readonly #lastRx = new Map<number, { pid: number; payload: Uint8Array }>();

  constructor(opts: Nrf24Options) {
    this.#opts = opts;
    for (const [address, bytes] of RESET_VALUES) {
      if (ADDRESS_REGS.has(address)) this.#addresses.set(address, Uint8Array.from(bytes));
      else this.#regs[address] = bytes[0] ?? 0;
    }
  }

  /** Register value for tests: a byte, or the address bytes of a 5-byte register. */
  peek(address: number): number {
    return this.#regs[address & 0x1f] ?? 0;
  }

  get state(): State {
    return this.#state;
  }

  get rxCount(): number {
    return this.#rx.length;
  }

  get txCount(): number {
    return this.#tx.length;
  }

  // ── SpiDevice ──────────────────────────────────────────────────────────────

  pinChanged(gpio: number, level: Level): void {
    const { pins } = this.#opts;
    if (gpio === pins.csn) {
      if (level === 0) {
        this.#selected = true;
        this.#command = null;
        this.#index = 0;
        this.#pendingWrite = [];
      } else if (this.#selected) {
        this.#selected = false;
        this.#endCommand();
      }
    }
    if (gpio === pins.ce && level !== this.#ce) {
      this.#ce = level;
      this.#reevaluate();
    }
  }

  transfer(mosi: number): number {
    if (!this.#selected) return 0xff;
    if (this.#command === null) {
      this.#command = mosi & 0xff;
      this.#index = 0;
      return this.#status();
    }
    const cmd = this.#command;
    const i = this.#index++;
    if ((cmd & 0xe0) === NRF_CMD.R_REGISTER) return this.#readRegisterByte(cmd & 0x1f, i);
    if ((cmd & 0xe0) === NRF_CMD.W_REGISTER) {
      this.#pendingWrite.push(mosi & 0xff);
      return 0x00;
    }
    switch (cmd) {
      case NRF_CMD.R_RX_PAYLOAD:
        return this.#rx[0]?.payload[i] ?? 0;
      case NRF_CMD.R_RX_PL_WID:
        return this.#rx[0]?.payload.length ?? 0;
      case NRF_CMD.W_TX_PAYLOAD:
      case NRF_CMD.W_TX_PAYLOAD_NO_ACK:
        this.#pendingWrite.push(mosi & 0xff);
        return 0x00;
      default:
        if ((cmd & 0xf8) === NRF_CMD.W_ACK_PAYLOAD) this.#pendingWrite.push(mosi & 0xff);
        return 0x00;
    }
  }

  /** A command takes effect when CSN rises (§8.3.1). */
  #endCommand(): void {
    const cmd = this.#command;
    this.#command = null;
    if (cmd === null) return;
    if ((cmd & 0xe0) === NRF_CMD.W_REGISTER) {
      if (this.#pendingWrite.length > 0) this.#writeRegister(cmd & 0x1f, this.#pendingWrite);
      return;
    }
    const data = Uint8Array.from(this.#pendingWrite.slice(0, MAX_PAYLOAD));
    switch (cmd) {
      case NRF_CMD.R_RX_PAYLOAD:
        if (this.#index > 0) this.#rx.shift();
        return;
      case NRF_CMD.W_TX_PAYLOAD:
      case NRF_CMD.W_TX_PAYLOAD_NO_ACK:
        if (data.length > 0 && this.#tx.length < FIFO_DEPTH) {
          this.#tx.push({
            payload: data,
            noAck: cmd === NRF_CMD.W_TX_PAYLOAD_NO_ACK,
            ackPipe: null,
          });
          this.#reuse = false;
          this.#reevaluate();
        }
        return;
      case NRF_CMD.FLUSH_TX:
        this.#tx = [];
        this.#reuse = false;
        return;
      case NRF_CMD.FLUSH_RX:
        this.#rx = [];
        return;
      case NRF_CMD.REUSE_TX_PL:
        if (this.#lastSent) this.#reuse = true;
        this.#reevaluate();
        return;
      default:
        // ACTIVATE is a no-op on the nRF24L01+ (it toggled features on the old nRF24L01).
        if (
          (cmd & 0xf8) === NRF_CMD.W_ACK_PAYLOAD && data.length > 0 && this.#tx.length < FIFO_DEPTH
        ) {
          this.#tx.push({ payload: data, noAck: false, ackPipe: cmd & 0x07 });
        }
    }
  }

  // ── registers ──────────────────────────────────────────────────────────────

  #readRegisterByte(address: number, index: number): number {
    if (ADDRESS_REGS.has(address)) return this.#addresses.get(address)?.[index] ?? 0;
    if (index > 0) return 0;
    if (address === NRF_REG.STATUS) return this.#status();
    if (address === NRF_REG.FIFO_STATUS) return this.#fifoStatus();
    return this.peek(address);
  }

  #writeRegister(address: number, bytes: number[]): void {
    if (ADDRESS_REGS.has(address)) {
      const target = this.#addresses.get(address) as Uint8Array;
      bytes.slice(0, 5).forEach((b, i) => {
        target[i] = b;
      });
      return;
    }
    const value = bytes[0] ?? 0;
    switch (address) {
      case NRF_REG.STATUS:
        // RX_DR, TX_DS and MAX_RT are cleared by writing 1.
        this.#regs[NRF_REG.STATUS] = this.peek(NRF_REG.STATUS) & ~(value & 0x70);
        this.#updateIrq();
        this.#reevaluate();
        return;
      case NRF_REG.OBSERVE_TX:
      case NRF_REG.RPD:
      case NRF_REG.FIFO_STATUS:
        return; // read only
      case NRF_REG.RF_CH:
        this.#regs[address] = value & 0x7f;
        return;
      case NRF_REG.RF_SETUP:
        if (value & 0x80) this.#warnOnce("constant carrier (RF_SETUP CONT_WAVE) is not modelled");
        this.#regs[address] = value;
        return;
      case NRF_REG.CONFIG:
        this.#regs[address] = value & 0x7f;
        this.#updateIrq();
        this.#reevaluate();
        return;
      default:
        if (address <= NRF_REG.FEATURE) this.#regs[address] = value;
    }
  }

  #status(): number {
    const pipe = this.#rx[0]?.pipe ?? 7;
    const txFull = this.#tx.length >= FIFO_DEPTH ? 1 : 0;
    return (this.peek(NRF_REG.STATUS) & 0x70) | (pipe << 1) | txFull;
  }

  #fifoStatus(): number {
    return (this.#reuse ? 0x40 : 0) |
      (this.#tx.length >= FIFO_DEPTH ? 0x20 : 0) |
      (this.#tx.length === 0 ? 0x10 : 0) |
      (this.#rx.length >= FIFO_DEPTH ? 0x02 : 0) |
      (this.#rx.length === 0 ? 0x01 : 0);
  }

  #raise(flag: number): void {
    this.#regs[NRF_REG.STATUS] = this.peek(NRF_REG.STATUS) | flag;
    this.#updateIrq();
  }

  /** IRQ is active low while any unmasked flag is set (CONFIG bits 6:4 mask them). */
  #updateIrq(): void {
    const masked = this.peek(NRF_REG.CONFIG) & 0x70;
    const level: Level = (this.peek(NRF_REG.STATUS) & 0x70 & ~masked) !== 0 ? 0 : 1;
    if (level === this.#irq) return;
    this.#irq = level;
    if (this.#opts.pins.irq !== null) this.#opts.drivePin(this.#opts.pins.irq, level);
  }

  // ── configuration as the radio uses it ─────────────────────────────────────

  #dataRate(): Nrf24DataRate {
    const setup = this.peek(NRF_REG.RF_SETUP);
    if (setup & 0x20) return 250_000;
    return setup & 0x08 ? 2_000_000 : 1_000_000;
  }

  #addressWidth(): number {
    const aw = this.peek(NRF_REG.SETUP_AW) & 0x03;
    return aw === 0 ? 3 : aw + 2;
  }

  /** CRC is forced on when any pipe has auto-ACK (§7.3.5). */
  #crcBytes(): number {
    const config = this.peek(NRF_REG.CONFIG);
    if (!(config & 0x08) && this.peek(NRF_REG.EN_AA) === 0) return 0;
    return config & 0x04 ? 2 : 1;
  }

  #dynamic(pipe: number): boolean {
    return (this.peek(NRF_REG.FEATURE) & 0x04) !== 0 &&
      (this.peek(NRF_REG.DYNPD) & (1 << pipe)) !== 0;
  }

  #pipeAddress(pipe: number): Uint8Array {
    const width = this.#addressWidth();
    if (pipe === 0) return (this.#addresses.get(NRF_REG.RX_ADDR_P0) as Uint8Array).slice(0, width);
    const p1 = (this.#addresses.get(NRF_REG.RX_ADDR_P1) as Uint8Array).slice(0, width);
    if (pipe >= 2) p1[0] = this.peek(NRF_REG.RX_ADDR_P0 + pipe);
    return p1;
  }

  #pipeFor(address: Uint8Array): number | null {
    const enabled = this.peek(NRF_REG.EN_RXADDR);
    for (let pipe = 0; pipe < 6; pipe++) {
      if ((enabled & (1 << pipe)) && sameBytes(this.#pipeAddress(pipe), address)) return pipe;
    }
    return null;
  }

  // ── state machine ──────────────────────────────────────────────────────────

  #reevaluate(): void {
    const config = this.peek(NRF_REG.CONFIG);
    if (!(config & 0x02)) {
      this.#cancelTimer();
      this.#state = "power_down";
      return;
    }
    if (this.#state === "tx_settle" || this.#state === "tx_air" || this.#state === "tx_wait_ack") {
      return; // the transmission in progress decides what comes next
    }
    if (!this.#ce) {
      this.#state = "standby";
      return;
    }
    if (config & 0x01) {
      if (this.#state !== "rx") {
        this.#state = "rx";
        this.#rxReadyAt = this.#opts.clock.now() + SETTLE_MS;
      }
      return;
    }
    const next = this.#nextToSend();
    if (next && !(this.peek(NRF_REG.STATUS) & MAX_RT)) this.#startTx(next, true);
    else this.#state = "standby"; // standby-II
  }

  #nextToSend(): TxEntry | null {
    if (this.#reuse && this.#lastSent) return this.#lastSent;
    return this.#tx.find((e) => e.ackPipe === null) ?? null;
  }

  #startTx(entry: TxEntry, newPayload: boolean): void {
    if (newPayload) {
      this.#retransmits = 0;
      this.#pid = (this.#pid + 1) & 0x03;
      this.#regs[NRF_REG.OBSERVE_TX] = this.peek(NRF_REG.OBSERVE_TX) & 0xf0;
    }
    this.#state = "tx_settle";
    this.#schedule(SETTLE_MS, () => this.#sendAttempt(entry));
  }

  #sendAttempt(entry: TxEntry): void {
    const address = (this.#addresses.get(NRF_REG.TX_ADDR) as Uint8Array).slice(
      0,
      this.#addressWidth(),
    );
    const expectAck = !entry.noAck && (this.peek(NRF_REG.EN_AA) & 0x01) !== 0;
    const frame = this.#frame("nrf24", address, entry.payload, entry.noAck, this.#dynamic(0));
    this.#state = "tx_air";
    this.#opts.transmit(frame);
    this.#schedule(frame.airtimeMs, () => {
      if (!expectAck) return this.#txSucceeded(entry);
      // Wait for the ACK until the next attempt is due: ARD after the end of this one.
      this.#state = "tx_wait_ack";
      const ardMs = (((this.peek(NRF_REG.SETUP_RETR) >> 4) & 0x0f) + 1) * 0.25;
      this.#schedule(ardMs, () => this.#ackTimedOut(entry));
    });
  }

  #ackTimedOut(entry: TxEntry): void {
    const arc = this.peek(NRF_REG.SETUP_RETR) & 0x0f;
    if (this.#retransmits < arc) {
      this.#retransmits++;
      const observe = this.peek(NRF_REG.OBSERVE_TX);
      this.#regs[NRF_REG.OBSERVE_TX] = (observe & 0xf0) | this.#retransmits;
      this.#sendAttempt(entry);
      return;
    }
    const observe = this.peek(NRF_REG.OBSERVE_TX);
    const lost = Math.min(15, (observe >> 4) + 1);
    this.#regs[NRF_REG.OBSERVE_TX] = (lost << 4) | (observe & 0x0f);
    this.#state = "standby";
    this.#raise(MAX_RT); // the payload stays in the TX FIFO
  }

  #txSucceeded(entry: TxEntry): void {
    if (!(this.#reuse && entry === this.#lastSent)) {
      this.#tx = this.#tx.filter((e) => e !== entry);
      this.#lastSent = entry;
    }
    this.#state = "standby";
    this.#raise(TX_DS);
    this.#reevaluate();
  }

  #frame(
    kind: "nrf24" | "nrf24-ack",
    address: Uint8Array,
    payload: Uint8Array,
    noAck: boolean,
    dynamic: boolean,
  ): AirFrame<Nrf24Header> {
    const channel = this.peek(NRF_REG.RF_CH);
    const dataRate = this.#dataRate();
    const crcBytes = this.#crcBytes();
    const txPowerDbm = nrf24TxPowerDbm((this.peek(NRF_REG.RF_SETUP) >> 1) & 0x03);
    return {
      kind,
      payload: payload.slice(),
      airtimeMs: nrf24AirtimeUs(address.length, payload.length, crcBytes, dataRate) / 1000,
      frequencyHz: nrf24ChannelFrequencyHz(channel),
      bandwidthHz: nrf24BandwidthHz(dataRate),
      noiseFigureDb: NRF24_NOISE_FIGURE_DB,
      requiredSnrDb: nrf24RequiredSnrDb(dataRate),
      referenceBytes: NRF24_REFERENCE_BYTES,
      captureDb: NRF24_CAPTURE_DB,
      txPowerDbm,
      interferenceKey: `nrf24/ch${channel}`,
      rateBps: dataRate,
      dst: addressHex(address),
      src: "",
      params: {
        channel,
        data_rate_kbps: dataRate / 1000,
        tx_power_dbm: txPowerDbm,
        address: addressHex(address),
        pid: this.#pid,
        no_ack: noAck,
        crc_bytes: crcBytes,
        retransmit: this.#retransmits,
      },
      header: {
        channel,
        dataRate,
        address,
        pid: this.#pid,
        noAck,
        crcBytes,
        dynamic,
        ack: kind === "nrf24-ack",
      },
    };
  }

  // ── AirReceiver ────────────────────────────────────────────────────────────

  hear(frame: AirFrame): Hearing {
    if (!isNrf24Frame(frame)) return "deaf";
    const now = this.#opts.clock.now();
    const h = frame.header;
    if (h.channel !== this.peek(NRF_REG.RF_CH) || now < this.#ackingUntil) return "deaf";
    if (this.#state === "tx_wait_ack") {
      const mine = this.#pipeAddress(0);
      return h.ack && sameBytes(h.address, mine) ? "listen" : "deaf";
    }
    if (this.#state !== "rx" || now < this.#rxReadyAt || h.ack) return "deaf";
    const pipe = this.#pipeFor(h.address);
    if (pipe === null) return "deaf";
    return this.#canDecode(h, pipe, frame.payload.length) ? "listen" : "mismatch";
  }

  #canDecode(h: Nrf24Header, pipe: number, length: number): boolean {
    if (h.dataRate !== this.#dataRate() || h.crcBytes !== this.#crcBytes()) return false;
    const dynamic = this.#dynamic(pipe);
    if (dynamic !== h.dynamic) return false;
    return dynamic || length === this.peek(NRF_REG.RX_PW_P0 + pipe);
  }

  receive(frame: AirFrame, _from: string, quality: ReceptionQuality): boolean {
    if (!isNrf24Frame(frame)) return false;
    const h = frame.header;
    if (this.#state === "tx_wait_ack") {
      if (!h.ack || !sameBytes(h.address, this.#pipeAddress(0))) return false;
      this.#cancelTimer();
      const entry = this.#nextToSend();
      if (frame.payload.length > 0 && this.#rx.length < FIFO_DEPTH) {
        this.#rx.push({ payload: frame.payload.slice(), pipe: 0 });
        this.#raise(RX_DR);
      }
      if (entry) this.#txSucceeded(entry);
      return true;
    }
    if (this.#state !== "rx" || h.ack) return false;
    const pipe = this.#pipeFor(h.address);
    if (pipe === null || !this.#canDecode(h, pipe, frame.payload.length)) return false;
    // A full RX FIFO takes nothing and sends no ACK, so the sender retries (§7.5.2).
    if (this.#rx.length >= FIFO_DEPTH) return false;
    this.#regs[NRF_REG.RPD] = quality.rssiDbm > RPD_THRESHOLD_DBM ? 1 : 0;
    const last = this.#lastRx.get(pipe);
    const duplicate = last !== undefined && last.pid === h.pid &&
      sameBytes(last.payload, frame.payload);
    if (!duplicate) {
      this.#lastRx.set(pipe, { pid: h.pid, payload: frame.payload.slice() });
      this.#rx.push({ payload: frame.payload.slice(), pipe });
      this.#raise(RX_DR);
    }
    if (!h.noAck && (this.peek(NRF_REG.EN_AA) & (1 << pipe))) this.#sendAck(pipe, h);
    return true;
  }

  /** The receiver answers 130 us after the packet with an ACK on the same address. */
  #sendAck(pipe: number, h: Nrf24Header): void {
    const ackPayload = (this.peek(NRF_REG.FEATURE) & 0x02)
      ? this.#tx.find((e) => e.ackPipe === pipe) ?? null
      : null;
    const frame = this.#frame(
      "nrf24-ack",
      h.address,
      ackPayload?.payload ?? new Uint8Array(),
      true,
      h.dynamic,
    );
    frame.header.pid = h.pid;
    frame.params.pid = h.pid;
    const now = this.#opts.clock.now();
    this.#ackingUntil = now + SETTLE_MS + frame.airtimeMs;
    this.#opts.clock.schedule(now + SETTLE_MS, () => {
      this.#opts.transmit(frame);
      if (ackPayload) {
        this.#tx = this.#tx.filter((e) => e !== ackPayload);
        this.#raise(TX_DS);
      }
    });
  }

  // ── timers ─────────────────────────────────────────────────────────────────

  #schedule(delayMs: number, fn: () => void): void {
    this.#cancelTimer();
    this.#timer = this.#opts.clock.schedule(this.#opts.clock.now() + delayMs, () => {
      this.#timer = null;
      fn();
    });
  }

  #cancelTimer(): void {
    this.#timer?.();
    this.#timer = null;
  }

  #warnOnce(message: string): void {
    if (this.#warned.has(message)) return;
    this.#warned.add(message);
    this.#opts.warn(message);
  }
}
