// qemu-wifi-l2: connects each board's QEMU `socket` netdev to the engine.
//
// One loopback TCP listener per node (adapters/loopback-ports.ts). QEMU
// connects to its node's port as the client (`server=off`). Frames QEMU sends
// are handed to `onFrame`; frames the engine delivers are written back with
// the same length-prefix framing.
//
// Fidelity F2: frames are captured at the netdev, after the guest's embedded
// access point has turned 802.11 into Ethernet, so the adapter sees what the
// guest's IP stack sent, not the 802.11 exchange behind it.

import { type FrameSink, macToString } from "../../engine/mod.ts";
import { LoopbackPorts } from "../loopback-ports.ts";
import { encodeFrame, FrameDecoder } from "./framing.ts";

export { LOOPBACK } from "../loopback-ports.ts";

export type FrameHandler = (nodeId: string, frame: Uint8Array) => void;

/** The source MAC (lower case) of the first frame a node's board sent. */
export type FirstFrameHandler = (nodeId: string, sourceMac: string) => void;

/** Bytes of an Ethernet frame up to and including the source MAC. */
const SOURCE_MAC_END = 12;

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
  readonly #onFirstFrame: FirstFrameHandler;
  readonly #heard = new Set<string>();

  /**
   * `onFirstFrame` fires once per node, with the source MAC of the first frame its board
   * sends. A board whose MAC is only set after the netdev connects (an Android guest) uses
   * it to check the MAC the engine routes by.
   */
  constructor(
    onFrame: FrameHandler,
    onProblem: (nodeId: string, message: string) => void = () => {},
    onFirstFrame: FirstFrameHandler = () => {},
  ) {
    this.#onFrame = onFrame;
    this.#onFirstFrame = onFirstFrame;
    this.#ports = new LoopbackPorts(onProblem);
  }

  /** Start listening for a node's board. Port 0 lets the OS pick; the chosen port is returned. */
  listen(nodeId: string): NodeAttachment {
    const port = this.#ports.listen(nodeId, () => {
      // A FramingError thrown here is reported and cuts the board off.
      const decoder = new FrameDecoder();
      return (chunk) => {
        for (const frame of decoder.push(chunk)) {
          this.#noteFirstFrame(nodeId, frame);
          this.#onFrame(nodeId, frame);
        }
      };
    });
    const sink: FrameSink = {
      ready: () => this.#ports.isConnected(nodeId),
      deliver: (frame) => this.#ports.send(nodeId, encodeFrame(frame)),
    };
    return { nodeId, port, sink };
  }

  #noteFirstFrame(nodeId: string, frame: Uint8Array): void {
    // A frame too short to carry a source MAC is not a frame to judge the board by.
    if (this.#heard.has(nodeId) || frame.length < SOURCE_MAC_END) return;
    this.#heard.add(nodeId);
    this.#onFirstFrame(nodeId, macToString(frame, 6));
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
