import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  avdRamMb,
  freeRamMb,
  ramWarning,
  warnIfLowRam,
} from "../orchestrator/boards/android/ram.ts";
import type { RamReaders } from "../orchestrator/boards/android/ram.ts";
import { fakeHostEnv } from "./android_fake_sdk.ts";

const readers = (files: Record<string, string> = {}, commands: Record<string, string> = {}) =>
  ({
    readFile: (path) => files[path],
    run: (cmd) => commands[cmd],
  }) satisfies RamReaders;

Deno.test("a 4 GB AVD on a host with 3 GB free warns with both numbers", () => {
  const line = ramWarning(4096, 3072);
  assertStringIncludes(line ?? "", "4096 MB");
  assertStringIncludes(line ?? "", "3072 MB");
  assertEquals(line?.includes("\n"), false);
});

Deno.test("no warning when the free memory covers the AVD", () => {
  assertEquals(ramWarning(4096, 4096), undefined);
  assertEquals(ramWarning(4096, 16384), undefined);
});

Deno.test("free RAM per platform", () => {
  assertEquals(
    freeRamMb(
      fakeHostEnv("linux"),
      readers({
        "/proc/meminfo": "MemTotal: 16000000 kB\nMemFree: 1000 kB\nMemAvailable: 3145728 kB\n",
      }),
    ),
    3072,
  );
  assertEquals(
    freeRamMb(fakeHostEnv("windows"), readers({}, { powershell: "2097152\r\n" })),
    2048,
  );
  assertEquals(
    freeRamMb(
      fakeHostEnv("darwin"),
      readers({}, {
        vm_stat: "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n" +
          "Pages free:                               65536.\n" +
          "Pages inactive:                           32768.\n" +
          "Pages speculative:                        32768.\n",
      }),
    ),
    2048,
  );
  assertEquals(freeRamMb(fakeHostEnv("linux"), readers()), undefined);
  assertEquals(freeRamMb(fakeHostEnv("windows"), readers({}, { powershell: "oops" })), undefined);
});

Deno.test("the AVD's RAM comes from hw.ramSize, 2048 when absent", () => {
  assertEquals(
    avdRamMb("/avd", readers({ "/avd/config.ini": "hw.lcd.density=420\nhw.ramSize=4096\n" })),
    4096,
  );
  assertEquals(avdRamMb("/avd", readers()), 2048);
});

Deno.test("warnIfLowRam prints one line for a 4 GB AVD on a loaded host, and stays quiet otherwise", () => {
  const files = (free: number) => ({
    "/avd/config.ini": "hw.ramSize=4096\n",
    "/proc/meminfo": `MemAvailable: ${free * 1024} kB\n`,
  });
  const printed: string[] = [];
  warnIfLowRam("/avd", fakeHostEnv("linux"), readers(files(1500)), (line) => printed.push(line));
  assertEquals(printed.length, 1);
  assertStringIncludes(printed[0]!, "4096 MB");
  assertStringIncludes(printed[0]!, "1500 MB");

  warnIfLowRam("/avd", fakeHostEnv("linux"), readers(files(8000)), (line) => printed.push(line));
  warnIfLowRam(null, fakeHostEnv("linux"), readers(files(1)), (line) => printed.push(line));
  warnIfLowRam("/avd", fakeHostEnv("linux"), readers(), (line) => printed.push(line));
  assertEquals(printed.length, 1);
});
