// Exhaustive tests of the MCP server through its real entrypoint, the
// `hertzbench mcp` process on stdin and stdout: the tool list against
// docs/mcp.md, every argument a tool refuses, every run state, every PHY,
// resources, concurrent calls, and what no tool may reach or run. A few
// protocol branches no stdio client can reach are driven in process at the end.

import { basename, join, sep } from "node:path";
import { PATH_DELIMITER, skipOnWindows, writeFakePython } from "./platform.ts";
import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { EXAMPLES, type Json, McpClient, pollStatus, withServer } from "./mcp_client.ts";
import { McpServer, PROTOCOL_VERSIONS, serveLines, ToolError } from "../mcp/protocol.ts";

const MAIN = fileURLToPath(new URL("../cli/main.ts", import.meta.url));
const DOCS = new URL("../docs/", import.meta.url);
const LIVE = `${EXAMPLES}live-3-scripted.yaml`;

// ---------------------------------------------------------------- helpers

/** Wait on a condition, never a fixed delay; fail with what was awaited. */
async function until<T>(
  probe: () => Promise<T | null | undefined | false>,
  what: string,
): Promise<T> {
  const deadline = performance.now() + 20_000;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function listDir(path: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(path)) names.push(entry.name);
  return names.sort();
}

/** A tool's raw result or protocol error, without the helpers' assumptions. */
async function rawCall(client: McpClient, name: string, args: unknown) {
  return await client.request("tools/call", { name, arguments: args });
}

/**
 * The tool's error text. A JSON-RPC error instead of a tool result fails the
 * test: docs/mcp.md promises every mistake the caller can fix comes back as
 * `isError`, and a protocol error as a server bug.
 */
async function refusal(client: McpClient, name: string, args: Record<string, unknown>) {
  const response = await rawCall(client, name, args);
  assertEquals(response.error, undefined, `${name} ${JSON.stringify(args)}: protocol error`);
  const result = response.result as { content: { text: string }[]; isError?: boolean };
  assertEquals(result.isError, true, `${name} ${JSON.stringify(args)} succeeded`);
  return result.content[0]!.text;
}

/** The answer to each line written, raw, to a fresh server that then sees end of input. */
async function rawExchange(workspace: string, chunks: string[]): Promise<Json[]> {
  const child = new Deno.Command(Deno.execPath(), {
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
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  for (const chunk of chunks) await writer.write(new TextEncoder().encode(chunk));
  await writer.close();
  const [status, stdout] = await Promise.all([
    child.status,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  assertEquals(status.code, 0);
  return stdout.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line));
}

/**
 * A stand-in for the ESP32 worker: HERTZBENCH_PYTHON runs `body`, a Python
 * program, and QEMU_ESP32_LIB at an empty file so the library check
 * passes. No QEMU runs.
 */
async function withFakeEsp32(
  body: string,
  test: (env: Record<string, string>) => Promise<void>,
): Promise<void> {
  const fake = await Deno.makeTempDir({ prefix: "hzb-cov-fake-" });
  try {
    await Deno.writeFile(`${fake}/libqemu-xtensa.so`, new Uint8Array(0));
    const python = await writeFakePython(fake, body);
    await test({
      QEMU_ESP32_LIB: `${fake}/libqemu-xtensa.so`,
      HERTZBENCH_PYTHON: python,
    });
  } finally {
    await Deno.remove(fake, { recursive: true });
  }
}

const PAIR = `name: pair
seed: 5
duration: 60s
environment: { shadowing_sigma_db: 0 }
nodes:
  - id: a
    board: scripted
    position: [0, 0]
    firmware: { send: [{ to: b, every: 100ms, count: 600 }] }
  - { id: b, board: scripted, position: [5, 0], firmware: {} }
  - { id: s, count: 2, board: scripted, position: { grid: { origin: [0, 10], step: [5, 0] } }, firmware: {} }
`;

const QUICK = `name: quick
seed: 5
duration: 600ms
environment: { shadowing_sigma_db: 0 }
nodes:
  - id: a
    board: scripted
    position: [0, 0]
    firmware: { send: [{ to: b, every: 50ms, count: 5 }] }
  - { id: b, board: scripted, position: [5, 0], firmware: {} }
`;

// ---------------------------------------------------------------- tools/list against docs/mcp.md

interface DocTool {
  name: string;
  args: string[];
  required: string[];
}

/**
 * The tool rows of every table between "## Tools" and "## Resources". In the
 * arguments column a `?` marks an optional argument, notes in parentheses are
 * not arguments, and "X or Y" makes both sides optional.
 */
function documentedTools(markdown: string): DocTool[] {
  const section = markdown.slice(
    markdown.indexOf("\n## Tools"),
    markdown.indexOf("\n## Resources"),
  );
  const rows = section.split("\n").filter((line) => /^\| `[a-z_]+` +\|/.test(line));
  return rows.map((row) => {
    const cells = row.split("|").map((cell) => cell.trim());
    const name = cells[1]!.replaceAll("`", "");
    const clauses = cells[2]!.replace(/\([^)]*\)/g, "").split(",");
    const args: string[] = [];
    const required = new Set<string>();
    clauses.forEach((clause, index) => {
      const tokens = [...clause.matchAll(/`([a-z0-9_]+)(\?)?`/g)];
      const alternative = /\bor\b/.test(clause);
      for (const [, arg, optional] of tokens) {
        args.push(arg!);
        if (!optional && !alternative) required.add(arg!);
      }
      // ", or `x`": the clause before is the other alternative.
      if (/^\s*or\b/.test(clause) && index > 0) {
        for (const [, arg] of clauses[index - 1]!.matchAll(/`([a-z0-9_]+)\??`/g)) {
          required.delete(arg!);
        }
      }
    });
    return { name, args: args.sort(), required: [...required].sort() };
  });
}

Deno.test("cov mcp: tools/list matches the tool tables of docs/mcp.md exactly", async () => {
  const documented = documentedTools(await Deno.readTextFile(new URL("mcp.md", DOCS)));
  await withServer(async (client) => {
    const listed = (await client.request("tools/list")).result!.tools as Json[];
    assertEquals(
      listed.map((t) => t.name).sort(),
      documented.map((t) => t.name).sort(),
      "the same tool names",
    );
    for (const doc of documented) {
      const tool = listed.find((t) => t.name === doc.name)!;
      assertEquals(
        Object.keys(tool.inputSchema.properties ?? {}).sort(),
        doc.args,
        `${doc.name}: arguments`,
      );
      assertEquals((tool.inputSchema.required ?? []).slice().sort(), doc.required, doc.name);
      assertEquals(tool.inputSchema.type, "object", doc.name);
      assertEquals(tool.inputSchema.additionalProperties, false, doc.name);
      assert(tool.description.length > 20, `${doc.name} has a description`);
    }
  });
});

Deno.test("cov mcp: resources/list matches the resource table of docs/mcp.md, and each reads from disk", async () => {
  const markdown = await Deno.readTextFile(new URL("mcp.md", DOCS));
  const table = markdown.slice(markdown.indexOf("\n## Resources"));
  const patterns = [...table.matchAll(/^\| `(hertzbench:\/\/[^`]+)`/gm)].map((m) => m[1]!);
  const examples = (await listDir(EXAMPLES)).filter((name) => /\.ya?ml$/.test(name));
  const expected = patterns.flatMap((uri) =>
    uri.includes("<file>") ? examples.map((name) => `hertzbench://examples/${name}`) : [uri]
  ).sort();
  assertEquals(patterns.length, 3);
  await withServer(async (client) => {
    const listed = (await client.request("resources/list")).result!.resources as Json[];
    assertEquals(listed.map((r) => r.uri).sort(), expected);
    for (const resource of listed) {
      const read = await client.request("resources/read", { uri: resource.uri });
      const [content] = read.result!.contents as Json[];
      const docName = /^hertzbench:\/\/docs\/(.+)$/.exec(resource.uri)?.[1];
      const onDisk = docName
        ? await Deno.readTextFile(new URL(docName, DOCS))
        : await Deno.readTextFile(`${EXAMPLES}${resource.uri.split("/").pop()}`);
      assertEquals(content.text, onDisk, resource.uri);
      assertEquals(content.uri, resource.uri);
      assertEquals(content.mimeType, docName ? "text/markdown" : "application/yaml");
      assertEquals(resource.mimeType, content.mimeType);
    }
    assertEquals((await client.request("resources/templates/list")).result, {
      resourceTemplates: [],
    });
  });
});

// ---------------------------------------------------------------- protocol

Deno.test("cov mcp: initialize answers each protocol version it speaks, else its newest", async () => {
  await withServer(async (client) => {
    for (const version of PROTOCOL_VERSIONS) {
      const init = await client.request("initialize", { protocolVersion: version });
      assertEquals(init.result?.protocolVersion, version);
    }
    for (const params of [undefined, {}, { protocolVersion: 2025 }, ["2025-06-18"]]) {
      const init = await client.request("initialize", params);
      assertEquals(init.result?.protocolVersion, PROTOCOL_VERSIONS[0], JSON.stringify(params));
    }
    const init = (await client.request("initialize", { protocolVersion: "2024-11-05" })).result!;
    assertEquals(init.capabilities, { tools: {}, resources: {} });
    assertEquals((init.serverInfo as Json).name, "hertzbench");
    assertMatch((init.serverInfo as Json).version, /^\d+\.\d+\.\d+$/);
    assertStringIncludes(init.instructions as string, "No tool runs host commands");
  });
});

Deno.test("cov mcp: malformed requests get the JSON-RPC error that names them", async () => {
  await withServer(async (client) => {
    const expectError = async (method: string, params: unknown, code: number, words: string) => {
      const response = await client.request(method, params);
      assertEquals(response.error?.code, code, `${method} ${JSON.stringify(params)}`);
      assertStringIncludes(response.error!.message, words);
    };
    await expectError("tools/call", undefined, -32602, "needs a tool name");
    await expectError("tools/call", { name: 7 }, -32602, "needs a tool name");
    await expectError("tools/call", ["get_status"], -32602, "needs a tool name");
    await expectError("tools/call", { name: "nope" }, -32602, "unknown tool: nope");
    await expectError("tools/call", { name: "get_status", arguments: [] }, -32602, "object");
    await expectError("tools/call", { name: "get_status", arguments: "x" }, -32602, "object");
    await expectError("resources/read", undefined, -32602, "needs a uri");
    await expectError("resources/read", { uri: 5 }, -32602, "needs a uri");
    await expectError("resources/read", { uri: "hertzbench://examples/none.yaml" }, -32002, "none");
    await expectError("resources/read", { uri: "file:///etc/passwd" }, -32002, "not found");
    await expectError("frobnicate", {}, -32601, "frobnicate");
    // arguments: null is no arguments at all.
    const nullArgs = await client.request("tools/call", { name: "get_status", arguments: null });
    assertEquals(JSON.parse((nullArgs.result as Json).content[0].text).state, "idle");
    // A request to a notifications/ method still gets its empty answer.
    assertEquals((await client.request("notifications/whatever")).result, {});
    assertEquals((await client.request("ping", { extra: 1 })).result, {});
  });
});

Deno.test("cov mcp: raw lines: garbage, bad ids, client responses and notifications", async () => {
  await withServer(async (client) => {
    // No answer at all: a notification that fails, a client's response, blank lines.
    await client.send(JSON.stringify({ jsonrpc: "2.0", method: "no/such/method" }));
    await client.send(JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: {} }));
    await client.send(JSON.stringify({ jsonrpc: "2.0", id: 42, result: {} }));
    await client.send(JSON.stringify({ jsonrpc: "2.0", id: 43, error: { code: 1, message: "x" } }));
    await client.send("   ");
    await client.send("");
    // One answer each, all with a null id but the string id.
    const lines = [
      "not json",
      "[]",
      '"a string"',
      "null",
      JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]),
      JSON.stringify({ jsonrpc: "1.0", id: 1, method: "ping" }),
      JSON.stringify({ id: 1, method: "ping" }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: 5 }),
      JSON.stringify({ jsonrpc: "2.0", id: {}, method: "ping" }),
      JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" }),
      JSON.stringify({ jsonrpc: "2.0", id: true, method: "ping" }),
      JSON.stringify({ jsonrpc: "2.0", id: "text-id", method: "ping" }),
    ];
    for (const line of lines) await client.send(line);
    await until(() => Promise.resolve(client.unmatched.length >= lines.length), "every answer");
    assertEquals(await client.ok("get_status"), { state: "idle" }, "the server goes on");
    assertEquals(client.unmatched.length, lines.length, JSON.stringify(client.unmatched));
    const codes = client.unmatched.map((r) => r.error?.code ?? "result");
    assertEquals(codes.filter((c) => c === -32700).length, 1, "one parse error");
    assertEquals(codes.filter((c) => c === -32600).length, lines.length - 2);
    const byText = client.unmatched.find((r) => (r.id as unknown) === "text-id")!;
    assertEquals(byText.result, {}, "a string id is answered with that id");
    const badId = client.unmatched.filter((r) => r.error?.message.includes("id must be"));
    assertEquals(badId.length, 3, "{}, null and true are not ids");
    assert(client.unmatched.every((r) => r.id === null || (r.id as unknown) === "text-id"));
  });
});

Deno.test("cov mcp: a request split across writes, two in one write, and a last line with no newline are all answered", async () => {
  const workspace = await Deno.makeTempDir({ prefix: "hzb-cov-raw-" });
  try {
    const ping = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "ping" });
    const status = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_status" },
    });
    const answers = await rawExchange(workspace, [
      ping(1).slice(0, 10),
      ping(1).slice(10) + "\n" + ping(2) + "\n",
      status, // no newline: end of input ends the line
    ]);
    assertEquals(answers.map((a) => a.id).sort(), [1, 2, 3]);
    const last = answers.find((a) => a.id === 3);
    assertEquals(JSON.parse(last.result.content[0].text), { state: "idle" });
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

// ---------------------------------------------------------------- arguments, driven by each schema

/** A value of the right type for `key`, so the argument under test is the one refused. */
function validValue(key: string, schema: Json): unknown {
  const byKey: Record<string, unknown> = {
    link: "a->b",
    position: [0, 0],
    path: "absent.yaml",
    yaml: QUICK,
    label: "p",
    text: "hi",
  };
  if (key in byKey) return byKey[key];
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case "string":
      return "a";
    case "integer":
    case "number":
      return schema.minimum ?? 1;
    case "boolean":
      return false;
    case "array":
      return schema.items?.type === "object" ? [] : ["tx"];
    case "object":
      return {};
  }
  throw new Error(`no valid value for ${key}`);
}

function wrongValue(schema: Json): unknown {
  switch (schema.type) {
    case "string":
      return 42;
    case "integer":
      return 1.5;
    case "number":
      return "1";
    case "boolean":
      return "yes";
    case "array":
      return "x";
    case "object":
      return ["x"];
  }
  throw new Error(`no wrong value for ${JSON.stringify(schema)}`);
}

/** Arguments every required key of which is valid, except those in `skip`. */
function baseArgs(tool: Json, skip: string[] = []): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const key of tool.inputSchema.required ?? []) {
    if (!skip.includes(key)) args[key] = validValue(key, tool.inputSchema.properties[key]);
  }
  // Arguments a tool needs before it looks further: one of text or
  // data_base64, or something to change.
  const companions: Record<string, Record<string, unknown>> = {
    send_serial: { text: "hi" },
    set_channel: { path_loss_exponent: 3 },
    set_radio: { antenna_gain_dbi: 1 },
  };
  for (const [key, value] of Object.entries(companions[tool.name] ?? {})) {
    if (!skip.includes(key)) args[key] = value;
  }
  return args;
}

Deno.test("cov mcp: every tool refuses an unknown argument, a missing required one and each wrong type, naming it", async () => {
  await withServer(async (client) => {
    const listed = (await client.request("tools/list")).result!.tools as Json[];
    for (const tool of listed) {
      const unknown = await refusal(client, tool.name, { ...baseArgs(tool), zz_unknown: 1 });
      assertStringIncludes(unknown, "unknown argument zz_unknown", tool.name);

      for (const key of tool.inputSchema.required ?? []) {
        const missing = await refusal(client, tool.name, baseArgs(tool, [key]));
        assertStringIncludes(missing, key, `${tool.name} without ${key}`);
      }

      for (const [key, schema] of Object.entries(tool.inputSchema.properties as Json)) {
        const args = { ...baseArgs(tool), [key]: wrongValue(schema) };
        // send_serial takes text or data_base64, not both.
        if (tool.name === "send_serial" && key === "data_base64") delete args.text;
        const wrong = await refusal(client, tool.name, args);
        assertStringIncludes(wrong, key, `${tool.name}.${key} = ${JSON.stringify(args[key])}`);
      }
    }
  });
});

Deno.test("cov mcp: numeric arguments are refused one past each schema bound and accepted on it", async () => {
  await withServer(async (client) => {
    const listed = (await client.request("tools/list")).result!.tools as Json[];
    // open_view at its minimum (0, a free port) first, so its maximum finds the view already open.
    listed.sort((a, b) => (a.name === "open_view" ? -1 : b.name === "open_view" ? 1 : 0));
    let checked = 0;
    for (const tool of listed) {
      for (const [key, schema] of Object.entries(tool.inputSchema.properties as Json)) {
        const s = schema as Json;
        if (s.type !== "number" && s.type !== "integer") continue;
        for (const bound of ["minimum", "maximum"] as const) {
          if (s[bound] === undefined) continue;
          const outside = s[bound] + (bound === "minimum" ? -1 : 1);
          const refused = await refusal(client, tool.name, { ...baseArgs(tool), [key]: outside });
          assertStringIncludes(refused, key, `${tool.name}.${key} = ${outside}`);
          // On the bound the argument passes; what answers is the next check, or success.
          const onBound = await rawCall(client, tool.name, { ...baseArgs(tool), [key]: s[bound] });
          assertEquals(onBound.error, undefined, `${tool.name}.${key} = ${s[bound]}`);
          const text = (onBound.result as Json).content[0].text as string;
          assert(!text.includes(`${key} must be`), `${tool.name}.${key} = ${s[bound]}: ${text}`);
          checked++;
        }
      }
    }
    assert(checked >= 20, `${checked} bounds checked`);
  });
});

Deno.test("cov mcp: argument rules a schema cannot say: empty strings, serial bytes, link and event filters", async () => {
  await withServer(async (client) => {
    const cases: [string, Record<string, unknown>, string][] = [
      ["read_scenario", { path: "" }, "path must be a non-empty string"],
      ["get_serial", { node: "" }, "node must be a non-empty string"],
      ["start_phase", { label: "" }, "label must be a non-empty string"],
      ["move_node", { node: "a", position: [0, 0], phase: "" }, "phase must be a non-empty string"],
      ["validate_scenario", { path: "a.yaml", yaml: QUICK }, "exactly one of path or yaml"],
      ["validate_scenario", {}, "exactly one of path or yaml"],
      ["create_scenario", { path: "x.txt", yaml: QUICK }, "must end in .yaml or .yml"],
      ["create_scenario", { path: "x.yaml", yaml: QUICK, overwrite: 1 }, "overwrite must be"],
      ["edit_scenario", { path: "x.yaml" }, "nothing to change"],
      ["edit_scenario", { path: "x.json", set: {} }, "must end in .yaml or .yml"],
      ["edit_scenario", { path: "x.yaml", set: null }, "set must be an object"],
      ["add_node", { path: "x.yaml", node: null }, "node must be an object"],
      ["send_serial", { node: "a" }, "exactly one of text or data_base64"],
      ["send_serial", { node: "a", text: "x", data_base64: "eA==" }, "exactly one"],
      ["send_serial", { node: "a", text: "", newline: false }, "nothing to send"],
      ["send_serial", { node: "a", data_base64: "" }, "nothing to send"],
      ["send_serial", { node: "a", data_base64: "eA==", newline: true }, "newline applies to text"],
      ["send_serial", { node: "a", data_base64: "not base64!" }, "data_base64 must be base64"],
      ["send_serial", { node: "a", data_base64: "a" }, "data_base64 must be base64"],
      [
        "send_serial",
        { node: "a", text: "x".repeat(4096) },
        "at most 4096 bytes per call, got 4097",
      ],
      ["send_serial", { node: "a", data_base64: btoa("y".repeat(4097)) }, "got 4097"],
      ["inject_fault", { link: "ab" }, 'link must be "from->to"'],
      ["inject_fault", { link: "a->" }, 'link must be "from->to"'],
      ["inject_fault", { link: " ->b" }, 'link must be "from->to"'],
      ["inject_fault", { link: "a->b->c" }, 'link must be "from->to"'],
      ["set_channel", {}, "nothing to change"],
      ["set_channel", { phase: "p" }, "nothing to change"],
      ["set_channel", { obstacles: [{ polygon: [[0, 0]], attenuation_db: 3 }] }, "two points"],
      ["set_channel", { obstacles: [{ polygon: [[0, 0], [1, 1]] }] }, "attenuation_db"],
      ["set_radio", { node: "a" }, "nothing to change"],
      ["set_radio", { node: "a", phase: "p" }, "nothing to change"],
      ["get_events", { types: [] }, "non-empty array"],
      ["get_events", { types: ["tx", "teleport"] }, 'unknown event type "teleport"'],
      ["get_events", { types: [3] }, "unknown event type 3"],
      ["get_serial", { node: "a", since_ms: "5" }, "since_ms must be a number"],
      ["export_capture", { kind: "wav" }, "kind must be one of pcap, pcap-80211, btsnoop"],
      ["move_node", { node: "a", position: [0, 0, 0, 0] }, "position"],
      ["move_node", { node: "a", position: { x: 1 } }, "position"],
    ];
    for (const [tool, args, words] of cases) {
      assertStringIncludes(
        await refusal(client, tool, args),
        words,
        `${tool} ${JSON.stringify(args)}`,
      );
    }
  });
});

// ---------------------------------------------------------------- run states

const RUN_TOOLS: [string, Record<string, unknown>][] = [
  ["move_node", { node: "a", position: [1, 1] }],
  ["inject_fault", { link: "a->b", extra_loss_pct: 5 }],
  ["set_channel", { path_loss_exponent: 3 }],
  ["set_radio", { node: "a", antenna_gain_dbi: 2 }],
  ["start_phase", { label: "late" }],
  ["send_serial", { node: "a", text: "hi" }],
  ["stop", {}],
];

Deno.test("cov mcp: before any run, every run tool says there is none and get_view_state draws nothing", async () => {
  await withServer(async (client) => {
    const idle: [string, Record<string, unknown>][] = [
      ...RUN_TOOLS,
      ["get_serial", { node: "a" }],
      ["get_metrics", {}],
      ["get_events", {}],
      ["export_capture", { kind: "pcap" }],
      ["get_report", {}],
    ];
    for (const [tool, args] of idle) {
      assertStringIncludes(await refusal(client, tool, args), "no run yet", tool);
    }
    assertEquals(await client.ok("get_view_state"), {
      status: { state: "idle" },
      scene: null,
      timeline: null,
    });
  });
});

Deno.test("cov mcp: after stop and after the end, the live tools refuse with the last run's state", async () => {
  await withServer(async (client, workspace) => {
    await client.ok("create_scenario", { path: "pair.yaml", yaml: PAIR });
    await client.ok("run_scenario", { path: "pair.yaml" });
    await pollStatus(client, (s) => s.state === "running", "the boards to connect");
    const stopped = await client.ok("stop");
    assertEquals(stopped.state, "stopped");
    assertStringIncludes(stopped.note, "no output files");
    assertEquals(await listDir(stopped.out_dir), [], "stop writes no output file");
    for (const [tool, args] of RUN_TOOLS) {
      assertStringIncludes(
        await refusal(client, tool, args),
        `${tool}: no run in progress (the last one is stopped)`,
      );
    }
    assertStringIncludes(await refusal(client, "get_report", {}), "this one is stopped");
    const events = await client.ok("get_events", { limit: 1 });
    assertEquals([events.state, events.events.length, events.truncated], ["stopped", 1, true]);
    assertEquals((await client.ok("get_serial", { node: "b" })).state, "stopped");
    assertEquals((await client.ok("get_view_state")).status.state, "stopped");

    await client.ok("create_scenario", { path: "quick.yaml", yaml: QUICK });
    const second = await client.ok("run_scenario", { path: "quick.yaml", out: "runs/q" });
    assert(second.run_id !== stopped.run_id, "a new run replaces the stopped one");
    const done = await pollStatus(client, (s) => s.state === "finished", "the run to finish");
    assertEquals(done.out_dir, join(workspace, "runs", "q"));
    for (const [tool, args] of RUN_TOOLS) {
      assertStringIncludes(
        await refusal(client, tool, args),
        `${tool}: no run in progress (the last one is finished)`,
      );
    }
    assertStringIncludes((await client.ok("get_report")).report, "quick");
    assertEquals((await client.ok("get_metrics")).state, "finished");
    const capture = await client.ok("export_capture", { kind: "pcap", path: "after.pcap" });
    assertEquals(capture.state, "finished");
  });
});

// A worker that reads its config and never connects: the run stays starting.
const NEVER_CONNECTS = "import sys\nsys.stdin.buffer.read()\n";
// A worker that dies at once: the run fails before time zero.
const DIES = "import sys\nsys.stderr.write('fake worker: no QEMU here\\n')\nsys.exit(3)\n";

const ESP32_PAIR = `name: esp32-pair
duration: 60s
nodes:
  - { id: a, board: esp32, firmware: ./fw.bin, position: [0, 0] }
  - { id: b, board: esp32, firmware: ./fw.bin, position: [5, 0] }
`;

Deno.test("cov mcp: while the boards are starting, the live tools wait and stop ends it at once", async () => {
  await withFakeEsp32(NEVER_CONNECTS, async (env) => {
    await withServer(async (client, workspace) => {
      const boards = await client.ok("list_boards");
      const esp32 = boards.boards.find((b: Json) => b.board === "esp32");
      assertEquals(esp32.available, true);
      assertStringIncludes(esp32.detail, env.QEMU_ESP32_LIB!);

      await Deno.writeFile(`${workspace}/fw.bin`, new Uint8Array(16));
      await client.ok("create_scenario", { path: "esp.yaml", yaml: ESP32_PAIR });
      const started = await client.ok("run_scenario", { path: "esp.yaml" });
      assertEquals(started.state, "starting");
      assertEquals([started.elapsed_ms, started.problems], [null, []]);

      for (const [tool, args] of RUN_TOOLS.filter(([t]) => t !== "stop")) {
        assertStringIncludes(
          await refusal(client, tool, args),
          `${tool}: the boards are still starting`,
        );
      }
      assertStringIncludes(
        await refusal(client, "export_capture", { kind: "pcap" }),
        "the boards are still starting",
      );
      assertStringIncludes(await refusal(client, "run_scenario", { path: "esp.yaml" }), "starting");
      assertStringIncludes(await refusal(client, "get_report", {}), "this one is starting");
      const metrics = await client.ok("get_metrics");
      assertEquals(metrics, {
        state: "starting",
        note: "the boards have not all connected yet: no metrics",
      });
      const view = await client.ok("get_view_state");
      assertEquals([view.scene.phy, view.scene.links, view.timeline], [
        "wifi",
        [],
        { entries: [], next_since: -1, truncated: false },
      ]);
      assertEquals((await client.ok("get_serial", { node: "a" })).total, 0);
      assertEquals((await client.ok("get_events")).events, []);

      const before = performance.now();
      const stopped = await client.ok("stop");
      assertEquals(stopped.state, "stopped");
      assert(performance.now() - before < 10_000, "stop did not wait out the connect timeout");
      assertStringIncludes(
        await refusal(client, "export_capture", { kind: "pcap" }),
        "the run never reached time zero",
      );
    }, env);
  });
});

Deno.test("cov mcp: a board that dies at start-up turns the run failed, with its error", async () => {
  await withFakeEsp32(DIES, async (env) => {
    await withServer(async (client, workspace) => {
      await Deno.writeFile(`${workspace}/fw.bin`, new Uint8Array(16));
      await client.ok("create_scenario", { path: "esp.yaml", yaml: ESP32_PAIR });
      await client.ok("run_scenario", { path: "esp.yaml" });
      const failed = await pollStatus(client, (s) => s.state === "failed", "the run to fail");
      assert(typeof failed.error === "string" && failed.error.length > 0, failed.error);
      assert(!failed.error.startsWith("internal error"), failed.error);
      assertStringIncludes(await refusal(client, "stop", {}), "the last one is failed");
      assertStringIncludes(
        await refusal(client, "export_capture", { kind: "pcap" }),
        "the run never reached time zero",
      );
      assertStringIncludes(await refusal(client, "get_report", {}), "this one is failed");
    }, env);
  });
});

Deno.test("cov mcp: the internet gateway is off the medium: it cannot be moved or retuned", async () => {
  await withFakeEsp32(NEVER_CONNECTS, async (env) => {
    await withServer(async (client, workspace) => {
      await Deno.writeFile(`${workspace}/fw.bin`, new Uint8Array(16));
      await client.ok("create_scenario", {
        path: "gw.yaml",
        yaml: `name: gw
duration: 60s
nodes:
  - { id: a, board: scripted, position: [0, 0], firmware: { send: [{ to: b, every: 100ms, count: 600 }] } }
  - { id: b, board: scripted, position: [5, 0], firmware: {} }
  - { id: inet, board: esp32, firmware: ./fw.bin, position: [9, 0], internet_gateway: true }
`,
      });
      await client.ok("run_scenario", { path: "gw.yaml" });
      const running = await pollStatus(
        client,
        (s) => s.state === "running",
        "the boards to connect",
      );
      assertEquals(
        running.nodes.map((n: Json) => [n.id, n.on_medium]),
        [["a", true], ["b", true], ["inet", false]],
      );
      assertStringIncludes(
        await refusal(client, "move_node", { node: "inet", position: [1, 1] }),
        "inet is the internet gateway: it is not on the medium",
      );
      assertStringIncludes(
        await refusal(client, "set_radio", { node: "inet", antenna_gain_dbi: 3 }),
        "inet is the internet gateway",
      );
      const moved = await client.ok("move_node", { node: "a", position: [1, 0] });
      assertEquals(moved.links.map((l: Json) => l.link), ["a->b"], "the gateway is no peer");
      assertStringIncludes(
        await refusal(client, "inject_fault", { link: "a->inet" }),
        "matches no link",
      );
      await client.ok("stop");
    }, env);
  });
});

Deno.test("cov mcp: the mobile bridge moves like a station but has no console and no HCI on Wi-Fi", async () => {
  await withServer(async (client) => {
    await client.ok("create_scenario", {
      path: "bridge.yaml",
      yaml: `name: bridge
duration: 60s
environment: { shadowing_sigma_db: 0 }
nodes:
  - { id: web, board: scripted, position: [0, 0], firmware: { serve: [{ port: 80, protocol: http }] } }
  - { id: other, board: scripted, position: [5, 0] }
bridge:
  position: [2, 0]
  expose: [{ node: web, port: 80, service: http }]
`,
    });
    await client.ok("run_scenario", { path: "bridge.yaml" });
    await pollStatus(client, (s) => s.state === "running", "the boards to connect");
    assertStringIncludes(
      await refusal(client, "send_serial", { node: "phone", text: "hi" }),
      "phone is the mobile bridge: it has no serial console",
    );
    assertStringIncludes(
      await refusal(client, "export_capture", { kind: "btsnoop", node: "phone" }),
      "no HCI capture of phone",
    );
    const radio = await client.ok("set_radio", { node: "phone", tx_power_dbm: 5 });
    assertEquals(radio.links.map((l: Json) => l.link), ["phone->web", "phone->other"]);
    assertEquals((await client.ok("get_serial", { node: "phone" })).node, "phone");
    assertStringIncludes(
      await refusal(client, "get_serial", { node: "tablet" }),
      "(nodes: web, other, phone)",
    );
    await client.ok("stop");
  });
});

// ---------------------------------------------------------------- every PHY

interface PhyCase {
  name: string;
  scenePhy: string;
  chip: boolean;
  yaml: string;
}

const PHYS: PhyCase[] = [
  {
    name: "wifi",
    scenePhy: "wifi",
    chip: false,
    yaml: `name: phy-wifi
seed: 3
duration: 60s
environment: { shadowing_sigma_db: 0 }
nodes:
  - { id: gw, board: scripted, position: [0, 0], firmware: { send: [{ to: s, every: 100ms, count: 600 }] } }
  - { id: s, board: scripted, position: [5, 0], firmware: { send: [{ to: gw, every: 100ms, count: 600 }] } }
`,
  },
  {
    name: "espnow",
    scenePhy: "wifi",
    chip: false,
    yaml: `name: phy-espnow
seed: 3
duration: 60s
environment: { shadowing_sigma_db: 0 }
nodes:
  - id: gw
    board: scripted
    position: [0, 0]
    radios: [{ phy: wifi, channel: 1 }]
    firmware: { send: [{ to: broadcast, via: espnow, every: 200ms, count: 300, payload: beacon }] }
  - id: s
    board: scripted
    position: [5, 0]
    radios: [{ phy: wifi, channel: 1 }]
    firmware: { send: [{ to: gw, via: espnow, every: 100ms, count: 600, payload: reading }] }
`,
  },
  {
    name: "lora",
    scenePhy: "lora",
    chip: true,
    yaml: `name: phy-lora
seed: 3
duration: 60s
environment: { preset: urban, shadowing_sigma_db: 0 }
nodes:
  - id: gw
    board: scripted
    position: [0, 0]
    radios: [{ phy: lora, frequency_mhz: 868.1, sf: 7, bw_khz: 125, cr: 4/5, tx_power_dbm: 14 }]
    firmware: { listen: true }
  - id: s
    board: scripted
    position: [300, 0]
    radios: [{ phy: lora, frequency_mhz: 868.1, sf: 7, bw_khz: 125, cr: 4/5, tx_power_dbm: 14 }]
    firmware: { send: [{ every: 300ms, count: 200, start: 0ms, payload: reading }] }
`,
  },
  {
    name: "nrf24",
    scenePhy: "nrf24",
    chip: true,
    yaml: `name: phy-nrf24
seed: 3
duration: 60s
environment: { preset: indoor_office, shadowing_sigma_db: 0 }
nodes:
  - { id: gw, board: scripted, position: [0, 0], radios: [{ phy: nrf24 }], firmware: {} }
  - id: s
    board: scripted
    position: [5, 0]
    radios: [{ phy: nrf24 }]
    firmware: { send: [{ to: gw, every: 200ms, count: 300, payload: t }] }
`,
  },
  {
    name: "ble",
    scenePhy: "ble",
    chip: true,
    yaml: `name: phy-ble
seed: 3
duration: 60s
environment: { preset: indoor_office, shadowing_sigma_db: 0 }
nodes:
  - id: gw
    board: scripted
    position: [0, 0]
    radios: [{ phy: ble, tx_power_dbm: 0 }]
    firmware: { connect: { peers: [s], interval: 30ms, timeout: 1s } }
  - id: s
    board: scripted
    position: [5, 0]
    radios: [{ phy: ble, tx_power_dbm: 0 }]
    firmware:
      advertise: { interval: 50ms }
      send: [{ to: gw, every: 200ms, count: 300, payload: reading }]
`,
  },
];

for (const phy of PHYS) {
  Deno.test(`cov mcp: a live ${phy.name} run takes every live tool its PHY allows and refuses the rest`, async () => {
    await withServer(async (client, workspace) => {
      await client.ok("create_scenario", { path: `${phy.name}.yaml`, yaml: phy.yaml });
      const validated = await client.ok("validate_scenario", { path: `${phy.name}.yaml` });
      assertEquals(validated.scenario.nodes.map((n: Json) => n.phy), [
        phy.scenePhy,
        phy.scenePhy,
      ]);
      await client.ok("run_scenario", { path: `${phy.name}.yaml`, seed: 4 });
      const running = await pollStatus(
        client,
        (s) => s.state === "running",
        "the boards to connect",
      );
      assertEquals(running.seed, 4);
      await until(
        async () => (await client.ok("get_events", { types: ["tx"] })).events.length > 0,
        `a ${phy.name} transmission`,
      );

      // move_node gives the budget to every other station, on every PHY.
      const moved = await client.ok("move_node", { node: "s", position: [6, 0], phase: "moved" });
      assertEquals(moved.links.map((l: Json) => l.link), ["s->gw"]);
      assert(Number.isFinite(moved.links[0].rssi_dbm), JSON.stringify(moved));
      assertEquals([moved.from.x, moved.to], [phy.name === "lora" ? 300 : 5, { x: 6, y: 0 }]);

      const gain = await client.ok("set_radio", { node: "gw", antenna_gain_dbi: 3 });
      assertEquals([gain.changes, gain.links.map((l: Json) => l.link)], [
        { antennaGainDbi: 3 },
        ["gw->s"],
      ]);
      const loss = await client.ok("set_channel", { path_loss_exponent: 2.5, phase: "env" });
      assertEquals([loss.changes, loss.phase], [{ pathLossExponent: 2.5 }, "env"]);
      if (phy.chip) {
        for (const args of [{ channel: 3 }, { tx_power_dbm: 1 }]) {
          assertStringIncludes(
            await refusal(client, "set_radio", { node: "s", ...args }),
            `on a ${phy.scenePhy} run only antenna_gain_dbi can change`,
          );
        }
        assertStringIncludes(
          await refusal(client, "set_channel", { noise_figure_db: 6 }),
          `noise_figure_db is the Wi-Fi receiver's; on this ${phy.scenePhy} run`,
        );
        assertStringIncludes(
          await refusal(client, "export_capture", { kind: "pcap-80211" }),
          "pcap-80211 is for Wi-Fi runs",
        );
      } else {
        const tuned = await client.ok("set_radio", { node: "s", channel: 1, tx_power_dbm: 10 });
        assertEquals(tuned.changes, { channel: 1, txPowerDbm: 10 });
        await client.ok("set_channel", { noise_figure_db: 6 });
        const air80211 = await client.ok("export_capture", { kind: "pcap-80211" });
        assert(basename(air80211.file) === "air-live-80211.pcap", air80211.file);
      }

      const fault = await client.ok("inject_fault", {
        link: "*->gw",
        extra_loss_pct: 50,
        extra_latency_ms: 2,
        extra_jitter_ms: 1,
        interference_db: 3,
        phase: "chaos",
      });
      assertEquals(fault.links, ["s->gw"]);
      assertEquals(
        [fault.extra_loss_pct, fault.extra_jitter_ms, fault.interference_db],
        [50, 1, 3],
      );
      const cleared = await client.ok("inject_fault", { link: "s->*" });
      assertEquals([cleared.extra_jitter_ms, cleared.interference_db, cleared.phase], [0, 0, null]);
      assertEquals((await client.ok("start_phase", { label: "quiet" })).phase, "quiet");

      const view = await client.ok("get_view_state", { since: -1 });
      assertEquals(view.scene.phy, phy.scenePhy);
      assertEquals(view.scene.links.map((l: Json) => `${l.from}->${l.to}`).sort(), [
        "gw->s",
        "s->gw",
      ]);
      assert(view.timeline.entries.length > 0, "the timeline has the frames so far");

      const metrics = await until(async () => {
        const m = await client.ok("get_metrics");
        return m.phases.some((p: Json) => p.label === "quiet") && m;
      }, "the quiet phase in the metrics");
      assertEquals([metrics.partial, metrics.latency], [true, "modelled"]);
      assertEquals(
        metrics.phases.map((p: Json) => p.label).slice(0, 5),
        ["start", "moved", "env", "chaos", "quiet"],
      );

      const air = await client.ok("export_capture", { kind: "pcap" });
      assert(air.file.startsWith(join(workspace, "out", phy.name) + sep), air.file);
      assertEquals((await Deno.stat(air.file)).size, air.bytes);
      assert(air.packets > 0, `${phy.name}: ${air.packets} packets`);
      assertStringIncludes(
        await refusal(client, "export_capture", { kind: "pcap", node: "gw" }),
        "node applies to btsnoop only",
      );
      assertStringIncludes(
        await refusal(client, "export_capture", { kind: "btsnoop" }),
        "btsnoop needs the node",
      );
      assertStringIncludes(
        await refusal(client, "export_capture", { kind: "btsnoop", node: "zz" }),
        "no node named",
      );
      if (phy.name === "ble") {
        const hci = await client.ok("export_capture", { kind: "btsnoop", node: "gw" });
        assert(basename(hci.file) === "hci-gw-live.btsnoop", hci.file);
        assert(hci.packets > 0, "the central's HCI traffic");
      } else {
        assertStringIncludes(
          await refusal(client, "export_capture", { kind: "btsnoop", node: "gw" }),
          "btsnoop is for BLE nodes",
        );
      }

      const mine = await until(async () => {
        const page = await client.ok("get_events", { node: "gw", types: ["tx", "deliver"] });
        return page.events.length > 0 && page;
      }, "a frame sent or received by gw");
      for (const event of mine.events) {
        assert(["tx", "deliver"].includes(event.type), event.type);
        assert(event.node === "gw" || event.from === "gw" || event.to === "gw", event);
      }
      assertEquals((await client.ok("stop")).state, "stopped");
    });
  });
}

Deno.test("cov mcp: the move_node description promises the budgets every PHY returns", async () => {
  await withServer(async (client) => {
    const listed = (await client.request("tools/list")).result!.tools as Json[];
    const move = listed.find((t) => t.name === "move_node")!;
    assert(!/list is empty/.test(move.description), move.description);
    assertStringIncludes(move.description, "on every PHY");
  });
});

// ---------------------------------------------------------------- reading a run

Deno.test("cov mcp: get_events and get_serial page through a run without losing or repeating an event", async () => {
  await withServer(async (client) => {
    await client.ok("run_scenario", { path: LIVE });
    await pollStatus(client, (s) => s.state === "running", "the boards to connect");
    await until(
      async () => (await client.ok("get_events", { types: ["deliver"] })).events.length >= 20,
      "twenty deliveries",
    );
    await client.ok("stop");
    const all = await client.ok("get_events", { limit: 5000 });
    let since = -1;
    const paged: number[] = [];
    for (;;) {
      const page = await client.ok("get_events", { since_seq: since, limit: 7 });
      paged.push(...page.events.map((e: Json) => e.seq));
      if (!page.truncated) {
        assertEquals(page.next_since_seq, all.events[all.events.length - 1].seq);
        break;
      }
      since = page.next_since_seq;
    }
    assertEquals(paged, all.events.map((e: Json) => e.seq));
    const past = await client.ok("get_events", { since_seq: 1e9 });
    assertEquals([past.events, past.next_since_seq, past.truncated], [[], 1e9, false]);

    const serial = await client.ok("get_serial", { node: "a", tail: 1 });
    assertEquals(serial.lines.length, 1);
    const later = await client.ok("get_serial", { node: "a", since_ms: serial.next_since_ms });
    assertEquals([later.lines, later.next_since_ms], [[], serial.next_since_ms]);
    const early = await client.ok("get_serial", { node: "a", since_ms: -1e9, tail: 2000 });
    assertEquals(early.total, early.lines.length + 0);
    const view = await client.ok("get_view_state", {
      since: all.events[all.events.length - 1].seq,
    });
    assertEquals(view.timeline.entries, [], "nothing after the last event");
  });
});

// ---------------------------------------------------------------- editing scenario files

Deno.test("cov mcp: edit_scenario refuses each malformed edit and leaves the file as it was", async () => {
  await withServer(async (client, workspace) => {
    await client.ok("create_scenario", { path: "pair.yaml", yaml: PAIR });
    const file = `${workspace}/pair.yaml`;
    const cases: [Record<string, unknown>, string][] = [
      [{ set: { nodes: [] } }, "set cannot replace nodes"],
      [{ set: JSON.parse('{"__proto__": {"x": 1}}') }, "the key __proto__ is not allowed"],
      [{ set: { environment: JSON.parse('{"constructor": 1}') } }, "set.environment"],
      [{ nodes: { prototype: {} } }, "nodes: the key prototype is not allowed"],
      [{ nodes: { zz: {} } }, 'no node entry with id "zz" (entries: a, b, s)'],
      [{ nodes: { "s-2": {} } }, "s-2 is one of the 2 nodes of the group s"],
      [{ nodes: { a: 5 } }, "nodes.a must be an object or null"],
      [{ nodes: { a: [] } }, "nodes.a must be an object or null"],
      [{ nodes: { a: { id: "z" } } }, "renaming a node is not an edit"],
      [{ add: [5] }, "add[0] must be a node entry"],
      [{ add: [{ board: "scripted" }] }, "add[0].id must be a string"],
      [{ add: [{ id: "" }] }, "add[0].id must be a string"],
      [{ add: [{ id: "a", board: "scripted" }] }, 'a node entry with id "a" already exists'],
      [{ add: "x" }, "add must be an array"],
      [{ set: { duration: "forever" } }, "nothing was written"],
      [{ nodes: { b: { board: "esp32-c3" } } }, "nothing was written"],
    ];
    for (const [edit, words] of cases) {
      assertStringIncludes(
        await refusal(client, "edit_scenario", { path: "pair.yaml", ...edit }),
        words,
      );
      assertEquals(await Deno.readTextFile(file), PAIR, JSON.stringify(edit));
    }
    assertStringIncludes(
      await refusal(client, "add_node", { path: "pair.yaml", node: { id: "b" } }),
      "already exists",
    );
    assertStringIncludes(
      await refusal(client, "remove_node", { path: "pair.yaml", id: "s-1" }),
      "edit the group by its id s",
    );
    assertEquals(await Deno.readTextFile(file), PAIR);

    // null removes a key: without its seed the scenario takes the default one.
    const unseeded = await client.ok("edit_scenario", { path: "pair.yaml", set: { seed: null } });
    assertEquals(unseeded.scenario.seed, 1);
    assertStringIncludes(unseeded.note, "comments and the original layout are gone");
    const removed = await client.ok("remove_node", { path: "pair.yaml", id: "s" });
    assertEquals(removed.scenario.nodes.map((n: Json) => n.id), ["a", "b"]);
    const added = await client.ok("add_node", {
      path: "pair.yaml",
      node: { id: "c", board: "esp32", firmware: "./fw/c", position: [9, 9] },
    });
    assertEquals(added.missing_firmware.length, 1, "missing firmware is reported, not refused");
    assertStringIncludes(added.missing_firmware[0], join(workspace, "fw", "c"));
  });
});

Deno.test("cov mcp: a scenario file that is not a scenario is reported, not edited", async () => {
  await withServer(async (client, workspace) => {
    const files: Record<string, string> = {
      "broken.yaml": "name: [unclosed\n",
      "list.yaml": "- a\n- b\n",
      "nodes.yaml": "name: n\nnodes: { a: 1 }\n",
      "invalid.yaml": "name: n\nduration: 5\n",
    };
    for (const [name, text] of Object.entries(files)) {
      await Deno.writeTextFile(`${workspace}/${name}`, text);
    }
    assertStringIncludes(
      await refusal(client, "edit_scenario", { path: "broken.yaml", set: { seed: 1 } }),
      "is not valid YAML",
    );
    assertStringIncludes(
      await refusal(client, "edit_scenario", { path: "list.yaml", set: { seed: 1 } }),
      "its top level is not a map",
    );
    assertStringIncludes(
      await refusal(client, "edit_scenario", { path: "nodes.yaml", set: { seed: 1 } }),
      "nodes must be a list of node entries",
    );
    assertStringIncludes(
      await refusal(client, "edit_scenario", { path: "absent.yaml", set: { seed: 1 } }),
      "does not exist; create_scenario writes a new one",
    );
    for (const [name, text] of Object.entries(files)) {
      assertEquals(await Deno.readTextFile(`${workspace}/${name}`), text, name);
    }
    const read = await client.ok("read_scenario", { path: "invalid.yaml" });
    assertEquals([read.valid, read.yaml], [false, files["invalid.yaml"]]);
    assertStringIncludes(read.error, "duration");
    assertStringIncludes(
      await refusal(client, "read_scenario", { path: "absent.yaml" }),
      "does not exist",
    );
    assertStringIncludes(
      await refusal(client, "validate_scenario", { path: "broken.yaml" }),
      "not valid YAML",
    );
    assertStringIncludes(
      await refusal(client, "run_scenario", { path: "invalid.yaml" }),
      "duration",
    );
  });
});

// ---------------------------------------------------------------- regressions: caller mistakes are tool errors

Deno.test("cov mcp regression: a NUL byte in any path is a tool error, not a server fault", async () => {
  await withServer(async (client, workspace) => {
    await client.ok("create_scenario", { path: "pair.yaml", yaml: PAIR });
    const nul = "a\u0000.yaml";
    const cases: [string, Record<string, unknown>][] = [
      ["read_scenario", { path: nul }],
      ["validate_scenario", { path: nul }],
      ["create_scenario", { path: nul, yaml: QUICK }],
      ["edit_scenario", { path: nul, set: { seed: 2 } }],
      ["add_node", { path: nul, node: { id: "z" } }],
      ["remove_node", { path: nul, id: "a" }],
      ["run_scenario", { path: nul }],
      ["run_scenario", { path: "pair.yaml", out: "o\u0000ut" }],
    ];
    for (const [tool, args] of cases) {
      assertStringIncludes(await refusal(client, tool, args), "NUL", tool);
    }
    await client.ok("run_scenario", { path: "pair.yaml" });
    await pollStatus(client, (s) => s.state === "running", "the boards to connect");
    assertStringIncludes(
      await refusal(client, "export_capture", { kind: "pcap", path: "x\u0000.pcap" }),
      "NUL",
    );
    await client.ok("stop");
    assertEquals(await exists(`${workspace}/a`), false, "no file was cut at the NUL");
  });
});

Deno.test("cov mcp regression: a directory where a file belongs is a tool error, not a server fault", async () => {
  await withServer(async (client, workspace) => {
    await Deno.mkdir(`${workspace}/dir.yaml`);
    await Deno.mkdir(`${workspace}/capture.pcap`);
    const cases: [string, Record<string, unknown>][] = [
      ["read_scenario", { path: "dir.yaml" }],
      ["edit_scenario", { path: "dir.yaml", set: { seed: 2 } }],
      ["add_node", { path: "dir.yaml", node: { id: "z" } }],
      ["remove_node", { path: "dir.yaml", id: "a" }],
      ["create_scenario", { path: "dir.yaml", yaml: QUICK, overwrite: true }],
      ["validate_scenario", { path: "dir.yaml" }],
      ["run_scenario", { path: "dir.yaml" }],
    ];
    for (const [tool, args] of cases) {
      assertMatch(await refusal(client, tool, args), /is a directory/i, tool);
    }
    await client.ok("create_scenario", { path: "pair.yaml", yaml: PAIR });
    await client.ok("run_scenario", { path: "pair.yaml" });
    await pollStatus(client, (s) => s.state === "running", "the boards to connect");
    assertStringIncludes(
      await refusal(client, "export_capture", { kind: "pcap", path: "capture.pcap" }),
      "is a directory",
    );
    await client.ok("stop");
    assert((await Deno.stat(`${workspace}/dir.yaml`)).isDirectory, "left as it was");
  });
});

Deno.test("cov mcp regression: a file where a directory belongs is a tool error, not a server fault", async () => {
  await withServer(async (client, workspace) => {
    await Deno.writeTextFile(`${workspace}/plain`, "a file\n");
    await client.ok("create_scenario", { path: "pair.yaml", yaml: PAIR });
    const cases: [string, Record<string, unknown>][] = [
      ["create_scenario", { path: "plain/x.yaml", yaml: QUICK }],
      ["create_scenario", { path: "plain/deeper/x.yaml", yaml: QUICK }],
      ["run_scenario", { path: "pair.yaml", out: "plain" }],
      ["run_scenario", { path: "pair.yaml", out: "plain/run" }],
    ];
    for (const [tool, args] of cases) {
      assertStringIncludes(await refusal(client, tool, args), "is not a directory", tool);
    }
    await client.ok("run_scenario", { path: "pair.yaml" });
    await pollStatus(client, (s) => s.state === "running", "the boards to connect");
    assertStringIncludes(
      await refusal(client, "export_capture", { kind: "pcap", path: "plain/air.pcap" }),
      "is not a directory",
    );
    await client.ok("stop");
    assertEquals(await Deno.readTextFile(`${workspace}/plain`), "a file\n");
  });
});

/** Whether this process reads a file whatever its mode says, as root does. */
async function readsUnreadableFiles(): Promise<boolean> {
  const file = await Deno.makeTempFile({ prefix: "hzb-cov-mode-" });
  try {
    await Deno.chmod(file, 0o000);
    await Deno.readTextFile(file);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.PermissionDenied) return false;
    throw error;
  } finally {
    await Deno.remove(file);
  }
}

Deno.test({
  name: "cov mcp regression: an unreadable scenario file is a tool error, not a server fault",
  ignore: Deno.build.os === "windows" || await readsUnreadableFiles(),
  fn: async () => {
    await withServer(async (client, workspace) => {
      await client.ok("create_scenario", { path: "locked.yaml", yaml: PAIR });
      await Deno.chmod(`${workspace}/locked.yaml`, 0o000);
      try {
        for (
          const [tool, args] of [
            ["read_scenario", { path: "locked.yaml" }],
            ["edit_scenario", { path: "locked.yaml", set: { seed: 2 } }],
          ] as const
        ) {
          assertStringIncludes(await refusal(client, tool, args), "permission denied", tool);
        }
      } finally {
        await Deno.chmod(`${workspace}/locked.yaml`, 0o644);
      }
      assertEquals(await Deno.readTextFile(`${workspace}/locked.yaml`), PAIR);
    });
  },
});

Deno.test({
  name:
    "cov mcp regression: a path the file modes forbid writing is a tool error, not a server fault",
  ignore: Deno.build.os === "windows" || await readsUnreadableFiles(),
  fn: async () => {
    await withServer(async (client, workspace) => {
      await client.ok("create_scenario", { path: "pair.yaml", yaml: PAIR });
      await client.ok("create_scenario", { path: "locked.yaml", yaml: PAIR });
      await Deno.chmod(`${workspace}/locked.yaml`, 0o444);
      await Deno.mkdir(`${workspace}/ro`);
      await Deno.chmod(`${workspace}/ro`, 0o555);
      try {
        const cases: [string, Record<string, unknown>][] = [
          ["create_scenario", { path: "locked.yaml", yaml: QUICK, overwrite: true }],
          ["create_scenario", { path: "ro/x.yaml", yaml: QUICK }],
          ["create_scenario", { path: "ro/sub/x.yaml", yaml: QUICK }],
          ["run_scenario", { path: "pair.yaml", out: "ro/run" }],
        ];
        for (const [tool, args] of cases) {
          assertMatch(await refusal(client, tool, args), /permission denied/i, tool);
        }
        await client.ok("run_scenario", { path: "pair.yaml" });
        await pollStatus(client, (s) => s.state === "running", "the boards to connect");
        assertMatch(
          await refusal(client, "export_capture", { kind: "pcap", path: "ro/air.pcap" }),
          /permission denied/i,
        );
        await client.ok("stop");
        assertEquals(await listDir(`${workspace}/ro`), [], "nothing was written there");
      } finally {
        await Deno.chmod(`${workspace}/ro`, 0o755);
        await Deno.chmod(`${workspace}/locked.yaml`, 0o644);
      }
      assertEquals(await Deno.readTextFile(`${workspace}/locked.yaml`), PAIR);
    });
  },
});

Deno.test("cov mcp regression: a dangling symlink on the way to a write is refused as a way out", async () => {
  await withServer(async (client, workspace) => {
    await Deno.symlink("/nonexistent/hertzbench-cov", `${workspace}/dangling`, { type: "file" });
    await client.ok("create_scenario", { path: "pair.yaml", yaml: PAIR });
    const cases: [string, Record<string, unknown>][] = [
      ["create_scenario", { path: "dangling/x.yaml", yaml: QUICK }],
      ["create_scenario", { path: "dangling/deeper/x.yaml", yaml: QUICK }],
      ["run_scenario", { path: "pair.yaml", out: "dangling" }],
      ["run_scenario", { path: "pair.yaml", out: "dangling/run" }],
    ];
    for (const [tool, args] of cases) {
      assertStringIncludes(await refusal(client, tool, args), "through a symlink", tool);
    }
    await client.ok("run_scenario", { path: "pair.yaml" });
    await pollStatus(client, (s) => s.state === "running", "the boards to connect");
    for (const path of ["dangling", "dangling/air.pcap"]) {
      assertStringIncludes(
        await refusal(client, "export_capture", { kind: "pcap", path }),
        "through a symlink",
        path,
      );
    }
    await client.ok("stop");
    assertEquals(await exists("/nonexistent/hertzbench-cov"), false);
  });
});

// ---------------------------------------------------------------- what no tool may reach or run

Deno.test("cov mcp: no write leaves the workspace, by absolute path, by .. or through a symlink", async () => {
  const outside = await Deno.makeTempDir({ prefix: "hzb-cov-outside-" });
  try {
    await Deno.writeTextFile(`${outside}/victim.yaml`, PAIR);
    await withServer(async (client, workspace) => {
      await Deno.symlink(outside, `${workspace}/door`);
      await Deno.symlink(`${outside}/victim.yaml`, `${workspace}/victim-link.yaml`);
      await client.ok("create_scenario", { path: "pair.yaml", yaml: PAIR });
      const escapes = [
        `${outside}/new.yaml`,
        "../new.yaml",
        "sub/../../new.yaml",
        "door/new.yaml",
        "door/deeper/new.yaml",
      ];
      const fileTools = (path: string): [string, Record<string, unknown>][] => [
        ["create_scenario", { path, yaml: QUICK, overwrite: true }],
        ["edit_scenario", { path, set: { seed: 2 } }],
        ["add_node", { path, node: { id: "z", board: "scripted", position: [0, 0] } }],
        ["remove_node", { path, id: "a" }],
      ];
      for (const path of [...escapes, `${outside}/victim.yaml`, "victim-link.yaml"]) {
        for (const [tool, args] of fileTools(path)) {
          assertMatch(
            await refusal(client, tool, args),
            /inside the workspace|through a symlink/,
            `${tool} ${path}`,
          );
        }
      }
      // An example outside the workspace is read, never edited in place.
      assertStringIncludes(
        await refusal(client, "edit_scenario", { path: LIVE, set: { seed: 2 } }),
        "inside the workspace",
      );
      for (const out of [outside, "../out", "door", "door/run"]) {
        assertMatch(
          await refusal(client, "run_scenario", { path: "pair.yaml", out }),
          /inside the workspace|through a symlink/,
          out,
        );
      }
      await client.ok("run_scenario", { path: "pair.yaml" });
      await pollStatus(client, (s) => s.state === "running", "the boards to connect");
      for (
        const path of [`${outside}/air.pcap`, "../air.pcap", "door/air.pcap", "victim-link.yaml"]
      ) {
        assertMatch(
          await refusal(client, "export_capture", { kind: "pcap", path }),
          /inside the workspace|through a symlink/,
          path,
        );
      }
      await client.ok("stop");
    });
    assertEquals(await listDir(outside), ["victim.yaml"], "nothing was created outside");
    assertEquals(await Deno.readTextFile(`${outside}/victim.yaml`), PAIR, "nothing was changed");
    assertEquals(
      await Deno.readTextFile(`${EXAMPLES}live-3-scripted.yaml`).then((t) => t.length > 0),
      true,
    );
  } finally {
    await Deno.remove(outside, { recursive: true });
  }
});

const stubTest = skipOnWindows(
  "the stubs are POSIX shell scripts found through PATH; Windows would not run them, so the test would prove nothing",
);

// Programs an attacker would want a tool to start: shells, interpreters,
// build tools, browsers. Each stub leaves a canary file if anything runs it.
const STUBS = [
  "sh",
  "bash",
  "zsh",
  "python",
  "python3",
  "node",
  "deno",
  "cmake",
  "make",
  "idf.py",
  "xdg-open",
  "open",
  "firefox",
  "chromium",
  "google-chrome",
  "curl",
  "wget",
  "sudo",
  "env",
];

stubTest("cov mcp: no tool starts a host program, whatever its arguments say", async () => {
  const bin = await Deno.makeTempDir({ prefix: "hzb-cov-bin-" });
  const canary = await Deno.makeTempDir({ prefix: "hzb-cov-canary-" });
  try {
    for (const name of STUBS) {
      await Deno.writeTextFile(`${bin}/${name}`, `#!/bin/sh\n: > "${canary}/${name}"\n`);
      await Deno.chmod(`${bin}/${name}`, 0o755);
    }
    const env = {
      PATH: `${bin}${PATH_DELIMITER}${Deno.env.get("PATH") ?? ""}`,
      BROWSER: `${bin}/firefox`,
    };
    await withServer(async (client, workspace) => {
      const hostile = "$(touch pwned);`touch pwned2`|sh -c 'touch pwned3'&&rm -rf ~";
      const listed = (await client.request("tools/list")).result!.tools as Json[];
      // Every tool, idle, with every string argument a shell would act on.
      for (const tool of listed) {
        const args: Record<string, unknown> = {};
        for (const [key, schema] of Object.entries(tool.inputSchema.properties as Json)) {
          if ((schema as Json).type === "string" && !(schema as Json).enum) args[key] = hostile;
        }
        await rawCall(client, tool.name, args);
      }
      // A literal file name, created inside the workspace and nowhere else.
      const name = "$(touch pwned).yaml";
      const created = await client.ok("create_scenario", { path: name, yaml: PAIR });
      assertEquals(created.file, `${workspace}/${name}`);
      // And a live run driven through every live tool, the view included.
      await client.ok("run_scenario", { path: name, out: "out/$(id)" });
      await pollStatus(client, (s) => s.state === "running", "the boards to connect");
      await client.ok("start_phase", { label: hostile });
      await client.ok("move_node", { node: "a", position: [1, 1], phase: hostile });
      await client.ok("inject_fault", { link: "a->b", extra_loss_pct: 1, phase: hostile });
      await client.ok("set_channel", { base_latency_ms: 1, phase: hostile });
      await client.ok("set_radio", { node: "a", antenna_gain_dbi: 1, phase: hostile });
      await refusal(client, "send_serial", { node: "a", text: hostile });
      await client.ok("export_capture", { kind: "pcap", path: "`id`.pcap" });
      const view = await client.ok("open_view", { port: 0 });
      assertMatch(view.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
      assertEquals((await client.ok("open_view", { port: 0 })).already_open, true);
      await client.ok("get_view_state");
      await client.ok("stop");
      assertEquals(
        (await listDir(workspace)).filter((n) => n.startsWith("pwned")),
        [],
        "no shell ran a hostile argument",
      );
    }, env);
    assertEquals(await listDir(canary), [], "no stub was started");
  } finally {
    await Deno.remove(bin, { recursive: true });
    await Deno.remove(canary, { recursive: true });
  }
});

// The control for the test above: the stubs do catch a program the server
// starts. The one it starts is the ESP32 worker, through the interpreter the
// person running the server chose (HERTZBENCH_PYTHON, else python3 on PATH),
// never one a tool argument names.
stubTest(
  "cov mcp: the stub PATH catches the one program a run starts, the operator's ESP32 worker",
  async () => {
    const bin = await Deno.makeTempDir({ prefix: "hzb-cov-bin-" });
    const canary = await Deno.makeTempDir({ prefix: "hzb-cov-canary-" });
    try {
      await Deno.writeFile(`${bin}/libqemu-xtensa.so`, new Uint8Array(0));
      await Deno.writeTextFile(`${bin}/python3`, `#!/bin/sh\n: > "${canary}/python3"\nexit 3\n`);
      await Deno.chmod(`${bin}/python3`, 0o755);
      const env = {
        PATH: `${bin}${PATH_DELIMITER}${Deno.env.get("PATH") ?? ""}`,
        QEMU_ESP32_LIB: `${bin}/libqemu-xtensa.so`,
      };
      await withServer(async (client, workspace) => {
        await Deno.writeFile(`${workspace}/fw.bin`, new Uint8Array(16));
        await client.ok("create_scenario", { path: "esp.yaml", yaml: ESP32_PAIR });
        await client.ok("run_scenario", { path: "esp.yaml" });
        await pollStatus(client, (s) => s.state === "failed", "the stub worker to fail the run");
      }, env);
      assertEquals(await listDir(canary), ["python3"]);
    } finally {
      await Deno.remove(bin, { recursive: true });
      await Deno.remove(canary, { recursive: true });
    }
  },
);

// ---------------------------------------------------------------- concurrency

Deno.test("cov mcp: forty calls in flight on a live run are each answered once, by their own id", async () => {
  await withServer(async (client) => {
    await client.ok("run_scenario", { path: LIVE });
    await pollStatus(client, (s) => s.state === "running", "the boards to connect");
    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < 4; i++) {
      calls.push(
        client.request("ping"),
        client.request("tools/list"),
        client.request("resources/read", { uri: "hertzbench://examples/live-3-scripted.yaml" }),
        client.ok("get_status"),
        client.ok("get_events", { limit: 50 }),
        client.ok("get_metrics"),
        client.ok("get_view_state"),
        client.ok("get_serial", { node: "b" }),
        client.ok("start_phase", { label: `p${i}` }),
        client.ok("move_node", { node: "c", position: [12 + i, 4] }),
      );
    }
    const answers = await Promise.all(calls);
    assertEquals(answers.length, 40);
    assertEquals(client.unmatched, [], "no stray or duplicate answer");
    const status = await client.ok("get_status");
    assertEquals(status.state, "running");
    assertEquals(status.nodes.find((n: Json) => n.id === "c").position.y, 4);

    const stops = await Promise.all([1, 2, 3].map(() => client.call("stop")));
    assert(stops.some((s) => !s.isError), "one stop succeeds");
    for (const stop of stops) {
      if (stop.isError) assertStringIncludes(stop.text, "no run in progress");
      else assertEquals(stop.value.state, "stopped");
    }
    assertEquals((await client.ok("get_status")).state, "stopped");
  });
});

Deno.test("cov mcp: concurrent writers: one create wins, five run_scenario calls start one run", async () => {
  await withServer(async (client, workspace) => {
    const creates = await Promise.all(
      [1, 2, 3, 4, 5].map((seed) =>
        client.call("create_scenario", {
          path: "race.yaml",
          yaml: PAIR.replace("seed: 5", `seed: ${seed}`),
        })
      ),
    );
    assertEquals(creates.filter((c) => !c.isError).length, 1, "createNew lets one through");
    for (const c of creates.filter((c) => c.isError)) assertStringIncludes(c.text, "exists");
    const winner = creates.find((c) => !c.isError)!.value.scenario.seed;
    assertStringIncludes(await Deno.readTextFile(`${workspace}/race.yaml`), `seed: ${winner}`);

    const edits = await Promise.all(
      [10, 11, 12, 13].map((seed) =>
        client.call("edit_scenario", { path: "race.yaml", set: { seed } })
      ),
    );
    assert(edits.every((e) => !e.isError), JSON.stringify(edits.map((e) => e.text)));
    const read = await client.ok("read_scenario", { path: "race.yaml" });
    assertEquals(read.valid, true, "each edit replaced the file whole");
    assert([10, 11, 12, 13].includes(read.scenario.seed), read.scenario.seed);
    const leftovers = (await listDir(workspace)).filter((n) => n.endsWith(".tmp"));
    assertEquals(leftovers, [], "no temporary file is left behind");

    const runs = await Promise.all(
      [1, 2, 3, 4, 5].map(() => client.call("run_scenario", { path: "race.yaml" })),
    );
    assertEquals(runs.filter((r) => !r.isError).length, 1);
    for (const r of runs.filter((r) => r.isError)) {
      assertMatch(r.text, /preparing a run|call stop first/);
    }
    await pollStatus(client, (s) => s.state === "running", "the boards to connect");
    await client.ok("stop");
  });
});

Deno.test("cov mcp: open_view refuses a port in use, then serves on a free one, once", async () => {
  const taken = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  try {
    const port = (taken.addr as Deno.NetAddr).port;
    await withServer(async (client) => {
      assertStringIncludes(
        await refusal(client, "open_view", { port }),
        `port ${port} is in use; pass another, or 0 for a free one`,
      );
      const view = await client.ok("open_view");
      assertEquals(view.already_open, false);
      const page = await fetch(view.url);
      assertEquals(page.status, 200);
      await page.body?.cancel();
      const again = await client.ok("open_view", { port });
      assertEquals([again.url, again.already_open], [view.url, true]);
    });
  } finally {
    taken.close();
  }
});

// ---------------------------------------------------------------- in process: what no stdio client can reach

function pipe(lines: string[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(lines.join("\n"));
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function serveInProcess(server: McpServer, lines: string[], stop?: AbortSignal) {
  let text = "";
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      text += new TextDecoder().decode(chunk);
    },
  });
  await serveLines(server, pipe(lines), output, stop);
  return text.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
}

Deno.test("cov mcp in process: a server fault is a JSON-RPC internal error with the call's id, logged with its stack", async () => {
  const logged: string[] = [];
  const server = new McpServer({
    info: { name: "t", version: "0" },
    tools: [
      {
        name: "boom",
        description: "throws a bug",
        inputSchema: { type: "object" },
        call: () => Promise.reject(new RangeError("bug inside")),
      },
      {
        name: "refuse",
        description: "throws a caller's mistake",
        inputSchema: { type: "object" },
        call: () => Promise.reject(new ToolError("fix your input")),
      },
    ],
    resources: () => Promise.reject(new Error("resources broke")),
    log: (message) => logged.push(message),
  });
  const quiet = console.error;
  console.error = () => {};
  try {
    const answers = await serveInProcess(server, [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "boom" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "refuse" } }),
      JSON.stringify({ jsonrpc: "2.0", id: "r", method: "resources/list" }),
      JSON.stringify({ jsonrpc: "2.0", method: "resources/list" }),
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "initialize" }),
    ]);
    const byId = new Map(answers.map((a) => [a.id, a]));
    assertEquals(byId.get(1).error.code, -32603);
    assertStringIncludes(byId.get(1).error.message, "boom failed: bug inside");
    assertEquals(byId.get(2).result, {
      content: [{ type: "text", text: "fix your input" }],
      isError: true,
    });
    assertEquals(byId.get("r").error.code, -32603);
    assertStringIncludes(byId.get("r").error.message, "resources broke");
    assertEquals(byId.get(4).result.instructions, undefined, "no instructions, no field");
    assertEquals(answers.length, 4, "the failing notification is not answered");
    assertEquals(logged.length, 1);
    assertStringIncludes(logged[0]!, "RangeError: bug inside");
  } finally {
    console.error = quiet;
  }
});

Deno.test("cov mcp in process: a stop signal that already fired reads nothing", async () => {
  const server = new McpServer({
    info: { name: "t", version: "0" },
    tools: [],
    resources: () => Promise.resolve([]),
  });
  const stop = new AbortController();
  stop.abort();
  const answers = await serveInProcess(
    server,
    [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })],
    stop.signal,
  );
  assertEquals(answers, []);
});
