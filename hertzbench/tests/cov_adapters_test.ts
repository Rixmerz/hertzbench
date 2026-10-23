// Edge cases, invalid input and error paths of the adapters: the SX127x and
// nRF24L01+ register models, spi-link (protocol, adapter, client), the
// loopback ports, qemu-wifi-l2 framing, and ble-hci (H4, link-layer PDUs, the
// virtual controller, the TCP adapter and the btsnoop capture).

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  type AirFrame,
  AirMedium,
  environmentFromPreset,
  EventLog,
  ManualClock,
  type Position,
  substream,
} from "../engine/mod.ts";
import { IRQ, MODE, REG, Sx127x } from "../adapters/lora-sx127x/mod.ts";
import { Nrf24l01, NRF_CMD, NRF_REG } from "../adapters/nrf24/mod.ts";
import {
  encode,
  type Level,
  MessageDecoder,
  OP_DRIVE,
  OP_MISO,
  OP_PIN,
  OP_XFER,
  type PinDriver,
  ProtocolError,
  type SpiDevice,
  SpiLinkAdapter,
  SpiLinkClient,
  workerRadioSpiConfig,
} from "../adapters/spi-link/mod.ts";
import { LoopbackPorts } from "../adapters/loopback-ports.ts";
import {
  encodeFrame,
  FrameDecoder,
  FramingError,
  MAX_FRAME_BYTES,
} from "../adapters/qemu-wifi-l2/mod.ts";
import {
  addressToBytes,
  addressToString,
  ADV_PDU,
  type BleAirHeader,
  BleController,
  BleHciAdapter,
  BtsnoopWriter,
  encodeAdvPdu,
  encodeConnectInd,
  encodeDataPdu,
  encodeHci,
  EVT,
  H4_ACL,
  H4_COMMAND,
  H4_EVENT,
  H4Decoder,
  type HciPacket,
  HciProtocolError,
  LE_SUBEVENT,
  LL_CTRL,
  LLID,
  OP,
  parseAdvPdu,
  parseConnectInd,
  parseDataPdu,
  readU16,
  STATUS,
  SUPPORTED_COMMAND_BITS,
  supportedCommands,
  u16,
} from "../adapters/ble-hci/mod.ts";
import { until } from "./helpers.ts";

// ── SX127x driven by raw register access ────────────────────────────────────

const LORA_PINS = { cs: 5, reset: 14, dio0: 26 };

function loraAir(positions: Record<string, Position>) {
  const clock = new ManualClock();
  const log = new EventLog();
  const air = new AirMedium({
    seed: 3,
    clock,
    log,
    environment: environmentFromPreset("free_space", { shadowingSigmaDb: 0 }),
  });
  const warnings: string[] = [];
  const dio0: Level[] = [];
  const chips = new Map<string, Sx127x>();
  for (const [id, position] of Object.entries(positions)) {
    const chip = new Sx127x({
      pins: LORA_PINS,
      clock,
      transmit: (frame) => air.transmit(id, frame),
      drivePin: (_gpio, level) => dio0.push(level),
      rng: substream(3, `sx127x:${id}`),
      warn: (message) => warnings.push(message),
    });
    air.addNode({ id, position, antennaGainDbi: 0 }, chip);
    chips.set(id, chip);
  }
  return { clock, log, air, warnings, dio0, chip: (id: string) => chips.get(id)! };
}

function writeReg(chip: Sx127x, address: number, ...values: number[]): void {
  chip.pinChanged(LORA_PINS.cs, 0);
  chip.transfer(address | 0x80);
  for (const v of values) chip.transfer(v);
  chip.pinChanged(LORA_PINS.cs, 1);
}

function readReg(chip: Sx127x, address: number, count = 1): number[] {
  chip.pinChanged(LORA_PINS.cs, 0);
  chip.transfer(address & 0x7f);
  const out = Array.from({ length: count }, () => chip.transfer(0));
  chip.pinChanged(LORA_PINS.cs, 1);
  return out;
}

/** LoRa mode, standby, then the payload in the FIFO at the TX base and TX mode. */
function loraSend(chip: Sx127x, payload: number[]): void {
  writeReg(chip, REG.OP_MODE, 0x80);
  writeReg(chip, REG.OP_MODE, 0x81);
  writeReg(chip, REG.FIFO_ADDR_PTR, chip.peek(REG.FIFO_TX_BASE_ADDR));
  writeReg(chip, REG.FIFO, ...payload);
  writeReg(chip, REG.PAYLOAD_LENGTH, payload.length);
  writeReg(chip, REG.OP_MODE, 0x80 | MODE.TX);
}

Deno.test("sx127x: RxDone in RX single puts RegOpMode back to standby, and a second packet is not taken", () => {
  const r = loraAir({ tx: { x: 0, y: 0 }, rx: { x: 20, y: 0 } });
  const rx = r.chip("rx");
  writeReg(rx, REG.OP_MODE, 0x80);
  writeReg(rx, REG.OP_MODE, 0x80 | MODE.RX_SINGLE);
  assertEquals(rx.mode, MODE.RX_SINGLE);

  loraSend(r.chip("tx"), [1, 2, 3, 4]);
  r.clock.advanceBy(60);
  assert(rx.peek(REG.IRQ_FLAGS) & IRQ.RX_DONE, "the first packet arrives");
  assertEquals(rx.peek(REG.RX_NB_BYTES), 4);
  assertEquals(rx.mode, MODE.STDBY, "RX single returns to standby on its own after RxDone");

  writeReg(r.chip("tx"), REG.OP_MODE, 0x81);
  loraSend(r.chip("tx"), [9, 9]);
  r.clock.advanceBy(60);
  assertEquals(rx.peek(REG.RX_NB_BYTES), 4, "a chip in standby does not receive");
});

// ── nRF24L01+ driven by raw SPI commands ────────────────────────────────────

const NRF_PINS = { csn: 5, ce: 4, irq: 26 };

function nrfAir(positions: Record<string, Position>) {
  const clock = new ManualClock();
  const log = new EventLog();
  const air = new AirMedium({
    seed: 11,
    clock,
    log,
    environment: environmentFromPreset("free_space", { shadowingSigmaDb: 0 }),
  });
  const warnings: string[] = [];
  const irq: Level[] = [];
  const chips = new Map<string, Nrf24l01>();
  for (const [id, position] of Object.entries(positions)) {
    const chip = new Nrf24l01({
      pins: NRF_PINS,
      clock,
      transmit: (frame) => air.transmit(id, frame),
      drivePin: (_gpio, level) => irq.push(level),
      warn: (message) => warnings.push(message),
    });
    air.addNode({ id, position, antennaGainDbi: 0 }, chip);
    chips.set(id, chip);
  }
  const outcomes = () =>
    log.events.flatMap((e) =>
      e.type === "deliver"
        ? [`${e.kind}:deliver`]
        : e.type === "drop"
        ? [`${e.kind}:${e.reason}`]
        : []
    );
  return { clock, log, air, warnings, irq, outcomes, chip: (id: string) => chips.get(id)! };
}

/** One SPI command: CSN low, the bytes, CSN high. Returns what came back on MISO. */
function nrfCmd(chip: Nrf24l01, ...bytes: number[]): number[] {
  chip.pinChanged(NRF_PINS.csn, 0);
  const out = bytes.map((b) => chip.transfer(b));
  chip.pinChanged(NRF_PINS.csn, 1);
  return out;
}

const nrfWrite = (chip: Nrf24l01, reg: number, ...values: number[]) =>
  nrfCmd(chip, NRF_CMD.W_REGISTER | reg, ...values);

Deno.test("nrf24: RF_CH above 125 is warned about and puts nothing on the air instead of throwing", () => {
  const r = nrfAir({ tx: { x: 0, y: 0 }, rx: { x: 5, y: 0 } });
  const chip = r.chip("tx");
  nrfWrite(chip, NRF_REG.CONFIG, 0x0e);
  nrfWrite(chip, NRF_REG.RF_CH, 127);
  assertEquals(chip.peek(NRF_REG.RF_CH), 127, "the register holds 7 bits");
  nrfCmd(chip, NRF_CMD.W_TX_PAYLOAD, 1, 2, 3);
  chip.pinChanged(NRF_PINS.ce, 1);
  r.clock.advanceBy(50);
  assertEquals(r.log.events.filter((e) => e.type === "tx").length, 0);
  assertEquals(r.warnings.length, 1);
  assert(r.warnings[0]!.includes("RF_CH 127"), r.warnings[0]);
  assert(nrfCmd(chip, NRF_CMD.NOP)[0]! & 0x10, "no ACK can come back: MAX_RT");
});

/** PWR_UP, 2-byte CRC; RX or TX; pipe 1 or the TX address on `address`; static 3-byte payloads. */
function nrfSetup(chip: Nrf24l01, role: "tx" | "rx", address = [1, 2, 3, 4, 5]): void {
  nrfWrite(chip, NRF_REG.CONFIG, role === "rx" ? 0x0f : 0x0e);
  nrfWrite(chip, NRF_REG.RF_CH, 76);
  nrfWrite(chip, NRF_REG.RX_ADDR_P0, ...address);
  nrfWrite(chip, NRF_REG.TX_ADDR, ...address);
  nrfWrite(chip, NRF_REG.RX_PW_P0, 3);
  if (role === "rx") chip.pinChanged(NRF_PINS.ce, 1);
}

Deno.test("nrf24: a receiver retuned above channel 125 mid-packet sends no ACK instead of throwing", () => {
  const r = nrfAir({ tx: { x: 0, y: 0 }, rx: { x: 5, y: 0 } });
  const tx = r.chip("tx");
  const rx = r.chip("rx");
  nrfSetup(rx, "rx");
  nrfSetup(tx, "tx");
  r.clock.advanceBy(1);
  nrfCmd(tx, NRF_CMD.W_TX_PAYLOAD, 7, 8, 9);
  tx.pinChanged(NRF_PINS.ce, 1);
  r.clock.advanceBy(0.14); // settled, the packet is on the air
  nrfWrite(rx, NRF_REG.RF_CH, 126);
  r.clock.advanceBy(50);
  assertEquals(rx.rxCount, 1, "the packet that had started still arrives");
  assert(r.warnings.some((w) => w.includes("RF_CH 126")), r.warnings.join("; "));
  assert(nrfCmd(tx, NRF_CMD.NOP)[0]! & 0x10, "the sender never gets the ACK: MAX_RT");
});

// ── SX127x: registers and modes ─────────────────────────────────────────────

Deno.test("sx127x: an unselected or resetting chip answers 0xff and takes nothing", () => {
  const r = loraAir({ a: { x: 0, y: 0 } });
  const chip = r.chip("a");
  assertEquals(chip.transfer(0x80 | REG.SYNC_WORD), 0xff, "CS high");
  writeReg(chip, REG.SYNC_WORD, 0x34);
  assertEquals(chip.peek(REG.SYNC_WORD), 0x34);
  chip.pinChanged(LORA_PINS.reset, 0);
  assertEquals(chip.peek(REG.SYNC_WORD), 0x12, "NRESET low restores the reset values");
  chip.pinChanged(LORA_PINS.cs, 0);
  assertEquals(chip.transfer(0x80 | REG.SYNC_WORD), 0xff, "in reset");
  chip.pinChanged(LORA_PINS.cs, 1);
  chip.pinChanged(LORA_PINS.reset, 0);
  chip.pinChanged(LORA_PINS.reset, 1);
  writeReg(chip, REG.SYNC_WORD, 0x56);
  assertEquals(chip.peek(REG.SYNC_WORD), 0x56, "out of reset it listens again");
});

Deno.test("sx127x: a chip without a reset line ignores that GPIO", () => {
  const clock = new ManualClock();
  const chip = new Sx127x({
    pins: { cs: 5, reset: null, dio0: null },
    clock,
    transmit: () => {},
    drivePin: () => {
      throw new Error("DIO0 is not wired");
    },
    rng: substream(1, "x"),
    warn: () => {},
  });
  writeReg(chip, REG.SYNC_WORD, 0x34);
  chip.pinChanged(14, 0);
  assertEquals(chip.peek(REG.SYNC_WORD), 0x34);
  writeReg(chip, REG.DIO_MAPPING_1, 0x40);
  writeReg(chip, REG.OP_MODE, 0x80);
  writeReg(chip, REG.OP_MODE, 0x83);
  clock.advanceBy(100);
  assert(chip.peek(REG.IRQ_FLAGS) & IRQ.TX_DONE, "TxDone rises with no DIO0 to drive");
});

Deno.test("sx127x: burst reads auto-increment, FIFO reads move the FIFO pointer instead", () => {
  const r = loraAir({ a: { x: 0, y: 0 } });
  const chip = r.chip("a");
  assertEquals(readReg(chip, REG.FRF_MSB, 3), [0x6c, 0x80, 0x00]);
  writeReg(chip, REG.OP_MODE, 0x80);
  writeReg(chip, REG.FIFO_ADDR_PTR, 0x10);
  writeReg(chip, REG.FIFO, 7, 8, 9);
  assertEquals(chip.peek(REG.FIFO_ADDR_PTR), 0x13);
  writeReg(chip, REG.FIFO_ADDR_PTR, 0x10);
  assertEquals(readReg(chip, REG.FIFO, 3), [7, 8, 9]);
  assertEquals(readReg(chip, 0x7f, 2), [0, 0x00], "the address wraps from 0x7f to 0x00 (FIFO)");
});

Deno.test("sx127x: read-only registers keep their value, IRQ flags clear by writing 1", () => {
  const r = loraAir({ a: { x: 0, y: 0 } });
  const chip = r.chip("a");
  writeReg(chip, REG.VERSION, 0x99);
  writeReg(chip, REG.RX_NB_BYTES, 0x55);
  assertEquals([chip.peek(REG.VERSION), chip.peek(REG.RX_NB_BYTES)], [0x12, 0]);
  writeReg(chip, REG.OP_MODE, 0x80);
  writeReg(chip, REG.OP_MODE, 0x83);
  r.clock.advanceBy(100);
  assertEquals(chip.peek(REG.IRQ_FLAGS), IRQ.TX_DONE);
  writeReg(chip, REG.IRQ_FLAGS, 0x00);
  assertEquals(chip.peek(REG.IRQ_FLAGS), IRQ.TX_DONE, "writing 0 clears nothing");
  writeReg(chip, REG.IRQ_FLAGS, 0xff);
  assertEquals(chip.peek(REG.IRQ_FLAGS), 0);
});

Deno.test("sx127x: RegRssiValue is the noise floor with the band's offset, RssiWideband is random", () => {
  const r = loraAir({ a: { x: 0, y: 0 } });
  const chip = r.chip("a");
  writeReg(chip, REG.OP_MODE, 0x80);
  // Reset Frf is 434 MHz: the low-frequency port, offset 164. Floor at 125 kHz, NF 6: -117.03 dBm.
  assertEquals(readReg(chip, REG.RSSI_VALUE), [47]);
  writeReg(chip, REG.FRF_MSB, 0xd9, 0x06, 0x66); // 868.1 MHz: offset 157
  assertEquals(readReg(chip, REG.RSSI_VALUE), [40]);
  const draws = Array.from({ length: 16 }, () => readReg(chip, REG.RSSI_WIDEBAND)[0]!);
  assert(new Set(draws).size > 4, `wideband draws ${draws}`);
  assert(draws.every((d) => d >= 0 && d <= 255));
});

Deno.test("sx127x: LongRangeMode changes only from or into sleep; FSK TX and RX are warned and do nothing", () => {
  const r = loraAir({ a: { x: 0, y: 0 } });
  const chip = r.chip("a");
  writeReg(chip, REG.OP_MODE, 0x81); // from the reset value 0x09 (FSK standby): not sleep
  assertEquals(chip.loraMode, false);
  writeReg(chip, REG.OP_MODE, 0x83);
  writeReg(chip, REG.OP_MODE, 0x85);
  r.clock.advanceBy(200);
  assertEquals(r.log.events.filter((e) => e.type === "tx").length, 0);
  assertEquals(r.warnings.filter((w) => w.includes("FSK/OOK")).length, 1, "warned once");
  writeReg(chip, REG.OP_MODE, 0x80);
  assertEquals(chip.loraMode, true, "a write into sleep takes the bit");
  writeReg(chip, REG.OP_MODE, 0x81);
  writeReg(chip, REG.OP_MODE, 0x01);
  assertEquals(chip.loraMode, true, "outside sleep a write without the bit keeps LoRa mode");
});

Deno.test("sx127x: CAD, frequency hopping and invalid modem settings are warned once each", () => {
  const r = loraAir({ a: { x: 0, y: 0 } });
  const chip = r.chip("a");
  writeReg(chip, REG.OP_MODE, 0x80);
  writeReg(chip, REG.OP_MODE, 0x80 | MODE.CAD);
  writeReg(chip, REG.OP_MODE, 0x80 | MODE.CAD);
  writeReg(chip, REG.HOP_PERIOD, 0);
  writeReg(chip, REG.HOP_PERIOD, 5);
  writeReg(chip, REG.HOP_PERIOD, 6);
  assertEquals(chip.peek(REG.HOP_PERIOD), 6);
  writeReg(chip, REG.OP_MODE, 0x81);
  writeReg(chip, REG.MODEM_CONFIG_2, 0x50); // SF5 does not exist
  writeReg(chip, REG.OP_MODE, 0x83);
  assertEquals(chip.mode, MODE.STDBY, "back to standby at once");
  assert(chip.peek(REG.IRQ_FLAGS) & IRQ.TX_DONE, "TxDone still rises so a driver does not hang");
  writeReg(chip, REG.MODEM_CONFIG_2, 0x70);
  writeReg(chip, REG.MODEM_CONFIG_1, 0xa2); // bandwidth code 10 is reserved
  writeReg(chip, REG.OP_MODE, 0x83);
  assertEquals(r.log.events.filter((e) => e.type === "tx").length, 0);
  assertEquals(r.warnings.length, 4, r.warnings.join("; "));
  assert(r.warnings.some((w) => w.includes("CAD")));
  assert(r.warnings.some((w) => w.includes("RegHopPeriod")));
  assert(r.warnings.some((w) => w.includes("SF 5")));
  assert(r.warnings.some((w) => w.includes("bandwidth code 10")));
});

Deno.test("sx127x: DIO0 follows the mapped flag only, and a masked flag neither sets nor drives", () => {
  const r = loraAir({ a: { x: 0, y: 0 } });
  const chip = r.chip("a");
  writeReg(chip, REG.OP_MODE, 0x80);
  writeReg(chip, REG.DIO_MAPPING_1, 0x00); // RxDone
  writeReg(chip, REG.OP_MODE, 0x83);
  r.clock.advanceBy(100);
  assertEquals(r.dio0, [], "TxDone is not what DIO0 shows under mapping 00");
  writeReg(chip, REG.DIO_MAPPING_1, 0x40); // TxDone
  assertEquals(r.dio0, [1], "remapping shows the flag already set");
  writeReg(chip, REG.DIO_MAPPING_1, 0xc0); // nothing
  assertEquals(r.dio0, [1, 0]);
  writeReg(chip, REG.IRQ_FLAGS, 0xff);
  writeReg(chip, REG.IRQ_FLAGS_MASK, IRQ.TX_DONE);
  writeReg(chip, REG.DIO_MAPPING_1, 0x40);
  writeReg(chip, REG.OP_MODE, 0x83);
  r.clock.advanceBy(100);
  assertEquals(chip.peek(REG.IRQ_FLAGS) & IRQ.TX_DONE, 0);
  assertEquals(r.dio0, [1, 0]);
});

Deno.test("sx127x: leaving TX mid-packet cancels TxDone; writing TX again while sending starts nothing new", () => {
  const r = loraAir({ a: { x: 0, y: 0 } });
  const chip = r.chip("a");
  writeReg(chip, REG.OP_MODE, 0x80);
  writeReg(chip, REG.OP_MODE, 0x83);
  writeReg(chip, REG.OP_MODE, 0x83);
  assertEquals(r.log.events.filter((e) => e.type === "tx").length, 1);
  writeReg(chip, REG.OP_MODE, 0x81);
  r.clock.advanceBy(100);
  assertEquals(chip.peek(REG.IRQ_FLAGS) & IRQ.TX_DONE, 0);
});

Deno.test("sx127x: RX continuous appends packets in the FIFO and points at the newest", () => {
  const r = loraAir({ tx: { x: 0, y: 0 }, rx: { x: 30, y: 0 } });
  const rx = r.chip("rx");
  writeReg(rx, REG.OP_MODE, 0x80);
  writeReg(rx, REG.OP_MODE, 0x80 | MODE.RX_CONTINUOUS);
  loraSend(r.chip("tx"), [1, 2, 3]);
  r.clock.advanceBy(60);
  loraSend(r.chip("tx"), [4, 5]);
  r.clock.advanceBy(60);
  assertEquals(rx.peek(REG.FIFO_RX_CURRENT_ADDR), 3);
  assertEquals(rx.peek(REG.RX_NB_BYTES), 2);
  writeReg(rx, REG.FIFO_ADDR_PTR, 0);
  assertEquals(readReg(rx, REG.FIFO, 5), [1, 2, 3, 4, 5]);
  assertEquals(rx.mode, MODE.RX_CONTINUOUS);
});

Deno.test("sx127x: an implicit-header receiver needs the same length, CR and CRC; inverted I/Q must match", () => {
  const r = loraAir({ tx: { x: 0, y: 0 }, rx: { x: 30, y: 0 } });
  const tx = r.chip("tx");
  const rx = r.chip("rx");
  writeReg(rx, REG.OP_MODE, 0x80);
  writeReg(tx, REG.OP_MODE, 0x80);
  writeReg(rx, REG.MODEM_CONFIG_1, 0x73); // implicit header
  writeReg(tx, REG.MODEM_CONFIG_1, 0x73);
  writeReg(rx, REG.PAYLOAD_LENGTH, 4);
  writeReg(rx, REG.OP_MODE, 0x80 | MODE.RX_CONTINUOUS);
  loraSend(tx, [1, 2, 3]);
  r.clock.advanceBy(60);
  loraSend(tx, [1, 2, 3, 4]);
  r.clock.advanceBy(60);
  writeReg(tx, REG.INVERT_IQ, 0x26); // InvertIQ-TX on (inverted logic)
  loraSend(tx, [1, 2, 3, 4]);
  r.clock.advanceBy(60);
  const drops = r.log.events.flatMap((e) => (e.type === "drop" ? [e.reason] : []));
  assertEquals(drops, ["phy_mismatch", "phy_mismatch"]);
  assertEquals(rx.peek(REG.RX_NB_BYTES), 4, "only the frame of the expected length arrived");
});

// ── nRF24L01+: registers, FIFOs, ACK payloads ───────────────────────────────

Deno.test("nrf24: unselected answers 0xff; STATUS on the first byte; 5-byte and 1-byte register reads", () => {
  const r = nrfAir({ a: { x: 0, y: 0 } });
  const chip = r.chip("a");
  assertEquals(chip.transfer(NRF_CMD.NOP), 0xff);
  assertEquals(nrfCmd(chip, NRF_CMD.NOP), [0x0e]);
  assertEquals(nrfCmd(chip, NRF_CMD.R_REGISTER | NRF_REG.RX_ADDR_P1, 0, 0, 0, 0, 0, 0), [
    0x0e,
    0xc2,
    0xc2,
    0xc2,
    0xc2,
    0xc2,
    0,
  ]);
  assertEquals(nrfCmd(chip, NRF_CMD.R_REGISTER | NRF_REG.CONFIG, 0, 0), [0x0e, 0x08, 0]);
  assertEquals(nrfCmd(chip, NRF_CMD.R_REGISTER | NRF_REG.STATUS, 0), [0x0e, 0x0e]);
  assertEquals(nrfCmd(chip, NRF_CMD.R_REGISTER | NRF_REG.FIFO_STATUS, 0), [0x0e, 0x11]);
  assertEquals(nrfCmd(chip, NRF_CMD.R_RX_PL_WID, 0), [0x0e, 0], "empty RX FIFO");
  assertEquals(nrfCmd(chip, NRF_CMD.R_RX_PAYLOAD, 0, 0), [0x0e, 0, 0]);
  assertEquals(chip.rxCount, 0);
});

Deno.test("nrf24: read-only registers ignore writes, RF_CH keeps 7 bits, CONT_WAVE is warned", () => {
  const r = nrfAir({ a: { x: 0, y: 0 } });
  const chip = r.chip("a");
  nrfWrite(chip, NRF_REG.OBSERVE_TX, 0x55);
  nrfWrite(chip, NRF_REG.RPD, 1);
  nrfWrite(chip, NRF_REG.FIFO_STATUS, 0);
  assertEquals([
    chip.peek(NRF_REG.OBSERVE_TX),
    chip.peek(NRF_REG.RPD),
    chip.peek(NRF_REG.FIFO_STATUS),
  ], [0, 0, 0x11]);
  nrfWrite(chip, NRF_REG.RF_CH, 0xff);
  assertEquals(chip.peek(NRF_REG.RF_CH), 0x7f);
  nrfWrite(chip, NRF_REG.RF_SETUP, 0x80 | 0x0e);
  nrfWrite(chip, NRF_REG.RF_SETUP, 0x80 | 0x0e);
  assertEquals(r.warnings.filter((w) => w.includes("CONT_WAVE")).length, 1);
  nrfWrite(chip, 0x1e, 0x42);
  assertEquals(chip.peek(0x1e), 0, "past FEATURE nothing is stored");
  nrfCmd(chip, NRF_CMD.W_REGISTER | NRF_REG.EN_AA);
  assertEquals(chip.peek(NRF_REG.EN_AA), 0x3f, "a write with no data byte changes nothing");
  nrfCmd(chip, NRF_CMD.ACTIVATE, 0x73);
  assertEquals(chip.state, "power_down");
});

Deno.test("nrf24: the TX FIFO holds three payloads, sets TX_FULL, and FLUSH_TX empties it", () => {
  const r = nrfAir({ a: { x: 0, y: 0 } });
  const chip = r.chip("a");
  for (let i = 0; i < 4; i++) nrfCmd(chip, NRF_CMD.W_TX_PAYLOAD, i);
  nrfCmd(chip, NRF_CMD.W_TX_PAYLOAD);
  assertEquals(chip.txCount, 3, "the fourth and an empty one are not taken");
  assertEquals(nrfCmd(chip, NRF_CMD.NOP)[0]! & 0x01, 1, "STATUS TX_FULL");
  assertEquals(nrfCmd(chip, NRF_CMD.R_REGISTER | NRF_REG.FIFO_STATUS, 0)[1], 0x21);
  nrfCmd(chip, NRF_CMD.FLUSH_TX);
  assertEquals(chip.txCount, 0);
  nrfCmd(chip, NRF_CMD.W_ACK_PAYLOAD | 1, 9, 9);
  assertEquals(chip.txCount, 1, "an ACK payload sits in the TX FIFO too");
});

Deno.test("nrf24: powering down cancels a transmission in progress", () => {
  const r = nrfAir({ a: { x: 0, y: 0 } });
  const chip = r.chip("a");
  nrfWrite(chip, NRF_REG.CONFIG, 0x0e);
  nrfCmd(chip, NRF_CMD.W_TX_PAYLOAD, 1, 2, 3);
  chip.pinChanged(NRF_PINS.ce, 1);
  assertEquals(chip.state, "tx_settle");
  nrfWrite(chip, NRF_REG.CONFIG, 0x0c);
  assertEquals(chip.state, "power_down");
  r.clock.advanceBy(10);
  assertEquals(r.log.events.filter((e) => e.type === "tx").length, 0);
});

Deno.test("nrf24: an ACK payload rides back on the ACK, and the sender's RX FIFO gets it", () => {
  const r = nrfAir({ tx: { x: 0, y: 0 }, rx: { x: 5, y: 0 } });
  const tx = r.chip("tx");
  const rx = r.chip("rx");
  for (const chip of [tx, rx]) {
    nrfWrite(chip, NRF_REG.FEATURE, 0x06); // EN_DPL, EN_ACK_PAY
    nrfWrite(chip, NRF_REG.DYNPD, 0x01);
  }
  nrfSetup(rx, "rx");
  nrfSetup(tx, "tx");
  nrfCmd(rx, NRF_CMD.W_ACK_PAYLOAD | 0, 0xaa, 0xbb);
  r.clock.advanceBy(1);
  nrfCmd(tx, NRF_CMD.W_TX_PAYLOAD, 1, 2, 3, 4, 5);
  tx.pinChanged(NRF_PINS.ce, 1);
  r.clock.advanceBy(5);
  assertEquals(rx.rxCount, 1);
  assertEquals(nrfCmd(rx, NRF_CMD.R_RX_PL_WID, 0)[1], 5, "dynamic payload length");
  assertEquals(rx.txCount, 0, "the ACK payload left with the ACK");
  assertEquals(tx.rxCount, 1);
  assertEquals(nrfCmd(tx, NRF_CMD.R_RX_PAYLOAD, 0, 0).slice(1), [0xaa, 0xbb]);
  assertEquals(tx.rxCount, 0, "reading a payload pops it");
  const status = nrfCmd(tx, NRF_CMD.NOP)[0]!;
  assertEquals(status & 0x60, 0x60, "TX_DS and RX_DR");
  nrfWrite(tx, NRF_REG.STATUS, 0x70);
  assertEquals(nrfCmd(tx, NRF_CMD.NOP)[0]! & 0x70, 0);
});

Deno.test("nrf24: REUSE_TX_PL sends the last payload again; a full RX FIFO takes nothing and sends no ACK", () => {
  const r = nrfAir({ tx: { x: 0, y: 0 }, rx: { x: 5, y: 0 } });
  const tx = r.chip("tx");
  const rx = r.chip("rx");
  nrfSetup(rx, "rx");
  nrfSetup(tx, "tx");
  nrfWrite(tx, NRF_REG.SETUP_RETR, 0x01); // one retransmit
  r.clock.advanceBy(1);
  tx.pinChanged(NRF_PINS.ce, 1);
  nrfCmd(tx, NRF_CMD.REUSE_TX_PL);
  assertEquals(tx.state, "standby", "nothing to reuse yet");
  for (let i = 1; i <= 3; i++) {
    nrfCmd(tx, NRF_CMD.W_TX_PAYLOAD, i, i, i);
    r.clock.advanceBy(3);
    nrfWrite(tx, NRF_REG.STATUS, 0x70);
  }
  assertEquals(rx.rxCount, 3);
  assertEquals(nrfCmd(rx, NRF_CMD.R_REGISTER | NRF_REG.FIFO_STATUS, 0)[1]! & 0x02, 0x02, "RX_FULL");
  nrfCmd(tx, NRF_CMD.REUSE_TX_PL);
  r.clock.advanceBy(5);
  assert(nrfCmd(tx, NRF_CMD.NOP)[0]! & 0x10, "no ACK from a full receiver: MAX_RT");
  assertEquals(rx.rxCount, 3);
  assert(nrfCmd(tx, NRF_CMD.R_REGISTER | NRF_REG.FIFO_STATUS, 0)[1]! & 0x40, "TX_REUSE");
  nrfCmd(rx, NRF_CMD.FLUSH_RX);
  assertEquals(rx.rxCount, 0);
  assertEquals(
    nrfCmd(tx, NRF_CMD.R_REGISTER | NRF_REG.OBSERVE_TX, 0)[1],
    0x11,
    "one lost packet, one retransmit",
  );
});

// ── spi-link: protocol ──────────────────────────────────────────────────────

Deno.test("spi-link protocol: encode refuses values that are not bytes", () => {
  for (const bad of [-1, 256, 1.5, Number.NaN]) {
    assertThrows(() => encode({ op: "xfer", mosi: bad }), RangeError, "mosi must be a byte");
    assertThrows(() => encode({ op: "miso", miso: bad }), RangeError, "miso must be a byte");
    assertThrows(
      () => encode({ op: "pin", gpio: bad, level: 1 }),
      RangeError,
      "gpio must be a byte",
    );
    assertThrows(
      () => encode({ op: "drive", gpio: bad, level: 0 }),
      RangeError,
      "gpio must be a byte",
    );
  }
  assertEquals(Array.from(encode({ op: "drive", gpio: 26, level: 1 })), [OP_DRIVE, 26, 1]);
});

Deno.test("spi-link protocol: messages split anywhere reassemble; an unknown op or level is corrupt", () => {
  const stream = Uint8Array.of(OP_XFER, 0x42, OP_PIN, 5, 0, OP_MISO, 0x99, OP_DRIVE, 26, 1);
  for (const size of [1, 2, 3, 10]) {
    const decoder = new MessageDecoder();
    const out = [];
    for (let i = 0; i < stream.length; i += size) {
      out.push(...decoder.push(stream.subarray(i, i + size)));
    }
    assertEquals(out, [
      { op: "xfer", mosi: 0x42 },
      { op: "pin", gpio: 5, level: 0 },
      { op: "miso", miso: 0x99 },
      { op: "drive", gpio: 26, level: 1 },
    ], `chunk size ${size}`);
  }
  assertThrows(
    () => new MessageDecoder().push(Uint8Array.of(0x05)),
    ProtocolError,
    "unknown message 0x5",
  );
  assertThrows(
    () => new MessageDecoder().push(Uint8Array.of(OP_PIN, 5, 2)),
    ProtocolError,
    "pin level 2",
  );
  assertThrows(
    () => new MessageDecoder().push(Uint8Array.of(OP_DRIVE, 5, 0xff)),
    ProtocolError,
    "pin level 255",
  );
  assertEquals(new MessageDecoder().push(Uint8Array.of(OP_PIN, 5)), [], "half a message waits");
});

Deno.test("spi-link: the worker config always watches the chip select, once", () => {
  assertEquals(workerRadioSpiConfig(4000, 5, [14, 5, 14]), {
    radio_spi: { port: 4000, cs: 5, watch: [5, 14] },
  });
});

// ── spi-link: adapter and client over real sockets ──────────────────────────

async function readExactly(conn: Deno.Conn, n: number): Promise<number[]> {
  const out: number[] = [];
  const buffer = new Uint8Array(64);
  while (out.length < n) {
    const got = await conn.read(buffer);
    if (got === null) throw new Error(`connection closed after ${out.length} of ${n} bytes`);
    out.push(...buffer.subarray(0, got));
  }
  return out;
}

function invertingDevice(
  pins: [number, Level][],
): (drive: PinDriver) => SpiDevice & { drive: PinDriver } {
  return (drive) => ({
    drive,
    pinChanged: (gpio, level) => void pins.push([gpio, level]),
    transfer: (mosi) => mosi ^ 0xff,
  });
}

Deno.test("spi-link adapter: answers every XFER of one write in one reply, moves pins, drives the board", async () => {
  const problems: string[] = [];
  const adapter = new SpiLinkAdapter((node, message) => problems.push(`${node}: ${message}`));
  const pins: [number, Level][] = [];
  const attachment = adapter.listen("n", invertingDevice(pins));
  assertThrows(() => adapter.listen("n", invertingDevice(pins)), Error, '"n" is already attached');
  await assertRejects(() => adapter.waitConnected("zz", 10), Error, '"zz" is not attached');
  assertEquals(adapter.isConnected("n"), false);
  attachment.device.drive(26, 1); // no board yet: dropped
  const conn = await Deno.connect({ hostname: "127.0.0.1", port: attachment.port });
  try {
    await adapter.waitConnected("n", 2000);
    assertEquals(adapter.isConnected("n"), true);
    await conn.write(Uint8Array.of(OP_XFER, 0x0f, OP_PIN, 5, 0, OP_XFER, 0xf0));
    assertEquals(await readExactly(conn, 4), [OP_MISO, 0xf0, OP_MISO, 0x0f]);
    assertEquals(pins, [[5, 0]]);
    attachment.device.drive(26, 0);
    assertEquals(
      await readExactly(conn, 3),
      [OP_DRIVE, 26, 0],
      "only the drive made after connecting",
    );
    // A board that sends what only the engine sends is cut off.
    await conn.write(Uint8Array.of(OP_MISO, 0));
    const buffer = new Uint8Array(8);
    assertEquals(await conn.read(buffer), null);
    assertEquals(problems.length, 1);
    assert(problems[0]!.includes("only the engine sends"), problems[0]);
    await until(() => !adapter.isConnected("n"), "the adapter to drop the board");
  } finally {
    conn.close();
    await adapter.close();
  }
  assertThrows(() => adapter.listen("m", invertingDevice(pins)), Error, "adapter is closed");
});

Deno.test("spi-link client: transfers, drives, and a closed link fails later transfers", async () => {
  const adapter = new SpiLinkAdapter();
  const attachment = adapter.listen("n", invertingDevice([]));
  const client = await SpiLinkClient.connect(attachment.port);
  try {
    const drives: [number, Level][] = [];
    client.onDrive((gpio, level) => drives.push([gpio, level]));
    await adapter.waitConnected("n", 2000);
    await client.digitalWrite(5, 0);
    assertEquals(await client.transfer(0x12), 0xed);
    attachment.device.drive(26, 1);
    await until(() => drives.length === 1, "the DRIVE message");
    assertEquals(drives, [[26, 1]]);
    await adapter.close();
    await client.close(); // waits for the read loop to see the end of the link
    await assertRejects(() => client.transfer(1), Error, "spi-link connection closed");
    await assertRejects(() => client.digitalWrite(5, 1), Error, "spi-link connection closed");
  } finally {
    await client.close(); // a second close finds the socket already closed and still settles
    await adapter.close();
  }
});

Deno.test("spi-link client: a MISO that came early is kept; a transfer pending at close reads a floating 0xff", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const client = await SpiLinkClient.connect((listener.addr as Deno.NetAddr).port);
  const server = await listener.accept();
  try {
    let driven = false;
    client.onDrive(() => (driven = true));
    await server.write(Uint8Array.of(OP_MISO, 0x42, OP_DRIVE, 7, 1));
    await until(() => driven, "the DRIVE after the early MISO");
    assertEquals(await client.transfer(5), 0x42);
    assertEquals(await readExactly(server, 2), [OP_XFER, 5]);
    const pending = client.transfer(6);
    assertEquals(await readExactly(server, 2), [OP_XFER, 6]);
    server.close();
    assertEquals(await pending, 0xff);
  } finally {
    try {
      server.close();
    } catch {
      // Closed above on the normal path.
    }
    listener.close();
    await client.close();
  }
});

// ── loopback ports ──────────────────────────────────────────────────────────

Deno.test("loopback ports: a handler that throws a non-Error is reported with its text and cut off", async () => {
  const problems: string[] = [];
  const ports = new LoopbackPorts((node, message) => problems.push(`${node}: ${message}`));
  const port = ports.listen("n", () => () => {
    throw "not an Error";
  });
  ports.send("zz", Uint8Array.of(1)); // unknown node: nothing to do
  ports.send("n", Uint8Array.of(1)); // no board yet: dropped
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    await ports.waitConnected("n", 2000);
    await conn.write(Uint8Array.of(1));
    assertEquals(await conn.read(new Uint8Array(4)), null);
    assertEquals(problems, ["n: not an Error"]);
    await until(() => !ports.isConnected("n"), "the port to forget the board");
    assertEquals(ports.isConnected("zz"), false);
  } finally {
    conn.close();
    await ports.close();
  }
  assertThrows(() => ports.listen("m", () => () => {}), Error, "adapter is closed");
});

Deno.test("loopback ports: a board that vanishes mid-write is not reported as a problem", async () => {
  const problems: string[] = [];
  const ports = new LoopbackPorts((_node, message) => problems.push(message));
  const port = ports.listen("n", () => () => {});
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  await ports.waitConnected("n", 2000);
  conn.close();
  await until(() => !ports.isConnected("n"), "the read loop to see the close");
  ports.send("n", new Uint8Array(1 << 16));
  await ports.close();
  assertEquals(problems, []);
});

// ── qemu-wifi-l2 framing at its limits ──────────────────────────────────────

Deno.test("framing: a frame of exactly the maximum size passes, a prefix split before its body waits", () => {
  const max = new Uint8Array(MAX_FRAME_BYTES).fill(7);
  const encoded = encodeFrame(max);
  const decoder = new FrameDecoder();
  assertEquals(decoder.push(encoded.subarray(0, 2)), []);
  assertEquals(decoder.push(encoded.subarray(2, 4)), []);
  const frames = decoder.push(encoded.subarray(4));
  assertEquals(frames.length, 1);
  assertEquals(frames[0]!.length, MAX_FRAME_BYTES);
  const mixed = new FrameDecoder().push(
    Uint8Array.from([...encodeFrame(new Uint8Array(0)), ...encodeFrame(Uint8Array.of(1))]),
  );
  assertEquals(mixed.map((f) => Array.from(f)), [[1]], "an empty frame between frames is skipped");
  assertEquals(Array.from(encodeFrame(new Uint8Array(0))), [0, 0, 0, 0]);
  assertThrows(
    () => new FrameDecoder().push(Uint8Array.of(0, 1, 0, 0)),
    FramingError,
    "exceeds 65535",
  );
});

// ── ble-hci: H4 and HCI helpers ─────────────────────────────────────────────

Deno.test("hci: parameters over 255 bytes cannot be encoded in a command or an event", () => {
  assertThrows(
    () => encodeHci({ type: "command", opcode: OP.reset, params: new Uint8Array(256) }),
    RangeError,
    "command parameters",
  );
  assertThrows(
    () => encodeHci({ type: "event", code: EVT.commandComplete, params: new Uint8Array(256) }),
    RangeError,
    "event parameters",
  );
  assertEquals(
    encodeHci({ type: "command", opcode: OP.reset, params: new Uint8Array(255) }).length,
    259,
  );
});

Deno.test("hci: ACL keeps a 12-bit handle, 2-bit PB flag and a 16-bit length through the decoder", () => {
  const data = new Uint8Array(300).fill(3);
  const bytes = encodeHci({ type: "acl", handle: 0xfabc, pb: 6, data });
  assertEquals(Array.from(bytes.subarray(0, 5)), [H4_ACL, 0xbc, 0x2a, 0x2c, 0x01]);
  const decoder = new H4Decoder();
  assertEquals(decoder.push(bytes.subarray(0, 4)), [], "header incomplete");
  assertEquals(decoder.push(bytes.subarray(4, 100)), [], "body incomplete");
  const [packet] = decoder.push(bytes.subarray(100));
  assert(packet?.type === "acl");
  assertEquals([packet.handle, packet.pb, packet.data.length], [0xabc, 2, 300]);
});

Deno.test("hci: a stream that is not H4 is refused, naming the byte", () => {
  assertThrows(() => new H4Decoder().push(Uint8Array.of(0x07)), HciProtocolError, "indicator 0x07");
  const decoder = new H4Decoder();
  const packets = decoder.push(Uint8Array.of(H4_EVENT, 0x0e, 0, H4_COMMAND, 0x03, 0x0c, 0));
  assertEquals(packets.map((p) => p.type), ["event", "command"]);
  assertThrows(() => decoder.push(Uint8Array.of(0x00)), HciProtocolError, "indicator 0x00");
});

Deno.test("hci: device addresses go over the air least significant byte first, and must have six hex octets", () => {
  assertEquals(Array.from(addressToBytes("02:68:7A:62:01:05")), [
    0x05,
    0x01,
    0x62,
    0x7a,
    0x68,
    0x02,
  ]);
  assertEquals(addressToString(Uint8Array.of(5, 1, 0x62, 0x7a, 0x68, 2, 9)), "02:68:7a:62:01:05");
  for (const bad of ["02:68:7a:62:01", "02:68:7a:62:01:0g", "2:68:7a:62:01:05", ""]) {
    assertThrows(() => addressToBytes(bad), RangeError, "not a Bluetooth device address", bad);
  }
  assertEquals(readU16(Uint8Array.of(0x34), 0), 0x34, "a missing high byte reads as 0");
  assertEquals(readU16(Uint8Array.of(), 4), 0);
  assertEquals(u16(0x12345), [0x45, 0x23]);
});

Deno.test("hci: the supported-commands bitmap sets exactly the listed bits", () => {
  const bitmap = supportedCommands();
  const set = Array.from(bitmap).reduce((n, b) => n + b.toString(2).replaceAll("0", "").length, 0);
  assertEquals(set, SUPPORTED_COMMAND_BITS.length);
  assertEquals(bitmap[5], 0xc0, "Set Event Mask and Reset");
});

// ── ble-hci: link-layer PDUs ────────────────────────────────────────────────

Deno.test("ll: advertising PDU header bits round-trip, a length that disagrees is refused", () => {
  for (
    const [txRandom, rxRandom] of [[false, false], [true, false], [false, true], [
      true,
      true,
    ]] as const
  ) {
    const pdu = { type: ADV_PDU.scanReq, txRandom, rxRandom, payload: Uint8Array.of(1, 2, 3) };
    assertEquals(parseAdvPdu(encodeAdvPdu(pdu)), pdu);
  }
  assertEquals(
    encodeAdvPdu({ type: 0x1f, txRandom: false, rxRandom: false, payload: new Uint8Array(0) })[0],
    0x0f,
    "type is 4 bits",
  );
  assertEquals(parseAdvPdu(Uint8Array.of(0)), null, "no length byte");
  assertEquals(parseAdvPdu(Uint8Array.of(0, 2, 1)), null, "shorter than its length");
  assertEquals(parseAdvPdu(Uint8Array.of(0, 0, 1)), null, "longer than its length");
});

Deno.test("ll: CONNECT_IND carries every parameter and the channel map; any other length is not one", () => {
  const params = {
    accessAddress: 0x8e89bed7 ^ 0x12345678,
    crcInit: 0xabcdef,
    winSize: 2,
    winOffset: 3,
    interval: 24,
    latency: 1,
    timeout: 100,
    channelMap: [0, 1, 9, 17, 36],
    hop: 9,
    sca: 5,
  };
  const initA = Uint8Array.of(1, 2, 3, 4, 5, 6);
  const advA = Uint8Array.of(6, 5, 4, 3, 2, 1);
  const payload = encodeConnectInd(initA, advA, params);
  assertEquals(payload.length, 34);
  assertEquals(parseConnectInd(payload), {
    initA,
    advA,
    params: { ...params, accessAddress: params.accessAddress >>> 0 },
  });
  assertEquals(parseConnectInd(payload.subarray(0, 33)), null);
  assertEquals(parseConnectInd(new Uint8Array(35)), null);
});

Deno.test("ll: data PDU header bits round-trip, a length that disagrees is refused", () => {
  const pdu = {
    llid: LLID.control,
    nesn: 1,
    sn: 0,
    md: true,
    payload: Uint8Array.of(LL_CTRL.versionInd, 8),
  };
  assertEquals(encodeDataPdu(pdu)[0], 0x17);
  assertEquals(parseDataPdu(encodeDataPdu(pdu)), pdu);
  const empty = { llid: LLID.continuation, nesn: 0, sn: 1, md: false, payload: new Uint8Array(0) };
  assertEquals(parseDataPdu(encodeDataPdu(empty)), empty);
  assertEquals(parseDataPdu(Uint8Array.of(1)), null);
  assertEquals(parseDataPdu(Uint8Array.of(1, 1)), null);
});

// ── ble-hci: btsnoop ────────────────────────────────────────────────────────

Deno.test("btsnoop: header, flags per direction and type, time in microseconds since year 0", () => {
  const writer = new BtsnoopWriter(1_000);
  const command = encodeHci({ type: "command", opcode: OP.reset, params: new Uint8Array(0) });
  const event = encodeHci({
    type: "event",
    code: EVT.commandComplete,
    params: Uint8Array.of(1, 3, 0x0c, 0),
  });
  const acl = encodeHci({ type: "acl", handle: 1, pb: 2, data: Uint8Array.of(9) });
  writer.add(0, "host-to-controller", command);
  writer.add(2.5, "controller-to-host", event);
  writer.add(3, "host-to-controller", acl);
  writer.add(4, "controller-to-host", acl);
  writer.add(1, "controller-to-host", event); // earlier than the last: stamped with the later time
  assertEquals(writer.packetCount, 5);
  const bytes = writer.toBytes();
  const view = new DataView(bytes.buffer);
  assertEquals(new TextDecoder().decode(bytes.subarray(0, 8)), "btsnoop\0");
  assertEquals([view.getUint32(8), view.getUint32(12)], [1, 1002]);
  const records: { length: number; flags: number; us: bigint }[] = [];
  let offset = 16;
  while (offset < bytes.length) {
    const length = view.getUint32(offset);
    assertEquals(view.getUint32(offset + 4), length, "original and included lengths match");
    records.push({ length, flags: view.getUint32(offset + 8), us: view.getBigUint64(offset + 16) });
    offset += 24 + length;
  }
  assertEquals(offset, bytes.length);
  assertEquals(records.map((r) => r.flags), [2, 3, 0, 1, 3]);
  assertEquals(records.map((r) => r.length), [
    command.length,
    event.length,
    acl.length,
    acl.length,
    event.length,
  ]);
  const epoch = 0x00dcddb30f2f8000n;
  assertEquals(records.map((r) => r.us - epoch), [
    1_000_000n,
    1_002_500n,
    1_003_000n,
    1_004_000n,
    1_004_000n,
  ]);
});

Deno.test("btsnoop: a packet is copied when added, and an empty capture is only the header", () => {
  assertEquals(new BtsnoopWriter(0).toBytes().length, 16);
  const writer = new BtsnoopWriter(0);
  const packet = Uint8Array.of(H4_EVENT, 0x0e, 0);
  writer.add(0, "controller-to-host", packet);
  packet[1] = 0xff;
  assertEquals(writer.toBytes()[16 + 24 + 1], 0x0e);
});

// ── ble-hci: the adapter over a real socket ─────────────────────────────────

function loneController(toHost: (bytes: Uint8Array) => void, clock = new ManualClock()) {
  return new BleController({
    nodeId: "n",
    address: "02:68:7a:62:01:01",
    txPowerDbm: 0,
    clock,
    log: new EventLog(),
    rng: substream(3, "ble:n"),
    transmit: () => {},
    toHost,
    warn: () => {},
  });
}

Deno.test("ble-hci adapter: a host's command is answered over TCP and both directions are captured", async () => {
  const problems: string[] = [];
  const adapter = new BleHciAdapter(
    () => 5,
    1_700_000_000_000,
    (node, message) => problems.push(`${node}: ${message}`),
  );
  const attachment = adapter.listen("n", (toHost) => loneController(toHost));
  assertEquals(adapter.isConnected("n"), false);
  const conn = await Deno.connect({ hostname: "127.0.0.1", port: attachment.port });
  try {
    await adapter.waitConnected("n", 2000);
    await conn.write(encodeHci({ type: "command", opcode: OP.reset, params: new Uint8Array(0) }));
    assertEquals(await readExactly(conn, 7), [H4_EVENT, EVT.commandComplete, 4, 1, 0x03, 0x0c, 0]);
    assertEquals(attachment.snoop.packetCount, 2);
    // Not H4: the capture skips it, the controller's decoder reports it, the host is cut off.
    await conn.write(Uint8Array.of(0x07));
    assertEquals(await conn.read(new Uint8Array(8)), null);
    assertEquals(problems.length, 1);
    assert(problems[0]!.includes("indicator 0x07"), problems[0]);
    assertEquals(attachment.snoop.packetCount, 2);
    await until(() => !adapter.isConnected("n"), "the adapter to drop the host");
  } finally {
    conn.close();
    await adapter.close();
  }
});

// ── ble-hci: the virtual controller, raw HCI on a manual clock ──────────────

interface HciNode {
  id: string;
  address: string;
  controller: BleController;
  packets: HciPacket[];
  warnings: string[];
  /** Runs on every frame this node puts on the air, before the air sees it. */
  onTransmit: ((frame: AirFrame<BleAirHeader>) => void) | null;
}

function bleAir(positions: Record<string, [number, number]>) {
  const clock = new ManualClock();
  const log = new EventLog();
  const air = new AirMedium({
    seed: 3,
    clock,
    log,
    environment: environmentFromPreset("indoor_office", { shadowingSigmaDb: 0 }),
  });
  const nodes = new Map<string, HciNode>();
  Object.entries(positions).forEach(([id, [x, y]], i) => {
    const decoder = new H4Decoder();
    const node = {
      id,
      address: `02:68:7a:62:01:0${i + 1}`,
      packets: [],
      warnings: [],
      onTransmit: null,
    } as unknown as HciNode;
    node.controller = new BleController({
      nodeId: id,
      address: node.address,
      txPowerDbm: 0,
      clock,
      log,
      rng: substream(3, `ble:${id}`),
      transmit: (frame) => {
        node.onTransmit?.(frame);
        air.transmit(id, frame);
      },
      toHost: (bytes) => node.packets.push(...decoder.push(bytes)),
      warn: (message) => node.warnings.push(message),
    });
    air.addNode({ id, position: { x, y }, antennaGainDbi: 0 }, node.controller);
    nodes.set(id, node);
  });
  return { clock, log, air, node: (id: string) => nodes.get(id)! };
}

function hciCmd(node: HciNode, op: number, params: ArrayLike<number> = []): void {
  node.controller.fromHost(
    encodeHci({ type: "command", opcode: op, params: Uint8Array.from(params) }),
  );
}

const events = (node: HciNode, code: number) =>
  node.packets.flatMap((p) => (p.type === "event" && p.code === code ? [p.params] : []));

/** Status and return parameters of the last Command Complete for `op`. */
function completed(node: HciNode, op: number): number[] {
  const all = events(node, EVT.commandComplete).filter((p) => readU16(p, 1) === op);
  const last = all[all.length - 1];
  if (!last) throw new Error(`no Command Complete for 0x${op.toString(16)}`);
  return Array.from(last.subarray(3));
}

function statusOf(node: HciNode, op: number): number {
  const all = events(node, EVT.commandStatus).filter((p) => readU16(p, 2) === op);
  const last = all[all.length - 1];
  if (!last) throw new Error(`no Command Status for 0x${op.toString(16)}`);
  return last[0]!;
}

const leMeta = (node: HciNode, subevent: number) =>
  events(node, EVT.leMeta).filter((p) => p[0] === subevent).map((p) => Array.from(p.subarray(1)));

const advParams = (
  o: {
    intervalUnits?: number;
    type?: number;
    ownType?: number;
    channelMap?: number;
    filter?: number;
  } = {},
) => [
  ...u16(o.intervalUnits ?? 64),
  ...u16(o.intervalUnits ?? 64),
  o.type ?? 0,
  o.ownType ?? 0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  o.channelMap ?? 7,
  o.filter ?? 0,
];

function createConnectionParams(
  peer: string,
  o: { acceptList?: boolean; intervalUnits?: number; timeoutUnits?: number; window?: number } = {},
) {
  return [
    ...u16(16),
    ...u16(o.window ?? 16),
    o.acceptList ? 1 : 0,
    0,
    ...addressToBytes(peer),
    0,
    ...u16(o.intervalUnits ?? 24),
    ...u16(o.intervalUnits ?? 24),
    ...u16(0),
    ...u16(o.timeoutUnits ?? 100),
    ...u16(0),
    ...u16(0),
  ];
}

/** `gw` connects to the advertising `sensor`; returns both handles. */
function bleConnect(r: ReturnType<typeof bleAir>, timeoutUnits = 100) {
  const gw = r.node("gw");
  const sensor = r.node("sensor");
  hciCmd(sensor, OP.leSetAdvParams, advParams());
  hciCmd(sensor, OP.leSetAdvEnable, [1]);
  hciCmd(gw, OP.leCreateConnection, createConnectionParams(sensor.address, { timeoutUnits }));
  r.clock.advanceBy(300);
  const gwUp = leMeta(gw, LE_SUBEVENT.connectionComplete);
  const sensorUp = leMeta(sensor, LE_SUBEVENT.connectionComplete);
  assertEquals(gwUp.length, 1, "the central connected");
  assertEquals(sensorUp.length, 1, "the peripheral connected");
  assertEquals(
    [gwUp[0]![0], gwUp[0]![3], sensorUp[0]![3]],
    [0, 0, 1],
    "status, central, peripheral",
  );
  return {
    gw,
    sensor,
    gwHandle: readU16(Uint8Array.from(gwUp[0]!), 1),
    sensorHandle: readU16(Uint8Array.from(sensorUp[0]!), 1),
  };
}

const disconnections = (node: HciNode) =>
  events(node, EVT.disconnectionComplete).map((p) => ({ handle: readU16(p, 1), reason: p[3] }));

Deno.test("ble controller: a command one byte short of its parameters is answered 'invalid parameters'", () => {
  const node = bleAir({ a: [0, 0] }).node("a");
  const minimum: [number, number, "status" | "complete"][] = [
    [OP.disconnect, 3, "status"],
    [OP.readRemoteVersion, 2, "status"],
    [OP.leCreateConnection, 25, "status"],
    [OP.leConnectionUpdate, 14, "status"],
    [OP.leReadRemoteFeatures, 2, "status"],
    [OP.setEventMask, 8, "complete"],
    [OP.setControllerToHostFlowControl, 1, "complete"],
    [OP.hostBufferSize, 7, "complete"],
    [OP.setEventMaskPage2, 8, "complete"],
    [OP.writeLeHostSupport, 2, "complete"],
    [OP.readLocalExtendedFeatures, 1, "complete"],
    [OP.readRssi, 2, "complete"],
    [OP.leSetEventMask, 8, "complete"],
    [OP.leSetRandomAddress, 6, "complete"],
    [OP.leSetAdvParams, 15, "complete"],
    [OP.leSetAdvData, 1, "complete"],
    [OP.leSetScanRspData, 1, "complete"],
    [OP.leSetAdvEnable, 1, "complete"],
    [OP.leSetScanParams, 7, "complete"],
    [OP.leSetScanEnable, 2, "complete"],
    [OP.leAddToAcceptList, 7, "complete"],
    [OP.leRemoveFromAcceptList, 7, "complete"],
    [OP.leEncrypt, 32, "complete"],
  ];
  for (const [op, length, kind] of minimum) {
    hciCmd(node, op, new Uint8Array(length - 1));
    const status = kind === "status" ? statusOf(node, op) : completed(node, op)[0];
    assertEquals(status, STATUS.invalidParameters, `0x${op.toString(16)}`);
  }
  // Host Number Of Completed Packets has no event at all.
  const before = node.packets.length;
  hciCmd(node, OP.hostNumberOfCompletedPackets, [1, 1, 0, 1, 0]);
  assertEquals(node.packets.length, before);
});

Deno.test("ble controller: local reads report version, features, buffers, address and LE host support", () => {
  const node = bleAir({ a: [0, 0] }).node("a");
  hciCmd(node, OP.readLocalVersion);
  assertEquals(completed(node, OP.readLocalVersion), [0, 8, 0, 0, 8, 0xff, 0xff, 1, 0]);
  hciCmd(node, OP.readLocalFeatures);
  assertEquals(completed(node, OP.readLocalFeatures), [0, 0, 0, 0, 0, 0x60, 0, 0, 0]);
  hciCmd(node, OP.readLocalExtendedFeatures, [0]);
  assertEquals(completed(node, OP.readLocalExtendedFeatures).slice(0, 3), [0, 0, 1]);
  hciCmd(node, OP.readLocalExtendedFeatures, [1]);
  assertEquals(completed(node, OP.readLocalExtendedFeatures)[3], 0, "LE host not supported yet");
  hciCmd(node, OP.writeLeHostSupport, [1, 0]);
  hciCmd(node, OP.readLocalExtendedFeatures, [1]);
  assertEquals(completed(node, OP.readLocalExtendedFeatures)[3], 2, "LE Supported (Host)");
  hciCmd(node, OP.readLocalExtendedFeatures, [2]);
  assertEquals(completed(node, OP.readLocalExtendedFeatures).slice(0, 3), [
    STATUS.invalidParameters,
    2,
    1,
  ]);
  hciCmd(node, OP.readLeHostSupport);
  assertEquals(completed(node, OP.readLeHostSupport), [0, 1, 0]);
  hciCmd(node, OP.readBufferSize);
  assertEquals(completed(node, OP.readBufferSize), [0, 27, 0, 0, 10, 0, 0, 0]);
  hciCmd(node, OP.leReadBufferSize);
  assertEquals(completed(node, OP.leReadBufferSize), [0, 27, 0, 10]);
  hciCmd(node, OP.readBdAddr);
  assertEquals(completed(node, OP.readBdAddr), [0, ...addressToBytes(node.address)]);
  hciCmd(node, OP.leReadLocalFeatures);
  assertEquals(completed(node, OP.leReadLocalFeatures), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  hciCmd(node, OP.leReadSupportedStates);
  assertEquals(completed(node, OP.leReadSupportedStates), [
    0,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0x03,
    0,
    0,
  ]);
  hciCmd(node, OP.leReadAdvTxPower);
  assertEquals(completed(node, OP.leReadAdvTxPower), [0, 0]);
  hciCmd(node, OP.leReadAcceptListSize);
  assertEquals(completed(node, OP.leReadAcceptListSize), [0, 8]);
  for (const op of [OP.setEventMask, OP.setEventMaskPage2, OP.leSetEventMask]) {
    hciCmd(node, op, new Uint8Array(8));
    assertEquals(completed(node, op), [0]);
  }
  hciCmd(node, OP.reset);
  hciCmd(node, OP.readLeHostSupport);
  assertEquals(completed(node, OP.readLeHostSupport), [0, 0, 0], "Reset clears LE host support");
});

Deno.test("ble controller: LE Rand draws 8 bytes, LE Encrypt is AES-128 with HCI's byte order", async () => {
  const node = bleAir({ a: [0, 0] }).node("a");
  hciCmd(node, OP.leRand);
  hciCmd(node, OP.leRand);
  const draws = events(node, EVT.commandComplete).map((p) => Array.from(p.subarray(4)));
  assertEquals(draws.map((d) => d.length), [8, 8]);
  assert(draws[0]!.join() !== draws[1]!.join());
  // FIPS-197 appendix C.1: key 000102...0f, plaintext 00112233...ff.
  const key = Array.from({ length: 16 }, (_, i) => i).reverse();
  const plain = Array.from({ length: 16 }, (_, i) => i * 0x11).reverse();
  hciCmd(node, OP.leEncrypt, [...key, ...plain]);
  await until(
    () => events(node, EVT.commandComplete).some((p) => readU16(p, 1) === OP.leEncrypt),
    "LE Encrypt",
  );
  const hex = completed(node, OP.leEncrypt).slice(1).reverse().map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  assertEquals(hex, "69c4e0d86a7b0430d8cdb78070b4c55a");
});

Deno.test("ble controller: unknown commands, host events and ACL on no connection are warned once each", () => {
  const node = bleAir({ a: [0, 0] }).node("a");
  hciCmd(node, 0xfc01);
  hciCmd(node, 0xfc01);
  assertEquals(completed(node, 0xfc01), [STATUS.unknownCommand]);
  node.controller.fromHost(encodeHci({ type: "event", code: 0x0e, params: Uint8Array.of(1) }));
  node.controller.fromHost(encodeHci({ type: "event", code: 0x0e, params: Uint8Array.of(1) }));
  node.controller.fromHost(encodeHci({ type: "acl", handle: 7, pb: 2, data: Uint8Array.of(1) }));
  node.controller.fromHost(encodeHci({ type: "acl", handle: 7, pb: 2, data: Uint8Array.of(1) }));
  node.controller.fromHost(encodeHci({ type: "acl", handle: 8, pb: 2, data: Uint8Array.of(1) }));
  assertEquals(node.warnings.length, 4, node.warnings.join("; "));
  assert(node.warnings[1]!.includes("HCI event"));
  assert(node.warnings[2]!.includes("handle 0x7"));
  assert(node.warnings[3]!.includes("handle 0x8"));
  hciCmd(node, OP.readRssi, [9, 0]);
  assertEquals(completed(node, OP.readRssi), [STATUS.unknownConnection, 9, 0, 0]);
  hciCmd(node, OP.disconnect, [9, 0, 0x13]);
  assertEquals(statusOf(node, OP.disconnect), STATUS.unknownConnection);
  hciCmd(node, OP.readRemoteVersion, [9, 0]);
  assertEquals(statusOf(node, OP.readRemoteVersion), STATUS.unknownConnection);
  hciCmd(node, OP.leReadRemoteFeatures, [9, 0]);
  assertEquals(statusOf(node, OP.leReadRemoteFeatures), STATUS.unknownConnection);
  hciCmd(node, OP.leConnectionUpdate, [9, 0, 24, 0, 24, 0, 0, 0, 100, 0, 0, 0, 0, 0]);
  assertEquals(statusOf(node, OP.leConnectionUpdate), STATUS.unknownConnection);
});

Deno.test("ble controller: advertising parameters refuse directed, reserved types and changes while on", () => {
  const node = bleAir({ a: [0, 0] }).node("a");
  hciCmd(node, OP.leSetAdvParams, advParams({ type: 1 }));
  assertEquals(completed(node, OP.leSetAdvParams), [STATUS.unsupportedParameter]);
  hciCmd(node, OP.leSetAdvParams, advParams({ type: 4 }));
  assertEquals(completed(node, OP.leSetAdvParams), [STATUS.unsupportedParameter]);
  assertEquals(node.warnings.filter((w) => w.includes("directed")).length, 1);
  hciCmd(node, OP.leSetAdvParams, advParams({ type: 5 }));
  assertEquals(completed(node, OP.leSetAdvParams), [STATUS.invalidParameters]);
  hciCmd(node, OP.leSetAdvParams, advParams({ ownType: 2 }));
  assertEquals(completed(node, OP.leSetAdvParams), [0]);
  assert(node.warnings.some((w) => w.includes("resolvable private")));
  hciCmd(node, OP.leSetAdvEnable, [1]);
  assertEquals(completed(node, OP.leSetAdvEnable), [0]);
  hciCmd(node, OP.leSetAdvEnable, [1]);
  assertEquals(completed(node, OP.leSetAdvEnable), [0], "enabling twice is fine");
  hciCmd(node, OP.leSetAdvParams, advParams());
  assertEquals(completed(node, OP.leSetAdvParams), [STATUS.commandDisallowed]);
  hciCmd(node, OP.leSetAdvEnable, [0]);
  hciCmd(node, OP.leSetAdvParams, advParams({ ownType: 1 }));
  hciCmd(node, OP.leSetAdvEnable, [1]);
  assertEquals(
    completed(node, OP.leSetAdvEnable),
    [STATUS.invalidParameters],
    "a random address was never set",
  );
  hciCmd(node, OP.leSetAdvParams, advParams({ channelMap: 0 }));
  hciCmd(node, OP.leSetAdvEnable, [1]);
  assertEquals(completed(node, OP.leSetAdvEnable), [STATUS.invalidParameters], "no channel");
});

Deno.test("ble controller: scan and connection parameters are range-checked, one initiator at a time", () => {
  const node = bleAir({ a: [0, 0] }).node("a");
  hciCmd(node, OP.leSetScanParams, [0, ...u16(16), ...u16(0), 0, 0]);
  assertEquals(completed(node, OP.leSetScanParams), [STATUS.invalidParameters], "window 0");
  hciCmd(node, OP.leSetScanParams, [0, ...u16(16), ...u16(32), 0, 0]);
  assertEquals(
    completed(node, OP.leSetScanParams),
    [STATUS.invalidParameters],
    "window over interval",
  );
  hciCmd(node, OP.leSetScanEnable, [1, 0]);
  hciCmd(node, OP.leSetScanParams, [0, ...u16(16), ...u16(16), 0, 0]);
  assertEquals(completed(node, OP.leSetScanParams), [STATUS.commandDisallowed]);
  hciCmd(node, OP.leSetScanEnable, [0, 0]);

  const peer = "02:68:7a:62:01:09";
  for (
    const bad of [{ window: 0 }, { window: 17 }, { intervalUnits: 5 }, { intervalUnits: 3201 }, {
      timeoutUnits: 9,
    }, { timeoutUnits: 3201 }]
  ) {
    hciCmd(node, OP.leCreateConnection, createConnectionParams(peer, bad));
    assertEquals(
      statusOf(node, OP.leCreateConnection),
      STATUS.invalidParameters,
      JSON.stringify(bad),
    );
  }
  hciCmd(node, OP.leCreateConnectionCancel);
  assertEquals(
    completed(node, OP.leCreateConnectionCancel),
    [STATUS.commandDisallowed],
    "nothing to cancel",
  );
  hciCmd(node, OP.leCreateConnection, createConnectionParams(peer));
  assertEquals(statusOf(node, OP.leCreateConnection), 0);
  hciCmd(node, OP.leCreateConnection, createConnectionParams(peer));
  assertEquals(statusOf(node, OP.leCreateConnection), STATUS.commandDisallowed);
  hciCmd(node, OP.leCreateConnectionCancel);
  assertEquals(completed(node, OP.leCreateConnectionCancel), [0]);
  assertEquals(leMeta(node, LE_SUBEVENT.connectionComplete).map((p) => p[0]), [
    STATUS.unknownConnection,
  ]);
});

Deno.test("ble controller: the accept list holds eight devices, then refuses with 'memory capacity exceeded'", () => {
  const node = bleAir({ a: [0, 0] }).node("a");
  for (let i = 0; i < 8; i++) {
    hciCmd(node, OP.leAddToAcceptList, [0, i, 0, 0, 0, 0, 2]);
    assertEquals(completed(node, OP.leAddToAcceptList), [0]);
  }
  hciCmd(node, OP.leAddToAcceptList, [0, 9, 0, 0, 0, 0, 2]);
  assertEquals(completed(node, OP.leAddToAcceptList), [0x07]);
  hciCmd(node, OP.leRemoveFromAcceptList, [0, 3, 0, 0, 0, 0, 2]);
  hciCmd(node, OP.leAddToAcceptList, [0, 9, 0, 0, 0, 0, 2]);
  assertEquals(completed(node, OP.leAddToAcceptList), [0], "room again after a removal");
  hciCmd(node, OP.leClearAcceptList);
  for (let i = 0; i < 8; i++) hciCmd(node, OP.leAddToAcceptList, [1, i, 0, 0, 0, 0, 2]);
  assertEquals(completed(node, OP.leAddToAcceptList), [0], "cleared: eight fit again");
});

Deno.test("ble controller: non-connectable and scannable advertising reach a passive scanner with their types", () => {
  for (const [type, eventType] of [[3, 0x03], [2, 0x02]] as const) {
    const r = bleAir({ adv: [0, 0], scanner: [5, 0] });
    const adv = r.node("adv");
    const scanner = r.node("scanner");
    hciCmd(adv, OP.leSetAdvData, [31 + 5, ...new Uint8Array(40).fill(0x41)]);
    hciCmd(adv, OP.leSetAdvParams, advParams({ type, intervalUnits: 32 }));
    hciCmd(adv, OP.leSetAdvEnable, [1]);
    hciCmd(scanner, OP.leSetScanParams, [0, ...u16(16), ...u16(16), 0, 0]);
    hciCmd(scanner, OP.leSetScanEnable, [1, 1]);
    r.clock.advanceBy(500);
    const reports = leMeta(scanner, LE_SUBEVENT.advertisingReport);
    assertEquals(reports.length, 1, "duplicates are filtered");
    assertEquals(reports[0]![1], eventType);
    assertEquals(reports[0]![9], 31, "advertising data is cut to 31 bytes");
    const tx = r.log.events.flatMap((e) => (e.type === "tx" ? [e.radio?.pdu] : []));
    assert(!tx.includes("SCAN_REQ"), "a passive scanner never asks");
    hciCmd(scanner, OP.leSetScanEnable, [0, 0]);
    hciCmd(scanner, OP.leSetScanEnable, [1, 0]);
    r.clock.advanceBy(500);
    assert(
      leMeta(scanner, LE_SUBEVENT.advertisingReport).length > 2,
      "re-enabled without the filter",
    );
  }
});

Deno.test("ble controller: an active scanner asks ADV_SCAN_IND, never ADV_NONCONN_IND", () => {
  for (const [type, asks] of [[2, true], [3, false]] as const) {
    const r = bleAir({ adv: [0, 0], scanner: [3, 0] });
    hciCmd(r.node("adv"), OP.leSetAdvParams, advParams({ type, intervalUnits: 32 }));
    hciCmd(r.node("adv"), OP.leSetScanRspData, [2, 1, 2]);
    hciCmd(r.node("adv"), OP.leSetAdvEnable, [1]);
    hciCmd(r.node("scanner"), OP.leSetScanParams, [1, ...u16(16), ...u16(16), 0, 0]);
    hciCmd(r.node("scanner"), OP.leSetScanEnable, [1, 0]);
    r.clock.advanceBy(400);
    const tx = r.log.events.flatMap((e) => (e.type === "tx" ? [e.radio?.pdu] : []));
    assertEquals(tx.includes("SCAN_REQ"), asks, `type ${type}`);
    assertEquals(tx.includes("SCAN_RSP"), asks, `type ${type}`);
    const types = new Set(
      leMeta(r.node("scanner"), LE_SUBEVENT.advertisingReport).map((p) => p[1]),
    );
    assertEquals(types.has(0x04), asks);
  }
});

Deno.test("ble controller: accept-list filters drop scan requests and adverts from devices not on the list", () => {
  const r = bleAir({ adv: [0, 0], scanner: [3, 0] });
  const adv = r.node("adv");
  const scanner = r.node("scanner");
  hciCmd(adv, OP.leSetAdvParams, advParams({ intervalUnits: 32, filter: 1 }));
  hciCmd(adv, OP.leSetAdvEnable, [1]);
  hciCmd(scanner, OP.leSetScanParams, [1, ...u16(16), ...u16(16), 0, 0]);
  hciCmd(scanner, OP.leSetScanEnable, [1, 0]);
  r.clock.advanceBy(400);
  const tx = r.log.events.flatMap((e) => (e.type === "tx" ? [e.radio?.pdu] : []));
  assert(
    tx.includes("SCAN_REQ") && !tx.includes("SCAN_RSP"),
    "requests from a stranger go unanswered",
  );

  const s = bleAir({ adv: [0, 0], scanner: [3, 0] });
  hciCmd(s.node("adv"), OP.leSetAdvParams, advParams({ intervalUnits: 32 }));
  hciCmd(s.node("adv"), OP.leSetAdvEnable, [1]);
  hciCmd(s.node("scanner"), OP.leSetScanParams, [0, ...u16(16), ...u16(16), 0, 1]);
  hciCmd(s.node("scanner"), OP.leSetScanEnable, [1, 0]);
  s.clock.advanceBy(400);
  assertEquals(
    leMeta(s.node("scanner"), LE_SUBEVENT.advertisingReport),
    [],
    "the scanner's list is empty",
  );
  hciCmd(s.node("scanner"), OP.leSetScanEnable, [0, 0]);
  hciCmd(s.node("scanner"), OP.leAddToAcceptList, [0, ...addressToBytes(s.node("adv").address)]);
  hciCmd(s.node("scanner"), OP.leSetScanEnable, [1, 0]);
  s.clock.advanceBy(400);
  assert(leMeta(s.node("scanner"), LE_SUBEVENT.advertisingReport).length > 0, "listed: reported");
});

Deno.test("ble controller: a random own address is advertised with TxAdd set", () => {
  const r = bleAir({ adv: [0, 0], scanner: [3, 0] });
  const random = [0x11, 0x22, 0x33, 0x44, 0x55, 0xc6];
  hciCmd(r.node("adv"), OP.leSetRandomAddress, random);
  hciCmd(r.node("adv"), OP.leSetAdvParams, advParams({ ownType: 1, intervalUnits: 32 }));
  hciCmd(r.node("adv"), OP.leSetAdvEnable, [1]);
  assertEquals(completed(r.node("adv"), OP.leSetAdvEnable), [0]);
  hciCmd(r.node("scanner"), OP.leSetScanParams, [0, ...u16(16), ...u16(16), 0, 0]);
  hciCmd(r.node("scanner"), OP.leSetScanEnable, [1, 1]);
  r.clock.advanceBy(300);
  const [report] = leMeta(r.node("scanner"), LE_SUBEVENT.advertisingReport);
  assertEquals(report?.slice(2, 9), [1, ...random]);
});

Deno.test("ble controller: an advertiser that only accepts listed initiators is never connected to", () => {
  const r = bleAir({ gw: [0, 0], sensor: [3, 0] });
  hciCmd(r.node("sensor"), OP.leSetAdvParams, advParams({ filter: 2 }));
  hciCmd(r.node("sensor"), OP.leSetAdvEnable, [1]);
  hciCmd(r.node("gw"), OP.leCreateConnection, createConnectionParams(r.node("sensor").address));
  r.clock.advanceBy(400);
  assertEquals(leMeta(r.node("sensor"), LE_SUBEVENT.connectionComplete), []);
  assert(r.log.events.some((e) => e.type === "tx" && e.radio?.pdu === "CONNECT_IND"));
});

Deno.test("ble controller: an initiator using its accept list connects to a listed advertiser", () => {
  const r = bleAir({ gw: [0, 0], sensor: [3, 0] });
  hciCmd(r.node("sensor"), OP.leSetAdvParams, advParams());
  hciCmd(r.node("sensor"), OP.leSetAdvEnable, [1]);
  hciCmd(r.node("gw"), OP.leAddToAcceptList, [0, ...addressToBytes(r.node("sensor").address)]);
  hciCmd(
    r.node("gw"),
    OP.leCreateConnection,
    createConnectionParams("00:00:00:00:00:00", { acceptList: true }),
  );
  r.clock.advanceBy(300);
  assertEquals(leMeta(r.node("gw"), LE_SUBEVENT.connectionComplete).length, 1);
});

Deno.test("ble controller: a CONNECT_IND the peripheral never heard fails to establish after six events", () => {
  const r = bleAir({ gw: [0, 0], sensor: [3, 0] });
  r.node("gw").onTransmit = (frame) => {
    if (frame.params.pdu === "CONNECT_IND") r.air.moveNode("sensor", { x: 5000, y: 0 });
  };
  hciCmd(r.node("sensor"), OP.leSetAdvParams, advParams());
  hciCmd(r.node("sensor"), OP.leSetAdvEnable, [1]);
  hciCmd(r.node("gw"), OP.leCreateConnection, createConnectionParams(r.node("sensor").address));
  r.clock.advanceBy(600);
  assertEquals(disconnections(r.node("gw")).map((d) => d.reason), [
    STATUS.connectionFailedToEstablish,
  ]);
  assertEquals(leMeta(r.node("sensor"), LE_SUBEVENT.connectionComplete), []);
});

Deno.test("ble controller: on a live connection, RSSI, features, a second disconnect and a peripheral's update", () => {
  const r = bleAir({ gw: [0, 0], sensor: [3, 0] });
  const { gw, sensor, gwHandle, sensorHandle } = bleConnect(r);
  hciCmd(gw, OP.readRssi, u16(gwHandle));
  const rssi = completed(gw, OP.readRssi);
  assertEquals(rssi.slice(0, 3), [0, ...u16(gwHandle)]);
  assert(((rssi[3]! << 24) >> 24) < -20, `rssi byte ${rssi[3]}`);
  hciCmd(sensor, OP.leConnectionUpdate, [
    ...u16(sensorHandle),
    ...u16(48),
    ...u16(48),
    0,
    0,
    200,
    0,
    0,
    0,
    0,
    0,
  ]);
  assertEquals(statusOf(sensor, OP.leConnectionUpdate), STATUS.unsupportedRemoteFeature);
  hciCmd(gw, OP.leConnectionUpdate, [
    ...u16(gwHandle),
    ...u16(5),
    ...u16(5),
    0,
    0,
    200,
    0,
    0,
    0,
    0,
    0,
  ]);
  assertEquals(statusOf(gw, OP.leConnectionUpdate), STATUS.invalidParameters);
  hciCmd(gw, OP.leReadRemoteFeatures, u16(gwHandle));
  hciCmd(sensor, OP.leReadRemoteFeatures, u16(sensorHandle));
  r.clock.advanceBy(200);
  for (const node of [gw, sensor]) {
    const done = leMeta(node, LE_SUBEVENT.readRemoteFeaturesComplete);
    assertEquals(done.length, 1, node.id);
    assertEquals(done[0]![0], 0);
  }
  hciCmd(gw, OP.readRemoteVersion, u16(gwHandle));
  r.clock.advanceBy(200);
  hciCmd(gw, OP.readRemoteVersion, u16(gwHandle));
  r.clock.advanceBy(1);
  const versions = events(gw, EVT.readRemoteVersionComplete);
  assertEquals(versions.length, 2, "the second answer comes from what the peer already sent");
  assertEquals(Array.from(versions[1]!), [0, ...u16(gwHandle), 8, 0xff, 0xff, 1, 0]);
  hciCmd(gw, OP.disconnect, [...u16(gwHandle), 0x13]);
  hciCmd(gw, OP.disconnect, [...u16(gwHandle), 0x13]);
  assertEquals(statusOf(gw, OP.disconnect), STATUS.commandDisallowed, "already terminating");
  r.clock.advanceBy(300);
  assertEquals(disconnections(gw).map((d) => d.reason), [STATUS.localHostTerminated]);
  assertEquals(disconnections(sensor).map((d) => d.reason), [STATUS.remoteUserTerminated]);
});

Deno.test("ble controller: an unknown LL control opcode is answered with LL_UNKNOWN_RSP naming it", () => {
  const r = bleAir({ gw: [0, 0], sensor: [3, 0] });
  const { gw, sensor, gwHandle } = bleConnect(r);
  // Turn the central's LL_FEATURE_REQ into an opcode the controller does not know.
  gw.onTransmit = (frame) => {
    if (
      frame.kind === "ble-data" && (frame.payload[0]! & 3) === LLID.control &&
      frame.payload[2] === LL_CTRL.featureReq
    ) {
      frame.payload[2] = 0x30;
    }
  };
  const answers: number[][] = [];
  sensor.onTransmit = (frame) => {
    if (frame.kind === "ble-data" && (frame.payload[0]! & 3) === LLID.control) {
      answers.push(Array.from(frame.payload.subarray(2)));
    }
  };
  hciCmd(gw, OP.leReadRemoteFeatures, u16(gwHandle));
  r.clock.advanceBy(200);
  assert(
    answers.some((a) => a[0] === LL_CTRL.unknownRsp && a[1] === 0x30),
    JSON.stringify(answers),
  );
  assertEquals(leMeta(gw, LE_SUBEVENT.readRemoteFeaturesComplete), [], "no features came back");
  assertEquals(disconnections(gw), [], "the link survives");
});

Deno.test("ble controller: a connection update whose instant has passed ends the link with 0x28", () => {
  const r = bleAir({ gw: [0, 0], sensor: [3, 0] });
  const { gw, sensor, gwHandle } = bleConnect(r);
  gw.onTransmit = (frame) => {
    if (
      frame.kind === "ble-data" && (frame.payload[0]! & 3) === LLID.control &&
      frame.payload[2] === LL_CTRL.connectionUpdateInd
    ) {
      frame.payload[12] = 0xf0;
      frame.payload[13] = 0xff;
    }
  };
  hciCmd(gw, OP.leConnectionUpdate, [
    ...u16(gwHandle),
    ...u16(48),
    ...u16(48),
    0,
    0,
    100,
    0,
    0,
    0,
    0,
    0,
  ]);
  assertEquals(statusOf(gw, OP.leConnectionUpdate), 0);
  r.clock.advanceBy(1500);
  assertEquals(disconnections(sensor).map((d) => d.reason), [STATUS.instantPassed]);
  assertEquals(disconnections(gw).map((d) => d.reason), [STATUS.connectionTimeout]);
  assertEquals(
    leMeta(gw, LE_SUBEVENT.connectionUpdateComplete).length,
    1,
    "the central applied it at its instant",
  );
});

Deno.test("ble controller: Reset drops a connection without a disconnection event; close() stops every timer", () => {
  const r = bleAir({ gw: [0, 0], sensor: [3, 0] });
  const { gw, sensor, gwHandle } = bleConnect(r);
  hciCmd(gw, OP.reset);
  assertEquals(completed(gw, OP.reset), [0]);
  hciCmd(gw, OP.readRssi, u16(gwHandle));
  assertEquals(completed(gw, OP.readRssi)[0], STATUS.unknownConnection);
  r.clock.advanceBy(1500);
  assertEquals(disconnections(gw), []);
  assertEquals(disconnections(sensor).map((d) => d.reason), [STATUS.connectionTimeout]);
  sensor.controller.close();
  gw.controller.close();
  const before = [gw.packets.length, sensor.packets.length];
  hciCmd(gw, OP.reset);
  r.clock.advanceBy(1000);
  assertEquals(
    [gw.packets.length, sensor.packets.length],
    before,
    "a closed controller says nothing",
  );
});
