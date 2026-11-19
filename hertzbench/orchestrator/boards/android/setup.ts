// `hertzbench android setup`: take a machine with no Android SDK to a bootable AVD without
// Android Studio (docs/android.md, "Android without Android Studio"). It downloads Google's own
// command-line tools zip at run time, then lets Google's `sdkmanager` and `avdmanager` do the
// rest; nothing from Google is bundled here. Everything that touches the machine goes through
// `SetupDeps`, so a test plans and runs the steps with fakes and no network.

import { PRODUCT } from "../../../brand.ts";
import { BoardError } from "../board.ts";
import { checkHardwareAcceleration } from "./accel.ts";
import {
  type AndroidHostEnv,
  type CommandResult,
  defaultSdkRoot,
  emulatorExecutableName,
  joinHostPath,
} from "./platform.ts";
import { avdDirectory } from "./tooling.ts";

export const DEFAULT_AVD = "pixel8";
export const DEFAULT_DEVICE = "pixel_8";
export const DEFAULT_RAM_MB = 2048;
const IMAGE_PREFIX = "system-images;android-36;google_apis;";

/** The image docs/android.md recommends; Arm hosts cannot run an x86_64 one. */
export const defaultImage = (host: AndroidHostEnv): string =>
  IMAGE_PREFIX + (host.arch === "aarch64" ? "arm64-v8a" : "x86_64");

// ponytail: one pinned build of Google's tools. The sha256 values are the ones
// developer.android.com/studio publishes for it; to move to a newer build, change BUILD and the
// five hashes there. Google's `_latest` file names carry the build number, so there is no stable URL.
const BUILD = "15859902";
const DOWNLOAD_BASE = "https://dl.google.com/android/repository/";
const ZIP_SHA256: Record<string, string> = {
  linux: "4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583",
  win: "90ae805d20434428bffcb699c290860f19bb5f66a67e6b330067e3de801fb04a",
  mac_arm64: "835b62a26162b229b441d1f6d4680383815a270809eb33522c0d480fa5002c4e",
  mac_x86_64: "c5a6378ab5cf7e0d5701921405115befff13e9ff7417fb588389338f8bd050f3",
};

/** The zip Google publishes for `host`: its URL and the sha256 the download must have. */
export function commandLineToolsZip(host: AndroidHostEnv): { url: string; sha256: string } {
  const key = host.platform === "windows"
    ? "win"
    : host.platform === "darwin"
    ? (host.arch === "aarch64" ? "mac_arm64" : "mac_x86_64")
    : "linux";
  return {
    url: `${DOWNLOAD_BASE}commandlinetools-${key}-${BUILD}_latest.zip`,
    sha256: ZIP_SHA256[key]!,
  };
}

/** Runs the tools. A real one is `setupRunner`; a test records the calls and answers. */
export interface SetupRunner {
  /** Captures the output; `input` is written to the tool's stdin. */
  run(
    cmd: string,
    args: string[],
    opts?: { timeoutMs?: number; env?: Record<string, string>; input?: string },
  ): Promise<CommandResult>;
  /** Runs the tool on the user's terminal, so its progress and its prompts are seen. Exit code. */
  attach(cmd: string, args: string[], opts?: { env?: Record<string, string> }): Promise<number>;
}

export interface SetupDeps {
  host: AndroidHostEnv;
  runner: SetupRunner;
  /** Fetches a URL's bytes; the real one needs network permission. */
  download: (url: string) => Promise<Uint8Array>;
  /** Whether a file exists; default: the real file system. */
  exists?: (path: string) => boolean;
  /** Reads the environment the AVD directory is looked up in; default: this process's. */
  env?: (name: string) => string | undefined;
  /** Whether a person can answer sdkmanager's licence prompts on this terminal. */
  interactive: boolean;
  log: (line: string) => void;
  /** Replaces the download's expected checksum, so a test need not hash a Google zip. */
  zip?: { url: string; sha256: string };
}

export interface SetupOptions {
  sdk?: string;
  image?: string;
  avd?: string;
  device?: string;
  ram?: number;
  acceptLicenses?: boolean;
  dryRun?: boolean;
}

export interface SetupPlan {
  sdk: string;
  /** Where the SDK root came from: "--sdk", an environment variable, or the platform default. */
  sdkSource: string;
  image: string;
  avd: string;
  device: string;
  ram: number;
  zip: { url: string; sha256: string };
  /** `<sdk>/cmdline-tools/latest`, where the zip is unpacked. */
  latest: string;
  sdkmanager: string;
  avdmanager: string;
  emulator: string;
  cmdlineToolsInstalled: boolean;
  /** The `sdkmanager` package ids not yet installed under the SDK. */
  missingPackages: string[];
  avdExists: boolean;
}

function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

/** The SDK root to install into: --sdk, $ANDROID_HOME, $ANDROID_SDK_ROOT, then the default. */
export function setupSdkRoot(
  host: AndroidHostEnv,
  flag?: string,
): { sdk: string; source: string } {
  if (flag) return { sdk: flag, source: "--sdk" };
  for (const name of ["ANDROID_HOME", "ANDROID_SDK_ROOT"]) {
    const value = host.env[name];
    if (value) return { sdk: value, source: name };
  }
  return { sdk: defaultSdkRoot(host), source: "the default location" };
}

const toolName = (host: AndroidHostEnv, name: string) =>
  host.platform === "windows" ? `${name}.bat` : name;

function checkOptions(options: SetupOptions): void {
  const bad = (what: string): never => {
    throw new BoardError(`android setup: ${what}`);
  };
  if (
    options.image !== undefined &&
    !/^system-images;android-[\w.-]+;[\w-]+;[\w-]+$/.test(options.image)
  ) {
    bad(`--image must look like system-images;android-36;google_apis;x86_64, got ${options.image}`);
  }
  if (options.avd !== undefined && !/^[A-Za-z0-9][\w.-]*$/.test(options.avd)) {
    bad(`--avd may hold letters, digits, . _ and -, got ${JSON.stringify(options.avd)}`);
  }
  if (options.device !== undefined && !/^[A-Za-z0-9][\w. -]*$/.test(options.device)) {
    bad(`--device must be an avdmanager device id such as pixel_8, got ${options.device}`);
  }
  if (options.ram !== undefined && !(Number.isInteger(options.ram) && options.ram > 0)) {
    bad(`--ram must be a whole number of MB, got ${options.ram}`);
  }
}

/** Everything setup would do on this machine, decided from what is already installed. */
export function planSetup(options: SetupOptions, deps: SetupDeps): SetupPlan {
  checkOptions(options);
  const { host } = deps;
  const exists = deps.exists ?? isFile;
  const { sdk, source } = setupSdkRoot(host, options.sdk);
  const image = options.image ?? defaultImage(host);
  const avd = options.avd ?? DEFAULT_AVD;
  const latest = joinHostPath(host, sdk, "cmdline-tools", "latest");
  const bin = (name: string) => joinHostPath(host, latest, "bin", toolName(host, name));
  // Every SDK package leaves a package.xml in the folder its id names.
  const installed = (id: string) =>
    exists(joinHostPath(host, sdk, ...id.split(";"), "package.xml"));
  return {
    sdk,
    sdkSource: source,
    image,
    avd,
    device: options.device ?? DEFAULT_DEVICE,
    ram: options.ram ?? DEFAULT_RAM_MB,
    zip: deps.zip ?? commandLineToolsZip(host),
    latest,
    sdkmanager: bin("sdkmanager"),
    avdmanager: bin("avdmanager"),
    emulator: joinHostPath(host, sdk, "emulator", emulatorExecutableName(host.platform)),
    cmdlineToolsInstalled: exists(bin("sdkmanager")),
    missingPackages: ["platform-tools", "emulator", image].filter((id) => !installed(id)),
    avdExists: avdDirectory(avd, deps.env) !== null,
  };
}

const JAVA_HINT = "It needs a Java 17 or newer runtime: set JAVA_HOME or put java on PATH.";

function toolFailure(what: string, result: { code: number; stdout?: string; stderr?: string }) {
  const said = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split(/\r?\n/).slice(-8)
    .join("\n");
  return new BoardError(
    `${what} failed (exit ${result.code})${said ? `:\n${said}` : ""}\n${JAVA_HINT}`,
  );
}

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

/** Download Google's zip, check its sha256, and unpack it to `<sdk>/cmdline-tools/latest`. */
async function installCommandLineTools(plan: SetupPlan, deps: SetupDeps): Promise<void> {
  const { host } = deps;
  const parent = joinHostPath(host, plan.sdk, "cmdline-tools");
  await Deno.mkdir(parent, { recursive: true });
  const work = await Deno.makeTempDir({ dir: parent, prefix: ".hertzbench-" });
  try {
    const bytes = await deps.download(plan.zip.url);
    const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
    if (sha256 !== plan.zip.sha256) {
      throw new BoardError(
        `the download from ${plan.zip.url} has sha256 ${sha256}, expected ${plan.zip.sha256}; ` +
          `nothing was unpacked. Run it again, and if it repeats, the pinned build is out of date.`,
      );
    }
    const zipFile = joinHostPath(host, work, "tools.zip");
    const unpacked = joinHostPath(host, work, "unpacked");
    await Deno.writeFile(zipFile, bytes);
    await Deno.mkdir(unpacked);
    // Windows 10 and later ship bsdtar, which reads zips; Linux and macOS ship (or can install) unzip.
    const [cmd, args] = host.platform === "windows"
      ? ["tar", ["-xf", zipFile, "-C", unpacked]]
      : ["unzip", ["-q", zipFile, "-d", unpacked]];
    const unzip = await deps.runner.run(cmd!, args!);
    if (unzip.code !== 0) {
      throw new BoardError(
        `${cmd} could not unpack the download (exit ${unzip.code}): ` +
          `${(unzip.stderr || unzip.stdout).trim()}. Install ${cmd} and run again.`,
      );
    }
    try {
      await Deno.rename(joinHostPath(host, unpacked, "cmdline-tools"), plan.latest);
    } catch (error) {
      throw new BoardError(
        `could not move the unpacked tools to ${plan.latest}: ${(error as Error).message}. ` +
          `If that folder exists and is incomplete, remove it and run again.`,
      );
    }
  } finally {
    await Deno.remove(work, { recursive: true }).catch(() => {});
  }
}

const sdkEnv = (plan: SetupPlan) => ({ ANDROID_HOME: plan.sdk, ANDROID_SDK_ROOT: plan.sdk });

async function installPackages(plan: SetupPlan, options: SetupOptions, deps: SetupDeps) {
  const env = sdkEnv(plan);
  const root = `--sdk_root=${plan.sdk}`;
  if (options.acceptLicenses) {
    const licenses = await deps.runner.run(plan.sdkmanager, [root, "--licenses"], {
      env,
      input: "y\n".repeat(100),
    });
    if (licenses.code !== 0) throw toolFailure("sdkmanager --licenses", licenses);
  }
  // Without --accept-licenses sdkmanager asks on this terminal, which `attach` hands it.
  const code = await deps.runner.attach(plan.sdkmanager, [root, ...plan.missingPackages], { env });
  if (code !== 0) {
    throw new BoardError(
      `sdkmanager failed (exit ${code}); its output is above. ${JAVA_HINT} ` +
        `If you declined a licence, run again and accept it.`,
    );
  }
}

async function createAvd(plan: SetupPlan, deps: SetupDeps) {
  // `no` answers "Do you wish to create a custom hardware profile?".
  const created = await deps.runner.run(
    plan.avdmanager,
    ["create", "avd", "-n", plan.avd, "-k", plan.image, "-d", plan.device],
    { env: sdkEnv(plan), input: "no\n" },
  );
  if (created.code !== 0) throw toolFailure("avdmanager create avd", created);
  const dir = avdDirectory(plan.avd, deps.env);
  if (dir === null) {
    throw new BoardError(`avdmanager created ${plan.avd} but its folder was not found`);
  }
  // avdmanager may write `hw.ramSize=2G`, which the low-RAM check reads as 2 MB (docs/android.md).
  const config = joinHostPath(deps.host, dir, "config.ini");
  const text = await Deno.readTextFile(config).catch(() => "");
  const line = `hw.ramSize=${plan.ram}`;
  await Deno.writeTextFile(
    config,
    /^hw\.ramSize\s*=.*$/m.test(text)
      ? text.replace(/^hw\.ramSize\s*=.*$/m, line)
      : `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`,
  );
}

/**
 * Run (or, with `dryRun`, only print) the setup steps. Steps whose result is already on disk are
 * skipped, so running it again is safe. Throws a BoardError, with what to do, when a step fails.
 */
export async function runSetup(options: SetupOptions, deps: SetupDeps): Promise<SetupPlan> {
  const plan = planSetup(options, deps);
  const { log } = deps;
  const dry = options.dryRun === true;
  const needsLicenses = plan.missingPackages.length > 0;
  if (!dry && needsLicenses && !options.acceptLicenses && !deps.interactive) {
    throw new BoardError(
      `android setup: sdkmanager asks you to accept Google's Android SDK licences, and this ` +
        `terminal cannot answer. Run it again with --accept-licenses to accept them ` +
        `(https://developer.android.com/studio/terms), or run it in a terminal.`,
    );
  }
  log(`${dry ? "[dry run] " : ""}Android SDK: ${plan.sdk} (from ${plan.sdkSource})`);

  if (plan.cmdlineToolsInstalled) {
    log(`[1/4] command-line tools: already in ${plan.latest}, skipped`);
  } else {
    log(`[1/4] command-line tools: ${dry ? "would download" : "downloading"} ${plan.zip.url}`);
    if (dry) log(`      then check its sha256 and unpack it to ${plan.latest}`);
    else await installCommandLineTools(plan, deps);
  }

  if (!needsLicenses) {
    log(`[2/4] platform-tools, emulator and ${plan.image}: already installed, skipped`);
  } else {
    const how = options.acceptLicenses
      ? "licences accepted because of --accept-licenses"
      : "sdkmanager asks you to accept the licences";
    log(`[2/4] sdkmanager installs ${plan.missingPackages.join(", ")} (${how})`);
    if (!dry) await installPackages(plan, options, deps);
  }

  if (plan.avdExists) {
    log(`[3/4] AVD ${plan.avd}: already exists, skipped`);
  } else {
    log(`[3/4] avdmanager creates the AVD ${plan.avd} (${plan.device}, ${plan.ram} MB of RAM)`);
    if (!dry) await createAvd(plan, deps);
  }

  if (dry) {
    log(`[4/4] would check hardware acceleration`);
  } else {
    const accel = await checkHardwareAcceleration(deps.host, deps.runner, plan.emulator);
    if (!accel.ok) {
      throw new BoardError(
        `everything is installed, but ${accel.message}\nFix that and run android setup again; it skips what is done.`,
      );
    }
    log(`[4/4] hardware acceleration: ${accel.accelerator}`);
  }

  // A run looks for the SDK in the two variables and the default location, never in --sdk.
  if (plan.sdk !== setupSdkRoot(deps.host).sdk) {
    log(`Set ANDROID_HOME to ${plan.sdk} so ${PRODUCT.displayName} finds it.`);
  }
  log(`${dry ? "Then run" : "Next"}: ${PRODUCT.cli} android prepare ${plan.avd}`);
  return plan;
}

/** Fetches a URL into memory. Needs network permission, which `deno task hertzbench` lacks. */
// ponytail: whole zip in memory (~180 MB), fine for one download; stream to disk if it grows.
export async function fetchBytes(url: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    if (error instanceof Deno.errors.NotCapable) {
      throw new BoardError(
        `no network permission to download ${url}. Use the release binary, or run it with ` +
          `deno's --allow-net, or download the zip yourself as docs/android.md describes.`,
      );
    }
    throw new BoardError(`could not download ${url}: ${(error as Error).message}`);
  }
  if (!response.ok) throw new BoardError(`${url} answered ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** The real runner: starts real commands. A tool that is not installed answers exit 127. */
export const setupRunner: SetupRunner = {
  async run(cmd, args, opts = {}) {
    const controller = new AbortController();
    const timer = opts.timeoutMs === undefined
      ? undefined
      : setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const child = new Deno.Command(cmd, {
        args,
        env: opts.env,
        stdin: opts.input === undefined ? "null" : "piped",
        stdout: "piped",
        stderr: "piped",
        signal: controller.signal,
      }).spawn();
      if (opts.input !== undefined) {
        const writer = child.stdin.getWriter();
        try {
          await writer.write(new TextEncoder().encode(opts.input));
          await writer.close();
        } catch {
          // The tool stopped reading early; its exit code says whether that was fine.
        }
      }
      const out = await child.output();
      const text = new TextDecoder();
      return { code: out.code, stdout: text.decode(out.stdout), stderr: text.decode(out.stderr) };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return { code: 127, stdout: "", stderr: `${cmd}: command not found` };
      }
      if (controller.signal.aborted) {
        return { code: 124, stdout: "", stderr: `timed out after ${opts.timeoutMs} ms` };
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  },
  async attach(cmd, args, opts = {}) {
    try {
      const out = await new Deno.Command(cmd, {
        args,
        env: opts.env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }).output();
      return out.code;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        console.error(`${cmd}: command not found`);
        return 127;
      }
      throw error;
    }
  },
};
