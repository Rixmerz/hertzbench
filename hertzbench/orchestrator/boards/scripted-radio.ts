// A scripted board for chip-level radios: NOT firmware and NOT an emulator.
// It plays the MCU side of a sketch that uses arduino-LoRa or RF24, through
// the TypeScript replays of those libraries, over the same spi-link socket the
// patched Velxio worker uses. So the adapter, the chip model, the air, the
// metrics and the assertions run end to end on a host without libqemu.
//
// Serial lines it prints, for `serial:` assertions:
//   radio ready <radio>        setup finished
//   tx <text>                  LoRa: a packet went out (TxDone seen)
//   tx <text> ok|failed        nRF24: write() returned
//   rx "<text>" rssi=<dBm> snr=<dB>   LoRa reception, as packetRssi()/packetSnr() read it
//   rx "<text>" pipe=<n>       nRF24 reception

import type { Level } from "../../adapters/spi-link/device.ts";
import { SpiLinkClient } from "../../adapters/spi-link/client.ts";
import { type LoraRadio, nrf24AddressFor, type Nrf24Radio } from "../radios.ts";
import type { ScriptedSend } from "../scenario.ts";
import type { BoardContext, RunningBoard } from "./board.ts";
import { ArduinoLora } from "./drivers/arduino-lora.ts";
import type { DriverBus } from "./drivers/bus.ts";
import { type PaLevel, Rf24 } from "./drivers/rf24.ts";

/** How often a listening nRF24 script calls available(), as a sketch's loop() would. */
const NRF24_POLL_MS = 5;

function decodeText(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

export class ScriptedRadioBoard implements RunningBoard {
  readonly clockDescription = "wall clock (scripted board, no guest time)";
  readonly #ctx: BoardContext;
  readonly #client: SpiLinkClient;
  readonly #bus: DriverBus;
  readonly #cancels = new Set<() => void>();
  /** Driver calls run one at a time, as on a single-core MCU. */
  #queue: Promise<void> = Promise.resolve();
  #stopped = false;

  constructor(ctx: BoardContext, client: SpiLinkClient) {
    this.#ctx = ctx;
    this.#client = client;
    this.#bus = {
      digitalWrite: (gpio, level) => this.#guard(() => client.digitalWrite(gpio, level)),
      transfer: (mosi) => this.#guard(() => client.transfer(mosi)),
      delay: (ms) =>
        new Promise<void>((resolve) => {
          this.#schedule(ctx.clock.now() + ms, resolve, true);
        }),
    };
    const radio = ctx.node.radio;
    if (radio.phy === "lora") this.#run(() => this.#startLora(radio));
    else if (radio.phy === "nrf24") this.#run(() => this.#startNrf24(radio));
    else ctx.onProblem(`${ctx.node.id}: a scripted radio board needs a LoRa or nRF24 radio`);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const cancel of this.#cancels) cancel();
    this.#cancels.clear();
    await this.#client.close();
    await this.#queue;
  }

  /** After stop, bus calls fail fast instead of waiting on a closed socket. */
  async #guard<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#stopped) throw new StoppedError();
    return await fn();
  }

  #run(job: () => Promise<void>): void {
    this.#queue = this.#queue.then(async () => {
      if (this.#stopped) return;
      try {
        await job();
      } catch (error) {
        if (!(error instanceof StoppedError) && !this.#stopped) {
          this.#ctx.onProblem(`${this.#ctx.node.id}: scripted driver failed: ${error}`);
        }
      }
    });
  }

  /** `resolveAnyway`: a pending delay still resolves at stop, so the queue drains. */
  #schedule(atMs: number, fn: () => void, resolveAnyway = false): void {
    const cancel = this.#ctx.clock.schedule(atMs, () => {
      this.#cancels.delete(wrapped);
      if (!this.#stopped || resolveAnyway) fn();
    });
    const wrapped = () => {
      cancel();
      if (resolveAnyway) fn();
    };
    this.#cancels.add(wrapped);
  }

  #sends(): ScriptedSend[] {
    const firmware = this.#ctx.node.firmware;
    return firmware.kind === "script" ? firmware.send : [];
  }

  #listens(): boolean {
    const firmware = this.#ctx.node.firmware;
    return firmware.kind === "script" && firmware.listen;
  }

  /** Schedules every send of the script relative to the end of setup. */
  #scheduleSends(sendOne: (send: ScriptedSend, text: string) => Promise<void>): void {
    const ready = this.#ctx.clock.now();
    for (const send of this.#sends()) {
      for (let seq = 0; seq < send.count; seq++) {
        const text = `${send.payload}:${seq} from ${this.#ctx.node.id}`;
        this.#schedule(ready + send.startMs + seq * send.everyMs, () => {
          this.#run(() => sendOne(send, text));
        });
      }
    }
  }

  // ── LoRa (arduino-LoRa) ────────────────────────────────────────────────────

  async #startLora(radio: LoraRadio): Promise<void> {
    const ctx = this.#ctx;
    const lora = new ArduinoLora(this.#bus, {
      ss: radio.pins.cs,
      reset: radio.pins.reset,
      dio0: radio.pins.dio0,
    });
    if (!(await lora.begin(radio.frequencyHz))) {
      ctx.onProblem(`${ctx.node.id}: LoRa.begin() failed: the chip did not answer 0x12`);
      return;
    }
    await lora.setSpreadingFactor(radio.sf);
    await lora.setSignalBandwidth(radio.bandwidthHz);
    await lora.setCodingRate4(radio.codingRate);
    await lora.setSyncWord(radio.syncWord);
    await lora.setPreambleLength(radio.preambleLength);
    if (radio.crc) await lora.enableCrc();
    else await lora.disableCrc();
    await lora.setTxPower(radio.txPowerDbm);
    const listen = this.#listens();
    if (listen) {
      this.#client.onDrive((gpio: number, level: Level) => {
        if (gpio === radio.pins.dio0 && level === 1) this.#run(() => this.#onLoraPacket(lora));
      });
      await lora.receive();
    }
    ctx.onSerial(`radio ready lora ${radio.frequencyHz / 1e6} MHz SF${radio.sf}`);
    this.#scheduleSends(async (_send, text) => {
      if (!(await lora.beginPacket())) return;
      await lora.write(new TextEncoder().encode(text));
      await lora.endPacket();
      ctx.onSerial(`tx ${text}`);
      if (listen) await lora.receive();
    });
  }

  async #onLoraPacket(lora: ArduinoLora): Promise<void> {
    const length = await lora.handleDio0Rise();
    if (length === 0) return;
    const text = decodeText(await lora.readAll());
    const rssi = await lora.packetRssi();
    const snr = await lora.packetSnr();
    this.#ctx.onSerial(`rx "${text}" rssi=${rssi} snr=${snr}`);
  }

  // ── nRF24 (RF24) ───────────────────────────────────────────────────────────

  async #startNrf24(radio: Nrf24Radio): Promise<void> {
    const { node, peers } = this.#ctx;
    const ctx = this.#ctx;
    const rf = new Rf24(this.#bus, { ce: radio.pins.ce, csn: radio.pins.csn });
    if (!(await rf.begin())) {
      ctx.onProblem(`${node.id}: RF24 begin() failed: CONFIG did not read back`);
      return;
    }
    await rf.setChannel(radio.channel);
    await rf.setDataRate(
      radio.dataRate === 250_000 ? 250 : radio.dataRate === 2_000_000 ? 2000 : 1000,
    );
    await rf.setPALevel(((radio.txPowerDbm + 18) / 6) as PaLevel);
    await rf.setRetries(radio.retryDelayUs / 250 - 1, radio.retries);
    await rf.setAutoAck(radio.autoAck);
    await rf.openReadingPipe(1, nrf24AddressFor(ctx.nodeIndex));
    const listen = this.#listens();
    if (listen) await rf.startListening();
    ctx.onSerial(`radio ready nrf24 ch ${radio.channel}`);

    if (listen) {
      const poll = () => {
        this.#run(async () => {
          while (await rf.available()) {
            const pipe = await rf.pipeAvailable();
            const text = decodeText(await rf.read());
            ctx.onSerial(`rx "${text}" pipe=${pipe}`);
          }
        });
        this.#schedule(ctx.clock.now() + NRF24_POLL_MS, poll);
      };
      poll();
    }
    this.#scheduleSends(async (send, text) => {
      const peer = peers.find((p) => p.id === send.to);
      if (!peer) return;
      if (listen) await rf.stopListening();
      await rf.openWritingPipe(nrf24AddressFor(peer.index));
      const ok = await rf.write(new TextEncoder().encode(text));
      ctx.onSerial(`tx ${text} ${ok ? "ok" : "failed"}`);
      if (listen) await rf.startListening();
    });
  }
}

class StoppedError extends Error {
  override name = "StoppedError";
}

export async function startScriptedRadioBoard(
  ctx: BoardContext,
  port: number,
): Promise<RunningBoard> {
  const client = await SpiLinkClient.connect(port);
  return new ScriptedRadioBoard(ctx, client);
}
