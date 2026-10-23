// Phase 5a, the IP bridge: a phone on the host's LAN reaches a simulated node.
//
// The bridge is a station on the Wi-Fi medium, at the scenario's position,
// with its own MAC and address. For each exposed `node:port` it listens on a
// host port; every TCP connection a phone opens there becomes a connection
// from the bridge's station to the node, over the engine's TCP, and the bytes
// are relayed both ways. HTTP, WebSocket and MQTT are all TCP underneath, so
// the relay does not look inside them.
//
// What is modelled and what is not (docs/fidelity.md, "Mobile bridge"): the
// phone's own TCP ends at the host. The leg from the bridge's station to the
// node crosses the medium, so every segment pays the channel model between
// the bridge's position and the node's: path loss, walls, MAC retries, link
// overrides, a move. The phone-to-host leg is the real LAN, not modelled.
//
// Only the declared pairs are relayed: a phone cannot use the bridge to reach
// any other address or port (CWE-441).

import {
  type Clock,
  type FrameSink,
  type Rng,
  type TcpConnection,
  TcpError,
  TcpHost,
} from "../../engine/mod.ts";
import type { ExposedService, IpBridgeSpec } from "../../orchestrator/scenario.ts";
import type { BridgeReport, RunningBridge } from "../bridge.ts";

export interface BridgeEndpoint extends ExposedService {
  /** Where a phone connects: the bound host address and port. */
  host: string;
  hostPort: number;
}

/** Announces the endpoints on the LAN (bridge/ip/mdns.ts). */
export interface EndpointPublisher {
  /** Resolves with one line for the report: what was advertised, or why nothing was. */
  publish(endpoints: readonly BridgeEndpoint[]): Promise<string>;
  close(): Promise<void>;
}

export interface IpBridgeOptions {
  spec: IpBridgeSpec;
  /** Address and MAC of every node the bridge may reach. */
  nodes: ReadonlyMap<string, { ip: string; mac: string }>;
  clock: Clock;
  /** Put a frame on the medium as the bridge's station. */
  transmit(frame: Uint8Array): void;
  /** One line of the bridge's log; the runner logs it as the bridge node's serial. */
  log(line: string): void;
  rng: Rng;
  publisher?: EndpointPublisher;
}

export class BridgeStartError extends Error {
  override name = "BridgeStartError";
}

export class IpBridge implements RunningBridge {
  readonly id: string;
  readonly #opts: IpBridgeOptions;
  readonly #tcp: TcpHost;
  readonly #listeners: Deno.TcpListener[] = [];
  readonly #accepting: Promise<void>[] = [];
  readonly #relays = new Set<Promise<void>>();
  readonly #clients = new Set<{ host: Deno.TcpConn; sim: TcpConnection | null }>();
  #endpoints: BridgeEndpoint[] = [];
  #mdns = "off (the scenario turned it off, or the proxy listens on loopback only)";
  #closed = false;

  constructor(opts: IpBridgeOptions) {
    this.id = opts.spec.id;
    this.#opts = opts;
    const macs = new Map([...opts.nodes.values()].map((n) => [n.ip, n.mac]));
    this.#tcp = new TcpHost({
      mac: opts.spec.mac,
      ip: opts.spec.ip,
      clock: opts.clock,
      send: (frame) => opts.transmit(frame),
      macFor: (ip) => macs.get(ip) ?? null,
      rng: opts.rng,
    });
  }

  /** Hand this to `Medium.addNode` for the bridge's station. */
  readonly sink: FrameSink = {
    ready: () => !this.#closed,
    deliver: (frame) => void this.#tcp.receive(frame),
  };

  report(): BridgeReport {
    return { kind: "ip", id: this.id, endpoints: [...this.#endpoints], mdns: this.#mdns };
  }

  /** Open a host listener per exposed port, then announce them. */
  async start(): Promise<void> {
    const { spec } = this.#opts;
    for (const exposed of spec.expose) {
      let listener: Deno.TcpListener;
      try {
        listener = Deno.listen({ hostname: spec.listen, port: exposed.listenPort });
      } catch (error) {
        await this.close();
        throw new BridgeStartError(listenFailure(spec.listen, exposed.listenPort, error));
      }
      this.#listeners.push(listener);
      const endpoint: BridgeEndpoint = {
        ...exposed,
        host: spec.listen,
        hostPort: (listener.addr as Deno.NetAddr).port,
      };
      this.#endpoints.push(endpoint);
      this.#accepting.push(this.#accept(listener, endpoint));
      this.#opts.log(
        `bridge listening on ${endpoint.host}:${endpoint.hostPort} for ${exposed.node}:${exposed.port} (${exposed.service})`,
      );
    }
    if (this.#opts.publisher) this.#mdns = await this.#opts.publisher.publish(this.#endpoints);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#listeners) {
      try {
        listener.close();
      } catch {
        // Already closed.
      }
    }
    for (const client of this.#clients) {
      client.sim?.abort("the bridge shut down");
      closeQuietly(client.host);
    }
    this.#tcp.close();
    await Promise.allSettled([...this.#accepting, ...this.#relays]);
    await this.#opts.publisher?.close();
  }

  async #accept(listener: Deno.TcpListener, endpoint: BridgeEndpoint): Promise<void> {
    try {
      for await (const conn of listener) {
        if (this.#closed) {
          closeQuietly(conn);
          break;
        }
        const relay = this.#relay(conn, endpoint);
        this.#relays.add(relay);
        void relay.finally(() => this.#relays.delete(relay));
      }
    } catch (error) {
      // Closed by close(); anything else is worth a line in the log.
      if (!this.#closed) {
        this.#opts.log(`bridge stopped accepting on ${endpoint.hostPort}: ${error}`);
      }
    }
  }

  async #relay(host: Deno.TcpConn, endpoint: BridgeEndpoint): Promise<void> {
    const { log, nodes } = this.#opts;
    const remote = host.remoteAddr as Deno.NetAddr;
    const who = `${remote.hostname}:${remote.port} -> ${endpoint.node}:${endpoint.port}`;
    const client: { host: Deno.TcpConn; sim: TcpConnection | null } = { host, sim: null };
    this.#clients.add(client);
    const target = nodes.get(endpoint.node);
    try {
      if (!target) throw new TcpError(`${endpoint.node} is not on the medium`);
      log(`bridge ${who} connecting`);
      const sim = await this.#tcp.connect(target.ip, endpoint.port);
      client.sim = sim;
      log(`bridge ${who} connected`);
      const done = new Promise<TcpError | null>((resolve) =>
        sim.onClose((error) => {
          // A reset or a timeout on the medium ends the phone's connection too.
          if (error) closeQuietly(host);
          resolve(error);
        })
      );
      // Node to phone. Writes go one after the other, in order.
      let toHost = Promise.resolve();
      sim.onData((bytes) => {
        toHost = toHost.then(() => writeAll(host, bytes)).catch(() => sim.abort("phone went away"));
      });
      sim.onEnd(() => {
        toHost = toHost.then(() => host.closeWrite()).catch(() => {});
      });
      // Phone to node, with backpressure: the next read waits for room in the send buffer.
      const buffer = new Uint8Array(16 * 1024);
      try {
        for (;;) {
          const n = await host.read(buffer);
          if (n === null) break;
          await sim.write(buffer.slice(0, n));
        }
        sim.end();
      } catch (error) {
        if (!(error instanceof TcpError)) sim.abort("phone went away");
      }
      const error = await done;
      await toHost;
      log(
        `bridge ${who} closed${error ? ` (${error.message})` : ""}: ` +
          `${sim.bytesSent} B to the node, ${sim.bytesReceived} B from it`,
      );
    } catch (error) {
      log(`bridge ${who} failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.#clients.delete(client);
      closeQuietly(host);
    }
  }
}

async function writeAll(conn: Deno.Conn, bytes: Uint8Array): Promise<void> {
  let written = 0;
  while (written < bytes.length) written += await conn.write(bytes.subarray(written));
}

function closeQuietly(conn: Deno.Conn): void {
  try {
    conn.close();
  } catch {
    // Already closed by the other direction.
  }
}

/** What to tell the person when a host port cannot be opened. */
function listenFailure(host: string, port: number, error: unknown): string {
  const where = `${host}:${port === 0 ? "<any port>" : port}`;
  if (error instanceof Deno.errors.NotCapable || error instanceof Deno.errors.PermissionDenied) {
    return `the bridge may not listen on ${where}: Deno's network permission is limited to ` +
      `127.0.0.1. To reach it from a phone, run with \`deno task lan\` (see docs/mobile-bridge.md)`;
  }
  if (error instanceof Deno.errors.AddrInUse) {
    return `the bridge cannot listen on ${where}: the port is already in use`;
  }
  if (error instanceof Deno.errors.AddrNotAvailable) {
    return `the bridge cannot listen on ${where}: the host has no such address`;
  }
  return `the bridge cannot listen on ${where}: ${error instanceof Error ? error.message : error}`;
}
