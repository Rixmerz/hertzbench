import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { computeMetrics, type EngineEvent } from "../engine/mod.ts";
import {
  BoardError,
  type BoardLauncher,
  evaluateAssertions,
  expandLinkRule,
  type LiveRun,
  loadScenario,
  metricsDocument,
  parseScenario,
  renderReport,
  RunInterrupted,
  runScenario,
  scriptedLauncher,
} from "../orchestrator/mod.ts";
import { simulateScenarioTraffic } from "./helpers.ts";

const EXAMPLES = fileURLToPath(new URL("../scenarios/examples/", import.meta.url));

// ── assertions ──────────────────────────────────────────────────────────────

function deliver(t: number, from: string, to: string, delayMs: number): EngineEvent {
  return {
    type: "deliver",
    t,
    seq: 0,
    from,
    to,
    bytes: 100,
    kind: "udp",
    delayMs,
    attempts: 1,
    rateMbps: 54,
    rssiDbm: -60,
    snrDb: 30,
  };
}

function drop(t: number, from: string, to: string): EngineEvent {
  return {
    type: "drop",
    t,
    seq: 0,
    from,
    to,
    bytes: 100,
    kind: "udp",
    reason: "retry_exhausted",
    attempts: 7,
    rssiDbm: -90,
    snrDb: 1,
  };
}

const serial = (t: number, node: string, text: string): EngineEvent => ({
  type: "serial",
  t,
  seq: 0,
  node,
  text,
});

Deno.test("assertions: serial contains, with and without a deadline", () => {
  const scenario = parseScenario(`
name: s
duration: 10s
nodes:
  - { id: gw, board: scripted, position: [0, 0] }
  - { id: s1, board: scripted, position: [1, 0] }
assertions:
  - serial: { node: gw, contains: "received from sensor", within: 5s }
  - serial: { node: gw, contains: "received from sensor", within: 1s }
  - serial: { node: gw, contains: "never printed" }
  - serial: { node: s1, contains: "received from sensor" }
`);
  const events = [serial(2000, "gw", "received from sensor-4 seq=1")];
  const results = evaluateAssertions(scenario.assertions, events, []);
  assertEquals(results.map((r) => r.passed), [true, false, false, false]);
  assertEquals(results[0]!.detail, "seen at 2000 ms");
});

Deno.test("assertions: metric thresholds, per phase, per frame kind, with link patterns", () => {
  const scenario = parseScenario(`
name: m
duration: 10s
nodes:
  - { id: gw, board: scripted, position: [0, 0] }
  - { id: s1, board: scripted, position: [1, 0] }
  - { id: s2, board: scripted, position: [2, 0] }
timeline:
  - { at: 5s, label: far, move: { node: s2, to: [90, 0] } }
assertions:
  - metric: { link: "s*->gw", phase: start, loss_pct: { lt: 1 }, latency_p95_ms: { lt: 1 } }
  - metric: { link: "s2->gw", phase: far, loss_pct: { gt: 50 } }
  - metric: { link: "s1->gw", phase: far, loss_pct: { eq: 0 }, delivered: { gte: 2 } }
  - metric: { link: "s2->gw", phase: far, latency_p95_ms: { lt: 1 } }
  - metric: { link: "gw->s1", loss_pct: { lt: 1 } }
  - metric: { link: "s1->gw", kind: tcp, loss_pct: { lt: 1 } }
`);
  const events: EngineEvent[] = [
    deliver(100, "s1", "gw", 0.4),
    deliver(200, "s2", "gw", 0.5),
    { type: "phase", t: 5000, seq: 0, label: "far" },
    deliver(5100, "s1", "gw", 0.4),
    deliver(5200, "s1", "gw", 0.4),
    drop(5300, "s2", "gw"),
    drop(5400, "s2", "gw"),
  ];
  const metrics = computeMetrics(events, 10_000);
  const results = evaluateAssertions(scenario.assertions, events, metrics.phases);
  assertEquals(results.map((r) => r.passed), [true, true, true, false, false, false]);
  assert(results[3]!.detail.includes("nothing was delivered"));
  assert(results[4]!.detail.includes("no frames crossed"));
  assert(results[5]!.detail.includes("no frames crossed"));
});

// ── the example scenarios' geometry, judged by the engine alone ──────────────

for (const file of ["udp-3-nodes.yaml", "udp-3-scripted.yaml"]) {
  Deno.test(`example ${file}: the walk behind the wall degrades c->a and leaves c->b alone`, async () => {
    const { scenario } = await loadScenario(`${EXAMPLES}${file}`);
    // What the sketch sends: "ping:<n>" in a UDP datagram, every node to every other.
    const rig = simulateScenarioTraffic(scenario, { everyMs: 200, payloadBytes: 10 });
    const metrics = computeMetrics(rig.log.events, scenario.durationMs);
    const metricAssertions = scenario.assertions.filter((a) => a.kind === "metric");
    assert(metricAssertions.length >= 3, "the example should assert on the experiment");
    const results = evaluateAssertions(metricAssertions, rig.log.events, metrics.phases);
    for (const r of results) assert(r.passed, `${r.description}: ${r.detail}`);

    // And the measurable claim itself, read straight off the phases.
    const near = metrics.phases.find((p) => p.label === "start")!.links.find((l) =>
      l.from === "c" && l.to === "a"
    )!;
    const far = metrics.phases.find((p) => p.label === "behind-wall")!.links.find((l) =>
      l.from === "c" && l.to === "a"
    )!;
    assert(far.lossPct > near.lossPct + 20, `loss ${near.lossPct} -> ${far.lossPct}`);
    assert(far.latencyMs!.p95 > 4 * near.latencyMs!.p95, "p95 latency should at least quadruple");
    assert(far.rssiDbm < near.rssiDbm - 15);
  });
}

Deno.test("example udp-3-nodes.yaml is a valid 3-board ESP32 scenario", async () => {
  const { scenario } = await loadScenario(`${EXAMPLES}udp-3-nodes.yaml`);
  assertEquals(scenario.nodes.map((n) => [n.id, n.board]), [["a", "esp32"], ["b", "esp32"], [
    "c",
    "esp32",
  ]]);
  assertEquals(
    new Set(scenario.nodes.map((n) => n.firmware.kind === "sketch" && n.firmware.path)).size,
    1,
  );
});

// ── runner ──────────────────────────────────────────────────────────────────

const TWO_NODES = `
name: runner
seed: 3
duration: 1s
environment: { shadowing_sigma_db: 0 }
nodes:
  - id: a
    board: scripted
    position: [0, 0]
    firmware: { send: [{ to: b, every: 50ms, count: 10 }] }
  - { id: b, board: scripted, position: [5, 0], firmware: {} }
`;

async function runFrom(yaml: string, launchers?: Record<string, BoardLauncher>) {
  const dir = await Deno.makeTempDir({ prefix: "hzb-run-" });
  try {
    const file = `${dir}/s.yaml`;
    await Deno.writeTextFile(file, yaml);
    const loaded = await loadScenario(file, `${dir}/out`);
    const result = await runScenario(loaded.scenario, {
      outDir: loaded.outDir,
      outputs: loaded.outputs,
      launchers,
    });
    return { result, dir, loaded };
  } catch (error) {
    await Deno.remove(dir, { recursive: true });
    throw error;
  }
}

Deno.test("runner: a scripted run delivers its datagrams and writes every output", async () => {
  const { result, dir, loaded } = await runFrom(TWO_NODES);
  try {
    assert(result.passed, JSON.stringify(result.problems));
    const ab = result.metrics.total.find((l) => l.from === "a" && l.to === "b")!;
    assertEquals([ab.sent, ab.delivered], [10, 10]);
    for (const path of Object.values(loaded.outputs)) {
      assert((await Deno.stat(path)).size > 0, path);
    }
    const doc = JSON.parse(await Deno.readTextFile(loaded.outputs.metrics));
    assertEquals(doc.schema, 2);
    assertEquals(doc.latency, "modelled");
    assertEquals(doc.passed, true);
    assert(renderReport(result).includes("RESULT: PASS"));
    assertEquals(metricsDocument(result).links.length, result.metrics.total.length);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runner: a scenario link rule forces loss on that direction only", async () => {
  const yaml = TWO_NODES.replace(
    "firmware: { send: [{ to: b, every: 50ms, count: 10 }] }",
    "firmware: { send: [{ to: b, every: 50ms, count: 10 }] }\n",
  ) + "links: [{ from: a, to: b, extra_loss_pct: 100 }]\n";
  const { result, dir } = await runFrom(yaml);
  try {
    const ab = result.metrics.total.find((l) => l.from === "a" && l.to === "b")!;
    assertEquals([ab.delivered, ab.dropped.extra_loss], [0, 10]);
    const pongs = result.metrics.total.find((l) => l.from === "b" && l.to === "a");
    assertEquals(pongs, undefined, "no ping arrived, so no pong went back");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runner: live control at time zero lands in the log like the timeline, then closes", async () => {
  const dir = await Deno.makeTempDir({ prefix: "hzb-run-" });
  try {
    const file = `${dir}/s.yaml`;
    await Deno.writeTextFile(file, TWO_NODES);
    const loaded = await loadScenario(file, `${dir}/out`);
    let live: LiveRun | undefined;
    let pairs: [string, string][] = [];
    let rssiBefore = 0;
    const result = await runScenario(loaded.scenario, {
      outDir: loaded.outDir,
      outputs: loaded.outputs,
      onUnderway: (run) => {
        live = run;
        rssiBefore = run.budget("a", "b").rssiDbm;
        run.startPhase("live");
        run.moveNode("b", { x: 40, y: 0 });
        pairs = run.setLink({ from: "a", to: "*", extraLossPct: 100, extraLatencyMs: 0 });
      },
    });
    assert(live, "onUnderway was called");
    assertEquals(pairs, [["a", "b"]]);
    assert(live.budget("a", "b").rssiDbm < rssiBefore - 10, "moving b 35 m away costs signal");
    assertEquals(live.position("b"), { x: 40, y: 0 });
    const ab = result.metrics.total.find((l) => l.from === "a" && l.to === "b")!;
    assert((ab.dropped.extra_loss ?? 0) > 0, JSON.stringify(ab));
    assertEquals(ab.delivered, 0);
    assert(result.events.some((e) => e.type === "move" && e.node === "b"));
    assert(result.metrics.phases.some((p) => p.label === "live"));
    assertEquals(live.events().length, result.events.length, "readers work after the end");
    assertEquals(live.active, false);
    assertThrows(() => live!.moveNode("b", { x: 0, y: 0 }), Error, "the run has ended");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runner: a failing assertion fails the run", async () => {
  const yaml = TWO_NODES + `assertions: [{ metric: { link: "a->b", loss_pct: { gt: 50 } } }]\n`;
  const { result, dir } = await runFrom(yaml);
  try {
    assertEquals(result.passed, false);
    assertEquals(result.assertions[0]!.passed, false);
    assert(renderReport(result).includes("RESULT: FAIL"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runner: a board that cannot start aborts the run and releases everything", async () => {
  const failing: BoardLauncher = {
    fidelity: "test",
    start() {
      return Promise.reject(new BoardError("boom: libqemu missing"));
    },
  };
  // Deno's leak sanitizer fails this test if the listeners, sockets or timers outlive the call.
  await assertRejects(() => runFrom(TWO_NODES, { scripted: failing }), BoardError, "boom");
});

Deno.test("runner: a problem during the run is reported and fails the run", async () => {
  const noisy: BoardLauncher = {
    fidelity: "test",
    async start(ctx) {
      const inner = await scriptedLauncher.start(ctx);
      // Once the run is underway, as a worker that dies mid-run would.
      if (ctx.node.id === "b") {
        ctx.clock.schedule(
          ctx.clock.now() + 300,
          () => ctx.onProblem("b: worker exited early (code 1)"),
        );
      }
      return inner;
    },
  };
  const { result, dir } = await runFrom(TWO_NODES, { scripted: noisy });
  try {
    assertEquals(result.passed, false);
    assertEquals(result.problems, ["b: worker exited early (code 1)"]);
    assertEquals(result.metrics.total.find((l) => l.from === "a")?.delivered, 10);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runner: a board that reports a problem while starting ends the run at once, listing it", async () => {
  const dying: BoardLauncher = {
    fidelity: "test",
    start(ctx) {
      if (ctx.node.id === "b") ctx.onProblem("b: worker exited early (code 1); see /tmp/x.log");
      // It never connects, so only fail-fast can end the wait before the 30 s timeout.
      return Promise.resolve({ clockDescription: "test", stop: () => Promise.resolve() });
    },
  };
  const started = performance.now();
  const error = await assertRejects(() => runFrom(TWO_NODES, { scripted: dying }), BoardError);
  assert(
    performance.now() - started < 5000,
    "start-up failure must not wait for the connect timeout",
  );
  assert(error.message.includes("b: worker exited early (code 1); see /tmp/x.log"), error.message);
});

Deno.test("runner: the internet gateway gets no medium port and no lease; others do", async () => {
  const seen = new Map<string, number | null>();
  const recording: BoardLauncher = {
    fidelity: "test",
    start(ctx) {
      seen.set(ctx.node.id, ctx.netPort);
      return Promise.resolve({ clockDescription: "test", stop: () => Promise.resolve() });
    },
  };
  const yaml = `
name: gw
seed: 1
duration: 200ms
nodes:
  - { id: a, board: scripted, position: [0, 0] }
  - { id: b, board: scripted, position: [5, 0] }
  - { id: net, board: esp32, firmware: ./x.bin, position: [9, 9], internet_gateway: true }
`;
  // The recording launcher never connects, so the run cannot reach its duration:
  // a short startup timeout turns that into the error this test wants to see.
  const dir = await Deno.makeTempDir({ prefix: "hzb-gw-" });
  try {
    await Deno.writeTextFile(`${dir}/s.yaml`, yaml);
    const loaded = await loadScenario(`${dir}/s.yaml`, `${dir}/out`);
    await assertRejects(
      () =>
        runScenario(loaded.scenario, {
          outDir: loaded.outDir,
          outputs: loaded.outputs,
          launchers: { scripted: recording, esp32: recording },
          startupTimeoutMs: 100,
        }),
      Error,
      "did not connect",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
  assert(typeof seen.get("a") === "number" && typeof seen.get("b") === "number");
  assertEquals(seen.get("net"), null);
});

Deno.test("link rules expand patterns to ordered pairs, never to self", () => {
  const rule = { from: "sensor-*", to: "gw", extraLossPct: 10, extraLatencyMs: 0 };
  assertEquals(expandLinkRule(rule, ["gw", "sensor-1", "sensor-2"]), [
    ["sensor-1", "gw"],
    ["sensor-2", "gw"],
  ]);
  assertEquals(expandLinkRule({ ...rule, from: "*", to: "*" }, ["a", "b"]).length, 2);
});

Deno.test("runner: aborting ends a long run promptly, stops every board and releases everything", async () => {
  const stopped: string[] = [];
  const tracking: BoardLauncher = {
    fidelity: "test",
    async start(ctx) {
      const inner = await scriptedLauncher.start(ctx);
      return {
        clockDescription: inner.clockDescription,
        async stop() {
          stopped.push(ctx.node.id);
          await inner.stop();
        },
      };
    },
  };
  const dir = await Deno.makeTempDir({ prefix: "hzb-abort-" });
  try {
    await Deno.writeTextFile(`${dir}/s.yaml`, TWO_NODES.replace("duration: 1s", "duration: 10m"));
    const loaded = await loadScenario(`${dir}/s.yaml`, `${dir}/out`);
    const controller = new AbortController();
    const started = performance.now();
    setTimeout(() => controller.abort(), 300);
    await assertRejects(
      () =>
        runScenario(loaded.scenario, {
          outDir: loaded.outDir,
          outputs: loaded.outputs,
          launchers: { scripted: tracking },
          signal: controller.signal,
        }),
      RunInterrupted,
    );
    assert(performance.now() - started < 5000, "an abort must not wait out the duration");
    assertEquals(stopped.sort(), ["a", "b"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runner: a board that fails to start does not leave its sibling running", async () => {
  const stopped: string[] = [];
  const mixed: BoardLauncher = {
    fidelity: "test",
    async start(ctx) {
      if (ctx.node.id === "b") throw new BoardError("b failed to start");
      const inner = await scriptedLauncher.start(ctx);
      // Make "a" finish starting after "b" has already failed.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        clockDescription: inner.clockDescription,
        async stop() {
          stopped.push(ctx.node.id);
          await inner.stop();
        },
      };
    },
  };
  await assertRejects(() => runFrom(TWO_NODES, { scripted: mixed }), BoardError, "b failed");
  assertEquals(stopped, ["a"]);
});

Deno.test("runner: ten boards, the top of the 2 to 10 range, all get their lease and talk over 90 links", async () => {
  const nodes = Array.from({ length: 10 }, (_, i) => {
    const next = `n${(i + 1) % 10}`;
    const prev = `n${(i + 9) % 10}`;
    return `  - id: n${i}
    board: scripted
    position: [${i * 4}, 0]
    firmware: { send: [{ to: ${next}, every: 100ms, count: 8 }, { to: ${prev}, every: 100ms, count: 8 }] }`;
  });
  const yaml = `name: ten\nseed: 5\nduration: 2s\nenvironment: { shadowing_sigma_db: 0 }\nnodes:\n${
    nodes.join("\n")
  }\n`;
  const { result, dir } = await runFrom(yaml);
  try {
    assert(result.passed, JSON.stringify(result.problems));
    assertEquals(
      result.nodes.map((n) => n.ip),
      Array.from({ length: 10 }, (_, i) => `192.168.4.${11 + i}`),
    );
    assertEquals(result.nodes[9]!.mac, "02:68:7a:62:01:0a");
    for (const node of result.nodes) {
      const bound = result.events.some((e) =>
        e.type === "serial" && e.node === node.id && e.text === `dhcp bound ip=${node.ip}`
      );
      assert(bound, `${node.id} never got ${node.ip}`);
    }
    // Every board broadcast nothing but unicast here; each ring neighbour saw its pings.
    const links = new Set(result.metrics.total.map((l) => `${l.from}>${l.to}`));
    for (let i = 0; i < 10; i++) {
      assert(links.has(`n${i}>n${(i + 1) % 10}`), `n${i} never reached its next neighbour`);
      assert(links.has(`n${i}>n${(i + 9) % 10}`), `n${i} never reached its previous neighbour`);
    }
    const delivered = result.metrics.total.reduce((sum, l) => sum + l.delivered, 0);
    assert(delivered >= 10 * 2 * 8, `only ${delivered} frames delivered`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runner: traffic before time zero is kept, with negative times, and the log never steps back", async () => {
  // Board c connects 200 ms after a and b, which have already run DHCP by then.
  // a sends for 450 ms from its lease, so its traffic spans time zero even when
  // the 200 ms wait overshoots (Windows timers tick every 15.6 ms).
  const slowC: BoardLauncher = {
    fidelity: "test",
    async start(ctx) {
      if (ctx.node.id === "c") await new Promise((resolve) => setTimeout(resolve, 200));
      return scriptedLauncher.start(ctx);
    },
  };
  const yaml = `name: late
seed: 2
duration: 1s
environment: { shadowing_sigma_db: 0 }
nodes:
  - id: a
    board: scripted
    position: [0, 0]
    firmware: { send: [{ to: b, every: 50ms, count: 10 }] }
  - { id: b, board: scripted, position: [5, 0], firmware: {} }
  - { id: c, board: scripted, position: [9, 0], firmware: {} }
assertions:
  - serial: { node: a, contains: "dhcp bound", within: 1s }
  - metric: { link: "a->b", loss_pct: { lt: 1 } }
`;
  const { result, dir } = await runFrom(yaml, { scripted: slowC });
  try {
    assert(result.passed, JSON.stringify(result.assertions));
    const times = result.events.map((e) => e.t);
    assert(times.some((t) => t < 0), "a and b should have talked before c connected");
    times.forEach((t, i) => {
      if (i > 0) assert(t >= times[i - 1]!, `event ${i} at ${t} follows ${times[i - 1]}`);
    });
    // Pre-zero frames are in the log but not in the measured window.
    const early = result.events.filter((e) =>
      e.t < 0 && (e.type === "deliver" || e.type === "drop")
    );
    const counted = result.metrics.total.reduce((sum, l) => sum + l.sent, 0);
    const all = result.events.filter((e) => e.type === "deliver" || e.type === "drop").length;
    assertEquals(counted, all - early.length);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
