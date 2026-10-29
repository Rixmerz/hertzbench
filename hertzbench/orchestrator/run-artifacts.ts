// The files a run writes while it plays: air.pcap, events.jsonl and one serial-<node>.log per
// board that spoke. Every record goes to its file as it happens, so a run that is interrupted,
// crashes or is killed leaves what it had produced; nothing waits in memory for the end.

import { dirname, join } from "node:path";
import type { EngineEvent, EventLog, PcapWriter } from "../engine/mod.ts";

const encoder = new TextEncoder();

/** A file that grows a record at a time. A write that fails is reported once and the file is dropped. */
class GrowingFile {
  readonly path: string;
  readonly #onError: (message: string) => void;
  #file: Deno.FsFile | null = null;
  #created = false;

  constructor(path: string, onError: (message: string) => void) {
    this.path = path;
    this.#onError = onError;
    try {
      Deno.mkdirSync(dirname(path), { recursive: true });
      this.#file = Deno.openSync(path, { write: true, create: true, truncate: true });
      this.#created = true;
    } catch (error) {
      this.#fail(error);
    }
  }

  /** Whether the file is on disk, even if a later write to it failed. */
  get created(): boolean {
    return this.#created;
  }

  write(data: string | Uint8Array): void {
    if (!this.#file) return;
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    try {
      // ponytail: one write call per record, fine at the rates a run logs; batch them if a trace
      // of a busy air ever shows the writes. Unbuffered is the point: what was written survives a
      // kill. A short write is possible, so loop until all of it is written.
      for (let done = 0; done < bytes.length;) done += this.#file.writeSync(bytes.subarray(done));
    } catch (error) {
      this.#fail(error);
    }
  }

  close(): void {
    const file = this.#file;
    this.#file = null;
    try {
      file?.close();
    } catch (error) {
      this.#fail(error);
    }
  }

  #fail(error: unknown): void {
    this.close();
    this.#onError(`cannot write ${this.path}: ${error instanceof Error ? error.message : error}`);
  }
}

export interface ArtifactPaths {
  /** Where the serial logs go. */
  outDir: string;
  pcap: string;
  events: string;
}

export class RunArtifacts {
  readonly #log: EventLog;
  readonly #paths: ArtifactPaths;
  readonly #onProblem: (message: string) => void;
  #pcap: GrowingFile | null = null;
  /** Set when time zero comes: events are written timed from it. */
  #stream: { zeroMs: number; events: GrowingFile } | null = null;
  readonly #serial = new Map<string, GrowingFile>();
  #closed = false;

  /** `onProblem` is told of a file that could not be written; the run goes on without it. */
  constructor(log: EventLog, paths: ArtifactPaths, onProblem: (message: string) => void) {
    this.#log = log;
    this.#paths = paths;
    this.#onProblem = onProblem;
  }

  /**
   * Starts air.pcap: the capture header now, then each frame as it is captured. Captures are
   * stamped with the Unix time of the clock's start, so they need no time zero.
   */
  streamPcap(pcap: PcapWriter): void {
    const file = new GrowingFile(this.#paths.pcap, this.#onProblem);
    this.#pcap = file;
    pcap.pipe((bytes) => file.write(bytes));
  }

  /**
   * Time zero has come. Everything logged so far is written, timed from it (the boot lines come
   * out negative), and from now on every event is written as it is logged.
   */
  startAt(zeroMs: number): void {
    if (this.#stream || this.#closed) return;
    this.#stream = { zeroMs, events: new GrowingFile(this.#paths.events, this.#onProblem) };
    for (const event of this.#log.events) this.record(event);
  }

  /** Give this to `EventLog.listen`. Events before time zero wait in the log until `startAt`. */
  record(event: EngineEvent): void {
    const stream = this.#stream;
    if (!stream || this.#closed) return;
    const timed = { ...event, t: event.t - stream.zeroMs };
    stream.events.write(JSON.stringify(timed) + "\n");
    if (event.type !== "serial") return;
    let file = this.#serial.get(event.node);
    if (!file) {
      file = new GrowingFile(join(this.#paths.outDir, `serial-${event.node}.log`), this.#onProblem);
      this.#serial.set(event.node, file);
    }
    file.write(`[${(timed.t / 1000).toFixed(3)}s] ${event.text}\n`);
  }

  /**
   * Ends every file. A run that stopped before time zero writes its log timed from the clock's
   * start instead, as the capture is. Safe to call twice.
   */
  close(): void {
    this.startAt(0);
    this.#closed = true;
    this.#pcap?.close();
    this.#stream?.events.close();
    for (const file of this.#serial.values()) file.close();
  }

  /** The files this run wrote, for the result: the capture, the event log, then the serial logs. */
  files(): { pcap: string | null; events: string | null; serial: string[] } {
    const written = (file: GrowingFile | null | undefined) => file?.created ? file.path : null;
    return {
      pcap: written(this.#pcap),
      events: written(this.#stream?.events),
      serial: [...this.#serial.values()].flatMap((file) => written(file) ?? []),
    };
  }
}
