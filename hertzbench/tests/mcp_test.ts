// The MCP server through its real entrypoint: `hertzbench mcp` as a separate
// process, spoken to over stdin and stdout the way Claude Code does.

import { join, sep } from "node:path";
import { signalTest } from "./platform.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  EXAMPLES,
  type Json,
  McpClient,
  pollMetrics,
  pollStatus,
  withServer,
} from "./mcp_client.ts";

const TOOLS = [
  "add_node",
  "create_scenario",
  "edit_scenario",
  "export_capture",
  "get_events",
  "get_metrics",
  "get_report",
  "get_serial",
  "get_status",
  "get_view_state",
  "inject_fault",
  "list_boards",
  "move_node",
  "mqtt_publish",
  "open_view",
  "read_scenario",
  "remove_node",
  "run_scenario",
  "send_payload",
  "send_serial",
  "set_channel",
  "set_radio",
  "start_phase",
  "stop",
  "validate_scenario",
];

const SHORT = `name: two-nodes
seed: 5
duration: 1500ms
environment: { shadowing_sigma_db: 0 }
nodes:
  - id: a
    board: scripted
    position: [0, 0]
    firmware: { send: [{ to: b, every: 50ms, count: 10 }] }
  - { id: b, board: scripted, position: [5, 0], firmware: {} }
assertions:
  - serial: { node: b, contains: "rx ping:9 from a" }
  - metric: { link: "a->b", kind: udp, delivered: { eq: 10 } }
`;

Deno.test("mcp: handshake, every tool, resources and protocol errors", async () => {
  await withServer(async (client) => {
    const fresh = new McpClient(Deno.cwd());
    const init = await fresh.request("initialize", { protocolVersion: "1999-01-01" });
    assertEquals(init.result?.protocolVersion, "2025-11-25", "an unknown version gets our newest");
    assertEquals((await fresh.close()).code, 0);

    const tools = await client.request("tools/list");
    const listed = tools.result!.tools as { name: string; inputSchema: { type: string } }[];
    assertEquals(listed.map((t) => t.name).sort(), TOOLS);
    assert(listed.every((t) => t.inputSchema.type === "object"));

    assertEquals((await client.request("ping")).result, {});
    assertEquals((await client.request("no/such/method")).error?.code, -32601);
    assertEquals((await client.request("tools/call", { name: "frobnicate" })).error?.code, -32602);
    await client.send("this is not json");

    const resources = await client.request("resources/list");
    const uris = (resources.result!.resources as { uri: string }[]).map((r) => r.uri);
    for (
      const uri of [
        "hertzbench://docs/fidelity.md",
        "hertzbench://docs/scenario-format.md",
        "hertzbench://examples/udp-3-scripted.yaml",
        "hertzbench://examples/udp-3-nodes.yaml",
        "hertzbench://examples/live-3-scripted.yaml",
      ]
    ) assert(uris.includes(uri), `${uri} in ${uris.join(", ")}`);
    const fidelity = await client.request("resources/read", {
      uri: "hertzbench://docs/fidelity.md",
    });
    const contents = fidelity.result!.contents as { text: string; mimeType: string }[];
    assertStringIncludes(contents[0]!.text, "| `scripted` board | **none** |");
    assertEquals(contents[0]!.mimeType, "text/markdown");
    const example = await client.request("resources/read", {
      uri: "hertzbench://examples/udp-3-scripted.yaml",
    });
    assertEquals(
      (example.result!.contents as { text: string }[])[0]!.text,
      await Deno.readTextFile(`${EXAMPLES}udp-3-scripted.yaml`),
    );
    assertEquals(
      (await client.request("resources/read", { uri: "hertzbench://nope" })).error?.code,
      -32002,
    );
    assertEquals(client.unmatched.map((r) => r.error?.code), [-32700]);

    const boards = await client.ok("list_boards");
    const byKind = Object.fromEntries(
      boards.boards.map((b: Json) => [b.board, b]),
    );
    assertEquals(byKind.esp32.names, ["esp32", "esp32-devkit-v1"]);
    assertEquals(byKind.esp32.available, false);
    assertStringIncludes(byKind.esp32.detail, "libqemu-xtensa not found");
    assertEquals(byKind.scripted.available, true);
    assertStringIncludes(byKind.scripted.fidelity, "none");

    assertStringIncludes(await client.refused("get_status", { verbose: true }), "unknown argument");
    assertEquals((await client.ok("get_status")).state, "idle");
    assertStringIncludes(await client.refused("get_metrics"), "no run yet");
  }, { QEMU_ESP32_LIB: "/nonexistent/libqemu-xtensa.so" });
});

Deno.test("mcp: create, validate and run a scenario to the end, outputs inside the workspace", async () => {
  await withServer(async (client, workspace) => {
    const created = await client.ok("create_scenario", { path: "s/two.yaml", yaml: SHORT });
    assertEquals(created.file, join(workspace, "s", "two.yaml"));
    assertEquals(created.scenario.nodes.map((n: { ip: string }) => n.ip), [
      "192.168.4.11",
      "192.168.4.12",
    ]);
    assertEquals(created.missing_firmware, []);
    assertEquals(await Deno.readTextFile(`${workspace}/s/two.yaml`), SHORT);

    assertStringIncludes(
      await client.refused("create_scenario", { path: "s/two.yaml", yaml: SHORT }),
      "overwrite: true",
    );
    await client.ok("create_scenario", { path: "s/two.yaml", yaml: SHORT, overwrite: true });
    assertStringIncludes(
      await client.refused("create_scenario", { path: "../escape.yaml", yaml: SHORT }),
      "inside the workspace",
    );
    const invalid = await client.refused("create_scenario", {
      path: "bad.yaml",
      yaml: SHORT.replace("duration: 1500ms", "duration: 15"),
    });
    assertStringIncludes(invalid, "duration");
    let written = true;
    try {
      await Deno.stat(`${workspace}/bad.yaml`);
    } catch {
      written = false;
    }
    assertEquals(written, false, "an invalid scenario is not written");

    const missingFw = await client.ok("create_scenario", {
      path: "esp.yaml",
      yaml: `name: esp\nduration: 1s\nnodes:\n` +
        `  - { id: a, board: esp32, firmware: ./fw/a, position: [0, 0] }\n` +
        `  - { id: b, board: esp32, firmware: ./fw/a, position: [5, 0] }\n`,
    });
    assertEquals(missingFw.missing_firmware.length, 2);
    assertStringIncludes(
      await client.refused("validate_scenario", { path: "esp.yaml" }),
      "does not exist",
    );
    assertStringIncludes(
      await client.refused("run_scenario", { path: "esp.yaml" }),
      "does not exist",
    );

    const validated = await client.ok("validate_scenario", { path: "s/two.yaml" });
    assertEquals(validated.ok, true);
    assertEquals(validated.warnings, []);
    assertEquals(
      (await client.ok("validate_scenario", { yaml: SHORT })).scenario.name,
      "two-nodes",
    );
    assertStringIncludes(
      await client.refused("validate_scenario", {
        yaml: SHORT.replace("board: scripted", "board: esp32-c3"),
      }),
      "nodes[0].board",
    );
    assertStringIncludes(
      await client.refused("validate_scenario", {}),
      "exactly one of path or yaml",
    );

    const started = await client.ok("run_scenario", { path: "s/two.yaml", seed: 9 });
    assert(["starting", "running"].includes(started.state), started.state);
    assertEquals(started.seed, 9);
    assert(started.out_dir.startsWith(join(workspace, "out", "two") + sep), started.out_dir);

    const done = await pollStatus(client, (s) => s.state === "finished", "the run to finish");
    assertEquals(done.passed, true, JSON.stringify(done.assertions));
    assertEquals(done.assertions.length, 2);
    for (const file of done.files) {
      assert(file.startsWith(done.out_dir), file);
      assert((await Deno.stat(file)).size > 0, file);
    }

    const metrics = await client.ok("get_metrics");
    assertEquals([metrics.state, metrics.schema, metrics.latency], ["finished", 2, "modelled"]);
    const ab = metrics.links.find((l: Json) => l.from === "a" && l.to === "b");
    assertEquals(ab.delivered >= 10, true, JSON.stringify(ab));
    assertEquals(metrics, {
      state: "finished",
      ...JSON.parse(await Deno.readTextFile(`${done.out_dir}/metrics.json`)),
    });

    const serial = await client.ok("get_serial", { node: "b", tail: 3 });
    assertEquals(serial.lines.length, 3);
    assertEquals(serial.truncated, true);
    assertStringIncludes(serial.lines[2].text, "rx ping:9 from a");
    const newer = await client.ok("get_serial", { node: "b", since_ms: serial.next_since_ms });
    assertEquals(newer.lines, []);
    assertStringIncludes(await client.refused("get_serial", { node: "zz" }), "no node named");
    assertStringIncludes(await client.refused("stop"), "no run in progress");
  });
});

Deno.test("mcp: move_node and inject_fault act on a live run; stop keeps what happened", async () => {
  await withServer(async (client) => {
    await client.ok("run_scenario", { path: `${EXAMPLES}live-3-scripted.yaml` });
    await pollStatus(client, (s) => s.state === "running", "the boards to connect");
    assertStringIncludes(
      await client.refused("run_scenario", { path: `${EXAMPLES}live-3-scripted.yaml` }),
      "call stop first",
    );

    // Traffic flows before Json fault: no extra_loss drop anywhere.
    const link = (m: Json, phase: string, from: string, to: string) =>
      m.phases.find((p: Json) => p.label === phase)?.links.find((l: Json) =>
        l.from === from && l.to === to
      );
    const before = await pollMetrics(client, (m) => (link(m, "start", "a", "b")?.sent ?? 0) >= 3);
    assertEquals(before.partial, true);
    assertEquals(link(before, "start", "a", "b").dropped.extra_loss, undefined);

    const fault = await client.ok("inject_fault", {
      link: "a->b",
      extra_loss_pct: 100,
      phase: "fault",
    });
    assertEquals(fault.links, ["a->b"]);
    const during = await pollMetrics(
      client,
      (m) => (link(m, "fault", "a", "b")?.dropped.extra_loss ?? 0) >= 3,
    );
    assertEquals(link(during, "fault", "a", "b").delivered, 0, "every a->b frame is lost");
    assertEquals(link(during, "fault", "b", "a")?.dropped.extra_loss, undefined, "b->a untouched");

    const near = await client.ok("move_node", { node: "c", position: [12, 4] });
    const far = await client.ok("move_node", {
      node: "c",
      position: [42, 0],
      phase: "behind-wall",
    });
    const rssi = (moved: Json, to: string) =>
      moved.links.find((l: Json) => l.link === `c->${to}`).rssi_dbm;
    assert(rssi(far, "a") < rssi(near, "a") - 20, `${rssi(near, "a")} -> ${rssi(far, "a")}`);
    assertEquals(far.from, { x: 12, y: 4 });
    const status = await client.ok("get_status");
    assertEquals(status.nodes.find((n: { id: string }) => n.id === "c").position, { x: 42, y: 0 });

    assertStringIncludes(
      await client.refused("move_node", { node: "zz", position: [0, 0] }),
      "no node named",
    );
    assertStringIncludes(
      await client.refused("move_node", { node: "c", position: [1] }),
      "position",
    );
    assertStringIncludes(
      await client.refused("inject_fault", { link: "a->zz" }),
      "matches no link",
    );
    assertStringIncludes(
      await client.refused("inject_fault", { link: "a->b", extra_loss_pct: 150 }),
      "extra_loss_pct",
    );

    const stopped = await client.ok("stop");
    assertEquals(stopped.state, "stopped");
    assert(stopped.elapsed_ms < 120_000, "it ended long before its duration");
    const after = await client.ok("get_metrics");
    assertEquals([after.state, after.partial], ["stopped", true]);
    assert(after.phases.some((p: { label: string }) => p.label === "behind-wall"));
    assert((await client.ok("get_serial", { node: "a" })).total > 0);
    assertStringIncludes(
      await client.refused("move_node", { node: "c", position: [0, 0] }),
      "no run in progress",
    );
  });
});

Deno.test("mcp: two run_scenario calls sent together start one run, not two", async () => {
  await withServer(async (client) => {
    const path = `${EXAMPLES}live-3-scripted.yaml`;
    const outcomes = await Promise.all([
      client.call("run_scenario", { path }),
      client.call("run_scenario", { path }),
    ]);
    assertEquals(outcomes.map((o) => o.isError).sort(), [false, true], outcomes[1]!.text);
    await pollStatus(client, (s) => s.state === "running", "the boards to connect");
    assertEquals((await client.ok("stop")).state, "stopped");
  });
});

Deno.test("mcp: a symlink cannot carry a write out of the workspace", async () => {
  const outside = await Deno.makeTempDir({ prefix: "hzb-outside-" });
  try {
    await withServer(async (client, workspace) => {
      await Deno.writeTextFile(`${outside}/victim.yaml`, "keep me\n");
      await Deno.symlink(`${outside}/victim.yaml`, `${workspace}/link.yaml`);
      assertStringIncludes(
        await client.refused("create_scenario", {
          path: "link.yaml",
          yaml: SHORT,
          overwrite: true,
        }),
        "symlink",
      );
      assertEquals(await Deno.readTextFile(`${outside}/victim.yaml`), "keep me\n");

      await Deno.symlink(outside, `${workspace}/escape`);
      await client.ok("create_scenario", { path: "s.yaml", yaml: SHORT });
      assertStringIncludes(
        await client.refused("run_scenario", { path: "s.yaml", out: "escape/run1" }),
        "symlink",
      );
      const created = [];
      for await (const entry of Deno.readDir(outside)) created.push(entry.name);
      assertEquals(created, ["victim.yaml"], "nothing was created outside");
    });
  } finally {
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("mcp: closing stdin during a run stops it and the server exits cleanly", async () => {
  const workspace = await Deno.makeTempDir({ prefix: "hzb-mcp-" });
  try {
    const client = new McpClient(workspace);
    await client.initialize();
    await client.ok("run_scenario", { path: `${EXAMPLES}live-3-scripted.yaml` });
    await pollStatus(client, (s) => s.state === "running", "the boards to connect");
    const started = performance.now();
    const { code, stderr } = await client.close();
    assertEquals(code, 0, stderr);
    assert(performance.now() - started < 10_000, "the 120 s run did not hold the server open");
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

signalTest("mcp: SIGINT and SIGTERM stop the run in progress and end the server", async () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const workspace = await Deno.makeTempDir({ prefix: "hzb-mcp-" });
    try {
      const client = new McpClient(workspace);
      await client.initialize();
      await client.ok("run_scenario", { path: `${EXAMPLES}live-3-scripted.yaml` });
      await pollStatus(client, (s) => s.state === "running", "the boards to connect");
      const started = performance.now();
      const { code, stderr } = await client.interrupt(signal);
      assertEquals(code, 0, stderr);
      assert(
        performance.now() - started < 10_000,
        `${signal}: the run did not hold the server open`,
      );
    } finally {
      await Deno.remove(workspace, { recursive: true });
    }
  }
});

/** Ask get_metrics until `done` holds. */

Deno.test("mcp: a run's mobile bridge shows in get_status, moves with move_node and logs to get_serial", async () => {
  await withServer(async (client, workspace) => {
    await Deno.writeTextFile(
      `${workspace}/bridge.yaml`,
      `name: mcp-bridge
duration: 4s
environment: { shadowing_sigma_db: 0 }
nodes:
  - { id: web, board: scripted, position: [0, 0], firmware: { serve: [{ port: 80, protocol: http }] } }
  - { id: other, board: scripted, position: [5, 0] }
bridge:
  position: [2, 0]
  expose: [{ node: web, port: 80, service: http }]
`,
    );
    await client.ok("run_scenario", { path: "bridge.yaml" });
    const running = await pollStatus(client, (s) => s.state === "running", "the boards to connect");
    const endpoint = running.bridge.endpoints[0];
    assertEquals([running.bridge.kind, endpoint.node, endpoint.port], ["ip", "web", 80]);
    for (const deadline = Date.now() + 10_000;;) {
      const web = await client.ok("get_serial", { node: "web" });
      if (web.lines.some((l: Json) => l.text === "tcp listening on 80 (http)")) break;
      if (Date.now() > deadline) throw new Error("the web node never opened port 80");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const response = await fetch(`http://127.0.0.1:${endpoint.hostPort}/hi`);
    assertEquals(await response.text(), "web: GET /hi\n");

    const moved = await client.ok("move_node", { node: "phone", position: [30, 0] });
    assertEquals(moved.links.map((l: Json) => l.link), ["phone->web", "phone->other"]);
    const status = await client.ok("get_status");
    assertEquals(status.bridge.position, { x: 30, y: 0 });
    const log = await client.ok("get_serial", { node: "phone" });
    assert(log.lines.some((l: Json) => /-> web:80 connected$/.test(l.text)), JSON.stringify(log));
    await pollStatus(client, (s) => s.state === "finished", "the run to finish");
  });
});
