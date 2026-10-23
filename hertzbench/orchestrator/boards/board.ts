// What the runner needs from something that plays a board. The real one starts
// a Velxio ESP32 worker under QEMU; the scripted one is a labelled stand-in for
// hosts and CI jobs without libqemu.

import type { Clock } from "../../engine/mod.ts";
import type { ScenarioNode } from "../scenario.ts";

export interface PeerInfo {
  id: string;
  ip: string;
  mac: string;
}

export interface BoardContext {
  node: ScenarioNode;
  /** The node's listener on the adapter, or null for the internet-gateway node, which keeps SLIRP. */
  netPort: number | null;
  /** Every other board on the medium. */
  peers: readonly PeerInfo[];
  /** The virtual gateway that answers ARP and DHCP. */
  gateway: { ip: string; mac: string; subnetMask: string };
  clock: Clock;
  /** Directory for this run's files (eFuse images, worker logs). */
  outDir: string;
  /** One complete line of the board's serial output. */
  onSerial(line: string): void;
  /** Something went wrong that the report must show (a crash, a worker error). */
  onProblem(message: string): void;
}

export interface RunningBoard {
  /** Which clock the board's time follows, for the report. */
  readonly clockDescription: string;
  stop(): Promise<void>;
}

export interface BoardLauncher {
  /** What this board is, in fidelity terms, for the report. */
  readonly fidelity: string;
  start(context: BoardContext): Promise<RunningBoard>;
}

export class BoardError extends Error {
  override name = "BoardError";
}
