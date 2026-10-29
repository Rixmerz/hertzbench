// The Android SDK tools a node of kind `android` needs (docs/android-device-plan.md,
// section 1): find `emulator` and `adb`, list AVDs, check KVM, boot an AVD headless,
// install and launch an app, stream logcat, stop the emulator. Every step that can
// hang has its own timeout and a timeout error names the step. No scenario or
// runner code lives here; the board launcher of the next piece composes these.

import { delimiter, join } from "node:path";
import { BoardError } from "../board.ts";

/** The steps that have a timeout, as a timeout or failure message names them. */
export type AndroidStep = "boot" | "install" | "launch" | "logcat" | "stop" | "tool";

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
const FIRST_CONSOLE_PORT = 5554;
const LAST_CONSOLE_PORT = 5682;

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

/** Whether /dev/kvm can be opened for read and write; null when it can, else the reason. */
export function kvmProblem(device = "/dev/kvm"): string | null {
  if (Deno.build.os !== "linux") {
    return `hardware acceleration for the emulator is only wired for Linux (KVM); this is ${Deno.build.os}`;
  }
  try {
    Deno.openSync(device, { read: true, write: true }).close();
    return null;
  } catch (error) {
    return `${device} is not usable: ${(error as Error).message}. ` +
      `Enable virtualization and add your user to the kvm group.`;
  }
}

/** The first even console port in 5554..5682 whose pair of ports is free on loopback. */
export function pickConsolePort(): number {
  for (let port = FIRST_CONSOLE_PORT; port <= LAST_CONSOLE_PORT; port += 2) {
    try {
      Deno.listen({ hostname: "127.0.0.1", port }).close();
      Deno.listen({ hostname: "127.0.0.1", port: port + 1 }).close();
      return port;
    } catch {
      // taken by another emulator or adb server; try the next pair
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
  /** Flags after the headless set, e.g. the Wi-Fi socket flags of the next piece. */
  extraArgs?: string[];
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
    const extras = Object.entries(app.extras ?? {}).flatMap(([key, value]) => ["--es", key, value]);
    const result = await runBounded(
      "launch",
      this.tools.adb,
      ["-s", this.serial, "shell", "am", "start", "-W", ...target, ...extras],
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
    const reading = (async () => {
      let pending = "";
      const decoder = new TextDecoder();
      try {
        for await (const chunk of child.stdout) {
          const lines = (pending + decoder.decode(chunk, { stream: true })).split(/\r?\n/);
          pending = lines.pop()!;
          lines.filter((line) => line !== "").forEach(onLine);
        }
      } catch {
        // killed by stop(); the lines read so far were delivered
      }
      if (pending !== "") onLine(pending);
    })();
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
  }
}

/** Start the AVD headless with the flags of the plan; returns before it has booted. */
export function launchEmulator(tools: AndroidTools, options: EmulatorOptions): RunningEmulator {
  const port = options.port ?? pickConsolePort();
  const child = new Deno.Command(tools.emulator, {
    args: [
      "-avd",
      options.avd,
      ...HEADLESS_FLAGS,
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
