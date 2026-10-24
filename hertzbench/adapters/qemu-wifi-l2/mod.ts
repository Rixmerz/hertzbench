export * from "./adapter.ts";
export * from "./efuse.ts";
export * from "./framing.ts";

/**
 * The fields the Velxio ESP32 worker reads from its stdin config to attach the
 * Wi-Fi NIC to the engine instead of SLIRP (see hertzbench/docs/upstream-sync.md).
 * This is the contract between the adapter and the worker patch.
 */
export interface WorkerNetworkConfig {
  /** Loopback TCP port of this node's listener; the worker builds the `socket` netdev from it. */
  wifi_l2_port: number;
  /** Path to the writable per-board eFuse image holding the station MAC. */
  efuse_image: string;
}

export function workerNetworkConfig(port: number, efuseImagePath: string): WorkerNetworkConfig {
  return { wifi_l2_port: port, efuse_image: efuseImagePath };
}
