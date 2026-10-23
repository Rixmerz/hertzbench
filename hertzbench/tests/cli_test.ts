// The real entrypoint: `hertzbench` as a separate process, the way a person or
// CI runs it. Nothing here imports the orchestrator.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const MAIN = new URL("../cli/main.ts", import.meta.url).pathname;
const EXAMPLES = new URL("../scenarios/examples/", import.meta.url).pathname;

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

async function hertzbench(args: string[], env: Record<string, string> = {}): Promise<Outcome> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-net=127.0.0.1",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env",
      MAIN,
      ...args,
    ],
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  return { code: output.code, stdout: decode(output.stdout), stderr: decode(output.stderr) };
}

async function inTempDir<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "hzb-cli-" });
  try {
    return await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const SHORT = `
name: short
seed: 9
duration: 1s
environment: { shadowing_sigma_db: 0 }
nodes:
  - id: a
    board: scripted
    position: [0, 0]
    firmware: { send: [{ to: b, every: 50ms, count: 10 }] }
  - { id: b, board: scripted, position: [5, 0], firmware: {} }
`;

Deno.test("run: the scripted example passes end to end and writes metrics.json and air.pcap", async () => {
  await inTempDir(async (dir) => {
    const run = await hertzbench(["run", `${EXAMPLES}udp-3-scripted.yaml`, "--out", dir]);
    assertEquals(run.code, 0, run.stdout + run.stderr);
    assertStringIncludes(run.stdout, "RESULT: PASS");
    assertStringIncludes(run.stdout, 'Phase "behind-wall"');
    assertStringIncludes(run.stdout, "MODELLED");

    const metrics = JSON.parse(await Deno.readTextFile(`${dir}/metrics.json`));
    assertEquals(metrics.passed, true);
    assertEquals(metrics.scenario, "udp-3-scripted");
    const wall = metrics.phases.find((p: { label: string }) => p.label === "behind-wall");
    const ca = (links: { from: string; to: string; loss_pct: number }[]) =>
      links.find((l) => l.from === "c" && l.to === "a")!;
    const startPhase = metrics.phases[0];
    assert(ca(wall.links).loss_pct > ca(startPhase.links).loss_pct + 20);

    const pcap = await Deno.readFile(`${dir}/air.pcap`);
    const view = new DataView(pcap.buffer);
    assertEquals(view.getUint32(0, true), 0xa1b2c3d4);
    assertEquals(view.getUint32(20, true), 1);
    assert(pcap.length > 24 + 16 * 100, "the capture should hold the run's frames");
    assert((await Deno.stat(`${dir}/events.jsonl`)).size > 0);
    assertStringIncludes(
      await Deno.readTextFile(`${dir}/serial-a.log`),
      "dhcp bound ip=192.168.4.11",
    );
  });
});

Deno.test("run: a failed assertion exits 1 and says which", async () => {
  await inTempDir(async (dir) => {
    await Deno.writeTextFile(
      `${dir}/s.yaml`,
      SHORT + `assertions: [{ metric: { link: "a->b", loss_pct: { gt: 50 } } }]\n`,
    );
    const run = await hertzbench(["run", `${dir}/s.yaml`, "--out", `${dir}/out`]);
    assertEquals(run.code, 1, run.stdout + run.stderr);
    assertStringIncludes(run.stdout, "FAIL  metric a->b");
    assertStringIncludes(run.stdout, "RESULT: FAIL");
  });
});

Deno.test("run: --seed overrides the scenario seed, --quiet prints only the result", async () => {
  await inTempDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/s.yaml`, SHORT);
    const seeded = await hertzbench(["run", `${dir}/s.yaml`, "--out", `${dir}/o1`, "--seed", "77"]);
    assertEquals(seeded.code, 0, seeded.stdout + seeded.stderr);
    assertStringIncludes(seeded.stdout, "seed 77");
    assertEquals(JSON.parse(await Deno.readTextFile(`${dir}/o1/metrics.json`)).seed, 77);
    const quiet = await hertzbench(["run", `${dir}/s.yaml`, "--out", `${dir}/o2`, "--quiet"]);
    assertEquals(quiet.stdout.trim(), "RESULT: PASS");
  });
});

Deno.test("run: scenario outputs land where the scenario says, relative to the scenario", async () => {
  await inTempDir(async (dir) => {
    await Deno.writeTextFile(
      `${dir}/s.yaml`,
      SHORT +
        `outputs: { metrics: ./results/m.json, pcap: ./results/a.pcap, events: ./results/e.jsonl }\n`,
    );
    const run = await hertzbench(["run", `${dir}/s.yaml`]);
    assertEquals(run.code, 0, run.stdout + run.stderr);
    for (const name of ["m.json", "a.pcap", "e.jsonl"]) {
      assert((await Deno.stat(`${dir}/results/${name}`)).size > 0, name);
    }
  });
});

Deno.test("validate: accepts the examples and the firmware they name", async () => {
  for (const file of ["udp-3-nodes.yaml", "udp-3-scripted.yaml"]) {
    const run = await hertzbench(["validate", `${EXAMPLES}${file}`]);
    assertEquals(run.code, 0, run.stdout + run.stderr);
    assertStringIncludes(run.stdout, "ok (3 nodes");
  }
});

Deno.test("exit 2: an invalid scenario names the field, a missing sketch names the node", async () => {
  await inTempDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/bad.yaml`, SHORT.replace("duration: 1s", "duration: 1"));
    const bad = await hertzbench(["validate", `${dir}/bad.yaml`]);
    assertEquals(bad.code, 2);
    assertStringIncludes(bad.stderr, "duration");

    await Deno.writeTextFile(
      `${dir}/nofw.yaml`,
      "name: nofw\nduration: 1s\nnodes:\n" +
        "  - { id: a, board: esp32, firmware: ./missing, position: [0, 0] }\n" +
        "  - { id: b, board: esp32, firmware: ./missing, position: [5, 0] }\n",
    );
    const missing = await hertzbench(["run", `${dir}/nofw.yaml`]);
    assertEquals(missing.code, 2);
    assertStringIncludes(missing.stderr, "a: ");
    assertStringIncludes(missing.stderr, "does not exist");

    const nofile = await hertzbench(["run", `${dir}/absent.yaml`]);
    assertEquals(nofile.code, 2);
    assertStringIncludes(nofile.stderr, "cannot read");
  });
});

Deno.test("exit 2: an ESP32 scenario on a host without libqemu says so instead of hanging", async () => {
  await inTempDir(async (dir) => {
    const fw = `${dir}/fw.bin`;
    await Deno.writeFile(fw, new Uint8Array(16));
    await Deno.writeTextFile(
      `${dir}/esp.yaml`,
      `name: esp\nduration: 30s\nnodes:\n` +
        `  - { id: a, board: esp32, firmware: ./fw.bin, position: [0, 0] }\n` +
        `  - { id: b, board: esp32, firmware: ./fw.bin, position: [5, 0] }\n`,
    );
    const run = await hertzbench(["run", `${dir}/esp.yaml`, "--out", `${dir}/out`], {
      QEMU_ESP32_LIB: `${dir}/does-not-exist.so`,
    });
    assertEquals(run.code, 2, run.stdout + run.stderr);
    assertStringIncludes(run.stderr, "libqemu-xtensa not found");
    assertStringIncludes(run.stderr, "e2e-esp32.md");
  });
});

Deno.test("usage: no arguments and --help print usage; an unknown command exits 2", async () => {
  const none = await hertzbench([]);
  assertEquals(none.code, 0);
  assertStringIncludes(none.stderr, "hzb");
  const unknown = await hertzbench(["frobnicate"]);
  assertEquals(unknown.code, 2);
  assertStringIncludes(unknown.stderr, "unknown command");
  const noFile = await hertzbench(["run"]);
  assertEquals(noFile.code, 2);
});

Deno.test("SIGINT: the CLI stops the run, exits 130 and writes no results", async () => {
  await inTempDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/long.yaml`, SHORT.replace("duration: 1s", "duration: 10m"));
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-net=127.0.0.1",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "--allow-env",
        MAIN,
        "run",
        `${dir}/long.yaml`,
        "--out",
        `${dir}/out`,
      ],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    // Wait for the run to be underway (the CLI reports it on stderr), then interrupt.
    const reader = child.stderr.pipeThrough(new TextDecoderStream()).getReader();
    let seen = "";
    while (!seen.includes("running for")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += value;
    }
    child.kill("SIGINT");
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += value;
    }
    const status = await child.status;
    await child.stdout.cancel();
    assertEquals(status.code, 130, seen);
    assertStringIncludes(seen, "interrupted");
    let wrote = true;
    try {
      await Deno.stat(`${dir}/out/metrics.json`);
    } catch {
      wrote = false;
    }
    assertEquals(wrote, false);
  });
});

Deno.test("exit 2: a worker that dies during start-up fails fast, lists why, and accepted the launcher's config", async () => {
  await inTempDir(async (dir) => {
    // An empty file is not a shared library: the real worker starts, accepts the
    // config the launcher wrote, tries to load it and exits.
    await Deno.writeFile(`${dir}/libqemu-xtensa.so`, new Uint8Array(0));
    await Deno.writeFile(`${dir}/fw.bin`, new Uint8Array(16));
    await Deno.writeTextFile(
      `${dir}/esp.yaml`,
      `name: dying\nduration: 60s\nnodes:\n` +
        `  - { id: a, board: esp32, firmware: ./fw.bin, position: [0, 0] }\n` +
        `  - { id: b, board: esp32, firmware: ./fw.bin, position: [5, 0] }\n`,
    );
    const started = performance.now();
    const run = await hertzbench(["run", `${dir}/esp.yaml`, "--out", `${dir}/out`], {
      QEMU_ESP32_LIB: `${dir}/libqemu-xtensa.so`,
    });
    assert(performance.now() - started < 25_000, "must not wait for the 30 s connect timeout");
    assertEquals(run.code, 2, run.stdout + run.stderr);
    assertStringIncludes(run.stderr, "worker exited early");
    assertStringIncludes(run.stderr, "worker-");
    assert(!run.stderr.includes("    at "), "a start-up failure is a message, not a stack trace");

    // The cross-language contract: the real worker read wifi_l2_port and
    // efuse_image from the launcher's config and got as far as loading libqemu.
    // Renaming a field on one side only would stop it here.
    const log = await Deno.readTextFile(`${dir}/out/worker-a.stderr.log`);
    assertStringIncludes(log, "Loading library");
    assert(!log.includes("wifi_l2_port must be"), log);
    assert(!log.includes("efuse_image must be"), log);
    assertEquals((await Deno.stat(`${dir}/out/efuse-a.bin`)).size, 512);
  });
});

Deno.test("scripted run: logged times never step backwards in the events or the capture", async () => {
  await inTempDir(async (dir) => {
    const run = await hertzbench([
      "run",
      `${EXAMPLES}udp-3-scripted.yaml`,
      "--out",
      dir,
      "--quiet",
    ]);
    assertEquals(run.code, 0, run.stdout + run.stderr);

    const events = (await Deno.readTextFile(`${dir}/events.jsonl`)).trim().split("\n").map((l) =>
      JSON.parse(l) as { seq: number; t: number }
    );
    assert(events.length > 100);
    events.forEach((e, i) => {
      assertEquals(e.seq, i);
      if (i > 0) {
        assert(e.t >= events[i - 1]!.t, `event ${i} at ${e.t} follows ${events[i - 1]!.t}`);
      }
    });

    const pcap = await Deno.readFile(`${dir}/air.pcap`);
    const view = new DataView(pcap.buffer);
    let offset = 24;
    let last = 0;
    let records = 0;
    while (offset < pcap.length) {
      const stamp = view.getUint32(offset, true) * 1_000_000 + view.getUint32(offset + 4, true);
      assert(stamp >= last, `capture record ${records} steps back in time`);
      last = stamp;
      offset += 16 + view.getUint32(offset + 8, true);
      records++;
    }
    assertEquals(offset, pcap.length);
    assert(records > 100);
  });
});

Deno.test("installed as real commands: hertzbench and hzb run from any directory", async () => {
  await inTempDir(async (dir) => {
    for (const name of ["hertzbench", "hzb"]) {
      const install = await new Deno.Command(Deno.execPath(), {
        args: [
          "install",
          "--global",
          "--root",
          dir,
          "--name",
          name,
          "--allow-net=127.0.0.1",
          "--allow-read",
          "--allow-write",
          "--allow-run",
          "--allow-env",
          "--config",
          new URL("../deno.json", import.meta.url).pathname,
          MAIN,
        ],
        stdout: "null",
        stderr: "piped",
      }).output();
      assertEquals(install.code, 0, new TextDecoder().decode(install.stderr));
      const out = await new Deno.Command(`${dir}/bin/${name}`, {
        args: ["validate", `${EXAMPLES}udp-3-scripted.yaml`],
        cwd: dir,
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
      assertStringIncludes(new TextDecoder().decode(out.stdout), "ok (3 nodes");
    }
  });
});
