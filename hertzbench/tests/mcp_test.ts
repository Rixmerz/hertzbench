// The MCP server through its real entrypoint: `hertzbench mcp` as a separate
// process, spoken to over stdin and stdout the way Claude Code does.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const MAIN = new URL("../cli/main.ts", import.meta.url).pathname;
const EXAMPLES = new URL("../scenarios/examples/", import.meta.url).pathname;

// Tool results are JSON documents read field by field; typing each one here
// would only restate the server.
// deno-lint-ignore no-explicit-any
type Json = any;

const TOOLS = [
  "create_scenario",
  "get_metrics",
  "get_serial",
  "get_status",
  "inject_fault",
  "list_boards",
  "move_node",
  "run_scenario",
  "stop",
  "validate_scenario",
];

interface RpcResponse {
  id: number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface ToolOutcome {
  isError: boolean;
  text: string;
  value: Json;
}

class McpClient {
  readonly #child: Deno.ChildProcess;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #waiting = new Map<number, (response: RpcResponse) => void>();
  readonly #reading: Promise<void>;
  readonly #stderr: Promise<string>;
  readonly unmatched: RpcResponse[] = [];
  #nextId = 1;

  constructor(workspace: string, env: Record<string, string> = {}) {
    this.#child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-net=127.0.0.1",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "--allow-env",
        MAIN,
        "mcp",
        "--workspace",
        workspace,
      ],
      env,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    this.#writer = this.#child.stdin.getWriter();
    this.#reading = this.#read();
    this.#stderr = new Response(this.#child.stderr).text();
  }

  async #read(): Promise<void> {
    let buffered = "";
    for await (const chunk of this.#child.stdout.pipeThrough(new TextDecoderStream())) {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const response = JSON.parse(buffered.slice(0, newline)) as RpcResponse;
        buffered = buffered.slice(newline + 1);
        const resolve = response.id === null ? undefined : this.#waiting.get(response.id);
        if (resolve) {
          this.#waiting.delete(response.id as number);
          resolve(response);
        } else {
          this.unmatched.push(response);
        }
        newline = buffered.indexOf("\n");
      }
    }
  }

  async send(line: string): Promise<void> {
    await this.#writer.write(new TextEncoder().encode(line + "\n"));
  }

  async request(method: string, params?: unknown): Promise<RpcResponse> {
    const id = this.#nextId++;
    const answer = new Promise<RpcResponse>((resolve) => this.#waiting.set(id, resolve));
    await this.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return await answer;
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
    const response = await this.request("tools/call", { name, arguments: args });
    if (response.error) {
      throw new Error(`${name}: protocol error ${JSON.stringify(response.error)}`);
    }
    const result = response.result as { content: { text: string }[]; isError?: boolean };
    const text = result.content[0]!.text;
    const isError = result.isError === true;
    return { isError, text, value: isError ? null : JSON.parse(text) };
  }

  /** The tool's value, failing the test if the tool reported an error. */
  async ok(name: string, args: Record<string, unknown> = {}): Promise<Json> {
    const outcome = await this.call(name, args);
    assert(!outcome.isError, `${name} failed: ${outcome.text}`);
    return outcome.value;
  }

  /** The tool's error text, failing the test if the tool succeeded. */
  async refused(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const outcome = await this.call(name, args);
    assert(outcome.isError, `${name} should have failed, got ${outcome.text}`);
    return outcome.text;
  }

  /** Close stdin, as a client does when it is done, and wait for the server to exit. */
  async close(): Promise<{ code: number; stderr: string }> {
    await this.#writer.close();
    const status = await this.#child.status;
    await this.#reading;
    return { code: status.code, stderr: await this.#stderr };
  }

  /** Signal the server, as a terminal or a supervisor would, and wait for it to exit. */
  async interrupt(signal: Deno.Signal): Promise<{ code: number; stderr: string }> {
    this.#child.kill(signal);
    const status = await this.#child.status;
    await this.#reading;
    await this.#writer.close().catch(() => {/* the server exited and closed its end */});
    return { code: status.code, stderr: await this.#stderr };
  }

  async initialize(): Promise<RpcResponse> {
    const response = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "hertzbench-test", version: "0" },
    });
    await this.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    return response;
  }
}

async function withServer(
  body: (client: McpClient, workspace: string) => Promise<void>,
  env: Record<string, string> = {},
): Promise<void> {
  const workspace = await Deno.makeTempDir({ prefix: "hzb-mcp-" });
  const client = new McpClient(workspace, env);
  try {
    await client.initialize();
    await body(client, workspace);
  } finally {
    const { code, stderr } = await client.close();
    await Deno.remove(workspace, { recursive: true });
    assertEquals(code, 0, stderr);
  }
}

/** Ask get_status until `done` holds. Fails instead of hanging. */
async function pollStatus(client: McpClient, done: (status: Json) => boolean, what: string) {
  const deadline = performance.now() + 20_000;
  for (;;) {
    const status = await client.ok("get_status");
    if (done(status)) return status;
    if (performance.now() > deadline) {
      throw new Error(`timed out waiting for ${what}: ${JSON.stringify(status)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

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

Deno.test("mcp: handshake, the ten tools, resources and protocol errors", async () => {
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
    assertEquals(created.file, `${workspace}/s/two.yaml`);
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

    assertEquals((await client.ok("validate_scenario", { path: "s/two.yaml" })).ok, true);
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
    assert(started.out_dir.startsWith(`${workspace}/out/two/`), started.out_dir);

    const done = await pollStatus(client, (s) => s.state === "finished", "the run to finish");
    assertEquals(done.passed, true, JSON.stringify(done.assertions));
    assertEquals(done.assertions.length, 2);
    for (const file of done.files) {
      assert(file.startsWith(done.out_dir), file);
      assert((await Deno.stat(file)).size > 0, file);
    }

    const metrics = await client.ok("get_metrics");
    assertEquals([metrics.state, metrics.schema, metrics.latency], ["finished", 1, "modelled"]);
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

Deno.test("mcp: SIGINT and SIGTERM stop the run in progress and end the server", async () => {
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
async function pollMetrics(client: McpClient, done: (metrics: Json) => boolean) {
  const deadline = performance.now() + 20_000;
  for (;;) {
    const metrics = await client.ok("get_metrics");
    if (done(metrics)) return metrics;
    if (performance.now() > deadline) {
      throw new Error(`timed out waiting on metrics: ${JSON.stringify(metrics)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
