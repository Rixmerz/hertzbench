// A scripted BLE board: NOT firmware and NOT a Bluetooth stack. It plays the
// host side of a BLE sketch through the TypeScript HCI host (drivers/hci-host.ts)
// over the same ble-hci socket the ESP32 board's UART relay uses, so the
// virtual controllers, the air, the metrics and the assertions run end to end
// on a host without libqemu.
//
// A peripheral advertises its name and, once connected, sends each `send` as
// an ATT Handle Value Notification on handle 0x0010. A central connects to its
// peers through the filter accept list, reconnects when a link drops, and
// sends ATT Write Commands on the same handle. Both answer any ATT request
// with "Request Not Supported": there is no attribute table to discover.
//
// Serial lines, for `serial:` assertions:
//   ble ready addr=<address>
//   ble advertising as <name>
//   ble connected to <node> as central|peripheral
//   ble disconnected from <node> reason=0x08
//   ble adv "<name>" from <node> rssi=<dBm>      (scan: true)
//   ble tx <text> to <node>          / ble tx <text> to <node> skipped: not connected
//   ble rx "<text>" from <node>

import { LOOPBACK } from "../../adapters/loopback-ports.ts";
import { OP, STATUS } from "../../adapters/ble-hci/hci.ts";
import type { BleScript, ScriptedSend } from "../scenario.ts";
import type { BoardContext, RunningBoard } from "./board.ts";
import { advertisedName, HciHost } from "./drivers/hci-host.ts";

/** The attribute handle scripted boards notify and write. */
export const SCRIPTED_ATT_HANDLE = 0x0010;
const ATT_ERROR_RSP = 0x01;
const ATT_NOTIFY = 0x1b;
const ATT_INDICATE = 0x1d;
const ATT_CONFIRM = 0x1e;
const ATT_WRITE_CMD = 0x52;
const ATT_REQUEST_NOT_SUPPORTED = 0x06;

class ScriptedBleBoard implements RunningBoard {
  readonly clockDescription = "wall clock (scripted board, no guest time)";
  readonly #ctx: BoardContext;
  readonly #conn: Deno.TcpConn;
  readonly #host: HciHost;
  readonly #script: BleScript;
  readonly #cancels = new Set<() => void>();
  readonly #reading: Promise<void>;
  /** Host calls run one at a time, as on a single-core MCU. */
  #queue: Promise<void> = Promise.resolve();
  #writes: Promise<void> = Promise.resolve();
  /** Connection handle by peer node. */
  readonly #handles = new Map<string, number>();
  readonly #peerOf = new Map<number, string>();
  #initiating = false;
  #stopped = false;

  constructor(ctx: BoardContext, conn: Deno.TcpConn, script: BleScript) {
    this.#ctx = ctx;
    this.#conn = conn;
    this.#script = script;
    this.#host = new HciHost((bytes) => this.#write(bytes), {
      connected: (handle, role, peer, status) => this.#onConnected(handle, role, peer, status),
      disconnected: (handle, reason) => this.#onDisconnected(handle, reason),
      advertisingReport: (report) => {
        const name = advertisedName(report.data);
        if (name !== null) {
          ctx.onSerial(
            `ble adv "${name}" from ${this.#nodeOf(report.address)} rssi=${report.rssi}`,
          );
        }
      },
      att: (handle, pdu) => this.#onAtt(handle, pdu),
    });
    this.#reading = this.#readLoop();
    this.#run(() => this.#start());
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const cancel of this.#cancels) cancel();
    this.#cancels.clear();
    this.#host.fail(new StoppedError());
    try {
      this.#conn.close();
    } catch {
      // The adapter closed it first at the end of the run.
    }
    await this.#reading;
    await this.#queue;
  }

  async #write(bytes: Uint8Array): Promise<void> {
    const next = this.#writes.then(async () => {
      let written = 0;
      while (written < bytes.length) written += await this.#conn.write(bytes.subarray(written));
    });
    this.#writes = next.catch(() => {});
    await next;
  }

  async #readLoop(): Promise<void> {
    const buffer = new Uint8Array(4096);
    try {
      for (;;) {
        const n = await this.#conn.read(buffer);
        if (n === null) break;
        this.#host.feed(buffer.slice(0, n));
      }
    } catch {
      // Closed by stop() or by the adapter at the end of the run.
    }
    this.#host.fail(new StoppedError());
  }

  #run(job: () => Promise<void>): void {
    this.#queue = this.#queue.then(async () => {
      if (this.#stopped) return;
      try {
        await job();
      } catch (error) {
        if (!(error instanceof StoppedError) && !this.#stopped) {
          this.#ctx.onProblem(`${this.#ctx.node.id}: scripted BLE host failed: ${error}`);
        }
      }
    });
  }

  #schedule(atMs: number, fn: () => void): void {
    const cancel = this.#ctx.clock.schedule(atMs, () => {
      this.#cancels.delete(cancel);
      if (!this.#stopped) fn();
    });
    this.#cancels.add(cancel);
  }

  #nodeOf(address: string): string {
    return this.#ctx.peers.find((p) => p.mac === address)?.id ?? address;
  }

  async #start(): Promise<void> {
    const ctx = this.#ctx;
    await this.#host.init();
    ctx.onSerial(`ble ready addr=${this.#host.address}`);
    if (this.#script.scan) await this.#host.scan(false, 100, 100, true);
    if (this.#script.advertise) await this.#advertise();
    if (this.#script.connect) await this.#initiate();
    this.#scheduleSends();
  }

  async #advertise(): Promise<void> {
    const advertise = this.#script.advertise;
    if (!advertise) return;
    await this.#host.advertise(advertise.name, advertise.intervalMs);
    this.#ctx.onSerial(`ble advertising as ${advertise.name}`);
  }

  /** Connect to every wanted peer that is not connected, through the accept list. */
  async #initiate(): Promise<void> {
    const connect = this.#script.connect;
    if (!connect || this.#initiating) return;
    const wanted = connect.peers.filter((id) => !this.#handles.has(id));
    if (wanted.length === 0) return;
    const addresses = wanted.flatMap((id) =>
      this.#ctx.peers.filter((p) => p.id === id).map((p) => p.mac)
    );
    await this.#host.setAcceptList(addresses);
    await this.#host.connectAcceptList(connect.intervalMs, connect.timeoutMs);
    this.#initiating = true;
  }

  #onConnected(
    handle: number,
    role: "central" | "peripheral",
    address: string,
    status: number,
  ): void {
    if (role === "central") this.#initiating = false;
    if (status !== STATUS.success) return;
    const peer = this.#nodeOf(address);
    this.#handles.set(peer, handle);
    this.#peerOf.set(handle, peer);
    this.#ctx.onSerial(`ble connected to ${peer} as ${role}`);
    if (role === "central") this.#run(() => this.#initiate());
  }

  #onDisconnected(handle: number, reason: number): void {
    const peer = this.#peerOf.get(handle) ?? `handle ${handle}`;
    this.#peerOf.delete(handle);
    this.#handles.delete(peer);
    this.#ctx.onSerial(
      `ble disconnected from ${peer} reason=0x${reason.toString(16).padStart(2, "0")}`,
    );
    if (this.#script.advertise) this.#run(() => this.#advertise());
    if (this.#script.connect) {
      // An initiator scanning for the other peers holds the accept list: cancel it, then start over with this one added.
      this.#run(async () => {
        if (this.#initiating) {
          const cancelled = await this.#host.command(OP.leCreateConnectionCancel);
          if (cancelled.status === STATUS.success) this.#initiating = false;
        }
        await this.#initiate();
      });
    }
  }

  #onAtt(handle: number, pdu: Uint8Array): void {
    const peer = this.#peerOf.get(handle) ?? `handle ${handle}`;
    const op = pdu[0] ?? 0;
    if (op === ATT_NOTIFY || op === ATT_INDICATE || op === ATT_WRITE_CMD) {
      this.#ctx.onSerial(`ble rx "${new TextDecoder().decode(pdu.subarray(3))}" from ${peer}`);
      if (op === ATT_INDICATE) this.#host.sendAtt(handle, Uint8Array.of(ATT_CONFIRM));
    } else if ((op & 1) === 0 && op !== ATT_WRITE_CMD) {
      // A request: there is no attribute table behind this board.
      this.#host.sendAtt(handle, Uint8Array.of(ATT_ERROR_RSP, op, 0, 0, ATT_REQUEST_NOT_SUPPORTED));
    }
  }

  #scheduleSends(): void {
    const ready = this.#ctx.clock.now();
    const firmware = this.#ctx.node.firmware;
    const sends: ScriptedSend[] = firmware.kind === "script" ? firmware.send : [];
    const opcode = this.#script.connect ? ATT_WRITE_CMD : ATT_NOTIFY;
    for (const send of sends) {
      const to = send.to as string;
      for (let seq = 0; seq < send.count; seq++) {
        const text = `${send.payload}:${seq}`;
        this.#schedule(ready + send.startMs + seq * send.everyMs, () => {
          const handle = this.#handles.get(to);
          if (handle === undefined) {
            this.#ctx.onSerial(`ble tx ${text} to ${to} skipped: not connected`);
            return;
          }
          this.#host.sendAtt(
            handle,
            Uint8Array.from([
              opcode,
              SCRIPTED_ATT_HANDLE & 0xff,
              SCRIPTED_ATT_HANDLE >> 8,
              ...new TextEncoder().encode(text),
            ]),
          );
          this.#ctx.onSerial(`ble tx ${text} to ${to}`);
        });
      }
    }
  }
}

class StoppedError extends Error {
  override name = "StoppedError";
}

export async function startScriptedBleBoard(
  ctx: BoardContext,
  port: number,
): Promise<RunningBoard> {
  const firmware = ctx.node.firmware;
  const script = firmware.kind === "script" && firmware.ble
    ? firmware.ble
    : { advertise: null, connect: null, scan: false };
  const conn = await Deno.connect({ hostname: LOOPBACK, port });
  conn.setNoDelay(true);
  return new ScriptedBleBoard(ctx, conn, script);
}
