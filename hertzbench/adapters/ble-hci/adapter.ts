// ble-hci adapter: one loopback TCP port per node carrying HCI over H4, the
// byte stream a host stack writes to an HCI UART. On the other end is either
// the ESP32 board's UART relay (orchestrator/boards/qemu-esp32.ts, which turns
// the Velxio worker's `uart_tx` events and `uart_send` commands into this
// stream) or a scripted host. The node's virtual controller answers it.
//
// Fidelity F3 (ADR 0002): the firmware's host stack runs unchanged, but over
// an external HCI UART in a simulation-only build, against a controller the
// engine plays.

import { LoopbackPorts } from "../loopback-ports.ts";
import { BtsnoopWriter } from "./btsnoop.ts";
import { type BleController } from "./controller.ts";
import { encodeHci, H4Decoder } from "./hci.ts";

export interface HciAttachment {
  nodeId: string;
  /** Port the board connects to. */
  port: number;
  controller: BleController;
  /** Every HCI packet of this node, both directions. */
  snoop: BtsnoopWriter;
}

export class BleHciAdapter {
  readonly #ports: LoopbackPorts;
  readonly #now: () => number;
  readonly #epochMs: number;

  /** `now` stamps the btsnoop records in engine time; `epochMs` is the Unix time of engine time 0. */
  constructor(
    now: () => number,
    epochMs: number,
    onProblem: (nodeId: string, message: string) => void = () => {},
  ) {
    this.#now = now;
    this.#epochMs = epochMs;
    this.#ports = new LoopbackPorts(onProblem);
  }

  /** Listen for a node's host. `makeController` builds the controller with the function it answers through. */
  listen(
    nodeId: string,
    makeController: (toHost: (bytes: Uint8Array) => void) => BleController,
  ): HciAttachment {
    const snoop = new BtsnoopWriter(this.#epochMs);
    const controller = makeController((bytes) => {
      // The controller hands over one whole packet per call.
      snoop.add(this.#now(), "controller-to-host", bytes);
      this.#ports.send(nodeId, bytes);
    });
    const port = this.#ports.listen(nodeId, () => {
      const inbound = new H4Decoder();
      return (chunk) => {
        // Decoded twice, here for the capture and in the controller, so a
        // stream that is not H4 is reported by the controller's own decoder.
        try {
          for (const packet of inbound.push(chunk)) {
            snoop.add(this.#now(), "host-to-controller", encodeHci(packet));
          }
        } catch {
          // The controller below throws the same error with its message.
        }
        controller.fromHost(chunk);
      };
    });
    return { nodeId, port, controller, snoop };
  }

  isConnected(nodeId: string): boolean {
    return this.#ports.isConnected(nodeId);
  }

  waitConnected(nodeId: string, timeoutMs: number): Promise<void> {
    return this.#ports.waitConnected(nodeId, timeoutMs);
  }

  close(): Promise<void> {
    return this.#ports.close();
  }
}
