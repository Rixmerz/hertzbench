// The Android tooling module against fake `emulator` and `adb` scripts on PATH: no
// SDK and no emulator are needed. Each step's timeout fires and names the step, and
// a failed install quotes adb. The scripts are POSIX sh, so these tests skip on Windows.

import { join } from "node:path";
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  AndroidStepError,
  avdDirectory,
  findAndroidTools,
  kvmProblem,
  launchEmulator,
  listAvds,
  preparedSnapshot,
  prepareSnapshot,
  type RunningEmulator,
  snapshotBootArgs,
  wifiSocketArgs,
} from "../orchestrator/boards/android/tooling.ts";
import { BoardError } from "../orchestrator/boards/board.ts";
import { FAKE_EMULATOR_VERSION, fakeAvdHome, fakeSdk } from "./android_fake_sdk.ts";
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

// ── snapshots (piece 6) ─────────────────────────────────────────────────────

const envOf = (vars: Record<string, string>) => (name: string) => vars[name];

Deno.test("avdDirectory follows the AVD's .ini to where the AVD really is", async () => {
  const home = await Deno.makeTempDir({ prefix: "hzb-avd-ini-" });
  const elsewhere = await Deno.makeTempDir({ prefix: "hzb-avd-elsewhere-" });
  try {
    await Deno.writeTextFile(
      join(home, "moved.ini"),
      `avd.ini.encoding=UTF-8\npath=${elsewhere}\n`,
    );
    await Deno.mkdir(join(home, "plain.avd"));
    const env = envOf({ ANDROID_AVD_HOME: home });
    assertEquals(avdDirectory("moved", env), elsewhere);
    assertEquals(avdDirectory("plain", env), join(home, "plain.avd"));
    assertEquals(avdDirectory("absent", env), null);
    // $ANDROID_USER_HOME/avd and ~/.android/avd come after $ANDROID_AVD_HOME
    await Deno.mkdir(join(home, "avd", "user.avd"), { recursive: true });
    assertEquals(
      avdDirectory("user", envOf({ ANDROID_USER_HOME: home })),
      join(home, "avd", "user.avd"),
    );
    await Deno.mkdir(join(home, ".android", "avd", "dot.avd"), { recursive: true });
    assertEquals(
      avdDirectory("dot", envOf({ HOME: home })),
      join(home, ".android", "avd", "dot.avd"),
    );
  } finally {
    await Deno.remove(home, { recursive: true });
    await Deno.remove(elsewhere, { recursive: true });
  }
});

Deno.test("preparedSnapshot: usable only with a marker made by this emulator build", async () => {
  const ready = await fakeAvdHome("pixel8", { emulator: FAKE_EMULATOR_VERSION });
  const bare = await fakeAvdHome("pixel8", null);
  try {
    const env = (home: string) => envOf({ ANDROID_AVD_HOME: home });
    assertEquals(preparedSnapshot("pixel8", FAKE_EMULATOR_VERSION, env(ready.home)), {
      usable: true,
    });

    const stale = preparedSnapshot("pixel8", "38.0.0.0", env(ready.home));
    assert(!stale.usable);
    assertStringIncludes(stale.reason, `prepared with emulator ${FAKE_EMULATOR_VERSION}`);
    assertStringIncludes(stale.reason, "this is 38.0.0.0");
    assertStringIncludes(stale.reason, "hertzbench android prepare pixel8");

    const none = preparedSnapshot("pixel8", FAKE_EMULATOR_VERSION, env(bare.home));
    assert(!none.usable);
    assertStringIncludes(none.reason, "pixel8 has no prepared snapshot");

    const unknown = preparedSnapshot("tablet", FAKE_EMULATOR_VERSION, env(bare.home));
    assert(!unknown.usable);
    assertStringIncludes(unknown.reason, "no directory found for the AVD tablet");
  } finally {
    await ready.remove();
    await bare.remove();
  }
});

Deno.test("the snapshot and Wi-Fi socket flags are spelled as the emulator reads them", () => {
  assertEquals(snapshotBootArgs("02:68:7a:62:01:02"), [
    "-snapshot",
    "hertzbench",
    "-force-snapshot-load",
    "-wifi-mac-address",
    "02:68:7a:62:01:02",
  ]);
  assertEquals(wifiSocketArgs(4321), [
    "-feature",
    "-WiFiPacketStream",
    "-wifi-socket",
    "connect=127.0.0.1:4321",
  ]);
});

androidTest("two emulators launched back to back get different console ports", async () => {
  const sdk = await fakeSdk(
    `emu) kill "$(cat "$DIR/emulator-pid-\${serial#emulator-}")" ;;`,
    `port=""; prev=""
for arg in "$@"; do if [ "$prev" = "-port" ]; then port="$arg"; fi; prev="$arg"; done
echo $$ > "$DIR/emulator-pid-$port"
exec sleep 60`,
  );
  const first = launchEmulator(findAndroidTools(), { avd: "pixel8" });
  const second = launchEmulator(findAndroidTools(), { avd: "pixel8" });
  try {
    // Neither fake binds its port, so only the claim keeps the second pick from the first's port.
    assert(first.port !== second.port, `both took ${first.port}`);
    assertEquals(first.serial, `emulator-${first.port}`);
    await first.kill();
    // a stopped emulator gives its port back
    const third = launchEmulator(findAndroidTools(), { avd: "pixel8" });
    assertEquals(third.port, first.port);
    await third.kill();
  } finally {
    await second.kill();
    await first.kill();
    await sdk.restore();
  }
});

const SAVE_OK = BOOTED.replace(
  "emu) kill",
  'emu) if [ "$1" = avd ]; then echo OK; exit 0; fi; kill',
);

/**
 * The pieces `prepareSnapshot` needs around a fake SDK: an AVD tree that already holds a marker of
 * an older build, and an emulator that records its arguments and the Wi-Fi port it was given.
 */
async function prepareRig(adb: string) {
  const avd = await fakeAvdHome("pixel8", { emulator: "old build" });
  const sdk = await fakeSdk(
    adb,
    `echo "$@" > "$DIR/emulator-args"; echo $$ > "$DIR/emulator-pid"
for arg in "$@"; do last="$arg"; done
echo "\${last##*:}" > "$DIR/wifi-port"
exec sleep 60`,
  );
  return {
    sdk,
    avd,
    env: envOf({ ANDROID_AVD_HOME: avd.home }),
    async remove() {
      await sdk.restore();
      await avd.remove();
    },
  };
}

androidTest(
  "prepare: boots writable and cold with the run's Wi-Fi flags, saves the snapshot, marks it, stops",
  async () => {
    const rig = await prepareRig(SAVE_OK);
    try {
      const marker = join(rig.avd.avdDir, "snapshots", "hertzbench", "hertzbench.json");
      const result = await prepareSnapshot(findAndroidTools(), "pixel8", {
        checkKvm: () => null,
        env: rig.env,
      });
      assertEquals(result.snapshotDir, join(rig.avd.avdDir, "snapshots", "hertzbench"));
      assertEquals(result.emulatorVersion, FAKE_EMULATOR_VERSION);
      assertEquals(JSON.parse(await Deno.readTextFile(marker)), {
        emulator: FAKE_EMULATOR_VERSION,
      });
      assertEquals(preparedSnapshot("pixel8", FAKE_EMULATOR_VERSION, rig.env), { usable: true });

      const args = await Deno.readTextFile(join(rig.sdk.dir, "emulator-args"));
      assertStringIncludes(
        args,
        "-avd pixel8 -no-window -no-audio -no-boot-anim -no-snapshot-load",
      );
      assertStringIncludes(args, "-no-snapshot-save -gpu swiftshader_indirect -port ");
      assertStringIncludes(args, "-feature -WiFiPacketStream -wifi-socket connect=127.0.0.1:");
      assert(!args.includes("-read-only"), `a snapshot cannot be saved read-only: ${args}`);
      const calls = await Deno.readTextFile(join(rig.sdk.dir, "adb-calls"));
      assertStringIncludes(calls, " emu avd snapshot save hertzbench");
      assert(
        calls.indexOf("snapshot save") < calls.indexOf("emu kill"),
        "the snapshot is saved before the emulator is stopped",
      );
    } finally {
      await rig.remove();
    }
  },
);

androidTest("prepare: the emulator's Wi-Fi socket has a listener to connect to", async () => {
  // The fake emulator only records the port; the save waits for the probe's connection to it.
  const rig = await prepareRig(
    SAVE_OK.replace(
      "echo OK;",
      'n=0; while [ ! -f "$DIR/probed" ] && [ $n -lt 100 ]; do sleep 0.05; n=$((n+1)); done; echo OK;',
    ),
  );
  try {
    let connected = false;
    const probe = (async () => {
      for (let i = 0; i < 200 && !connected; i++) {
        try {
          const port = Number((await Deno.readTextFile(join(rig.sdk.dir, "wifi-port"))).trim());
          (await Deno.connect({ hostname: "127.0.0.1", port })).close();
          connected = true;
          await Deno.writeTextFile(join(rig.sdk.dir, "probed"), "");
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
    })();
    await prepareSnapshot(findAndroidTools(), "pixel8", { checkKvm: () => null, env: rig.env });
    await probe;
    assert(connected, "nothing listened on the port given to -wifi-socket");
  } finally {
    await rig.remove();
  }
});

androidTest(
  "prepare: a refused save names the snapshot step, quotes the console and drops the old marker",
  async () => {
    const rig = await prepareRig(
      SAVE_OK.replace("echo OK;", "echo 'KO: not enough disk'; exit 0;"),
    );
    try {
      const error = await assertRejects(
        () => prepareSnapshot(findAndroidTools(), "pixel8", { checkKvm: () => null, env: rig.env }),
        AndroidStepError,
      );
      assertEquals(error.step, "snapshot");
      assertStringIncludes(error.message, "KO: not enough disk");
      assertEquals(
        preparedSnapshot("pixel8", FAKE_EMULATOR_VERSION, rig.env).usable,
        false,
        "the marker of an earlier snapshot must not vouch for a failed save",
      );
      assertStringIncludes(await Deno.readTextFile(join(rig.sdk.dir, "adb-calls")), "emu kill");
    } finally {
      await rig.remove();
    }
  },
);

androidTest(
  "prepare: no KVM, an unknown AVD and an AVD without a directory stop it before boot",
  async () => {
    const rig = await prepareRig(SAVE_OK);
    try {
      const tools = findAndroidTools();
      const run = (avd: string, checkKvm: () => string | null) =>
        assertRejects(() => prepareSnapshot(tools, avd, { checkKvm, env: rig.env }), BoardError);
      assertStringIncludes((await run("pixel8", () => "no /dev/kvm")).message, "no /dev/kvm");
      assertStringIncludes(
        (await run("nope", () => null)).message,
        "no AVD named nope (found: pixel8, tablet)",
      );
      // "tablet" is listed by the fake emulator but has no directory under the AVD home
      assertStringIncludes(
        (await run("tablet", () => null)).message,
        "no directory found for the AVD tablet",
      );
      await assertRejects(
        () => Deno.readTextFile(join(rig.sdk.dir, "emulator-args")),
        Deno.errors.NotFound,
      );
    } finally {
      await rig.remove();
    }
  },
);
