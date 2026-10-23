// The MCP server: `hertzbench mcp`, spoken over stdin and stdout by an AI
// agent such as Claude Code. stdout carries only protocol messages; progress
// and diagnostics go to stderr.

import denoConfig from "../deno.json" with { type: "json" };
import { PRODUCT } from "../brand.ts";
import { serveView, type ViewServer } from "../view/server.ts";
import { McpServer, serveLines } from "./protocol.ts";
import { Session, type SessionOptions } from "./session.ts";
import { resources, tools, type ViewOpener } from "./tools.ts";

export { McpServer, serveLines, ToolError } from "./protocol.ts";
export { Session } from "./session.ts";
export { resources, tools, type ViewOpener } from "./tools.ts";

const INSTRUCTIONS = `${PRODUCT.displayName} simulates the radio network between emulated boards ` +
  "(Wi-Fi/IP, ESP-NOW, LoRa, nRF24, BLE). Typical loop: list_boards, read an example resource, " +
  "create_scenario (or read_scenario and edit_scenario, add_node, remove_node), " +
  "validate_scenario, run_scenario, poll get_status until running. While it runs: move_node, " +
  "inject_fault (loss, latency, jitter, interference), set_channel, set_radio, start_phase, " +
  "send_serial; read get_serial, get_metrics, get_events, get_view_state and export_capture. " +
  "The run ends by itself at its duration (then get_report), or call stop. open_view gives a " +
  "person a live map. Boards marked fidelity none (scripted) are traffic generators, not " +
  "firmware. No tool runs host commands.";

export function createServer(session: Session, openView?: ViewOpener): McpServer {
  return new McpServer({
    info: { name: PRODUCT.slug, version: denoConfig.version, instructions: INSTRUCTIONS },
    tools: tools(session, openView),
    resources,
  });
}

/**
 * Serve on stdin and stdout until the client closes stdin or a signal arrives;
 * then stop any run. With `viewPort`, the same session is also drawn by the
 * visual layer on that loopback port, so a person can watch the agent's run.
 */
export async function runMcpServer(
  options: SessionOptions & { viewPort?: number },
): Promise<void> {
  const log = (line: string) => console.error(`[${PRODUCT.slug}] ${line}`);
  const session = new Session({ ...options, progress: options.progress ?? log });
  // At most one view per server: from --view-port, or the first open_view.
  let view: ViewServer | null = options.viewPort === undefined
    ? null
    : serveView(session, { port: options.viewPort });
  if (view) log(`view: ${view.url}`);
  const openView: ViewOpener = (port) => {
    if (view) return { url: view.url, already_open: true };
    view = serveView(session, { port });
    log(`view: ${view.url}`);
    return { url: view.url, already_open: false };
  };
  // A signal ends the server the way end of input does, so the run in progress
  // is stopped below and no board is left running.
  const shutdown = new AbortController();
  const onSignal = () => shutdown.abort();
  const signals: Deno.Signal[] = Deno.build.os === "windows" ? ["SIGINT"] : ["SIGINT", "SIGTERM"];
  for (const signal of signals) Deno.addSignalListener(signal, onSignal);
  try {
    await serveLines(
      createServer(session, openView),
      Deno.stdin.readable,
      Deno.stdout.writable,
      shutdown.signal,
    );
  } finally {
    for (const signal of signals) Deno.removeSignalListener(signal, onSignal);
    await session.close();
    await view?.shutdown();
  }
}
