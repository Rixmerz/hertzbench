// Piece 7 of docs/android-device-plan.md: the BLE bridge's netsim backend. A fake H4 controller on
// loopback plays netsimd's HCI port and the app's Bluetooth stack: it answers the host's bring-up,
// reports a connection, and sends ATT requests. No emulator is involved here; the end-to-end runs
// with a fake emulator are in tests/bridge_netsim_scenario_test.ts.

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { BridgeStartError, GattOperationError, NetsimPeripheral } from "../bridge/mod.ts";
import { GattTable } from "../bridge/ble/netsim.ts";
import { OP } from "../adapters/ble-hci/hci.ts";
import {
  ATT,
  ATT_ERROR,
  type DiscoveredService,
  uuidToBytes,
  uuidToString,
} from "../orchestrator/boards/drivers/att.ts";
import type { PeripheralHandlers } from "../bridge/mod.ts";
import { FakeNetsim, type FakeOptions } from "./bridge_netsim_fake.ts";

const SERVICES: DiscoveredService[] = [
  {
    uuid: "0000ff00-0000-1000-8000-00805f9b34fb",
    startHandle: 0x0e,
    endHandle: 0x11,
    characteristics: [{
      uuid: "0000ff01-0000-1000-8000-00805f9b34fb",
      declarationHandle: 0x0f,
      valueHandle: 0x10,
      properties: 0x1e, // read, write without response, write, notify
      cccdHandle: 0x11,
    }],
  },
  {
    uuid: "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
    startHandle: 0x20,
    endHandle: 0x22,
    characteristics: [{
      uuid: "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
      declarationHandle: 0x21,
      valueHandle: 0x22,
      properties: 0x02, // read
      cccdHandle: null,
    }],
  },
];

const text = (value: Uint8Array) => new TextDecoder().decode(value);
const bytes = (value: string) => new TextEncoder().encode(value);
const u16 = (n: number) => [n & 0xff, n >> 8];

/** Handlers that record what the app did and answer from `values`. */
function recordingHandlers(
  seen: string[],
  values: Record<number, string> = {},
): PeripheralHandlers {
  return {
    read: (handle) => {
      seen.push(`read ${handle.toString(16)}`);
      const value = values[handle];
      if (value === undefined) {
        return Promise.reject(new GattOperationError("not connected to sensor-1", "failed"));
      }
      return Promise.resolve(bytes(value));
    },
    write: (handle, value, withResponse) => {
      seen.push(`write ${handle.toString(16)} ${text(value)} ${withResponse}`);
      return text(value) === "nope"
        ? Promise.reject(new GattOperationError("the node refused it", "not-permitted"))
        : Promise.resolve();
    },
    subscribe: (handle, enabled) => {
      seen.push(`subscribe ${handle.toString(16)} ${enabled}`);
      return Promise.resolve();
    },
  };
}

const APP = 0x40;

async function withPeripheral(
  options: FakeOptions,
  fn: (rig: {
    fake: FakeNetsim;
    peripheral: NetsimPeripheral;
    seen: string[];
    log: string[];
    problems: string[];
  }) => Promise<void>,
): Promise<void> {
  const fake = new FakeNetsim(options);
  const seen: string[] = [];
  const log: string[] = [];
  const problems: string[] = [];
  const peripheral = new NetsimPeripheral({
    host: "127.0.0.1",
    port: fake.port,
    log: (line) => log.push(line),
    onProblem: (message) => problems.push(message),
  });
  try {
    await fn({ fake, peripheral, seen, log, problems });
  } finally {
    await peripheral.close();
    await fake.close();
  }
}

Deno.test("netsim: the host resets, advertises the first service and the name, and answers a Read", async () => {
  await withPeripheral({}, async ({ fake, peripheral, seen }) => {
    await peripheral.open();
    await peripheral.start(SERVICES, "sensor-1", recordingHandlers(seen, { 0x10: "reading:7" }));

    assertEquals(fake.opcodes[0], OP.reset, "the first command is Reset");
    const enable = fake.opcodes.indexOf(OP.leSetAdvEnable);
    assert(enable > fake.opcodes.indexOf(OP.leSetAdvData), "advertising is enabled last");
    assertEquals(fake.data.get(OP.leSetAdvEnable), Uint8Array.of(1));
    // 31 bytes cannot hold flags, a 128-bit UUID and a 26-byte name: the UUID is in the
    // advertising data (here the 16-bit alias of the first service), the name in the scan response.
    const adv = fake.data.get(OP.leSetAdvData)!;
    assertEquals([...adv.slice(1, 1 + adv[0]!)], [2, 1, 6, 3, 3, 0x00, 0xff]);
    const scanResponse = fake.data.get(OP.leSetScanRspData)!;
    assertEquals(text(scanResponse.slice(3, 1 + scanResponse[0]!)), "sensor-1");

    await fake.connectApp(APP);
    const read = await fake.ask(APP, Uint8Array.of(ATT.readReq, 0x10, 0x00));
    assertEquals([...read], [ATT.readRsp, ...bytes("reading:7")]);
    assertEquals(seen, ["read 10"], "the node's handle is the handle the app reads");
  });
});

Deno.test("netsim: the app discovers the table: services, characteristics, descriptors", async () => {
  await withPeripheral({}, async ({ fake, peripheral, seen }) => {
    await peripheral.start(SERVICES, "sensor-1", recordingHandlers(seen));
    await fake.connectApp(APP);

    assertEquals([...await fake.ask(APP, Uint8Array.of(ATT.mtuReq, 247, 0))], [ATT.mtuRsp, 23, 0]);

    // A 16-bit and a 128-bit service cannot share a response: the first answer holds only the
    // 16-bit one, and asking after it finds the other (nothing is skipped).
    const group = (start: number) =>
      fake.ask(APP, Uint8Array.of(ATT.readByGroupReq, ...u16(start), 0xff, 0xff, 0x00, 0x28));
    const first = await group(1);
    assertEquals([...first], [ATT.readByGroupRsp, 6, 0x0e, 0, 0x11, 0, 0x00, 0xff]);
    const second = await group(0x12);
    assertEquals(second[1], 20);
    assertEquals(uuidToString(second.slice(6)), SERVICES[1]!.uuid);
    assertEquals([...await group(0x23)], [ATT.errorRsp, ATT.readByGroupReq, 0x23, 0, 0x0a]);

    const declarations = await fake.ask(
      APP,
      Uint8Array.of(ATT.readByTypeReq, 0x0e, 0, 0x11, 0, 0x03, 0x28),
    );
    // length 7: handle 0x0f, properties 0x1e, value handle 0x10, UUID 0xff01
    assertEquals([...declarations], [ATT.readByTypeRsp, 7, 0x0f, 0, 0x1e, 0x10, 0, 0x01, 0xff]);

    const info = await fake.ask(APP, Uint8Array.of(ATT.findInfoReq, 0x11, 0, 0x11, 0));
    assertEquals([...info], [ATT.findInfoRsp, 1, 0x11, 0, 0x02, 0x29]);
    const wide = await fake.ask(APP, Uint8Array.of(ATT.findInfoReq, 0x22, 0, 0x22, 0));
    assertEquals(wide[1], 2, "the 128-bit value is listed in the 128-bit format");

    assertEquals(
      [...await fake.ask(APP, Uint8Array.of(ATT.readByGroupReq, 1, 0, 0xff, 0xff, 0x03, 0x28))],
      [ATT.errorRsp, ATT.readByGroupReq, 1, 0, 0x10],
      "only primary services are grouped",
    );
    assertEquals(seen, [], "discovery is answered here, nothing reaches the node");
  });
});

Deno.test("netsim: writes, refusals and subscriptions reach the bridge's handlers", async () => {
  await withPeripheral({}, async ({ fake, peripheral, seen, log }) => {
    await peripheral.start(SERVICES, "sensor-1", recordingHandlers(seen));
    await fake.connectApp(APP);

    const write = (handle: number, value: string, op: number = ATT.writeReq) =>
      fake.send(APP, Uint8Array.of(op, ...u16(handle), ...bytes(value)));
    let answer = fake.nextAtt();
    await write(0x10, "hello");
    assertEquals([...await answer], [ATT.writeRsp]);

    answer = fake.nextAtt();
    await write(0x10, "nope");
    assertEquals([...await answer], [
      ATT.errorRsp,
      ATT.writeReq,
      0x10,
      0,
      ATT_ERROR.writeNotPermitted,
    ]);

    // A write command has no answer; the next request's answer is the next thing on the wire.
    await write(0x10, "cmd", ATT.writeCmd);
    assertEquals([...await fake.ask(APP, Uint8Array.of(ATT.readReq, 0x10, 0))], [
      ATT.errorRsp,
      ATT.readReq,
      0x10,
      0,
      0x0e,
    ], "a read the bridge could not carry out is an unlikely error");

    // The second service's value is read-only here: a write is refused without asking the node.
    answer = fake.nextAtt();
    await write(0x22, "x");
    assertEquals([...await answer], [
      ATT.errorRsp,
      ATT.writeReq,
      0x22,
      0,
      ATT_ERROR.writeNotPermitted,
    ]);

    answer = fake.nextAtt();
    await write(0x11, "\x01\x00");
    assertEquals([...await answer], [ATT.writeRsp]);
    assertEquals([...await fake.ask(APP, Uint8Array.of(ATT.readReq, 0x11, 0))], [
      ATT.readRsp,
      1,
      0,
    ]);

    // The node notifies: the app, subscribed, gets it on the node's handle.
    const notified = fake.nextNotification();
    peripheral.notify(0x10, bytes("reading:8"));
    assertEquals([...await notified], [ATT.notify, 0x10, 0, ...bytes("reading:8")]);

    // Leaving ends the subscription at the node, and the host advertises again.
    const before = fake.opcodes.filter((op) => op === OP.leSetAdvEnable).length;
    await fake.disconnectApp(APP, 0x13);
    await poll(() => fake.opcodes.filter((op) => op === OP.leSetAdvEnable).length > before);
    assertEquals(seen, [
      "write 10 hello true",
      "write 10 nope true",
      "write 10 cmd false",
      "read 10",
      "subscribe 10 true",
      "subscribe 10 false",
    ]);
    assertEquals(log, ["bridge phone connected", "bridge phone disconnected reason=0x13"]);
  });
});

Deno.test("netsim: a controller whose LE buffers are the shared ones still carries ATT", async () => {
  await withPeripheral({ leCredits: 0, classicCredits: 3 }, async ({ fake, peripheral, seen }) => {
    await peripheral.start(SERVICES, "sensor-1", recordingHandlers(seen, { 0x10: "ok" }));
    assert(fake.opcodes.includes(OP.readBufferSize), "the host asked the BR/EDR buffer count");
    await fake.connectApp(APP);
    const read = await fake.ask(APP, Uint8Array.of(ATT.readReq, 0x10, 0x00));
    assertEquals(text(read.slice(1)), "ok");
  });
});

Deno.test("netsim: netsim going away is logged, not a problem of the run", async () => {
  await withPeripheral({}, async ({ fake, peripheral, seen, log, problems }) => {
    await peripheral.start(SERVICES, "sensor-1", recordingHandlers(seen));
    fake.dropConnection();
    await poll(() => log.length > 0);
    assertStringIncludes(log[0]!, "bridge netsim closed the HCI connection");
    assertEquals(problems, []);
  });
});

Deno.test("netsim: no HCI port, or one that is not a controller, ends the run before it starts", async () => {
  const closed = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (closed.addr as Deno.NetAddr).port;
  closed.close();
  const unreachable = new NetsimPeripheral({ host: "127.0.0.1", port });
  const error = await assertRejects(() => unreachable.open(), BridgeStartError);
  assertStringIncludes(error.message, `cannot reach netsim's HCI port at 127.0.0.1:${port}`);
  assertStringIncludes(error.message, `--hci-port ${port}`);

  // Accepts, then hangs up: a TCP service that is not HCI.
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const accepted = listener.accept().then((conn) => conn.close());
  const mute = new NetsimPeripheral({
    host: "127.0.0.1",
    port: (listener.addr as Deno.NetAddr).port,
  });
  const notHci = await assertRejects(() => mute.open(), BridgeStartError);
  assertStringIncludes(notHci.message, "is not a Bluetooth controller");
  await accepted;
  listener.close();
});

Deno.test("gatt table: a 128-bit UUID is 16 little-endian bytes, a base-UUID one is its 16-bit alias", () => {
  assertEquals([...uuidToBytes("0000180f-0000-1000-8000-00805f9b34fb")], [0x0f, 0x18]);
  const custom = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
  assertEquals(uuidToBytes(custom).length, 16);
  assertEquals(uuidToString(uuidToBytes(custom)), custom);
  // Only 0000xxxx on the base is short: the same low bits under another prefix are not.
  assertEquals(uuidToBytes("1234180f-0000-1000-8000-00805f9b34fb").length, 16);
});

Deno.test("gatt table: after a reset the app's subscriptions are gone", async () => {
  const table = new GattTable(SERVICES, recordingHandlers([]));
  assertEquals(table.notification(0x10, bytes("x")), null);
  await table.handle(Uint8Array.of(ATT.writeReq, 0x11, 0, 1, 0));
  assertEquals([...table.notification(0x10, bytes("x"))!], [ATT.notify, 0x10, 0, ...bytes("x")]);
  assertEquals(table.reset(), [0x10]);
  assertEquals(table.notification(0x10, bytes("x")), null);
});

/** Poll for a condition: no sleeps for async. */
async function poll(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
