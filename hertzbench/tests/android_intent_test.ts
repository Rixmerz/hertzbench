// Timeline intents and instrumented tests on the Android node (docs/android-device-plan.md,
// section 4, items 3 and 4): the scenario schema and its refusals, the parser of `am instrument`
// output, and the launcher run through the real runner against a fake emulator and a fake `adb`
// that records `am broadcast` and replays `am instrument` output. No Android SDK is needed. The
// runs skip on Windows because the fake tools are sh scripts.

import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  type AssertionResult,
  checkFirmwareFiles,
  createAndroidLauncher,
  InstrumentationResults,
  loadScenario,
  parseScenario,
  runScenario,
  ScenarioError,
} from "../orchestrator/mod.ts";
import { fakeGuestSdk } from "./android_fake_sdk.ts";
import { skipOnWindows } from "./platform.ts";

const androidRun = skipOnWindows("the fake emulator and adb are sh scripts");

// Not derived from a console port, so a developer's own emulator cannot break the test.
const GUEST_MAC = "02:aa:bb:cc:dd:ee";

const RUNNER = "dev.example.test/androidx.test.runner.AndroidJUnitRunner";

const PHONE = `
    id: phone
    board: android
    position: [3, 0]
    mac: ${GUEST_MAC}
    android: { avd: pixel8, apk: ./app.apk, package: dev.example.app }`;

const WEB = "  - { id: web, board: scripted, position: [0, 0] }";

const scenarioWith = (timeline: string, phone = PHONE) =>
  `name: intents\nduration: 4s\nnodes:\n${WEB}\n  -${phone}\ntimeline:\n${timeline}\n`;

// ── schema ──────────────────────────────────────────────────────────────────

Deno.test("android intent: a timeline entry is read, with broadcast as the default", () => {
  const scenario = parseScenario(scenarioWith(`  - at: 2s
    android: { node: phone, intent: { action: dev.example.REFRESH } }
  - at: 3s
    android:
      node: phone
      intent: { action: dev.example.OPEN, via: start, extras: { page: "a b", n: "3" } }
`));
  assertEquals(scenario.timeline.map((e) => e.atMs), [2000, 3000]);
  assertEquals(scenario.timeline[0]!.actions, [{
    kind: "android",
    node: "phone",
    intent: { via: "broadcast", action: "dev.example.REFRESH", extras: {} },
  }]);
  assertEquals(scenario.timeline[1]!.actions, [{
    kind: "android",
    node: "phone",
    intent: { via: "start", action: "dev.example.OPEN", extras: { page: "a b", n: "3" } },
  }]);
});

const instrumentWith = (fields: string) =>
  scenarioWith(
    "  - { at: 1s, label: go }",
    PHONE.replace(
      "package: dev.example.app }",
      `package: dev.example.app, instrument: ${fields} }`,
    ),
  );

Deno.test("android instrument: the section is read, and without it the node has none", () => {
  const withInstrument = parseScenario(
    instrumentWith(`{ runner: ${RUNNER}, at: 3s, apk: ./test.apk }`),
  );
  assertEquals(withInstrument.nodes[1]!.android!.instrument, {
    runner: RUNNER,
    atMs: 3000,
    apk: "./test.apk",
  });
  assertEquals(parseScenario(scenarioWith("  - { at: 1s, label: go }")).nodes[1]!.android, {
    avd: "pixel8",
    package: "dev.example.app",
    extras: {},
    logcat: ["HZB"],
    bootTimeoutMs: 120_000,
    installTimeoutMs: 60_000,
    launchTimeoutMs: 20_000,
  });
});

for (
  const [name, yaml, message] of [
    [
      "an intent for a node that is not android",
      scenarioWith("  - at: 1s\n    android: { node: web, intent: { action: a.B } }"),
      "timeline[0].android.node: web is not an android node",
    ],
    [
      "an intent for a node that does not exist",
      scenarioWith("  - at: 1s\n    android: { node: ghost, intent: { action: a.B } }"),
      'timeline[0].android.node: no node named "ghost"',
    ],
    [
      "an intent without an action",
      scenarioWith("  - at: 1s\n    android: { node: phone, intent: {} }"),
      "timeline[0].android.intent.action: expected a non-empty string",
    ],
    [
      "an action that is not a dotted name",
      scenarioWith('  - at: 1s\n    android: { node: phone, intent: { action: "a; reboot" } }'),
      "timeline[0].android.intent.action: not an intent action",
    ],
    [
      "a delivery that is neither broadcast nor start",
      scenarioWith(
        "  - at: 1s\n    android: { node: phone, intent: { action: a.B, via: service } }",
      ),
      'timeline[0].android.intent.via: expected broadcast or start, got "service"',
    ],
    [
      "an extra with a name adb would read as a flag",
      scenarioWith(
        '  - at: 1s\n    android: { node: phone, intent: { action: a.B, extras: { "-e": x } } }',
      ),
      "timeline[0].android.intent.extras.-e: not an intent extra name",
    ],
    [
      "an unknown field of the intent",
      scenarioWith(
        "  - at: 1s\n    android: { node: phone, intent: { action: a.B, component: x } }",
      ),
      "timeline[0].android.intent.component: unknown field",
    ],
    [
      "an intent after the end of the run",
      scenarioWith("  - at: 9s\n    android: { node: phone, intent: { action: a.B } }"),
      "timeline[0].at: is after the end of the run",
    ],
    [
      "a runner that is not package/class",
      instrumentWith("{ runner: not-a-runner, at: 1s }"),
      "nodes[1].android.instrument.runner: not <test package>/<runner class>",
    ],
    [
      "an instrument without a time",
      instrumentWith(`{ runner: ${RUNNER} }`),
      "nodes[1].android.instrument.at: expected a duration",
    ],
    [
      "an instrument after the end of the run",
      instrumentWith(`{ runner: ${RUNNER}, at: 9s }`),
      "nodes[1].android.instrument.at: is after the end of the run",
    ],
    [
      "a test apk that is not an .apk",
      instrumentWith(`{ runner: ${RUNNER}, at: 1s, apk: test.zip }`),
      "nodes[1].android.instrument.apk: expected the path of an .apk file",
    ],
    [
      "an unknown field of the instrument",
      instrumentWith(`{ runner: ${RUNNER}, at: 1s, args: x }`),
      "nodes[1].android.instrument.args: unknown field",
    ],
  ] as const
) {
  Deno.test(`android intent refused: ${name}`, () => {
    const error = assertThrows(() => parseScenario(yaml), ScenarioError);
    assertStringIncludes(error.message, message);
  });
}

Deno.test("android instrument: the test apk is resolved against the scenario file and must exist", async () => {
  const work = await Deno.makeTempDir({ prefix: "hzb-android-intent-" });
  try {
    await Deno.writeTextFile(join(work, "app.apk"), "PK");
    await Deno.writeTextFile(
      join(work, "s.yaml"),
      instrumentWith(`{ runner: ${RUNNER}, at: 1s, apk: ./tests/test.apk }`),
    );
    const { scenario } = await loadScenario(join(work, "s.yaml"), join(work, "out"));
    const testApk = join(work, "tests", "test.apk");
    assertEquals(scenario.nodes[1]!.android!.instrument!.apk, testApk);
    assertEquals(await checkFirmwareFiles(scenario), [
      `phone: ${testApk} is not an .apk file that exists`,
    ]);
    await Deno.mkdir(join(work, "tests"));
    await Deno.writeTextFile(testApk, "PK");
    assertEquals(await checkFirmwareFiles(scenario), []);
  } finally {
    await Deno.remove(work, { recursive: true });
  }
});

// ── the parser of `am instrument -w -r` output ──────────────────────────────

const status = (fields: Record<string, string>, code: number) => [
  ...Object.entries(fields).map(([key, value]) => `INSTRUMENTATION_STATUS: ${key}=${value}`),
  `INSTRUMENTATION_STATUS_CODE: ${code}`,
];

const CLASS = "dev.example.test.MainTest";

/** Output as AndroidJUnitRunner prints it: a test starts (1) and ends (0, -2, -3), and a failure's stack spans lines. */
const FIXTURE = [
  ...status({
    class: CLASS,
    current: "1",
    id: "AndroidJUnitRunner",
    numtests: "4",
    test: "shows_temp",
  }, 1),
  ...status({ class: CLASS, current: "1", test: "shows_temp" }, 0),
  ...status({ class: CLASS, current: "2", test: "refreshes" }, 1),
  "INSTRUMENTATION_STATUS: stack=java.lang.AssertionError: expected 21.5",
  "\tat dev.example.test.MainTest.refreshes(MainTest.kt:31)",
  "\tat java.lang.reflect.Method.invoke(Native Method)",
  ...status({ class: CLASS, current: "2", test: "refreshes" }, -2),
  ...status({ class: CLASS, current: "3", test: "flaky" }, 1),
  ...status({ class: CLASS, current: "3", test: "flaky" }, -3),
  ...status({ class: CLASS, current: "4", test: "needs_gps" }, 1),
  ...status({ class: CLASS, current: "4", test: "needs_gps" }, -4),
  ...status({ class: CLASS, current: "5", test: "boom" }, 1),
  ...status({ class: CLASS, current: "5", test: "boom" }, -1),
  "INSTRUMENTATION_RESULT: stream=",
  "",
  "Time: 3.2",
  "INSTRUMENTATION_CODE: -1",
];

Deno.test("android instrument: a result is a line as its test ends, from the runner's status codes", () => {
  const results = new InstrumentationResults();
  const lines = FIXTURE.map((line) => results.feed(line));
  // A start (code 1) says nothing yet; the line comes with the code that ends the test.
  assertEquals(lines.flat(), [
    `test ${CLASS}#shows_temp passed`,
    `test ${CLASS}#refreshes failed`,
    `test ${CLASS}#flaky skipped`,
    `test ${CLASS}#needs_gps skipped`,
    `test ${CLASS}#boom failed`,
  ]);
  // The passed line is emitted at its own STATUS_CODE line, not at the end of the output.
  assertEquals(lines[FIXTURE.indexOf("INSTRUMENTATION_STATUS_CODE: 0")], [
    `test ${CLASS}#shows_temp passed`,
  ]);
  assertEquals(results.finish(0), { lines: [], failure: null });
});

Deno.test("android instrument: a run that did not reach its end is a failure, and a test left open did not pass", () => {
  const crashed = new InstrumentationResults();
  [
    ...status({ class: CLASS, test: "boom" }, 1),
    "INSTRUMENTATION_RESULT: shortMsg=Process crashed.",
    "INSTRUMENTATION_RESULT: longMsg=Native crash",
    "INSTRUMENTATION_CODE: 0",
  ].forEach((line) => crashed.feed(line));
  assertEquals(crashed.finish(0), {
    lines: [`test ${CLASS}#boom failed`],
    failure: "Process crashed.: Native crash",
  });

  const missing = new InstrumentationResults();
  [
    ...status({ Error: "Unable to find instrumentation info for: ComponentInfo{a/b}" }, -1),
    "INSTRUMENTATION_FAILED: a/b",
  ].forEach((line) => missing.feed(line));
  const { failure } = missing.finish(0);
  assertStringIncludes(failure!, "could not start: a/b");
  assertStringIncludes(failure!, "Unable to find instrumentation info");

  const cut = new InstrumentationResults();
  status({ class: CLASS, test: "t" }, 1).forEach((line) => cut.feed(line));
  assertEquals(cut.finish(255), {
    lines: [`test ${CLASS}#t failed`],
    failure: "adb exited with code 255 before the end of instrumentation",
  });
});

// ── the launcher through the runner ─────────────────────────────────────────

// The fake app logs every `am` call it receives into `app-log`, which the fake logcat follows, so
// an intent becomes a serial line stamped when it arrived, relative to time zero. `am instrument`
// replays `instrument-1`, waits a second, then replays `instrument-2`. A file `am-error` makes an
// intent of the REFRESH action fail the way `am` does: exit 0 and an "Error:" line.
const ADB = `shell)
  case "$1" in
    getprop) echo 1 ;;
    am)
      case "$2" in
        instrument) cat "$DIR/instrument-1"; sleep 1; cat "$DIR/instrument-2" ;;
        *)
          echo "intent $*" >> "$DIR/app-log"
          case "$*" in
            *REFRESH*) if [ -f "$DIR/am-error" ]; then echo "Error: Activity not started, unable to resolve Intent"; fi ;;
          esac ;;
      esac ;;
  esac ;;
wait-for-device) exit 0 ;;
install) echo Success ;;
logcat)
  if [ "$1" = "-c" ]; then exit 0; fi
  exec tail -n 0 -f "$DIR/app-log" ;;
emu) kill "$(cat "$DIR/emulator-pid")" ;;`;

async function runPhone(
  scenarioText: string,
  files: Record<string, string> = {},
) {
  const sdk = await fakeGuestSdk(ADB, GUEST_MAC);
  const work = await Deno.makeTempDir({ prefix: "hzb-android-intent-" });
  try {
    await Deno.writeTextFile(join(sdk.dir, "app-log"), "");
    for (const [name, content] of Object.entries(files)) {
      await Deno.writeTextFile(join(sdk.dir, name), content);
    }
    await Deno.writeTextFile(join(work, "app.apk"), "PK");
    await Deno.writeTextFile(join(work, "test.apk"), "PK");
    await Deno.writeTextFile(join(work, "s.yaml"), scenarioText);
    const loaded = await loadScenario(join(work, "s.yaml"), join(work, "out"));
    const result = await runScenario(loaded.scenario, {
      outDir: loaded.outDir,
      outputs: loaded.outputs,
      launchers: { android: createAndroidLauncher({ checkKvm: () => null }) },
    });
    return {
      result,
      work,
      phoneLines: result.events.flatMap((e) =>
        e.type === "serial" && e.node === "phone" ? [e] : []
      ),
      adbCalls: (await Deno.readTextFile(join(sdk.dir, "adb-calls"))).split("\n"),
    };
  } finally {
    await sdk.restore();
    await Deno.remove(work, { recursive: true });
  }
}

const verdicts = (results: AssertionResult[]) =>
  results.map((r) => [r.passed, r.detail.startsWith("seen at") ? "seen" : r.detail]);

androidRun(
  "android intent: a timeline entry runs am broadcast at its time, limited to the app's package",
  async () => {
    const { result, phoneLines, adbCalls } = await runPhone(`name: intents
duration: 4s
nodes:
${WEB}
  -${PHONE}
timeline:
  - at: 1500ms
    android:
      node: phone
      intent: { action: dev.example.REFRESH, extras: { msg: "it's ok" } }
  - at: 2500ms
    android: { node: phone, intent: { action: dev.example.OPEN, via: start } }
assertions:
  - serial: { node: phone, contains: "am broadcast -a 'dev.example.REFRESH'", within: 3s }
  - serial: { node: phone, contains: "am start -a 'dev.example.OPEN'", within: 4s }
`);
    assertEquals(result.problems, []);
    assertEquals(verdicts(result.assertions), [[true, "seen"], [true, "seen"]]);

    const call = (text: string) => adbCalls.find((line) => line.includes(text));
    assertEquals(
      call("am broadcast"),
      "-s emulator-5554 shell am broadcast -a 'dev.example.REFRESH' -p 'dev.example.app' " +
        "--es msg 'it'\\''s ok'",
    );
    assertStringIncludes(
      call("am start -a")!,
      "shell am start -a 'dev.example.OPEN' -p 'dev.example.app'",
    );

    // Not before its time, and not much after it: the app saw the intent on the runner's clock.
    const seenAt = (text: string) => phoneLines.find((e) => e.text.includes(text))!.t;
    const broadcastAt = seenAt("am broadcast");
    const startAt = seenAt("am start -a");
    assert(
      broadcastAt >= 1500 && broadcastAt < 2500,
      `the broadcast was seen at ${broadcastAt} ms`,
    );
    assert(startAt >= 2500 && startAt < 3500, `the start was seen at ${startAt} ms`);
  },
);

androidRun(
  "android intent: a refused intent is a problem of the run, named with adb's own words",
  async () => {
    const { result } = await runPhone(
      `name: intents
duration: 3s
nodes:
${WEB}
  -${PHONE}
timeline:
  - at: 1s
    android: { node: phone, intent: { action: dev.example.REFRESH, via: start } }
`,
      { "am-error": "1" },
    );
    assertEquals(result.passed, false);
    assertEquals(result.problems.length, 1);
    assertStringIncludes(
      result.problems[0]!,
      "phone: start of dev.example.REFRESH to dev.example.app failed",
    );
    assertStringIncludes(result.problems[0]!, "Error: Activity not started");
  },
);

const INSTRUMENT_1 = [
  ...status({ class: CLASS, test: "shows_temp" }, 1),
  ...status({ class: CLASS, test: "shows_temp" }, 0),
  ...status({ class: CLASS, test: "refreshes" }, 1),
].join("\n");

const INSTRUMENT_2 = [
  "INSTRUMENTATION_STATUS: stack=java.lang.AssertionError: expected 21.5",
  "\tat dev.example.test.MainTest.refreshes(MainTest.kt:31)",
  ...status({ class: CLASS, test: "refreshes" }, -2),
  ...status({ class: CLASS, test: "flaky" }, 1),
  ...status({ class: CLASS, test: "flaky" }, -3),
  "INSTRUMENTATION_CODE: -1",
].join("\n");

const INSTRUMENTED_PHONE = PHONE.replace(
  "package: dev.example.app }",
  `package: dev.example.app,\n      instrument: { runner: ${RUNNER}, at: 1s, apk: ./test.apk } }`,
);

androidRun(
  "android instrument: test results are serial lines as they arrive, and serial assertions judge them",
  async () => {
    const { result, phoneLines, adbCalls } = await runPhone(
      `name: instrumented
duration: 4s
nodes:
${WEB}
  -${INSTRUMENTED_PHONE}
assertions:
  - serial: { node: phone, contains: "shows_temp passed", within: 3s }
  - serial: { node: phone, contains: "refreshes passed" }
  - serial: { node: phone, contains: "refreshes failed" }
`,
      { "instrument-1": INSTRUMENT_1, "instrument-2": INSTRUMENT_2 },
    );
    assertEquals(result.problems, []);
    // The fake app also logs its own launch; only the test results are the runner's.
    const testLines = phoneLines.filter((e) => e.text.startsWith("test "));
    assertEquals(testLines.map((e) => e.text), [
      `test ${CLASS}#shows_temp passed`,
      `test ${CLASS}#refreshes failed`,
      `test ${CLASS}#flaky skipped`,
    ]);
    // The failing assertion is the one on text the run never printed: a failed test is not a problem.
    assertEquals(verdicts(result.assertions).map(([passed]) => passed), [true, false, true]);

    // Streamed, not collected: the second test comes a second after the first, and not before `at`.
    assert(testLines[0]!.t >= 1000, `the first result came at ${testLines[0]!.t} ms`);
    const gapMs = testLines[1]!.t - testLines[0]!.t;
    assert(gapMs >= 800, `the second result came ${gapMs} ms after the first`);

    const at = (call: string) => adbCalls.findIndex((line) => line.includes(call));
    assert(at("install -r -t") >= 0 && at("test.apk") > at("app.apk"), adbCalls.join("\n"));
    assert(at("am instrument -w -r") > at("am start -W"), adbCalls.join("\n"));
    assertStringIncludes(adbCalls[at("am instrument")]!, `-r '${RUNNER}'`);
  },
);

androidRun(
  "android instrument: a runner that does not exist is a problem of the run",
  async () => {
    const { result, phoneLines } = await runPhone(
      `name: instrumented
duration: 3s
nodes:
${WEB}
  -${INSTRUMENTED_PHONE}
`,
      {
        "instrument-1": [
          ...status({ Error: "Unable to find instrumentation info for: ComponentInfo{a/b}" }, -1),
          "INSTRUMENTATION_FAILED: a/b",
        ].join("\n"),
        "instrument-2": "",
      },
    );
    assertEquals(phoneLines.map((e) => e.text).filter((t) => t.startsWith("test ")), []);
    assertEquals(result.passed, false);
    assertEquals(result.problems.length, 1);
    assertStringIncludes(
      result.problems[0]!,
      `phone: instrumentation ${RUNNER} failed: could not start`,
    );
    assertStringIncludes(result.problems[0]!, "Unable to find instrumentation info");
  },
);
