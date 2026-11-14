// `hertzbench android prepare <avd>` on a Windows host. The host is data (`fakeHostEnv("windows")`),
// the files the tool lookup sees are a set of Windows paths, and the commands the launcher itself
// runs go through an injected runner, so this runs on Linux: it is not a real Windows machine.
// The fake emulator.exe and adb.exe are sh scripts, so the test that boots one skips on Windows.

import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { androidCommand } from "../cli/android.ts";
import { type PrepareOptions, prepareSnapshot } from "../orchestrator/boards/android/tooling.ts";
import { fakeAvdHome, fakeCommandRunner, fakeHostEnv, fakeSdk } from "./android_fake_sdk.ts";
import { skipOnWindows } from "./platform.ts";

const androidTest = skipOnWindows("the fake emulator.exe and adb.exe are sh scripts");

const SDK = "C:\\Users\\tester\\AppData\\Local\\Android\\Sdk";
const SDK_EMULATOR = `${SDK}\\emulator\\emulator.exe`;
const SDK_ADB = `${SDK}\\platform-tools\\adb.exe`;
const WINDOWS_SDK_FILES = new Set([SDK, SDK_EMULATOR, SDK_ADB]);

const SAVE_OK = `shell) echo 1 ;;
wait-for-device) exit 0 ;;
emu) if [ "$1" = avd ]; then echo OK; exit 0; fi; kill "$(cat "$DIR/emulator-pid")" ;;`;

/** What `body` writes to the console, and what it returns. */
async function captured<T>(body: () => Promise<T>) {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  console.log = (...args: unknown[]) => void out.push(args.join(" "));
  console.error = (...args: unknown[]) => void err.push(args.join(" "));
  try {
    return { result: await body(), out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

Deno.test("android prepare on windows: the tools are found as emulator.exe and adb.exe", async () => {
  const host = fakeHostEnv("windows", { env: { PATH: "C:\\Windows;C:\\Tools" } });
  const runner = fakeCommandRunner();
  let given: { tools: unknown; avd: string; options?: PrepareOptions } | undefined;
  const run = await captured(() =>
    androidCommand(["prepare", "pixel8"], {
      host,
      runner,
      exists: (path) => WINDOWS_SDK_FILES.has(path),
      prepare: (tools, avd, options) => {
        given = { tools, avd, options };
        return Promise.resolve({
          snapshotDir: "C:\\avd\\snapshots\\hertzbench",
          emulatorVersion: "1",
        });
      },
    })
  );
  assertEquals(run.result, 0);
  assertEquals(given?.tools, { emulator: SDK_EMULATOR, adb: SDK_ADB });
  assertEquals(given?.avd, "pixel8");
  // The same host and runner reach the acceleration gate, not this machine's.
  assertEquals(given?.options?.host, host);
  assertEquals(given?.options?.runner, runner);
  assertStringIncludes(run.out, "pixel8: snapshot hertzbench saved in C:\\avd\\snapshots");
});

Deno.test("android prepare on windows: a missing SDK names the Windows default location", async () => {
  const run = await captured(() =>
    androidCommand(["prepare", "pixel8"], { host: fakeHostEnv("windows"), exists: () => false })
  );
  assertEquals(run.result, 2);
  assertStringIncludes(run.err, "hertzbench: emulator and adb not found");
  assertStringIncludes(run.err, SDK);
});

/** Runs prepare for a windows host whose tools are the fake SDK's emulator.exe and adb.exe. */
async function prepareOnWindows(accelOutput: { code: number; stdout: string; stderr: string }) {
  const sdk = await fakeSdk(SAVE_OK, undefined, "windows");
  const avd = await fakeAvdHome("pixel8", null);
  try {
    const runner = fakeCommandRunner(() => accelOutput);
    let found: { emulator: string; adb: string } | undefined;
    const run = await captured(() =>
      androidCommand(["prepare", "pixel8"], {
        host: fakeHostEnv("windows"),
        runner,
        exists: (path) => WINDOWS_SDK_FILES.has(path),
        env: (name) => name === "ANDROID_AVD_HOME" ? avd.home : undefined,
        // The finder ran on the windows host; the snapshot step then runs the fake SDK's scripts.
        prepare: (tools, name, options) => {
          found = tools;
          return prepareSnapshot({ emulator: sdk.emulator, adb: sdk.adb }, name, options);
        },
      })
    );
    return { run, runner, found, sdk, avd };
  } finally {
    await sdk.restore();
    await avd.remove();
  }
}

androidTest("android prepare on windows: the acceleration gate accepts WHPX", async () => {
  const { run, runner, found, sdk, avd } = await prepareOnWindows({
    code: 0,
    stdout: "WHPX(10.0.22631) is installed\n",
    stderr: "",
  });
  assertEquals(run.result, 0, run.err);
  assertEquals(found, { emulator: SDK_EMULATOR, adb: SDK_ADB });
  // The gate asked emulator.exe, through the runner, not `kvm` and not a real device node.
  assertEquals(runner.calls.length, 1);
  assertEquals(runner.calls[0]!.args, ["-accel-check"]);
  assert(runner.calls[0]!.cmd.endsWith("emulator.exe"), runner.calls[0]!.cmd);
  assertStringIncludes(run.out, `saved in ${join(avd.avdDir, "snapshots", "hertzbench")}`);
  assert(sdk.emulator.endsWith("emulator.exe"));
});

androidTest("android prepare on windows: no accelerator stops it with the WHPX hint", async () => {
  const { run } = await prepareOnWindows({ code: 1, stdout: "", stderr: "HAXM is not installed" });
  assertEquals(run.result, 2);
  assertStringIncludes(run.err, "Windows Hypervisor Platform");
});
