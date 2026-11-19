// `hertzbench android prepare <avd>`: save the snapshot that `snapshot: true` android nodes boot
// from (docs/android-device-plan.md, piece 6). `hertzbench android setup`: install what android
// nodes need, without Android Studio. Kept apart from main.ts because they take no scenario file.

import { PRODUCT } from "../brand.ts";
import { BoardError } from "../orchestrator/boards/board.ts";
import { detectHost, findAndroidToolsOnHost } from "../orchestrator/boards/android/host.ts";
import type { AndroidHostEnv, CommandRunner } from "../orchestrator/boards/android/platform.ts";
import {
  DEFAULT_AVD,
  DEFAULT_DEVICE,
  DEFAULT_RAM_MB,
  fetchBytes,
  runSetup,
  type SetupDeps,
  type SetupOptions,
  setupRunner,
} from "../orchestrator/boards/android/setup.ts";
import { PREPARED_SNAPSHOT, prepareSnapshot } from "../orchestrator/boards/android/tooling.ts";

export const ANDROID_USAGE = `Usage:
  ${PRODUCT.cli} android setup [--sdk <dir>] [--image <id>] [--avd <name>] [--device <id>]
                              [--ram <MB>] [--accept-licenses] [--dry-run]
  ${PRODUCT.cli} android prepare <avd>

setup     Install what android nodes need, without Android Studio: Google's command-line tools
          (downloaded from dl.google.com when missing), platform-tools, the emulator and a system
          image, then an AVD. It skips what is already there, so it can be run again.
          --sdk <dir>         SDK folder. Default: $ANDROID_HOME, $ANDROID_SDK_ROOT, then the
                              platform default (~/Android/Sdk on Linux, ~/Library/Android/sdk on
                              macOS, %LOCALAPPDATA%\\Android\\Sdk on Windows).
          --image <id>        System image. Default: system-images;android-36;google_apis;x86_64
                              (arm64-v8a on an Arm host).
          --avd <name>        AVD to create. Default: ${DEFAULT_AVD}.
          --device <id>       avdmanager device. Default: ${DEFAULT_DEVICE}.
          --ram <MB>          hw.ramSize of the new AVD. Default: ${DEFAULT_RAM_MB}.
          --accept-licenses   Accept Google's SDK licences for you. Without it sdkmanager asks on
                              this terminal, and setup stops when there is no terminal.
          --dry-run           Print each step and change nothing.

prepare   Boot the AVD once with the flags a run uses, save the snapshot "${PREPARED_SNAPSHOT}" in
          it and stop it. Scenarios with \`snapshot: true\` in an android section boot that
          snapshot, which is faster than a cold boot and lets several android nodes share a run.
          The AVD must not be running, and its own snapshots are left alone. Run it again after
          the emulator is updated.
`;

/** What a test replaces; the command itself passes none, so it runs on this machine. */
export interface AndroidCommandOptions {
  /** The host to find the tools on and check acceleration for; default: this process's. */
  host?: AndroidHostEnv;
  /** Runs `emulator -accel-check`; default: real commands. */
  runner?: CommandRunner;
  /** Replaces the file check of the tool lookup, so a test can stand in for a Windows SDK. */
  exists?: (path: string) => boolean;
  /** Reads the environment the AVD directory is looked up in; default: this process's. */
  env?: (name: string) => string | undefined;
  /** Replaces the snapshot step, so a test sees which tools it was given. */
  prepare?: typeof prepareSnapshot;
  /** Replaces parts of what `android setup` does to the machine (the downloader, the runner). */
  setup?: Partial<SetupDeps>;
}

const SETUP_VALUE_FLAGS = ["--sdk", "--image", "--avd", "--device", "--ram"] as const;

/** The options of `android setup`, or the sentence that says what is wrong with the arguments. */
function parseSetupArgs(args: string[]): SetupOptions | string {
  const options: SetupOptions = {};
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i]!.split(/=(.*)/s, 2) as [string, string | undefined];
    if (flag === "--accept-licenses" && inline === undefined) options.acceptLicenses = true;
    else if (flag === "--dry-run" && inline === undefined) options.dryRun = true;
    else if ((SETUP_VALUE_FLAGS as readonly string[]).includes(flag)) {
      const value = inline ?? args[++i];
      if (value === undefined || value === "" || (inline === undefined && value.startsWith("-"))) {
        return `${flag} needs a value`;
      }
      if (flag === "--ram") options.ram = /^\d+$/.test(value) ? Number(value) : NaN;
      else options[flag.slice(2) as "sdk" | "image" | "avd" | "device"] = value;
    } else return `unexpected argument ${args[i]}`;
  }
  return options;
}

/** Exit status: 0 prepared, 2 bad usage or an environment that cannot do it. */
export async function androidCommand(
  argv: string[],
  options: AndroidCommandOptions = {},
): Promise<number> {
  const [subcommand, avd, ...rest] = argv;
  if (subcommand === "--help" || subcommand === "-h") {
    console.error(ANDROID_USAGE);
    return 0;
  }
  if (subcommand === "setup") {
    return await setupCommand([avd, ...rest].filter((a) => a !== undefined), options);
  }
  if (subcommand !== "prepare") {
    console.error(
      `${
        subcommand === undefined
          ? "android needs a subcommand"
          : `unknown android subcommand ${JSON.stringify(subcommand)}`
      }\n\n${ANDROID_USAGE}`,
    );
    return 2;
  }
  if (avd === undefined || avd.startsWith("-")) {
    console.error(`android prepare needs the name of an AVD\n\n${ANDROID_USAGE}`);
    return 2;
  }
  if (rest.length > 0) {
    console.error(`unexpected argument ${rest[0]}\n\n${ANDROID_USAGE}`);
    return 2;
  }
  try {
    console.error(`[${PRODUCT.slug}] booting ${avd} to save its snapshot; this takes a minute`);
    const host = options.host ?? detectHost();
    const { snapshotDir, emulatorVersion } = await (options.prepare ?? prepareSnapshot)(
      findAndroidToolsOnHost(host, options.exists),
      avd,
      { host, runner: options.runner, env: options.env },
    );
    console.log(
      `${avd}: snapshot ${PREPARED_SNAPSHOT} saved in ${snapshotDir} (emulator ${emulatorVersion})`,
    );
    return 0;
  } catch (error) {
    if (error instanceof BoardError) {
      console.error(`${PRODUCT.cli}: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

/** `android setup`: exit status 0 when the SDK and the AVD are ready, 2 when a step failed. */
async function setupCommand(args: string[], options: AndroidCommandOptions): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.error(ANDROID_USAGE);
    return 0;
  }
  const parsed = parseSetupArgs(args);
  if (typeof parsed === "string") {
    console.error(`android setup: ${parsed}\n\n${ANDROID_USAGE}`);
    return 2;
  }
  try {
    await runSetup(parsed, {
      host: options.host ?? detectHost(),
      runner: setupRunner,
      download: fetchBytes,
      env: options.env,
      exists: options.exists,
      interactive: Deno.stdin.isTerminal(),
      log: (line) => console.log(line),
      ...options.setup,
    });
    return 0;
  } catch (error) {
    if (error instanceof BoardError) {
      console.error(`${PRODUCT.cli}: ${error.message}`);
      return 2;
    }
    throw error;
  }
}
