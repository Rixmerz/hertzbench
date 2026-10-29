// The `android` board: an AVD booted headless under the Android emulator whose Wi-Fi
// frames reach the qemu-wifi-l2 medium, so the app is a station like an ESP32
// (docs/android-device-plan.md, sections 1 and 2). The steps themselves live in
// ./android/tooling.ts; this file strings them together inside `start()`, which resolves
// only once the app is running, so time zero never comes before the app.

import type { AndroidApp, AndroidIntent, AndroidSpec } from "../scenario.ts";
import {
  type AndroidTools,
  consolePortFree,
  emulatorVersion,
  findAndroidTools,
  FIRST_CONSOLE_PORT,
  kvmProblem,
  LAST_CONSOLE_PORT,
  launchEmulator,
  listAvds,
  netsimHciArgs,
  preparedSnapshot,
  type RunningEmulator,
  snapshotBootArgs,
  wifiSocketArgs,
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

export { wifiSocketArgs };

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

/** What the lifecycle needs of the thing it boots: a node of `board: android`, or a BLE scenario's app. */
interface AppBoot {
  /** The node's id, or the bridge's: it names the emulator log and the problems. */
  id: string;
  spec: AndroidSpec;
  apk: string;
  outDir: string;
  onSerial(line: string): void;
  /** Console port to start on; null: any free one. */
  port: number | null;
  /** Flags after the headless set: the Wi-Fi socket, the snapshot, or netsim's HCI port. */
  extraArgs: string[];
  /** The first line of the emulator log says how it booted. */
  bootKind: "cold boot" | "snapshot boot";
}

/** Everything that can be wrong before an emulator is worth starting. */
async function preflight(
  id: string,
  spec: AndroidSpec,
  apk: string,
  checkKvm: () => string | null,
) {
  const tools = findAndroidTools();
  const kvm = checkKvm();
  if (kvm !== null) throw new BoardError(`${id}: ${kvm}`);
  const avds = await listAvds(tools.emulator);
  if (!avds.includes(spec.avd)) {
    throw new BoardError(
      `${id}: no AVD named ${spec.avd} (found: ${avds.join(", ") || "none"}). ` +
        `Hertzbench never creates one; make it in Android Studio or with avdmanager.`,
    );
  }
  for (const file of [apk, ...(spec.instrument?.apk !== undefined ? [spec.instrument.apk] : [])]) {
    try {
      if (!(await Deno.stat(file)).isFile) throw new Error("not a file");
    } catch {
      throw new BoardError(`${id}: ${file} is not an .apk file that exists`);
    }
  }
  // Only for the report: a build whose `-version` cannot be read still runs.
  const version = await emulatorVersion(tools.emulator).catch(() => "unknown");
  return { tools, version };
}

async function startAndroid(
  ctx: BoardContext,
  checkKvm: () => string | null,
): Promise<RunningBoard> {
  const { node } = ctx;
  if (ctx.netPort === null) throw new BoardError(`${node.id}: an android node needs a Wi-Fi port`);
  const spec = node.android;
  if (spec === undefined || node.firmware.kind !== "apk") {
    throw new BoardError(`${node.id}: an android node needs an android section`);
  }
  const apk = node.firmware.path;
  const { tools, version } = await preflight(node.id, spec, apk, checkKvm);
  const snapshot = spec.snapshot === true;
  if (snapshot) {
    const prepared = preparedSnapshot(spec.avd, version);
    if (!prepared.usable) throw new BoardError(`${node.id}: ${prepared.reason}`);
  }

  // A snapshot boot sets the MAC itself, so the console port does not matter to it.
  const port = snapshot ? null : consolePortForMac(node.mac);
  if (port !== null && !consolePortFree(port)) {
    throw new BoardError(
      `${node.id}: emulator console port ${port} is taken, and the AVD takes its Wi-Fi MAC ` +
        `${node.mac} from it. Stop the emulator that holds it, or set mac: on the node to the ` +
        `MAC another free port gives.`,
    );
  }
  const { emulator, shutDown } = await bootApp(tools, version, {
    id: node.id,
    spec,
    apk,
    outDir: ctx.outDir,
    onSerial: ctx.onSerial,
    port,
    extraArgs: [...(snapshot ? snapshotBootArgs(node.mac) : []), ...wifiSocketArgs(ctx.netPort)],
    bootKind: snapshot ? "snapshot boot" : "cold boot",
  }, flagHint(version));
  return new AndroidBoard(node.id, spec, emulator, ctx.onSerial, shutDown);
}

/**
 * Boot the AVD, install the app, start its logcat and launch it; resolves once the app is
 * running. A step that fails stops the emulator and throws, `hint` appended to the message.
 */
async function bootApp(
  tools: AndroidTools,
  version: string,
  boot: AppBoot,
  hint: string,
): Promise<{ emulator: RunningEmulator; shutDown: () => Promise<void> }> {
  const { id, spec, apk } = boot;
  const logPath = `${boot.outDir}/${id}-emulator.log`;
  const emulator = launchEmulator(tools, {
    avd: spec.avd,
    ...(boot.port !== null ? { port: boot.port } : {}),
    extraArgs: boot.extraArgs,
  });
  let logcat: { stop(): Promise<void> } | undefined;
  const shutDown = async () => {
    // The log is written last: it holds what the emulator said up to its death.
    await logcat?.stop();
    await emulator.kill();
    await Deno.writeTextFile(
      logPath,
      `emulator ${version} (${boot.bootKind})\n${emulator.logTail()}\n`,
    );
  };
  try {
    await emulator.waitForBoot(spec.bootTimeoutMs);
    logcat = await emulator.logcat(spec.logcat, withoutBufferBanners(boot.onSerial));
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
    throw new BoardError(`${id}: ${describe(error)}${hint} (log: ${logPath})`);
  }
  return { emulator, shutDown };
}

export interface AndroidAppContext {
  /** The bridge's id: the emulator log is `<id>-emulator.log` and the app's logcat lines are its serial. */
  id: string;
  app: AndroidApp;
  /** The port netsimd is asked to listen on for HCI hosts: the bridge's `netsim_hci`. */
  hciPort: number;
  outDir: string;
  onSerial(line: string): void;
}

/** Boots the app of a BLE scenario (docs/android-device-plan.md, section 3). */
export interface AndroidAppLauncher {
  start(context: AndroidAppContext): Promise<RunningBoard>;
}

/**
 * The lifecycle of a node without the Wi-Fi socket: the app reaches the mirrored peripheral
 * through netsim, which the emulator starts on `hciPort` for the bridge's host side to join.
 */
export function createAndroidAppLauncher(options: AndroidLauncherOptions = {}): AndroidAppLauncher {
  return {
    async start(ctx) {
      const { tools, version } = await preflight(
        ctx.id,
        ctx.app,
        ctx.app.apk,
        options.checkKvm ?? kvmProblem,
      );
      const { emulator, shutDown } = await bootApp(tools, version, {
        id: ctx.id,
        spec: ctx.app,
        apk: ctx.app.apk,
        outDir: ctx.outDir,
        onSerial: ctx.onSerial,
        port: null,
        extraArgs: netsimHciArgs(ctx.hciPort),
        bootKind: "cold boot",
      }, "");
      return new AndroidBoard(ctx.id, ctx.app, emulator, ctx.onSerial, shutDown);
    },
  };
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
