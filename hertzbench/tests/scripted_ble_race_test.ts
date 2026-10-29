// Regression: a scripted BLE central connecting two peers through the accept
// list, when the controller's Command Status for LE Create Connection and the
// LE Connection Complete that follows reach the host in one socket read. Both
// events are then handled in one feed(), before the Create Connection await
// resumes, so the re-initiate queued by the connection must still go ahead.

import { assert, assertEquals } from "@std/assert";
import { ManualClock } from "../engine/mod.ts";
import {
  addressToBytes,
  encodeHci,
  EVT,
  H4Decoder,
  LE_SUBEVENT,
  OP,
  u16,
} from "../adapters/ble-hci/hci.ts";
import type { BoardContext, PeerInfo } from "../orchestrator/boards/board.ts";
import { startScriptedBleBoard } from "../orchestrator/boards/scripted-ble.ts";

const HOST_ADDRESS = "02:68:7a:62:01:01";
const PHONE: PeerInfo = { id: "phone", index: 2, ip: "192.168.4.12", mac: "02:68:7a:62:01:02" };
const WATCH: PeerInfo = { id: "watch", index: 3, ip: "192.168.4.13", mac: "02:68:7a:62:01:03" };

function event(code: number, params: ArrayLike<number>): Uint8Array {
  return encodeHci({ type: "event", code, params: Uint8Array.from(params) });
}

function commandComplete(op: number, params: ArrayLike<number> = []): Uint8Array {
  return event(EVT.commandComplete, [1, ...u16(op), 0, ...Array.from(params)]);
}

function connectionComplete(handle: number, peer: string): Uint8Array {
  return event(EVT.leMeta, [
    LE_SUBEVENT.connectionComplete,
    0, // success
    ...u16(handle),
    0, // central
    0,
    ...addressToBytes(peer),
    ...u16(24),
    ...u16(0),
    ...u16(400),
    0,
  ]);
}

/** Command Status for LE Create Connection and the connection to `peer`, in one buffer. */
function statusThenConnected(handle: number, peer: string): Uint8Array {
  const status = event(EVT.commandStatus, [0, 1, ...u16(OP.leCreateConnection)]);
  const connected = connectionComplete(handle, peer);
  const both = new Uint8Array(status.length + connected.length);
  both.set(status);
  both.set(connected, status.length);
  return both;
}

/** A fake controller on a loopback port that answers each command with one write. */
class FakeController {
  readonly listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  readonly commands: { op: number; params: Uint8Array }[] = [];
  conn: Deno.TcpConn | null = null;
  readonly #loop: Promise<void>;
  readonly #connectTo: string[];

  constructor(connectTo: string[]) {
    this.#connectTo = [...connectTo];
    this.#loop = this.#run();
  }

  get port(): number {
    return (this.listener.addr as Deno.NetAddr).port;
  }

  #reply(op: number): Uint8Array {
    if (op === OP.leReadBufferSize) return commandComplete(op, [...u16(27), 3]);
    if (op === OP.readBdAddr) return commandComplete(op, addressToBytes(HOST_ADDRESS));
    if (op === OP.leCreateConnection) {
      const peer = this.#connectTo.shift();
      if (!peer) throw new Error("an LE Create Connection nobody expected");
      return statusThenConnected(0x40 + this.#connectTo.length, peer);
    }
    return commandComplete(op);
  }

  async #run(): Promise<void> {
    try {
      const conn = await this.listener.accept();
      this.conn = conn;
      const decoder = new H4Decoder();
      const buffer = new Uint8Array(4096);
      for (;;) {
        const n = await conn.read(buffer);
        if (n === null) break;
        for (const packet of decoder.push(buffer.slice(0, n))) {
          if (packet.type !== "command") continue;
          this.commands.push({ op: packet.opcode, params: packet.params });
          // One write per answer: a few dozen bytes on loopback arrive in one read.
          await conn.write(this.#reply(packet.opcode));
        }
      }
    } catch {
      // Closed by close().
    }
  }

  async close(): Promise<void> {
    this.listener.close();
    try {
      this.conn?.close();
    } catch {
      // The board closed it first.
    }
    await this.#loop;
  }
}

async function until(cond: () => boolean, what: () => string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what()}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

Deno.test("scripted-ble: a central re-initiates when Command Status and Connection Complete share one read", async () => {
  const controller = new FakeController([PHONE.mac, WATCH.mac]);
  const serial: string[] = [];
  const problems: string[] = [];
  const ctx: BoardContext = {
    node: {
      id: "hub",
      board: "scripted",
      firmware: {
        kind: "script",
        send: [],
        serve: [],
        subscribe: [],
        listen: false,
        ble: {
          advertise: null,
          connect: { peers: ["phone", "watch"], intervalMs: 30, timeoutMs: 1000 },
          scan: false,
        },
      },
      position: { x: 10, y: 0 },
      radio: { phy: "ble", txPowerDbm: 0, antennaGainDbi: 0, hciUart: 1 },
      ip: "192.168.4.11",
      mac: HOST_ADDRESS,
      internetGateway: false,
    },
    nodeIndex: 1,
    netPort: null,
    peers: [PHONE, WATCH],
    gateway: { ip: "192.168.4.1", mac: "02:68:7a:62:00:01", subnetMask: "255.255.255.0" },
    clock: new ManualClock(),
    outDir: "/nonexistent/scripted-board-out",
    onSerial: (line) => serial.push(line),
    onProblem: (message) => problems.push(message),
  };
  const board = await startScriptedBleBoard(ctx, controller.port);
  try {
    await until(
      () => serial.includes("ble connected to watch as central"),
      () =>
        `the second connection; serial: ${JSON.stringify(serial)}, commands: ${
          JSON.stringify(controller.commands.map((c) => c.op.toString(16)))
        }`,
    );
    assertEquals(serial, [
      `ble ready addr=${HOST_ADDRESS}`,
      "ble connected to phone as central",
      "ble connected to watch as central",
    ]);
    // After Reset, the event masks, Read Buffer Size and Read BD_ADDR: both peers, then watch alone.
    assertEquals(controller.commands.slice(5).map((c) => c.op), [
      OP.leClearAcceptList,
      OP.leAddToAcceptList,
      OP.leAddToAcceptList,
      OP.leCreateConnection,
      OP.leClearAcceptList,
      OP.leAddToAcceptList,
      OP.leCreateConnection,
    ]);
    assertEquals(controller.commands[10]?.params.subarray(1), addressToBytes(WATCH.mac));
    assert(problems.length === 0, problems.join("\n"));
  } finally {
    await board.stop();
    await controller.close();
  }
});
