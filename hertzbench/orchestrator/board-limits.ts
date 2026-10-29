// Run-report warnings for a board that failed in a way the sketch did not
// cause: a place where the emulator, not the firmware, is what ended up wrong.
// Each detector reads a node's serial lines and names the limit in terms of
// fidelity (docs/fidelity.md), so the failure does not look like a defect in
// the sketch. Add the next detector to DETECTORS below.

import type { EngineEvent } from "../engine/mod.ts";
import type { BoardKind, FirmwareSpec } from "./scenario.ts";

interface Detector {
  board: BoardKind;
  /** The warning for one node's serial lines, or null when they show nothing. */
  detect(lines: readonly string[]): string | null;
}

// ROM boot banner: `rst:0x8 (TG1WDT_SYS_RESET)` is the interrupt watchdog,
// `rst:0x7 (TG0WDT_SYS_RESET)` the task watchdog of timer group 0.
const WATCHDOG_RESET = /rst:0x[78] \(TG[01]WDT_SYS_RESET\)/;
// One watchdog reset can be a bug in the sketch; a boot loop is the pattern
// this detector exists for.
const WATCHDOG_LOOP_MIN_RESETS = 2;

/** Classic Bluetooth (BluetoothSerial, SPP): the fork maps the Bluetooth block as an unimplemented device. */
export const CLASSIC_BLUETOOTH_LIMIT =
  "classic Bluetooth is not simulated; this firmware cannot run on the esp32 board";
// `BluetoothSerial::begin()` fails this assert in the controller init, then the board reboots.
const CLASSIC_BLUETOOTH_ASSERT = "assert failed: esp_bt_controller_init";

const DETECTORS: readonly Detector[] = [
  {
    board: "esp32",
    detect(lines) {
      return lines.some((line) => line.includes(CLASSIC_BLUETOOTH_ASSERT))
        ? CLASSIC_BLUETOOTH_LIMIT
        : null;
    },
  },
  {
    board: "esp32",
    detect(lines) {
      const resets = lines.filter((line) => WATCHDOG_RESET.test(line)).length;
      if (resets < WATCHDOG_LOOP_MIN_RESETS) return null;
      return `interrupt watchdog reset loop (${resets} watchdog resets in its serial): a ` +
        "busy-wait with interrupts disabled, such as a sensor that is not modelled " +
        "(DHT11/DHT22), is a fidelity limit of the emulated board, not necessarily a defect in the sketch";
    },
  },
];

/** One warning per node and detector that matches, in scenario order. */
export function boardLimitWarnings(
  nodes: readonly { id: string; board: BoardKind }[],
  events: readonly EngineEvent[],
): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    const lines = events.flatMap((e) => e.type === "serial" && e.node === node.id ? [e.text] : []);
    for (const detector of DETECTORS) {
      if (detector.board !== node.board) continue;
      const warning = detector.detect(lines);
      if (warning) out.push(`${node.id}: ${warning}`);
    }
  }
  return out;
}

// The files compile_sketch.py hands to the compiler, so a scan reads what would be built.
const SKETCH_SOURCE = /\.(ino|h|hpp|c|cpp)$/;
const BLUETOOTH_SERIAL_INCLUDE = /^\s*#\s*include\s*[<"]BluetoothSerial\.h[>"]/m;

/**
 * Warnings `validate` can give before anything is compiled: one per esp32 node
 * whose sketch includes `BluetoothSerial.h`. A sketch directory that cannot be
 * read is `checkFirmwareFiles`' to report, so it is skipped here.
 */
export async function sketchLimitWarnings(
  nodes: readonly { id: string; board: BoardKind; firmware: FirmwareSpec }[],
): Promise<string[]> {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.board !== "esp32" || node.firmware.kind !== "sketch") continue;
    const dir = node.firmware.path;
    try {
      const files = [];
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && SKETCH_SOURCE.test(entry.name)) files.push(entry.name);
      }
      for (const name of files.sort()) {
        const text = await Deno.readTextFile(`${dir}/${name}`);
        if (BLUETOOTH_SERIAL_INCLUDE.test(text)) {
          out.push(`${node.id}: ${name} includes BluetoothSerial.h; ${CLASSIC_BLUETOOTH_LIMIT}`);
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound || error instanceof Deno.errors.NotADirectory)) {
        throw error;
      }
    }
  }
  return out;
}
