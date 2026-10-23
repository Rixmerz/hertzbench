// The visual layer's HTTP server: a page that draws the run of one Session (a
// map of the nodes, links colored by signal or loss, a packet timeline) and
// moves a node when it is dragged. It reads what the MCP tools read and writes
// only through the MCP `move_node` tool, so a move from the page and a move
// from an agent are the same call.
//
// It listens on 127.0.0.1 only. Any web page the user has open can still send
// requests to a loopback port, so every request must name this server in its
// Host header (DNS rebinding, CWE-350), and a write must be JSON from no origin
// or this one (CSRF, CWE-352). A cross-site JSON POST needs a CORS preflight,
// which this server never answers.

import { PRODUCT } from "../brand.ts";
import { ToolError } from "../mcp/protocol.ts";
import type { Session } from "../mcp/session.ts";
import { tools } from "../mcp/tools.ts";
import { viewState } from "./scene.ts";

export interface ViewOptions {
  /** 0 picks a free port. */
  port: number;
}

export interface ViewServer {
  readonly url: string;
  /** Stop listening; requests in flight finish first. */
  shutdown(): Promise<void>;
}

const STATIC = new URL("./static/", import.meta.url);
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

// Reused from the Velxio frontend as they are, read from disk: its design
// tokens, the fonts they name and its board drawings. Nothing in frontend/ is
// changed or built.
const VELXIO = new URL("../../frontend/", import.meta.url);
const VELXIO_TOKENS = [
  "index.css",
  "colors.css",
  "spacing.css",
  "typography.css",
  "radius.css",
  "elevation.css",
  "motion.css",
  "z-index.css",
];
const VELXIO_FONTS = ["Inter.var.woff2", "JetBrainsMono.var.woff2"];
const BOARD_IMAGES: Record<string, string> = { esp32: "esp32-devkit-v1.svg" };

const HEADERS = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; " +
    "img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; " +
    "frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const MAX_BODY_BYTES = 16 * 1024;

export function serveView(session: Session, options: ViewOptions): ViewServer {
  const moveNode = tools(session).find((tool) => tool.name === "move_node") ??
    missingTool("move_node");
  let port = options.port;
  const allowedHosts = () => [`127.0.0.1:${port}`, `localhost:${port}`];

  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: options.port,
    onListen: () => {},
  }, async (request) => {
    const url = new URL(request.url);
    if (!allowedHosts().includes(request.headers.get("host") ?? "")) {
      return text(403, "unknown host");
    }
    try {
      if (request.method === "GET") return await get(url);
      if (request.method === "POST" && url.pathname === "/api/move") {
        const refused = refuseWrite(request, allowedHosts());
        if (refused) return refused;
        return await move(request);
      }
      return text(405, "method not allowed");
    } catch (error) {
      console.error(
        `[${PRODUCT.slug}] view: ${request.method} ${url.pathname}: ${
          error instanceof Error ? error.stack : error
        }`,
      );
      return text(500, "internal error; see the server's stderr");
    }
  });
  port = server.addr.port;

  async function get(url: URL): Promise<Response> {
    const asset = STATIC_FILES[url.pathname];
    if (asset) return await file(new URL(asset.file, STATIC), asset.type);
    const token = url.pathname.match(/^\/velxio\/tokens\/([a-z-]+\.css)$/)?.[1];
    if (token && VELXIO_TOKENS.includes(token)) {
      return await file(new URL(`src/tokens/${token}`, VELXIO), "text/css; charset=utf-8");
    }
    // The tokens load their fonts from /fonts/, as in the Velxio app.
    const font = url.pathname.match(/^\/fonts\/([A-Za-z.]+\.woff2)$/)?.[1];
    if (font && VELXIO_FONTS.includes(font)) {
      return await file(new URL(`public/fonts/${font}`, VELXIO), "font/woff2");
    }
    const board = url.pathname.match(/^\/velxio\/boards\/([a-z0-9-]+\.svg)$/)?.[1];
    if (board && Object.values(BOARD_IMAGES).includes(board)) {
      return await file(new URL(`public/boards/${board}`, VELXIO), "image/svg+xml");
    }
    if (url.pathname === "/api/view") {
      const since = Number(url.searchParams.get("since") ?? "-1");
      if (!Number.isInteger(since) || since < -1) return text(400, "since must be an integer");
      return json(200, view(since));
    }
    return text(404, "not found");
  }

  function view(since: number) {
    const state = viewState(session, since);
    return {
      ...state,
      board_images: state.scene === null ? {} : Object.fromEntries(
        Object.entries(BOARD_IMAGES).map(([kind, name]) => [kind, `/velxio/boards/${name}`]),
      ),
    };
  }

  async function move(request: Request): Promise<Response> {
    const body = await request.text();
    if (body.length > MAX_BODY_BYTES) return text(413, "body too large");
    let args: unknown;
    try {
      args = JSON.parse(body);
    } catch {
      return json(400, { error: "the body is not JSON" });
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      return json(400, { error: "the body must be a JSON object" });
    }
    try {
      return json(200, await moveNode.call(args as Record<string, unknown>));
    } catch (error) {
      if (error instanceof ToolError) return json(400, { error: error.message });
      throw error;
    }
  }

  return {
    url: `http://127.0.0.1:${port}/`,
    shutdown: () => server.shutdown(),
  };
}

function missingTool(name: string): never {
  throw new Error(`the MCP tools have no ${name}`);
}

/** Null when the write may go ahead; otherwise the refusal. */
function refuseWrite(request: Request, hosts: string[]): Response | null {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    return text(415, "writes must be application/json");
  }
  // Browsers send Origin on every POST; tools such as curl send none.
  const origin = request.headers.get("origin");
  if (origin !== null && !hosts.some((host) => origin === `http://${host}`)) {
    return text(403, "cross-origin writes are refused");
  }
  return null;
}

async function file(url: URL, type: string): Promise<Response> {
  try {
    return new Response(await Deno.readFile(url), {
      headers: { ...HEADERS, "content-type": type },
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return text(404, "not found");
    throw error;
  }
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...HEADERS, "content-type": "application/json" },
  });
}

function text(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { ...HEADERS, "content-type": "text/plain; charset=utf-8" },
  });
}
