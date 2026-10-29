// Coverage of the CLI through its real entrypoint: `cli/main.ts` as a separate
// process, every option with a missing or bad value, every command's exit
// status, `validate` over every example, and `view` and `mcp` as the servers
// they are. The child inherits DENO_COVERAGE_DIR, so `deno test --coverage`
// counts what it runs.

import { join } from "node:path";
import { FAKE_EMULATOR_VERSION, fakeAvdHome, fakeSdk } from "./android_fake_sdk.ts";
import { forward, signalTest } from "./platform.ts";
import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const MAIN = fileURLToPath(new URL("../cli/main.ts", import.meta.url));
const EXAMPLES = fileURLToPath(new URL("../scenarios/examples/", import.meta.url));
const PERMISSIONS = [
  "--allow-net=127.0.0.1",
  "--allow-read",
  "--allow-write",
  "--allow-run",
  "--allow-env",
];

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(args: string[], env: Record<string, string> = {}): Promise<Outcome> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["run", ...PERMISSIONS, MAIN, ...args],
    env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  return { code: output.code, stdout: decode(output.stdout), stderr: decode(output.stderr) };
}

async function inTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "hzb-cov-cli-" });
  try {
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const SHORT = `name: short
duration: 300ms
nodes:
  - { id: a, board: scripted, position: [0, 0], firmware: { send: [{ to: b, every: 50ms, count: 3 }] } }
  - { id: b, board: scripted, position: [5, 0] }
`;

/** Exit 2 with the reason on stderr, followed by the usage. */
function assertUsageError(outcome: Outcome, words: string): void {
  assertEquals(outcome.code, 2, outcome.stderr);
  assertStringIncludes(outcome.stderr, words);
  assertStringIncludes(outcome.stderr, "Usage:");
  assertEquals(outcome.stdout, "");
}

// ── regressions ─────────────────────────────────────────────────────────────

Deno.test("cli: an empty --seed or --port is refused, not read as 0", async () => {
  assertUsageError(await cli(["validate", "x.yaml", "--seed", ""]), "--seed needs an integer");
  assertUsageError(await cli(["view", "x.yaml", "--port", ""]), "--port needs a port");
  assertUsageError(await cli(["mcp", "--view-port", " "]), "--view-port needs a port");
});

// ── arguments ───────────────────────────────────────────────────────────────

// ── android prepare ─────────────────────────────────────────────────────────

Deno.test("cli: android needs prepare and an AVD name, and says so with the usage", async () => {
  const cases: [string[], string][] = [
    [["android"], "android needs a subcommand"],
    [["android", "frobnicate"], 'unknown android subcommand "frobnicate"'],
    [["android", "prepare"], "android prepare needs the name of an AVD"],
    [["android", "prepare", "--wipe"], "android prepare needs the name of an AVD"],
    [["android", "prepare", "pixel8", "extra"], "unexpected argument extra"],
  ];
  for (const [args, words] of cases) {
    const outcome = await cli(args);
    assertEquals(outcome.code, 2, args.join(" "));
    assertStringIncludes(outcome.stderr, words);
    assertStringIncludes(outcome.stderr, "hertzbench android prepare <avd>");
    assertEquals(outcome.stdout, "");
  }
  const help = await cli(["android", "--help"]);
  assertEquals(help.code, 0, help.stderr);
  assertStringIncludes(help.stderr, "hertzbench android prepare <avd>");
  assertStringIncludes((await cli(["--help"])).stderr, "hertzbench android prepare <avd>");
});

// The fake emulator and adb are sh scripts, and the CLI's KVM check is only wired for Linux.
Deno.test({
  name: "cli: android prepare saves the snapshot and exits 0, or exits 2 with the reason " +
    "[skipped off Linux: sh fake tools, and KVM acceleration is Linux-only]",
  ignore: Deno.build.os !== "linux",
  fn: async () => {
    const avd = await fakeAvdHome("pixel8", null);
    const sdk = await fakeSdk(
      `shell) echo 1 ;;
wait-for-device) exit 0 ;;
emu) if [ "$1" = avd ]; then echo OK; exit 0; fi; kill "$(cat "$DIR/emulator-pid")" ;;`,
    );
    try {
      const env = { ANDROID_AVD_HOME: avd.home };
      const done = await cli(["android", "prepare", "pixel8"], env);
      assertEquals(done.code, 0, done.stderr);
      assertStringIncludes(
        done.stdout,
        `pixel8: snapshot hertzbench saved in ${join(avd.avdDir, "snapshots", "hertzbench")} ` +
          `(emulator ${FAKE_EMULATOR_VERSION})`,
      );
      const marker = await Deno.readTextFile(
        join(avd.avdDir, "snapshots", "hertzbench", "hertzbench.json"),
      );
      assertEquals(JSON.parse(marker), { emulator: FAKE_EMULATOR_VERSION });

      const missing = await cli(["android", "prepare", "nope"], env);
      assertEquals(missing.code, 2);
      assertStringIncludes(missing.stderr, "hertzbench: no AVD named nope (found: pixel8, tablet)");
    } finally {
      await sdk.restore();
      await avd.remove();
    }
  },
});

Deno.test("cli: --help and -h print the usage and exit 0, wherever they are", async () => {
  for (const args of [["--help"], ["-h"], ["run", "x.yaml", "--help"], ["validate", "-h"]]) {
    const outcome = await cli(args);
    assertEquals(outcome.code, 0, args.join(" "));
    assertStringIncludes(outcome.stderr, "Usage:");
    assertStringIncludes(outcome.stderr, "hertzbench mcp [--workspace DIR] [--view-port N]");
    assert(!outcome.stderr.includes("unknown"), outcome.stderr);
  }
});

Deno.test("cli: every option with a missing or bad value exits 2 and names the option", async () => {
  const cases: [string[], string][] = [
    [["run", "x.yaml", "--out"], "--out needs a directory"],
    [["run", "x.yaml", "--seed"], "--seed needs an integer"],
    [["run", "x.yaml", "--seed", "abc"], "--seed needs an integer"],
    [["run", "x.yaml", "--seed", "-1"], "--seed needs an integer"],
    [["run", "x.yaml", "--seed", "1.5"], "--seed needs an integer"],
    [["run", "x.yaml", "--seed", "4294967296"], "--seed needs an integer"],
    [["mcp", "--workspace"], "--workspace needs a directory"],
    [["view", "x.yaml", "--port"], "--port needs a port from 0 to 65535"],
    [["view", "x.yaml", "--port", "65536"], "--port needs a port"],
    [["mcp", "--view-port", "http"], "--view-port needs a port"],
    [["run", "x.yaml", "--verbose"], "unknown option --verbose"],
    [["run", "x.yaml", "-q"], "unknown option -q"],
    [["run", "a.yaml", "b.yaml"], "unexpected argument b.yaml"],
    [["frobnicate", "x.yaml"], 'unknown command "frobnicate"'],
    [["mcp", "x.yaml"], "mcp takes no scenario file"],
    [["run"], "run needs a scenario file"],
    [["validate"], "validate needs a scenario file"],
    [["view"], "view needs a scenario file"],
  ];
  for (const [args, words] of cases) assertUsageError(await cli(args), words);
});

Deno.test("cli: the largest seed and port are accepted", async () => {
  await inTempDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/s.yaml`, SHORT);
    const outcome = await cli([
      "validate",
      `${dir}/s.yaml`,
      "--seed",
      "4294967295",
      "--port",
      "65535",
    ]);
    assertEquals(outcome.code, 0, outcome.stderr);
    assertStringIncludes(outcome.stdout, "seed 4294967295");
  });
});

// ── validate ────────────────────────────────────────────────────────────────

Deno.test("cli: validate reports nodes, duration and seed, with --seed applied", async () => {
  await inTempDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/s.yaml`, SHORT);
    const plain = await cli(["validate", `${dir}/s.yaml`]);
    assertEquals(plain.code, 0, plain.stderr);
    assertStringIncludes(
      forward(plain.stdout),
      forward(`${dir}/s.yaml: ok (2 nodes, 300 ms, seed 1)`),
    );
    const seeded = await cli(["validate", `${dir}/s.yaml`, "--seed", "0"]);
    assertStringIncludes(seeded.stdout, "seed 0)");
  });
});

Deno.test("cli: validate exits 2 on a missing file, an invalid field and missing firmware", async () => {
  await inTempDir(async (dir) => {
    const missing = await cli(["validate", `${dir}/nope.yaml`]);
    assertEquals(missing.code, 2);
    assertStringIncludes(forward(missing.stderr), forward(`cannot read ${dir}/nope.yaml`));
    await Deno.writeTextFile(`${dir}/bad.yaml`, SHORT.replace("300ms", "300"));
    const bad = await cli(["validate", `${dir}/bad.yaml`]);
    assertEquals(bad.code, 2);
    assertStringIncludes(bad.stderr, "hertzbench: duration:");
    await Deno.writeTextFile(
      `${dir}/fw.yaml`,
      SHORT.replace(
        "board: scripted, position: [5, 0]",
        "board: esp32, firmware: ./b.bin, position: [5, 0]",
      ),
    );
    const fw = await cli(["validate", `${dir}/fw.yaml`]);
    assertEquals(fw.code, 2);
    assertStringIncludes(fw.stderr, "firmware not found");
    assertStringIncludes(forward(fw.stderr), forward(`b: ${dir}/b.bin does not exist`));
  });
});

Deno.test("cli: validate warns, and still exits 0, for an esp32 sketch that includes BluetoothSerial.h", async () => {
  await inTempDir(async (dir) => {
    await Deno.mkdir(`${dir}/bt`);
    await Deno.writeTextFile(`${dir}/bt/bt.ino`, '#include "BluetoothSerial.h"\nvoid setup() {}\n');
    await Deno.writeTextFile(
      `${dir}/s.yaml`,
      SHORT.replace(
        "board: scripted, position: [5, 0]",
        "board: esp32, firmware: ./bt, position: [5, 0]",
      ),
    );
    const outcome = await cli(["validate", `${dir}/s.yaml`]);
    assertEquals(outcome.code, 0, outcome.stderr);
    assertStringIncludes(outcome.stdout, "ok (2 nodes");
    assertStringIncludes(
      outcome.stderr,
      "warning: b: bt.ino includes BluetoothSerial.h; classic Bluetooth is not simulated; " +
        "this firmware cannot run on the esp32 board",
    );
  });
});

Deno.test("cli: validate accepts every example; the only refusals are unbuilt ESP-IDF binaries and Android apps", async () => {
  const names = [...Deno.readDirSync(EXAMPLES)].filter((e) => e.name.endsWith(".yaml"))
    .map((e) => e.name).sort();
  assert(names.length >= 13, `found ${names.length} examples`);
  const refused: string[] = [];
  for (const name of names) {
    const outcome = await cli(["validate", `${EXAMPLES}${name}`]);
    if (outcome.code === 0) {
      assertStringIncludes(outcome.stdout, `${name}: ok (`);
      continue;
    }
    assertEquals(outcome.code, 2, `${name}: ${outcome.stderr}`);
    assertStringIncludes(outcome.stderr, "firmware not found");
    for (const line of outcome.stderr.trim().split("\n").slice(1)) {
      assert(
        /[\\/]build[\\/](?:[^\\/]+\.bin|outputs[\\/]apk[\\/]debug[\\/]app-debug\.apk) does not exist$/
          .test(line),
        `${name}: ${line}`,
      );
    }
    refused.push(name);
  }
  // At most the two that need `idf.py build` of scenarios/examples/fw/ble-sensor first, and the
  // two that need `gradle assembleDebug` of examples/android/iot-app.
  const unbuilt = [
    "ble-sensors-3-nodes.yaml",
    "bridge-ble-esp32.yaml",
    "android-web-scripted.yaml",
    "android-web-esp32.yaml",
  ];
  for (const name of refused) assert(unbuilt.includes(name), `${name} was refused`);
});

// ── run ─────────────────────────────────────────────────────────────────────

Deno.test("cli: run prints the report and writes the outputs; --quiet prints only the result", async () => {
  await inTempDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/s.yaml`, SHORT);
    const full = await cli(["run", `${dir}/s.yaml`, "--out", `${dir}/out`, "--seed", "3"]);
    assertEquals(full.code, 0, full.stderr);
    assertStringIncludes(full.stdout, "(seed 3, 300 ms)");
    assertStringIncludes(full.stdout, "RESULT: PASS");
    assertStringIncludes(full.stderr, "[hertzbench] starting 2 board(s)");
    const metrics = JSON.parse(await Deno.readTextFile(`${dir}/out/metrics.json`));
    assertEquals([metrics.schema, metrics.seed], [2, 3]);
    const quiet = await cli(["run", `${dir}/s.yaml`, "--out", `${dir}/q`, "--quiet"]);
    assertEquals([quiet.code, quiet.stdout, quiet.stderr], [0, "RESULT: PASS\n", ""]);
  });
});

Deno.test("cli: a failed assertion exits 1, --quiet says FAIL", async () => {
  await inTempDir(async (dir) => {
    await Deno.writeTextFile(
      `${dir}/s.yaml`,
      SHORT + "assertions:\n  - serial: { node: a, contains: never printed }\n",
    );
    const outcome = await cli(["run", `${dir}/s.yaml`, "--out", `${dir}/out`, "--quiet"]);
    assertEquals([outcome.code, outcome.stdout], [1, "RESULT: FAIL\n"]);
  });
});

Deno.test("cli: run exits 2 when the scenario is invalid or a board cannot start", async () => {
  await inTempDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/bad.yaml`, SHORT.replace("id: b", "id: a"));
    const bad = await cli(["run", `${dir}/bad.yaml`, "--out", `${dir}/out`]);
    assertEquals(bad.code, 2);
    assertStringIncludes(bad.stderr, 'duplicate node id "a"');
    await Deno.writeFile(`${dir}/b.bin`, new Uint8Array(4));
    await Deno.writeTextFile(
      `${dir}/esp.yaml`,
      SHORT.replace(
        "board: scripted, position: [5, 0]",
        "board: esp32, firmware: ./b.bin, position: [5, 0]",
      ),
    );
    const esp = await cli(["run", `${dir}/esp.yaml`, "--out", `${dir}/out`], {
      QEMU_ESP32_LIB: `${dir}/no-libqemu.so`,
    });
    assertEquals(esp.code, 2, esp.stderr);
    assertStringIncludes(esp.stderr, "libqemu-xtensa not found");
    // Nothing ran, so nothing was written.
    let wrote = true;
    try {
      await Deno.stat(`${dir}/out/metrics.json`);
    } catch {
      wrote = false;
    }
    assertEquals(wrote, false);
  });
});

// ── view and mcp ────────────────────────────────────────────────────────────

/** Read a child's stderr until `marker` shows up or the stream ends; returns what it read. */
async function readUntil(
  reader: ReadableStreamDefaultReader<string>,
  marker: string,
): Promise<string> {
  let seen = "";
  while (!seen.includes(marker)) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += value;
  }
  return seen;
}

signalTest(
  "cli: view runs the scenario, serves it, prints the report and exits 0 on SIGINT",
  async () => {
    await inTempDir(async (dir) => {
      await Deno.writeTextFile(`${dir}/s.yaml`, SHORT);
      const child = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          ...PERMISSIONS,
          MAIN,
          "view",
          `${dir}/s.yaml`,
          "--out",
          `${dir}/out`,
          "--port",
          "0",
          "--seed",
          "5",
        ],
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const stdout = new Response(child.stdout).text();
      const reader = child.stderr.pipeThrough(new TextDecoderStream()).getReader();
      let seen = await readUntil(reader, "the view stays up until Ctrl-C");
      assertStringIncludes(seen, "view: http://127.0.0.1:");
      assertStringIncludes(seen, "run finished");
      const url = /view: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(seen)?.[1];
      assert(url, seen);
      const page = await fetch(url);
      assertEquals(page.status, 200);
      await page.body?.cancel();
      child.kill("SIGINT");
      seen += await readUntil(reader, "\u0000");
      const status = await child.status;
      assertEquals(status.code, 0, seen);
      const report = await stdout;
      assertStringIncludes(report, "(seed 5, 300 ms)");
      assertStringIncludes(report, "RESULT: PASS");
    });
  },
);

Deno.test("cli: view exits 2 on an invalid scenario and on a port already in use", async () => {
  await inTempDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/bad.yaml`, "name: x\n");
    const bad = await cli(["view", `${dir}/bad.yaml`, "--port", "0", "--out", `${dir}/out`]);
    assertEquals(bad.code, 2, bad.stderr);
    assertStringIncludes(bad.stderr, "hertzbench:");
    assertStringIncludes(bad.stderr, "duration");
    const taken = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    try {
      const port = (taken.addr as Deno.NetAddr).port;
      await Deno.writeTextFile(`${dir}/s.yaml`, SHORT);
      const busy = await cli([
        "view",
        `${dir}/s.yaml`,
        "--port",
        String(port),
        "--out",
        `${dir}/out`,
      ]);
      assertEquals(busy.code, 2, busy.stderr);
      assertStringIncludes(busy.stderr, `port ${port} is in use; pass --port`);
    } finally {
      taken.close();
    }
  });
});

Deno.test("cli: mcp serves until its stdin closes, then exits 0", async () => {
  await inTempDir(async (dir) => {
    const outcome = await cli(["mcp", "--workspace", dir, "--view-port", "0"]);
    assertEquals(outcome.code, 0, outcome.stderr);
    assertEquals(outcome.stdout, "");
    const plain = await cli(["mcp", "--workspace", dir]);
    assertEquals(plain.code, 0, plain.stderr);
  });
});
