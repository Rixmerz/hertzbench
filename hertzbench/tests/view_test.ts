// The visual layer: the link and timeline model as pure functions, then the
// HTTP server through its real entrypoints, `hertzbench view` and
// `hertzbench mcp --view-port`, each a separate process on a scripted run.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ChipSignal, EngineEvent, LinkBudget } from "../engine/mod.ts";
import {
  chipSignalQuality,
  lossQuality,
  sceneLinks,
  signalQuality,
  TIMELINE_CAP,
  timelineSince,
} from "../view/scene.ts";

const MAIN = new URL("../cli/main.ts", import.meta.url).pathname;
const LIVE = new URL("../scenarios/examples/live-3-scripted.yaml", import.meta.url).pathname;
const LORA = new URL("../scenarios/examples/lora-gateway-6-scripted.yaml", import.meta.url)
  .pathname;
const PERMISSIONS = [
  "--allow-net=127.0.0.1",
  "--allow-read",
  "--allow-write",
  "--allow-run",
  "--allow-env",
];

// Answers are JSON documents read field by field; typing each one here would
// only restate the server.
// deno-lint-ignore no-explicit-any
type Json = any;

// ── The model ───────────────────────────────────────────────────────────────

Deno.test("signal quality follows the rate table: 54 Mbit/s, 24 Mbit/s, the slowest rate, below it", () => {
  assertEquals(signalQuality(26), "good");
  assertEquals(signalQuality(25.9), "fair");
  assertEquals(signalQuality(17), "fair");
  assertEquals(signalQuality(16.9), "poor");
  assertEquals(signalQuality(9), "poor");
  assertEquals(signalQuality(8.9), "bad");
});

Deno.test("loss quality: under 1%, under 10%, under 50%, from 50%, and idle without frames", () => {
  assertEquals(lossQuality(null), "idle");
  assertEquals(lossQuality(0), "good");
  assertEquals(lossQuality(1), "fair");
  assertEquals(lossQuality(9.99), "fair");
  assertEquals(lossQuality(10), "poor");
  assertEquals(lossQuality(50), "bad");
});

// SF7 at 125 kHz: a 10% loss floor at -7.5 dB SNR for 20-byte frames.
const LORA_SF7: ChipSignal = {
  frequencyHz: 868.1e6,
  bandwidthHz: 125e3,
  noiseFigureDb: 6,
  txPowerDbm: 14,
  requiredSnrDb: -7.5,
  referenceBytes: 20,
  rateBps: 5468.75,
};

Deno.test("chip signal quality follows the PHY's error curve: 10% loss at its floor", () => {
  // The waterfall falls tenfold per 1.5 dB: 3 dB of margin loses 0.1%, 1.5 dB about 1%.
  assertEquals(chipSignalQuality(-4.5, LORA_SF7), "good");
  assertEquals(chipSignalQuality(-6, LORA_SF7), "fair");
  // At the floor itself the curve gives 10% less a rounding error; just below it, more.
  assertEquals(chipSignalQuality(-7.4, LORA_SF7), "fair");
  assertEquals(chipSignalQuality(-7.6, LORA_SF7), "poor");
  assertEquals(chipSignalQuality(-9, LORA_SF7), "bad");
});

function budget(distanceM: number, rssiDbm: number, snrDb: number): LinkBudget {
  return {
    distanceM,
    pathLossDb: 0,
    obstacleLossDb: 0,
    shadowingDb: 0,
    rssiDbm,
    noiseFloorDbm: rssiDbm - snrDb,
    snrDb,
  };
}

function outcome(
  seq: number,
  t: number,
  from: string,
  to: string,
  delivered: boolean,
): EngineEvent {
  const base = { seq, t, from, to, bytes: 100, kind: "udp" as const, rssiDbm: -60, snrDb: 30 };
  return delivered
    ? { ...base, type: "deliver", delayMs: 0.5, attempts: 1, rateMbps: 54 }
    : { ...base, type: "drop", reason: "retry_exhausted", attempts: 7 };
}

Deno.test("scene links: loss counts only the recent window, overrides follow the last rule", () => {
  const events: EngineEvent[] = [
    // Old losses on a->b, outside the 2 s window at t = 5000.
    outcome(0, 1000, "a", "b", false),
    outcome(1, 1500, "a", "b", false),
    {
      seq: 2,
      t: 2000,
      type: "link-override",
      from: "b",
      to: "a",
      extraLossPct: 30,
      extraLatencyMs: 0,
    },
    {
      seq: 3,
      t: 2100,
      type: "link-override",
      from: "a",
      to: "b",
      extraLossPct: 20,
      extraLatencyMs: 5,
    },
    {
      seq: 4,
      t: 2200,
      type: "link-override",
      from: "a",
      to: "b",
      extraLossPct: 0,
      extraLatencyMs: 0,
    },
    outcome(5, 3500, "a", "b", true),
    outcome(6, 4000, "a", "b", true),
    outcome(7, 4500, "a", "b", true),
    outcome(8, 4900, "a", "b", false),
  ];
  const links = sceneLinks(
    [
      { from: "a", to: "b", budget: budget(10, -60, 31) },
      { from: "b", to: "a", budget: budget(10, -84, 7) },
    ],
    events,
    5000,
  );
  assertEquals(links[0], {
    from: "a",
    to: "b",
    distance_m: 10,
    rssi_dbm: -60,
    snr_db: 31,
    rate_bps: 54e6,
    required_snr_db: null,
    signal: "good",
    window_frames: 4,
    window_loss_pct: 25,
    loss: "poor",
    override: null,
  });
  assertEquals(links[1]!.signal, "bad");
  assertEquals(links[1]!.rate_bps, 6e6);
  assertEquals(links[1]!.window_frames, 0);
  assertEquals(links[1]!.window_loss_pct, null);
  assertEquals(links[1]!.loss, "idle");
  assertEquals(links[1]!.override, {
    extra_loss_pct: 30,
    extra_latency_ms: 0,
    extra_jitter_ms: 0,
    interference_db: 0,
  });
});

Deno.test("timeline: entries after `since`, without serial lines or raw transmissions, capped at the newest", () => {
  const events: EngineEvent[] = [
    { seq: 0, t: 1, type: "serial", node: "a", text: "boot" },
    { seq: 1, t: 2, type: "tx", node: "a", bytes: 100, kind: "udp", dst: "x", src: "y" },
    outcome(2, 3, "a", "b", true),
    outcome(3, 4, "a", "b", false),
    { seq: 4, t: 5, type: "move", node: "a", position: { x: 1, y: 2 } },
    { seq: 5, t: 6, type: "phase", label: "far" },
    { seq: 6, t: 7, type: "serial", node: "a", text: "late" },
  ];
  const all = timelineSince(events, -1);
  assertEquals(all.entries.map((e) => e.type), ["deliver", "drop", "move", "phase"]);
  assertEquals(all.next_since, 6);
  assertEquals(all.truncated, false);
  const drop = all.entries[1]!;
  assert(drop.type === "drop");
  assertEquals(drop.reason, "retry_exhausted");

  const later = timelineSince(events, 3);
  assertEquals(later.entries.map((e) => e.seq), [4, 5]);
  const none = timelineSince(events, 6);
  assertEquals(none, { entries: [], next_since: 6, truncated: false });

  const capped = timelineSince(events, -1, 2);
  assertEquals(capped.entries.map((e) => e.seq), [4, 5]);
  assertEquals(capped.truncated, true);
  assert(TIMELINE_CAP >= 1000);
});

// ── The server, through the real commands ───────────────────────────────────

/** A spawned command whose stderr is read as it comes, so a test can wait for a line. */
class Spawned {
  readonly child: Deno.ChildProcess;
  #stderr = "";
  readonly #draining: Promise<void>;

  constructor(args: string[], stdin: "piped" | "null" = "null") {
    this.child = new Deno.Command(Deno.execPath(), {
      args: ["run", ...PERMISSIONS, MAIN, ...args],
      stdin,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const stderr = this.child.stderr;
    this.#draining = (async () => {
      for await (const chunk of stderr.pipeThrough(new TextDecoderStream())) {
        this.#stderr += chunk;
      }
    })();
  }

  get stderr(): string {
    return this.#stderr;
  }

  async waitFor(pattern: RegExp, timeoutMs = 20_000): Promise<RegExpMatchArray> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const match = this.#stderr.match(pattern);
      if (match) return match;
      if (performance.now() > deadline) {
        throw new Error(`timed out waiting for ${pattern} on stderr:\n${this.#stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** Wait for an exit that is already on its way, and for the last of stderr. */
  async exited(): Promise<number> {
    const status = await this.child.status;
    await this.#draining;
    return status.code;
  }

  /** Signal it and wait for the exit; returns the exit code and what it printed. */
  async interrupt(): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      this.child.kill("SIGINT");
    } catch (error) {
      // It exited on its own; the code and stderr below say why.
      if (!(error instanceof TypeError)) throw error;
    }
    const [status, stdout] = await Promise.all([
      this.child.status,
      new Response(this.child.stdout).text(),
    ]);
    await this.#draining;
    return { code: status.code, stdout, stderr: this.#stderr };
  }
}

async function getView(base: string, since = -1): Promise<Json> {
  const response = await fetch(`${base}api/view?since=${since}`);
  assertEquals(response.status, 200);
  return await response.json();
}

async function pollView(base: string, done: (view: Json) => boolean, what: string) {
  const deadline = performance.now() + 20_000;
  for (;;) {
    const view = await getView(base);
    if (done(view)) return view;
    if (performance.now() > deadline) {
      throw new Error(`timed out waiting for ${what}: ${JSON.stringify(view.status)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function postMove(
  base: string,
  body: unknown,
  headers: Record<string, string> = { "content-type": "application/json" },
): Promise<{ status: number; body: string }> {
  const response = await fetch(`${base}api/move`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.text() };
}

/** One HTTP/1.1 request written by hand, for headers fetch will not let a test forge. */
async function rawGet(port: number, path: string, host: string): Promise<string> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    const request = `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`;
    await conn.write(new TextEncoder().encode(request));
    return await new Response(conn.readable).text();
  } catch (error) {
    conn.close();
    throw error;
  }
}

Deno.test("view: serves the live map, moves a node through move_node, refuses foreign writes, stops on SIGINT", async () => {
  const dir = await Deno.makeTempDir({ prefix: "hzb-view-" });
  const view = new Spawned(["view", LIVE, "--port", "0", "--out", `${dir}/out`]);
  try {
    const [, base, port] = await view.waitFor(/view: (http:\/\/127\.0\.0\.1:(\d+)\/)/);
    const url = base!;

    const running = await pollView(
      url,
      (v) =>
        v.status.state === "running" && v.scene.links.length === 6 && v.timeline.entries.length > 0,
      "a running scene with traffic",
    );
    assertEquals(running.status.scenario, "live-3-scripted");
    assertEquals(running.scene.obstacles, [{ from: [30, -20], to: [30, 20], attenuation_db: 12 }]);
    const ca = running.scene.links.find((l: Json) => l.from === "c" && l.to === "a");
    assertEquals(ca.signal, "good");
    assert(running.timeline.entries.some((e: Json) => e.type === "deliver"));

    // The drag from the page: the same move_node tool an agent calls.
    const moved = await postMove(url, { node: "c", position: [42, 0] });
    assertEquals(moved.status, 200, moved.body);
    assertEquals(JSON.parse(moved.body).to, { x: 42, y: 0 });
    const after = await getView(url, running.timeline.next_since);
    assertEquals(after.status.nodes.find((n: Json) => n.id === "c").position, { x: 42, y: 0 });
    const farLink = after.scene.links.find((l: Json) => l.from === "c" && l.to === "a");
    assertEquals(farLink.signal, "bad");
    assertEquals(farLink.distance_m, 42);
    assert(
      after.timeline.entries.some((e: Json) => e.type === "move" && e.node === "c"),
      "the move is on the timeline",
    );

    // Tool errors come back as 400 with the tool's message.
    const unknown = await postMove(url, { node: "zz", position: [1, 1] });
    assertEquals(unknown.status, 400);
    assertStringIncludes(unknown.body, "no node named");

    // Writes another web page could send are refused (CWE-352).
    assertEquals(
      (await postMove(url, { node: "c", position: [1, 1] }, { "content-type": "text/plain" }))
        .status,
      415,
    );
    const foreign = await postMove(url, { node: "c", position: [1, 1] }, {
      "content-type": "application/json",
      origin: "http://example.com",
    });
    assertEquals(foreign.status, 403);
    const stayed = await getView(url);
    assertEquals(stayed.status.nodes.find((n: Json) => n.id === "c").position, { x: 42, y: 0 });

    // A name that is not this server is refused, even on loopback (DNS rebinding, CWE-350).
    const rebound = await rawGet(Number(port), "/api/view", `attacker.example:${port}`);
    assertStringIncludes(rebound, "403");
    assertStringIncludes(await rawGet(Number(port), "/api/view", `localhost:${port}`), "200 OK");

    // The page, its assets with a strict CSP, and Velxio's tokens read from frontend/.
    const page = await fetch(url);
    assertStringIncludes(page.headers.get("content-security-policy") ?? "", "script-src 'self'");
    assertStringIncludes(await page.text(), '<script src="/app.js"');
    for (const asset of ["app.js", "style.css"]) {
      const response = await fetch(`${url}${asset}`);
      assertEquals(response.status, 200, asset);
      await response.body?.cancel();
    }
    const tokens = await fetch(`${url}velxio/tokens/colors.css`);
    assertStringIncludes(await tokens.text(), "--color-bg-canvas");
    const board = await fetch(`${url}velxio/boards/esp32-devkit-v1.svg`);
    assertEquals(board.headers.get("content-type"), "image/svg+xml");
    await board.body?.cancel();
    for (
      const path of ["velxio/tokens/../../../deno.json", "velxio/boards/arduino-uno.svg", "nope"]
    ) {
      const response = await fetch(`${url}${path}`);
      assertEquals(response.status, 404, path);
      await response.body?.cancel();
    }
  } finally {
    const { code, stderr } = await view.interrupt();
    await Deno.remove(dir, { recursive: true });
    assertEquals(code, 0, stderr);
    assert(!stderr.includes("stays up"), stderr);
  }
});

Deno.test("view: an invalid scenario exits 2 before serving", async () => {
  const dir = await Deno.makeTempDir({ prefix: "hzb-view-" });
  try {
    await Deno.writeTextFile(`${dir}/bad.yaml`, "name: bad\nnodes: []\n");
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["run", ...PERMISSIONS, MAIN, "view", `${dir}/bad.yaml`, "--port", "0"],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stderr = new TextDecoder().decode(output.stderr);
    assertEquals(output.code, 2, stderr);
    assert(!stderr.includes("view: http"), stderr);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mcp --view-port: the page draws the agent's run, and a drag shows up in get_status", async () => {
  const workspace = await Deno.makeTempDir({ prefix: "hzb-view-mcp-" });
  const server = new Spawned(["mcp", "--workspace", workspace, "--view-port", "0"], "piped");
  const writer = server.child.stdin.getWriter();
  const lines = server.child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  let nextId = 1;
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Json> => {
    const id = nextId++;
    const message = { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
    await writer.write(new TextEncoder().encode(JSON.stringify(message) + "\n"));
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline >= 0) {
        const response = JSON.parse(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        if (response.id !== id) continue;
        const result = response.result;
        assert(!result.isError, `${name}: ${result.content[0].text}`);
        return JSON.parse(result.content[0].text);
      }
      const { value, done } = await lines.read();
      if (done) throw new Error(`the server closed stdout; stderr:\n${server.stderr}`);
      buffered += value;
    }
  };
  try {
    const [, url] = await server.waitFor(/view: (http:\/\/127\.0\.0\.1:\d+\/)/);
    const idle = await getView(url!);
    assertEquals(idle.status.state, "idle");
    assertEquals(idle.scene, null);

    await call("run_scenario", { path: LIVE });
    await pollView(url!, (v) => v.status.state === "running", "the agent's run to be running");
    const moved = await postMove(url!, { node: "b", position: [20, 5] });
    assertEquals(moved.status, 200, moved.body);
    const status = await call("get_status");
    assertEquals(status.nodes.find((n: Json) => n.id === "b").position, { x: 20, y: 5 });
    await call("stop");
    const stopped = await getView(url!);
    assertEquals(stopped.status.state, "stopped");
  } finally {
    await writer.close();
    await lines.cancel();
    const code = await server.exited();
    await Deno.remove(workspace, { recursive: true });
    assertEquals(code, 0, server.stderr);
  }
});

Deno.test("scene links: a chip-level link is judged by its PHY's floor and shows its own bit rate", () => {
  const [near, far] = sceneLinks(
    [
      { from: "n1", to: "gw", budget: { ...budget(300, -110, -4), signal: LORA_SF7 } },
      { from: "n6", to: "gw", budget: { ...budget(1800, -135, -15), signal: LORA_SF7 } },
    ],
    [],
    1000,
  );
  assertEquals(near!.signal, "good");
  assertEquals(near!.rate_bps, 5468.75);
  assertEquals(near!.required_snr_db, -7.5);
  assertEquals(far!.signal, "bad");
});

Deno.test("view: a LoRa run draws its link budgets, and a drag moves the node and its budget", async () => {
  const dir = await Deno.makeTempDir({ prefix: "hzb-view-lora-" });
  const view = new Spawned(["view", LORA, "--port", "0", "--out", `${dir}/out`]);
  try {
    const [, url] = await view.waitFor(/view: (http:\/\/127\.0\.0\.1:\d+\/)/);
    const running = await pollView(
      url!,
      (v) =>
        v.status.state === "running" &&
        v.timeline.entries.some((e: Json) => e.type === "deliver"),
      "a running LoRa scene with a delivered packet",
    );
    // Seven stations, every directed pair, each with the LoRa budget the chip model would use.
    assertEquals(running.scene.phy, "lora");
    assertEquals(running.scene.links.length, 42);
    const link = (from: string) =>
      running.scene.links.find((l: Json) => l.from === from && l.to === "gw");
    assertEquals(link("node-1").signal, "good");
    assertEquals(link("node-6").signal, "bad");
    assertEquals(link("node-1").required_snr_db, -7.5);
    assertEquals(Math.round(link("node-1").rate_bps), 5469);

    const moved = await postMove(url!, { node: "node-6", position: [100, 0] });
    assertEquals(moved.status, 200, moved.body);
    const toGw = JSON.parse(moved.body).links.find((l: Json) => l.link === "node-6->gw");
    assertEquals(toGw.distance_m, 100);
    assert(
      toGw.snr_db > link("node-1").snr_db,
      "at 100 m node-6 hears better than node-1 at 300 m",
    );
    const after = await getView(url!);
    assertEquals(after.status.nodes.find((n: Json) => n.id === "node-6").position, {
      x: 100,
      y: 0,
    });
  } finally {
    const { code, stderr } = await view.interrupt();
    await Deno.remove(dir, { recursive: true });
    assertEquals(code, 0, stderr);
  }
});
