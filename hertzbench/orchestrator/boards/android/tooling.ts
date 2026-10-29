// The Android SDK tools a node of kind `android` needs (docs/android-device-plan.md,
// section 1): find `emulator` and `adb`, list AVDs, check KVM, boot an AVD headless,
// install and launch an app, stream logcat, stop the emulator. Every step that can
// hang has its own timeout and a timeout error names the step. No scenario or
// runner code lives here; the board launcher of the next piece composes these.

import { delimiter, join } from "node:path";
import { BoardError } from "../board.ts";

/** The steps that have a timeout, as a timeout or failure message names them. */
export type AndroidStep =
  | "boot"
  | "install"
  | "launch"
  | "intent"
  | "instrument"
  | "logcat"
  | "snapshot"
  | "stop"
  | "tool";

/** A step of the Android lifecycle failed or ran out of time. */
export class AndroidStepError extends BoardError {
  override name = "AndroidStepError";
  constructor(readonly step: AndroidStep, message: string) {
    super(message);
  }
}

/** Default bounds from the plan: 120 s is four times the 29-31 s cold boot measured on pixel8. */
export const DEFAULT_TIMEOUTS: { bootMs: number; installMs: number; launchMs: number } = {
  bootMs: 120_000,
  installMs: 60_000,
  launchMs: 20_000,
};

const TOOL_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 10_000;
const BOOT_POLL_MS = 1000;
const LOG_TAIL_LINES = 20;
/** Console ports the emulator takes in pairs (console, adb): 5554, 5556, ... */
export const FIRST_CONSOLE_PORT = 5554;
export const LAST_CONSOLE_PORT = 5682;

/** The flags every headless launch uses (plan section 1, step 2). */
const HEADLESS_FLAGS = [
  "-no-window",
  "-no-audio",
  "-no-boot-anim",
  "-read-only",
  "-no-snapshot-save",
  "-gpu",
  "swiftshader_indirect",
];

/**
 * The same flags for `android prepare`. A snapshot cannot be saved under `-read-only`, and the
 * AVD's own `default_boot` snapshot must not be what the guest starts from: the snapshot saved
 * has to come from a boot with the run's flags.
 */
const PREPARE_FLAGS = HEADLESS_FLAGS.flatMap((flag) =>
  flag === "-read-only" ? [] : flag === "-no-snapshot-save" ? ["-no-snapshot-load", flag] : [flag]
);

/** The snapshot `android prepare` saves in the AVD; never `default_boot`, which is the person's own. */
export const PREPARED_SNAPSHOT = "hertzbench";
const SNAPSHOT_MARKER = "hertzbench.json";
const SNAPSHOT_SAVE_TIMEOUT_MS = 120_000;

/**
 * `-feature -WiFiPacketStream` makes the guest's virtio Wi-Fi a plain socket netdev; without it
 * netsim owns Wi-Fi and the socket stays silent. It is an undocumented emulator feature flag.
 * A snapshot saved without these flags would reload with netsim's Wi-Fi.
 */
export function wifiSocketArgs(netPort: number): string[] {
  return ["-feature", "-WiFiPacketStream", "-wifi-socket", `connect=127.0.0.1:${netPort}`];
}

/**
 * Boot the prepared snapshot and give the guest's `wlan0` the node's MAC. `-force-snapshot-load`
 * makes the emulator exit when the snapshot cannot be loaded, instead of cold-booting with the
 * AVD's own MAC, which the medium would not know.
 */
export function snapshotBootArgs(mac: string): string[] {
  return ["-snapshot", PREPARED_SNAPSHOT, "-force-snapshot-load", "-wifi-mac-address", mac];
}

export interface AndroidTools {
  emulator: string;
  adb: string;
}

const exe = (name: string): string => Deno.build.os === "windows" ? `${name}.exe` : name;

function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

/**
 * Find `emulator` and `adb`: PATH first, then $ANDROID_HOME, $ANDROID_SDK_ROOT and ~/Android.
 * Throws a BoardError that lists where it looked.
 */
export function findAndroidTools(
  env: (name: string) => string | undefined = (name) => Deno.env.get(name),
): AndroidTools {
  const searched: string[] = [];
  const sdkRoots = [env("ANDROID_HOME"), env("ANDROID_SDK_ROOT")];
  const home = env("HOME") ?? env("USERPROFILE");
  if (home) sdkRoots.push(join(home, "Android"));
  const find = (name: string, sdkSubdir: string): string | undefined => {
    const candidates = (env("PATH") ?? "").split(delimiter).filter((dir) => dir !== "")
      .map((dir) => join(dir, exe(name)));
    for (const root of sdkRoots) if (root) candidates.push(join(root, sdkSubdir, exe(name)));
    for (const candidate of candidates) {
      if (isFile(candidate)) return candidate;
    }
    searched.push(name);
    return undefined;
  };
  const emulator = find("emulator", "emulator");
  const adb = find("adb", "platform-tools");
  if (!emulator || !adb) {
    throw new BoardError(
      `${searched.join(" and ")} not found on PATH, in $ANDROID_HOME, $ANDROID_SDK_ROOT or ` +
        `~/Android. Install the Android SDK emulator and platform-tools and set ANDROID_HOME.`,
    );
  }
  return { emulator, adb };
}

interface CommandResult {
  success: boolean;
  code: number;
  text: string;
}

/**
 * Run a tool to completion within `timeoutMs`. On expiry the process is killed and an
 * AndroidStepError names `step`; the pipes are not awaited, a grandchild may hold them.
 */
async function runBounded(
  step: AndroidStep,
  program: string,
  args: string[],
  timeoutMs: number,
  what: string,
): Promise<CommandResult> {
  const child = new Deno.Command(program, { args, stdout: "piped", stderr: "piped" }).spawn();
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  output.catch(() => {}); // abandoned on timeout; nothing is left to report there
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = Symbol("expired");
  const winner = await Promise.race([
    child.status,
    new Promise<typeof expired>((resolve) => {
      timer = setTimeout(() => resolve(expired), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (winner === expired) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited between the race and the kill
    }
    throw new AndroidStepError(step, `${what} timed out after ${timeoutMs} ms (step: ${step})`);
  }
  const [stdout, stderr] = await output;
  return { success: winner.success, code: winner.code, text: `${stdout}${stderr}`.trim() };
}

/** `adb shell` joins its arguments into one line for the device's shell: quote what is not ours. */
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Intent extras as `--es key value` arguments. */
const extraArgs = (extras: Record<string, string> = {}): string[] =>
  Object.entries(extras).flatMap(([key, value]) => ["--es", key, shellQuote(value)]);

/** Feed `onLine` each non-empty line of `stream` as it arrives; a read error ends it quietly. */
async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  let pending = "";
  const decoder = new TextDecoder();
  try {
    for await (const chunk of stream) {
      const lines = (pending + decoder.decode(chunk, { stream: true })).split(/\r?\n/);
      pending = lines.pop()!;
      lines.filter((line) => line !== "").forEach(onLine);
    }
  } catch {
    // the process was killed; the lines read so far were delivered
  }
  if (pending !== "") onLine(pending);
}

/** `emulator -list-avds`: the AVD names, one per line of output. */
export async function listAvds(emulator: string): Promise<string[]> {
  const result = await runBounded(
    "tool",
    emulator,
    ["-list-avds"],
    TOOL_TIMEOUT_MS,
    "listing AVDs",
  );
  if (!result.success) {
    throw new AndroidStepError("tool", `emulator -list-avds failed: ${result.text}`);
  }
  // The emulator may print INFO lines beside the names; AVD names have no spaces.
  return result.text.split(/\r?\n/).map((line) => line.trim()).filter((line) =>
    line !== "" && !/\s/.test(line)
  );
}

/** `emulator -version`, e.g. "37.1.11.0 (build_id 15917651)"; the plan pins the version it was checked with. */
export async function emulatorVersion(emulator: string): Promise<string> {
  const result = await runBounded(
    "tool",
    emulator,
    ["-version"],
    TOOL_TIMEOUT_MS,
    "emulator -version",
  );
  const match = /Android emulator version (.+)/.exec(result.text);
  if (!match) throw new AndroidStepError("tool", `unexpected emulator -version: ${result.text}`);
  return match[1]!.trim();
}

/**
 * Whether /dev/kvm can be opened for read and write; null when it can, else the reason. Also
 * null when Deno's own permissions forbid the look: it demands --allow-all for any device
 * node, which the CLI's task never has. The emulator then answers for itself: it exits at
 * once without acceleration and the boot step quotes its log.
 */
export function kvmProblem(device = "/dev/kvm"): string | null {
  if (Deno.build.os !== "linux") {
    return `hardware acceleration for the emulator is only wired for Linux (KVM); this is ${Deno.build.os}`;
  }
  try {
    Deno.openSync(device, { read: true, write: true }).close();
    return null;
  } catch (error) {
    if (error instanceof Deno.errors.NotCapable) return null;
    return `${device} is not usable: ${(error as Error).message}. ` +
      `Enable virtualization and add your user to the kvm group.`;
  }
}

/** Whether a console port pair (console, adb) can be opened on loopback. */
export function consolePortFree(port: number): boolean {
  try {
    Deno.listen({ hostname: "127.0.0.1", port }).close();
    Deno.listen({ hostname: "127.0.0.1", port: port + 1 }).close();
    return true;
  } catch {
    // taken by another emulator or adb server
    return false;
  }
}

/**
 * Console ports handed out and not yet given back by `kill()`. A launched emulator binds its port
 * a moment after it starts, and boards start in parallel, so two picks in that moment would see the
 * same port free and boot two emulators on one serial.
 */
const claimedPorts = new Set<number>();

/** The first even console port in 5554..5682 whose pair of ports is free on loopback and unclaimed. */
export function pickConsolePort(): number {
  for (let port = FIRST_CONSOLE_PORT; port <= LAST_CONSOLE_PORT; port += 2) {
    if (!claimedPorts.has(port) && consolePortFree(port)) {
      claimedPorts.add(port);
      return port;
    }
  }
  throw new BoardError(
    `no free emulator console port in ${FIRST_CONSOLE_PORT}..${LAST_CONSOLE_PORT}`,
  );
}

export interface EmulatorOptions {
  avd: string;
  /** Even console port; defaults to a free one. */
  port?: number;
  /** Flags after the headless set, e.g. the Wi-Fi socket flags. */
  extraArgs?: string[];
  /** Cold boot without `-read-only`, so a snapshot can be saved (`android prepare`). */
  writable?: boolean;
}

export class RunningEmulator {
  readonly serial: string;
  private readonly tail: string[] = [];
  private readonly drained: Promise<unknown>;
  private exited = false;

  constructor(
    private readonly tools: AndroidTools,
    private readonly child: Deno.ChildProcess,
    readonly port: number,
  ) {
    this.serial = `emulator-${port}`;
    this.child.status.then(() => this.exited = true, () => this.exited = true);
    this.drained = Promise.all([this.collect(child.stdout), this.collect(child.stderr)]);
  }

  private async collect(stream: ReadableStream<Uint8Array>): Promise<void> {
    let pending = "";
    const decoder = new TextDecoder();
    const keep = (line: string) => {
      this.tail.push(line);
      if (this.tail.length > LOG_TAIL_LINES) this.tail.shift();
    };
    try {
      for await (const chunk of stream) {
        const lines = (pending + decoder.decode(chunk, { stream: true })).split(/\r?\n/);
        pending = lines.pop()!;
        lines.forEach(keep);
      }
    } catch {
      // the pipe closes when the process dies; the tail already holds what it said
    }
    if (pending !== "") keep(pending);
  }

  /** The last 20 lines the emulator printed, for a failure message. */
  logTail(): string {
    return this.tail.join("\n");
  }

  hasExited(): boolean {
    return this.exited;
  }

  /**
   * Poll `getprop sys.boot_completed` until it is 1, then `adb wait-for-device`, all within
   * `timeoutMs`. Fails early, with the emulator's last lines, if the process dies.
   */
  async waitForBoot(timeoutMs = DEFAULT_TIMEOUTS.bootMs, pollMs = BOOT_POLL_MS): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    const timedOut = () =>
      new AndroidStepError(
        "boot",
        `${this.serial} did not reach sys.boot_completed=1 within ${timeoutMs} ms (step: boot). ` +
          `Emulator log tail:\n${this.logTail()}`,
      );
    const remaining = () => deadline - performance.now();
    for (;;) {
      if (this.exited) {
        throw new AndroidStepError(
          "boot",
          `the emulator exited before ${this.serial} booted (step: boot). Log tail:\n${this.logTail()}`,
        );
      }
      if (remaining() <= 0) throw timedOut();
      try {
        const result = await runBounded(
          "boot",
          this.tools.adb,
          ["-s", this.serial, "shell", "getprop", "sys.boot_completed"],
          Math.max(1, remaining()),
          "getprop sys.boot_completed",
        );
        if (result.success && result.text === "1") break;
      } catch (error) {
        if (!(error instanceof AndroidStepError)) throw error;
        throw timedOut();
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(pollMs, Math.max(1, remaining())))
      );
    }
    try {
      await runBounded(
        "boot",
        this.tools.adb,
        ["-s", this.serial, "wait-for-device"],
        Math.max(1, remaining()),
        "adb wait-for-device",
      );
    } catch (error) {
      if (error instanceof AndroidStepError) throw timedOut();
      throw error;
    }
  }

  /** `adb install -r -t`; a failure quotes adb's own output. */
  async install(apk: string, timeoutMs = DEFAULT_TIMEOUTS.installMs): Promise<void> {
    const result = await runBounded(
      "install",
      this.tools.adb,
      ["-s", this.serial, "install", "-r", "-t", apk],
      timeoutMs,
      `installing ${apk}`,
    );
    if (!result.success || !/\bSuccess\b/.test(result.text)) {
      throw new AndroidStepError(
        "install",
        `installing ${apk} failed (step: install), adb said:\n${result.text}`,
      );
    }
  }

  /**
   * `am start -W`, which returns once the activity is displayed. Without an activity the
   * package's launcher activity starts. `extras` become `--es key value`.
   */
  async launch(
    app: { package: string; activity?: string; extras?: Record<string, string> },
    timeoutMs = DEFAULT_TIMEOUTS.launchMs,
  ): Promise<void> {
    const target = app.activity !== undefined ? ["-n", `${app.package}/${app.activity}`] : [
      "-a",
      "android.intent.action.MAIN",
      "-c",
      "android.intent.category.LAUNCHER",
      "-p",
      app.package,
    ];
    const result = await runBounded(
      "launch",
      this.tools.adb,
      ["-s", this.serial, "shell", "am", "start", "-W", ...target, ...extraArgs(app.extras)],
      timeoutMs,
      `starting ${app.package}`,
    );
    // `am start` exits 0 on "Error: Activity class ... does not exist"; its text is the verdict.
    if (!result.success || /^Error/m.test(result.text)) {
      throw new AndroidStepError(
        "launch",
        `starting ${app.package} failed (step: launch), adb said:\n${result.text}`,
      );
    }
  }

  /**
   * `am broadcast` or `am start` of `intent.action`, limited to `app.package` so a test hook cannot
   * reach another app (and a manifest receiver gets a broadcast at all, since API 26). It returns
   * once the system has taken the intent, not once the app has handled it.
   */
  async sendIntent(
    app: { package: string },
    intent: { via: "broadcast" | "start"; action: string; extras?: Record<string, string> },
    timeoutMs = DEFAULT_TIMEOUTS.launchMs,
  ): Promise<void> {
    const result = await runBounded(
      "intent",
      this.tools.adb,
      [
        "-s",
        this.serial,
        "shell",
        "am",
        intent.via,
        "-a",
        shellQuote(intent.action),
        "-p",
        shellQuote(app.package),
        ...extraArgs(intent.extras),
      ],
      timeoutMs,
      `${intent.via} of ${intent.action}`,
    );
    // Like `am start`, `am broadcast` exits 0 on "Error: ..." and on a thrown exception.
    if (!result.success || /^(Error|Exception)\b/m.test(result.text)) {
      throw new AndroidStepError(
        "intent",
        `${intent.via} of ${intent.action} to ${app.package} failed (step: intent), adb said:\n${result.text}`,
      );
    }
  }

  /**
   * `am instrument -w -r <runner>` with its output streamed line by line to `onLine` while the
   * tests run. `done` settles with adb's exit code when instrumentation ends; `stop()` ends it
   * early and resolves once the output is drained.
   */
  instrument(
    runner: string,
    onLine: (line: string) => void,
  ): { done: Promise<number>; stop(): Promise<void> } {
    const child = new Deno.Command(this.tools.adb, {
      args: ["-s", this.serial, "shell", "am", "instrument", "-w", "-r", shellQuote(runner)],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const reading = Promise.all([readLines(child.stdout, onLine), readLines(child.stderr, onLine)]);
    const done = child.status.then(async (status) => {
      await reading;
      return status.code;
    });
    return {
      done,
      async stop() {
        try {
          child.kill("SIGKILL");
        } catch {
          // already exited
        }
        await done;
      },
    };
  }

  /**
   * Clear the log, then stream `logcat -v raw -s <tag>:V...` to `onLine`. Start it before
   * `launch` so the app's first lines are kept. `stop()` ends the stream.
   */
  async logcat(
    tags: string[],
    onLine: (line: string) => void,
  ): Promise<{ stop(): Promise<void> }> {
    const clear = await runBounded(
      "logcat",
      this.tools.adb,
      ["-s", this.serial, "logcat", "-c"],
      TOOL_TIMEOUT_MS,
      "adb logcat -c",
    );
    if (!clear.success) {
      throw new AndroidStepError("logcat", `adb logcat -c failed: ${clear.text}`);
    }
    const child = new Deno.Command(this.tools.adb, {
      args: ["-s", this.serial, "logcat", "-v", "raw", "-s", ...tags.map((tag) => `${tag}:V`)],
      stdout: "piped",
      stderr: "null",
    }).spawn();
    const reading = readLines(child.stdout, onLine);
    return {
      async stop() {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        await reading;
      },
    };
  }

  /**
   * `adb emu avd snapshot save <name>`. The console answers `OK`, or `KO: <reason>` with exit
   * status 0, so the text is the verdict.
   */
  async saveSnapshot(name: string, timeoutMs = SNAPSHOT_SAVE_TIMEOUT_MS): Promise<void> {
    const result = await runBounded(
      "snapshot",
      this.tools.adb,
      ["-s", this.serial, "emu", "avd", "snapshot", "save", name],
      timeoutMs,
      `saving snapshot ${name}`,
    );
    if (!result.success || /^KO/m.test(result.text) || !/^OK/m.test(result.text)) {
      throw new AndroidStepError(
        "snapshot",
        `saving snapshot ${name} failed (step: snapshot), the emulator said:\n${result.text}`,
      );
    }
  }

  /** `adb emu kill`, then up to 10 s for the process, then SIGKILL. Safe to call twice. */
  async kill(): Promise<void> {
    if (!this.exited) {
      try {
        await runBounded(
          "stop",
          this.tools.adb,
          ["-s", this.serial, "emu", "kill"],
          STOP_GRACE_MS,
          "adb emu kill",
        );
      } catch (error) {
        if (!(error instanceof AndroidStepError)) throw error;
        // fall through to the signal below
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.child.status.catch(() => {}),
        new Promise((resolve) => timer = setTimeout(resolve, STOP_GRACE_MS)),
      ]);
      clearTimeout(timer);
      if (!this.exited) {
        try {
          this.child.kill("SIGKILL");
        } catch {
          // exited just now
        }
      }
    }
    await this.child.status.catch(() => {});
    await this.drained;
    claimedPorts.delete(this.port);
  }
}

/** Start the AVD headless with the flags of the plan; returns before it has booted. */
export function launchEmulator(tools: AndroidTools, options: EmulatorOptions): RunningEmulator {
  const port = options.port ?? pickConsolePort();
  claimedPorts.add(port);
  const child = new Deno.Command(tools.emulator, {
    args: [
      "-avd",
      options.avd,
      ...(options.writable ? PREPARE_FLAGS : HEADLESS_FLAGS),
      "-port",
      String(port),
      ...(options.extraArgs ?? []),
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  return new RunningEmulator(tools, child, port);
}

type EnvReader = (name: string) => string | undefined;
const processEnv: EnvReader = (name) => Deno.env.get(name);

function isDirectory(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}

/**
 * The directory of an AVD (`<name>.avd`): the emulator's own lookup, `$ANDROID_AVD_HOME`, then
 * `$ANDROID_USER_HOME/avd`, then `~/.android/avd`, where `<name>.ini` points at it.
 */
export function avdDirectory(avd: string, env: EnvReader = processEnv): string | null {
  const home = env("HOME") ?? env("USERPROFILE");
  const roots = [
    env("ANDROID_AVD_HOME"),
    env("ANDROID_USER_HOME") ? join(env("ANDROID_USER_HOME")!, "avd") : undefined,
    home ? join(home, ".android", "avd") : undefined,
  ];
  for (const root of roots) {
    if (!root) continue;
    let dir = join(root, `${avd}.avd`);
    try {
      const pointed = /^path=(.+)$/m.exec(Deno.readTextFileSync(join(root, `${avd}.ini`)));
      if (pointed) dir = pointed[1]!.trim();
    } catch {
      // no .ini here: the conventional <name>.avd next to it is still a candidate
    }
    if (isDirectory(dir)) return dir;
  }
  return null;
}

/** A prepared snapshot a run may boot, or why it may not. */
export type PreparedSnapshot = { usable: true } | { usable: false; reason: string };

/**
 * Whether `avd` holds the snapshot `android prepare` saved, made by this emulator build. Snapshots
 * are tied to the emulator version, and the marker `prepare` writes beside the snapshot's files is
 * how a build that differs is told apart before it costs a boot.
 */
export function preparedSnapshot(
  avd: string,
  emulatorVersion: string,
  env: EnvReader = processEnv,
): PreparedSnapshot {
  const again = `run \`hertzbench android prepare ${avd}\``;
  const dir = avdDirectory(avd, env);
  if (dir === null) return { usable: false, reason: `no directory found for the AVD ${avd}` };
  let marker: { emulator?: unknown };
  try {
    marker = JSON.parse(
      Deno.readTextFileSync(join(dir, "snapshots", PREPARED_SNAPSHOT, SNAPSHOT_MARKER)),
    );
  } catch {
    return { usable: false, reason: `${avd} has no prepared snapshot; ${again}` };
  }
  if (marker.emulator !== emulatorVersion) {
    return {
      usable: false,
      reason: `${avd}'s snapshot was prepared with emulator ${marker.emulator}, this is ` +
        `${emulatorVersion}; ${again}`,
    };
  }
  return { usable: true };
}

export interface PrepareOptions {
  /** Replaces the /dev/kvm check; tests on hosts without KVM pass `() => null`. */
  checkKvm?: () => string | null;
  bootTimeoutMs?: number;
  env?: EnvReader;
}

/**
 * Boot `avd` once with the flags a run uses, wait for it, save the snapshot `run`s boot from
 * (`snapshot: true`), and stop it. The guest's Wi-Fi socket is a netdev that needs a peer to
 * connect to, so a loopback listener that discards what it receives stands in for the medium.
 * Replaces an earlier snapshot of the same name. Returns the emulator version it was made with.
 */
export async function prepareSnapshot(
  tools: AndroidTools,
  avd: string,
  options: PrepareOptions = {},
): Promise<{ snapshotDir: string; emulatorVersion: string }> {
  const kvm = (options.checkKvm ?? kvmProblem)();
  if (kvm !== null) throw new BoardError(kvm);
  const avds = await listAvds(tools.emulator);
  if (!avds.includes(avd)) {
    throw new BoardError(
      `no AVD named ${avd} (found: ${avds.join(", ") || "none"}). ` +
        `Hertzbench never creates one; make it in Android Studio or with avdmanager.`,
    );
  }
  const dir = avdDirectory(avd, options.env);
  if (dir === null) throw new BoardError(`no directory found for the AVD ${avd}`);
  const version = await emulatorVersion(tools.emulator);

  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const connections = new Set<Deno.Conn>();
  const accepting = (async () => {
    try {
      for await (const conn of listener) {
        connections.add(conn);
        conn.readable.pipeTo(new WritableStream()).catch(() => {}); // frames nobody answers
      }
    } catch {
      // closed below, once the emulator is gone
    }
  })();
  const emulator = launchEmulator(tools, {
    avd,
    writable: true,
    extraArgs: wifiSocketArgs((listener.addr as Deno.NetAddr).port),
  });
  try {
    await emulator.waitForBoot(options.bootTimeoutMs);
    const snapshotDir = join(dir, "snapshots", PREPARED_SNAPSHOT);
    // A failed save must not leave the old marker vouching for a half-written snapshot.
    await Deno.remove(join(snapshotDir, SNAPSHOT_MARKER)).catch(() => {});
    await emulator.saveSnapshot(PREPARED_SNAPSHOT);
    try {
      await Deno.writeTextFile(
        join(snapshotDir, SNAPSHOT_MARKER),
        `${JSON.stringify({ emulator: version })}\n`,
      );
    } catch (error) {
      throw new AndroidStepError(
        "snapshot",
        `the emulator saved snapshot ${PREPARED_SNAPSHOT}, but ${snapshotDir} is not where ` +
          `Hertzbench looks for it (step: snapshot): ${(error as Error).message}`,
      );
    }
    return { snapshotDir, emulatorVersion: version };
  } finally {
    await emulator.kill();
    listener.close();
    for (const conn of connections) {
      try {
        conn.close();
      } catch {
        // the emulator's end closed it first
      }
    }
    await accepting;
  }
}
