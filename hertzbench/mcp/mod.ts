// The MCP server: `hertzbench mcp`, spoken over stdin and stdout by an AI
// agent such as Claude Code. stdout carries only protocol messages; progress
// and diagnostics go to stderr.

import denoConfig from "../deno.json" with { type: "json" };
import { PRODUCT } from "../brand.ts";
import { McpServer, serveLines } from "./protocol.ts";
import { Session, type SessionOptions } from "./session.ts";
import { resources, tools } from "./tools.ts";

export { McpServer, serveLines, ToolError } from "./protocol.ts";
export { Session } from "./session.ts";
export { resources, tools } from "./tools.ts";

const INSTRUCTIONS =
  `${PRODUCT.displayName} simulates the radio network between emulated boards. ` +
  "Typical loop: list_boards, read an example resource, create_scenario, validate_scenario, " +
  "run_scenario, poll get_status until running, then move_node / inject_fault and read " +
  "get_metrics and get_serial; the run ends by itself at its duration, or call stop. " +
  "Boards marked fidelity none (scripted) are traffic generators, not firmware.";

export function createServer(session: Session): McpServer {
  return new McpServer({
    info: { name: PRODUCT.slug, version: denoConfig.version, instructions: INSTRUCTIONS },
    tools: tools(session),
    resources,
  });
}

/** Serve on stdin and stdout until the client closes stdin or a signal arrives; then stop any run. */
export async function runMcpServer(options: SessionOptions): Promise<void> {
  const session = new Session({
    ...options,
    progress: options.progress ?? ((line) => console.error(`[${PRODUCT.slug}] ${line}`)),
  });
  // A signal ends the server the way end of input does, so the run in progress
  // is stopped below and no board is left running.
  const shutdown = new AbortController();
  const onSignal = () => shutdown.abort();
  const signals: Deno.Signal[] = Deno.build.os === "windows" ? ["SIGINT"] : ["SIGINT", "SIGTERM"];
  for (const signal of signals) Deno.addSignalListener(signal, onSignal);
  try {
    await serveLines(
      createServer(session),
      Deno.stdin.readable,
      Deno.stdout.writable,
      shutdown.signal,
    );
  } finally {
    for (const signal of signals) Deno.removeSignalListener(signal, onSignal);
    await session.close();
  }
}
