// The host side of the BLE bridge: a GATT peripheral a real phone connects
// to. The real one is BlueZ (bluez.ts); tests give a stand-in. The bridge
// hands it the table it discovered on the simulated node and answers the
// phone's operations by replaying them on the simulated air.

import type { DiscoveredService } from "../../orchestrator/boards/drivers/att.ts";

/** A phone operation the bridge could not carry out; the peripheral reports it to the phone. */
export class GattOperationError extends Error {
  override name = "GattOperationError";
  /** "not-permitted" when the node refused it, "failed" for anything else (not connected, timed out). */
  readonly kind: "not-permitted" | "failed";
  constructor(message: string, kind: "not-permitted" | "failed") {
    super(message);
    this.kind = kind;
  }
}

/** What the phone does, keyed by the characteristic's value handle on the simulated node. */
export interface PeripheralHandlers {
  read(handle: number): Promise<Uint8Array>;
  write(handle: number, value: Uint8Array, withResponse: boolean): Promise<void>;
  subscribe(handle: number, enabled: boolean): Promise<void>;
}

export interface GattPeripheral {
  /** For the report: "BlueZ on hci0", or what a stand-in is. */
  readonly description: string;
  /**
   * Reach the host side before the bridge connects to the node, so a missing one ends the run at
   * time zero (a BridgeStartError) instead of after the node's table is discovered. BlueZ needs
   * the table to register, so it has none.
   */
  open?(): Promise<void>;
  /** Register the table and advertise `name`; resolves when the phone can connect. */
  start(services: DiscoveredService[], name: string, handlers: PeripheralHandlers): Promise<void>;
  /** The node notified or indicated: pass it to a subscribed phone. */
  notify(handle: number, value: Uint8Array): void;
  close(): Promise<void>;
}
