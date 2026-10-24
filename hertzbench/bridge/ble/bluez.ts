// The BLE bridge's real host side: BlueZ, through bluez_gatt.py. The helper
// owns the D-Bus objects BlueZ reads and does what this side tells it over
// stdio (the protocol is at the top of bluez_gatt.py); this side answers each
// phone operation through the bridge's handlers. Linux only, and only when a
// scenario has a BLE bridge: nothing here runs otherwise.

import { fileURLToPath } from "node:url";
import type { DiscoveredService } from "../../orchestrator/boards/drivers/att.ts";
import { propertyNames } from "../../orchestrator/boards/drivers/att.ts";
import { GattOperationError, type GattPeripheral, type PeripheralHandlers } from "./peripheral.ts";

export const BLUEZ_HELPER = fileURLToPath(new URL("./bluez_gatt.py", import.meta.url));
/** How long BlueZ gets to accept the application and the advertisement. */
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 3_000;

export interface BluezPeripheralOptions {
  adapter: string;
  /** The helper's command line; default python3 on bluez_gatt.py on the system bus. Tests run it on a private bus. */
  command?: string[];
}

type HelperEvent =
  | { event: "ready" }
  | { event: "error"; message: string }
  | { event: "read"; id: number; char: number }
  | { event: "write"; id: number | null; char: number; value: string }
  | { event: "subscribe"; char: number; enabled: boolean };

// ATT values fit in 20 bytes here, so the one-line forms qemu-esp32.ts also uses are enough.
const encodeBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decodeBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export class BluezStartError extends Error {
  override name = "BluezStartError";
}

/** Why the BlueZ bridge cannot run on this OS, or null on Linux. Windows and macOS have no BlueZ. */
export function bluezUnsupportedReason(os: string = Deno.build.os): string | null {
  if (os === "linux") return null;
  const alternatives = os === "windows"
    ? "run the BLE bridge from WSL2 with a USB Bluetooth adapter attached through usbipd-win, " +
      "or on a Linux host (or a Raspberry Pi) and reach the simulator from there"
    : "run the BLE bridge on a Linux host (or a Raspberry Pi) instead; the IP bridge works here";
  return `the BLE bridge needs BlueZ, which only exists on Linux (this host is ${os}); ` +
    `${alternatives}. See docs/mobile-bridge.md`;
}

export class BluezPeripheral implements GattPeripheral {
  readonly description: string;
  readonly #command: string[];
  #child: Deno.ChildProcess | null = null;
  #stdin: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #writes: Promise<void> = Promise.resolve();
  #stderr = "";
  #reading: Promise<void> = Promise.resolve();
  #unsupported: string | null = null;

  constructor(opts: BluezPeripheralOptions) {
    // A custom command is how tests (and anyone with their own helper) bring their own host side.
    const unsupported = opts.command ? null : bluezUnsupportedReason();
    if (unsupported) this.#unsupported = unsupported;
    this.description = `BlueZ on ${opts.adapter}`;
    this.#command = opts.command ?? ["python3", "-I", BLUEZ_HELPER, "--adapter", opts.adapter];
  }

  async start(
    services: DiscoveredService[],
    name: string,
    handlers: PeripheralHandlers,
  ): Promise<void> {
    if (this.#unsupported) throw new BluezStartError(this.#unsupported);
    const [program, ...args] = this.#command as [string, ...string[]];
    try {
      this.#child = new Deno.Command(program, {
        args,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new BluezStartError(`${program} is not installed; the BLE bridge needs it for BlueZ`);
      }
      throw error;
    }
    const child = this.#child;
    this.#stdin = child.stdin.getWriter();
    void this.#collectStderr(child.stderr);
    let ready: (error: Error | null) => void = () => {};
    const started = new Promise<Error | null>((resolve) => (ready = resolve));
    this.#reading = this.#readEvents(child.stdout, handlers, (error) => ready(error));
    void child.status.then((status) =>
      ready(
        new BluezStartError(
          `the BlueZ helper exited with code ${status.code} before BlueZ accepted the GATT application` +
            (this.#stderr.trim()
              ? `: ${this.#stderr.trim().split(/\r?\n/).slice(-3).join(" | ")}`
              : ""),
        ),
      )
    );
    this.#send({
      op: "start",
      name,
      services: services.map((s) => ({
        uuid: s.uuid,
        characteristics: s.characteristics.map((c) => ({
          id: c.valueHandle,
          uuid: c.uuid,
          flags: propertyNames(c.properties),
        })),
      })),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Error>((resolve) => {
      timer = setTimeout(
        () =>
          resolve(new BluezStartError(`BlueZ did not answer within ${START_TIMEOUT_MS / 1000} s`)),
        START_TIMEOUT_MS,
      );
    });
    const outcome = await Promise.race([started, timeout]);
    clearTimeout(timer);
    if (outcome) {
      await this.close();
      throw outcome;
    }
  }

  notify(handle: number, value: Uint8Array): void {
    this.#send({ op: "notify", char: handle, value: encodeBase64(value) });
  }

  async close(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    this.#child = null;
    this.#send({ op: "stop" });
    await this.#writes;
    try {
      await this.#stdin?.close();
    } catch {
      // The helper already exited and closed its end.
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const exited = await Promise.race([
      child.status.then(() => true),
      new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), STOP_TIMEOUT_MS))),
    ]);
    clearTimeout(timer);
    if (!exited) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Gone between the check and the kill.
      }
      await child.status;
    }
    await this.#reading;
  }

  #send(message: Record<string, unknown>): void {
    const writer = this.#stdin;
    if (!writer) return;
    const bytes = new TextEncoder().encode(JSON.stringify(message) + "\n");
    this.#writes = this.#writes.then(() => writer.write(bytes)).catch(() => {});
  }

  async #collectStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
      // Keep the tail only: it is for the error message.
      this.#stderr = (this.#stderr + chunk).slice(-4096);
    }
  }

  async #readEvents(
    stream: ReadableStream<Uint8Array>,
    handlers: PeripheralHandlers,
    ready: (error: Error | null) => void,
  ): Promise<void> {
    let pending = "";
    for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        let event: HelperEvent;
        try {
          event = JSON.parse(line) as HelperEvent;
        } catch {
          continue; // not ours: a stray print from a library
        }
        this.#dispatch(event, handlers, ready);
      }
    }
  }

  #dispatch(
    event: HelperEvent,
    handlers: PeripheralHandlers,
    ready: (error: Error | null) => void,
  ): void {
    switch (event.event) {
      case "ready":
        return ready(null);
      case "error":
        return ready(new BluezStartError(event.message));
      case "read":
        return void this.#answer(event.id, () => handlers.read(event.char));
      case "write": {
        const value = decodeBase64(event.value);
        if (event.id === null) {
          // A write command: BlueZ already answered the phone; a failure is in the bridge's log.
          handlers.write(event.char, value, false).catch(() => {});
          return;
        }
        return void this.#answer(event.id, async () => {
          await handlers.write(event.char, value, true);
          return new Uint8Array(0);
        });
      }
      case "subscribe":
        handlers.subscribe(event.char, event.enabled).catch(() => {});
        return;
    }
  }

  async #answer(id: number, fn: () => Promise<Uint8Array>): Promise<void> {
    try {
      this.#send({ op: "reply", id, value: encodeBase64(await fn()) });
    } catch (error) {
      this.#send({
        op: "reply",
        id,
        error: error instanceof GattOperationError ? error.kind : "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
