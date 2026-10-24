// The cross-language contract of spi-link: the Python client the Velxio ESP32
// worker ships (RadioSpiLink in backend/app/services/esp32_worker.py) against
// the real TypeScript adapter and SX127x model. A byte layout changed on one
// side only fails here, without libqemu.

import { PYTHON } from "./platform.ts";
import { fileURLToPath } from "node:url";
import { assertEquals } from "@std/assert";
import { type AirFrame, WallClock } from "../engine/mod.ts";
import { Sx127x } from "../adapters/lora-sx127x/mod.ts";
import { SpiLinkAdapter } from "../adapters/spi-link/mod.ts";
import { substream } from "../engine/rng.ts";

const BACKEND = fileURLToPath(new URL("../../backend", import.meta.url));
const PINS = { cs: 5, reset: 14, dio0: 26 };

// Drives the chip the way arduino-LoRa does on the guest, through the worker's
// own client, and prints what it read and which pins the chip drove.
const SCRIPT = `
import json, sys, threading, time
sys.path.insert(0, ${JSON.stringify(BACKEND)})
from app.services.esp32_worker import RadioSpiLink

port = int(sys.argv[1])
drives, errors = [], []
dio0_high = threading.Event()
def on_drive(gpio, level):
    drives.append([gpio, level])
    if gpio == 26 and level == 1:
        dio0_high.set()
link = RadioSpiLink(port, on_drive=on_drive, on_error=errors.append)

def single(address, value):
    link.pin(5, 0)
    link.transfer(address)
    out = link.transfer(value)
    link.pin(5, 1)
    return out

version = single(0x42, 0x00)
single(0x81, 0x80)                         # RegOpMode: LoRa, sleep
single(0xb9, 0x34)                         # RegSyncWord
sync = single(0x39, 0x00)
single(0xc0, 0x40)                         # RegDioMapping1: DIO0 = TxDone
single(0xa2, 0x01)                         # RegPayloadLength 1
single(0x81, 0x83)                         # RegOpMode: LoRa, TX
dio0_high.wait(5)
flags = single(0x12, 0x00)
single(0x92, 0xff)                         # clear every IRQ: DIO0 falls
time.sleep(0.2)
link.close()
print(json.dumps({"version": version, "sync": sync, "flags": flags, "drives": drives, "errors": errors}))
`;

Deno.test("spi-link: the worker's Python client drives the TypeScript SX127x model", async () => {
  const clock = new WallClock();
  const sent: AirFrame[] = [];
  const problems: string[] = [];
  const adapter = new SpiLinkAdapter((id, message) => problems.push(`${id}: ${message}`));
  const { port } = adapter.listen("node", (drivePin) =>
    new Sx127x({
      pins: PINS,
      clock,
      transmit: (frame) => sent.push(frame),
      drivePin,
      rng: substream(1, "sx127x:node"),
      warn: (message) => problems.push(message),
    }));
  try {
    const output = await new Deno.Command(PYTHON, {
      args: ["-c", SCRIPT, String(port)],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = (b: Uint8Array) => new TextDecoder().decode(b);
    assertEquals(output.code, 0, text(output.stderr));
    const result = JSON.parse(text(output.stdout));
    assertEquals(result.version, 0x12);
    assertEquals(result.sync, 0x34);
    assertEquals(result.flags & 0x08, 0x08, "TxDone");
    assertEquals(result.drives, [[26, 1], [26, 0]], "DIO0 rose at TxDone and fell when cleared");
    assertEquals(result.errors, []);
    assertEquals(sent.length, 1);
    assertEquals(sent[0]!.params.sync_word, 0x34);
    assertEquals(problems, []);
  } finally {
    await adapter.close();
    clock.cancelAll();
  }
});
