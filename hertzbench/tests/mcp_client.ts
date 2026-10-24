// A test client for `hertzbench mcp`: the server as a separate process, spoken
// to over stdin and stdout the way Claude Code does. Shared by the MCP tests.

import { fileURLToPath } from "node:url";
import { assert, assertEquals } from "@std/assert";

const MAIN = fileURLToPath(new URL("../cli/main.ts", import.meta.url));
export const EXAMPLES = fileURLToPath(new URL("../scenarios/examples/", import.meta.url));

// Tool results are JSON documents read field by field; typing each one here
// would only restate the server.
// deno-lint-ignore no-explicit-any
export type Json = any;

export interface RpcResponse {
  id: number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export interface ToolOutcome {
  isError: boolean;
  text: string;
  value: Json;
}

export class McpClient {
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

export async function withServer(
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
export async function pollStatus(client: McpClient, done: (status: Json) => boolean, what: string) {
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

export async function pollMetrics(client: McpClient, done: (metrics: Json) => boolean) {
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
