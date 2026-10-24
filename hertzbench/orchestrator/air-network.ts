// The network of a LoRa, nRF24 or BLE scenario: one radio model per node on the
// chip-level air. A LoRa or nRF24 chip is reached by its board over spi-link;
// a BLE virtual controller over HCI on ble-hci. The Wi-Fi network (Phase 1) is
// built in runner.ts; all hand the runner the same shape.

import {
  type AirFrame,
  AirMedium,
  BLE_BANDWIDTH_HZ,
  BLE_NOISE_FIGURE_DB,
  BLE_RATE_BPS,
  BLE_REFERENCE_BYTES,
  bleChannelFrequencyHz,
  bleLlRecord,
  bleRequiredSnrDb,
  type ChipSignal,
  type Clock,
  type EngineEvent,
  type EventLog,
  LINKTYPE_BLUETOOTH_LE_LL_WITH_PHDR,
  LINKTYPE_LORATAP,
  LINKTYPE_USER0,
  LORA_NOISE_FIGURE_DB,
  LORA_REFERENCE_BYTES,
  loraBitRate,
  loraRequiredSnrDb,
  type MediumControl,
  NRF24_NOISE_FIGURE_DB,
  NRF24_REFERENCE_BYTES,
  nrf24BandwidthHz,
  nrf24ChannelFrequencyHz,
  nrf24RequiredSnrDb,
  PcapWriter,
  substream,
} from "../engine/mod.ts";
import { isLoraFrame, Sx127x } from "../adapters/lora-sx127x/mod.ts";
import { isNrf24Frame, Nrf24l01 } from "../adapters/nrf24/mod.ts";
import { SpiLinkAdapter } from "../adapters/spi-link/mod.ts";
import {
  BleController,
  BleHciAdapter,
  type BtsnoopWriter,
  isBleFrame,
} from "../adapters/ble-hci/mod.ts";
import {
  BleBridge,
  BluezPeripheral,
  bluezUnsupportedReason,
  type BridgeHooks,
  type RunningBridge,
} from "../bridge/mod.ts";
import { BoardError } from "./boards/board.ts";
import type { NodeRadio } from "./radios.ts";
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
  /** BLE only: each node's HCI traffic, written as hci-<node>.btsnoop. */
  hciCaptures?: Map<string, BtsnoopWriter>;
  /** The mobile bridge's station on this medium, when the scenario has one. */
  bridge?: RunningBridge;
}

export interface AirNetworkContext {
  clock: Clock;
  log: EventLog;
  epochMs: number;
  onProblem(nodeId: string, message: string): void;
  hooks?: BridgeHooks;
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

/** The LE link-layer record of a BLE frame, as the transmitter put it on the air. */
export function bleRecord(frame: AirFrame): Uint8Array {
  if (!isBleFrame(frame)) return frame.payload.slice();
  const h = frame.header;
  return bleLlRecord(h.channel, h.accessAddress, frame.payload, h.crcInit, frame.txPowerDbm);
}

/**
 * The signal a chip radio is declared with, for link budgets read before it
 * has transmitted. A BLE radio is read on advertising channel 37 until its
 * first frame; after that, on the channel of its last frame.
 */
export function declaredSignal(radio: NodeRadio): ChipSignal {
  switch (radio.phy) {
    case "lora":
      return {
        frequencyHz: radio.frequencyHz,
        bandwidthHz: radio.bandwidthHz,
        noiseFigureDb: LORA_NOISE_FIGURE_DB,
        txPowerDbm: radio.txPowerDbm,
        requiredSnrDb: loraRequiredSnrDb(radio.sf),
        referenceBytes: LORA_REFERENCE_BYTES,
        // The scenario writes the coding rate as its denominator, the modem as 1-4.
        rateBps: loraBitRate({ ...radio, codingRate: radio.codingRate - 4 }),
      };
    case "nrf24":
      return {
        frequencyHz: nrf24ChannelFrequencyHz(radio.channel),
        bandwidthHz: nrf24BandwidthHz(radio.dataRate),
        noiseFigureDb: NRF24_NOISE_FIGURE_DB,
        txPowerDbm: radio.txPowerDbm,
        requiredSnrDb: nrf24RequiredSnrDb(radio.dataRate),
        referenceBytes: NRF24_REFERENCE_BYTES,
        rateBps: radio.dataRate,
      };
    case "ble":
      return {
        frequencyHz: bleChannelFrequencyHz(37),
        bandwidthHz: BLE_BANDWIDTH_HZ,
        noiseFigureDb: BLE_NOISE_FIGURE_DB,
        txPowerDbm: radio.txPowerDbm,
        requiredSnrDb: bleRequiredSnrDb(),
        referenceBytes: BLE_REFERENCE_BYTES,
        rateBps: BLE_RATE_BPS,
      };
    case "wifi":
      throw new Error("a Wi-Fi radio is not on the chip-level air");
  }
}

function createBleNetwork(scenario: Scenario, ctx: AirNetworkContext): NetworkSetup {
  const { clock, log } = ctx;
  const pcap = new PcapWriter(ctx.epochMs, LINKTYPE_BLUETOOTH_LE_LL_WITH_PHDR);
  const warnings: string[] = [];
  const air = new AirMedium({
    seed: scenario.seed,
    environment: scenario.environment,
    clock,
    log,
    tap: (tMs, _node, frame) => pcap.addFrame(tMs, bleRecord(frame)),
  });
  const adapter = new BleHciAdapter(() => clock.now(), ctx.epochMs, ctx.onProblem);
  const ports = new Map<string, number>();
  const hciCaptures = new Map<string, BtsnoopWriter>();
  const controllers: BleController[] = [];
  for (const node of scenario.nodes) {
    const radio = node.radio;
    if (radio.phy !== "ble") throw new Error(`${node.id}: not a BLE node`);
    const attachment = adapter.listen(node.id, (toHost) =>
      new BleController({
        nodeId: node.id,
        address: node.mac,
        txPowerDbm: radio.txPowerDbm,
        clock,
        log,
        rng: substream(scenario.seed, `ble:${node.id}`),
        transmit: (frame) => air.transmit(node.id, frame),
        toHost,
        warn: (message) => warnings.push(`${node.id}: ${message}`),
      }));
    controllers.push(attachment.controller);
    ports.set(node.id, attachment.port);
    hciCaptures.set(node.id, attachment.snoop);
    air.addNode(
      {
        id: node.id,
        position: node.position,
        antennaGainDbi: radio.antennaGainDbi,
        signal: declaredSignal(radio),
      },
      attachment.controller,
    );
  }
  const spec = scenario.bridge;
  let bridge: BleBridge | undefined;
  if (spec?.kind === "ble") {
    const radio = spec.radio;
    const mirror = scenario.nodes.find((n) => n.id === spec.mirror);
    if (!mirror || radio.phy !== "ble") {
      throw new Error("the BLE bridge needs a mirrored node and a ble radio");
    }
    // Refuse before any board starts, not as a problem in the report of a run that cannot work.
    const unsupported = ctx.hooks?.peripheral ? null : bluezUnsupportedReason();
    if (unsupported) throw new BoardError(unsupported);
    bridge = new BleBridge({
      spec,
      mirrorAddress: mirror.mac,
      clock,
      peripheral: ctx.hooks?.peripheral?.(spec) ?? new BluezPeripheral({ adapter: spec.adapter }),
      makeController: (toHost) =>
        new BleController({
          nodeId: spec.id,
          address: spec.mac,
          txPowerDbm: radio.txPowerDbm,
          clock,
          log,
          rng: substream(scenario.seed, `ble:${spec.id}`),
          transmit: (frame) => air.transmit(spec.id, frame),
          toHost,
          warn: (message) => warnings.push(`${spec.id}: ${message}`),
        }),
      log: (text) => log.append({ type: "serial", t: clock.now(), node: spec.id, text }),
      onProblem: (message) => ctx.onProblem(spec.id, message),
    });
    controllers.push(bridge.controller);
    air.addNode(
      {
        id: spec.id,
        position: spec.position,
        antennaGainDbi: radio.antennaGainDbi,
        signal: declaredSignal(radio),
      },
      bridge.controller,
    );
  }
  return {
    medium: air,
    ports,
    ...(bridge ? { bridge } : {}),
    waitConnected: (id, timeoutMs) => adapter.waitConnected(id, timeoutMs),
    close: async () => {
      for (const controller of controllers) controller.close();
      await adapter.close();
    },
    pcap,
    warnings,
    hciCaptures,
  };
}

export function createAirNetwork(scenario: Scenario, ctx: AirNetworkContext): NetworkSetup {
  if (scenario.phy === "ble") return createBleNetwork(scenario, ctx);
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
      {
        id: node.id,
        position: node.position,
        antennaGainDbi: radio.antennaGainDbi,
        signal: declaredSignal(radio),
      },
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
    // Wi-Fi has no chip registers to read back, and a BLE controller is configured over HCI.
    if (radio.phy === "wifi" || radio.phy === "ble") continue;
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
