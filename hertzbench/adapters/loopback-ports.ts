// One loopback TCP listener per node, so the port identifies the node and a
// board can only ever speak as itself. The board connects to its node's port
// as the client; the listener therefore has to be up before the board starts.
// What the bytes mean is the adapter's business: each connection gets a fresh
// handler from the adapter, and anything it throws is reported and ends that
// connection. Shared by qemu-wifi-l2 and spi-link.

export const LOOPBACK = "127.0.0.1";

/** Takes the bytes of one read. Throwing reports the error's message and closes the connection. */
export type ChunkHandler = (chunk: Uint8Array) => void;

interface Port {
  nodeId: string;
  listener: Deno.TcpListener;
  conn: Deno.TcpConn | null;
  /** Writes are chained so bytes reach the board in the order they were sent. */
  writes: Promise<void>;
  /** Pending waitConnected calls; each is called with nothing on connect, or an error on close. */
  waiters: Set<(error?: Error) => void>;
  loops: Promise<void>[];
  newHandler: () => ChunkHandler;
}

function isDisconnect(error: unknown): boolean {
  return error instanceof Deno.errors.ConnectionReset ||
    error instanceof Deno.errors.ConnectionAborted ||
    error instanceof Deno.errors.BrokenPipe ||
    error instanceof Deno.errors.BadResource ||
    error instanceof Deno.errors.Interrupted;
}

export class LoopbackPorts {
  readonly #onProblem: (nodeId: string, message: string) => void;
  readonly #ports = new Map<string, Port>();
  #closed = false;

  constructor(onProblem: (nodeId: string, message: string) => void) {
    this.#onProblem = onProblem;
  }

  /** Start listening for a node's board; returns the port the OS picked. */
  listen(nodeId: string, newHandler: () => ChunkHandler): number {
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
      newHandler,
    };
    this.#ports.set(nodeId, port);
    port.loops.push(this.#acceptLoop(port));
    return (listener.addr as Deno.NetAddr).port;
  }

  isConnected(nodeId: string): boolean {
    return this.#ports.get(nodeId)?.conn != null;
  }

  /** Resolve when the board has connected; reject after `timeoutMs` or when the ports close. */
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

  /** Queue bytes to the node's board; dropped when no board is connected. */
  send(nodeId: string, bytes: Uint8Array): void {
    const port = this.#ports.get(nodeId);
    const conn = port?.conn;
    if (!port || !conn) return;
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
          // One board per node. A second connection would let two peers share an identity.
          conn.close();
          this.#onProblem(port.nodeId, "rejected a second connection to the node's port");
          continue;
        }
        conn.setNoDelay(true);
        port.conn = conn;
        for (const settle of [...port.waiters]) settle();
        port.loops.push(this.#readLoop(port, conn, port.newHandler()));
      }
    } catch (error) {
      if (!this.#closed && !isDisconnect(error)) {
        this.#onProblem(port.nodeId, `accept failed: ${error}`);
      }
    }
  }

  async #readLoop(port: Port, conn: Deno.TcpConn, handle: ChunkHandler): Promise<void> {
    const buffer = new Uint8Array(65536);
    try {
      for (;;) {
        let n: number | null;
        try {
          n = await conn.read(buffer);
        } catch (error) {
          if (!isDisconnect(error)) this.#onProblem(port.nodeId, `read failed: ${error}`);
          return;
        }
        if (n === null) return;
        try {
          handle(buffer.subarray(0, n));
        } catch (error) {
          this.#onProblem(port.nodeId, error instanceof Error ? error.message : String(error));
          return;
        }
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
}
