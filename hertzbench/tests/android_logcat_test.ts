// Logcat as the Android node's serial lines (docs/android-device-plan.md, section 4): the
// launcher runs through the real runner against a fake emulator and a fake `adb logcat` that
// honours the `-s` tag filter, and the scenario's `serial:` assertions are judged on what the
// app "logged". No Android SDK is needed. The runs skip on Windows because the fake tools are
// sh scripts.

import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type AssertionResult,
  createAndroidLauncher,
  loadScenario,
  runScenario,
} from "../orchestrator/mod.ts";
import { fakeGuestSdk } from "./android_fake_sdk.ts";
import { skipOnWindows } from "./platform.ts";

const androidRun = skipOnWindows("the fake emulator and adb are sh scripts");

// Not derived from a console port, so the run takes any free port and a developer's own
// emulator on 5584 cannot break the test.
const GUEST_MAC = "02:aa:bb:cc:dd:ee";

// The fake logcat plays `logcat-buffer`, one `tag|text` per line. A line of tag `adb` is adb's
// own and always printed, `sleep` waits; any other tag is printed only if `-s` names it, as
// `HZB:V`. Lines end in CRLF like adb's. The final `exec sleep` keeps the stream open until
// stop() kills it, and no plain sleep may outlive it: a child of the killed sh would hold the
// pipe open.
const ADB = `shell) echo 1 ;;
wait-for-device) exit 0 ;;
install) echo Success ;;
logcat)
  if [ "$1" = "-c" ]; then exit 0; fi
  tags=" $* "
  while IFS='|' read -r tag text; do
    case "$tag" in
      sleep) sleep "$text" ;;
      adb) printf '%s\\r\\n' "$text" ;;
      *) case "$tags" in *" $tag:V "*) printf '%s\\r\\n' "$text" ;; esac ;;
    esac
  done < "$DIR/logcat-buffer"
  exec sleep 60 ;;
emu) kill "$(cat "$DIR/emulator-pid")" ;;`;

const BUFFER = [
  "adb|--------- beginning of main",
  "HZB|got temp 21.5",
  "Noise|chatter nobody subscribed to",
  "HZB|",
  "IotApp|ready",
  "sleep|1",
  "HZB|late line",
].join("\n");

/** Run a scenario whose phone logs `BUFFER` through the fake logcat; `logcat` is appended to its android section. */
async function runPhone(
  assertions: string[],
  { logcat = "", duration = "2s" }: { logcat?: string; duration?: string } = {},
) {
  const sdk = await fakeGuestSdk(ADB, GUEST_MAC);
  const work = await Deno.makeTempDir({ prefix: "hzb-android-logcat-" });
  try {
    await Deno.writeTextFile(join(sdk.dir, "logcat-buffer"), BUFFER + "\n");
    await Deno.writeTextFile(join(work, "app.apk"), "PK");
    await Deno.writeTextFile(
      join(work, "s.yaml"),
      `name: logcat
duration: ${duration}
nodes:
  - { id: web, board: scripted, position: [0, 0] }
  - id: phone
    board: android
    position: [3, 0]
    mac: ${GUEST_MAC}
    android: { avd: pixel8, apk: ./app.apk, package: dev.example.app${logcat} }
assertions:
${assertions.map((a) => `  - serial: { node: phone, ${a} }`).join("\n")}
`,
    );
    const loaded = await loadScenario(join(work, "s.yaml"), join(work, "out"));
    const result = await runScenario(loaded.scenario, {
      outDir: loaded.outDir,
      outputs: loaded.outputs,
      launchers: { android: createAndroidLauncher({ checkKvm: () => null }) },
    });
    const phoneLines = result.events.flatMap((e) =>
      e.type === "serial" && e.node === "phone" ? [e] : []
    );
    return {
      result,
      phoneLines,
      adbCalls: (await Deno.readTextFile(join(sdk.dir, "adb-calls"))).split("\n"),
      serialLog: await Deno.readTextFile(join(loaded.outDir, "serial-phone.log")),
    };
  } finally {
    await sdk.restore();
    await Deno.remove(work, { recursive: true });
  }
}

const verdicts = (results: AssertionResult[]) =>
  results.map((r) => [r.passed, r.detail.startsWith("seen at") ? "seen" : r.detail]);

androidRun(
  "android logcat: the subscribed tags become the phone's serial lines, in order, and serial assertions on them pass",
  async () => {
    const { result, phoneLines, adbCalls, serialLog } = await runPhone(
      [
        'contains: "got temp 21.5", within: 60s',
        'contains: "ready"',
        'contains: "late line"',
      ],
      { logcat: ", logcat: [HZB, IotApp]" },
    );
    assertEquals(result.problems, []);
    // No adb banner, no CR, no blank line, nothing of the unsubscribed tag.
    assertEquals(phoneLines.map((e) => e.text), ["got temp 21.5", "ready", "late line"]);
    assertEquals(verdicts(result.assertions), [[true, "seen"], [true, "seen"], [true, "seen"]]);
    assertEquals(result.passed, true);

    // Lines are stamped when they arrive, not when the stream started: the fake waits a second.
    const gapMs = phoneLines[2]!.t - phoneLines[0]!.t;
    assert(gapMs >= 800, `the second line came ${gapMs} ms after the first`);

    assertStringIncludes(serialLog, "] got temp 21.5\n");
    assertStringIncludes(serialLog, "] late line\n");

    // The log is cleared and the stream is open before the app starts, so its first lines are kept.
    const at = (call: string) => adbCalls.findIndex((line) => line.includes(call));
    assertEquals(at("logcat -c") >= 0, true);
    assert(at("logcat -c") < at("logcat -v raw -s HZB:V IotApp:V"), adbCalls.join("\n"));
    assert(at("logcat -v raw -s HZB:V IotApp:V") < at("am start"), adbCalls.join("\n"));
  },
);

androidRun(
  "android logcat: serial assertions fail on text never logged, on an unsubscribed tag and on adb's banner",
  async () => {
    // No `logcat:` in the section: the default tag is HZB alone.
    const { result, phoneLines } = await runPhone(
      [
        'contains: "got temp 21.5"',
        'contains: "never logged"',
        'contains: "ready", within: 60s',
        'contains: "chatter"',
        'contains: "beginning of main"',
      ],
      { duration: "600ms" },
    );
    assertEquals(result.problems, []);
    assertEquals(phoneLines.map((e) => e.text).slice(0, 1), ["got temp 21.5"]);
    assertEquals(verdicts(result.assertions), [
      [true, "seen"],
      [false, "never seen"],
      [false, "never seen"], // IotApp is not among the default tags
      [false, "never seen"],
      [false, "never seen"],
    ]);
    assertEquals(result.passed, false);
  },
);
