// The path of `android prepare` and of an android node in `hertzbench run`, on a Windows host.
// The host is data (`fakeHostEnv("windows")`) and the commands the launcher itself runs go
// through an injected runner, so this runs on Linux: nothing here is a real Windows machine.
// The fake emulator.exe and adb.exe are sh scripts, so the launch tests skip on Windows.

import { join } from "node:path";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { createAndroidAppLauncher } from "../orchestrator/boards/android.ts";
import { findAndroidToolsOnHost } from "../orchestrator/boards/android/host.ts";
import { fakeCommandRunner, fakeHostEnv, fakeSdk } from "./android_fake_sdk.ts";
import { skipOnWindows } from "./platform.ts";

const androidTest = skipOnWindows("the fake emulator.exe and adb.exe are sh scripts");

const ADB = `shell) echo 1 ;;
wait-for-device) exit 0 ;;
install) echo Success ;;
logcat)
  if [ "$1" = "-c" ]; then exit 0; fi
  exec sleep 60 ;;
emu) kill "$(cat "$DIR/emulator-pid")" ;;`;

/** Every program the launcher starts through Deno.Command, with its arguments. */
async function recordingSpawns<T>(
  body: () => Promise<T>,
): Promise<{ result: T; spawned: { cmd: string; args: string[] }[] }> {
  const spawned: { cmd: string; args: string[] }[] = [];
  const Original = Deno.Command;
  Deno.Command = class extends Original {
    constructor(cmd: string | URL, options?: Deno.CommandOptions) {
      spawned.push({ cmd: String(cmd), args: options?.args ?? [] });
      super(cmd, options);
    }
  };
  try {
    return { result: await body(), spawned };
  } finally {
    Deno.Command = Original;
  }
}

/** Boots the app of a BLE scenario on a windows host against a fake SDK, then stops it. */
async function bootAndStopOnWindows() {
  const sdk = await fakeSdk(ADB, undefined, "windows");
  const work = await Deno.makeTempDir({ prefix: "hzb-android-windows-" });
  try {
    await Deno.writeTextFile(join(work, "app.apk"), "PK");
    // `emulator -accel-check` goes through the injected runner, answered as WHPX does on Windows.
    const runner = fakeCommandRunner(() => ({ stdout: "WHPX(10.0.22631) is installed\n" }));
    const launcher = createAndroidAppLauncher({
      host: fakeHostEnv("windows"),
      runner,
      tools: { emulator: sdk.emulator, adb: sdk.adb },
    });
    const { result: stopMs, spawned } = await recordingSpawns(async () => {
      const board = await launcher.start({
        id: "phone",
        app: {
          avd: "pixel8",
          package: "dev.example.app",
          extras: {},
          logcat: [],
          bootTimeoutMs: 20_000,
          installTimeoutMs: 20_000,
          launchTimeoutMs: 20_000,
          apk: join(work, "app.apk"),
        },
        hciPort: 1234,
        outDir: work,
        onSerial: () => {},
      });
      const started = performance.now();
      await board.stop();
      return performance.now() - started;
    });
    return {
      sdk,
      spawned,
      stopMs,
      accelCalls: runner.calls,
      adbCalls: await Deno.readTextFile(join(sdk.dir, "adb-calls")),
      log: await Deno.readTextFile(join(work, "phone-emulator.log")),
    };
  } finally {
    await sdk.restore();
    await Deno.remove(work, { recursive: true });
  }
}

androidTest(
  "windows host: stop asks adb.exe for `emu kill` and does not wait for a signal",
  async () => {
    const run = await bootAndStopOnWindows();
    assertStringIncludes(run.adbCalls, "emu kill");
    // The 10 s grace before the forced kill never ran: `adb emu kill` ended the emulator.
    assert(run.stopMs < 5_000, `stop took ${run.stopMs} ms`);
    assertStringIncludes(run.log, "(cold boot)");
    assert(run.spawned.some((call) => call.cmd.endsWith("adb.exe") && call.args.includes("kill")));
  },
);

androidTest(
  "windows host: /dev/null is not used, and the accelerator is checked by the runner",
  async () => {
    const run = await bootAndStopOnWindows();
    assertEquals(run.accelCalls, [{ cmd: run.sdk.emulator, args: ["-accel-check"] }]);
    for (const call of [...run.spawned, ...run.accelCalls]) {
      assert(
        ![call.cmd, ...call.args].some((word) => word.includes("/dev/")),
        JSON.stringify(call),
      );
    }
  },
);

androidTest("windows host: no sh is spawned, only emulator.exe and adb.exe", async () => {
  const run = await bootAndStopOnWindows();
  assert(run.spawned.length > 0);
  for (const call of [...run.spawned, ...run.accelCalls]) {
    assert(/(emulator|adb)\.exe$/.test(call.cmd), `spawned ${call.cmd}`);
  }
});

androidTest(
  "windows host: a failing accelerator check stops the launch and names WHPX",
  async () => {
    const runner = fakeCommandRunner(() => ({ code: 1, stderr: "HAXM is not installed" }));
    const launcher = createAndroidAppLauncher({
      host: fakeHostEnv("windows"),
      runner,
      tools: {
        emulator: "C:\\sdk\\emulator\\emulator.exe",
        adb: "C:\\sdk\\platform-tools\\adb.exe",
      },
    });
    const error = await assertRejects(() =>
      launcher.start({
        id: "phone",
        app: {
          avd: "pixel8",
          package: "dev.example.app",
          extras: {},
          logcat: [],
          bootTimeoutMs: 1,
          installTimeoutMs: 1,
          launchTimeoutMs: 1,
          apk: "app.apk",
        },
        hciPort: 1234,
        outDir: ".",
        onSerial: () => {},
      })
    );
    assertStringIncludes((error as Error).message, "phone: hardware acceleration");
    assertStringIncludes((error as Error).message, "Windows Hypervisor Platform");
  },
);

Deno.test("windows host: tools are found by their .exe names on PATH, then in the SDK root", () => {
  const sdk = "C:\\Users\\tester\\AppData\\Local\\Android\\Sdk";
  const files = new Set([
    "C:\\Tools\\adb.exe",
    `${sdk}\\emulator\\emulator.exe`,
    `${sdk}\\platform-tools\\adb.exe`,
    sdk,
  ]);
  const exists = (path: string) => files.has(path);
  const host = fakeHostEnv("windows", { env: { PATH: "C:\\Windows;C:\\Tools" } });
  assertEquals(findAndroidToolsOnHost(host, exists), {
    emulator: `${sdk}\\emulator\\emulator.exe`,
    adb: "C:\\Tools\\adb.exe",
  });
  // ANDROID_HOME wins over the default location.
  files.add("D:\\Sdk").add("D:\\Sdk\\emulator\\emulator.exe").add(
    "D:\\Sdk\\platform-tools\\adb.exe",
  );
  const custom = fakeHostEnv("windows", { env: { ANDROID_HOME: "D:\\Sdk" } });
  assertEquals(findAndroidToolsOnHost(custom, exists), {
    emulator: "D:\\Sdk\\emulator\\emulator.exe",
    adb: "D:\\Sdk\\platform-tools\\adb.exe",
  });
});

Deno.test("windows host: a missing SDK says where it looked, with Windows separators", () => {
  const error = assertThrows(() => findAndroidToolsOnHost(fakeHostEnv("windows"), () => false));
  assertStringIncludes((error as Error).message, "emulator and adb not found");
  assertStringIncludes((error as Error).message, "C:\\Users\\tester\\AppData\\Local\\Android\\Sdk");
});
