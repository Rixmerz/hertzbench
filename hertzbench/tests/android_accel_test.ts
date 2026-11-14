import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { BoardError } from "../orchestrator/boards/board.ts";
import { checkHardwareAcceleration } from "../orchestrator/boards/android/accel.ts";
import { processRunner } from "../orchestrator/boards/android/host.ts";
import { prepareSnapshot } from "../orchestrator/boards/android/tooling.ts";
import { fakeCommandRunner, fakeHostEnv, fakeSdk } from "./android_fake_sdk.ts";
import { skipOnWindows } from "./platform.ts";

const fakeSdkTest = skipOnWindows("the fake emulator and adb are sh scripts");
const WINDOWS_FIX = 'Enable "Windows Hypervisor Platform" in Windows Features and reboot.';

Deno.test("linux keeps the KVM check and never runs -accel-check", async () => {
  if (Deno.build.os !== "linux") return;
  const runner = fakeCommandRunner();
  const result = await checkHardwareAcceleration(fakeHostEnv("linux"), runner, "emulator");
  assertEquals(runner.calls, []);
  if (result.ok) {
    assertEquals(result.accelerator, "KVM");
  } else {
    // today's message, unchanged
    assertStringIncludes(result.message, "/dev/kvm is not usable: ");
    assertStringIncludes(
      result.message,
      "Enable virtualization and add your user to the kvm group.",
    );
  }
});

for (const accelerator of ["WHPX", "AEHD", "HAXM"]) {
  Deno.test(`windows accepts ${accelerator} from emulator -accel-check`, async () => {
    const runner = fakeCommandRunner(() => ({
      stdout: `accel:\n0\n${accelerator}(10.0.22631) is installed and usable.\naccel\n`,
    }));
    const result = await checkHardwareAcceleration(
      fakeHostEnv("windows"),
      runner,
      "C:\\sdk\\emulator\\emulator.exe",
    );
    assertEquals(result, { ok: true, accelerator });
    assertEquals(runner.calls, [{
      cmd: "C:\\sdk\\emulator\\emulator.exe",
      args: ["-accel-check"],
    }]);
  });
}

Deno.test("windows: exit 1 is not usable, the message quotes the output and names the fix", async () => {
  const output = "accel:\n1\nWHPX is not enabled: Hyper-V platform missing\naccel";
  const runner = fakeCommandRunner(() => ({ code: 1, stdout: output }));
  const result = await checkHardwareAcceleration(fakeHostEnv("windows"), runner, "emulator.exe");
  assert(!result.ok);
  assertEquals(result.output, output);
  assertStringIncludes(result.message, output);
  assertStringIncludes(result.message, WINDOWS_FIX);
});

Deno.test("windows: exit 0 without a known accelerator is not usable", async () => {
  const runner = fakeCommandRunner(() => ({ stdout: "accel:\n0\nno accelerator found\naccel" }));
  const result = await checkHardwareAcceleration(fakeHostEnv("windows"), runner, "emulator.exe");
  assert(!result.ok);
  assertStringIncludes(result.message, "no accelerator found");
  assertStringIncludes(result.message, WINDOWS_FIX);
});

Deno.test("windows: an emulator that cannot be started fails with its error quoted", async () => {
  const runner = {
    run: () => Promise.reject(new Error("program not found")),
  };
  const result = await checkHardwareAcceleration(fakeHostEnv("windows"), runner, "emulator.exe");
  assert(!result.ok);
  assertStringIncludes(result.message, "program not found");
});

Deno.test("darwin accepts HVF", async () => {
  const runner = fakeCommandRunner(() => ({ stdout: "accel:\n0\nHVF is available\naccel\n" }));
  const result = await checkHardwareAcceleration(fakeHostEnv("darwin"), runner, "emulator");
  assertEquals(result, { ok: true, accelerator: "HVF" });
  assertEquals(runner.calls, [{ cmd: "emulator", args: ["-accel-check"] }]);
});

Deno.test("darwin: not usable fails with the output quoted, and WHPX does not count", async () => {
  for (
    const [code, stdout] of [[1, "accel:\n1\nHVF is not supported\naccel"], [
      0,
      "accel:\n0\nWHPX is installed and usable.\naccel",
    ]] as const
  ) {
    const runner = fakeCommandRunner(() => ({ code, stdout }));
    const result = await checkHardwareAcceleration(fakeHostEnv("darwin"), runner, "emulator");
    assert(!result.ok);
    assertStringIncludes(result.message, stdout);
    assertStringIncludes(result.message, "HVF");
  }
});

fakeSdkTest(
  "prepare on windows runs the emulator's -accel-check and stops before boot",
  async () => {
    const sdk = await fakeSdk(
      "",
      `if [ "$1" = "-accel-check" ]; then echo 'accel:'; echo 1; echo 'WHPX is not enabled'; exit 1; fi; exit 9`,
      "windows",
    );
    try {
      const error = await assertRejects(
        () =>
          prepareSnapshot({ emulator: sdk.emulator, adb: sdk.adb }, "pixel8", {
            host: fakeHostEnv("windows"),
            runner: processRunner,
          }),
        BoardError,
      );
      assertStringIncludes(error.message, "WHPX is not enabled");
      assertStringIncludes(error.message, WINDOWS_FIX);
      assert(!error.message.includes("only wired for Linux"));
    } finally {
      await sdk.restore();
    }
  },
);
