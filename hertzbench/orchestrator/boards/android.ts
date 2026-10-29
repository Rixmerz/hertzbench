// The `android` board: an AVD booted headless under the Android emulator whose Wi-Fi
// frames reach the qemu-wifi-l2 medium, so the app is a station like an ESP32
// (docs/android-device-plan.md, sections 1 and 2). The steps themselves live in
// ./android/tooling.ts; this file strings them together inside `start()`, which resolves
// only once the app is running, so time zero never comes before the app.

import type { ScenarioNode } from "../scenario.ts";
import {
  consolePortFree,
  emulatorVersion,
  findAndroidTools,
  FIRST_CONSOLE_PORT,
  kvmProblem,
  LAST_CONSOLE_PORT,
  launchEmulator,
  listAvds,
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
  try {
    if (!(await Deno.stat(apk)).isFile) throw new Error("not a file");
  } catch {
    throw new BoardError(`${node.id}: ${apk} is not an .apk file that exists`);
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
    logcat = await emulator.logcat(spec.logcat, ctx.onSerial);
    await emulator.install(apk, spec.installTimeoutMs);
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
  return new AndroidBoard(shutDown);
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

class AndroidBoard implements RunningBoard {
  readonly clockDescription = "wall clock (the guest follows host time)";
  #stopped = false;

  constructor(private readonly shutDown: () => Promise<void>) {}

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    await this.shutDown();
  }
}
