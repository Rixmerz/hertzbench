// The page in a real browser: headless Chromium, driven over the DevTools
// protocol with real mouse input, drags a node on the map of a running
// `hertzbench view` and the engine must see the move. Skipped when no Chromium
// is installed; set HERTZBENCH_CHROMIUM to point at one.

import { fileURLToPath } from "node:url";
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { BROWSER_START_TIMEOUT_MS, chromiumArgs } from "./chromium.ts";

const MAIN = fileURLToPath(new URL("../cli/main.ts", import.meta.url));
const LIVE = fileURLToPath(new URL("../scenarios/examples/live-3-scripted.yaml", import.meta.url));

function findChromium(): string | null {
  const candidates = [
    Deno.env.get("HERTZBENCH_CHROMIUM"),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ];
  for (const path of candidates) {
    if (!path) continue;
    try {
      if (Deno.statSync(path).isFile) return path;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return null;
}

const CHROMIUM = findChromium();

/** SIGTERM a child that may have exited already, as a Chromium that failed to start has. */
function terminate(child: Deno.ChildProcess): void {
  try {
    child.kill("SIGTERM");
  } catch (error) {
    // It exited already: the error that ended the test says why.
    if (!(error instanceof TypeError)) throw error;
  }
}

/** Reads a child's stderr as it comes, so a test can wait for a line on it. */
class StderrWatch {
  text = "";
  closed = false;
  readonly done: Promise<void>;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.done = (async () => {
      for await (const chunk of stream.pipeThrough(new TextDecoderStream())) this.text += chunk;
      this.closed = true;
    })();
  }

  async waitFor(pattern: RegExp, timeoutMs = 20_000): Promise<RegExpMatchArray> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const match = this.text.match(pattern);
      if (match) return match;
      // A process that exited before printing the line never will: say why at once.
      if (this.closed) throw new Error(`exited before printing ${pattern}:\n${this.text}`);
      if (performance.now() > deadline) {
        throw new Error(`timed out waiting for ${pattern}:\n${this.text}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

/** The DevTools protocol over one WebSocket, flat sessions. */
class Cdp {
  readonly #socket: WebSocket;
  readonly #waiting = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  #nextId = 1;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.onmessage = (message) => {
      const data = JSON.parse(String(message.data));
      const waiter = data.id === undefined ? undefined : this.#waiting.get(data.id);
      if (!waiter) return;
      this.#waiting.delete(data.id);
      if (data.error) waiter.reject(new Error(JSON.stringify(data.error)));
      else waiter.resolve(data.result);
    };
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error(`could not open ${url}`));
    });
    return new Cdp(socket);
  }

  // deno-lint-ignore no-explicit-any
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = this.#nextId++;
    const answer = new Promise((resolve, reject) => this.#waiting.set(id, { resolve, reject }));
    this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return answer;
  }

  async close(): Promise<void> {
    const closed = new Promise((resolve) => (this.#socket.onclose = resolve));
    this.#socket.close();
    await closed;
  }
}

Deno.test({
  name: "browser: dragging a node on the map moves it in the engine",
  ignore: CHROMIUM === null,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "hzb-browser-" });
    const view = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-net=127.0.0.1",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "--allow-env",
        MAIN,
        "view",
        LIVE,
        "--port",
        "0",
        "--out",
        `${dir}/out`,
      ],
      stdout: "null",
      stderr: "piped",
    }).spawn();
    const viewLog = new StderrWatch(view.stderr);
    const browser = new Deno.Command(CHROMIUM!, {
      args: chromiumArgs(`${dir}/profile`),
      stdout: "null",
      stderr: "piped",
    }).spawn();
    const browserLog = new StderrWatch(browser.stderr);
    let cdp: Cdp | null = null;
    try {
      const [, url] = await viewLog.waitFor(
        /view: (http:\/\/127\.0\.0\.1:\d+\/)/,
        BROWSER_START_TIMEOUT_MS,
      );
      const [, devtools] = await browserLog.waitFor(
        /DevTools listening on (ws:\/\/\S+)/,
        BROWSER_START_TIMEOUT_MS,
      );
      cdp = await Cdp.connect(devtools!);
      const { targetId } = await cdp.send("Target.createTarget", { url: url! });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      const page = (method: string, params: Record<string, unknown> = {}) =>
        cdp!.send(method, params, sessionId);
      const evaluate = async (expression: string) =>
        (await page("Runtime.evaluate", { expression, returnByValue: true })).result.value;

      // Centre of each node on screen, once the page shows the run as running and has drawn the
      // map at the size its box has. The first frame of a run is drawn at the box's earlier size
      // and redrawn when the box settles, tens of ms later: the map's scale was 5.7 px/m in that
      // frame and 9.3 after it, so coordinates taken in it put the press and the drop off.
      const centres = `(() => {
        if (document.getElementById("state").dataset.state !== "running") return null;
        const box = document.getElementById("map-box").getBoundingClientRect();
        const [, , width, height] = document.getElementById("map").getAttribute("viewBox")
          .split(" ").map(Number);
        if (Math.abs(width - box.width) > 0.5 || Math.abs(height - box.height) > 0.5) return null;
        const out = {};
        for (const node of document.querySelectorAll(".node")) {
          const r = node.querySelector("circle.node-dot").getBoundingClientRect();
          out[node.getAttribute("aria-label").split(",")[0]] = [r.x + r.width / 2, r.y + r.height / 2];
        }
        return Object.keys(out).length === 3 ? out : null;
      })()`;
      type Centres = Record<string, [number, number]>;
      const deadline = performance.now() + 20_000;
      const settled = async (): Promise<Centres> => {
        for (;;) {
          const found: Centres | null = await evaluate(centres);
          if (found) return found;
          if (performance.now() > deadline) {
            throw new Error("the page never showed three running nodes");
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      };
      const sameCentres = (x: Centres, y: Centres) =>
        Object.entries(x).every(([id, [px, py]]) =>
          Math.abs(px - y[id]![0]) < 0.5 && Math.abs(py - y[id]![1]) < 0.5
        );
      // A reading is taken as true when one more, a poll of the page (250 ms) later, agrees.
      let at = await settled();
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const again = await settled();
        if (sameCentres(at, again)) break;
        at = again;
      }
      // a is at (0, 0) m and b at (8, 0) m: that fixes the map's scale and origin.
      const [ax, ay] = at.a!;
      const [bx] = at.b!;
      const pxPerMetre = (bx - ax) / 8;
      const [cx, cy] = at.c!;
      // Screen y grows down and the map's y grows up: 3 m up the map is 3 m less on screen.
      const [toX, toY] = [cx + 6 * pxPerMetre, cy - 3 * pxPerMetre];

      const mouse = (type: string, x: number, y: number) =>
        page("Input.dispatchMouseEvent", {
          type,
          x,
          y,
          button: "left",
          buttons: type === "mouseReleased" ? 0 : 1,
          clickCount: 1,
        });
      await mouse("mouseMoved", cx, cy);
      await mouse("mousePressed", cx, cy);
      for (let step = 1; step <= 10; step++) {
        await mouse("mouseMoved", cx + ((toX - cx) * step) / 10, cy + ((toY - cy) * step) / 10);
      }
      await mouse("mouseReleased", toX, toY);

      const expected = { x: (toX - ax) / pxPerMetre, y: -(toY - ay) / pxPerMetre };
      let position: { x: number; y: number } | null = null;
      const moveDeadline = performance.now() + 5_000;
      for (;;) {
        const scene = await (await fetch(`${url}api/view?since=999999999`)).json();
        position = scene.status.nodes.find((n: { id: string }) => n.id === "c").position;
        if (position!.x !== 12 || performance.now() > moveDeadline) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assertAlmostEquals(position!.x, expected.x, 0.25);
      assertAlmostEquals(position!.y, expected.y, 0.25);
      assertAlmostEquals(position!.x, 18, 0.25);
      assertAlmostEquals(position!.y, 7, 0.25);
      // One drag is one move in the engine, not one per pointer event.
      const timeline = await (await fetch(`${url}api/view?since=-1`)).json();
      const moves = timeline.timeline.entries.filter((e: { type: string }) => e.type === "move");
      assertEquals(moves.length, 1);
      const label = await evaluate(
        `[...document.querySelectorAll(".node")].map((n) => n.getAttribute("aria-label")).find((l) => l.startsWith("c,"))`,
      );
      assert(String(label).includes("at x 18.0 m, y 7.0 m"), String(label));
    } finally {
      await cdp?.close();
      terminate(browser);
      await browser.status;
      await browserLog.done;
      view.kill("SIGINT");
      const status = await view.status;
      await viewLog.done;
      await Deno.remove(dir, { recursive: true });
      assertEquals(status.code, 0, viewLog.text);
    }
  },
});
