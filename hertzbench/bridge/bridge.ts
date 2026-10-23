// What the runner sees of a mobile bridge, whichever kind: started at time
// zero, closed with the run, and described in the report.

import type { BleBridgeSpec, IpBridgeSpec } from "../orchestrator/scenario.ts";
import type { GattPeripheral } from "./ble/peripheral.ts";
import type { BridgeEndpoint, EndpointPublisher } from "./ip/proxy.ts";

/** Replace the parts of a bridge that touch the host's network or radio (tests). */
export interface BridgeHooks {
  /** Announces the IP bridge's endpoints; default: mDNS when the scenario asks for it. */
  publisher?: (spec: IpBridgeSpec) => EndpointPublisher | null;
  /** The BLE bridge's host side; default: BlueZ on the scenario's adapter. */
  peripheral?: (spec: BleBridgeSpec) => GattPeripheral;
}

/** One characteristic the BLE bridge mirrors, as the report lists it. */
export interface MirroredCharacteristic {
  uuid: string;
  /** Its value handle on the simulated node. */
  handle: number;
  properties: string[];
}

export interface MirroredService {
  uuid: string;
  characteristics: MirroredCharacteristic[];
}

export type BridgeReport =
  | {
    kind: "ip";
    id: string;
    endpoints: BridgeEndpoint[];
    /** What mDNS advertised, or why nothing was. */
    mdns: string;
  }
  | {
    kind: "ble";
    id: string;
    mirror: string;
    adapter: string;
    name: string;
    /** The GATT server discovered on the node; empty until the first connection. */
    services: MirroredService[];
    /** The host side: BlueZ, or the stand-in a test gave. */
    peripheral: string;
  };

export interface RunningBridge {
  readonly id: string;
  /** Called at time zero. A failure here ends the run before it starts. */
  start(): Promise<void>;
  close(): Promise<void>;
  report(): BridgeReport;
}

/** The report's fidelity line for the bridge (PLAN.md D10). */
export const BRIDGE_FIDELITY = {
  ip: "the phone's TCP ends at the host proxy and that leg is the real LAN, not modelled; " +
    "the bridge's own TCP to the node crosses the medium from the bridge's position, so every " +
    "segment pays the channel model",
  ble: "the phone's GATT operations end at BlueZ on the host and that leg is a real radio, not " +
    "modelled; each one is replayed as ATT from the bridge's node on the simulated air, so it " +
    "pays the channel model, and the phone sees the node's answer",
} as const;

/** Where a phone connects, one line each, for the progress output and the report. */
export function bridgeLines(report: BridgeReport): string[] {
  if (report.kind === "ip") {
    return [
      ...report.endpoints.map((e) =>
        `bridge ${report.id}: ${e.service} ${e.node}:${e.port} at ${e.host}:${e.hostPort}`
      ),
      `bridge ${report.id}: mDNS ${report.mdns}`,
    ];
  }
  return [
    `bridge ${report.id}: mirrors ${report.mirror}'s GATT server as "${report.name}" on ${report.adapter} (${report.peripheral})`,
  ];
}
