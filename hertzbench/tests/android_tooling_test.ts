// The Android tooling module against fake `emulator` and `adb` scripts on PATH: no
// SDK and no emulator are needed. Each step's timeout fires and names the step, and
// a failed install quotes adb. The scripts are POSIX sh, so these tests skip on Windows.

import { join } from "node:path";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  AndroidStepError,
  findAndroidTools,
  kvmProblem,
  launchEmulator,
  listAvds,
  type RunningEmulator,
} from "../orchestrator/boards/android/tooling.ts";
import { fakeSdk } from "./android_fake_sdk.ts";
import { skipOnWindows } from "./platform.ts";

const androidTest = skipOnWindows("the fake emulator and adb are sh scripts");

const BOOTED = `shell) echo 1 ;;
wait-for-device) exit 0 ;;
emu) kill "$(cat "$DIR/emulator-pid")" ;;`;

async function withEmulator(
  sdk: { restore(): Promise<void> },
  body: (emulator: RunningEmulator) => Promise<void>,
): Promise<void> {
  const emulator = launchEmulator(findAndroidTools(), { avd: "pixel8" });
  try {
    await body(emulator);
  } finally {
    await emulator.kill();
    await sdk.restore();
  }
}

androidTest(
  "finds the tools on PATH and lists the AVDs, skipping emulator info lines",
  async () => {
    const sdk = await fakeSdk(BOOTED);
    try {
      const tools = findAndroidTools();
      assertEquals(tools.emulator, join(sdk.dir, "emulator"));
      assertEquals(tools.adb, join(sdk.dir, "adb"));
      assertEquals(await listAvds(tools.emulator), ["pixel8", "tablet"]);
    } finally {
      await sdk.restore();
    }
  },
);

androidTest("falls back to $ANDROID_HOME when PATH has neither tool", async () => {
  const home = await Deno.makeTempDir({ prefix: "hzb-android-home-" });
  try {
    await Deno.mkdir(join(home, "emulator"));
    await Deno.mkdir(join(home, "platform-tools"));
    await Deno.writeTextFile(join(home, "emulator", "emulator"), "#!/bin/sh\n");
    await Deno.writeTextFile(join(home, "platform-tools", "adb"), "#!/bin/sh\n");
    const env: Record<string, string> = { ANDROID_HOME: home, PATH: "" };
    const tools = findAndroidTools((name) => env[name]);
    assertEquals(tools.emulator, join(home, "emulator", "emulator"));
    assertEquals(tools.adb, join(home, "platform-tools", "adb"));
    const error = await assertRejects(
      () => Promise.resolve().then(() => findAndroidTools(() => undefined)),
    );
    assertStringIncludes((error as Error).message, "emulator and adb not found");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("kvmProblem names the device it could not open", async () => {
  if (Deno.build.os !== "linux") return;
  // Not under /dev: Deno refuses every /dev path without --allow-all, whatever is there.
  const dir = await Deno.makeTempDir({ prefix: "hzb-kvm-" });
  try {
    const device = join(dir, "no-such-kvm");
    assertStringIncludes(kvmProblem(device) ?? "", device);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// Linux only: Deno's refusal of /dev paths is what this probes, and on macOS and Windows
// kvmProblem answers before opening anything ("only wired for Linux").
Deno.test({
  name: `kvmProblem does not mistake Deno's own permission wall for a missing KVM${
    Deno.build.os === "linux" ? "" : " [skipped: Deno's /dev permission wall is Linux-only]"
  }`,
  ignore: Deno.build.os !== "linux",
  fn: async () => {
    // The CLI task has no --allow-all, and Deno refuses /dev/kvm without it; a process with no
    // permission at all meets the same refusal.
    const dir = await Deno.makeTempDir({ prefix: "hzb-kvm-" });
    try {
      const module = new URL("../orchestrator/boards/android/tooling.ts", import.meta.url).href;
      const script = join(dir, "probe.ts");
      await Deno.writeTextFile(
        script,
        `import { kvmProblem } from ${
          JSON.stringify(module)
        };\nconsole.log(kvmProblem("/dev/kvm"));\n`,
      );
      const { stdout, success, stderr } = await new Deno.Command(Deno.execPath(), {
        args: ["run", "--no-prompt", script],
      }).output();
      assert(success, new TextDecoder().decode(stderr));
      assertEquals(new TextDecoder().decode(stdout).trim(), "null");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

androidTest("launches with the headless flags, boots, installs, launches and kills", async () => {
  const sdk = await fakeSdk(`${BOOTED}
install) echo Performing Streamed Install; echo Success ;;
logcat) if [ "$1" = "-c" ]; then exit 0; fi; echo "HZB got temp 21.5"; exec sleep 60 ;;`);
  await withEmulator(sdk, async (emulator) => {
    await emulator.waitForBoot(5000, 20);
    const lines: string[] = [];
    const logcat = await emulator.logcat(["HZB"], (line) => lines.push(line));
    await emulator.install("/tmp/app.apk", 5000);
    await emulator.launch(
      {
        package: "dev.example",
        activity: ".Main",
        extras: { board_url: "http://x/", note: "a b'c;" },
      },
      5000,
    );
    for (let i = 0; i < 100 && lines.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await logcat.stop();
    assertEquals(lines, ["HZB got temp 21.5"]);

    const args = await Deno.readTextFile(join(sdk_dir(), "emulator-args"));
    assertStringIncludes(args, "-avd pixel8 -no-window -no-audio -no-boot-anim -read-only");
    assertStringIncludes(args, "-no-snapshot-save -gpu swiftshader_indirect -port ");
    const calls = await Deno.readTextFile(join(sdk_dir(), "adb-calls"));
    assertStringIncludes(calls, `-s ${emulator.serial} install -r -t /tmp/app.apk`);
    assertStringIncludes(
      calls,
      // the device's shell sees each value as one word, whatever it contains
      "shell am start -W -n dev.example/.Main --es board_url 'http://x/' --es note 'a b'\\''c;'",
    );
    assertStringIncludes(calls, "logcat -v raw -s HZB:V");
    await emulator.kill();
    assert(emulator.hasExited());
    assertStringIncludes(await Deno.readTextFile(join(sdk_dir(), "adb-calls")), "emu kill");
  });
});

/** The directory of the fake tools currently first on PATH. */
function sdk_dir(): string {
  return findAndroidTools().adb.replace(/\/adb$/, "");
}

androidTest("boot timeout names the boot step and quotes the emulator log", async () => {
  const sdk = await fakeSdk(
    'shell) echo 0 ;;\nemu) kill "$(cat "$DIR/emulator-pid")" ;;',
    'echo "emulator is stuck" >&2; echo $$ > "$DIR/emulator-pid"; exec sleep 60',
  );
  await withEmulator(sdk, async (emulator) => {
    await new Promise((resolve) => setTimeout(resolve, 300)); // let the stderr line arrive
    const error = await assertRejects(() => emulator.waitForBoot(400, 50), AndroidStepError);
    assertEquals(error.step, "boot");
    assertStringIncludes(error.message, "within 400 ms (step: boot)");
    assertStringIncludes(error.message, "emulator is stuck");
  });
});

androidTest("boot fails early, with the log, when the emulator exits", async () => {
  const sdk = await fakeSdk("shell) echo 0 ;;", 'echo "no KVM" >&2; exit 1');
  await withEmulator(sdk, async (emulator) => {
    const error = await assertRejects(() => emulator.waitForBoot(5000, 50), AndroidStepError);
    assertEquals(error.step, "boot");
    assertStringIncludes(error.message, "exited before");
    assertStringIncludes(error.message, "no KVM");
  });
});

androidTest("a hung wait-for-device is the boot step's timeout too", async () => {
  const sdk = await fakeSdk(`shell) echo 1 ;;\nwait-for-device) exec sleep 60 ;;
emu) kill "$(cat "$DIR/emulator-pid")" ;;`);
  await withEmulator(sdk, async (emulator) => {
    const error = await assertRejects(() => emulator.waitForBoot(300, 20), AndroidStepError);
    assertEquals(error.step, "boot");
  });
});

androidTest("install timeout names the install step", async () => {
  const sdk = await fakeSdk(`install) exec sleep 60 ;;\nemu) kill "$(cat "$DIR/emulator-pid")" ;;`);
  await withEmulator(sdk, async (emulator) => {
    const error = await assertRejects(
      () => emulator.install("/tmp/app.apk", 300),
      AndroidStepError,
    );
    assertEquals(error.step, "install");
    assertStringIncludes(error.message, "timed out after 300 ms (step: install)");
  });
});

androidTest("a failed install quotes adb's output", async () => {
  const sdk = await fakeSdk(`install)
  echo "adb: failed to install /tmp/app.apk: Failure [INSTALL_FAILED_VERSION_DOWNGRADE]" >&2
  exit 1 ;;
emu) kill "$(cat "$DIR/emulator-pid")" ;;`);
  await withEmulator(sdk, async (emulator) => {
    const error = await assertRejects(
      () => emulator.install("/tmp/app.apk", 5000),
      AndroidStepError,
    );
    assertEquals(error.step, "install");
    assertStringIncludes(error.message, "Failure [INSTALL_FAILED_VERSION_DOWNGRADE]");
  });
});

androidTest("launch timeout names the launch step", async () => {
  const sdk = await fakeSdk(`shell) exec sleep 60 ;;\nemu) kill "$(cat "$DIR/emulator-pid")" ;;`);
  await withEmulator(sdk, async (emulator) => {
    const error = await assertRejects(
      () => emulator.launch({ package: "dev.example" }, 300),
      AndroidStepError,
    );
    assertEquals(error.step, "launch");
    assertStringIncludes(error.message, "timed out after 300 ms (step: launch)");
  });
});

androidTest("am start printing Error even with exit 0 is a launch failure", async () => {
  const sdk = await fakeSdk(`shell)
  echo "Error: Activity class {dev.example/.Gone} does not exist."
  exit 0 ;;
emu) kill "$(cat "$DIR/emulator-pid")" ;;`);
  await withEmulator(sdk, async (emulator) => {
    const error = await assertRejects(
      () => emulator.launch({ package: "dev.example", activity: ".Gone" }, 5000),
      AndroidStepError,
    );
    assertStringIncludes(error.message, "does not exist");
  });
});
