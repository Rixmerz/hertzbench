// The `android` board: an AVD booted headless under the Android emulator whose Wi-Fi
// frames reach the qemu-wifi-l2 medium, so the app is a station like an ESP32
// (docs/android-device-plan.md, sections 1 and 2). The steps themselves live in
// ./android/tooling.ts; this file strings them together inside `start()`, which resolves
// only once the app is running, so time zero never comes before the app.

import type { AndroidIntent, AndroidSpec, ScenarioNode } from "../scenario.ts";
import {
  consolePortFree,
  emulatorVersion,
  findAndroidTools,
  FIRST_CONSOLE_PORT,
  kvmProblem,
  LAST_CONSOLE_PORT,
  launchEmulator,
  listAvds,
  type RunningEmulator,
} from "./android/tooling.ts";
import { type BoardContext, BoardError, type BoardLauncher, type RunningBoard } from "./board.ts";

/** The emulator build the `-feature -WiFiPacketStream` behaviour was checked against. */
export const VERIFIED_EMULATOR_VERSION = "37.1.11";

export const ANDROID_FIDELITY =
  "Android emulator (QEMU, x86_64 system image): the app, its OS and its IP stack run unchanged; " +
  "the radio below wlan0 is the medium, 802.11 is not modelled (as for ESP32, F2)";

/**
 * The console port that makes the guest's `wlan0` take `mac`. The emulator derives the MAC from
 * its console port, `02:<port high byte>:<port low byte>:00:00:00` (5554 gives 02:15:b2:..., 5584
 * gives 02:15:d0:...; seen on emulator 37.1.11), and the medium needs the MAC before the guest
 * boots. Null for a MAC that is not of that shape: the scenario says it set the guest's MAC
 * another way, and any free port will do.
 */
export function consolePortForMac(mac: string): number | null {
  const match = /^02:([0-9a-f]{2}):([0-9a-f]{2}):00:00:00$/.exec(mac);
  if (!match) return null;
  const port = parseInt(match[1]! + match[2]!, 16);
  return port % 2 === 0 && port >= FIRST_CONSOLE_PORT && port <= LAST_CONSOLE_PORT ? port : null;
}

/**
 * `-feature -WiFiPacketStream` makes the guest's virtio Wi-Fi a plain socket netdev; without it
 * netsim owns Wi-Fi and the socket stays silent. It is an undocumented emulator feature flag.
 */
export function wifiSocketArgs(netPort: number): string[] {
  return ["-feature", "-WiFiPacketStream", "-wifi-socket", `connect=127.0.0.1:${netPort}`];
}

export interface AndroidLauncherOptions {
  /** Replaces the /dev/kvm check; tests on hosts without KVM pass `() => null`. */
  checkKvm?: () => string | null;
}

export function createAndroidLauncher(options: AndroidLauncherOptions = {}): BoardLauncher {
  return {
    fidelity: ANDROID_FIDELITY,
    start: (ctx) => startAndroid(ctx, options.checkKvm ?? kvmProblem),
  };
}

/** Everything that can be wrong before an emulator is worth starting. */
async function preflight(node: ScenarioNode, checkKvm: () => string | null) {
  const spec = node.android;
  if (spec === undefined || node.firmware.kind !== "apk") {
    throw new BoardError(`${node.id}: an android node needs an android section`);
  }
  const apk = node.firmware.path;
  const tools = findAndroidTools();
  const kvm = checkKvm();
  if (kvm !== null) throw new BoardError(`${node.id}: ${kvm}`);
  const avds = await listAvds(tools.emulator);
  if (!avds.includes(spec.avd)) {
    throw new BoardError(
      `${node.id}: no AVD named ${spec.avd} (found: ${avds.join(", ") || "none"}). ` +
        `Hertzbench never creates one; make it in Android Studio or with avdmanager.`,
    );
  }
  for (const file of [apk, ...(spec.instrument?.apk !== undefined ? [spec.instrument.apk] : [])]) {
    try {
      if (!(await Deno.stat(file)).isFile) throw new Error("not a file");
    } catch {
      throw new BoardError(`${node.id}: ${file} is not an .apk file that exists`);
    }
  }
  // Only for the report: a build whose `-version` cannot be read still runs.
  const version = await emulatorVersion(tools.emulator).catch(() => "unknown");
  return { tools, spec, apk, version };
}

async function startAndroid(
  ctx: BoardContext,
  checkKvm: () => string | null,
): Promise<RunningBoard> {
  const { node } = ctx;
  if (ctx.netPort === null) throw new BoardError(`${node.id}: an android node needs a Wi-Fi port`);
  const { tools, spec, apk, version } = await preflight(node, checkKvm);

  const logPath = `${ctx.outDir}/${node.id}-emulator.log`;
  const port = consolePortForMac(node.mac);
  if (port !== null && !consolePortFree(port)) {
    throw new BoardError(
      `${node.id}: emulator console port ${port} is taken, and the AVD takes its Wi-Fi MAC ` +
        `${node.mac} from it. Stop the emulator that holds it, or set mac: on the node to the ` +
        `MAC another free port gives.`,
    );
  }
  const emulator = launchEmulator(tools, {
    avd: spec.avd,
    ...(port !== null ? { port } : {}),
    extraArgs: wifiSocketArgs(ctx.netPort),
  });
  let logcat: { stop(): Promise<void> } | undefined;
  const shutDown = async () => {
    // The log is written last: it holds what the emulator said up to its death.
    await logcat?.stop();
    await emulator.kill();
    await Deno.writeTextFile(logPath, `emulator ${version}\n${emulator.logTail()}\n`);
  };
  try {
    await emulator.waitForBoot(spec.bootTimeoutMs);
    logcat = await emulator.logcat(spec.logcat, withoutBufferBanners(ctx.onSerial));
    await emulator.install(apk, spec.installTimeoutMs);
    if (spec.instrument?.apk !== undefined) {
      await emulator.install(spec.instrument.apk, spec.installTimeoutMs);
    }
    await emulator.launch(
      {
        package: spec.package,
        ...(spec.activity !== undefined ? { activity: spec.activity } : {}),
        extras: spec.extras,
      },
      spec.launchTimeoutMs,
    );
  } catch (error) {
    await shutDown().catch(() => {}); // the step's own failure is the one to report
    throw new BoardError(`${node.id}: ${describe(error)}${flagHint(version)} (log: ${logPath})`);
  }
  return new AndroidBoard(node.id, spec, emulator, ctx.onSerial, shutDown);
}

// adb announces the log buffer ("--------- beginning of main") even when logcat filters by tag.
// That line is adb's, not the app's, and a serial assertion must not be able to match it.
const LOGCAT_BANNER = /^-{9} /;

function withoutBufferBanners(onSerial: (line: string) => void): (line: string) => void {
  return (line) => {
    if (!LOGCAT_BANNER.test(line)) onSerial(line);
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A run on another emulator build may fail only because the undocumented flag changed. */
function flagHint(version: string): string {
  return version.startsWith(VERIFIED_EMULATOR_VERSION) ? "" : `\n  (emulator ${version}; ` +
    `-feature -WiFiPacketStream was verified with ${VERIFIED_EMULATOR_VERSION}. ` +
    `If netsim Wi-Fi is on, the emulator sends no Wi-Fi frames.)`;
}

/**
 * Turns the raw output of `am instrument -w -r` into the serial lines `test <class>#<method>
 * passed|failed|skipped`, one as soon as a test ends. Status code 1 only says a test started, and
 * the runner's own codes decide the rest: 0 passed, -1 and -2 failed, -3 (ignored) and -4
 * (assumption failure) skipped; anything else (2, in progress) says nothing about the result.
 */
export class InstrumentationResults {
  #status: Record<string, string> = {};
  #result: Record<string, string> = {};
  /** Where a line that is not `INSTRUMENTATION_*` continues: stack traces and messages span lines. */
  #open: { into: Record<string, string>; key: string } | null = null;
  #started: string | null = null;
  #runCode: number | null = null;
  #failedToStart: string | null = null;
  #errors: string[] = [];

  /** The serial lines this line of output completes. */
  feed(line: string): string[] {
    const header = /^INSTRUMENTATION_(STATUS_CODE|STATUS|RESULT|CODE|FAILED): ?(.*)$/.exec(line);
    if (header === null) {
      if (this.#open !== null) this.#open.into[this.#open.key] += `\n${line}`;
      return [];
    }
    const [, kind, value] = header as unknown as [string, string, string];
    this.#open = null;
    switch (kind) {
      case "STATUS":
      case "RESULT": {
        const into = kind === "STATUS" ? this.#status : this.#result;
        const split = value.indexOf("=");
        if (split < 0) return [];
        const key = value.slice(0, split);
        into[key] = value.slice(split + 1);
        this.#open = { into, key };
        return [];
      }
      case "CODE":
        this.#runCode = Number(value);
        return [];
      case "FAILED":
        this.#failedToStart = value;
        return [];
      default:
        return this.#finishStatus(Number(value));
    }
  }

  #finishStatus(code: number): string[] {
    const status = this.#status;
    this.#status = {};
    const test = status.test === undefined
      ? null
      : status.class === undefined
      ? status.test
      : `${status.class}#${status.test}`;
    if (test === null) {
      // A status block that names no test is the runner's own: an error here fails the run.
      if (code < 0) this.#errors.push(status.Error ?? status.stack ?? `status code ${code}`);
      return [];
    }
    if (code === 1) {
      this.#started = test;
      return [];
    }
    const word = code === 0
      ? "passed"
      : code === -1 || code === -2
      ? "failed"
      : code === -3 || code === -4
      ? "skipped"
      : null;
    if (this.#started === test) this.#started = null;
    return word === null ? [] : [`test ${test} ${word}`];
  }

  /**
   * Called when adb has exited with `exitCode`: why the run as a whole failed, or null when
   * instrumentation reached its end. `lines` is a test that had started and never ended, which a
   * crashed process leaves behind: it did not pass.
   */
  finish(exitCode: number): { lines: string[]; failure: string | null } {
    const reasons: string[] = [];
    if (this.#failedToStart !== null) reasons.push(`could not start: ${this.#failedToStart}`);
    reasons.push(...this.#errors);
    const crash = this.#result.shortMsg;
    if (crash !== undefined) {
      reasons.push(`${crash}${this.#result.longMsg ? `: ${this.#result.longMsg}` : ""}`);
    }
    if (reasons.length === 0) {
      if (this.#runCode === null) {
        reasons.push(`adb exited with code ${exitCode} before the end of instrumentation`);
      } else if (this.#runCode !== -1) reasons.push(`it ended with result code ${this.#runCode}`);
    }
    const lines = reasons.length > 0 && this.#started !== null
      ? [`test ${this.#started} failed`]
      : [];
    return { lines, failure: reasons.length > 0 ? reasons.join("; ") : null };
  }
}

class AndroidBoard implements RunningBoard {
  readonly clockDescription = "wall clock (the guest follows host time)";
  #stopped = false;
  #instrumentation: { stop(): Promise<void> } | null = null;

  constructor(
    private readonly nodeId: string,
    private readonly spec: AndroidSpec,
    private readonly emulator: RunningEmulator,
    private readonly onSerial: (line: string) => void,
    private readonly shutDown: () => Promise<void>,
  ) {}

  sendIntent(intent: AndroidIntent): Promise<void> {
    return this.emulator.sendIntent(this.spec, intent, this.spec.launchTimeoutMs);
  }

  /**
   * Runs the scenario's `android.instrument` runner. Each test result is a serial line when it
   * arrives; the promise settles when instrumentation ends, and rejects when the run as a whole
   * failed (no such runner, a crash). A board stopped meanwhile ends it quietly.
   */
  async runInstrumentation(): Promise<void> {
    const instrument = this.spec.instrument;
    if (instrument === undefined) {
      throw new BoardError(`${this.nodeId}: the android section has no instrument to run`);
    }
    const results = new InstrumentationResults();
    const run = this.emulator.instrument(
      instrument.runner,
      (line) => results.feed(line).forEach(this.onSerial),
    );
    this.#instrumentation = run;
    const exitCode = await run.done;
    if (this.#stopped) return;
    const { lines, failure } = results.finish(exitCode);
    lines.forEach(this.onSerial);
    if (failure !== null) {
      throw new BoardError(
        `${this.nodeId}: instrumentation ${instrument.runner} failed: ${failure}`,
      );
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    // Before the emulator goes: a killed emulator would make a healthy adb call look failed.
    await this.#instrumentation?.stop();
    await this.shutDown();
  }
}
