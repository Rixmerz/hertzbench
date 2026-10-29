// Piece 7 through the real entrypoint: `runScenario` with `peripheral: netsim`, no hooks. A fake
// netsimd (tests/bridge_netsim_fake.ts) plays the emulator's HCI port and the app's Bluetooth
// stack; a scripted sensor plays the node. The `android:` run adds a fake `emulator` and `adb`
// (sh scripts, so it skips on Windows) to check how the emulator is started and that the app's
// logcat reaches the bridge's serial lines.

import { join } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { OP } from "../adapters/ble-hci/hci.ts";
import { ATT } from "../orchestrator/boards/drivers/att.ts";
import {
  type AndroidAppLauncher,
  createAndroidAppLauncher,
  type LiveRun,
  loadScenario,
  parseScenario,
  renderReport,
  type RunResult,
  runScenario,
} from "../orchestrator/mod.ts";
import { fakeSdk } from "./android_fake_sdk.ts";
import { FakeNetsim } from "./bridge_netsim_fake.ts";
import { skipOnWindows } from "./platform.ts";

const androidRun = skipOnWindows("the fake emulator and adb are sh scripts");

const scenarioYaml = (port: number, extra = "") => `
name: bridge-netsim
seed: 3
duration: 6s
environment: { preset: indoor_office, shadowing_sigma_db: 0 }
nodes:
  - id: sensor-1
    board: scripted
    position: [0, 0]
    radios: [{ phy: ble }]
    firmware:
      advertise: { interval: 50ms }
      send: [{ to: phone, every: 100ms, count: 50, payload: reading }]
  - id: sensor-2
    board: scripted
    position: [0, 10]
    radios: [{ phy: ble }]
    firmware: { advertise: true }
  - id: gw
    board: scripted
    position: [5, 10]
    radios: [{ phy: ble }]
    firmware: { connect: { peers: [sensor-2] } }
bridge:
  position: [2, 0]
  mirror: sensor-1
  name: hzb sensor
  peripheral: netsim
  netsim_hci: 127.0.0.1:${port}
${extra}`;

const APP = 0x40;
const text = (pdu: Uint8Array) => new TextDecoder().decode(pdu);

async function until(what: string, check: () => boolean, timeoutMs = 8000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The app: waits for the advertisement, connects, subscribes, reads, writes; returns what it saw. */
async function useTheApp(fake: FakeNetsim, live: Promise<LiveRun>) {
  const control = await live;
  await until("the host to advertise", () => fake.opcodes.includes(OP.leSetAdvEnable));
  await fake.connectApp(APP);
  const service = await fake.ask(
    APP,
    Uint8Array.of(ATT.readByGroupReq, 1, 0, 0xff, 0xff, 0x00, 0x28),
  );
  const subscribed = await fake.ask(APP, Uint8Array.of(ATT.writeReq, 0x11, 0, 1, 0));
  const notified = await fake.nextNotification();
  const read = await fake.ask(APP, Uint8Array.of(ATT.readReq, 0x10, 0));
  const written = await fake.ask(
    APP,
    Uint8Array.of(ATT.writeReq, 0x10, 0, ...new TextEncoder().encode("hello")),
  );
  return { control, service, subscribed, notified, read, written };
}

function bridgeLog(result: RunResult): string[] {
  return result.events.flatMap((e) => (e.type === "serial" && e.node === "phone" ? [e.text] : []));
}

Deno.test("bridge netsim: an app reads, writes and subscribes to a simulated peripheral over the air", async () => {
  const fake = new FakeNetsim();
  const out = await Deno.makeTempDir({ prefix: "hzb-netsim-" });
  try {
    let underway: (live: LiveRun) => void = () => {};
    const live = new Promise<LiveRun>((resolve) => (underway = resolve));
    const run = runScenario(parseScenario(scenarioYaml(fake.port)), {
      outDir: out,
      outputs: { metrics: `${out}/m.json`, pcap: `${out}/air.pcap`, events: `${out}/e.jsonl` },
      onUnderway: underway,
    });
    const app = await useTheApp(fake, live);
    const result = await run;

    assertEquals([...app.service.slice(0, 2)], [ATT.readByGroupRsp, 6], "the node's service");
    assertEquals([...app.subscribed], [ATT.writeRsp]);
    assertEquals(app.notified[0], ATT.notify, "the node's reading reaches the subscribed app");
    assertEquals(app.read[0], ATT.readRsp);
    assert(/^reading:\d+$/.test(text(app.read.slice(1))), `read ${text(app.read.slice(1))}`);
    assertEquals([...app.written], [ATT.writeRsp]);

    assertEquals(result.problems, []);
    assertEquals(result.passed, true, renderReport(result));
    const log = bridgeLog(result);
    assert(log.includes("bridge phone connected"));
    assert(log.some((l) => l.startsWith("bridge phone read 0000ff01-") && l.includes("reading:")));
    assert(log.some((l) => l.startsWith("bridge phone wrote 0000ff01-") && l.includes('"hello"')));
    assert(log.some((l) => l.startsWith("bridge phone subscribed to 0000ff01-")));
    assert(result.bridge?.kind === "ble");
    assertEquals(result.bridge.adapter, "netsim");
    assertEquals(result.bridge.peripheral, `netsim HCI port 127.0.0.1:${fake.port}`);
    const station = result.nodes.find((n) => n.board === "bridge");
    assertStringIncludes(station?.fidelity ?? "", "netsim");
    assert(!station?.fidelity.includes("BlueZ"), "the BlueZ fidelity line is not the netsim one");
    assertStringIncludes(
      renderReport(result),
      'bridge phone: mirrors sensor-1\'s GATT server as "hzb sensor" on netsim',
    );
    // The host went through Reset first, and the node saw the replayed write on the air.
    assertEquals(fake.opcodes[0], OP.reset);
    assert(
      result.events.some((e) =>
        e.type === "serial" && e.node === "sensor-1" && e.text.includes('ble rx "hello" from phone')
      ),
    );
  } finally {
    await fake.close();
    await Deno.remove(out, { recursive: true });
  }
});

Deno.test("bridge netsim: with no HCI port to reach the run ends before it starts, naming the port", async () => {
  const closed = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (closed.addr as Deno.NetAddr).port;
  closed.close();
  const out = await Deno.makeTempDir({ prefix: "hzb-netsim-" });
  try {
    let message = "";
    try {
      await runScenario(parseScenario(scenarioYaml(port)), {
        outDir: out,
        outputs: { metrics: `${out}/m.json`, pcap: `${out}/air.pcap`, events: `${out}/e.jsonl` },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assertStringIncludes(message, `cannot reach netsim's HCI port at 127.0.0.1:${port}`);
  } finally {
    await Deno.remove(out, { recursive: true });
  }
});

// The fake logcat plays `logcat-buffer`; the final `exec sleep` keeps the stream open until stop()
// kills it (see tests/android_logcat_test.ts).
const ADB = `shell) echo 1 ;;
wait-for-device) exit 0 ;;
install) echo Success ;;
logcat)
  if [ "$1" = "-c" ]; then exit 0; fi
  tags=" $* "
  while IFS='|' read -r tag text; do
    case "$tags" in *" $tag:V "*) printf '%s\\r\\n' "$text" ;; esac
  done < "$DIR/logcat-buffer"
  exec sleep 60 ;;
emu) kill "$(cat "$DIR/emulator-pid")" ;;`;

/**
 * The real lifecycle against the fake SDK, except that stopping the emulator also takes netsimd
 * down, as it does: the runner stops the boards before it closes the bridge.
 */
function dyingWithTheEmulator(fake: FakeNetsim): AndroidAppLauncher {
  const real = createAndroidAppLauncher({ checkKvm: () => null });
  return {
    async start(ctx) {
      const board = await real.start(ctx);
      return {
        clockDescription: board.clockDescription,
        stop: async () => {
          await board.stop();
          fake.dropConnection();
        },
      };
    },
  };
}

androidRun(
  "bridge netsim: the android: app boots before time zero on the bridge's HCI port, and its logcat is the bridge's serial",
  async () => {
    const fake = new FakeNetsim();
    const sdk = await fakeSdk(ADB);
    const work = await Deno.makeTempDir({ prefix: "hzb-netsim-android-" });
    try {
      await Deno.writeTextFile(
        join(sdk.dir, "logcat-buffer"),
        "HZB|got reading 21.5\nNoise|chatter\n",
      );
      await Deno.writeTextFile(join(work, "app.apk"), "PK");
      await Deno.writeTextFile(
        join(work, "s.yaml"),
        scenarioYaml(
          fake.port,
          `android: { avd: pixel8, apk: ./app.apk, package: dev.example.bleapp }
assertions:
  - serial: { node: phone, contains: "got reading 21.5", within: 60s }
  - serial: { node: phone, contains: "bridge advertising", within: 60s }
`,
        ),
      );
      const loaded = await loadScenario(join(work, "s.yaml"), join(work, "out"));
      assertEquals(
        loaded.scenario.android?.apk,
        join(work, "app.apk"),
        "resolved from the scenario file",
      );
      let underway: (live: LiveRun) => void = () => {};
      const live = new Promise<LiveRun>((resolve) => (underway = resolve));
      const run = runScenario(loaded.scenario, {
        outDir: loaded.outDir,
        outputs: loaded.outputs,
        androidApp: dyingWithTheEmulator(fake),
        onUnderway: underway,
      });
      const app = await useTheApp(fake, live);
      const result = await run;

      const args = await Deno.readTextFile(join(sdk.dir, "emulator-args"));
      assertStringIncludes(args, `-avd pixel8`);
      assertStringIncludes(args, `-netsim-args --hci-port ${fake.port}`);
      assert(!args.includes("-wifi-socket") && !args.includes("WiFiPacketStream"), args);
      assertEquals(result.problems, [], "netsim ending with the emulator is not a problem");
      assertEquals(result.passed, true, renderReport(result));
      assertEquals(app.read[0], ATT.readRsp);
      // Time zero came after the app was running: logcat's first line precedes the bridge's.
      const log = bridgeLog(result);
      assert(log.indexOf("got reading 21.5") >= 0 && !log.includes("chatter"), log.join("\n"));
      assert(log.indexOf("got reading 21.5") < log.indexOf("bridge phone connected"));
      assertStringIncludes(
        await Deno.readTextFile(join(loaded.outDir, "phone-emulator.log")),
        "(cold boot)",
      );
      const calls = await Deno.readTextFile(join(sdk.dir, "adb-calls"));
      assertStringIncludes(calls, "install -r -t");
      assertStringIncludes(calls, "emu kill");
    } finally {
      await sdk.restore();
      await fake.close();
      await Deno.remove(work, { recursive: true });
    }
  },
);
