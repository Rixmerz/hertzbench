// `hertzbench android setup`: where the SDK goes on each OS, the plan of steps (what --dry-run
// prints), and that running it twice does the work once. The tools are fakes: a runner that
// records its calls and writes what the real tools would leave behind, and a downloader that never
// touches the network. The SDK and AVD folders are real temp dirs.

import { join, posix } from "node:path";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { androidCommand } from "../cli/android.ts";
import {
  commandLineToolsZip,
  defaultImage,
  type SetupDeps,
  type SetupRunner,
  setupSdkRoot,
} from "../orchestrator/boards/android/setup.ts";
import { fakeHostEnv } from "./android_fake_sdk.ts";

const IMAGE_X86 = "system-images;android-36;google_apis;x86_64";

Deno.test("android setup: the SDK root is --sdk, then ANDROID_HOME, then ANDROID_SDK_ROOT, then the OS default", () => {
  const linux = fakeHostEnv("linux");
  assertEquals(setupSdkRoot(linux).sdk, "/home/tester/Android/Sdk");
  assertEquals(setupSdkRoot(fakeHostEnv("darwin")).sdk, "/Users/tester/Library/Android/sdk");
  assertEquals(
    setupSdkRoot(fakeHostEnv("windows")).sdk,
    "C:\\Users\\tester\\AppData\\Local\\Android\\Sdk",
  );
  const both = fakeHostEnv("linux", { env: { ANDROID_HOME: "/a", ANDROID_SDK_ROOT: "/b" } });
  assertEquals(setupSdkRoot(both), { sdk: "/a", source: "ANDROID_HOME" });
  const rootOnly = fakeHostEnv("linux", { env: { ANDROID_SDK_ROOT: "/b" } });
  assertEquals(setupSdkRoot(rootOnly), { sdk: "/b", source: "ANDROID_SDK_ROOT" });
  assertEquals(setupSdkRoot(both, "/flag"), { sdk: "/flag", source: "--sdk" });
  // Unlike the tool lookup of a run, a root that does not exist yet is still the answer.
  assertEquals(setupSdkRoot(fakeHostEnv("linux", { env: { ANDROID_HOME: "/nope" } })).sdk, "/nope");
});

Deno.test("android setup: the download is Google's zip for the host, and the image fits the CPU", () => {
  const urls = new Set<string>();
  for (
    const host of [
      fakeHostEnv("linux"),
      fakeHostEnv("windows"),
      fakeHostEnv("darwin", { arch: "x86_64" }),
      fakeHostEnv("darwin", { arch: "aarch64" }),
    ]
  ) {
    const zip = commandLineToolsZip(host);
    assert(zip.url.startsWith("https://dl.google.com/android/repository/commandlinetools-"));
    assert(zip.url.endsWith("_latest.zip"));
    assert(/^[0-9a-f]{64}$/.test(zip.sha256));
    urls.add(zip.url);
  }
  assertEquals(urls.size, 4);
  assertStringIncludes(commandLineToolsZip(fakeHostEnv("windows")).url, "-win-");
  assertStringIncludes(
    commandLineToolsZip(fakeHostEnv("darwin", { arch: "aarch64" })).url,
    "mac_arm64",
  );
  assertEquals(defaultImage(fakeHostEnv("linux", { arch: "x86_64" })), IMAGE_X86);
  assertEquals(
    defaultImage(fakeHostEnv("darwin", { arch: "aarch64" })),
    "system-images;android-36;google_apis;arm64-v8a",
  );
});

/** What a run of `androidCommand` printed. */
async function captured<T>(body: () => Promise<T>) {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  console.log = (...args: unknown[]) => void out.push(args.join(" "));
  console.error = (...args: unknown[]) => void err.push(args.join(" "));
  try {
    return { result: await body(), out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

const sha256 = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");

/** A machine with an empty SDK folder and AVD folder, and fakes for every tool setup starts. */
async function fakeMachine(
  options: { interactive?: boolean; accelOutput?: string; avdmanagerFails?: boolean } = {},
) {
  const root = await Deno.makeTempDir({ prefix: "hzb-setup-" });
  const sdk = join(root, "Sdk");
  const avdHome = join(root, "avd");
  await Deno.mkdir(avdHome);
  const zipBytes = new TextEncoder().encode("not really a zip");
  const calls: { cmd: string; args: string[]; input?: string; attached?: boolean }[] = [];
  let downloads: string[] = [];
  const host = fakeHostEnv("darwin", { arch: "aarch64" });
  const runner: SetupRunner = {
    run(cmd, args, opts) {
      calls.push({ cmd, args, input: opts?.input });
      const done = (stdout = "", code = 0) => Promise.resolve({ code, stdout, stderr: "" });
      if (cmd === "unzip") {
        // What Google's zip holds: a cmdline-tools folder with bin/sdkmanager and bin/avdmanager.
        const bin = join(args.at(-1)!, "cmdline-tools", "bin");
        Deno.mkdirSync(bin, { recursive: true });
        Deno.writeTextFileSync(join(bin, "sdkmanager"), "");
        Deno.writeTextFileSync(join(bin, "avdmanager"), "");
        return done();
      }
      if (cmd.endsWith("avdmanager") && options.avdmanagerFails) {
        return Promise.resolve({ code: 1, stdout: "", stderr: "JAVA_HOME is not set" });
      }
      if (cmd.endsWith("avdmanager")) {
        const name = args[args.indexOf("-n") + 1]!;
        Deno.mkdirSync(join(avdHome, `${name}.avd`));
        Deno.writeTextFileSync(
          join(avdHome, `${name}.avd`, "config.ini"),
          "hw.device.name=pixel_8\nhw.ramSize=2G\n",
        );
        return done();
      }
      if (args[0] === "-accel-check") return done(options.accelOutput ?? "HVF is installed");
      return done();
    },
    attach(cmd, args) {
      calls.push({ cmd, args, attached: true });
      // sdkmanager leaves a package.xml in the folder of each package it installed.
      for (const id of args.filter((a) => !a.startsWith("--"))) {
        const dir = join(sdk, ...id.split(";"));
        Deno.mkdirSync(dir, { recursive: true });
        Deno.writeTextFileSync(join(dir, "package.xml"), "");
      }
      return Promise.resolve(0);
    },
  };
  const deps = (): Partial<SetupDeps> => ({
    runner,
    interactive: options.interactive ?? false,
    download: (url) => {
      downloads.push(url);
      return Promise.resolve(zipBytes);
    },
  });
  return {
    sdk,
    avdHome,
    calls,
    host,
    get downloads() {
      return downloads;
    },
    resetDownloads: () => (downloads = []),
    /** Runs the command with the fakes; `checksum` makes the fake zip match the pinned hash. */
    async run(args: string[], overrides: Partial<SetupDeps> = {}) {
      const zip = {
        url: commandLineToolsZip(host).url,
        sha256: await sha256(zipBytes),
      };
      return captured(() =>
        androidCommand(["setup", "--sdk", sdk, ...args], {
          host,
          env: (name) => name === "ANDROID_AVD_HOME" ? avdHome : undefined,
          setup: { ...deps(), zip, ...overrides },
        })
      );
    },
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

Deno.test("android setup --dry-run prints every step with the URL and changes nothing", async () => {
  const m = await fakeMachine();
  try {
    const run = await m.run(["--dry-run", "--accept-licenses"]);
    assertEquals(run.result, 0, run.err);
    assertStringIncludes(run.out, "[dry run]");
    assertStringIncludes(
      run.out,
      "[1/4] command-line tools: would download https://dl.google.com/",
    );
    assertStringIncludes(run.out, `unpack it to ${posix.join(m.sdk, "cmdline-tools", "latest")}`);
    assertStringIncludes(
      run.out,
      "[2/4] sdkmanager installs platform-tools, emulator, " +
        "system-images;android-36;google_apis;arm64-v8a (licences accepted because of --accept-licenses)",
    );
    assertStringIncludes(
      run.out,
      "[3/4] avdmanager creates the AVD pixel8 (pixel_8, 2048 MB of RAM)",
    );
    assertStringIncludes(run.out, "[4/4] would check hardware acceleration");
    assertStringIncludes(run.out, "Then run: hertzbench android prepare pixel8");
    // --sdk is not what a run looks in, so the plan says how to point it there.
    assertStringIncludes(run.out, `Set ANDROID_HOME to ${m.sdk}`);
    assertEquals(m.calls, []);
    assertEquals(m.downloads, []);
    assertEquals(await Array.fromAsync(Deno.readDir(m.sdk)).catch(() => "absent"), "absent");
  } finally {
    await m.cleanup();
  }
});

Deno.test("android setup installs everything once, and a second run skips every step", async () => {
  const m = await fakeMachine();
  try {
    const first = await m.run(["--accept-licenses", "--image", IMAGE_X86, "--ram", "3072"]);
    assertEquals(first.result, 0, first.err);
    // The URL is printed before the download starts, and the zip was fetched exactly once.
    assertStringIncludes(first.out, "downloading https://dl.google.com/android/repository/");
    assertEquals(m.downloads.length, 1);
    const latest = posix.join(m.sdk, "cmdline-tools", "latest");
    const sdkmanager = posix.join(latest, "bin", "sdkmanager");
    assertEquals(
      m.calls.map((c) =>
        `${c.cmd === "unzip" ? "unzip" : c.cmd.split("/").at(-1)}${c.attached ? " (attached)" : ""}`
      ),
      ["unzip", "sdkmanager", "sdkmanager (attached)", "avdmanager", "emulator"],
    );
    const [, licenses, install, create, accel] = m.calls;
    assertEquals(licenses!.cmd, sdkmanager);
    assertEquals(licenses!.args, [`--sdk_root=${m.sdk}`, "--licenses"]);
    assertStringIncludes(licenses!.input ?? "", "y\ny\n");
    assertEquals(install!.args, [`--sdk_root=${m.sdk}`, "platform-tools", "emulator", IMAGE_X86]);
    assertEquals(create!.args, ["create", "avd", "-n", "pixel8", "-k", IMAGE_X86, "-d", "pixel_8"]);
    assertEquals(create!.input, "no\n");
    assertEquals(accel!.cmd, posix.join(m.sdk, "emulator", "emulator"));
    // The 2G that avdmanager wrote is replaced by the RAM in MB.
    assertEquals(
      await Deno.readTextFile(join(m.avdHome, "pixel8.avd", "config.ini")),
      "hw.device.name=pixel_8\nhw.ramSize=3072\n",
    );
    assertStringIncludes(first.out, "hardware acceleration: HVF");
    assertStringIncludes(first.out, "Next: hertzbench android prepare pixel8");
    // No scratch folder is left next to `latest`.
    assertEquals(
      (await Array.fromAsync(Deno.readDir(join(m.sdk, "cmdline-tools")))).map((e) => e.name),
      ["latest"],
    );

    m.calls.length = 0;
    m.resetDownloads();
    const second = await m.run(["--accept-licenses", "--image", IMAGE_X86]);
    assertEquals(second.result, 0, second.err);
    assertStringIncludes(second.out, "[1/4] command-line tools: already in");
    assertStringIncludes(second.out, "[2/4] platform-tools, emulator and");
    assertStringIncludes(second.out, "[3/4] AVD pixel8: already exists, skipped");
    assertEquals(m.downloads, []);
    // Only the acceleration check runs again.
    assertEquals(m.calls.map((c) => c.args), [["-accel-check"]]);
  } finally {
    await m.cleanup();
  }
});

Deno.test("android setup without --accept-licenses lets sdkmanager ask on the terminal, or stops with a hint", async () => {
  const noTerminal = await fakeMachine({ interactive: false });
  try {
    const run = await noTerminal.run([]);
    assertEquals(run.result, 2);
    assertStringIncludes(run.err, "--accept-licenses");
    // It stops before the 180 MB download, not after.
    assertEquals(noTerminal.downloads, []);
    assertEquals(noTerminal.calls, []);
  } finally {
    await noTerminal.cleanup();
  }
  const terminal = await fakeMachine({ interactive: true });
  try {
    const run = await terminal.run([]);
    assertEquals(run.result, 0, run.err);
    // No --licenses call that answers for the user: sdkmanager asks while it installs.
    assert(!terminal.calls.some((c) => c.args.includes("--licenses")));
    assert(terminal.calls.some((c) => c.attached && c.args.includes("platform-tools")));
  } finally {
    await terminal.cleanup();
  }
});

Deno.test("android setup refuses a download whose sha256 is not the pinned one", async () => {
  const m = await fakeMachine();
  try {
    const run = await m.run(["--accept-licenses"], { zip: undefined });
    assertEquals(run.result, 2);
    assertStringIncludes(run.err, "has sha256");
    assertEquals(m.calls, []);
    // Nothing was unpacked and the scratch folder is gone.
    assertEquals(await Array.fromAsync(Deno.readDir(join(m.sdk, "cmdline-tools"))), []);
  } finally {
    await m.cleanup();
  }
});

Deno.test("android setup says what to fix when avdmanager or the accelerator fails", async () => {
  const failing = await fakeMachine({ avdmanagerFails: true });
  try {
    const run = await failing.run(["--accept-licenses"]);
    assertEquals(run.result, 2);
    assertStringIncludes(run.err, "avdmanager create avd failed (exit 1)");
    assertStringIncludes(run.err, "JAVA_HOME");
    assertStringIncludes(run.err, "Java 17");
  } finally {
    await failing.cleanup();
  }
  const noAccel = await fakeMachine({ accelOutput: "HVF is not supported" });
  try {
    const run = await noAccel.run(["--accept-licenses"]);
    assertEquals(run.result, 2);
    assertStringIncludes(run.err, "everything is installed, but");
    assertStringIncludes(run.err, "Hypervisor.framework");
    assert(!run.out.includes("Next:"));
  } finally {
    await noAccel.cleanup();
  }
});

Deno.test("android setup rejects bad arguments before touching anything", async () => {
  const cases: [string[], string][] = [
    [["--ram", "lots"], "--ram must be a whole number of MB"],
    [["--ram"], "--ram needs a value"],
    [["--sdk", "--dry-run"], "--sdk needs a value"],
    [["--image", "system-images/android-36"], "--image must look like"],
    [["--avd", "../escape"], "--avd may hold"],
    [["--frobnicate"], "unexpected argument --frobnicate"],
    [["pixel8"], "unexpected argument pixel8"],
  ];
  for (const [args, words] of cases) {
    const run = await captured(() =>
      androidCommand(["setup", ...args], {
        host: fakeHostEnv("linux"),
        setup: { download: () => Promise.reject(new Error("no network in tests")) },
      })
    );
    assertEquals(run.result, 2, args.join(" "));
    assertStringIncludes(run.err, words);
    assertEquals(run.out, "");
  }
  // --name=value is read like --name value.
  const dry = await captured(() =>
    androidCommand(["setup", "--dry-run", "--sdk=/x/sdk", "--avd=tab", "--device=pixel_tablet"], {
      host: fakeHostEnv("linux"),
      setup: { download: () => Promise.reject(new Error("no network in tests")) },
    })
  );
  assertEquals(dry.result, 0, dry.err);
  assertStringIncludes(dry.out, "Android SDK: /x/sdk (from --sdk)");
  assertStringIncludes(dry.out, "AVD tab (pixel_tablet, 2048 MB of RAM)");
});
