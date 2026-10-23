// The SX127x model driven by a replay of arduino-LoRa, on a manual clock, so
// the register sequences a real sketch issues are what is tested.

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  AirMedium,
  environmentFromPreset,
  EventLog,
  loraAirtimeMs,
  ManualClock,
  type Position,
  substream,
} from "../engine/mod.ts";
import { IRQ, MODE, paOutputDbm, REG, Sx127x } from "../adapters/lora-sx127x/mod.ts";
import type { Level, SpiDevice } from "../adapters/spi-link/device.ts";
import { ArduinoLora } from "../orchestrator/boards/drivers/arduino-lora.ts";
import type { DriverBus } from "../orchestrator/boards/drivers/bus.ts";

const PINS = { cs: 5, reset: 14, dio0: 26 };

function inProcessBus(device: SpiDevice, clock: ManualClock): DriverBus {
  return {
    digitalWrite: (gpio, level) => Promise.resolve(device.pinChanged(gpio, level)),
    transfer: (mosi) => Promise.resolve(device.transfer(mosi)),
    delay: (ms) => Promise.resolve(clock.advanceBy(ms)),
  };
}

function rig(positions: Record<string, Position>) {
  const clock = new ManualClock();
  const log = new EventLog();
  const air = new AirMedium({
    seed: 3,
    clock,
    log,
    environment: environmentFromPreset("free_space", { shadowingSigmaDb: 0 }),
  });
  const warnings: string[] = [];
  const nodes = new Map<string, { chip: Sx127x; lora: ArduinoLora; dio0: Level[] }>();
  for (const [id, position] of Object.entries(positions)) {
    const dio0: Level[] = [];
    const chip = new Sx127x({
      pins: PINS,
      clock,
      transmit: (frame) => air.transmit(id, frame),
      drivePin: (_gpio, level) => dio0.push(level),
      rng: substream(3, `sx127x:${id}`),
      warn: (message) => warnings.push(`${id}: ${message}`),
    });
    air.addNode({ id, position, antennaGainDbi: 0 }, chip);
    nodes.set(id, {
      chip,
      lora: new ArduinoLora(inProcessBus(chip, clock), { ss: 5, reset: 14, dio0: 26 }),
      dio0,
    });
  }
  const node = (id: string) => nodes.get(id)!;
  return { clock, log, air, node, warnings };
}

async function setup(lora: ArduinoLora, sf = 7): Promise<void> {
  assert(await lora.begin(868.1e6), "begin() must find the 0x12 silicon version");
  await lora.setSpreadingFactor(sf);
  await lora.setSignalBandwidth(125e3);
  await lora.setCodingRate4(5);
  await lora.enableCrc();
}

async function send(lora: ArduinoLora, text: string): Promise<void> {
  await lora.beginPacket();
  await lora.write(new TextEncoder().encode(text));
  await lora.endPacket();
}

Deno.test("sx127x: begin() leaves the registers arduino-LoRa expects", async () => {
  const r = rig({ a: { x: 0, y: 0 } });
  const { chip, lora } = r.node("a");
  await setup(lora);
  assertEquals(chip.peek(REG.OP_MODE), 0x81); // LoRa, standby
  assertEquals(
    [chip.peek(REG.FRF_MSB), chip.peek(REG.FRF_MID), chip.peek(REG.FRF_LSB)],
    [0xd9, 0x06, 0x66],
  );
  assertEquals(chip.peek(REG.PA_CONFIG), 0x8f); // PA_BOOST, 17 dBm
  assertEquals(chip.peek(REG.LNA), 0x23);
  assertEquals(chip.modulation().sf, 7);
  assertEquals(chip.modulation().crc, true);
  assertEquals(chip.modulation().lowDataRateOptimize, false);
  await lora.setSpreadingFactor(12);
  assertEquals(chip.modulation().lowDataRateOptimize, true);
});

Deno.test("sx127x: a packet goes out, TxDone rises after its airtime, and DIO0 tells the receiver", async () => {
  const r = rig({ node: { x: 0, y: 0 }, gw: { x: 200, y: 0 } });
  const tx = r.node("node");
  const gw = r.node("gw");
  await setup(tx.lora);
  await setup(gw.lora);
  await gw.lora.receive();
  assertEquals(gw.chip.mode, MODE.RX_CONTINUOUS);

  const started = r.clock.now();
  await send(tx.lora, "temperature=21.5C #1");
  // endPacket returns on the first poll after TxDone: 56.576 ms for 20 bytes at SF7.
  const took = r.clock.now() - started;
  assert(took >= loraAirtimeMs(tx.chip.modulation(), 20) && took < 56.576 + 2, `took ${took} ms`);
  assertEquals(tx.chip.mode, MODE.STDBY);
  assertEquals(tx.chip.peek(REG.IRQ_FLAGS) & IRQ.TX_DONE, 0, "endPacket clears TxDone");

  assertEquals(gw.dio0, [1], "DIO0 (mapped to RxDone) rose once");
  const length = await gw.lora.handleDio0Rise();
  assertEquals(length, 20);
  assertEquals(new TextDecoder().decode(await gw.lora.readAll()), "temperature=21.5C #1");
  assertEquals(gw.dio0, [1, 0], "clearing RxDone lowers DIO0");
  // Free space, 200 m, 868.1 MHz: 77.24 dB of loss; 17 dBm out.
  const rssi = await gw.lora.packetRssi();
  assertEquals(rssi, Math.round(17 - 77.24));
  // 56.8 dB of SNR does not fit RegPktSnrValue, an int8 in quarter dB: it saturates.
  assertEquals(await gw.lora.packetSnr(), 31.75);
  assertEquals(gw.chip.mode, MODE.RX_CONTINUOUS, "continuous RX stays on");

  const tx0 = r.log.events.find((e) => e.type === "tx");
  assert(tx0?.type === "tx");
  assertEquals(tx0.radio?.sf, 7);
  assertEquals(tx0.radio?.cr, "4/5");
  assertEquals(tx0.radio?.tx_power_dbm, 17);
  assertEquals(tx0.radio?.frequency_mhz, 868.1);
});

Deno.test("sx127x: parsePacket polling in RX single times out, re-arms and catches the packet", async () => {
  const r = rig({ node: { x: 0, y: 0 }, gw: { x: 50, y: 0 } });
  const tx = r.node("node");
  const gw = r.node("gw");
  await setup(tx.lora);
  await setup(gw.lora);
  assertEquals(await gw.lora.parsePacket(), 0);
  assertEquals(gw.chip.mode, MODE.RX_SINGLE);
  // 100 symbols of 1.024 ms: the default RegSymbTimeout.
  r.clock.advanceBy(103);
  assertEquals(gw.chip.mode, MODE.STDBY);
  assert(gw.chip.peek(REG.IRQ_FLAGS) & IRQ.RX_TIMEOUT);
  assertEquals(await gw.lora.parsePacket(), 0, "re-enters RX single and clears the timeout");
  assertEquals(gw.chip.mode, MODE.RX_SINGLE);

  await send(tx.lora, "ping");
  // The preamble arrived inside the window, so RX single held on to the end.
  const length = await gw.lora.parsePacket();
  assertEquals(length, 4);
  assertEquals(new TextDecoder().decode(await gw.lora.readAll()), "ping");
  assertEquals(gw.chip.mode, MODE.STDBY, "RxDone ends RX single");
});

Deno.test("sx127x: another SF or sync word is a phy_mismatch, another channel is silence", async () => {
  const r = rig({
    node: { x: 0, y: 0 },
    sf9: { x: 10, y: 0 },
    sync: { x: 0, y: 10 },
    far: { x: 5, y: 5 },
  });
  await setup(r.node("node").lora);
  await setup(r.node("sf9").lora, 9);
  await setup(r.node("sync").lora);
  await r.node("sync").lora.setSyncWord(0x34);
  await setup(r.node("far").lora);
  await r.node("far").lora.setFrequency(868.5e6);
  for (const id of ["sf9", "sync", "far"]) await r.node(id).lora.receive();
  await send(r.node("node").lora, "x");
  r.clock.runAll();
  const drops = r.log.events.flatMap((e) => (e.type === "drop" ? [`${e.to} ${e.reason}`] : []));
  assertEquals(drops.sort(), ["sf9 phy_mismatch", "sync phy_mismatch"]);
  assertEquals(r.log.events.filter((e) => e.type === "deliver").length, 0);
});

Deno.test("sx127x: a node that is transmitting does not hear (half-duplex)", async () => {
  const r = rig({ a: { x: 0, y: 0 }, b: { x: 30, y: 0 } });
  await setup(r.node("a").lora);
  await setup(r.node("b").lora, 7);
  await r.node("b").lora.receive();
  // a starts sending; b leaves RX to send its own packet before a's ends.
  await r.node("a").lora.beginPacket();
  await r.node("a").lora.write(new TextEncoder().encode("from a"));
  await r.node("a").lora.writeRegister(REG.OP_MODE, 0x83);
  r.clock.advanceBy(5);
  await send(r.node("b").lora, "from b");
  r.clock.runAll();
  const outcomes = r.log.events.flatMap((e) =>
    e.type === "drop" || e.type === "deliver"
      ? [`${e.from}>${e.to} ${e.type === "drop" ? e.reason : "deliver"}`]
      : []
  );
  // a is in TX when b sends, so b's frame has no listener; b left RX, so a's frame is not_listening.
  assertEquals(outcomes, ["a>b not_listening"]);
});

Deno.test("sx127x: registers - burst read, write-1-to-clear IRQs, mask, version, reset pin", () => {
  const clock = new ManualClock();
  const pins: Level[] = [];
  const warnings: string[] = [];
  const chip = new Sx127x({
    pins: PINS,
    clock,
    transmit: () => {},
    drivePin: (_g, l) => pins.push(l),
    rng: substream(1, "x"),
    warn: (m) => warnings.push(m),
  });
  const xfer = (...bytes: number[]) => {
    chip.pinChanged(PINS.cs, 0);
    const out = bytes.map((b) => chip.transfer(b));
    chip.pinChanged(PINS.cs, 1);
    return out;
  };
  // Burst read of Frf: the address increments after each byte.
  assertEquals(xfer(REG.FRF_MSB, 0, 0, 0).slice(1), [0x6c, 0x80, 0x00]);
  assertEquals(xfer(REG.VERSION, 0)[1], 0x12);
  // Unselected, the chip leaves MISO high.
  assertEquals(chip.transfer(REG.VERSION), 0xff);
  // LongRangeMode is ignored outside sleep: from FSK standby (0x09), 0x81 stays FSK.
  xfer(0x80 | REG.OP_MODE, 0x81);
  assertEquals(chip.loraMode, false);
  xfer(0x80 | REG.OP_MODE, 0x80);
  assertEquals(chip.loraMode, true);
  // TxDone with an empty payload, then write-1-to-clear.
  xfer(0x80 | REG.DIO_MAPPING_1, 0x40);
  xfer(0x80 | REG.OP_MODE, 0x83);
  clock.runAll();
  assertEquals(xfer(REG.IRQ_FLAGS, 0)[1], IRQ.TX_DONE);
  assertEquals(pins, [1]);
  xfer(0x80 | REG.IRQ_FLAGS, 0x01); // another bit: TxDone stays
  assertEquals(chip.peek(REG.IRQ_FLAGS), IRQ.TX_DONE);
  xfer(0x80 | REG.IRQ_FLAGS, 0xff);
  assertEquals(chip.peek(REG.IRQ_FLAGS), 0);
  assertEquals(pins, [1, 0]);
  // A masked IRQ never sets its flag.
  xfer(0x80 | REG.IRQ_FLAGS_MASK, IRQ.TX_DONE);
  xfer(0x80 | REG.OP_MODE, 0x83);
  clock.runAll();
  assertEquals(chip.peek(REG.IRQ_FLAGS), 0);
  // Read-only registers ignore writes.
  xfer(0x80 | REG.VERSION, 0x55);
  assertEquals(chip.peek(REG.VERSION), 0x12);
  // NRESET low restores the reset values.
  xfer(0x80 | REG.SYNC_WORD, 0x34);
  chip.pinChanged(PINS.reset, 0);
  chip.pinChanged(PINS.reset, 1);
  assertEquals(chip.peek(REG.SYNC_WORD), 0x12);
  assertEquals(chip.peek(REG.OP_MODE), 0x09);
  assertEquals(warnings, []);
  // CAD is reported, not silently ignored.
  xfer(0x80 | REG.OP_MODE, 0x80);
  xfer(0x80 | REG.OP_MODE, 0x87);
  assertEquals(warnings.length, 1);
  assert(warnings[0]!.includes("CAD"));
});

Deno.test("sx127x: a weak packet reports its RSSI through the datasheet's negative-SNR formula", () => {
  const clock = new ManualClock();
  const chip = new Sx127x({
    pins: PINS,
    clock,
    transmit: () => {},
    drivePin: () => {},
    rng: substream(1, "x"),
    warn: () => {},
  });
  const xfer = (...bytes: number[]) => {
    chip.pinChanged(PINS.cs, 0);
    bytes.forEach((b) => chip.transfer(b));
    chip.pinChanged(PINS.cs, 1);
  };
  xfer(0x80 | REG.OP_MODE, 0x80);
  xfer(0x80 | REG.FRF_MSB, 0xd9, 0x06, 0x66);
  xfer(0x80 | REG.OP_MODE, 0x85);
  const mod = chip.modulation();
  const accepted = chip.receive(
    {
      kind: "lora",
      payload: Uint8Array.of(1, 2, 3),
      airtimeMs: 30,
      frequencyHz: mod.frequencyHz,
      bandwidthHz: mod.bandwidthHz,
      noiseFigureDb: 6,
      requiredSnrDb: -7.5,
      referenceBytes: 20,
      captureDb: 6,
      txPowerDbm: 14,
      interferenceKey: "k",
      rateBps: 1,
      dst: "",
      src: "",
      params: {},
      header: { modulation: mod },
    },
    "x",
    { rssiDbm: -125, snrDb: -6 },
  );
  assert(accepted);
  // RSSI = -157 + PktRssi + PktSnr / 4 -> PktRssi = -125 + 157 + 6 = 38
  assertEquals(chip.peek(REG.PKT_RSSI_VALUE), 38);
  assertEquals(chip.peek(REG.PKT_SNR_VALUE), (-24) & 0xff);
});

Deno.test("sx127x: PA output power follows RegPaConfig and RegPaDac", () => {
  assertEquals(paOutputDbm(0x8f, 0x84), 17);
  assertEquals(paOutputDbm(0x8f, 0x87), 20);
  assertEquals(paOutputDbm(0x80, 0x84), 2);
  // RFO with MaxPower 7: Pmax 15 dBm, so OutputPower is the dBm.
  assertAlmostEquals(paOutputDbm(0x7e, 0x84), 14, 1e-9);
});
