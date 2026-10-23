// Semtech SX1276/77/78/79 in LoRa mode, modelled at its SPI register
// interface (fidelity F1: the firmware's own driver talks to it unmodified).
//
// What is modelled: the register file with its LoRa-page reset values, burst
// access with address auto-increment, the 256-byte FIFO behind RegFifo and
// RegFifoAddrPtr, the operating modes (sleep, standby, TX, RX continuous, RX
// single with its symbol timeout), IRQ flags (write 1 to clear) with
// RegIrqFlagsMask, DIO0 per RegDioMapping1, NRESET, and the packet registers
// (RegRxNbBytes, RegFifoRxCurrentAddr, RegPktSnrValue, RegPktRssiValue).
// Modem settings (Frf, SF, BW, CR, header mode, CRC, LDO, preamble, sync word,
// I/Q inversion, PA output power) are read from the registers when a packet is
// sent, so time on air and who can hear it follow what the firmware programmed.
//
// Not modelled, reported once through `warn` when the firmware uses it: FSK/OOK
// mode, channel activity detection (CAD), frequency hopping. DIO1-DIO5 are not
// driven. Register numbers and reset values: datasheet rev. 7, §6.4 and table 41.

import {
  type AirFrame,
  type AirReceiver,
  type Clock,
  frfToHz,
  type Hearing,
  LORA_BANDWIDTHS_HZ,
  LORA_CAPTURE_DB,
  LORA_NOISE_FIGURE_DB,
  LORA_REFERENCE_BYTES,
  loraAirtimeMs,
  loraBitRate,
  type LoraModulation,
  loraRequiredSnrDb,
  noiseFloorDbm,
  type ReceptionQuality,
  type Rng,
  sameLoraChannel,
  symbolTimeMs,
} from "../../engine/mod.ts";
import type { Level, PinDriver, SpiDevice } from "../spi-link/device.ts";

export const REG = {
  FIFO: 0x00,
  OP_MODE: 0x01,
  FRF_MSB: 0x06,
  FRF_MID: 0x07,
  FRF_LSB: 0x08,
  PA_CONFIG: 0x09,
  OCP: 0x0b,
  LNA: 0x0c,
  FIFO_ADDR_PTR: 0x0d,
  FIFO_TX_BASE_ADDR: 0x0e,
  FIFO_RX_BASE_ADDR: 0x0f,
  FIFO_RX_CURRENT_ADDR: 0x10,
  IRQ_FLAGS_MASK: 0x11,
  IRQ_FLAGS: 0x12,
  RX_NB_BYTES: 0x13,
  PKT_SNR_VALUE: 0x19,
  PKT_RSSI_VALUE: 0x1a,
  RSSI_VALUE: 0x1b,
  MODEM_CONFIG_1: 0x1d,
  MODEM_CONFIG_2: 0x1e,
  SYMB_TIMEOUT_LSB: 0x1f,
  PREAMBLE_MSB: 0x20,
  PREAMBLE_LSB: 0x21,
  PAYLOAD_LENGTH: 0x22,
  MAX_PAYLOAD_LENGTH: 0x23,
  HOP_PERIOD: 0x24,
  MODEM_CONFIG_3: 0x26,
  RSSI_WIDEBAND: 0x2c,
  DETECTION_OPTIMIZE: 0x31,
  INVERT_IQ: 0x33,
  DETECTION_THRESHOLD: 0x37,
  SYNC_WORD: 0x39,
  INVERT_IQ_2: 0x3b,
  DIO_MAPPING_1: 0x40,
  DIO_MAPPING_2: 0x41,
  VERSION: 0x42,
  PA_DAC: 0x4d,
} as const;

export const MODE = {
  SLEEP: 0,
  STDBY: 1,
  FSTX: 2,
  TX: 3,
  FSRX: 4,
  RX_CONTINUOUS: 5,
  RX_SINGLE: 6,
  CAD: 7,
} as const;

export const IRQ = {
  RX_TIMEOUT: 0x80,
  RX_DONE: 0x40,
  PAYLOAD_CRC_ERROR: 0x20,
  VALID_HEADER: 0x10,
  TX_DONE: 0x08,
  CAD_DONE: 0x04,
  FHSS_CHANGE_CHANNEL: 0x02,
  CAD_DETECTED: 0x01,
} as const;

const LONG_RANGE_MODE = 0x80;
const SILICON_VERSION = 0x12;
/** RSSI register offsets of the high-frequency (above 525 MHz) and low-frequency ports. */
const RSSI_OFFSET_HF = 157;
const RSSI_OFFSET_LF = 164;
const MID_BAND_HZ = 525e6;

/** LoRa-page reset values that differ from zero (datasheet table 41, "LoRa" column). */
const RESET_VALUES: ReadonlyArray<readonly [number, number]> = [
  [REG.OP_MODE, 0x09],
  [REG.FRF_MSB, 0x6c],
  [REG.FRF_MID, 0x80],
  [REG.FRF_LSB, 0x00],
  [REG.PA_CONFIG, 0x4f],
  [0x0a, 0x09], // RegPaRamp
  [REG.OCP, 0x2b],
  [REG.LNA, 0x20],
  [REG.FIFO_TX_BASE_ADDR, 0x80],
  [REG.MODEM_CONFIG_1, 0x72],
  [REG.MODEM_CONFIG_2, 0x70],
  [REG.SYMB_TIMEOUT_LSB, 0x64],
  [REG.PREAMBLE_LSB, 0x08],
  [REG.PAYLOAD_LENGTH, 0x01],
  [REG.MAX_PAYLOAD_LENGTH, 0xff],
  [REG.DETECTION_OPTIMIZE, 0xc3],
  [REG.INVERT_IQ, 0x27],
  [REG.DETECTION_THRESHOLD, 0x0a],
  [REG.SYNC_WORD, 0x12],
  [REG.INVERT_IQ_2, 0x1d],
  [REG.VERSION, SILICON_VERSION],
  [REG.PA_DAC, 0x84],
];

/** Read-only to the firmware: written by the modem itself. */
const READ_ONLY = new Set<number>([
  REG.FIFO_RX_CURRENT_ADDR,
  REG.RX_NB_BYTES,
  0x14,
  0x15,
  0x16,
  0x17,
  0x18,
  REG.PKT_SNR_VALUE,
  REG.PKT_RSSI_VALUE,
  REG.RSSI_VALUE,
  0x1c,
  0x25,
  0x28,
  0x29,
  0x2a,
  REG.RSSI_WIDEBAND,
  REG.VERSION,
]);

/** The PHY header a LoRa frame carries on the air, for the receiving model. */
export interface LoraHeader {
  modulation: LoraModulation;
}

export interface Sx127xPins {
  /** NSS, active low. */
  cs: number;
  /** NRESET, active low; null when not wired. */
  reset: number | null;
  /** DIO0 output; null when not wired. */
  dio0: number | null;
}

export interface Sx127xOptions {
  pins: Sx127xPins;
  clock: Clock;
  /** Puts a frame on the air. */
  transmit(frame: AirFrame<LoraHeader>): void;
  drivePin: PinDriver;
  /** Source of RegRssiWideband, which drivers read as a random number generator. */
  rng: Rng;
  /** Called once per distinct message when the firmware uses something not modelled. */
  warn(message: string): void;
}

export function isLoraFrame(frame: AirFrame): frame is AirFrame<LoraHeader> {
  return frame.kind === "lora";
}

/** Output power from RegPaConfig and RegPaDac (datasheet §5.4.2, §5.4.3). */
export function paOutputDbm(paConfig: number, paDac: number): number {
  const outputPower = paConfig & 0x0f;
  if (paConfig & 0x80) {
    // PA_BOOST: Pout = 17 - (15 - OutputPower); +3 dB with the high-power DAC setting.
    return 2 + outputPower + ((paDac & 0x07) === 0x07 ? 3 : 0);
  }
  // RFO: Pmax = 10.8 + 0.6 * MaxPower; Pout = Pmax - (15 - OutputPower).
  const maxPower = (paConfig >> 4) & 0x07;
  return 10.8 + 0.6 * maxPower - (15 - outputPower);
}

export class Sx127x implements SpiDevice, AirReceiver {
  readonly #opts: Sx127xOptions;
  readonly #regs = new Uint8Array(0x80);
  readonly #fifo = new Uint8Array(256);
  readonly #warned = new Set<string>();
  #selected = false;
  #inReset = false;
  /** Register of the burst in progress, or null before the address byte. */
  #address: number | null = null;
  #writing = false;
  #rxByteAddr = 0;
  /** In RX continuous or single, so a new RX entry keeps the FIFO write position. */
  #inRx = false;
  #dio0: Level = 0;
  #cancelTx: (() => void) | null = null;
  #cancelRxTimeout: (() => void) | null = null;
  #rxTimeoutAt = 0;

  constructor(opts: Sx127xOptions) {
    this.#opts = opts;
    this.#reset();
  }

  /** Current value of a register, for tests and the report. */
  peek(address: number): number {
    return this.#regs[address & 0x7f] ?? 0;
  }

  get mode(): number {
    return this.peek(REG.OP_MODE) & 0x07;
  }

  get loraMode(): boolean {
    return (this.peek(REG.OP_MODE) & LONG_RANGE_MODE) !== 0;
  }

  /** The modem settings in the registers right now. */
  modulation(): LoraModulation {
    const r = (a: number) => this.peek(a);
    const mc1 = r(REG.MODEM_CONFIG_1);
    const mc2 = r(REG.MODEM_CONFIG_2);
    const invert = r(REG.INVERT_IQ);
    return {
      frequencyHz: frfToHz((r(REG.FRF_MSB) << 16) | (r(REG.FRF_MID) << 8) | r(REG.FRF_LSB)),
      sf: mc2 >> 4,
      bandwidthHz: LORA_BANDWIDTHS_HZ[mc1 >> 4] ?? NaN,
      codingRate: (mc1 >> 1) & 0x07,
      preambleLength: (r(REG.PREAMBLE_MSB) << 8) | r(REG.PREAMBLE_LSB),
      explicitHeader: (mc1 & 0x01) === 0,
      crc: (mc2 & 0x04) !== 0,
      lowDataRateOptimize: (r(REG.MODEM_CONFIG_3) & 0x08) !== 0,
      syncWord: r(REG.SYNC_WORD),
      // InvertIQ-TX (bit 0) has inverted logic on the silicon: 0 means inverted.
      invertIq: (invert & 0x01) === 0,
    };
  }

  // ── SpiDevice ──────────────────────────────────────────────────────────────

  pinChanged(gpio: number, level: Level): void {
    const { pins } = this.#opts;
    if (gpio === pins.cs) {
      this.#selected = level === 0;
      this.#address = null;
    }
    if (pins.reset !== null && gpio === pins.reset) {
      if (level === 0 && !this.#inReset) this.#reset();
      this.#inReset = level === 0;
    }
  }

  transfer(mosi: number): number {
    if (!this.#selected || this.#inReset) return 0xff;
    if (this.#address === null) {
      this.#address = mosi & 0x7f;
      this.#writing = (mosi & 0x80) !== 0;
      return 0x00;
    }
    const address = this.#address;
    let miso: number;
    if (this.#writing) {
      miso = 0x00;
      this.#write(address, mosi & 0xff);
    } else {
      miso = this.#read(address);
    }
    // Burst access: the address increments, except on the FIFO, where the pointer does.
    if (address !== REG.FIFO) this.#address = (address + 1) & 0x7f;
    return miso;
  }

  // ── AirReceiver ────────────────────────────────────────────────────────────

  hear(frame: AirFrame): Hearing {
    if (!isLoraFrame(frame) || !this.#listening()) return "deaf";
    const mine = this.modulation();
    const theirs = frame.header.modulation;
    if (!sameLoraChannel(mine, theirs)) return "deaf";
    if (!this.#canDecode(mine, theirs, frame.payload.length)) return "mismatch";
    if (this.mode === MODE.RX_SINGLE) {
      // Preamble detected: RX single stays on until the packet ends.
      this.#armRxTimeout(Math.max(this.#rxTimeoutAt, this.#opts.clock.now() + frame.airtimeMs + 1));
    }
    return "listen";
  }

  receive(frame: AirFrame, _from: string, quality: ReceptionQuality): boolean {
    if (!isLoraFrame(frame) || !this.#listening()) return false;
    const mine = this.modulation();
    if (
      !sameLoraChannel(mine, frame.header.modulation) ||
      !this.#canDecode(mine, frame.header.modulation, frame.payload.length)
    ) {
      return false;
    }
    const start = this.#rxByteAddr;
    frame.payload.forEach((b, i) => {
      this.#fifo[(start + i) & 0xff] = b;
    });
    this.#rxByteAddr = (start + frame.payload.length) & 0xff;
    this.#regs[REG.FIFO_RX_CURRENT_ADDR] = start;
    this.#regs[REG.RX_NB_BYTES] = frame.payload.length;
    this.#regs[REG.PKT_SNR_VALUE] = Math.max(-128, Math.min(127, Math.round(quality.snrDb * 4))) &
      0xff;
    // Datasheet §5.5.5: for SNR < 0, RSSI = -157 + PacketRssi + PacketSnr / 4.
    const rssiReg = quality.rssiDbm + this.#rssiOffset() - Math.min(0, quality.snrDb);
    this.#regs[REG.PKT_RSSI_VALUE] = Math.max(0, Math.min(255, Math.round(rssiReg)));
    this.#raise(IRQ.VALID_HEADER | IRQ.RX_DONE);
    if (this.mode === MODE.RX_SINGLE) this.#enterMode(MODE.STDBY);
    return true;
  }

  // ── registers ──────────────────────────────────────────────────────────────

  #read(address: number): number {
    switch (address) {
      case REG.FIFO: {
        const pointer = this.peek(REG.FIFO_ADDR_PTR);
        this.#regs[REG.FIFO_ADDR_PTR] = (pointer + 1) & 0xff;
        return this.#fifo[pointer] ?? 0;
      }
      case REG.RSSI_VALUE: {
        // Nothing is on the air between packets in this model: the floor.
        const mod = this.modulation();
        const floor = noiseFloorDbm(LORA_NOISE_FIGURE_DB, mod.bandwidthHz || 125e3);
        return Math.max(0, Math.min(255, Math.round(floor + this.#rssiOffset())));
      }
      case REG.RSSI_WIDEBAND:
        return this.#opts.rng.int(256);
      default:
        return this.peek(address);
    }
  }

  #write(address: number, value: number): void {
    switch (address) {
      case REG.FIFO: {
        const pointer = this.peek(REG.FIFO_ADDR_PTR);
        this.#fifo[pointer] = value;
        this.#regs[REG.FIFO_ADDR_PTR] = (pointer + 1) & 0xff;
        return;
      }
      case REG.OP_MODE: {
        const current = this.peek(REG.OP_MODE);
        // LongRangeMode only changes in sleep (datasheet §6.4, RegOpMode bit 7).
        // Drivers write it together with the sleep mode, so a write that is or
        // starts from sleep takes it.
        const canSwitch = (current & 0x07) === MODE.SLEEP || (value & 0x07) === MODE.SLEEP;
        const longRange = canSwitch ? value & LONG_RANGE_MODE : current & LONG_RANGE_MODE;
        this.#regs[REG.OP_MODE] = (value & 0x7f) | longRange;
        this.#enterMode(value & 0x07);
        return;
      }
      case REG.IRQ_FLAGS:
        this.#regs[REG.IRQ_FLAGS] = this.peek(REG.IRQ_FLAGS) & ~value;
        this.#updateDio0();
        return;
      case REG.DIO_MAPPING_1:
        this.#regs[address] = value;
        this.#updateDio0();
        return;
      case REG.HOP_PERIOD:
        if (value !== 0) this.#warnOnce("frequency hopping (RegHopPeriod) is not modelled");
        this.#regs[address] = value;
        return;
      default:
        if (!READ_ONLY.has(address)) this.#regs[address] = value;
    }
  }

  // ── modes ──────────────────────────────────────────────────────────────────

  #enterMode(mode: number): void {
    const { clock } = this.#opts;
    if (mode !== MODE.TX && this.#cancelTx) {
      this.#cancelTx();
      this.#cancelTx = null;
    }
    if (mode !== MODE.RX_SINGLE) this.#clearRxTimeout();
    const wasReceiving = this.#inRx;
    this.#inRx = mode === MODE.RX_CONTINUOUS || mode === MODE.RX_SINGLE;
    if (
      !this.loraMode && (mode === MODE.TX || mode === MODE.RX_CONTINUOUS || mode === MODE.RX_SINGLE)
    ) {
      this.#warnOnce(
        "FSK/OOK mode is not modelled: only LoRa mode (RegOpMode bit 7) transmits and receives",
      );
      return;
    }
    switch (mode) {
      case MODE.TX:
        if (!this.#cancelTx) this.#startTx();
        return;
      case MODE.RX_CONTINUOUS:
        if (!wasReceiving) this.#rxByteAddr = this.peek(REG.FIFO_RX_BASE_ADDR);
        return;
      case MODE.RX_SINGLE: {
        if (!wasReceiving) this.#rxByteAddr = this.peek(REG.FIFO_RX_BASE_ADDR);
        const mod = this.modulation();
        const symbols = ((this.peek(REG.MODEM_CONFIG_2) & 0x03) << 8) |
          this.peek(REG.SYMB_TIMEOUT_LSB);
        if (this.#cancelRxTimeout === null) {
          this.#armRxTimeout(clock.now() + symbols * symbolTimeMs(mod.sf, mod.bandwidthHz));
        }
        return;
      }
      case MODE.CAD:
        this.#warnOnce("channel activity detection (CAD) is not modelled; CadDone never rises");
        return;
      default:
        return;
    }
  }

  #startTx(): void {
    const mod = this.modulation();
    if (!(mod.sf >= 6 && mod.sf <= 12) || Number.isNaN(mod.bandwidthHz)) {
      this.#warnOnce(
        `invalid modem settings (SF ${mod.sf}, bandwidth code ${
          this.peek(REG.MODEM_CONFIG_1) >> 4
        }); nothing transmitted`,
      );
      this.#enterStandbyAfterTx();
      return;
    }
    const length = this.peek(REG.PAYLOAD_LENGTH);
    const base = this.peek(REG.FIFO_TX_BASE_ADDR);
    const payload = Uint8Array.from({ length }, (_, i) => this.#fifo[(base + i) & 0xff] ?? 0);
    const airtimeMs = loraAirtimeMs(mod, length);
    const txPowerDbm = paOutputDbm(this.peek(REG.PA_CONFIG), this.peek(REG.PA_DAC));
    this.#opts.transmit({
      kind: "lora",
      payload,
      airtimeMs,
      frequencyHz: mod.frequencyHz,
      bandwidthHz: mod.bandwidthHz,
      noiseFigureDb: LORA_NOISE_FIGURE_DB,
      requiredSnrDb: loraRequiredSnrDb(mod.sf),
      referenceBytes: LORA_REFERENCE_BYTES,
      captureDb: LORA_CAPTURE_DB,
      txPowerDbm,
      // Rounded to 1 kHz, so registers a few hertz apart still share a channel.
      interferenceKey: `${Math.round(mod.frequencyHz / 1e3)}k/bw${mod.bandwidthHz}/sf${mod.sf}`,
      rateBps: loraBitRate(mod),
      dst: "",
      src: "",
      params: {
        frequency_mhz: Number((mod.frequencyHz / 1e6).toFixed(4)),
        sf: mod.sf,
        bw_khz: mod.bandwidthHz / 1000,
        cr: `4/${mod.codingRate + 4}`,
        crc: mod.crc,
        explicit_header: mod.explicitHeader,
        preamble: mod.preambleLength,
        ldo: mod.lowDataRateOptimize,
        sync_word: mod.syncWord,
        invert_iq: mod.invertIq,
        tx_power_dbm: Number(txPowerDbm.toFixed(1)),
      },
      header: { modulation: mod },
    });
    this.#cancelTx = this.#opts.clock.schedule(this.#opts.clock.now() + airtimeMs, () => {
      this.#cancelTx = null;
      this.#enterStandbyAfterTx();
    });
  }

  #enterStandbyAfterTx(): void {
    this.#regs[REG.OP_MODE] = (this.peek(REG.OP_MODE) & ~0x07) | MODE.STDBY;
    this.#raise(IRQ.TX_DONE);
  }

  #listening(): boolean {
    return this.loraMode && (this.mode === MODE.RX_CONTINUOUS || this.mode === MODE.RX_SINGLE);
  }

  /** Same SF, sync word and I/Q; an implicit-header receiver also needs the same CR, CRC and length. */
  #canDecode(mine: LoraModulation, theirs: LoraModulation, length: number): boolean {
    if (mine.sf !== theirs.sf || mine.syncWord !== theirs.syncWord) return false;
    // InvertIQ-RX (bit 6) is plain logic.
    const rxInverted = (this.peek(REG.INVERT_IQ) & 0x40) !== 0;
    if (rxInverted !== theirs.invertIq) return false;
    if (mine.explicitHeader !== theirs.explicitHeader) return false;
    if (!mine.explicitHeader) {
      return mine.codingRate === theirs.codingRate && mine.crc === theirs.crc &&
        this.peek(REG.PAYLOAD_LENGTH) === length;
    }
    return true;
  }

  #armRxTimeout(atMs: number): void {
    this.#clearRxTimeout();
    this.#rxTimeoutAt = atMs;
    this.#cancelRxTimeout = this.#opts.clock.schedule(atMs, () => {
      this.#cancelRxTimeout = null;
      if (this.mode !== MODE.RX_SINGLE) return;
      this.#regs[REG.OP_MODE] = (this.peek(REG.OP_MODE) & ~0x07) | MODE.STDBY;
      this.#inRx = false;
      this.#raise(IRQ.RX_TIMEOUT);
    });
  }

  #clearRxTimeout(): void {
    this.#cancelRxTimeout?.();
    this.#cancelRxTimeout = null;
    this.#rxTimeoutAt = 0;
  }

  #raise(flags: number): void {
    const unmasked = flags & ~this.peek(REG.IRQ_FLAGS_MASK);
    this.#regs[REG.IRQ_FLAGS] = this.peek(REG.IRQ_FLAGS) | unmasked;
    this.#updateDio0();
  }

  /** DIO0 follows the flag RegDioMapping1 bits 7:6 select: RxDone, TxDone or CadDone. */
  #updateDio0(): void {
    const mapping = this.peek(REG.DIO_MAPPING_1) >> 6;
    const source = mapping === 0
      ? IRQ.RX_DONE
      : mapping === 1
      ? IRQ.TX_DONE
      : mapping === 2
      ? IRQ.CAD_DONE
      : 0;
    const level: Level = (this.peek(REG.IRQ_FLAGS) & source) !== 0 ? 1 : 0;
    if (level === this.#dio0) return;
    this.#dio0 = level;
    if (this.#opts.pins.dio0 !== null) this.#opts.drivePin(this.#opts.pins.dio0, level);
  }

  #rssiOffset(): number {
    return this.modulation().frequencyHz < MID_BAND_HZ ? RSSI_OFFSET_LF : RSSI_OFFSET_HF;
  }

  #reset(): void {
    this.#cancelTx?.();
    this.#cancelTx = null;
    this.#clearRxTimeout();
    this.#regs.fill(0);
    this.#fifo.fill(0);
    for (const [address, value] of RESET_VALUES) this.#regs[address] = value;
    this.#rxByteAddr = 0;
    this.#inRx = false;
    this.#address = null;
    if (this.#dio0 !== 0) {
      this.#dio0 = 0;
      if (this.#opts.pins.dio0 !== null) this.#opts.drivePin(this.#opts.pins.dio0, 0);
    }
  }

  #warnOnce(message: string): void {
    if (this.#warned.has(message)) return;
    this.#warned.add(message);
    this.#opts.warn(message);
  }
}
