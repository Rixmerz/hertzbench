// What the runner needs from something that plays a board. The real one starts
// a Velxio ESP32 worker under QEMU; the scripted one is a labelled stand-in for
// hosts and CI jobs without libqemu.

import type { Clock } from "../../engine/mod.ts";
import type { AndroidIntent, ScenarioNode } from "../scenario.ts";

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

/** A message a live tool has a scripted MQTT broker publish, as if a client had sent it. */
export interface LiveMqttPublish {
  topic: string;
  payload: Uint8Array;
  /** Keep it for clients that subscribe later; an empty retained payload clears the topic's. */
  retain: boolean;
  /** Which of the node's MQTT services; null when it serves exactly one. */
  port: number | null;
}

/** One send a live tool asks of a scripted Wi-Fi or BLE board, the way its own `send` entries do. */
export interface LiveSend {
  via: "udp" | "espnow" | "mqtt" | "gatt";
  /** A node id; "broadcast" for ESP-NOW to every station on the channel. */
  to: string;
  /** The bytes as given: unlike a scheduled send, no ":<sequence>" is appended. */
  payload: Uint8Array;
  /** UDP: the port both ends use. MQTT: the broker's port. Unused by ESP-NOW and GATT. */
  port: number;
  /** MQTT only: the topic published to. */
  topic?: string;
}

export interface RunningBoard {
  /** Which clock the board's time follows, for the report. */
  readonly clockDescription: string;
  /** Bytes into the board's serial console (UART0). Absent where the board has none. */
  writeSerial?(bytes: Uint8Array): Promise<void>;
  /**
   * Publishes through the MQTT broker this board serves, to every client subscribed to a matching
   * filter; returns how many client sessions it was written to. Absent where the board runs no broker
   * the simulation can reach. Throws BoardError when it cannot.
   */
  publishMqtt?(publish: LiveMqttPublish): number;
  /** Sends once over a network path the board's script could use. Absent where it cannot. */
  sendPayload?(send: LiveSend): Promise<void>;
  /** Delivers an intent to the board's app (`am broadcast` or `am start`). Absent where there is no app. */
  sendIntent?(intent: AndroidIntent): Promise<void>;
  /**
   * Runs the app's instrumented tests, each result a serial line as it arrives. Settles when they
   * end; throws BoardError when the run as a whole fails. Absent where there is no app.
   */
  runInstrumentation?(): Promise<void>;
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
