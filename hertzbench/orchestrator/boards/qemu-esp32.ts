// The real board: a Velxio ESP32 worker (backend/app/services/esp32_worker.py)
// started headless with one JSON config line on stdin, as
// test/backend/integration/test_esp32_examples_qemu.py does. Its Wi-Fi NIC is
// attached to this run's adapter instead of SLIRP through two config fields
// that the core patch in docs/upstream-sync.md adds.
//
// Not runnable on a host without libqemu-xtensa; docs/e2e-esp32.md says how.

import { fileURLToPath } from "node:url";
import { workerNetworkConfig } from "../../adapters/qemu-wifi-l2/mod.ts";
import { buildEfuseImage } from "../../adapters/qemu-wifi-l2/mod.ts";
import { type BoardContext, BoardError, type BoardLauncher, type RunningBoard } from "./board.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WORKER_SCRIPT = `${REPO_ROOT}backend/app/services/esp32_worker.py`;
const COMPILE_HELPER = fileURLToPath(new URL("../compile_sketch.py", import.meta.url));
const STOP_GRACE_MS = 5000;

function pythonCommand(): string {
  return Deno.env.get("HERTZBENCH_PYTHON") ?? (Deno.build.os === "windows" ? "python" : "python3");
}

/** The shared library Velxio's lib manager would load: QEMU_ESP32_LIB, else beside the worker. */
export function resolveQemuLibrary(): string {
  const extension = Deno.build.os === "windows"
    ? ".dll"
    : Deno.build.os === "darwin"
    ? ".dylib"
    : ".so";
  const path = Deno.env.get("QEMU_ESP32_LIB") ??
    `${REPO_ROOT}backend/app/services/libqemu-xtensa${extension}`;
  try {
    if (!Deno.statSync(path).isFile) throw new Error("not a file");
  } catch {
    throw new BoardError(
      `libqemu-xtensa not found at ${path}. Build or download it and set QEMU_ESP32_LIB ` +
        `(see hertzbench/docs/e2e-esp32.md). The scripted board runs without it.`,
    );
  }
  return path;
}

type FirmwareCache = Map<string, Promise<Uint8Array>>;

/** Compile a sketch once per run, however many nodes share it. */
function loadFirmware(
  cache: FirmwareCache,
  spec: { kind: "sketch" | "binary"; path: string },
): Promise<Uint8Array> {
  let pending = cache.get(spec.path);
  if (!pending) {
    pending = spec.kind === "binary" ? Deno.readFile(spec.path) : compileSketch(spec.path);
    cache.set(spec.path, pending);
  }
  return pending;
}

async function compileSketch(sketchDir: string): Promise<Uint8Array> {
  const output = await new Deno.Command(pythonCommand(), {
    args: [COMPILE_HELPER, sketchDir],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new BoardError(
      `compiling ${sketchDir} failed:\n${new TextDecoder().decode(output.stderr).trim()}`,
    );
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(output.stdout));
  const b64 = typeof parsed === "object" && parsed !== null && "firmware_b64" in parsed
    ? (parsed as { firmware_b64: unknown }).firmware_b64
    : undefined;
  if (typeof b64 !== "string") {
    throw new BoardError(`compile helper returned no firmware for ${sketchDir}`);
  }
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Assembles UART bytes into lines, since the worker reports them one byte at a time. */
class LineAssembler {
  #pending = "";
  readonly #emit: (line: string) => void;
  readonly #decoder = new TextDecoder();

  constructor(emit: (line: string) => void) {
    this.#emit = emit;
  }

  push(chunk: Uint8Array | string): void {
    this.#pending += typeof chunk === "string"
      ? chunk
      : this.#decoder.decode(chunk, { stream: true });
    let newline = this.#pending.indexOf("\n");
    while (newline >= 0) {
      const line = this.#pending.slice(0, newline).replace(/\r$/, "");
      this.#pending = this.#pending.slice(newline + 1);
      if (line !== "") this.#emit(line);
      newline = this.#pending.indexOf("\n");
    }
  }

  flush(): void {
    if (this.#pending.trim() !== "") this.#emit(this.#pending.trim());
    this.#pending = "";
  }
}

class Esp32Board implements RunningBoard {
  readonly clockDescription = "wall clock (QEMU Xtensa runs without -icount when Wi-Fi is on)";
  readonly #child: Deno.ChildProcess;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #pumps: Promise<void>[];
  #stopping = false;

  constructor(
    ctx: BoardContext,
    child: Deno.ChildProcess,
    stderrLog: Deno.FsFile,
    stderrLogPath: string,
  ) {
    this.#child = child;
    this.#writer = child.stdin.getWriter();
    const lines = new LineAssembler(ctx.onSerial);
    this.#pumps = [
      this.#pumpStdout(child.stdout, ctx, lines),
      child.stderr.pipeTo(stderrLog.writable).catch(() => {
        // The log file closed under us while the run was ending.
      }),
      child.status.then((status) => {
        lines.flush();
        if (!this.#stopping) {
          ctx.onProblem(
            `${ctx.node.id}: worker exited early (code ${status.code}); see ${stderrLogPath}`,
          );
        }
      }),
    ];
  }

  async #pumpStdout(
    stdout: ReadableStream<Uint8Array>,
    ctx: BoardContext,
    lines: LineAssembler,
  ): Promise<void> {
    const reader = stdout.pipeThrough(new TextDecoderStream()).getReader();
    let pending = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      pending += value;
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        this.#handleEvent(pending.slice(0, newline), ctx, lines);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    }
  }

  #handleEvent(line: string, ctx: BoardContext, lines: LineAssembler): void {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return; // the worker's stdout is JSON lines; anything else is noise
    }
    if (typeof event !== "object" || event === null) return;
    const e = event as Record<string, unknown>;
    if (
      e.type === "uart_tx" && (e.uart === 0 || e.uart === undefined) && typeof e.byte === "number"
    ) {
      lines.push(Uint8Array.of(e.byte));
    } else if (e.type === "serial_output" && typeof e.data === "string" && (e.uart ?? 0) === 0) {
      lines.push(e.data);
    } else if (e.type === "error" && typeof e.message === "string") {
      ctx.onProblem(`${ctx.node.id}: worker error: ${e.message}`);
    } else if (e.type === "system" && e.event === "crash") {
      ctx.onProblem(`${ctx.node.id}: firmware crashed (${String(e.reason ?? "no reason given")})`);
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    try {
      await this.#writer.write(new TextEncoder().encode('{"cmd":"stop"}\n'));
      await this.#writer.close();
    } catch {
      // The worker already exited; there is nothing left to tell it.
    }
    const exited = await Promise.race([
      this.#child.status.then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), STOP_GRACE_MS);
        this.#child.status.finally(() => clearTimeout(timer));
      }),
    ]);
    if (!exited) {
      try {
        this.#child.kill("SIGKILL");
      } catch {
        // Exited between the timeout and the kill.
      }
    }
    await Promise.allSettled(this.#pumps);
  }
}

export const ESP32_FIDELITY =
  "F2 for Wi-Fi/IP (same firmware binary, frames captured at the netdev)";

/**
 * One launcher per run. Its firmware cache lives as long as the run, so a
 * long-lived process (the MCP server) recompiles a sketch edited between runs
 * and retries a compile that failed.
 */
export function createEsp32Launcher(): BoardLauncher {
  const firmwareCache: FirmwareCache = new Map();
  return { fidelity: ESP32_FIDELITY, start: (ctx) => startEsp32(ctx, firmwareCache) };
}

async function startEsp32(ctx: BoardContext, firmwareCache: FirmwareCache): Promise<RunningBoard> {
  const { node } = ctx;
  if (node.firmware.kind === "script") {
    throw new BoardError(
      `${node.id}: an esp32 board needs a sketch directory or a .bin, not a script`,
    );
  }
  const lib = resolveQemuLibrary();
  const firmware = await loadFirmware(firmwareCache, node.firmware);

  const config: Record<string, unknown> = {
    lib_path: lib,
    firmware_b64: toBase64(firmware),
    machine: "esp32-picsimlab",
    wifi_enabled: true,
  };
  if (ctx.netPort !== null) {
    // Distinct station MAC per board, and the NIC on the engine instead of SLIRP.
    const efusePath = `${ctx.outDir}/efuse-${node.id}.bin`;
    await Deno.writeFile(efusePath, buildEfuseImage(node.mac));
    Object.assign(config, workerNetworkConfig(ctx.netPort, efusePath));
  }

  const child = new Deno.Command(pythonCommand(), {
    args: [WORKER_SCRIPT],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const stderrLogPath = `${ctx.outDir}/worker-${node.id}.stderr.log`;
  const stderrLog = await Deno.open(stderrLogPath, {
    write: true,
    create: true,
    truncate: true,
  });
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(config) + "\n"));
  writer.releaseLock();
  return new Esp32Board(ctx, child, stderrLog, stderrLogPath);
}
