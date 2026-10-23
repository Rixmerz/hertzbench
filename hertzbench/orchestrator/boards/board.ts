// What the runner needs from something that plays a board. The real one starts
// a Velxio ESP32 worker under QEMU; the scripted one is a labelled stand-in for
// hosts and CI jobs without libqemu.

import type { Clock } from "../../engine/mod.ts";
import type { ScenarioNode } from "../scenario.ts";

export interface PeerInfo {
  id: string;
  /** 1-based position in the scenario's node list; scripted nRF24 boards derive addresses from it. */
  index: number;
  ip: string;
  mac: string;
}

export interface BoardContext {
  node: ScenarioNode;
  /** 1-based position of the node in the scenario's node list. */
  nodeIndex: number;
  /**
   * The node's listener on its adapter: qemu-wifi-l2 for a Wi-Fi node, spi-link
   * for a LoRa or nRF24 node; null for the internet-gateway node, which keeps SLIRP.
   */
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
  /** Bytes into the board's serial console (UART0). Absent where the board has none. */
  writeSerial?(bytes: Uint8Array): Promise<void>;
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
