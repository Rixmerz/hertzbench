// The network of a LoRa or nRF24 scenario: one radio chip model per node on
// the chip-level air, each reachable by its board over spi-link. The Wi-Fi
// network (Phase 1) is built in runner.ts; both hand the runner the same shape.

import {
  type AirFrame,
  AirMedium,
  type Clock,
  type EngineEvent,
  type EventLog,
  LINKTYPE_LORATAP,
  LINKTYPE_USER0,
  type MediumControl,
  PcapWriter,
  substream,
} from "../engine/mod.ts";
import { isLoraFrame, Sx127x } from "../adapters/lora-sx127x/mod.ts";
import { isNrf24Frame, Nrf24l01 } from "../adapters/nrf24/mod.ts";
import { SpiLinkAdapter } from "../adapters/spi-link/mod.ts";
import type { Scenario } from "./scenario.ts";

export interface NetworkSetup {
  medium: MediumControl;
  /** Each node's port on its adapter. */
  ports: Map<string, number>;
  waitConnected(nodeId: string, timeoutMs: number): Promise<void>;
  close(): Promise<void>;
  pcap: PcapWriter;
  /** Wi-Fi only: the ESP-NOW frames again, as 802.11 behind radiotap; written when not empty. */
  dot11Pcap?: PcapWriter;
  /** Features the firmware used that the chip model does not model, once each. */
  warnings: string[];
}

export interface AirNetworkContext {
  clock: Clock;
  log: EventLog;
  epochMs: number;
  onProblem(nodeId: string, message: string): void;
}

/**
 * LoRaTap v0 (github.com/eriknl/LoRaTap): 15 big-endian bytes, then the
 * payload. The capture is taken at the transmitter, so the RSSI fields hold
 * 0 (-139 dBm); the received levels are in events.jsonl and metrics.json.
 */
export function loraTapRecord(frame: AirFrame): Uint8Array {
  const out = new Uint8Array(15 + frame.payload.length);
  const view = new DataView(out.buffer);
  view.setUint8(0, 0); // version
  view.setUint16(2, 15);
  view.setUint32(4, Math.round(frame.frequencyHz));
  // Bandwidth in 125 kHz steps; narrower settings do not fit and are written as 0.
  view.setUint8(8, Math.floor(frame.bandwidthHz / 125e3));
  if (isLoraFrame(frame)) {
    view.setUint8(9, frame.header.modulation.sf);
    view.setUint8(14, frame.header.modulation.syncWord);
  }
  out.set(frame.payload, 15);
  return out;
}

/** hertzbench's nRF24 record under LINKTYPE_USER0: RF channel, address width, address (on-air order), payload. */
export function nrf24Record(frame: AirFrame): Uint8Array {
  if (!isNrf24Frame(frame)) return frame.payload.slice();
  const address = frame.header.address;
  const out = new Uint8Array(2 + address.length + frame.payload.length);
  out[0] = frame.header.channel;
  out[1] = address.length;
  out.set(address, 2);
  out.set(frame.payload, 2 + address.length);
  return out;
}

export function createAirNetwork(scenario: Scenario, ctx: AirNetworkContext): NetworkSetup {
  const { clock, log } = ctx;
  const lora = scenario.phy === "lora";
  const pcap = new PcapWriter(ctx.epochMs, lora ? LINKTYPE_LORATAP : LINKTYPE_USER0);
  const warnings: string[] = [];
  const air = new AirMedium({
    seed: scenario.seed,
    environment: scenario.environment,
    clock,
    log,
    tap: (tMs, _node, frame) =>
      pcap.addFrame(tMs, lora ? loraTapRecord(frame) : nrf24Record(frame)),
  });
  const adapter = new SpiLinkAdapter(ctx.onProblem);
  const ports = new Map<string, number>();
  scenario.nodes.forEach((node) => {
    const radio = node.radio;
    const warn = (message: string) => warnings.push(`${node.id}: ${message}`);
    const transmit = (frame: AirFrame) => air.transmit(node.id, frame);
    let attachment;
    if (radio.phy === "lora") {
      attachment = adapter.listen(node.id, (drivePin) =>
        new Sx127x({
          pins: radio.pins,
          clock,
          transmit,
          drivePin,
          rng: substream(scenario.seed, `sx127x:${node.id}`),
          warn,
        }));
    } else if (radio.phy === "nrf24") {
      attachment = adapter.listen(
        node.id,
        (drivePin) => new Nrf24l01({ pins: radio.pins, clock, transmit, drivePin, warn }),
      );
    } else {
      throw new Error(`${node.id}: a ${radio.phy} radio has no chip model`);
    }
    ports.set(node.id, attachment.port);
    air.addNode(
      { id: node.id, position: node.position, antennaGainDbi: radio.antennaGainDbi },
      attachment.device,
    );
  });
  return {
    medium: air,
    ports,
    waitConnected: (id, timeoutMs) => adapter.waitConnected(id, timeoutMs),
    close: () => adapter.close(),
    pcap,
    warnings,
  };
}

/**
 * Where firmware programmed its chip differently from what the scenario
 * declares. Firmware is the truth; this is a warning, never an override.
 */
export function declaredMismatches(scenario: Scenario, events: readonly EngineEvent[]): string[] {
  const out: string[] = [];
  for (const node of scenario.nodes) {
    const radio = node.radio;
    if (radio.phy === "wifi") continue;
    const declared: Record<string, string | number> = radio.phy === "lora"
      ? {
        frequency_mhz: Number((radio.frequencyHz / 1e6).toFixed(4)),
        sf: radio.sf,
        bw_khz: radio.bandwidthHz / 1000,
        cr: `4/${radio.codingRate}`,
        sync_word: radio.syncWord,
      }
      : { channel: radio.channel, data_rate_kbps: radio.dataRate / 1000 };
    const seen = new Set<string>();
    for (const event of events) {
      if (event.type !== "tx" || event.node !== node.id || !event.radio) continue;
      if (event.kind === "nrf24-ack") continue;
      for (const [field, want] of Object.entries(declared)) {
        const got = event.radio[field];
        if (got === undefined || got === want || seen.has(field)) continue;
        seen.add(field);
        out.push(
          `${node.id}: the firmware transmitted with ${field} ${got}, the scenario declares ${want}`,
        );
      }
    }
  }
  return out;
}
