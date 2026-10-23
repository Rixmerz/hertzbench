// A model of what the lcgamboa QEMU fork's Wi-Fi MAC does with ESP-NOW, for the
// scripted board and the tests: the same three receive filters, the same ACK
// answer, and the same single 10 ms ACK timer with its quirks. It is a model
// of hw/misc/esp32_wifi_ap.c:396-476 and :608-645, not that code; the real
// board runs the fork itself.

import {
  BROADCAST_MAC,
  buildEspNowAck,
  buildEspNowAction,
  type Clock,
  ESPNOW_ACK_TIMEOUT_MS,
  parseEspNow,
} from "../../engine/mod.ts";

/** The packet status the driver reads when the tx-done interrupt fires (ESP32_PHYA_ACK or _NACK). */
export type EspNowTxStatus = "ack" | "nack";

export interface EspNowForkModelOptions {
  mac: string;
  /** The guest's Wi-Fi channel (esp32_wifi_channel). */
  channel: number;
  clock: Clock;
  /** Put a frame on the netdev. */
  output(frame: Uint8Array): void;
  /** An action frame passed the receive filters and went into the guest's RX ring. */
  onReceive(src: string, dst: string, body: Uint8Array): void;
  /** The ACK timer fired: the guest sees a frame completed with this status. */
  onTxDone(status: EspNowTxStatus): void;
}

export class EspNowForkModel {
  readonly #opts: EspNowForkModelOptions;
  #status: EspNowTxStatus = "ack";
  #cancelTimer: (() => void) | null = null;
  readonly #broadcastDone = new Set<() => void>();

  constructor(opts: EspNowForkModelOptions) {
    this.#opts = opts;
  }

  /**
   * The guest sends an action frame. The status is set to ACK first (:591). A
   * broadcast then completes at once and leaves the ACK timer alone; a unicast
   * frame sets NACK and completes when its ACK arrives or after 10 ms
   * (timer_mod, :640-643). Sending again before completion restarts the one
   * timer, as the fork does; callers that want each frame's status send one at
   * a time.
   */
  send(dst: string, body: Uint8Array): void {
    const { clock, mac, channel } = this.#opts;
    this.#opts.output(buildEspNowAction({ dst, src: mac, channel, body }));
    this.#status = "ack";
    if (dst === BROADCAST_MAC) {
      const cancel = clock.schedule(clock.now(), () => {
        this.#broadcastDone.delete(cancel);
        this.#opts.onTxDone("ack");
      });
      this.#broadcastDone.add(cancel);
      return;
    }
    this.#status = "nack";
    this.#arm(clock.now() + ESPNOW_ACK_TIMEOUT_MS);
  }

  /** A frame arrived from the netdev. Anything that is not ESP-NOW is not this model's. */
  receive(frame: Uint8Array): boolean {
    const espnow = parseEspNow(frame);
    if (!espnow) return false;
    const { mac, channel } = this.#opts;
    if (espnow.channel !== channel || espnow.src === mac) return true;
    if (espnow.type === "action") {
      if (espnow.dst !== BROADCAST_MAC && espnow.dst !== mac) return true;
      this.#opts.onReceive(espnow.src, espnow.dst, espnow.body);
      if (espnow.dst !== BROADCAST_MAC) {
        this.#opts.output(buildEspNowAck({ dst: espnow.src, src: mac, channel }));
      }
      return true;
    }
    if (espnow.dst !== mac) return true;
    // timer_mod_anticipate(now): pulls a pending timer in, and arms one that
    // already fired. The fork does not check which frame the ACK answers.
    this.#status = "ack";
    this.#arm(this.#opts.clock.now());
    return true;
  }

  stop(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    for (const cancel of this.#broadcastDone) cancel();
    this.#broadcastDone.clear();
  }

  #arm(atMs: number): void {
    this.#cancelTimer?.();
    this.#cancelTimer = this.#opts.clock.schedule(atMs, () => {
      this.#cancelTimer = null;
      this.#opts.onTxDone(this.#status);
    });
  }
}
