// qemu-wifi-l2: connects each board's QEMU `stream` netdev to the engine.
//
// One loopback TCP listener per node (adapters/loopback-ports.ts). QEMU
// connects to its node's port as the client (`server=off`). Frames QEMU sends
// are handed to `onFrame`; frames the engine delivers are written back with
// the same length-prefix framing.
//
// Fidelity F2: frames are captured at the netdev, after the guest's embedded
// access point has turned 802.11 into Ethernet, so the adapter sees what the
// guest's IP stack sent, not the 802.11 exchange behind it.

import type { FrameSink } from "../../engine/mod.ts";
import { LoopbackPorts } from "../loopback-ports.ts";
import { encodeFrame, FrameDecoder } from "./framing.ts";

export { LOOPBACK } from "../loopback-ports.ts";

export type FrameHandler = (nodeId: string, frame: Uint8Array) => void;

export interface NodeAttachment {
  nodeId: string;
  /** Port the board's QEMU netdev connects to. */
  port: number;
  /** Hand this to `Medium.addNode`. */
  sink: FrameSink;
}

export class QemuWifiL2Adapter {
  readonly #onFrame: FrameHandler;
  readonly #ports: LoopbackPorts;

  constructor(
    onFrame: FrameHandler,
    onProblem: (nodeId: string, message: string) => void = () => {},
  ) {
    this.#onFrame = onFrame;
    this.#ports = new LoopbackPorts(onProblem);
  }

  /** Start listening for a node's board. Port 0 lets the OS pick; the chosen port is returned. */
  listen(nodeId: string): NodeAttachment {
    const port = this.#ports.listen(nodeId, () => {
      // A FramingError thrown here is reported and cuts the board off.
      const decoder = new FrameDecoder();
      return (chunk) => {
        for (const frame of decoder.push(chunk)) this.#onFrame(nodeId, frame);
      };
    });
    const sink: FrameSink = {
      ready: () => this.#ports.isConnected(nodeId),
      deliver: (frame) => this.#ports.send(nodeId, encodeFrame(frame)),
    };
    return { nodeId, port, sink };
  }

  isConnected(nodeId: string): boolean {
    return this.#ports.isConnected(nodeId);
  }

  /** Resolve when the board's QEMU has connected; reject after `timeoutMs` or when the adapter closes. */
  waitConnected(nodeId: string, timeoutMs: number): Promise<void> {
    return this.#ports.waitConnected(nodeId, timeoutMs);
  }

  close(): Promise<void> {
    return this.#ports.close();
  }
}
