// The Model Context Protocol subset this server speaks: JSON-RPC 2.0 messages,
// one per line on stdin and stdout, with initialize, ping, tools/list,
// tools/call, resources/list and resources/read. Nothing else is needed for
// tools and static resources.
//
// ponytail: hand-written instead of npm:@modelcontextprotocol/sdk. The SDK
// pulls an HTTP and OAuth stack (express, hono, jose, cors, ...) into a
// stdio-only server. Switch to it if we ever need sampling, subscriptions or
// the HTTP transport.

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** JSON-RPC error codes. */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/**
 * A failure the caller can fix: bad arguments, an invalid scenario, a board
 * that cannot start. It goes back as a tool result with `isError`, so the model
 * reads it, rather than as a protocol error.
 */
export class ToolError extends Error {
  override name = "ToolError";
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  inputSchema: Record<string, unknown>;
  /** Returns the result as a JSON value. Throws ToolError for a failure the caller can fix. */
  call(args: Record<string, unknown>): Promise<unknown>;
}

export interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  read(): Promise<string>;
}

export interface ServerInfo {
  name: string;
  version: string;
  instructions?: string;
}

type Id = string | number;

interface Response {
  jsonrpc: "2.0";
  id: Id | null;
  result?: unknown;
  error?: { code: number; message: string };
}

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class McpServer {
  readonly #info: ServerInfo;
  readonly #tools: Map<string, ToolDefinition>;
  readonly #resources: () => Promise<ResourceDefinition[]>;
  /** Unexpected errors: logged with their stack, never written to stdout. */
  readonly #log: (message: string) => void;

  constructor(options: {
    info: ServerInfo;
    tools: ToolDefinition[];
    resources: () => Promise<ResourceDefinition[]>;
    log?: (message: string) => void;
  }) {
    this.#info = options.info;
    this.#tools = new Map(options.tools.map((t) => [t.name, t]));
    this.#resources = options.resources;
    this.#log = options.log ?? ((message) => console.error(message));
  }

  /** Answer one parsed message. Notifications get no answer: null. */
  async handle(message: unknown): Promise<Response | null> {
    if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      // A response from the client (we send no requests) or garbage.
      if (isObject(message) && message.jsonrpc === "2.0" && !("method" in message)) return null;
      return this.#error(null, INVALID_REQUEST, "not a JSON-RPC 2.0 request");
    }
    const id = message.id;
    const isNotification = id === undefined;
    if (!isNotification && typeof id !== "string" && typeof id !== "number") {
      return this.#error(null, INVALID_REQUEST, "id must be a string or a number");
    }
    try {
      const result = await this.#dispatch(message.method, message.params);
      return isNotification ? null : { jsonrpc: "2.0", id: id as Id, result };
    } catch (error) {
      if (isNotification) return null;
      if (error instanceof RpcError) return this.#error(id as Id, error.code, error.message);
      throw error;
    }
  }

  #error(id: Id | null, code: number, message: string): Response {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }

  #dispatch(method: string, params: unknown): Promise<unknown> | unknown {
    switch (method) {
      case "initialize":
        return this.#initialize(params);
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: [...this.#tools.values()].map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        };
      case "tools/call":
        return this.#callTool(params);
      case "resources/list":
        return this.#listResources();
      case "resources/templates/list":
        return { resourceTemplates: [] };
      case "resources/read":
        return this.#readResource(params);
      default:
        if (method.startsWith("notifications/")) return {};
        throw new RpcError(METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }

  #initialize(params: unknown) {
    const requested = isObject(params) ? params.protocolVersion : undefined;
    // Answer with the client's version when we speak it, else with our newest
    // and let the client decide whether to go on.
    const protocolVersion = (PROTOCOL_VERSIONS as readonly unknown[]).includes(requested)
      ? requested
      : PROTOCOL_VERSIONS[0];
    return {
      protocolVersion,
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: this.#info.name, version: this.#info.version },
      ...(this.#info.instructions ? { instructions: this.#info.instructions } : {}),
    };
  }

  async #callTool(params: unknown) {
    if (!isObject(params) || typeof params.name !== "string") {
      throw new RpcError(INVALID_PARAMS, "tools/call needs a tool name");
    }
    const tool = this.#tools.get(params.name);
    if (!tool) throw new RpcError(INVALID_PARAMS, `unknown tool: ${params.name}`);
    const args = params.arguments ?? {};
    if (!isObject(args)) throw new RpcError(INVALID_PARAMS, "arguments must be an object");
    try {
      const value = await tool.call(args);
      return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
    } catch (error) {
      if (error instanceof ToolError) {
        return { content: [{ type: "text", text: error.message }], isError: true };
      }
      // A bug, not the caller's fault: keep the stack on stderr, and answer
      // with a protocol error so the call does not look like a tool verdict.
      this.#log(`${tool.name} failed: ${error instanceof Error ? error.stack : String(error)}`);
      throw new RpcError(
        INTERNAL_ERROR,
        `${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #listResources() {
    const resources = await this.#resources();
    return {
      resources: resources.map(({ uri, name, description, mimeType }) => ({
        uri,
        name,
        description,
        mimeType,
      })),
    };
  }

  async #readResource(params: unknown) {
    if (!isObject(params) || typeof params.uri !== "string") {
      throw new RpcError(INVALID_PARAMS, "resources/read needs a uri");
    }
    const uri = params.uri;
    const resource = (await this.#resources()).find((r) => r.uri === uri);
    // -32002 is the code the MCP specification gives "resource not found".
    if (!resource) throw new RpcError(-32002, `resource not found: ${uri}`);
    return { contents: [{ uri, mimeType: resource.mimeType, text: await resource.read() }] };
  }
}

/**
 * Serve newline-delimited JSON-RPC until `input` ends or `stop` aborts.
 * Requests are answered as they complete, so a slow call never holds up a
 * ping. Resolves once every answer has been written.
 */
export async function serveLines(
  server: McpServer,
  input: ReadableStream<Uint8Array>,
  output: WritableStream<Uint8Array>,
  stop?: AbortSignal,
): Promise<void> {
  const writer = output.getWriter();
  const encoder = new TextEncoder();
  let writes = Promise.resolve();
  const send = (response: Response) => {
    const line = encoder.encode(JSON.stringify(response) + "\n");
    writes = writes.then(() => writer.write(line));
  };
  const pending = new Set<Promise<void>>();
  const reader = input.pipeThrough(new TextDecoderStream()).getReader();
  const cancel = () => reader.cancel().catch(() => {/* already closed */});
  if (stop?.aborted) cancel();
  else stop?.addEventListener("abort", cancel, { once: true });
  let buffered = "";
  const onLine = (line: string) => {
    if (line.trim() === "") return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "not valid JSON" } });
      return;
    }
    const task = server.handle(message).then(
      (response) => {
        if (response) send(response);
      },
      (error) => {
        // handle() only rethrows what is not an RpcError: a bug in the server itself.
        console.error(error instanceof Error ? error.stack : error);
        const id = isObject(message) && (typeof message.id === "string" ||
            typeof message.id === "number")
          ? message.id
          : null;
        send({ jsonrpc: "2.0", id, error: { code: INTERNAL_ERROR, message: String(error) } });
      },
    );
    pending.add(task);
    task.finally(() => pending.delete(task));
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += value;
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      onLine(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
    }
  }
  stop?.removeEventListener("abort", cancel);
  onLine(buffered);
  await Promise.all(pending);
  await writes;
  writer.releaseLock();
}
