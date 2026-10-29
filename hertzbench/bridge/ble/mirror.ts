// Phase 5b, the BLE bridge: a phone reaches a simulated peripheral's GATT
// server through BlueZ on the host.
//
// The phone enters the engine as the bridge's node: a virtual controller on
// the simulated air at the scenario's position, driven by a host that is a
// central. It connects to the mirrored node, discovers its GATT server, and
// hands the table to the host's peripheral (BlueZ), which advertises it to
// the phone. Each phone operation (read, write, subscribe) is replayed as ATT
// from the bridge's node over the simulated connection, so it pays the
// channel model and the connection events, and the phone gets the node's own
// answer, error included. The node's notifications come back the same way.
//
// What is not mirrored (docs/fidelity.md, "Mobile bridge"): the phone's own
// link to the host, ATT handles (BlueZ assigns its own), the MTU (the
// simulated leg stays at 23) and security.

import type { BleController } from "../../adapters/ble-hci/mod.ts";
import { STATUS } from "../../adapters/ble-hci/hci.ts";
import type { Clock } from "../../engine/mod.ts";
import {
  ATT_ERROR,
  AttClient,
  AttError,
  type DiscoveredService,
  PROPERTY,
  propertyNames,
} from "../../orchestrator/boards/drivers/att.ts";
import { HciHost } from "../../orchestrator/boards/drivers/hci-host.ts";
import type { BleBridgeSpec } from "../../orchestrator/scenario.ts";
import type { BridgeReport, RunningBridge } from "../bridge.ts";
import { GattOperationError, type GattPeripheral, type PeripheralHandlers } from "./peripheral.ts";

export interface BleBridgeOptions {
  spec: BleBridgeSpec;
  /** Device address of the mirrored node. */
  mirrorAddress: string;
  clock: Clock;
  /** Builds the bridge's controller on the air with the function it answers the host through. */
  makeController(toHost: (bytes: Uint8Array) => void): BleController;
  peripheral: GattPeripheral;
  log(line: string): void;
  onProblem(message: string): void;
}

/**
 * GAP (0x1800) and GATT (0x1801): every GATT server has them, and the host's
 * peripheral publishes its own. BlueZ refuses a second copy of either
 * ("Failed to create entry in database"), which is what Bluedroid's table
 * carries, so they are left out of what the phone is handed.
 */
const HOST_OWNED_SERVICES = new Set([
  "00001800-0000-1000-8000-00805f9b34fb",
  "00001801-0000-1000-8000-00805f9b34fb",
]);

/** The discovered services the host's peripheral should publish to the phone. */
export function servicesToPublish(services: DiscoveredService[]): DiscoveredService[] {
  return services.filter((s) => !HOST_OWNED_SERVICES.has(s.uuid.toLowerCase()));
}

export class BleBridge implements RunningBridge {
  readonly id: string;
  readonly controller: BleController;
  readonly #opts: BleBridgeOptions;
  readonly #host: HciHost;
  #att: AttClient | null = null;
  #handle: number | null = null;
  #services: DiscoveredService[] = [];
  #published = false;
  /** Value handles the phone subscribed to, kept across reconnections. */
  readonly #subscribed = new Set<number>();
  #jobs: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(opts: BleBridgeOptions) {
    this.id = opts.spec.id;
    this.#opts = opts;
    // In-process HCI: each direction is handed over on its own microtask, as a UART would.
    this.controller = opts.makeController((bytes) => queueMicrotask(() => this.#host.feed(bytes)));
    this.#host = new HciHost((bytes) => {
      queueMicrotask(() => this.controller.fromHost(bytes));
      return Promise.resolve();
    }, {
      connected: (handle, role, peer, status) => this.#onConnected(handle, role, peer, status),
      disconnected: (handle, reason) => this.#onDisconnected(handle, reason),
      att: (handle, pdu) => {
        if (handle === this.#handle) this.#att?.handle(pdu);
      },
    });
  }

  report(): BridgeReport {
    const { spec, peripheral } = this.#opts;
    return {
      kind: "ble",
      id: this.id,
      mirror: spec.mirror,
      // The netsim backend has no BlueZ adapter: the report says where the host side is instead.
      adapter: spec.peripheral === "netsim" ? "netsim" : spec.adapter,
      name: spec.name,
      services: this.#services.map((s) => ({
        uuid: s.uuid,
        characteristics: s.characteristics.map((c) => ({
          uuid: c.uuid,
          handle: c.valueHandle,
          properties: propertyNames(c.properties),
        })),
      })),
      peripheral: peripheral.description,
    };
  }

  async start(): Promise<void> {
    await this.#opts.peripheral.open?.();
    await this.#host.init();
    this.#opts.log(`bridge ready addr=${this.#host.address}`);
    await this.#connect();
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#att?.close("the bridge shut down");
    this.#host.fail(new Error("the bridge shut down"));
    await this.#jobs;
    await this.#opts.peripheral.close();
  }

  async #connect(): Promise<void> {
    const { spec, mirrorAddress } = this.#opts;
    await this.#host.setAcceptList([mirrorAddress]);
    await this.#host.connectAcceptList(spec.intervalMs, spec.timeoutMs);
    this.#opts.log(`bridge connecting to ${spec.mirror}`);
  }

  #run(job: () => Promise<void>): void {
    this.#jobs = this.#jobs.then(async () => {
      if (this.#closed) return;
      try {
        await job();
      } catch (error) {
        if (!this.#closed) {
          this.#opts.onProblem(error instanceof Error ? error.message : String(error));
        }
      }
    });
  }

  #onConnected(handle: number, role: string, peer: string, status: number): void {
    const { spec, clock, log } = this.#opts;
    if (role !== "central" || status !== STATUS.success || peer !== this.#opts.mirrorAddress) {
      return;
    }
    this.#handle = handle;
    const att = new AttClient((pdu) => this.#host.sendAtt(handle, pdu), clock);
    att.onNotification = (valueHandle, value) => {
      if (!this.#subscribed.has(valueHandle)) return;
      log(`bridge notify ${this.#uuidOf(valueHandle)} ${JSON.stringify(text(value))} to the phone`);
      this.#opts.peripheral.notify(valueHandle, value);
    };
    this.#att = att;
    log(`bridge connected to ${spec.mirror}`);
    this.#run(async () => {
      if (!this.#published) {
        this.#services = await att.discover();
        for (const s of this.#services) {
          log(
            `bridge discovered service ${s.uuid} with ${s.characteristics.length} characteristic(s)`,
          );
        }
        await this.#opts.peripheral.start(
          servicesToPublish(this.#services),
          spec.name,
          this.#handlers,
        );
        this.#published = true;
        log(
          `bridge advertising "${spec.name}" to the phone (${this.#opts.peripheral.description})`,
        );
      } else {
        // A new connection starts with every CCCD off: turn the phone's subscriptions back on.
        for (const valueHandle of this.#subscribed) await this.#writeCccd(valueHandle, true);
      }
    });
  }

  #onDisconnected(handle: number, reason: number): void {
    if (handle !== this.#handle) return;
    this.#handle = null;
    this.#att?.close(`not connected to ${this.#opts.spec.mirror}`);
    this.#att = null;
    this.#opts.log(
      `bridge disconnected from ${this.#opts.spec.mirror} reason=0x${
        reason.toString(16).padStart(2, "0")
      }`,
    );
    if (!this.#closed) this.#run(() => this.#connect());
  }

  #uuidOf(valueHandle: number): string {
    for (const s of this.#services) {
      for (const c of s.characteristics) if (c.valueHandle === valueHandle) return c.uuid;
    }
    return `handle 0x${valueHandle.toString(16).padStart(4, "0")}`;
  }

  #requireAtt(): AttClient {
    if (!this.#att) {
      throw new GattOperationError(`not connected to ${this.#opts.spec.mirror}`, "failed");
    }
    return this.#att;
  }

  async #writeCccd(valueHandle: number, enabled: boolean): Promise<void> {
    const char = this.#services.flatMap((s) => s.characteristics).find((c) =>
      c.valueHandle === valueHandle
    );
    if (!char || char.cccdHandle === null) return;
    const bits = !enabled ? 0 : char.properties & PROPERTY.notify ? 0x0001 : 0x0002;
    await this.#requireAtt().write(char.cccdHandle, Uint8Array.of(bits, 0), true);
  }

  readonly #handlers: PeripheralHandlers = {
    read: (handle) =>
      this.#phone(`read ${this.#uuidOf(handle)}`, async () => {
        const value = await this.#requireAtt().read(handle);
        this.#opts.log(`bridge phone read ${this.#uuidOf(handle)}: ${JSON.stringify(text(value))}`);
        return value;
      }),
    write: (handle, value, withResponse) =>
      this.#phone(`write ${this.#uuidOf(handle)}`, async () => {
        await this.#requireAtt().write(handle, value, withResponse);
        this.#opts.log(
          `bridge phone wrote ${this.#uuidOf(handle)}: ${JSON.stringify(text(value))}`,
        );
      }),
    subscribe: (handle, enabled) =>
      this.#phone(`subscribe ${this.#uuidOf(handle)}`, async () => {
        if (enabled) this.#subscribed.add(handle);
        else this.#subscribed.delete(handle);
        await this.#writeCccd(handle, enabled);
        this.#opts.log(
          `bridge phone ${enabled ? "subscribed to" : "unsubscribed from"} ${this.#uuidOf(handle)}`,
        );
      }),
  };

  /** Run a phone operation, turning ATT errors into what the peripheral tells the phone. */
  async #phone<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#opts.log(`bridge phone ${what} failed: ${message}`);
      if (error instanceof GattOperationError) throw error;
      const refused = error instanceof AttError &&
        (error.code === ATT_ERROR.readNotPermitted || error.code === ATT_ERROR.writeNotPermitted);
      throw new GattOperationError(message, refused ? "not-permitted" : "failed");
    }
  }
}

function text(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}
