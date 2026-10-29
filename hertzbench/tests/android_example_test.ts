// The Android example (docs/android-device-plan.md, piece 4): examples/android/iot-app and the
// two scenarios that run it. The app is built with Gradle and run in an emulator, neither of which
// the suite has, so what is checked here is everything around that: the scenarios agree with the
// app's manifest and log lines, and the engine alone shows the walk out of range cutting the
// phone off, which is what the scenarios' metric assertions say.

import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { computeMetrics } from "../engine/mod.ts";
import {
  evaluateAssertions,
  loadScenario,
  parseScenario,
  type Scenario,
} from "../orchestrator/mod.ts";
import { simulateScenarioTraffic } from "./helpers.ts";

const SCENARIOS = fileURLToPath(new URL("../scenarios/examples/", import.meta.url));
const APP = fileURLToPath(new URL("../examples/android/iot-app/", import.meta.url));
const NAMES = ["android-web-scripted.yaml", "android-web-esp32.yaml"];

const load = async (name: string) => (await loadScenario(`${SCENARIOS}${name}`)).scenario;

for (const name of NAMES) {
  Deno.test(`android example ${name}: the scenario and the app agree`, async () => {
    const scenario = await load(name);
    const [web, phone] = scenario.nodes;
    assertEquals([web!.id, phone!.id, phone!.board], ["web", "phone", "android"]);
    const spec = phone!.android!;
    const manifest = await Deno.readTextFile(`${APP}app/src/main/AndroidManifest.xml`);
    const gradle = await Deno.readTextFile(`${APP}app/build.gradle.kts`);
    const source = await Deno.readTextFile(
      `${APP}app/src/main/kotlin/dev/hertzbench/iotapp/MainActivity.kt`,
    );

    // Where gradle puts the APK, the application id, and the activity `am start` is told.
    assertEquals(
      phone!.firmware,
      { kind: "apk", path: join(APP, "app", "build", "outputs", "apk", "debug", "app-debug.apk") },
    );
    assertStringIncludes(gradle, `applicationId = "${spec.package}"`);
    assertStringIncludes(manifest, `android:name="${spec.activity}"`);
    assert(source.includes("class MainActivity"), "the activity the scenario launches");

    // The board the app is told to poll is the scenario's `web` node.
    assertEquals(spec.extras, { board_url: `http://${web!.ip}/` });
    assertStringIncludes(source, `"board_url"`);
    assertStringIncludes(manifest, 'android:usesCleartextTraffic="true"');
    assertStringIncludes(manifest, "android.permission.INTERNET");

    // The lines `serial:` assertions wait for are the ones the app logs, under a tag the node reads.
    assertEquals(spec.logcat, ["HZB"]);
    assertStringIncludes(source, 'private const val TAG = "HZB"');
    const onPhone = scenario.assertions.filter((a) => a.kind === "serial" && a.node === "phone");
    assert(onPhone.length > 0, "the scenario asserts on what the app logged");
    for (const a of onPhone) {
      assert(a.kind === "serial" && a.contains.startsWith("status ok 200"), JSON.stringify(a));
    }
    assertStringIncludes(source, '"status ok 200 "');
  });
}

/** The scenario's metric assertions, judged on the engine's traffic between its nodes. */
function judgeMetrics(scenario: Scenario) {
  const rig = simulateScenarioTraffic(scenario, { everyMs: 200, payloadBytes: 10 });
  const metrics = computeMetrics(rig.log.events, scenario.durationMs);
  const assertions = scenario.assertions.filter((a) => a.kind === "metric");
  assert(assertions.length >= 2, "the scenario asserts on the experiment");
  return {
    phases: metrics.phases,
    results: evaluateAssertions(assertions, rig.log.events, metrics.phases),
  };
}

const lossOnLink = (phases: ReturnType<typeof judgeMetrics>["phases"], label: string) =>
  phases.find((p) => p.label === label)!.links.find((l) => l.from === "phone" && l.to === "web")!
    .lossPct;

for (const name of NAMES) {
  Deno.test(`android example ${name}: walking out of range cuts the phone off`, async () => {
    const scenario = await load(name);
    const { phases, results } = judgeMetrics(scenario);
    for (const r of results) assert(r.passed, `${r.description}: ${r.detail}`);
    assertEquals(phases.map((p) => p.label), ["start", "out-of-range"]);
    assertEquals(lossOnLink(phases, "start"), 0);
    assertEquals(lossOnLink(phases, "out-of-range"), 100);
  });

  Deno.test(`android example ${name}: a phone that starts out of range fails the near-phase assertion`, async () => {
    const scenario = structuredClone(await load(name));
    scenario.nodes.find((n) => n.id === "phone")!.position = { x: 200, y: 0 };
    const { results } = judgeMetrics(scenario);
    assertEquals(
      results.map((r) => r.passed),
      [false, true],
      results.map((r) => `${r.description}: ${r.detail}`).join("\n"),
    );
  });
}

// The opt-in CI job (docs/android-device-plan.md, piece 8) cannot run here: it boots an emulator.
// Its "must fail" step edits the scenario with `sed` and then greps the report, and both depend on
// text that lives in other files. Run here, a scenario edit that breaks either shows up on every
// pull request instead of in the nightly job.
Deno.test("android CI workflow: its inverted-assertion step still matches the scenario and the report", async () => {
  const workflow = await Deno.readTextFile(
    fileURLToPath(new URL("../../.github/workflows/hertzbench-android.yml", import.meta.url)),
  );
  const original = await Deno.readTextFile(`${SCENARIOS}android-web-scripted.yaml`);

  const sed = workflow.match(/sed 's\/(.+?)\/(.+?)\/'/);
  assert(sed, "the workflow edits the scenario with sed 's/<from>/<to>/'");
  const [, from, to] = sed as unknown as [string, string, string];
  assertEquals(original.split(from).length - 1, 1, `${from} is in the scenario exactly once`);
  const inverted = parseScenario(original.replace(from, to));

  // The assertion the sed inverts, judged against a run in which the app never logged it.
  const failed = evaluateAssertions(inverted.assertions, [], []).filter((r) => !r.passed)
    .filter((r) => r.description.startsWith("serial phone contains"));
  assertEquals(failed.length, 1);

  // The report prints `  FAIL  <description>  (<detail>)`; the workflow greps for that line.
  const grep = workflow.match(/grep -qF '(FAIL {2}[^']+)'/);
  assert(grep, "the workflow looks for the inverted assertion's FAIL line");
  assertStringIncludes(`FAIL  ${failed[0]!.description}  (${failed[0]!.detail})`, grep![1]!);
});
