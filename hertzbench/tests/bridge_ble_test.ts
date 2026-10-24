// Phase 5b: the BLE bridge. The GATT codec between a scripted peripheral and
// the bridge's client, the bridge on the simulated air with a stand-in for
// BlueZ, and the real BlueZ helper against a fake bluetoothd on a private
// D-Bus (never the host's adapter or system bus).

import { PYTHON } from "./platform.ts";
import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  BLUEZ_HELPER,
  BluezPeripheral,
  GattOperationError,
  type GattPeripheral,
  type PeripheralHandlers,
} from "../bridge/mod.ts";
import type { DiscoveredService } from "../orchestrator/boards/drivers/att.ts";
import { type LiveRun, parseScenario, renderReport, runScenario } from "../orchestrator/mod.ts";

const FAKE_BLUEZ = fileURLToPath(new URL("./fixtures/fake_bluez.py", import.meta.url));
const SERVICES: DiscoveredService[] = [{
  uuid: "0000ff00-0000-1000-8000-00805f9b34fb",
  startHandle: 0x0e,
  endHandle: 0x11,
  characteristics: [{
    uuid: "0000ff01-0000-1000-8000-00805f9b34fb",
    declarationHandle: 0x0f,
    valueHandle: 0x10,
    properties: 0x1e,
    cccdHandle: 0x11,
  }],
}];

// D-Bus sessions and BlueZ are Linux only: elsewhere the helper test cannot run.
const hasDbus = Deno.build.os === "linux" &&
  new Deno.Command("sh", { args: ["-c", "command -v dbus-run-session"] }).outputSync().success;

Deno.test({
  name: "bluez: the helper registers the mirrored table and relays a phone's operations",
  ignore: !hasDbus,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "hzb-bluez-" });
    const report = `${dir}/report.json`;
    const seen: string[] = [];
    let peripheral: GattPeripheral | null = null;
    let subscribed: () => void = () => {};
    const subscription = new Promise<void>((resolve) => (subscribed = resolve));
    const handlers: PeripheralHandlers = {
      read: (handle) => {
        seen.push(`read ${handle}`);
        return Promise.resolve(new TextEncoder().encode("reading:7"));
      },
      write: (handle, value, withResponse) => {
        const text = new TextDecoder().decode(value);
        seen.push(`write ${handle} ${text} ${withResponse}`);
        if (text === "nope") {
          return Promise.reject(new GattOperationError("the node refused it", "not-permitted"));
        }
        return Promise.resolve();
      },
      subscribe: (handle, enabled) => {
        seen.push(`subscribe ${handle} ${enabled}`);
        peripheral?.notify(handle, new TextEncoder().encode("reading:8"));
        subscribed();
        return Promise.resolve();
      },
    };
    peripheral = new BluezPeripheral({
      adapter: "hci0",
      command: ["dbus-run-session", "--", "python3", "-I", FAKE_BLUEZ, report, BLUEZ_HELPER],
    });
    await peripheral.start(SERVICES, "sensor-1", handlers);
    await subscription;
    // The notification goes out after the subscription; give D-Bus a moment to carry it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await peripheral.close();
    const state = JSON.parse(await Deno.readTextFile(report));
    await Deno.remove(dir, { recursive: true });

    assertEquals(seen, [
      "read 16",
      "write 16 hello true",
      "write 16 nope true",
      "subscribe 16 true",
    ]);
    const char =
      state.objects["/org/hertzbench/bridge/service0/char0"]["org.bluez.GattCharacteristic1"];
    assertEquals(char.UUID, "0000ff01-0000-1000-8000-00805f9b34fb");
    assertEquals(char.Flags, ["read", "write-without-response", "write", "notify"]);
    assertEquals(
      state.objects["/org/hertzbench/bridge/service0"]["org.bluez.GattService1"].UUID,
      "0000ff00-0000-1000-8000-00805f9b34fb",
    );
    assertEquals(state.advertisement.LocalName, "sensor-1");
    assertEquals(state.phone, [
      { read: "reading:7", error: null },
      { write: "hello", error: null },
      { write: "nope", error: "org.bluez.Error.NotPermitted" },
      { subscribe: null },
    ]);
    assertEquals(state.notified, ["reading:8"]);
    assertEquals(state.unregistered.sort(), ["UnregisterAdvertisement", "UnregisterApplication"]);
    assertEquals(state.helper_exit, 0);
  },
});

Deno.test("bluez: a helper that cannot reach BlueZ fails start with its reason", async () => {
  const peripheral = new BluezPeripheral({
    adapter: "hci0",
    command: [
      PYTHON,
      "-I",
      "-c",
      "import sys; sys.stderr.write('no bluetoothd here\\n'); sys.exit(3)",
    ],
  });
  let message = "";
  try {
    await peripheral.start(SERVICES, "x", {
      read: () => Promise.resolve(new Uint8Array(0)),
      write: () => Promise.resolve(),
      subscribe: () => Promise.resolve(),
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assertStringIncludes(message, "exited with code 3");
  assertStringIncludes(message, "no bluetoothd here");
});

/** A phone on the host, as the bridge sees it: the table it was handed and the operations it makes. */
class PhoneStandIn implements GattPeripheral {
  readonly description = "a test's stand-in for BlueZ";
  services: DiscoveredService[] = [];
  name = "";
  handlers: PeripheralHandlers | null = null;
  readonly notified: string[] = [];
  #started: () => void = () => {};
  readonly started = new Promise<void>((resolve) => (this.#started = resolve));
  closed = false;

  start(services: DiscoveredService[], name: string, handlers: PeripheralHandlers): Promise<void> {
    this.services = services;
    this.name = name;
    this.handlers = handlers;
    this.#started();
    return Promise.resolve();
  }
  notify(_handle: number, value: Uint8Array): void {
    this.notified.push(new TextDecoder().decode(value));
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

const BLE_SCENARIO = `
name: bridge-ble
seed: 3
duration: 9s
environment: { preset: indoor_office, shadowing_sigma_db: 0 }
nodes:
  - id: sensor-1
    board: scripted
    position: [0, 0]
    radios: [{ phy: ble }]
    firmware:
      advertise: { interval: 50ms }
      send: [{ to: phone, every: 100ms, count: 80, payload: reading }]
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
assertions:
  - serial: { node: sensor-1, contains: 'ble rx "hello" from phone' }
  - serial: { node: phone, contains: "bridge connected to sensor-1", within: 2s }
  - metric: { link: "phone->sensor-1", kind: ble-acl, delivered: { gt: 3 } }
`;

async function until(what: string, check: () => boolean, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

Deno.test("bridge ble: a phone reads, writes and subscribes to a simulated peripheral over the air", async () => {
  const out = await Deno.makeTempDir({ prefix: "hzb-bridge-ble-" });
  const phone = new PhoneStandIn();
  let underway: (live: LiveRun) => void = () => {};
  const live = new Promise<LiveRun>((resolve) => (underway = resolve));
  const run = runScenario(parseScenario(BLE_SCENARIO), {
    outDir: out,
    outputs: {
      metrics: `${out}/metrics.json`,
      pcap: `${out}/air.pcap`,
      events: `${out}/events.jsonl`,
    },
    onUnderway: underway,
    bridge: { peripheral: () => phone },
  });
  const control = await live;
  await phone.started;
  const handlers = phone.handlers as PeripheralHandlers;
  assertEquals(phone.name, "hzb sensor");
  assertEquals(
    phone.services.map((
      s,
    ) => [
      s.uuid,
      s.characteristics.map((c) => [c.uuid, c.valueHandle, c.properties, c.cccdHandle]),
    ]),
    [
      ["0000ff00-0000-1000-8000-00805f9b34fb", [[
        "0000ff01-0000-1000-8000-00805f9b34fb",
        0x10,
        0x1e,
        0x11,
      ]]],
    ],
  );

  await handlers.subscribe(0x10, true);
  await until("a notification", () => phone.notified.length >= 3);
  const read = new TextDecoder().decode(await handlers.read(0x10));
  assert(
    /^reading:\d+$/.test(read),
    `a read returns the last reading, got ${JSON.stringify(read)}`,
  );
  await handlers.write(0x10, new TextEncoder().encode("hello"), true);

  // Walk the phone out of range: the controllers drop the link after the 1 s supervision timeout.
  control.moveNode("phone", { x: 400, y: 0 });
  const bridgeLog = () =>
    control.events().flatMap((e) => (e.type === "serial" && e.node === "phone" ? [e.text] : []));
  await until(
    "the disconnection",
    () => bridgeLog().some((l) => l.includes("bridge disconnected from sensor-1 reason=0x08")),
  );
  let failure: unknown = null;
  try {
    await handlers.read(0x10);
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof GattOperationError && failure.kind === "failed");
  assertStringIncludes(failure.message, "not connected to sensor-1");

  const result = await run;
  assertEquals(result.problems, []);
  assertEquals(result.passed, true, renderReport(result));
  assertEquals(phone.closed, true);
  assert(
    bridgeLog().some((l) => l.startsWith("bridge phone read 0000ff01-") && l.includes("reading:")),
  );
  assert(
    bridgeLog().some((l) => l.startsWith("bridge phone wrote 0000ff01-") && l.includes('"hello"')),
  );
  const report = result.bridge;
  assert(report?.kind === "ble");
  assertEquals(report.services[0]?.characteristics[0]?.properties, [
    "read",
    "write-without-response",
    "write",
    "notify",
  ]);
  assertStringIncludes(renderReport(result), "bridge phone: mirrors sensor-1's GATT server");
  await Deno.remove(out, { recursive: true });
});
