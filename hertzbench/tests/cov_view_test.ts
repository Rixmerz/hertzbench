// The view's server and scene model through their error paths and edges:
// every way a request can be wrong (method, host, origin, content type, body,
// query), every file it serves and every file it must not, the quality
// buckets at and around each boundary and with values no channel model
// produces, and the timeline cursor. In process, no browser: the page itself
// is measured in view_ui_test.ts.

import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import {
  type ChipSignal,
  type EngineEvent,
  environmentFromPreset,
  type LinkBudget,
  type Position,
} from "../engine/mod.ts";
import { ToolError } from "../mcp/protocol.ts";
import { Session } from "../mcp/session.ts";
import {
  chipSignalQuality,
  LOSS_WINDOW_MS,
  lossQuality,
  sceneInterference,
  sceneLinks,
  sceneObstacles,
  signalQuality,
  TIMELINE_CAP,
  timelineSince,
  viewState,
} from "../view/scene.ts";
import { serveView, type ViewServer } from "../view/server.ts";

const LIVE = fileURLToPath(new URL("../scenarios/examples/live-3-scripted.yaml", import.meta.url));

// Answers are JSON documents read field by field.
// deno-lint-ignore no-explicit-any
type Json = any;

// ── A session whose answers the test sets ───────────────────────────────────

/** Just what the server reads from a Session; any call it did not expect throws. */
class StubSession {
  state: "idle" | "running" = "running";
  elapsed: number | null = 1000;
  failStatus: Error | null = null;
  failMove: Error | null = null;
  moved: { node: string; to: Position; phase: string | null }[] = [];

  get run() {
    return this.state === "idle"
      ? null
      : { loaded: { scenario: { phy: "wifi", environment: { obstacles: [], interference: [] } } } };
  }

  status() {
    if (this.failStatus) throw this.failStatus;
    if (this.state === "idle") return { state: "idle" as const };
    return {
      state: "running" as const,
      run_id: "r",
      scenario: "stub",
      seed: 1,
      duration_ms: 1000,
      elapsed_ms: this.elapsed,
      nodes: [],
      problems: [],
    };
  }

  events(): readonly EngineEvent[] {
    return [];
  }

  elapsedMs(): number | null {
    return this.elapsed;
  }

  linkBudgets() {
    return [];
  }

  move(node: string, to: Position, phase: string | null) {
    if (this.failMove) throw this.failMove;
    this.moved.push({ node, to, phase });
    return { node, to };
  }
}

async function serving<T>(
  session: StubSession | Session,
  fn: (server: ViewServer, port: number) => Promise<T>,
): Promise<T> {
  const server = serveView(session as Session, { port: 0 });
  try {
    return await fn(server, Number(new URL(server.url).port));
  } finally {
    await server.shutdown();
  }
}

/** One HTTP/1.1 request written by hand, so the Host header and the path are exactly what is given. */
async function raw(
  port: number,
  request: string,
): Promise<{ status: number; head: string; body: string }> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  try {
    await conn.write(new TextEncoder().encode(request.replaceAll("\n", "\r\n")));
    const text = await new Response(conn.readable).text();
    const [head = "", ...rest] = text.split("\r\n\r\n");
    return {
      status: Number(head.match(/^HTTP\/1\.[01] (\d+)/)?.[1]),
      head,
      body: rest.join("\r\n\r\n"),
    };
  } finally {
    try {
      conn.close();
    } catch {
      // The server already closed it after answering Connection: close.
    }
  }
}

const get = (port: number, path: string, host = `127.0.0.1:${port}`) =>
  raw(port, `GET ${path} HTTP/1.1\nHost: ${host}\nConnection: close\n\n`);

function post(
  port: number,
  body: string,
  headers: Record<string, string> = {},
  host = `127.0.0.1:${port}`,
) {
  const lines = Object.entries({ "content-type": "application/json", ...headers })
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `${name}: ${value}`);
  return raw(
    port,
    `POST /api/move HTTP/1.1\nHost: ${host}\n${lines.join("\n")}\nContent-Length: ${
      new TextEncoder().encode(body).length
    }\nConnection: close\n\n${body}`,
  );
}

// ── Who may ask ─────────────────────────────────────────────────────────────

Deno.test("view server: a request must name this server in Host, on either loopback name, exactly", async () => {
  await serving(new StubSession(), async (_server, port) => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      assertEquals((await get(port, "/api/view", host)).status, 200, host);
    }
    for (
      const host of [
        "127.0.0.1", // no port
        `127.0.0.1:${port + 1}`,
        `127.0.0.1:${port}.evil.example`,
        `evil.example:${port}`,
        `[::1]:${port}`,
        `LOCALHOST:${port}`, // browsers send it lowercase; a different spelling is a different name
        ` 127.0.0.1:${port}`.trim() + "x",
        `0.0.0.0:${port}`,
      ]
    ) {
      const answer = await get(port, "/api/view", host);
      assertEquals(answer.status, 403, host);
      assertEquals(answer.body, "unknown host");
    }
    // HTTP/1.0 with no Host at all.
    const bare = await raw(port, "GET /api/view HTTP/1.0\n\n");
    assertEquals(bare.status, 403);
    // The refusal covers writes too: nothing reaches the tool.
    assertEquals((await post(port, "{}", {}, "evil.example")).status, 403);
  });
});

Deno.test("view server: only GET reads and only POST /api/move writes, and nothing answers a CORS preflight", async () => {
  const stub = new StubSession();
  await serving(stub, async (_server, port) => {
    for (const method of ["PUT", "DELETE", "PATCH", "OPTIONS", "HEAD", "TRACE"]) {
      const answer = await raw(
        port,
        `${method} /api/view HTTP/1.1\nHost: 127.0.0.1:${port}\nConnection: close\n\n`,
      );
      assertEquals(answer.status, 405, method);
      assert(
        !/access-control-allow/i.test(answer.head),
        `${method} was answered with CORS headers`,
      );
    }
    // A preflight as a browser sends it.
    const preflight = await raw(
      port,
      `OPTIONS /api/move HTTP/1.1\nHost: 127.0.0.1:${port}\nOrigin: http://evil.example\nAccess-Control-Request-Method: POST\nAccess-Control-Request-Headers: content-type\nConnection: close\n\n`,
    );
    assertEquals(preflight.status, 405);
    assert(!/access-control/i.test(preflight.head));
    // POST anywhere else, and GET on the write path, are not the write.
    assertEquals(
      (await raw(
        port,
        `POST /api/view HTTP/1.1\nHost: 127.0.0.1:${port}\nContent-Length: 0\nConnection: close\n\n`,
      )).status,
      405,
    );
    assertEquals(
      (await raw(
        port,
        `POST / HTTP/1.1\nHost: 127.0.0.1:${port}\nContent-Length: 0\nConnection: close\n\n`,
      )).status,
      405,
    );
    assertEquals((await get(port, "/api/move")).status, 404);
    assertEquals(stub.moved, []);
  });
});

Deno.test("view server: a write needs application/json from no origin or this one, and refuses the rest before the tool runs", async () => {
  const stub = new StubSession();
  await serving(stub, async (_server, port) => {
    const body = JSON.stringify({ node: "a", position: [1, 2] });
    for (
      const type of [
        "text/plain",
        "application/x-www-form-urlencoded",
        "multipart/form-data; boundary=x",
        "application/jsonx",
        "application/json-patch+json",
        "text/json",
        "",
      ]
    ) {
      assertEquals(
        (await post(port, body, { "content-type": type })).status,
        415,
        JSON.stringify(type),
      );
    }
    assertEquals(stub.moved.length, 0);
    for (
      const origin of [
        "http://evil.example",
        "null", // a sandboxed frame or a file: page
        `http://127.0.0.1:${port + 1}`,
        `https://127.0.0.1:${port}`,
        `http://127.0.0.1:${port}.evil.example`,
        `http://127.0.0.1:${port}/`,
        `http://localhost:${port + 1}`,
        `HTTP://127.0.0.1:${port}`,
      ]
    ) {
      assertEquals((await post(port, body, { origin })).status, 403, origin);
    }
    assertEquals(stub.moved.length, 0, "a refused write reached the tool");
    // The accepted forms: no origin (curl, the MCP client), this origin under either name, any case and parameters.
    for (
      const headers of [
        {} as Record<string, string>,
        { origin: `http://127.0.0.1:${port}` },
        { origin: `http://localhost:${port}` },
        { "content-type": "application/json; charset=utf-8" },
        { "content-type": "Application/JSON" },
        { "content-type": "application/json ;charset=utf-8" },
      ]
    ) {
      const answer = await post(port, body, headers);
      assertEquals(answer.status, 200, JSON.stringify(headers));
    }
    assertEquals(stub.moved.length, 6);
    assertEquals(stub.moved[0], { node: "a", to: { x: 1, y: 2 }, phase: null });
  });
});

// ── What a write may say ────────────────────────────────────────────────────

Deno.test("view server: a body that is not a JSON object is refused with a sentence, never a stack", async () => {
  const stub = new StubSession();
  await serving(stub, async (_server, port) => {
    for (const body of ["", "{", "not json", "{'node': 'a'}", "\u0000", '{"node":"a",}']) {
      const answer = await post(port, body);
      assertEquals(answer.status, 400, JSON.stringify(body));
      assertEquals(JSON.parse(answer.body), { error: "the body is not JSON" });
    }
    for (const body of ["[]", "[1,2]", "null", "5", '"text"', "true", "false"]) {
      const answer = await post(port, body);
      assertEquals(answer.status, 400, body);
      assertEquals(JSON.parse(answer.body), { error: "the body must be a JSON object" });
    }
    assertEquals(stub.moved.length, 0);
  });
});

Deno.test("view server: the body is capped at 16 KiB, counted to the character", async () => {
  const stub = new StubSession();
  await serving(stub, async (_server, port) => {
    const padded = (length: number) => {
      const head = '{"node":"a","position":[0,0],"phase":"';
      const tail = '"}';
      return head + "x".repeat(length - head.length - tail.length) + tail;
    };
    // Exactly at the cap it is read and judged by the tool, which is happy with a long phase name or not.
    const at = await post(port, padded(16 * 1024));
    assert(at.status !== 413, `a 16384-character body was refused as too large: ${at.status}`);
    const over = await post(port, padded(16 * 1024 + 1));
    assertEquals(over.status, 413);
    assertEquals(over.body, "body too large");
    // The same, with no JSON in it at all, is judged on size first.
    assertEquals((await post(port, "x".repeat(16 * 1024 + 1))).status, 413);
  });
});

Deno.test("view server: the tool's own refusals come back as 400 with its sentence, other failures as a 500 that names nothing", async () => {
  const stub = new StubSession();
  await serving(stub, async (_server, port) => {
    for (
      const args of [
        { position: [1, 2] }, // no node
        { node: "a" }, // no position
        { node: "", position: [1, 2] },
        { node: 7, position: [1, 2] },
        { node: "a", position: [1] },
        { node: "a", position: "1,2" },
        { node: "a", position: [1, "2"] },
        { node: "a", position: [1, 2], extra: true },
        { node: "a", position: [1e999, 0] }, // Infinity once parsed
      ]
    ) {
      const answer = await post(port, JSON.stringify(args));
      assertEquals(answer.status, 400, JSON.stringify(args));
      assertEquals(typeof JSON.parse(answer.body).error, "string");
      assertEquals(JSON.parse(answer.body).error.length > 0, true);
    }
    assertEquals(stub.moved.length, 0);

    stub.failMove = new ToolError("no node named zz");
    const refused = await post(port, JSON.stringify({ node: "zz", position: [0, 0] }));
    assertEquals(refused.status, 400);
    assertEquals(JSON.parse(refused.body), { error: "no node named zz" });

    // An engine bug: the person gets a fixed sentence, the stack goes to stderr.
    stub.failMove = new Error("secret detail at /home/someone/engine.ts:42");
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      const broken = await post(port, JSON.stringify({ node: "a", position: [0, 0] }));
      assertEquals(broken.status, 500);
      assertEquals(broken.body, "internal error; see the server's stderr");
      assert(!broken.head.includes("secret") && !broken.body.includes("secret"));
    } finally {
      console.error = original;
    }
    assertEquals(logged.length, 1);
    assertStringIncludes(String(logged[0]), "POST /api/move");
    assertStringIncludes(String(logged[0]), "secret detail");
  });
});

Deno.test("view server: a failure reading the run is a 500 without detail, an error that is not an Error too", async () => {
  const stub = new StubSession();
  await serving(stub, async (_server, port) => {
    const original = console.error;
    const logged: string[] = [];
    console.error = (...args: unknown[]) => void logged.push(args.join(" "));
    try {
      stub.failStatus = new Error("disk on fire");
      const first = await get(port, "/api/view");
      assertEquals(first.status, 500);
      assertEquals(first.body, "internal error; see the server's stderr");
      stub.failStatus = "plain string thrown" as unknown as Error;
      assertEquals((await get(port, "/api/view")).status, 500);
      stub.failStatus = null;
      assertEquals((await get(port, "/api/view")).status, 200, "the server recovers");
    } finally {
      console.error = original;
    }
    assertEquals(logged.length, 2);
    assertStringIncludes(logged[0]!, "disk on fire");
    assertStringIncludes(logged[1]!, "plain string thrown");
  });
});

// ── The query ───────────────────────────────────────────────────────────────

Deno.test("view server: since is an integer from -1; anything else is a 400 that says so", async () => {
  await serving(new StubSession(), async (_server, port) => {
    for (const since of ["-1", "0", "1", "42", "007", "1e3", "+5", "%205", "9007199254740991"]) {
      const answer = await get(port, `/api/view?since=${since}`);
      assertEquals(answer.status, 200, since);
      assertEquals(
        JSON.parse(answer.body).timeline.next_since,
        Number(decodeURIComponent(since)) >= 0 ? Number(decodeURIComponent(since)) : -1,
      );
    }
    for (
      const since of [
        "-2",
        "-100",
        "1.5",
        "0.1",
        "abc",
        "Infinity",
        "-Infinity",
        "NaN",
        "0x",
        "1,2",
        "--1",
        "1%20x",
      ]
    ) {
      const answer = await get(port, `/api/view?since=${since}`);
      assertEquals(answer.status, 400, since);
      assertEquals(answer.body, "since must be an integer");
    }
    // No since is the whole log; the first of several wins; unrelated parameters are ignored.
    assertEquals((await get(port, "/api/view")).status, 200);
    assertEquals((await get(port, "/api/view?since=3&since=oops")).status, 200);
    assertEquals((await get(port, "/api/view?other=1")).status, 200);
    assertEquals((await get(port, "/api/view?since=")).status, 200);
  });
});

Deno.test("view server: before a run there is nothing to draw, and before time zero no link", async () => {
  const stub = new StubSession();
  stub.state = "idle";
  await serving(stub, async (_server, port) => {
    const idle = JSON.parse((await get(port, "/api/view")).body);
    assertEquals(idle, {
      status: { state: "idle" },
      scene: null,
      timeline: null,
      board_images: {},
    });
    stub.state = "running";
    stub.elapsed = null;
    const starting = JSON.parse((await get(port, "/api/view")).body);
    assertEquals(starting.scene.links, []);
    assertEquals(starting.scene.phy, "wifi");
    assertEquals(starting.scene.window_ms, LOSS_WINDOW_MS);
    assertEquals(starting.board_images, { esp32: "/velxio/boards/esp32-devkit-v1.svg" });
    assertEquals(starting.timeline, { entries: [], next_since: -1, truncated: false });
  });
});

// ── What it serves ──────────────────────────────────────────────────────────

Deno.test("view server: the page, its script and style, Velxio's tokens, fonts and the board drawing, each with the strict headers", async () => {
  await serving(new StubSession(), async (_server, port) => {
    const files: [string, string][] = [
      ["/", "text/html; charset=utf-8"],
      ["/app.js", "text/javascript; charset=utf-8"],
      ["/style.css", "text/css; charset=utf-8"],
      ...["index", "colors", "spacing", "typography", "radius", "elevation", "motion", "z-index"]
        .map(
          (name): [string, string] => [`/velxio/tokens/${name}.css`, "text/css; charset=utf-8"],
        ),
      ["/fonts/Inter.var.woff2", "font/woff2"],
      ["/fonts/JetBrainsMono.var.woff2", "font/woff2"],
      ["/velxio/boards/esp32-devkit-v1.svg", "image/svg+xml"],
      ["/app.js?cache=bust", "text/javascript; charset=utf-8"],
    ];
    for (const [path, type] of files) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      assertEquals(response.status, 200, path);
      assertEquals(response.headers.get("content-type"), type, path);
      assertEquals(response.headers.get("x-content-type-options"), "nosniff", path);
      assertEquals(response.headers.get("cache-control"), "no-store", path);
      assertEquals(response.headers.get("referrer-policy"), "no-referrer", path);
      const policy = response.headers.get("content-security-policy") ?? "";
      assertStringIncludes(policy, "default-src 'none'");
      assertStringIncludes(policy, "script-src 'self'");
      assertStringIncludes(policy, "frame-ancestors 'none'");
      assert(!policy.includes("unsafe-inline") && !policy.includes("unsafe-eval"), policy);
      assert((await response.arrayBuffer()).byteLength > 100, path);
    }
    const json = await fetch(`http://127.0.0.1:${port}/api/view`);
    assertEquals(json.headers.get("content-type"), "application/json");
    assertEquals(json.headers.get("cache-control"), "no-store");
    await json.body?.cancel();
  });
});

Deno.test("view server: nothing outside the short list of files is reachable, however the path is spelled", async () => {
  await serving(new StubSession(), async (_server, port) => {
    for (
      const path of [
        "/index.html",
        "/app.js/",
        "/APP.JS",
        "/static/app.js",
        "/../deno.json",
        "/velxio/tokens/../../../deno.json", // sent as written: the request line is not normalised
        "/velxio/tokens/../../public/fonts/Inter.var.woff2",
        "/velxio/tokens/%2e%2e/%2e%2e/deno.json",
        "/velxio/tokens/..%2f..%2fdeno.json",
        "/velxio/tokens/colors.CSS",
        "/velxio/tokens/colors.css/",
        "/velxio/tokens/evil.css",
        "/velxio/tokens/",
        "/velxio/tokens/.css",
        "/velxio/tokens/a.b.css",
        "/velxio/boards/arduino-uno.svg",
        "/velxio/boards/../../package.json",
        "/velxio/boards/esp32-devkit-v1.svg.map",
        "/fonts/Inter.woff2",
        "/fonts/Inter.var.woff",
        "/fonts/../../etc/passwd",
        "/fonts/Inter.var.woff2/",
        "/fonts/%2e%2e/x.woff2",
        "/etc/passwd",
        "/api",
        "/api/",
        "/api/view/",
        "//",
        "/%00",
      ]
    ) {
      const answer = await get(port, path);
      assertEquals(answer.status, 404, path);
      assertEquals(answer.body, "not found", path);
    }
  });
});

Deno.test("view server: a port in use is an AddrInUse the CLI can name, and a stopped server stops answering", async () => {
  const first = serveView(new StubSession() as unknown as Session, { port: 0 });
  const port = Number(new URL(first.url).port);
  assertMatch(first.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  let error: unknown;
  try {
    serveView(new StubSession() as unknown as Session, { port });
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof Deno.errors.AddrInUse, String(error));
  assertEquals((await fetch(first.url + "api/view")).status, 200);
  await first.shutdown();
  await first.shutdown(); // twice is fine
  let refused = false;
  try {
    await fetch(first.url);
  } catch {
    refused = true; // connection refused: nothing listens any more
  }
  assert(refused, "the server answered after shutdown");
});

Deno.test("view server: it listens on loopback only", async () => {
  await serving(new StubSession(), (server) => {
    assertEquals(new URL(server.url).hostname, "127.0.0.1");
    return Promise.resolve();
  });
});

Deno.test("view server: many readers at once all get the same document", async () => {
  await serving(new StubSession(), async (_server, port) => {
    const answers = await Promise.all(
      Array.from(
        { length: 40 },
        () => fetch(`http://127.0.0.1:${port}/api/view?since=-1`).then((r) => r.text()),
      ),
    );
    assertEquals(new Set(answers).size, 1);
  });
});

// ── Against a real run ──────────────────────────────────────────────────────

Deno.test("view server: on a real run the move tool reaches the engine, and what the engine refuses comes back as 400", async () => {
  const dir = await Deno.makeTempDir({ prefix: "hzb-cov-view-" });
  const session = new Session({ workspace: dir });
  const server = serveView(session, { port: 0 });
  const port = Number(new URL(server.url).port);
  try {
    // No run yet: the tool says so.
    const idle = await post(port, JSON.stringify({ node: "a", position: [1, 1] }));
    assertEquals(idle.status, 400);
    assert(JSON.parse(idle.body).error.length > 0);
    assertEquals(JSON.parse((await get(port, "/api/view")).body).status, { state: "idle" });

    await session.start(LIVE, { out: `${dir}/out` });
    const deadline = performance.now() + 30_000;
    while (session.status().state !== "running" || session.elapsedMs(session.run!) === null) {
      assert(performance.now() < deadline, "the run did not start");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const running: Json = JSON.parse((await get(port, "/api/view")).body);
    assertEquals(running.status.nodes.map((n: Json) => n.id), ["a", "b", "c"]);
    assertEquals(running.scene.links.length, 6);
    assertEquals(running.scene.obstacles, [{ from: [30, -20], to: [30, 20], attenuation_db: 12 }]);
    assertEquals(running.board_images.esp32, "/velxio/boards/esp32-devkit-v1.svg");

    const moved = await post(
      port,
      JSON.stringify({ node: "c", position: [20.5, -3.25], phase: "dragged" }),
    );
    assertEquals(moved.status, 200, moved.body);
    assertEquals(JSON.parse(moved.body).to, { x: 20.5, y: -3.25 });
    const after: Json = JSON.parse((await get(port, "/api/view?since=-1")).body);
    assertEquals(after.status.nodes.find((n: Json) => n.id === "c").position, {
      x: 20.5,
      y: -3.25,
    });
    const entries = after.timeline.entries.map((e: Json) => e.type);
    assert(entries.includes("move") && entries.includes("phase"), entries.join());
    assertEquals(after.timeline.entries.find((e: Json) => e.type === "phase").label, "dragged");

    for (
      const [args, wanted] of [
        [{ node: "nobody", position: [1, 1] }, "no node named"],
        [{ node: "a", position: [1, 2, 3, 4] }, "position"],
        [{ node: "a", position: [0, 0], phase: "" }, ""],
      ] as [Record<string, unknown>, string][]
    ) {
      const refused = await post(port, JSON.stringify(args));
      if (wanted) {
        assertEquals(refused.status, 400, JSON.stringify(args));
        assertStringIncludes(JSON.parse(refused.body).error, wanted);
      }
    }

    // The run ends: the page can still read it, but the engine takes no more moves.
    await session.stop();
    const stopped: Json = JSON.parse((await get(port, "/api/view")).body);
    assertEquals(stopped.status.state, "stopped");
    const late = await post(port, JSON.stringify({ node: "a", position: [1, 1] }));
    assertEquals(late.status, 400);
    assertEquals(
      JSON.parse((await get(port, "/api/view?since=-1")).body).timeline.entries.length > 0,
      true,
    );
  } finally {
    await session.close();
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

// ── The scene model at its edges ────────────────────────────────────────────

const LORA: ChipSignal = {
  frequencyHz: 868.1e6,
  bandwidthHz: 125e3,
  noiseFigureDb: 6,
  txPowerDbm: 14,
  requiredSnrDb: -7.5,
  referenceBytes: 20,
  rateBps: 5468.75,
};

function budget(snrDb: number, rssiDbm = snrDb - 94, distanceM = 10): LinkBudget {
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

Deno.test("scene: the Wi-Fi buckets switch exactly at 26, 17 and 9 dB and hold for values no link has", () => {
  const cases: [number, string][] = [
    [Infinity, "good"],
    [1e9, "good"],
    [26.000001, "good"],
    [26, "good"],
    [25.999999, "fair"],
    [21, "fair"],
    [17.000001, "fair"],
    [17, "fair"],
    [16.999999, "poor"],
    [12, "poor"],
    [9.000001, "poor"],
    [9, "poor"],
    [8.999999, "bad"],
    [0, "bad"],
    [-0, "bad"],
    [-50, "bad"],
    [-Infinity, "bad"],
    [NaN, "bad"], // a budget that is not a number is no link at all
  ];
  for (const [snr, expected] of cases) assertEquals(signalQuality(snr), expected, String(snr));
});

Deno.test("scene: the loss buckets switch exactly at 1, 10 and 50 percent, and idle is only for no data", () => {
  const cases: [number | null, string][] = [
    [null, "idle"],
    [-5, "good"],
    [0, "good"],
    [0.999999, "good"],
    [1, "fair"],
    [9.999999, "fair"],
    [10, "poor"],
    [49.999999, "poor"],
    [50, "bad"],
    [99.9, "bad"],
    [100, "bad"],
    [150, "bad"],
    [Infinity, "bad"],
    [NaN, "bad"],
  ];
  for (const [loss, expected] of cases) assertEquals(lossQuality(loss), expected, String(loss));
});

Deno.test("scene: a chip PHY's buckets follow its own floor, whatever the floor is", () => {
  // The 10% point sits at requiredSnrDb; one decade of loss per 1.5 dB around it.
  for (const required of [-20, -7.5, 0, 8, 12.3, 30]) {
    const signal = { ...LORA, requiredSnrDb: required };
    assertEquals(chipSignalQuality(required + 40, signal), "good", `${required} +40`);
    assertEquals(chipSignalQuality(required + 3.2, signal), "good", `${required} +3.2`);
    assertEquals(chipSignalQuality(required + 1.4, signal), "fair", `${required} +1.4`);
    assertEquals(chipSignalQuality(required - 0.05, signal), "poor", `${required} -0.05`);
    assertEquals(chipSignalQuality(required - 5, signal), "bad", `${required} -5`);
    assertEquals(chipSignalQuality(required - 40, signal), "bad", `${required} -40`);
  }
  assertEquals(chipSignalQuality(Infinity, LORA), "good");
  assertEquals(chipSignalQuality(-Infinity, LORA), "bad");
  assertEquals(chipSignalQuality(NaN, LORA), "bad");
});

Deno.test("scene links: Wi-Fi and chip links carry their own rate, floor and rounding", () => {
  const [wifi, chip, edge] = sceneLinks(
    [
      { from: "a", to: "b", budget: budget(30.123456789, -63.987654321, 12.3456789) },
      { from: "n", to: "gw", budget: { ...budget(-5), signal: LORA } },
      { from: "x", to: "y", budget: budget(8.9999) },
    ],
    [],
    5000,
  );
  assertEquals(wifi, {
    from: "a",
    to: "b",
    distance_m: 12.346,
    rssi_dbm: -63.988,
    snr_db: 30.123,
    rate_bps: 54e6,
    required_snr_db: null,
    signal: "good",
    window_frames: 0,
    window_loss_pct: null,
    loss: "idle",
    override: null,
  });
  assertEquals(chip!.rate_bps, 5468.75);
  assertEquals(chip!.required_snr_db, -7.5);
  assertEquals(chip!.signal, "good");
  assertEquals(
    edge!.rate_bps,
    6e6,
    "below every threshold the slowest rate is still the one quoted",
  );
  assertEquals(edge!.signal, "bad");
  assertEquals(sceneLinks([], [], 0), []);
});

function frame(seq: number, t: number, from: string, to: string, ok: boolean): EngineEvent {
  const base = { seq, t, from, to, bytes: 10, kind: "udp" as const, rssiDbm: -60, snrDb: 30 };
  return ok
    ? { ...base, type: "deliver", delayMs: 1, attempts: 1, rateMbps: 54 }
    : { ...base, type: "drop", reason: "retry_exhausted", attempts: 7 };
}

Deno.test("scene links: the loss window starts exactly 2 s back, and a link with no sender in it is idle", () => {
  const now = 10_000;
  const events: EngineEvent[] = [
    frame(0, now - LOSS_WINDOW_MS - 0.001, "a", "b", false), // just outside
    frame(1, now - LOSS_WINDOW_MS, "a", "b", false), // exactly on the edge: in
    frame(2, now - 1, "a", "b", true),
    frame(3, now - 5000, "b", "a", false), // old: b->a is idle
  ];
  const [ab, ba, ac] = sceneLinks(
    [
      { from: "a", to: "b", budget: budget(30) },
      { from: "b", to: "a", budget: budget(30) },
      { from: "a", to: "c", budget: budget(30) },
    ],
    events,
    now,
  );
  assertEquals([ab!.window_frames, ab!.window_loss_pct, ab!.loss], [2, 50, "bad"]);
  assertEquals([ba!.window_frames, ba!.window_loss_pct, ba!.loss], [0, null, "idle"]);
  assertEquals([ac!.window_frames, ac!.window_loss_pct, ac!.loss], [0, null, "idle"]);
});

Deno.test("scene links: an override stays until a rule that sets everything to zero, and each field counts", () => {
  const override = (
    seq: number,
    from: string,
    to: string,
    extra: Record<string, number>,
  ): EngineEvent =>
    ({
      seq,
      t: seq * 10,
      type: "link-override",
      from,
      to,
      extraLossPct: 0,
      extraLatencyMs: 0,
      ...extra,
    }) as EngineEvent;
  const links = [
    { from: "a", to: "b", budget: budget(30) },
    { from: "b", to: "a", budget: budget(30) },
    { from: "a", to: "c", budget: budget(30) },
    { from: "c", to: "a", budget: budget(30) },
    { from: "b", to: "c", budget: budget(30) },
  ];
  const events = [
    override(0, "a", "b", { extraLossPct: 10 }),
    override(1, "b", "a", { extraLatencyMs: 5 }),
    override(2, "a", "c", { extraJitterMs: 3 }),
    override(3, "c", "a", { interferenceDb: 20 }),
    override(4, "x", "y", { extraLossPct: 99 }), // a pair the run has no link for
    override(5, "b", "c", { extraLossPct: 50 }),
    override(6, "b", "c", {}), // cleared
  ];
  const got = sceneLinks(links, events, 1000).map((l) => l.override);
  assertEquals(got[0], {
    extra_loss_pct: 10,
    extra_latency_ms: 0,
    extra_jitter_ms: 0,
    interference_db: 0,
  });
  assertEquals(got[1], {
    extra_loss_pct: 0,
    extra_latency_ms: 5,
    extra_jitter_ms: 0,
    interference_db: 0,
  });
  assertEquals(got[2], {
    extra_loss_pct: 0,
    extra_latency_ms: 0,
    extra_jitter_ms: 3,
    interference_db: 0,
  });
  assertEquals(got[3], {
    extra_loss_pct: 0,
    extra_latency_ms: 0,
    extra_jitter_ms: 0,
    interference_db: 20,
  });
  assertEquals(got[4], null);
});

Deno.test("scene obstacles: walls become segments in metres with their loss", () => {
  assertEquals(sceneObstacles([]), []);
  assertEquals(
    sceneObstacles([{ from: [0, 0], to: [10, 5], attenuationDb: 7.5 }, {
      from: [-1, -1],
      to: [-1, 9],
      attenuationDb: 0,
    }]),
    [{ from: [0, 0], to: [10, 5], attenuation_db: 7.5 }, {
      from: [-1, -1],
      to: [-1, 9],
      attenuation_db: 0,
    }],
  );
});

// ── The timeline cursor ─────────────────────────────────────────────────────

Deno.test("timeline: a cap of zero keeps nothing and says it left some out", () => {
  const events = [frame(0, 1, "a", "b", true), frame(1, 2, "a", "b", false)];
  const none = timelineSince(events, -1, 0);
  assertEquals(none.entries, []);
  assertEquals(none.truncated, true);
  assertEquals(none.next_since, 1);
});

Deno.test("timeline: the cap keeps the newest, the cursor passes events that draw nothing, and an empty log leaves it where it was", () => {
  const log: EngineEvent[] = [];
  for (let i = 0; i < TIMELINE_CAP + 10; i++) log.push(frame(i, i, "a", "b", i % 2 === 0));
  const all = timelineSince(log, -1);
  assertEquals(all.entries.length, TIMELINE_CAP);
  assertEquals(all.truncated, true);
  assertEquals(all.entries[0]!.seq, 10, "the newest 4000, so the oldest 10 are the ones left out");
  assertEquals(all.next_since, TIMELINE_CAP + 9);
  const tail = timelineSince(log, TIMELINE_CAP + 5);
  assertEquals(tail.entries.map((e) => e.seq), [
    TIMELINE_CAP + 6,
    TIMELINE_CAP + 7,
    TIMELINE_CAP + 8,
    TIMELINE_CAP + 9,
  ]);
  assertEquals(tail.truncated, false);
  // Nothing new: the cursor does not move, backwards least of all.
  assertEquals(timelineSince(log, 10_000), { entries: [], next_since: 10_000, truncated: false });
  assertEquals(timelineSince([], -1), { entries: [], next_since: -1, truncated: false });
  // An event that draws nothing still advances the cursor, so it is not read again.
  const quiet: EngineEvent[] = [
    { seq: 7, t: 1, type: "serial", node: "a", text: "hello" } as EngineEvent,
  ];
  assertEquals(timelineSince(quiet, 3), { entries: [], next_since: 7, truncated: false });
});

Deno.test("timeline: only deliver, drop, move, phase and link-override draw; every other event type is left out", () => {
  const at = (type: string, extra: Record<string, unknown> = {}) =>
    ({ seq: 0, t: 1, type, ...extra }) as unknown as EngineEvent;
  for (
    const type of [
      "tx",
      "service",
      "serial",
      "espnow-send",
      "ble-link",
      "channel",
      "radio",
      "warning",
    ]
  ) {
    assertEquals(timelineSince([at(type)], -1).entries, [], type);
  }
  const drawn = timelineSince(
    [
      at("deliver", { from: "a", to: "b", kind: "udp", bytes: 3, delayMs: 1.23456, attempts: 1 }),
      at("drop", {
        from: "a",
        to: "b",
        kind: "udp",
        bytes: 3,
        reason: "out_of_range",
        attempts: 2,
      }),
      at("move", { node: "a", position: { x: 1, y: 2 } }),
      at("phase", { label: "go" }),
      at("link-override", { from: "a", to: "b", extraLossPct: 5, extraLatencyMs: 2 }),
      at("link-override", {
        from: "a",
        to: "b",
        extraLossPct: 5,
        extraLatencyMs: 2,
        extraJitterMs: 1,
        interferenceDb: 3,
      }),
    ],
    -1,
  ).entries;
  assertEquals(drawn.map((e) => e.type), [
    "deliver",
    "drop",
    "move",
    "phase",
    "link-override",
    "link-override",
  ]);
  assertEquals((drawn[0] as Json).delay_ms, 1.235);
  assertEquals((drawn[1] as Json).reason, "out_of_range");
  assertEquals((drawn[4] as Json).extra_jitter_ms, 0);
  assertEquals((drawn[4] as Json).interference_db, 0);
  assertEquals((drawn[5] as Json).extra_jitter_ms, 1);
  assertEquals((drawn[5] as Json).interference_db, 3);
});

Deno.test("scene: viewState on a session with no run, or no time zero, has no links and no crash", () => {
  const stub = new StubSession();
  stub.state = "idle";
  assertEquals(viewState(stub as unknown as Session, -1), {
    status: { state: "idle" },
    scene: null,
    timeline: null,
  });
  stub.state = "running";
  stub.elapsed = null;
  const scene = viewState(stub as unknown as Session, -1);
  assertEquals(scene.scene!.links, []);
  assertEquals(scene.timeline, { entries: [], next_since: -1, truncated: false });
});

Deno.test("scene: a named wall keeps its id, an unnamed one has none, and sources carry their state", () => {
  assertEquals(
    sceneObstacles([
      { id: "door", from: [0, 0], to: [0, 4], attenuationDb: 12 },
      { from: [5, 0], to: [5, 4], attenuationDb: 6 },
    ]),
    [
      { id: "door", from: [0, 0], to: [0, 4], attenuation_db: 12 },
      { from: [5, 0], to: [5, 4], attenuation_db: 6 },
    ],
  );
  assertEquals(
    sceneInterference([
      { id: "oven", position: { x: 3, y: 4 }, powerDbm: 20, band: "2.4ghz", active: true },
      { id: "ap", position: { x: 1, y: 2, z: 3 }, powerDbm: -5, band: "868mhz", active: false },
    ]),
    [
      { id: "oven", position: [3, 4], power_dbm: 20, band: "2.4ghz", active: true },
      { id: "ap", position: [1, 2], power_dbm: -5, band: "868mhz", active: false },
    ],
  );
});

Deno.test("scene: the map draws the live model, so an open door and a running oven show as they are", () => {
  const stub = new StubSession();
  const scenario = environmentFromPreset("indoor_office", {
    obstacles: [{ id: "door", from: [0, 0], to: [0, 4], attenuationDb: 12 }],
    interference: [{
      id: "oven",
      position: { x: 3, y: 4 },
      powerDbm: 20,
      band: "2.4ghz",
      active: false,
    }],
  });
  const live = {
    obstacles: [{ ...scenario.obstacles[0]!, attenuationDb: 0 }],
    interference: [{ ...scenario.interference[0]!, active: true }],
  };
  const run = (environment: unknown, withLive: boolean) => ({
    loaded: { scenario: { phy: "wifi", environment } },
    ...(withLive ? { live: { environment: () => ({ ...scenario, ...live }) } } : {}),
  });
  const scene = (withLive: boolean) => {
    Object.defineProperty(stub, "run", { value: run(scenario, withLive), configurable: true });
    return viewState(stub as unknown as Session, -1).scene!;
  };
  // Before the run has a live handle, the file's own model.
  assertEquals(scene(false).obstacles[0]!.attenuation_db, 12);
  assertEquals(scene(false).interference[0]!.active, false);
  // Once it has one, what the model is now.
  assertEquals(scene(true).obstacles[0]!.attenuation_db, 0);
  assertEquals(scene(true).obstacles[0]!.id, "door");
  assertEquals(scene(true).interference[0]!.active, true);
});
