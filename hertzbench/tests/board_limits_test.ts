import { assertEquals } from "@std/assert";
import type { EngineEvent } from "../engine/mod.ts";
import { boardLimitWarnings } from "../orchestrator/board-limits.ts";

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
