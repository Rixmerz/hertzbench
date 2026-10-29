import { assertEquals } from "@std/assert";
import type { EngineEvent } from "../engine/mod.ts";
import { boardLimitWarnings, sketchLimitWarnings } from "../orchestrator/board-limits.ts";
import { compileFailureMessage } from "../orchestrator/boards/qemu-esp32.ts";

function serial(node: string, text: string, seq: number): EngineEvent {
  return { type: "serial", t: seq, seq, node, text };
}

const BOOT_LOOP = [
  "[OT FIRMWARE] ready",
  "ets Jul 29 2019 12:21:46",
  "rst:0x8 (TG1WDT_SYS_RESET),boot:0x12 (SPI_FAST_FLASH_BOOT)",
  "rst:0x7 (TG0WDT_SYS_RESET),boot:0x12 (SPI_FAST_FLASH_BOOT)",
];

Deno.test("board limits: a watchdog reset loop on an esp32 node is named as a fidelity limit", () => {
  const warnings = boardLimitWarnings(
    [{ id: "a", board: "esp32" }],
    BOOT_LOOP.map((text, i) => serial("a", text, i)),
  );
  assertEquals(warnings.length, 1);
  assertEquals(
    warnings[0]?.startsWith("a: interrupt watchdog reset loop (2 watchdog resets"),
    true,
  );
  assertEquals(warnings[0]?.includes("DHT11/DHT22"), true);
});

Deno.test("board limits: a single watchdog reset is not a loop", () => {
  const events = BOOT_LOOP.slice(0, 3).map((text, i) => serial("a", text, i));
  assertEquals(boardLimitWarnings([{ id: "a", board: "esp32" }], events), []);
});

Deno.test("board limits: only the esp32 node whose serial shows the loop is named", () => {
  const events = [
    ...BOOT_LOOP.map((text, i) => serial("a", text, i)),
    serial("b", "rst:0x1 (POWERON_RESET),boot:0x12 (SPI_FAST_FLASH_BOOT)", 10),
  ];
  const nodes = [
    { id: "a", board: "esp32" as const },
    { id: "b", board: "esp32" as const },
    { id: "c", board: "scripted" as const },
  ];
  assertEquals(boardLimitWarnings(nodes, events).map((w) => w.slice(0, 2)), ["a:"]);
  // A scripted node with the same lines is not an emulated ESP32.
  assertEquals(
    boardLimitWarnings(
      [{ id: "c", board: "scripted" }],
      BOOT_LOOP.map((text, i) => serial("c", text, i)),
    ),
    [],
  );
});

const BT_LOOP = [
  "assert failed: esp_bt_controller_init bt.c:1555 (select_src_ret && set_div_ret)",
  "Rebooting...",
];

Deno.test("board limits: the classic Bluetooth assert on an esp32 node is named as a fidelity limit", () => {
  const warnings = boardLimitWarnings(
    [{ id: "a", board: "esp32" }, { id: "b", board: "esp32" }, { id: "c", board: "scripted" }],
    [
      ...BT_LOOP.map((text, i) => serial("a", text, i)),
      ...BT_LOOP.map((text, i) => serial("c", text, 10 + i)),
      serial("b", "[OT FIRMWARE] ready", 20),
    ],
  );
  assertEquals(warnings, [
    "a: classic Bluetooth is not simulated; this firmware cannot run on the esp32 board",
  ]);
});

async function withSketch(
  files: Record<string, string>,
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "hzb-limits-" });
  try {
    for (const [name, text] of Object.entries(files)) {
      await Deno.writeTextFile(`${dir}/${name}`, text);
    }
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("board limits: a sketch that includes BluetoothSerial.h is flagged before compiling", async () => {
  await withSketch(
    { "a.ino": '#include "BluetoothSerial.h"\nBluetoothSerial SerialBT;\nvoid setup() {}\n' },
    async (dir) => {
      const warnings = await sketchLimitWarnings([
        { id: "a", board: "esp32", firmware: { kind: "sketch", path: dir } },
      ]);
      assertEquals(warnings, [
        "a: a.ino includes BluetoothSerial.h; classic Bluetooth is not simulated; " +
        "this firmware cannot run on the esp32 board",
      ]);
    },
  );
});

Deno.test("board limits: the angle-bracket include in a header is flagged too; a comment is not", async () => {
  await withSketch(
    {
      "a.ino": "// #include <BluetoothSerial.h>\nvoid setup() {}\n",
      "bt.h": "#include <BluetoothSerial.h>\n",
    },
    async (dir) => {
      const warnings = await sketchLimitWarnings([
        { id: "a", board: "esp32", firmware: { kind: "sketch", path: dir } },
      ]);
      assertEquals(warnings.length, 1);
      assertEquals(warnings[0]?.startsWith("a: bt.h includes"), true);
    },
  );
});

Deno.test("board limits: sketches without it, other boards, binaries and missing directories give no sketch warning", async () => {
  await withSketch({ "a.ino": "#include <WiFi.h>\nvoid setup() {}\n" }, async (dir) => {
    assertEquals(
      await sketchLimitWarnings([
        { id: "a", board: "esp32", firmware: { kind: "sketch", path: dir } },
        { id: "b", board: "esp32", firmware: { kind: "binary", path: `${dir}/a.ino` } },
        { id: "c", board: "esp32", firmware: { kind: "sketch", path: `${dir}/nope` } },
      ]),
      [],
    );
  });
  await withSketch({ "a.ino": '#include "BluetoothSerial.h"\n' }, async (dir) => {
    assertEquals(
      await sketchLimitWarnings([
        { id: "a", board: "android", firmware: { kind: "sketch", path: dir } },
      ]),
      [],
    );
  });
});

Deno.test("compile failure: a text section overflow hints at a larger app partition", () => {
  const overflow = compileFailureMessage(
    "fw/a",
    "region `iram0_0_seg' overflowed\nsketch.ino.elf section `.text' will not fit\n" +
      "text section exceeds available space in board",
  );
  assertEquals(overflow.startsWith("compiling fw/a failed:\n"), true);
  assertEquals(overflow.includes("text section exceeds available space in board"), true);
  assertEquals(overflow.includes("larger app partition"), true);
  assertEquals(
    compileFailureMessage("fw/a", "error: 'foo' was not declared"),
    "compiling fw/a failed:\nerror: 'foo' was not declared",
  );
});
