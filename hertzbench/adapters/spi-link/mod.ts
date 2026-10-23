export * from "./adapter.ts";
export * from "./client.ts";
export * from "./device.ts";
export * from "./protocol.ts";

/**
 * The field the Velxio ESP32 worker reads from its stdin config to put a radio
 * chip model on the guest's SPI bus (see hertzbench/docs/upstream-sync.md,
 * patch 2). This is the contract between the adapter and the worker patch.
 */
export interface WorkerRadioSpiConfig {
  radio_spi: {
    /** Loopback TCP port of this node's spi-link listener. */
    port: number;
    /** GPIO of the chip select: the worker forwards SPI bytes only while it is low. */
    cs: number;
    /** GPIOs the chip reads (chip select, reset, CE): the worker forwards their edges. */
    watch: number[];
  };
}

export function workerRadioSpiConfig(
  port: number,
  cs: number,
  watch: number[],
): WorkerRadioSpiConfig {
  return { radio_spi: { port, cs, watch: [...new Set([cs, ...watch])] } };
}
