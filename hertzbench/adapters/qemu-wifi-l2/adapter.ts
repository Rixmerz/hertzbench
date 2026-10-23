// qemu-wifi-l2: connects each board's QEMU `stream` netdev to the engine.
//
// One loopback TCP listener per node, so the port identifies the node and a
// board can only ever speak as itself. QEMU connects to its node's port as the
// client (`server=off`); the adapter therefore has to be listening before the
// board starts. Frames QEMU sends are handed to `onFrame`; frames the engine
// delivers are written back with the same length-prefix framing.
//
// Fidelity F2: frames are captured at the netdev, after the guest's embedded
// access point has turned 802.11 into Ethernet, so the adapter sees what the
// guest's IP stack sent, not the 802.11 exchange behind it.

import type { FrameSink } from "../../engine/mod.ts";
import { encodeFrame, FrameDecoder, FramingError } from "./framing.ts";

export const LOOPBACK = "127.0.0.1";

export type FrameHandler = (nodeId: string, frame: Uint8Array) => void;

export interface NodeAttachment {
  nodeId: string;
  /** Port the board's QEMU netdev connects to. */
  port: number;
  /** Hand this to `Medium.addNode`. */
  sink: FrameSink;
}

interface Port {
  nodeId: string;
  listener: Deno.TcpListener;
  conn: Deno.TcpConn | null;
  /** Writes are chained so frames reach the board in the order the engine delivered them. */
  writes: Promise<void>;
  /** Pending waitConnected calls; each is called with nothing on connect, or an error on close. */
  waiters: Set<(error?: Error) => void>;
  loops: Promise<void>[];
}

function isDisconnect(error: unknown): boolean {
  return error instanceof Deno.errors.ConnectionReset ||
    error instanceof Deno.errors.ConnectionAborted ||
    error instanceof Deno.errors.BrokenPipe ||
    error instanceof Deno.errors.BadResource ||
    error instanceof Deno.errors.Interrupted;
}

export class QemuWifiL2Adapter {
  readonly #onFrame: FrameHandler;
  readonly #onProblem: (nodeId: string, message: string) => void;
  readonly #ports = new Map<string, Port>();
  #closed = false;

  constructor(
    onFrame: FrameHandler,
    onProblem: (nodeId: string, message: string) => void = () => {},
  ) {
    this.#onFrame = onFrame;
    this.#onProblem = onProblem;
  }

  /** Start listening for a node's board. Port 0 lets the OS pick; the chosen port is returned. */
  listen(nodeId: string): NodeAttachment {
    if (this.#closed) throw new Error("adapter is closed");
    if (this.#ports.has(nodeId)) {
      throw new Error(`node ${JSON.stringify(nodeId)} is already attached`);
    }
    const listener = Deno.listen({ hostname: LOOPBACK, port: 0 });
    const port: Port = {
      nodeId,
      listener,
      conn: null,
      writes: Promise.resolve(),
      waiters: new Set(),
      loops: [],
    };
    this.#ports.set(nodeId, port);
    port.loops.push(this.#acceptLoop(port));
    const sink: FrameSink = {
      ready: () => port.conn !== null,
      deliver: (frame) => this.#write(port, frame),
    };
    return { nodeId, port: (listener.addr as Deno.NetAddr).port, sink };
  }

  isConnected(nodeId: string): boolean {
    return this.#ports.get(nodeId)?.conn != null;
  }

  /** Resolve when the board's QEMU has connected; reject after `timeoutMs` or when the adapter closes. */
  waitConnected(nodeId: string, timeoutMs: number): Promise<void> {
    const port = this.#ports.get(nodeId);
    if (!port) return Promise.reject(new Error(`node ${JSON.stringify(nodeId)} is not attached`));
    if (port.conn) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const settle = (error?: Error) => {
        clearTimeout(timer);
        port.waiters.delete(settle);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () => settle(new Error(`node ${nodeId}: the board did not connect within ${timeoutMs} ms`)),
        timeoutMs,
      );
      port.waiters.add(settle);
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    const loops: Promise<void>[] = [];
    for (const port of this.#ports.values()) {
      for (const settle of [...port.waiters]) {
        settle(new Error(`node ${port.nodeId}: adapter closed`));
      }
      port.listener.close();
      port.conn?.close();
      port.conn = null;
      loops.push(...port.loops, port.writes);
    }
    await Promise.allSettled(loops);
    this.#ports.clear();
  }

  async #acceptLoop(port: Port): Promise<void> {
    try {
      for await (const conn of port.listener) {
        if (port.conn) {
          // One board per node. A second connection would let two peers share a MAC.
          conn.close();
          this.#onProblem(port.nodeId, "rejected a second connection to the node's port");
          continue;
        }
        conn.setNoDelay(true);
        port.conn = conn;
        for (const settle of [...port.waiters]) settle();
        port.loops.push(this.#readLoop(port, conn));
      }
    } catch (error) {
      if (!this.#closed && !isDisconnect(error)) {
        this.#onProblem(port.nodeId, `accept failed: ${error}`);
      }
    }
  }

  async #readLoop(port: Port, conn: Deno.TcpConn): Promise<void> {
    const decoder = new FrameDecoder();
    const buffer = new Uint8Array(65536);
    try {
      for (;;) {
        const n = await conn.read(buffer);
        if (n === null) break;
        for (const frame of decoder.push(buffer.subarray(0, n))) this.#onFrame(port.nodeId, frame);
      }
    } catch (error) {
      if (error instanceof FramingError) {
        this.#onProblem(port.nodeId, error.message);
      } else if (!isDisconnect(error)) {
        this.#onProblem(port.nodeId, `read failed: ${error}`);
      }
    } finally {
      if (port.conn === conn) port.conn = null;
      try {
        conn.close();
      } catch {
        // Already closed by close() or by the peer; nothing left to release.
      }
    }
  }

  #write(port: Port, frame: Uint8Array): void {
    const conn = port.conn;
    if (!conn) return;
    const bytes = encodeFrame(frame);
    port.writes = port.writes.then(async () => {
      try {
        let written = 0;
        while (written < bytes.length) written += await conn.write(bytes.subarray(written));
      } catch (error) {
        // A vanished board is the read loop's to clear; anything else is worth reporting.
        if (!isDisconnect(error)) this.#onProblem(port.nodeId, `write failed: ${error}`);
      }
    });
  }
}
