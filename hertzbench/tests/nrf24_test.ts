// The nRF24L01+ model driven by a replay of RF24, on a manual clock:
// Enhanced ShockBurst with the ACK crossing the air, retries and MAX_RT.

import { assert, assertEquals } from "@std/assert";
import {
  AirMedium,
  environmentFromPreset,
  EventLog,
  ManualClock,
  type Position,
} from "../engine/mod.ts";
import { Nrf24l01, NRF_CMD, NRF_REG } from "../adapters/nrf24/mod.ts";
import type { Level, SpiDevice } from "../adapters/spi-link/device.ts";
import { Rf24 } from "../orchestrator/boards/drivers/rf24.ts";
import type { DriverBus } from "../orchestrator/boards/drivers/bus.ts";

const PINS = { csn: 5, ce: 4, irq: 26 };
const GW_ADDRESS = Uint8Array.of(0x01, 0x00, 0x42, 0x5a, 0x48);
const OTHER_ADDRESS = Uint8Array.of(0x02, 0x00, 0x42, 0x5a, 0x48);

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
    seed: 11,
    clock,
    log,
    environment: environmentFromPreset("free_space", { shadowingSigmaDb: 0 }),
  });
  const nodes = new Map<string, { chip: Nrf24l01; rf: Rf24; irq: Level[] }>();
  for (const [id, position] of Object.entries(positions)) {
    const irq: Level[] = [];
    const chip = new Nrf24l01({
      pins: PINS,
      clock,
      transmit: (frame) => air.transmit(id, frame),
      drivePin: (_gpio, level) => irq.push(level),
      warn: () => {},
    });
    air.addNode({ id, position, antennaGainDbi: 0 }, chip);
    nodes.set(id, { chip, rf: new Rf24(inProcessBus(chip, clock), PINS), irq });
  }
  const node = (id: string) => nodes.get(id)!;
  const outcomes = () =>
    log.events.flatMap((e) =>
      e.type === "deliver"
        ? [`${e.kind} ${e.from}>${e.to} deliver`]
        : e.type === "drop"
        ? [`${e.kind} ${e.from}>${e.to} ${e.reason}`]
        : []
    );
  return { clock, log, air, node, outcomes };
}

async function listenOn(rf: Rf24, address: Uint8Array): Promise<void> {
  assert(await rf.begin(), "begin() must read CONFIG back as written");
  await rf.openReadingPipe(1, address);
  await rf.startListening();
}

Deno.test("nrf24: begin() succeeds against the model, as RF24 checks it", async () => {
  const r = rig({ a: { x: 0, y: 0 } });
  const { rf, chip } = r.node("a");
  assert(await rf.begin());
  assert(await rf.isChipConnected());
  assertEquals(chip.peek(NRF_REG.CONFIG), 0x7e);
  assertEquals(chip.peek(NRF_REG.RF_CH), 76);
  assertEquals(chip.peek(NRF_REG.SETUP_RETR), 0x5f);
  assertEquals(chip.state, "standby");
});

Deno.test("nrf24: write() is acknowledged over the air and the receiver reads the payload", async () => {
  const r = rig({ node: { x: 0, y: 0 }, gw: { x: 20, y: 0 } });
  const node = r.node("node");
  const gw = r.node("gw");
  await listenOn(gw.rf, GW_ADDRESS);
  r.clock.advanceBy(1); // RX settling
  assert(await node.rf.begin());
  await node.rf.openWritingPipe(GW_ADDRESS);

  const ok = await node.rf.write(new TextEncoder().encode("hello gw"));
  assert(ok, "TX_DS: the ACK came back");
  assert(await gw.rf.available());
  assertEquals(await gw.rf.pipeAvailable(), 1);
  const payload = await gw.rf.read();
  assertEquals(new TextDecoder().decode(payload.subarray(0, 8)), "hello gw");
  assertEquals(payload.length, 32, "static payload, padded by the sender");
  assert(!(await gw.rf.available()));
  assertEquals(r.outcomes(), ["nrf24 node>gw deliver", "nrf24-ack gw>node deliver"]);
  // CONFIG masks every IRQ after RF24 begin(), so the line never moved.
  assertEquals(gw.irq, []);
});

Deno.test("nrf24: with nobody listening, write() retries ARC times and reports MAX_RT", async () => {
  const r = rig({ node: { x: 0, y: 0 }, gw: { x: 20, y: 0 } });
  const node = r.node("node");
  assert(await node.rf.begin());
  assert(await r.node("gw").rf.begin()); // powered, never listening
  await node.rf.openWritingPipe(GW_ADDRESS);
  const started = r.clock.now();
  assertEquals(await node.rf.write(new TextEncoder().encode("anyone?")), false);
  const txs = r.log.events.filter((e) => e.type === "tx");
  assertEquals(txs.length, 16, "one attempt plus 15 retransmits");
  // 16 x (329 us on air + 1500 us ARD) + 130 us settling: about 29.4 ms.
  const took = r.clock.now() - started;
  assert(took > 29 && took < 32, `took ${took} ms`);
  assertEquals(node.chip.peek(NRF_REG.OBSERVE_TX), 0x1f, "PLOS_CNT 1, ARC_CNT 15");
  assertEquals(node.chip.txCount, 0, "RF24 flushes the payload after MAX_RT");
});

Deno.test("nrf24: a lost ACK makes the sender retry; the receiver keeps one copy", async () => {
  const r = rig({ node: { x: 0, y: 0 }, gw: { x: 20, y: 0 } });
  const node = r.node("node");
  const gw = r.node("gw");
  await listenOn(gw.rf, GW_ADDRESS);
  r.clock.advanceBy(1);
  assert(await node.rf.begin());
  await node.rf.openWritingPipe(GW_ADDRESS);
  r.air.setLinkOverride("gw", "node", { extraLossPct: 100, extraLatencyMs: 0 });
  assertEquals(await node.rf.write(new TextEncoder().encode("once")), false);
  assertEquals(gw.chip.rxCount, 1, "retransmissions with the same PID are dropped");
  const delivered = r.outcomes().filter((o) => o === "nrf24 node>gw deliver").length;
  assertEquals(delivered, 16);
});

Deno.test("nrf24: another address is silence, another data rate on the address is a mismatch", async () => {
  const r = rig({ node: { x: 0, y: 0 }, gw: { x: 20, y: 0 }, slow: { x: 0, y: 20 } });
  await listenOn(r.node("gw").rf, OTHER_ADDRESS);
  const slow = r.node("slow").rf;
  assert(await slow.begin());
  await slow.setDataRate(250);
  await slow.openReadingPipe(1, GW_ADDRESS);
  await slow.startListening();
  r.clock.advanceBy(1);
  const node = r.node("node").rf;
  assert(await node.begin());
  await node.openWritingPipe(GW_ADDRESS);
  assertEquals(await node.write(Uint8Array.of(1)), false);
  const outcomes = new Set(r.outcomes());
  assertEquals([...outcomes], ["nrf24 node>slow phy_mismatch"]);
});

Deno.test("nrf24: multicast (NO_ACK) completes without an ACK", async () => {
  const r = rig({ node: { x: 0, y: 0 }, gw: { x: 20, y: 0 } });
  await listenOn(r.node("gw").rf, GW_ADDRESS);
  r.clock.advanceBy(1);
  const node = r.node("node").rf;
  assert(await node.begin());
  await node.openWritingPipe(GW_ADDRESS);
  assert(await node.write(Uint8Array.of(7), true));
  assertEquals(r.outcomes(), ["nrf24 node>gw deliver"]);
});

Deno.test("nrf24: STATUS on every first byte, IRQ follows unmasked flags, FIFO status", () => {
  const clock = new ManualClock();
  const irq: Level[] = [];
  const chip = new Nrf24l01({
    pins: PINS,
    clock,
    transmit: () => {},
    drivePin: (_g, l) => irq.push(l),
    warn: () => {},
  });
  const cmd = (...bytes: number[]) => {
    chip.pinChanged(PINS.csn, 0);
    const out = bytes.map((b) => chip.transfer(b));
    chip.pinChanged(PINS.csn, 1);
    return out;
  };
  assertEquals(cmd(NRF_CMD.NOP)[0], 0x0e, "RX_P_NO empty, nothing pending");
  // 5-byte address registers read back least significant byte first.
  assertEquals(cmd(NRF_REG.RX_ADDR_P1, 0xff, 0xff, 0xff, 0xff, 0xff).slice(1), [
    0xc2,
    0xc2,
    0xc2,
    0xc2,
    0xc2,
  ]);
  assertEquals(cmd(NRF_REG.FIFO_STATUS, 0xff)[1], 0x11);
  // Three payloads fill the TX FIFO; STATUS TX_FULL and FIFO_STATUS FIFO_FULL say so.
  for (let i = 0; i < 3; i++) cmd(NRF_CMD.W_TX_PAYLOAD, i);
  assertEquals(cmd(NRF_CMD.NOP)[0]! & 0x01, 1);
  assertEquals(cmd(NRF_REG.FIFO_STATUS, 0xff)[1], 0x21);
  cmd(NRF_CMD.FLUSH_TX);
  assertEquals(cmd(NRF_REG.FIFO_STATUS, 0xff)[1], 0x11);
  // Power up as a transmitter with CRC, IRQs unmasked, and send with nobody around.
  cmd(NRF_CMD.W_REGISTER | NRF_REG.CONFIG, 0x0e);
  cmd(NRF_CMD.W_REGISTER | NRF_REG.SETUP_RETR, 0x00); // no retransmits
  cmd(NRF_CMD.W_TX_PAYLOAD, 0x42);
  chip.pinChanged(PINS.ce, 1);
  clock.runAll();
  assertEquals(cmd(NRF_CMD.NOP)[0]! & 0x70, 0x10, "MAX_RT");
  assertEquals(irq, [0], "IRQ is active low");
  cmd(NRF_CMD.W_REGISTER | NRF_REG.STATUS, 0x10);
  assertEquals(irq, [0, 1]);
});
