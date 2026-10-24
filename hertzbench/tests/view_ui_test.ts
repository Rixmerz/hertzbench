// The view's page measured in headless Chromium, driven over the DevTools
// protocol: layout and composition at four viewports, labels that must not
// cover each other, WCAG AA contrast from real computed styles in both
// themes, the color of every link at every quality boundary, drag and
// keyboard moves, the packet timeline, and the page with no node, one node and
// fifty. Skipped when no Chromium is installed; set HERTZBENCH_CHROMIUM to
// point at one.
//
// Two kinds of server stand behind the page. A scripted `FakeSession` serves
// states no real run reaches (more boards than a scenario may hold, a failed
// run, an error the engine would never raise) through the real `serveView`, so
// the HTTP layer, the scene model and the page are all the real ones. A real
// `Session` runs a scripted scenario where the test needs the engine's own
// link budgets: the color at each boundary, a fault, a move.
//
// The Chromium helpers below repeat the ones in view_browser_test.ts: a test
// file cannot be imported without registering its tests twice.

import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import {
  chipPacketErrorRate,
  type ChipSignal,
  type EngineEvent,
  type LinkBudget,
  type Position,
} from "../engine/mod.ts";
import { ToolError } from "../mcp/protocol.ts";
import { Session } from "../mcp/session.ts";
import { serveView, type ViewServer } from "../view/server.ts";

// ── Chromium over the DevTools protocol ─────────────────────────────────────

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
const APP_JS = new URL("../view/static/app.js", import.meta.url).href;

// Answers from the page are JSON read field by field.
// deno-lint-ignore no-explicit-any
type Json = any;

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
      await sleep(20);
    }
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Poll a condition on this side until it holds. */
async function until(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** Time for something that must NOT happen to have happened: a few polls of the page. */
const QUIET_MS = 700;

interface CdpMessage {
  method?: string;
  params?: Json;
  sessionId?: string;
}

/** The DevTools protocol over one WebSocket, flat sessions. */
class Cdp {
  readonly #socket: WebSocket;
  readonly #waiting = new Map<
    number,
    { resolve: (v: Json) => void; reject: (e: Error) => void }
  >();
  readonly #listeners = new Set<(message: CdpMessage) => void>();
  #nextId = 1;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.onmessage = (message) => {
      const data = JSON.parse(String(message.data));
      if (data.id === undefined) {
        for (const listener of this.#listeners) listener(data);
        return;
      }
      const waiter = this.#waiting.get(data.id);
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

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Json> {
    const id = this.#nextId++;
    const answer = new Promise((resolve, reject) => this.#waiting.set(id, { resolve, reject }));
    this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return answer;
  }

  listen(listener: (message: CdpMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async close(): Promise<void> {
    const closed = new Promise((resolve) => (this.#socket.onclose = resolve));
    this.#socket.close();
    await closed;
  }
}

// What the page-side helpers return, installed once per document.
const PAGE_TOOLS = String.raw`(() => {
  const parseColor = (text) => {
    const s = String(text).trim();
    let m = s.match(/^#([0-9a-f]{3,8})$/i);
    if (m) {
      let h = m[1];
      if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
      const n = (i) => parseInt(h.slice(i, i + 2), 16);
      return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
    }
    m = s.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    if (s === "transparent") return [0, 0, 0, 0];
    throw new Error("cannot parse the color " + JSON.stringify(s));
  };
  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };
  const describe = (el) => {
    const id = el.id ? "#" + el.id : "";
    const cls = typeof el.className === "string" ? el.className : el.className && el.className.baseVal;
    return el.tagName.toLowerCase() + id + (cls ? "." + cls.trim().split(/\s+/).join(".") : "");
  };
  /** The background stack under an element: translucent layers up to the first opaque one. */
  const backdrop = (el, includeSelf) => {
    const chain = [];
    let opacity = 1;
    for (let a = el; a; a = a.parentElement) {
      const s = getComputedStyle(a);
      opacity *= Number(s.opacity);
      if (a === el && !includeSelf) continue;
      const bg = parseColor(s.backgroundColor);
      if (bg[3] > 0) chain.push(bg);
      if (bg[3] >= 1) break;
    }
    return { chain, opacity };
  };
  const texts = () => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let n; (n = walker.nextNode());) {
      if (!n.nodeValue.trim()) continue;
      const el = n.parentElement;
      if (!el || seen.has(el) || el.closest("script,style,title")) continue;
      seen.add(el);
      const cs = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      if (cs.display === "none" || cs.visibility === "hidden" || box.width === 0 || box.height === 0) continue;
      const svg = el instanceof SVGElement;
      const { chain, opacity } = backdrop(el, !svg);
      out.push({
        what: describe(el) + " " + JSON.stringify(n.nodeValue.trim().slice(0, 30)),
        fg: parseColor(svg ? cs.fill : cs.color),
        chain,
        opacity,
        size: parseFloat(cs.fontSize),
        weight: Number(cs.fontWeight) || 400,
        halo: svg && cs.stroke !== "none" ? { color: parseColor(cs.stroke), width: parseFloat(cs.strokeWidth) } : null,
      });
    }
    return out;
  };
  const pseudoText = (selector, pseudo) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const cs = getComputedStyle(el, pseudo);
    if (cs.content === "none" || cs.content === "normal") return null;
    const { chain } = backdrop(el, true);
    return { text: cs.content, fg: parseColor(cs.color), chain, size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight) || 400 };
  };
  window.__hzb = { parseColor, rect, describe, backdrop, texts, pseudoText };
  return true;
})()`;

// Canvas text has no box to measure: record what the timeline draws, as it draws it.
const CANVAS_RECORDER = String.raw`(() => {
  const proto = CanvasRenderingContext2D.prototype;
  const drawn = { texts: [], rects: [], draws: 0, width: 0, height: 0 };
  window.__canvas = drawn;
  const clearRect = proto.clearRect;
  proto.clearRect = function (...args) {
    drawn.texts.length = 0;
    drawn.rects.length = 0;
    drawn.draws++;
    const ratio = this.getTransform().a || 1;
    drawn.width = this.canvas.width / ratio;
    drawn.height = this.canvas.height / ratio;
    return clearRect.apply(this, args);
  };
  const fillText = proto.fillText;
  proto.fillText = function (text, x, y, ...rest) {
    drawn.texts.push({ text: String(text), x, y, width: this.measureText(String(text)).width, align: this.textAlign, fill: this.fillStyle, font: this.font });
    return fillText.call(this, text, x, y, ...rest);
  };
  const fillRect = proto.fillRect;
  proto.fillRect = function (x, y, w, h) {
    drawn.rects.push({ x, y, w, h, fill: this.fillStyle });
    return fillRect.call(this, x, y, w, h);
  };
})();`;

/** One tab, with the console watched and the page's own script covered. */
class Page {
  /** Uncaught exceptions and console errors since the last time a test cleared them. */
  errors: string[] = [];
  readonly #cdp: Cdp;
  readonly #sessionId: string;
  readonly #targetId: string;
  readonly #stop: () => void;
  #covered = false;

  private constructor(cdp: Cdp, sessionId: string, targetId: string) {
    this.#cdp = cdp;
    this.#sessionId = sessionId;
    this.#targetId = targetId;
    this.#stop = cdp.listen((message) => {
      if (message.sessionId !== sessionId) return;
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params.exceptionDetails;
        this.errors.push(`exception: ${details.exception?.description ?? details.text}`);
      } else if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        this.errors.push(
          `console.error: ${
            message.params.args.map((a: Json) => a.value ?? a.description).join(" ")
          }`,
        );
      }
    });
  }

  static async open(cdp: Cdp): Promise<Page> {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(cdp, sessionId, targetId);
    for (const domain of ["Page", "Runtime", "Log", "Profiler"]) {
      await page.send(`${domain}.enable`);
    }
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: CANVAS_RECORDER });
    await page.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
    page.#covered = true;
    return page;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Json> {
    return this.#cdp.send(method, params, this.#sessionId);
  }

  /** Navigate and wait for the load event, the fonts and the page-side helpers. */
  async goto(url: string): Promise<void> {
    await this.flushCoverage();
    const loaded = new Promise<void>((resolve) => {
      const stop = this.#cdp.listen((message) => {
        if (message.sessionId === this.#sessionId && message.method === "Page.loadEventFired") {
          stop();
          resolve();
        }
      });
    });
    await this.send("Page.navigate", { url });
    await loaded;
    await this.eval("document.fonts.ready.then(() => true)");
    await this.eval(PAGE_TOOLS);
  }

  async eval<T = Json>(expression: string): Promise<T> {
    const answer = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (answer.exceptionDetails) {
      throw new Error(
        `in the page: ${
          answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text
        }\n${expression}`,
      );
    }
    return answer.result.value;
  }

  /** Poll an expression until it is truthy; its value is returned. */
  async waitFor<T = Json>(expression: string, what: string, timeoutMs = 15_000): Promise<T> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const value = await this.eval<T>(expression);
      if (value) return value;
      if (performance.now() > deadline) {
        throw new Error(
          `timed out waiting for ${what}: ${expression}\npage errors: ${this.errors.join("; ")}`,
        );
      }
      await sleep(30);
    }
  }

  /**
   * Answer the page's requests whose URL contains `fragment` with `answer` instead of the
   * server; null lets a request through. Returns the function that stops it.
   */
  async intercept(
    fragment: string,
    answer: () => { status: number; body: string } | null,
  ): Promise<() => Promise<void>> {
    await this.send("Fetch.enable", { patterns: [{ urlPattern: `*${fragment}*` }] });
    const stop = this.#cdp.listen((message) => {
      if (message.sessionId !== this.#sessionId || message.method !== "Fetch.requestPaused") return;
      const requestId = message.params.requestId;
      const reply = answer();
      if (reply === null) {
        this.send("Fetch.continueRequest", { requestId }).catch(() => {});
      } else {
        this.send("Fetch.fulfillRequest", {
          requestId,
          responseCode: reply.status,
          responseHeaders: [{ name: "content-type", value: "application/json" }],
          body: btoa(reply.body),
        }).catch(() => {});
      }
    });
    return async () => {
      stop();
      await this.send("Fetch.disable");
    };
  }

  async viewport(width: number, height: number): Promise<void> {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  async scheme(value: "light" | "dark"): Promise<void> {
    await this.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value }],
    });
  }

  mouse(type: string, x: number, y: number, extra: Record<string, unknown> = {}): Promise<Json> {
    return this.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      buttons: type === "mouseReleased" || type === "mouseMoved" ? 0 : 1,
      clickCount: 1,
      ...extra,
    });
  }

  /** Press and release one key; `code` is the DOM key name, `vk` its Windows key code. */
  async key(key: string, vk: number, modifiers = 0): Promise<void> {
    const base = { key, code: key, windowsVirtualKeyCode: vk, modifiers };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /** Add the page script's V8 coverage to the directory `deno coverage` reads, if there is one. */
  async flushCoverage(): Promise<void> {
    if (!this.#covered) return;
    const dir = Deno.env.get("DENO_COVERAGE_DIR");
    const taken = await this.send("Profiler.takePreciseCoverage");
    if (!dir) return;
    for (const script of taken.result as { url: string }[]) {
      if (!script.url.endsWith("/app.js")) continue;
      await Deno.writeTextFile(
        `${dir}/${crypto.randomUUID()}.json`,
        JSON.stringify({ ...script, url: APP_JS }),
      );
    }
  }

  async close(): Promise<void> {
    await this.flushCoverage();
    this.#stop();
    await this.#cdp.send("Target.closeTarget", { targetId: this.#targetId });
  }
}

/** Run `fn` with a fresh headless Chromium and one open tab, and shut both down. */
async function withPage(fn: (page: Page) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "hzb-ui-" });
  const browser = new Deno.Command(CHROMIUM!, {
    args: [
      "--headless=new",
      // Ubuntu 23.10+ (and its GitHub runners) forbid the unprivileged user namespaces
      // Chromium's sandbox needs, and Chromium then exits with "No usable sandbox!".
      // The page under test is the project's own, served on loopback.
      "--no-sandbox",
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${dir}/profile`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1280,900",
      "about:blank",
    ],
    stdout: "null",
    stderr: "piped",
  }).spawn();
  const log = new StderrWatch(browser.stderr);
  let cdp: Cdp | null = null;
  try {
    const [, devtools] = await log.waitFor(/DevTools listening on (ws:\/\/\S+)/);
    cdp = await Cdp.connect(devtools!);
    const page = await Page.open(cdp);
    try {
      await fn(page);
    } finally {
      await page.close();
    }
  } finally {
    await cdp?.close();
    terminate(browser);
    await browser.status;
    await log.done;
    await Deno.remove(dir, { recursive: true });
  }
}

// ── A scripted session behind the real server ───────────────────────────────

interface FakeNode {
  id: string;
  board: string;
  position: Position;
  onMedium: boolean;
}

type Budget = LinkBudget & { signal?: ChipSignal };

function wifiBudget(snrDb: number, distanceM = 10): Budget {
  return {
    distanceM,
    pathLossDb: 0,
    obstacleLossDb: 0,
    shadowingDb: 0,
    rssiDbm: snrDb - 94,
    noiseFloorDbm: -94,
    snrDb,
  };
}

/**
 * What `serveView` reads from a Session, with every answer set by the test. It
 * is handed to the real server, so the HTTP layer, the scene model and the
 * page are the real ones; only the engine is missing.
 */
class FakeSession {
  state: "idle" | "starting" | "running" | "finished" | "failed" | "stopped" = "running";
  scenario = "fake-scenario";
  runId = "run-1";
  phy = "wifi";
  seed = 7;
  durationMs = 60_000;
  elapsed: number | null = 5000;
  nodes: FakeNode[] = [];
  obstacles: { from: [number, number]; to: [number, number]; attenuationDb: number }[] = [];
  problems: string[] = [];
  error: string | null = null;
  passed = true;
  events_: EngineEvent[] = [];
  /** Throws on the next status() when set: the server answers 500. */
  statusError: Error | null = null;
  moveError: Error | null = null;
  moves: { node: string; to: Position; phase: string | null }[] = [];
  /** The budget of a directed link; by default 60 dB of SNR less 2 dB per metre. */
  budgetOf: (from: FakeNode, to: FakeNode) => Budget = (from, to) => {
    const d = Math.hypot(from.position.x - to.position.x, from.position.y - to.position.y);
    return wifiBudget(60 - 2 * d, d);
  };
  #seq = 0;

  setNodes(nodes: [id: string, x: number, y: number, board?: string][]): this {
    this.nodes = nodes.map(([id, x, y, board]) => ({
      id,
      board: board ?? "scripted",
      position: { x, y },
      onMedium: true,
    }));
    return this;
  }

  /** Append an engine event at `t` ms. */
  add(event: Record<string, unknown> & { type: string; t: number }): this {
    this.events_.push({ seq: this.#seq++, ...event } as unknown as EngineEvent);
    return this;
  }

  get run() {
    if (this.state === "idle") return null;
    return {
      loaded: { scenario: { phy: this.phy, environment: { obstacles: this.obstacles } } },
    };
  }

  status() {
    if (this.statusError) throw this.statusError;
    if (this.state === "idle") return { state: "idle" as const };
    const base = {
      state: this.state,
      run_id: this.runId,
      scenario: this.scenario,
      seed: this.seed,
      duration_ms: this.durationMs,
      elapsed_ms: this.elapsed,
      nodes: this.nodes.map((n) => ({
        id: n.id,
        board: n.board,
        ip: "192.168.4.11",
        on_medium: n.onMedium,
        position: n.position,
      })),
      problems: this.problems,
    };
    if (this.state === "finished") return { ...base, passed: this.passed };
    if (this.state === "failed") return { ...base, error: this.error };
    return base;
  }

  events(): readonly EngineEvent[] {
    return this.events_;
  }

  elapsedMs(): number | null {
    return this.elapsed;
  }

  linkBudgets() {
    const medium = this.nodes.filter((n) => n.onMedium);
    return medium.flatMap((from) =>
      medium.filter((to) => to !== from).map((to) => ({
        from: from.id,
        to: to.id,
        budget: this.budgetOf(from, to),
      }))
    );
  }

  move(node: string, to: Position, phase: string | null) {
    if (this.moveError) throw this.moveError;
    const found = this.nodes.find((n) => n.id === node);
    if (!found) throw new ToolError(`no node named ${node}`);
    this.moves.push({ node, to, phase });
    found.position = { x: to.x, y: to.y };
    this.add({ type: "move", t: this.elapsed ?? 0, node, position: found.position });
    return { node, to };
  }
}

/** Serve a session on a free port for the length of `fn`. */
async function serving<T>(
  session: FakeSession | Session,
  fn: (url: string, server: ViewServer) => Promise<T>,
): Promise<T> {
  const server = serveView(session as Session, { port: 0 });
  try {
    return await fn(server.url, server);
  } finally {
    await server.shutdown();
  }
}

// ── WCAG ────────────────────────────────────────────────────────────────────

type Rgba = [number, number, number, number];

const channel = (value: number) => {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgba) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `top` laid over an opaque `under`, with `extra` alpha on top of its own. */
function over(top: Rgba, under: Rgba, extra = 1): Rgba {
  const alpha = top[3] * extra;
  return [
    top[0] * alpha + under[0] * (1 - alpha),
    top[1] * alpha + under[1] * (1 - alpha),
    top[2] * alpha + under[2] * (1 - alpha),
    1,
  ];
}

/** The translucent layers under an element, outermost last, flattened to one opaque color. */
function flatten(chain: Rgba[]): Rgba {
  let color: Rgba = chain[chain.length - 1]![3] >= 1
    ? chain[chain.length - 1]!
    : [255, 255, 255, 1];
  const rest = chain[chain.length - 1]![3] >= 1 ? chain.slice(0, -1) : chain;
  for (let i = rest.length - 1; i >= 0; i--) color = over(rest[i]!, color);
  return color;
}

interface TextEntry {
  what: string;
  fg: Rgba;
  chain: Rgba[];
  opacity: number;
  size: number;
  weight: number;
  halo: { color: Rgba; width: number } | null;
}

/** AA asks 4.5:1 for text, 3:1 for large text (24 px, or 18.66 px bold). */
function neededContrast(entry: { size: number; weight: number }): number {
  return entry.size >= 24 || (entry.size >= 18.66 && entry.weight >= 700) ? 3 : 4.5;
}

// ── Geometry ────────────────────────────────────────────────────────────────

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** Overlap area in px² of two boxes, each shrunk by `slack` px so a shared edge is not an overlap. */
function overlapArea(a: Box, b: Box, slack = 0.5): number {
  const w = Math.min(a.right - slack, b.right - slack) - Math.max(a.left + slack, b.left + slack);
  const h = Math.min(a.bottom - slack, b.bottom - slack) - Math.max(a.top + slack, b.top + slack);
  return w > 0 && h > 0 ? w * h : 0;
}

const VIEWPORTS = [
  { width: 360, height: 740 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
] as const;

/** What the page's chrome and its pieces measure at the current viewport. */
const MEASURE = String.raw`(() => {
  const t = window.__hzb;
  const q = (s) => document.querySelector(s);
  const panes = ["header.bar", ".map-pane", ".side", ".timeline-pane"];
  const doc = document.documentElement;
  const out = {
    innerWidth: window.innerWidth,
    scrollWidth: doc.scrollWidth,
    clientWidth: doc.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    panes: Object.fromEntries(panes.map((s) => [s, t.rect(q(s))])),
    outside: [],
    clippedText: [],
  };
  // Every HTML element must sit inside the page horizontally and inside its own pane.
  for (const el of document.body.querySelectorAll("*")) {
    if (el instanceof SVGElement || el.closest(".table-box") || el.closest("canvas")) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const pane = el.closest(panes.join(","));
    if (r.left < -0.5 || r.right > window.innerWidth + 0.5) out.outside.push([t.describe(el), "page", r.left, r.right]);
    if (pane && pane !== el) {
      const p = pane.getBoundingClientRect();
      if (r.left < p.left - 0.5 || r.right > p.right + 0.5 || r.top < p.top - 0.5 || r.bottom > p.bottom + 0.5) {
        out.outside.push([t.describe(el), t.describe(pane), r.left - p.left, p.right - r.right]);
      }
    }
    const s = getComputedStyle(el);
    const hidesOverflow = s.overflowX !== "visible" || s.overflowY !== "visible";
    if (hidesOverflow && s.overflowX !== "auto" && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) {
      out.clippedText.push([t.describe(el), el.scrollWidth, el.clientWidth]);
    }
  }
  // Text itself can run past a box that fits: measure the glyphs, not only the boxes.
  out.textOutside = [];
  const range = document.createRange();
  const textWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = textWalker.nextNode());) {
    const el = n.parentElement;
    if (!n.nodeValue.trim() || el instanceof SVGElement || el.closest("script,style,.table-box")) continue;
    range.selectNodeContents(n);
    const r = range.getBoundingClientRect();
    if (r.width === 0) continue;
    const pane = el.closest(panes.join(","));
    const p = pane ? pane.getBoundingClientRect() : { left: 0, right: window.innerWidth };
    if (r.left < p.left - 0.5 || r.right > p.right + 0.5) out.textOutside.push([t.describe(el), n.nodeValue.trim().slice(0, 24), Math.round(r.right - p.right)]);
  }
  // The table scrolls inside its own box rather than widening the page.
  const box = q(".table-box");
  out.tableBox = { scrollWidth: box.scrollWidth, clientWidth: box.clientWidth, overflowX: getComputedStyle(box).overflowX };
  return out;
})()`;

// ── Tests ───────────────────────────────────────────────────────────────────

function threeNodes(): FakeSession {
  const session = new FakeSession().setNodes([["a", 0, 0], ["b", 8, 0], ["c", 12, 4]]);
  session.add({ type: "phase", t: 0, label: "start" });
  return session;
}

Deno.test({
  name:
    "ui: the page chrome fits the viewport without scrolling sideways at 360, 768, 1280 and 1920 px",
  ignore: CHROMIUM === null,
  fn: async () => {
    await withPage(async (page) => {
      await serving(threeNodes(), async (url) => {
        for (const { width, height } of VIEWPORTS) {
          await page.viewport(width, height);
          await page.goto(url);
          await page.waitFor(`document.querySelectorAll(".node").length === 3`, "three nodes");
          const m = await page.eval<Json>(MEASURE);
          const at = `${width}x${height}`;
          assertEquals(m.innerWidth, width, at);
          assert(
            m.scrollWidth <= m.clientWidth,
            `${at}: the document scrolls sideways: ${m.scrollWidth} > ${m.clientWidth}`,
          );
          assert(m.bodyScrollWidth <= m.clientWidth, `${at}: the body is wider than the page`);
          assertEquals(m.outside, [], `${at}: elements outside the page or their pane`);
          assertEquals(m.clippedText, [], `${at}: clipped content`);
          assertEquals(m.textOutside, [], `${at}: text running past its pane`);
          // The four blocks do not cover each other.
          const names = Object.keys(m.panes);
          for (let i = 0; i < names.length; i++) {
            for (let j = i + 1; j < names.length; j++) {
              assertEquals(
                overlapArea(m.panes[names[i]!], m.panes[names[j]!]),
                0,
                `${at}: ${names[i]} overlaps ${names[j]}`,
              );
            }
          }
          // The map keeps a usable size at every width.
          const map = await page.eval<Box>(`__hzb.rect(document.getElementById("map-box"))`);
          assert(
            map.width >= Math.min(m.clientWidth - 52, 300),
            `${at}: the map is ${map.width} px wide`,
          );
          assert(map.height >= 320, `${at}: the map is ${map.height} px tall`);
          assertEquals(page.errors, []);
        }
      });
    });
  },
});

// ── Labels on the map ───────────────────────────────────────────────────────

/** The boxes of every label and every node body on the map, and of the map itself. */
const LABEL_BOXES = String.raw`(() => {
  const t = window.__hzb;
  const boxes = (selector, kind) =>
    [...document.querySelectorAll(selector)].map((el) => ({ kind, what: t.describe(el) + " " + JSON.stringify(el.textContent.slice(0, 24)), box: t.rect(el) }));
  return {
    map: t.rect(document.getElementById("map")),
    labels: [
      ...boxes("#map text.node-label", "node label"),
      ...boxes("#map text.link-label", "link label"),
      ...boxes("#map text.wall-label", "wall label"),
      ...boxes("#map text.scale-label", "scale label"),
    ],
    bodies: [...boxes("#map circle.node-dot", "node"), ...boxes("#map image", "board")],
  };
})()`;

interface Labelled {
  kind: string;
  what: string;
  box: Box;
}

const show = (b: Box) =>
  `[${b.left.toFixed(0)},${b.top.toFixed(0)} ${b.right.toFixed(0)},${b.bottom.toFixed(0)}]`;

/** Every pair of labels that cover each other, every label over a node body, and every label off the map. */
function labelProblems(found: { map: Box; labels: Labelled[]; bodies: Labelled[] }): string[] {
  const problems: string[] = [];
  const { labels, map } = found;
  // Bodies closer than a name is tall leave a name no room: then a name over a neighbour's body is the layout's, not the label's.
  const centres = found.bodies.map((
    b,
  ) => [(b.box.left + b.box.right) / 2, (b.box.top + b.box.bottom) / 2]);
  const crowded = centres.some(([x1, y1], i) =>
    centres.some(([x2, y2], j) => i < j && Math.hypot(x1! - x2!, y1! - y2!) < 46)
  );
  const bodies = found.bodies;
  for (let i = 0; i < labels.length; i++) {
    const a = labels[i]!;
    for (let j = i + 1; j < labels.length; j++) {
      const b = labels[j]!;
      if (overlapArea(a.box, b.box) > 2) {
        problems.push(`${a.what} ${show(a.box)} covers ${b.what} ${show(b.box)}`);
      }
    }
    for (const body of crowded ? bodies.filter(() => a.kind === "link label") : bodies) {
      if (overlapArea(a.box, body.box) > 2) {
        problems.push(`${a.what} ${show(a.box)} covers ${body.what} ${show(body.box)}`);
      }
    }
    const { left, right, top, bottom } = a.box;
    if (
      left < map.left - 0.5 || right > map.right + 0.5 || top < map.top - 0.5 ||
      bottom > map.bottom + 0.5
    ) {
      problems.push(`${a.what} runs off the map`);
    }
  }
  return problems;
}

/** Layouts where nodes sit close to each other, in metres; the last node of each only sets the map's scale. */
const CLOSE_LAYOUTS: Record<string, [string, number, number][]> = {
  "a pair 4 m apart on a row": [["a", 0, 0], ["b", 4, 0], ["far", 40, 0]],
  "a pair 4 m apart on a column": [["a", 0, 0], ["b", 0, 4], ["far", 0, 40]],
  "a pair 5 m apart on a diagonal": [["a", 0, 0], ["b", 3, 4], ["far", 30, 30]],
  "a pair 2 m apart": [["a", 0, 0], ["b", 2, 0], ["far", 30, 0]],
  "six nodes on a row, 3 m apart": [
    ["n1", 0, 0],
    ["n2", 3, 0],
    ["n3", 6, 0],
    ["n4", 9, 0],
    ["n5", 12, 0],
    ["n6", 15, 0],
  ],
  "six nodes on a column, 3 m apart": [
    ["n1", 0, 0],
    ["n2", 0, 3],
    ["n3", 0, 6],
    ["n4", 0, 9],
    ["n5", 0, 12],
    ["n6", 0, 15],
  ],
  "a cluster of five around a sixth": [
    ["hub", 0, 0],
    ["n1", 5, 0],
    ["n2", -5, 0],
    ["n3", 0, 5],
    ["n4", 0, -5],
    ["far", 60, 40],
  ],
};

Deno.test({
  name:
    "ui: node, link and wall labels do not cover each other, a node or the map edge when nodes are close",
  ignore: CHROMIUM === null,
  fn: async () => {
    await withPage(async (page) => {
      const failures: string[] = [];
      for (const [name, layout] of Object.entries(CLOSE_LAYOUTS)) {
        const session = new FakeSession().setNodes(layout);
        session.obstacles = [{ from: [25, -3], to: [25, 3], attenuationDb: 12 }];
        await serving(session, async (url) => {
          for (const { width, height } of VIEWPORTS) {
            await page.viewport(width, height);
            await page.goto(url);
            await page.waitFor(
              `document.querySelectorAll(".node").length === ${layout.length}`,
              "the nodes",
            );
            const problems = labelProblems(await page.eval<Json>(LABEL_BOXES));
            for (const problem of problems) failures.push(`${name} @${width}: ${problem}`);
          }
        });
      }
      assertEquals(failures, []);
    });
  },
});

// ── Contrast ────────────────────────────────────────────────────────────────

const THEMES = ["dark", "light"] as const;

/** Every text on the page at `needed` ratio against what is behind it, and its halo where it has one. */
function textContrastFailures(entries: TextEntry[], where: string): string[] {
  const failures: string[] = [];
  for (const entry of entries) {
    const needed = neededContrast(entry);
    const back = flatten(entry.chain);
    const text = over(entry.fg, back, entry.opacity);
    const ratio = contrast(text, back);
    if (ratio < needed) {
      failures.push(`${where}: ${entry.what} is ${ratio.toFixed(2)}:1, needs ${needed}:1`);
    }
    if (entry.halo) {
      const haloRatio = contrast(entry.fg, entry.halo.color);
      if (haloRatio < needed) {
        failures.push(
          `${where}: ${entry.what} against its halo is ${
            haloRatio.toFixed(2)
          }:1, needs ${needed}:1`,
        );
      }
    }
  }
  return failures;
}

/** A session with every quality of link, a wall, an override and a problem on show. */
function richSession(): FakeSession {
  const session = new FakeSession().setNodes([
    ["a", 0, 0],
    ["b", 10, 0],
    ["c", 10, 10],
    ["d", 0, 10],
  ]);
  session.obstacles = [{ from: [5, -4], to: [5, 14], attenuationDb: 12 }];
  // a-b good, b-c fair, c-d poor, d-a bad, a-c and b-d fair/good by SNR.
  const snr: Record<string, number> = {
    "a>b": 30,
    "b>a": 30,
    "b>c": 20,
    "c>b": 20,
    "c>d": 12,
    "d>c": 12,
    "d>a": 4,
    "a>d": 4,
  };
  session.budgetOf = (from, to) => wifiBudget(snr[`${from.id}>${to.id}`] ?? 28, 10);
  session.problems = ["node d: the link to a is below the 6 Mbit/s threshold"];
  session.add({ type: "phase", t: 0, label: "start" });
  session.add({
    type: "link-override",
    t: 1000,
    from: "a",
    to: "b",
    extraLossPct: 30,
    extraLatencyMs: 5,
  });
  for (let i = 0; i < 6; i++) {
    session.add({
      type: i % 3 === 0 ? "drop" : "deliver",
      t: 3000 + i * 100,
      from: "a",
      to: "b",
      bytes: 10,
      kind: "udp",
      delayMs: 1,
      attempts: 1,
      rateMbps: 54,
      rssiDbm: -60,
      snrDb: 30,
      reason: "retry_exhausted",
    });
  }
  return session;
}

const STATES = [
  "idle",
  "starting",
  "running",
  "finished-passed",
  "finished-failed",
  "failed",
  "stopped",
] as const;

function inState(session: FakeSession, state: (typeof STATES)[number]): FakeSession {
  switch (state) {
    case "idle":
      session.state = "idle";
      break;
    case "starting":
      session.state = "starting";
      session.elapsed = null;
      break;
    case "running":
      session.state = "running";
      break;
    case "finished-passed":
      session.state = "finished";
      session.passed = true;
      break;
    case "finished-failed":
      session.state = "finished";
      session.passed = false;
      break;
    case "failed":
      session.state = "failed";
      session.error = "board a: the worker did not start within 30 s";
      break;
    case "stopped":
      session.state = "stopped";
      break;
  }
  return session;
}

Deno.test({
  name: "ui: the theme follows the system preference, now and when it changes",
  ignore: CHROMIUM === null,
  fn: async () => {
    await withPage(async (page) => {
      await serving(richSession(), async (url) => {
        await page.viewport(1280, 800);
        for (const theme of THEMES) {
          await page.scheme(theme);
          await page.goto(url);
          await page.waitFor(`document.querySelectorAll(".node").length === 4`, "the nodes");
          assertEquals(await page.eval(`document.documentElement.dataset.theme`), theme);
          assertEquals(
            await page.eval(`getComputedStyle(document.documentElement).colorScheme`),
            theme,
          );
        }
        // Switched while the page is open: the colors follow without a reload.
        const background = () =>
          page.eval<string>(`getComputedStyle(document.body).backgroundColor`);
        await page.scheme("dark");
        await page.waitFor(`document.documentElement.dataset.theme === "dark"`, "the dark theme");
        const dark = await background();
        await page.scheme("light");
        await page.waitFor(`document.documentElement.dataset.theme === "light"`, "the light theme");
        assertNotEquals(await background(), dark);
      });
    });
  },
});

Deno.test({
  name: "ui: every text meets WCAG AA contrast in both themes and in every state of the run",
  ignore: CHROMIUM === null,
  fn: async () => {
    await withPage(async (page) => {
      const failures: string[] = [];
      let measured = 0;
      await page.viewport(1280, 800);
      for (const theme of THEMES) {
        await page.scheme(theme);
        for (const state of STATES) {
          await serving(inState(richSession(), state), async (url) => {
            await page.goto(url);
            await page.waitFor(
              `document.getElementById("state").dataset.state !== "connecting" && document.getElementById("state").dataset.state !== undefined`,
              "the first answer",
            );
            if (state !== "idle") {
              await page.waitFor(`document.querySelectorAll(".node").length === 4`, "the nodes");
            }
            for (const mode of ["signal", "loss"]) {
              await page.eval(`document.querySelector('input[value="${mode}"]').click()`);
              const entries = await page.eval<TextEntry[]>(`__hzb.texts()`);
              measured += entries.length;
              failures.push(...textContrastFailures(entries, `${theme}/${state}/${mode}`));
            }
            // The "None reported." placeholder is generated content.
            const empty = await page.eval<Json>(`__hzb.pseudoText(".problems:empty", "::after")`);
            if (empty) {
              measured++;
              failures.push(
                ...textContrastFailures([{
                  what: "problems placeholder",
                  fg: empty.fg,
                  chain: empty.chain,
                  opacity: 1,
                  size: empty.size,
                  weight: empty.weight,
                  halo: null,
                }], `${theme}/${state}`),
              );
            }
          });
        }
      }
      // The two states a run's status does not reach: a refused move, and a lost connection.
      for (const theme of THEMES) {
        await page.scheme(theme);
        const session = richSession();
        await serving(session, async (url) => {
          await page.goto(url);
          await page.waitFor(`document.querySelectorAll(".node").length === 4`, "the nodes");
          session.moveError = new ToolError(
            "node a is the internet gateway: it is not on the medium",
          );
          await page.eval(`${noderef("a")}.focus()`);
          await page.key("ArrowRight", 39);
          await page.waitFor(noticeText, "the notice");
          let entries = await page.eval<TextEntry[]>(`__hzb.texts()`);
          assert(
            entries.some((e) => e.what.includes("notice")),
            "the notice was not among the texts",
          );
          measured += entries.length;
          failures.push(...textContrastFailures(entries, `${theme}/notice`));
          session.statusError = new Error("gone");
          const quiet = console.error;
          console.error = () => {}; // the server prints the stack of the error it turns into a 500
          try {
            await page.waitFor(
              `document.getElementById("state").dataset.state === "disconnected"`,
              "disconnected",
            );
            entries = await page.eval<TextEntry[]>(`__hzb.texts()`);
          } finally {
            console.error = quiet;
          }
          assert(
            entries.some((e) => e.what.includes("p#state") && e.what.includes("disconnected")),
          );
          measured += entries.length;
          failures.push(...textContrastFailures(entries, `${theme}/disconnected`));
        });
      }
      assert(measured > 200, `only ${measured} texts were measured`);
      assertEquals([...new Set(failures)], []);
    });
  },
});

// ── The color of a cable ────────────────────────────────────────────────────

type Quality = "good" | "fair" | "poor" | "bad" | "idle";

// What the legend promises, from the design tokens Velxio ships (dark theme).
const DASH: Record<Quality, string> = {
  good: "none",
  fair: "none",
  poor: "10px, 5px",
  bad: "3px, 6px",
  idle: "1px, 7px",
};

/** The stroke of the half of a link that starts at `from`, as the browser computes it. */
const HALF_STYLE = (from: string, to: string) =>
  String.raw`(() => {
  const line = [...document.querySelectorAll("#map line.link")].find((l) =>
    l.querySelector("title").textContent.startsWith(${JSON.stringify(`${from} → ${to}:`)}));
  if (!line) return null;
  const s = getComputedStyle(line);
  const root = getComputedStyle(document.documentElement);
  return {
    classes: line.getAttribute("class"),
    stroke: __hzb.parseColor(s.stroke),
    dash: s.strokeDasharray,
    width: parseFloat(s.strokeWidth),
    tokens: Object.fromEntries(["good", "fair", "poor", "bad", "idle"].map((q) => [q, __hzb.parseColor(root.getPropertyValue("--hzb-" + q))])),
  };
})()`;

const sameColor = (a: Rgba, b: Rgba) => a.every((v, i) => Math.abs(v - b[i]!) < 0.51);

/** The SNR at which a chip PHY's packet error rate crosses `pct`, by bisection on the engine's own curve. */
function snrAtLoss(pct: number, signal: ChipSignal): number {
  let [lo, hi] = [signal.requiredSnrDb - 30, signal.requiredSnrDb + 30];
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const per =
      chipPacketErrorRate(mid, signal.requiredSnrDb, signal.referenceBytes, signal.referenceBytes) *
      100;
    if (per > pct) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const EPSILON_DB = 0.002;

function chip(requiredSnrDb: number, referenceBytes: number, rateBps: number): ChipSignal {
  return {
    frequencyHz: 2.4e9,
    bandwidthHz: 1e6,
    noiseFigureDb: 6,
    txPowerDbm: 0,
    requiredSnrDb,
    referenceBytes,
    rateBps,
  };
}

/** The four PHYs the view draws, with the SNR at each boundary of its signal scale and the bucket on each side. */
const PHYS: {
  phy: string;
  signal?: ChipSignal;
  boundaries: { snr: number; above: Quality; below: Quality }[];
}[] = [
  {
    phy: "wifi",
    // The rate table: 54 Mbit/s from 26 dB, 24 from 17, the slowest from 9.
    boundaries: [
      { snr: 26, above: "good", below: "fair" },
      { snr: 17, above: "fair", below: "poor" },
      { snr: 9, above: "poor", below: "bad" },
    ],
  },
  ...[
    ["lora", chip(-7.5, 20, 5468.75)],
    ["nrf24", chip(12, 32, 1e6)],
    ["ble", chip(8, 37, 1e6)],
  ].map(([phy, signal]) => {
    const s = signal as ChipSignal;
    return {
      phy: phy as string,
      signal: s,
      // 1%, 10% and 50% of the reference frames lost to noise: above the SNR is the better bucket.
      boundaries: [
        { snr: snrAtLoss(1, s), above: "good" as Quality, below: "fair" as Quality },
        { snr: snrAtLoss(10, s), above: "fair" as Quality, below: "poor" as Quality },
        { snr: snrAtLoss(50, s), above: "poor" as Quality, below: "bad" as Quality },
      ],
    };
  }),
];

/** Six nodes, every pair a link; the SNR of each directed link is read from `snr` by name. */
function sixNodes(
  phy: string,
  signal: ChipSignal | undefined,
  snr: Map<string, number>,
): FakeSession {
  const session = new FakeSession().setNodes([
    ["n1", 0, 0],
    ["n2", 20, 0],
    ["n3", 40, 0],
    ["n4", 0, 20],
    ["n5", 20, 20],
    ["n6", 40, 20],
  ]);
  session.phy = phy;
  session.budgetOf = (from, to) => {
    const value = snr.get(`${from.id}>${to.id}`) ?? 40;
    return signal ? { ...wifiBudget(value, 20), signal } : wifiBudget(value, 20);
  };
  return session;
}

Deno.test({
  name: "ui: a cable changes color at every SNR boundary of every PHY, on both sides of it",
  ignore: CHROMIUM === null,
  fn: async () => {
    await withPage(async (page) => {
      await page.viewport(1280, 800);
      const failures: string[] = [];
      for (const { phy, signal, boundaries } of PHYS) {
        // One directed link per case: the SNR just above and just below each boundary, and far from all of them.
        const cases: { from: string; to: string; snr: number; expect: Quality; why: string }[] = [];
        const pairs = [
          ["n1", "n2"],
          ["n2", "n3"],
          ["n4", "n5"],
          ["n5", "n6"],
          ["n1", "n4"],
          ["n2", "n5"],
          ["n3", "n6"],
          ["n1", "n5"],
        ];
        const values: { snr: number; expect: Quality; why: string }[] = [
          { snr: 80, expect: "good", why: "far above every boundary" },
          { snr: -40, expect: "bad", why: "far below every boundary" },
          ...boundaries.flatMap((b, i) => [
            {
              snr: b.snr + EPSILON_DB,
              expect: b.above,
              why: `just above boundary ${i + 1} (${b.snr.toFixed(3)} dB)`,
            },
            { snr: b.snr, expect: b.above, why: `exactly at boundary ${i + 1}` },
            {
              snr: b.snr - EPSILON_DB,
              expect: b.below,
              why: `just below boundary ${i + 1} (${b.snr.toFixed(3)} dB)`,
            },
          ]),
        ];
        // wifi and the chip PHYs agree that a boundary SNR is the better bucket for chips only up to rounding.
        const usable = values.filter((v) =>
          !(signal &&
            v.why === `exactly at boundary ${boundaries.findIndex((b) => b.snr === v.snr) + 1}`)
        );
        // 8 pairs, two directions each: 16 directed links to place cases on.
        const links = pairs.flatMap(([a, b]) => [[a!, b!], [b!, a!]]);
        const snr = new Map<string, number>();
        usable.forEach((v, i) => {
          const [from, to] = links[i]!;
          snr.set(`${from}>${to}`, v.snr);
          cases.push({ from: from!, to: to!, snr: v.snr, expect: v.expect, why: v.why });
        });
        assert(
          cases.length <= links.length,
          `${phy}: ${cases.length} cases for ${links.length} links`,
        );
        await serving(sixNodes(phy, signal, snr), async (url) => {
          await page.goto(url);
          await page.waitFor(
            `document.querySelectorAll("#map line.link").length === 30`,
            "thirty halves",
          );
          for (const c of cases) {
            const half = await page.eval<Json>(HALF_STYLE(c.from, c.to));
            const at = `${phy} ${c.from}->${c.to} at ${c.snr} dB (${c.why})`;
            if (!half) {
              failures.push(`${at}: no line`);
              continue;
            }
            if (!half.classes.split(" ").includes(`q-${c.expect}`)) {
              failures.push(`${at}: classes ${half.classes}, wanted q-${c.expect}`);
            }
            if (!sameColor(half.stroke, half.tokens[c.expect])) {
              failures.push(`${at}: stroke ${half.stroke}, wanted ${half.tokens[c.expect]}`);
            }
            if (half.dash !== DASH[c.expect]) {
              failures.push(`${at}: dash ${half.dash}, wanted ${DASH[c.expect]}`);
            }
          }
          // The four colors differ from each other, so a bucket never reads as its neighbour.
          const { tokens } = await page.eval<Json>(HALF_STYLE(cases[0]!.from, cases[0]!.to));
          const names = Object.keys(tokens);
          for (let i = 0; i < names.length; i++) {
            for (let j = i + 1; j < names.length; j++) {
              if (sameColor(tokens[names[i]!], tokens[names[j]!])) {
                failures.push(`${phy}: ${names[i]} and ${names[j]} share a color`);
              }
            }
          }
          assertEquals(page.errors, []);
        });
      }
      assertEquals(failures, []);
    });
  },
});

Deno.test({
  name:
    "ui: in loss mode a cable changes color at 1%, 10% and 50% of frames lost, and is grey with no frame",
  ignore: CHROMIUM === null,
  fn: async () => {
    await withPage(async (page) => {
      await page.viewport(1280, 800);
      // [frames sent in the last 2 s, frames lost] -> the bucket, around each boundary.
      const cases: { sent: number; lost: number; expect: Quality }[] = [
        { sent: 0, lost: 0, expect: "idle" },
        { sent: 1, lost: 0, expect: "good" },
        { sent: 200, lost: 1, expect: "good" }, // 0.5%
        { sent: 100, lost: 1, expect: "fair" }, // 1%
        { sent: 100, lost: 9, expect: "fair" },
        { sent: 10, lost: 1, expect: "poor" }, // 10%
        { sent: 100, lost: 49, expect: "poor" },
        { sent: 100, lost: 50, expect: "bad" }, // 50%
        { sent: 5, lost: 5, expect: "bad" }, // 100%
      ];
      const failures: string[] = [];
      for (const phy of ["wifi", "lora", "nrf24", "ble"]) {
        const pairs = [["n1", "n2"], ["n2", "n3"], ["n4", "n5"], ["n5", "n6"], ["n1", "n4"]];
        const links = pairs.flatMap(([a, b]) => [[a!, b!], [b!, a!]]);
        const session = sixNodes(phy, phy === "wifi" ? undefined : chip(8, 32, 1e6), new Map());
        session.elapsed = 10_000;
        cases.forEach((c, i) => {
          const [from, to] = links[i]!;
          for (let k = 0; k < c.sent; k++) {
            const lost = k < c.lost;
            session.add({
              type: lost ? "drop" : "deliver",
              t: 8100 + (k % 1800),
              from,
              to,
              bytes: 20,
              kind: "udp",
              delayMs: 1,
              attempts: 1,
              rateMbps: 54,
              rssiDbm: -60,
              snrDb: 30,
              reason: "retry_exhausted",
            });
          }
          // Older frames, outside the 2 s window, must not count.
          if (c.sent > 0) {
            for (let k = 0; k < 50; k++) {
              session.add({
                type: "drop",
                t: 500 + k,
                from,
                to,
                bytes: 20,
                kind: "udp",
                reason: "retry_exhausted",
                attempts: 1,
                rssiDbm: -60,
                snrDb: 30,
              });
            }
          }
        });
        await serving(session, async (url) => {
          await page.goto(url);
          await page.waitFor(
            `document.querySelectorAll("#map line.link").length === 30`,
            "thirty halves",
          );
          await page.eval(`document.querySelector('input[value="loss"]').click()`);
          cases.forEach(() => {});
          for (const [i, c] of cases.entries()) {
            const [from, to] = links[i]!;
            const half = await page.eval<Json>(HALF_STYLE(from!, to!));
            const at = `${phy} ${from}->${to} ${c.lost}/${c.sent} lost`;
            if (!half.classes.split(" ").includes(`q-${c.expect}`)) {
              failures.push(`${at}: classes ${half.classes}, wanted q-${c.expect}`);
            }
            if (!sameColor(half.stroke, half.tokens[c.expect])) {
              failures.push(`${at}: stroke ${half.stroke}, wanted ${half.tokens[c.expect]}`);
            }
            if (half.dash !== DASH[c.expect]) {
              failures.push(`${at}: dash ${half.dash}, wanted ${DASH[c.expect]}`);
            }
          }
        });
      }
      assertEquals(failures, []);
    });
  },
});

// ── Real runs: the engine's own budgets move the colors ─────────────────────

const REAL_SCENARIOS: Record<
  string,
  { yaml: string; other: string; mover: string; reach: number }
> = {
  wifi: {
    other: "a",
    mover: "b",
    reach: 2000,
    yaml: `
name: ui-wifi
seed: 3
duration: 120s
environment: { preset: indoor_office, shadowing_sigma_db: 0 }
nodes:
  - { id: a, board: scripted, position: [0, 0], firmware: { send: [{ to: b, every: 100ms, count: 1000, payload: ping }] } }
  - { id: b, board: scripted, position: [5, 0], firmware: { send: [{ to: a, every: 100ms, count: 1000, payload: ping }] } }
`,
  },
  lora: {
    other: "gw",
    mover: "node-1",
    reach: 20_000,
    yaml: `
name: ui-lora
seed: 7
duration: 120s
environment: { preset: urban, shadowing_sigma_db: 0 }
nodes:
  - id: gw
    board: scripted
    position: [0, 0]
    radios: [{ phy: lora, frequency_mhz: 868.1, sf: 7, bw_khz: 125, cr: 4/5, tx_power_dbm: 14 }]
    firmware: { listen: true }
  - id: node-1
    board: scripted
    position: [300, 0]
    radios: [{ phy: lora, frequency_mhz: 868.1, sf: 7, bw_khz: 125, cr: 4/5, tx_power_dbm: 14 }]
    firmware: { send: [{ every: 700ms, count: 150, start: 0ms, payload: reading }] }
`,
  },
  nrf24: {
    other: "gw",
    mover: "near",
    reach: 5000,
    yaml: `
name: ui-nrf24
seed: 5
duration: 120s
environment: { preset: indoor_office, shadowing_sigma_db: 0 }
nodes:
  - { id: gw, board: scripted, position: [0, 0], radios: [{ phy: nrf24 }], firmware: {} }
  - id: near
    board: scripted
    position: [5, 0]
    radios: [{ phy: nrf24 }]
    firmware: { send: [{ to: gw, every: 200ms, count: 500, payload: t }] }
`,
  },
  ble: {
    other: "gw",
    mover: "s1",
    reach: 5000,
    yaml: `
name: ui-ble
seed: 11
duration: 120s
environment: { preset: indoor_office, shadowing_sigma_db: 0 }
nodes:
  - id: gw
    board: scripted
    position: [0, 0]
    radios: [{ phy: ble, tx_power_dbm: 0 }]
    firmware:
      connect: { peers: [s1], interval: 30ms, timeout: 1s }
  - id: s1
    board: scripted
    position: [5, 0]
    radios: [{ phy: ble, tx_power_dbm: 0 }]
    firmware:
      advertise: { interval: 50ms }
      send: [{ to: gw, every: 200ms, count: 500, payload: reading }]
`,
  },
};

/** A scripted scenario running in this process behind the real server. */
async function realRun(
  yaml: string,
  fn: (context: { session: Session; url: string }) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "hzb-ui-run-" });
  const session = new Session({ workspace: dir });
  const server = serveView(session, { port: 0 });
  try {
    await Deno.writeTextFile(`${dir}/scenario.yaml`, yaml);
    await session.start(`${dir}/scenario.yaml`, { out: `${dir}/out` });
    const deadline = performance.now() + 30_000;
    while (session.status().state !== "running" || session.elapsedMs(session.run!) === null) {
      const { state } = session.status();
      if (state === "failed" || state === "stopped" || performance.now() > deadline) {
        throw new Error(`the run did not start: ${JSON.stringify(session.status())}`);
      }
      await sleep(50);
    }
    await fn({ session, url: server.url });
  } finally {
    await session.close();
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
}

const ORDER: Quality[] = ["good", "fair", "poor", "bad"];

/** The bucket a budget falls in, worked out here from the channel model's numbers and the documented thresholds. */
function bucketOf(budget: LinkBudget & { signal?: ChipSignal }): Quality {
  if (!budget.signal) {
    // The rate table: 54 Mbit/s needs 26 dB, 24 needs 17, the slowest rate 9.
    return budget.snrDb >= 26
      ? "good"
      : budget.snrDb >= 17
      ? "fair"
      : budget.snrDb >= 9
      ? "poor"
      : "bad";
  }
  const s = budget.signal;
  const lossPct =
    chipPacketErrorRate(budget.snrDb, s.requiredSnrDb, s.referenceBytes, s.referenceBytes) * 100;
  return lossPct < 1 ? "good" : lossPct < 10 ? "fair" : lossPct < 50 ? "poor" : "bad";
}

const halfClasses = (from: string, to: string, quality: Quality) =>
  `${HALF_STYLE(from, to)}?.classes.split(" ").includes("q-${quality}")`;

for (const phy of Object.keys(REAL_SCENARIOS)) {
  Deno.test({
    name:
      `ui: on a real ${phy} run the cable turns from one color to the next at each boundary as a node moves`,
    ignore: CHROMIUM === null,
    fn: async () => {
      const { yaml, mover, other, reach } = REAL_SCENARIOS[phy]!;
      await realRun(yaml, async ({ session, url }) => {
        await withPage(async (page) => {
          await page.viewport(1280, 800);
          await page.goto(url);
          await page.waitFor(
            `document.querySelectorAll("#map line.link").length === 2`,
            "the two halves",
          );
          const budget = (from: string, to: string) =>
            session.linkBudgets(session.run!).find((l) => l.from === from && l.to === to)!.budget;
          const pageAgrees = async (from: string, to: string, why: string) => {
            const expected = bucketOf(budget(from, to));
            await page.waitFor(
              halfClasses(from, to, expected),
              `${phy} ${from}->${to} to be ${expected} ${why}`,
              8000,
            );
          };
          const at = (x: number) => {
            session.move(mover, { x, y: 0 }, null);
            return bucketOf(budget(mover, other));
          };
          at(1);
          assertEquals(
            bucketOf(budget(mover, other)),
            "good",
            `${phy}: one metre away is not good`,
          );
          // x grows, the link worsens: find where each bucket ends.
          let seen = 0;
          let goodUntil = 0;
          for (const next of ORDER.slice(1)) {
            const worse = (x: number) => ORDER.indexOf(at(x)) >= ORDER.indexOf(next);
            let hi = 2;
            while (!worse(hi)) {
              hi *= 2;
              assert(hi <= reach, `${phy}: never reaches ${next} within ${reach} m`);
            }
            let lo = hi / 2;
            while (hi - lo > 1e-6 * hi) {
              const mid = (lo + hi) / 2;
              if (worse(mid)) hi = mid;
              else lo = mid;
            }
            if (seen === 0) goodUntil = lo;
            seen++;
            // A BLE budget is read against the sender's last frame, and frames hop between
            // channels, so it wanders by a tenth of a dB at one position: stand clear of the edge.
            const margin = phy === "ble" ? 0.03 : 0;
            for (
              const [x, label] of [[lo * (1 - margin), "before"], [
                hi * (1 + margin),
                "after",
              ]] as const
            ) {
              const expected = at(x);
              assertEquals(
                ORDER.indexOf(expected) >= ORDER.indexOf(next),
                label === "after",
                `${phy}: ${label} the ${next} boundary at ${x} m the model says ${expected}`,
              );
              for (const [from, to] of [[mover, other], [other, mover]] as [string, string][]) {
                await page.waitFor(
                  halfClasses(from, to, expected),
                  `${phy} ${from}->${to} to be ${expected} ${label} the ${next} boundary (${x} m); now ${
                    JSON.stringify(await page.eval(HALF_STYLE(from, to)).then((h) => h?.classes))
                  }`,
                  8000,
                );
                const half = await page.eval<Json>(HALF_STYLE(from, to));
                assert(
                  sameColor(half.stroke, half.tokens[expected]),
                  `${phy}: ${from}->${to} stroke ${half.stroke}`,
                );
              }
              // The table row says the same as the cable.
              await page.waitFor(
                `[...document.querySelectorAll("#links tr")].some((r) => r.firstChild.textContent.startsWith("${mover} → ${other}") && r.querySelector(".quality").textContent === "${expected}")`,
                `the table row of ${mover} → ${other} to say ${expected}`,
                8000,
              );
            }
          }
          assertEquals(seen, 3);

          // A fault on a real link of this PHY: the table names it, and the cable takes the model's new bucket.
          at(goodUntil / 2);
          assertEquals(
            bucketOf(budget(mover, other)),
            "good",
            `${phy}: half way to the first boundary`,
          );
          await pageAgrees(mover, other, "back where the link is good");
          const quiet = budget(mover, other).snrDb;
          session.fault(
            { from: mover, to: other, extraLossPct: 10, extraLatencyMs: 3, interferenceDb: 40 },
            null,
          );
          const loud = budget(mover, other);
          assert(
            loud.snrDb < quiet - 30,
            `${phy}: 40 dB of interference left the SNR at ${loud.snrDb} from ${quiet}`,
          );
          assertNotEquals(bucketOf(loud), "good");
          await pageAgrees(mover, other, "under interference");
          await page.waitFor(
            `[...document.querySelectorAll("#links tr")].some((r) => r.firstChild.textContent === "${mover} → ${other} forced 10% loss, 3 ms, +40 dB noise")`,
            `the table to name the fault on ${mover} → ${other}`,
            8000,
          );
          assertEquals(await page.eval(`document.querySelectorAll("#links .override").length`), 1);
          // Cleared, the link is as it was.
          session.fault({ from: mover, to: other, extraLossPct: 0, extraLatencyMs: 0 }, null);
          await page.waitFor(
            `document.querySelectorAll("#links .override").length === 0`,
            "the fault to clear",
            8000,
          );
          await pageAgrees(mover, other, "after the fault");
          assertEquals(page.errors, []);
        });
      });
    },
  });
}

// ── Dragging and the keyboard ───────────────────────────────────────────────

/** The screen centre of every node's ring, by id. */
const CENTRES = String.raw`(() => {
  const out = {};
  for (const node of document.querySelectorAll(".node")) {
    const r = node.querySelector("circle.node-ring").getBoundingClientRect();
    out[node.getAttribute("aria-label").split(",")[0]] = [r.x + r.width / 2, r.y + r.height / 2];
  }
  return out;
})()`;

const noderef = (id: string) =>
  `[...document.querySelectorAll(".node")].find((n) => n.getAttribute("aria-label").startsWith(${
    JSON.stringify(id + ",")
  }))`;

const noticeText =
  `(() => { const n = document.getElementById("notice"); return n.hidden ? null : n.textContent; })()`;

async function drag(
  page: Page,
  from: [number, number],
  to: [number, number],
  steps = 8,
  button = "left",
) {
  await page.mouse("mouseMoved", from[0], from[1]);
  await page.mouse("mousePressed", from[0], from[1], {
    button,
    buttons: button === "left" ? 1 : 2,
  });
  for (let step = 1; step <= steps; step++) {
    await page.mouse(
      "mouseMoved",
      from[0] + ((to[0] - from[0]) * step) / steps,
      from[1] + ((to[1] - from[1]) * step) / steps,
      { button, buttons: button === "left" ? 1 : 2 },
    );
  }
  await page.mouse("mouseReleased", to[0], to[1], { button });
}

Deno.test({
  name:
    "ui: a drag moves the node under the pointer once, and every refusal leaves it where it was with a message",
  ignore: CHROMIUM === null,
  fn: async () => {
    const session = threeNodes();
    await withPage(async (page) => {
      await serving(session, async (url, server) => {
        await page.viewport(1280, 800);
        await page.goto(url);
        await page.waitFor(`document.querySelectorAll(".node").length === 3`, "three nodes");
        const centres = () => page.eval<Record<string, [number, number]>>(CENTRES);
        const before = await centres();
        const metre = (before.b![0] - before.a![0]) / 8;
        assert(metre > 5, `a metre is ${metre} px`);

        // The drag: the node follows the pointer, the others and the scale stay put, one move on release.
        const [cx, cy] = before.c!;
        const target: [number, number] = [cx + 6 * metre, cy - 3 * metre];
        await page.mouse("mouseMoved", cx, cy);
        await page.mouse("mousePressed", cx, cy, { buttons: 1 });
        await page.waitFor(`${noderef("c")}.classList.contains("dragging")`, "the dragging class");
        for (let step = 1; step <= 10; step++) {
          await page.mouse(
            "mouseMoved",
            cx + ((target[0] - cx) * step) / 10,
            cy + ((target[1] - cy) * step) / 10,
            { buttons: 1 },
          );
        }
        const during = await centres();
        assert(
          Math.abs(during.c![0] - target[0]) < 1.5 && Math.abs(during.c![1] - target[1]) < 1.5,
          `c is at ${during.c}, the pointer at ${target}`,
        );
        assertEquals([during.a, during.b], [before.a, before.b], "the others moved while dragging");
        assertEquals(session.moves, [], "a move was posted before the pointer was released");
        await page.mouse("mouseReleased", target[0], target[1]);
        await page.waitFor(
          `!${noderef("c")}.classList.contains("dragging")`,
          "the end of the drag",
        );
        await until(() => session.moves.length === 1, "the move to reach the server");
        await sleep(QUIET_MS);
        assertEquals(session.moves.length, 1, "one drag is one move");
        const move = session.moves[0]!;
        assertEquals(move.node, "c");
        assert(
          Math.abs(move.to.x - 18) < 0.3 && Math.abs(move.to.y - 7) < 0.3,
          JSON.stringify(move.to),
        );
        assertEquals(
          move.to.x,
          Math.round(move.to.x * 10) / 10,
          "positions go out rounded to 0.1 m",
        );
        assertMatch(
          await page.eval<string>(`${noderef("c")}.getAttribute("aria-label")`),
          /at x 18\.\d m, y [67]\.\d m/,
        );

        // A right-button press, a press on nothing, and a drag that is cancelled post nothing.
        const sent = session.moves.length;
        const [bx, by] = (await centres()).b!;
        await drag(page, [bx, by], [bx + 40, by + 40], 4, "right");
        await page.mouse("mouseMoved", 5, 5);
        await page.mouse("mousePressed", 5, 5, { buttons: 1 });
        await page.mouse("mouseReleased", 40, 40);
        await page.send("Emulation.setTouchEmulationEnabled", { enabled: true });
        await page.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: bx, y: by, id: 1 }],
        });
        await page.waitFor(`${noderef("b")}.classList.contains("dragging")`, "a touch drag");
        await page.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: bx + 60, y: by + 30, id: 1 }],
        });
        await page.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
        await page.waitFor(
          `!${noderef("b")}.classList.contains("dragging")`,
          "the cancelled drag to end",
        );
        await page.send("Emulation.setTouchEmulationEnabled", { enabled: false });
        await sleep(QUIET_MS);
        assertEquals(session.moves.length, sent, "a refused or cancelled drag posted a move");
        const after = await centres();
        assert(
          Math.abs(after.b![0] - bx) < 1 && Math.abs(after.b![1] - by) < 1,
          `b did not return: ${after.b} vs ${[bx, by]}`,
        );

        // The engine refuses with its own sentence: it is shown, and the node goes back.
        session.moveError = new ToolError("c is the internet gateway: it is not on the medium");
        const [gx, gy] = (await centres()).c!;
        await drag(page, [gx, gy], [gx - 50, gy + 50]);
        await page.waitFor(noticeText, "the refusal");
        assertEquals(
          await page.eval(noticeText),
          "Could not move c: c is the internet gateway: it is not on the medium",
        );
        assertEquals(
          await page.eval(`document.getElementById("notice").getAttribute("role")`),
          "alert",
        );
        await page.waitFor(
          `Math.abs(${JSON.stringify(gx)} - __c().c[0]) < 1`.replace(
            "__c()",
            `(${CENTRES.trim()})`,
          ),
          "c back in place",
        );

        // An error that is not JSON still reaches the person, as its plain text.
        session.moveError = new Error("boom");
        const spy = console.error;
        console.error = () => {}; // the server prints the stack of the error it turns into a 500
        try {
          await drag(page, [gx, gy], [gx - 50, gy + 50]);
          await page.waitFor(
            `document.getElementById("notice").textContent.includes("internal error")`,
            "the plain-text refusal",
          );
        } finally {
          console.error = spy;
        }
        assertEquals(
          await page.eval(noticeText),
          "Could not move c: internal error; see the server's stderr",
        );
        // ... and hides itself.
        await page.waitFor(`document.getElementById("notice").hidden`, "the notice to hide", 9000);

        // The run ended: nodes no longer move, and say why on a try.
        session.moveError = null;
        session.state = "finished";
        await page.waitFor(
          `${noderef("a")}.getAttribute("aria-disabled") === "true"`,
          "disabled nodes",
        );
        const [ax, ay] = (await centres()).a!;
        const posted = session.moves.length;
        await drag(page, [ax, ay], [ax + 50, ay]);
        await sleep(QUIET_MS);
        assertEquals(session.moves.length, posted);
        assertEquals(await page.eval(`${noderef("a")}.classList.contains("dragging")`), false);
        assertMatch(
          await page.eval<string>(`${noderef("a")}.getAttribute("aria-label")`),
          /Moves work while the run is running/,
        );

        // The server going away mid-flight: the page says it is disconnected, and a move says why it failed.
        session.state = "running";
        await page.waitFor(
          `document.getElementById("state").dataset.state === "running"`,
          "running again",
        );
        await server.shutdown();
        await page.waitFor(
          `document.getElementById("state").dataset.state === "disconnected"`,
          "the disconnected state",
          9000,
        );
        assertMatch(
          await page.eval<string>(`document.getElementById("state").textContent`),
          /^disconnected: /,
        );
        assertEquals(page.errors.filter((e) => !/Failed to load resource|ERR_/.test(e)), []);
      });
    });
  },
});

Deno.test({
  name:
    "ui: the keyboard reaches every control with a visible focus ring, arrows move a node, targets are 24 px",
  ignore: CHROMIUM === null,
  fn: async () => {
    const session = threeNodes();
    await withPage(async (page) => {
      await serving(session, async (url) => {
        await page.viewport(1280, 800);
        await page.goto(url);
        await page.waitFor(`document.querySelectorAll(".node").length === 3`, "three nodes");
        const focused = () =>
          page.eval<string>(
            `(() => { const a = document.activeElement; return a.classList.contains("node") ? "node " + a.getAttribute("aria-label").split(",")[0] : a.tagName.toLowerCase() + (a.value ? " " + a.value : ""); })()`,
          );

        // Tab order: the nodes in turn, then the mode choice (one stop for the group), and back.
        const order: string[] = [];
        for (let i = 0; i < 4; i++) {
          await page.key("Tab", 9);
          order.push(await focused());
        }
        assertEquals(order, ["node a", "node b", "node c", "input signal"]);
        await page.key("Tab", 9, 8);
        assertEquals(await focused(), "node c");

        // The ring on a focused node is visible against the map, and the radio shows a ring too.
        const ring = await page.eval<Json>(`(() => {
          const r = getComputedStyle(document.activeElement.querySelector("circle.node-ring"));
          const map = getComputedStyle(document.getElementById("map"));
          return { stroke: __hzb.parseColor(r.stroke), width: parseFloat(r.strokeWidth), background: __hzb.parseColor(map.backgroundColor) };
        })()`);
        assert(
          ring.stroke[3] === 1 && ring.width >= 2,
          `the focus ring is ${JSON.stringify(ring)}`,
        );
        assert(
          contrast(ring.stroke, ring.background) >= 3,
          `focus ring contrast ${contrast(ring.stroke, ring.background)}`,
        );
        await page.key("Tab", 9);
        assertEquals(await focused(), "input signal");
        assertNotEquals(
          await page.eval(`getComputedStyle(document.activeElement).boxShadow`),
          "none",
        );

        // Arrows: 1 m a press, 5 m with shift, other keys ignored; presses queue up before the server answers.
        await page.eval(`${noderef("a")}.focus()`);
        const start = { ...session.nodes[0]!.position };
        await page.key("ArrowRight", 39);
        await page.key("ArrowUp", 38);
        await page.key("ArrowDown", 40, 8);
        await page.key("ArrowLeft", 37, 8);
        await page.key("a", 65);
        await page.key("Enter", 13);
        await until(() => session.moves.length >= 4, "the four moves to reach the server");
        await sleep(QUIET_MS);
        assertEquals(session.moves.length, 4, "letters and Enter must not move a node");
        assertEquals(session.moves.map((m) => [m.to.x - start.x, m.to.y - start.y]), [
          [1, 0],
          [1, 1],
          [1, -4],
          [-4, -4],
        ]);
        assertMatch(
          await page.eval<string>(`${noderef("a")}.getAttribute("aria-label")`),
          /Arrow keys move it/,
        );

        // A node off the medium and a run that ended both say why a key does nothing.
        session.nodes[1]!.onMedium = false;
        await page.waitFor(
          `${noderef("b")}.classList.contains("node-off")`,
          "the node off the medium",
        );
        assertMatch(
          await page.eval<string>(`${noderef("b")}.getAttribute("aria-label")`),
          /Not on the medium/,
        );
        await page.eval(`${noderef("b")}.focus()`);
        const posted = session.moves.length;
        await page.key("ArrowRight", 39);
        await sleep(QUIET_MS);
        assertEquals(
          await page.eval(noticeText),
          "b can only be moved while the run is running and the node is on the medium.",
        );
        assertEquals(session.moves.length, posted);

        // Targets: a node is a 44 px ring, a mode choice a 24 px row, and a click on its text selects it.
        const targets = await page.eval<Json[]>(
          `[...document.querySelectorAll(".node, .mode label, .mode input")].map((e) => { const r = e.getBoundingClientRect(); return { what: __hzb.describe(e), w: r.width, h: r.height }; })`,
        );
        for (const t of targets.filter((t) => !t.what.startsWith("input"))) {
          assert(t.w >= 24 && t.h >= 24, `${t.what} is ${t.w}x${t.h}`);
        }
        const label = await page.eval<Box>(
          `__hzb.rect(document.querySelectorAll(".mode label")[1])`,
        );
        await page.mouse(
          "mousePressed",
          label.left + label.width / 2,
          label.top + label.height / 2,
        );
        await page.mouse(
          "mouseReleased",
          label.left + label.width / 2,
          label.top + label.height / 2,
        );
        assertEquals(
          await page.eval(`document.querySelector('input[value="loss"]').checked`),
          true,
        );
        await page.waitFor(
          `document.getElementById("legend").textContent.includes("lost")`,
          "the loss legend",
        );
        // The arrow keys switch between the two choices.
        await page.eval(`document.querySelector('input[value="loss"]').focus()`);
        await page.key("ArrowUp", 38);
        assertEquals(
          await page.eval(`document.querySelector('input[value="signal"]').checked`),
          true,
        );
        assertEquals(
          await page.eval(`document.getElementById("legend").textContent.includes("Mbit/s")`),
          true,
        );
        assertEquals(page.errors, []);
      });
    });
  },
});

// ── The packet timeline ─────────────────────────────────────────────────────

interface Drawn {
  width: number;
  height: number;
  draws: number;
  texts: {
    text: string;
    x: number;
    y: number;
    width: number;
    align: string;
    fill: Rgba;
    font: string;
  }[];
  rects: { x: number; y: number; w: number; h: number; fill: Rgba }[];
  css: { height: string; label: string };
  tokens: Record<string, Rgba>;
}

const DRAWN = String.raw`(() => {
  const root = getComputedStyle(document.documentElement);
  const token = (n) => __hzb.parseColor(root.getPropertyValue(n));
  const canvas = document.getElementById("timeline");
  return {
    width: __canvas.width,
    height: __canvas.height,
    draws: __canvas.draws,
    texts: __canvas.texts.map((t) => ({ ...t, fill: __hzb.parseColor(t.fill) })),
    rects: __canvas.rects.map((r) => ({ ...r, fill: __hzb.parseColor(r.fill) })),
    css: { height: canvas.style.height, label: canvas.getAttribute("aria-label") },
    tokens: { good: token("--hzb-good"), bad: token("--hzb-bad"), poor: token("--hzb-poor"), strong: token("--hzb-strong"), accent: token("--hzb-accent"), muted: token("--hzb-muted") },
  };
})()`;

const LABEL_WIDTH = 64; // the least the page keeps for row names
const ROW = 16;
const AXIS = 34; // two lines under the rows: seconds, then what happened

/** The left edge of a drawn text, whichever way it is aligned. */
const leftOf = (t: { x: number; width: number; align: string }) =>
  t.align === "center" ? t.x - t.width / 2 : t.align === "right" ? t.x - t.width : t.x;

/** Where the plot starts: the row separators begin there. */
const plotLeft = (d: { rects: { x: number; w: number; h: number }[] }) =>
  Math.min(...d.rects.filter((r) => r.h === 1 && r.w > 50).map((r) => r.x));

function delivered(
  t: number,
  from: string,
  to: string,
): Record<string, unknown> & { type: string; t: number } {
  return {
    type: "deliver",
    t,
    from,
    to,
    bytes: 10,
    kind: "udp",
    delayMs: 1,
    attempts: 1,
    rateMbps: 54,
    rssiDbm: -60,
    snrDb: 30,
  };
}

function lost(
  t: number,
  from: string,
  to: string,
): Record<string, unknown> & { type: string; t: number } {
  return {
    type: "drop",
    t,
    from,
    to,
    bytes: 10,
    kind: "udp",
    reason: "retry_exhausted",
    attempts: 7,
    rssiDbm: -60,
    snrDb: 30,
  };
}

/** What must hold of any drawing of the timeline, whatever the run. */
function timelineProblems(d: Drawn, where: string): string[] {
  const problems: string[] = [];
  const edge = d.rects.some((r) => r.h === 1 && r.w > 50) ? plotLeft(d) : LABEL_WIDTH;
  for (const t of d.texts) {
    const left = leftOf(t);
    if (left < -0.5 || left + t.width > d.width + 0.5) {
      problems.push(
        `${where}: the text ${JSON.stringify(t.text)} at ${left.toFixed(1)}, ${
          t.width.toFixed(1)
        } px wide, leaves the ${d.width} px canvas`,
      );
    }
    if (t.text.includes("→") && t.x <= 4 && t.x + t.width > edge + 0.5) {
      problems.push(
        `${where}: the row name ${JSON.stringify(t.text)} is ${
          t.width.toFixed(1)
        } px and runs into the plot, which starts at ${edge}`,
      );
    }
  }
  for (let i = 0; i < d.texts.length; i++) {
    for (let j = i + 1; j < d.texts.length; j++) {
      const a = d.texts[i]!;
      const b = d.texts[j]!;
      const box = (t: typeof a): Box => ({
        left: leftOf(t),
        right: leftOf(t) + t.width,
        top: t.y - 6,
        bottom: t.y + 6,
        width: t.width,
        height: 12,
      });
      if (overlapArea(box(a), box(b), 0.5) > 1) {
        problems.push(
          `${where}: the text ${JSON.stringify(a.text)} covers ${JSON.stringify(b.text)}`,
        );
      }
    }
  }
  for (const r of d.rects) {
    if (r.x + r.w < -0.5 || r.x > d.width + 0.5 || r.y + r.h < -0.5 || r.y > d.height + 0.5) {
      problems.push(`${where}: a mark at ${r.x.toFixed(1)},${r.y} is off the canvas`);
    }
  }
  return problems;
}

Deno.test({
  name:
    "ui: the packet timeline draws each frame, move, phase and fault at its time and row, and the text fits",
  ignore: CHROMIUM === null,
  fn: async () => {
    await withPage(async (page) => {
      await page.viewport(1280, 800);
      const draw = async (session: FakeSession, rows: number): Promise<Drawn> => {
        return await serving(session, async (url) => {
          await page.goto(url);
          await page.waitFor(
            `document.getElementById("state").dataset.state !== undefined`,
            "the first answer",
          );
          await page.waitFor(
            `__canvas.draws > 0 && document.getElementById("timeline").style.height === "${
              rows * ROW + AXIS
            }px"`,
            "the timeline",
          );
          return await page.eval<Drawn>(DRAWN);
        });
      };

      const session = threeNodes();
      session.elapsed = 12_000;
      session.events_ = [];
      session.add({ type: "phase", t: 4000, label: "warm-up" });
      session.add(delivered(1000, "a", "b")); // before the 10 s window
      session.add({ type: "move", t: 8000, node: "c", position: { x: 12, y: 4 } });
      session.add(lost(9000, "c", "a"));
      session.add({
        type: "link-override",
        t: 10_000,
        from: "a",
        to: "c",
        extraLossPct: 30,
        extraLatencyMs: 0,
      });
      session.add(delivered(11_000, "a", "b"));
      session.add(delivered(11_500, "a", "b"));
      session.add(lost(11_800, "a", "b"));
      const d = await draw(session, 6);
      const plot = d.width - LABEL_WIDTH - 8;
      const x = (t: number) => LABEL_WIDTH + ((t - 2000) / 10_000) * plot;
      const near = (a: number, b: number) => Math.abs(a - b) < 0.6;
      const mark = (fill: Rgba, at: number, y: number) =>
        d.rects.filter((r) => sameColor(r.fill, fill) && near(r.x, x(at)) && near(r.y, y));
      assertEquals(
        mark(d.tokens.good!, 11_000, 5).length,
        1,
        "a delivered frame is a green tick in its row",
      );
      assertEquals(mark(d.tokens.good!, 11_500, 5).length, 1);
      assertEquals(
        mark(d.tokens.bad!, 11_800, 1).length,
        1,
        "a lost frame is a red bar in its row",
      );
      assertEquals(mark(d.tokens.bad!, 9000, 4 * ROW + 1).length, 1, "c to a is the fifth row");
      assertEquals(
        d.rects.filter((r) => sameColor(r.fill, d.tokens.good!) && r.x < LABEL_WIDTH).length,
        0,
        "a frame from before the window was drawn",
      );
      for (
        const [color, t, text] of [[d.tokens.strong!, 8000, "move c"], [
          d.tokens.accent!,
          4000,
          "warm-up",
        ], [d.tokens.poor!, 10_000, "a→c 30%"]] as const
      ) {
        assertEquals(mark(color, t, 0).length, 1, `${text}: a line across every row`);
        assert(
          d.texts.some((tx) => tx.text === text && near(leftOf(tx), x(t) + 4)),
          `${text}: its label next to the line`,
        );
      }
      assertEquals(d.css.label, "Packet timeline, the last 10 s: 2 frames delivered, 2 lost.");
      assertEquals(
        d.texts.filter((t) => /^\d+ s$/.test(t.text)).length,
        11,
        "a tick for each second in view",
      );
      assertEquals(plotLeft(d), LABEL_WIDTH);
      assertEquals(d.texts.filter((t) => t.text.includes("→") && t.x <= 4).map((t) => t.text), [
        "a→b",
        "a→c",
        "b→a",
        "b→c",
        "c→a",
        "c→b",
      ]);
      assertEquals(timelineProblems(d, "main"), []);
      // The canvas is not blank: a delivered tick is on screen in the right color.
      const pixel = await page.eval<number[]>(
        `(() => { const c = document.getElementById("timeline"); const r = c.getContext("2d").getImageData(Math.round(${
          x(11_000)
        }), 8, 1, 1).data; return [...r]; })()`,
      );
      assert(pixel[3]! > 100 && pixel[1]! > pixel[0]!, `pixel at the green tick: ${pixel}`);

      // Before time zero there is nothing to place on the axis.
      const early = threeNodes();
      early.state = "starting";
      early.elapsed = null;
      const e = await draw(early, 1);
      assertEquals(e.css.label, "Packet timeline: the run has not reached time zero yet.");
      assertEquals(e.rects.filter((r) => r.h > 5 && r.w < 3).length, 0);

      // A packet between a pair the run has no budget for still gets its row.
      const extra = threeNodes();
      extra.elapsed = 12_000;
      extra.add(delivered(11_000, "x", "y"));
      const withExtra = await draw(extra, 7);
      assert(withExtra.texts.some((t) => t.text === "x→y"));

      // Long names, a move that has just happened, and two events at once.
      const crowded = new FakeSession().setNodes([["sensor-12", 0, 0], ["gateway-1", 8, 0]]);
      crowded.elapsed = 12_000;
      crowded.add({ type: "move", t: 11_990, node: "sensor-12", position: { x: 1, y: 0 } });
      crowded.add({ type: "phase", t: 11_900, label: "walked-away" });
      crowded.add({
        type: "link-override",
        t: 11_880,
        from: "sensor-12",
        to: "gateway-1",
        extraLossPct: 100,
        extraLatencyMs: 0,
      });
      assertEquals(timelineProblems(await draw(crowded, 2), "crowded"), []);
      assertEquals(page.errors, []);
    });
  },
});

// ── Nothing, one, ten, fifty ────────────────────────────────────────────────

function gridSession(count: number, columns: number, spacingM: number, prefix = "n"): FakeSession {
  return new FakeSession().setNodes(
    Array.from(
      { length: count },
      (_, i) =>
        [`${prefix}${i + 1}`, (i % columns) * spacingM, Math.floor(i / columns) * spacingM] as [
          string,
          number,
          number,
        ],
    ),
  );
}

const EMPTY_LINKS = {
  idle: "No run yet: links appear once a run starts.",
  oneNode: "No links: a link needs two nodes on the medium.",
  starting: "No links yet: the boards are still starting.",
};

Deno.test({
  name: "ui: the page holds together with no run, one node, ten and fifty, at every viewport",
  ignore: CHROMIUM === null,
  fn: async () => {
    await withPage(async (page) => {
      const cases: {
        name: string;
        session: FakeSession;
        nodes: number;
        links: number;
        empty: string | null;
        timelineRows: number;
      }[] = [
        {
          name: "no run",
          session: inState(new FakeSession(), "idle"),
          nodes: 0,
          links: 0,
          empty: EMPTY_LINKS.idle,
          timelineRows: 1,
        },
        {
          name: "starting",
          session: inState(threeNodes(), "starting"),
          nodes: 3,
          links: 0,
          empty: EMPTY_LINKS.starting,
          timelineRows: 1,
        },
        {
          name: "one node",
          session: new FakeSession().setNodes([["solo", 3, 4]]),
          nodes: 1,
          links: 0,
          empty: EMPTY_LINKS.oneNode,
          timelineRows: 1,
        },
        {
          name: "one node on the medium of two",
          session: (() => {
            const s = new FakeSession().setNodes([["a", 0, 0], ["gw", 5, 0]]);
            s.nodes[1]!.onMedium = false;
            return s;
          })(),
          nodes: 2,
          links: 0,
          empty: EMPTY_LINKS.oneNode,
          timelineRows: 1,
        },
        {
          name: "two nodes on the same spot",
          session: new FakeSession().setNodes([["a", 5, 5], ["b", 5, 5]]),
          nodes: 2,
          links: 2,
          empty: null,
          timelineRows: 2,
        },
        {
          name: "ten nodes",
          session: gridSession(10, 5, 6),
          nodes: 10,
          links: 90,
          empty: null,
          timelineRows: 90,
        },
        {
          name: "fifty nodes",
          session: gridSession(50, 10, 5),
          nodes: 50,
          links: 2450,
          empty: null,
          timelineRows: 2450,
        },
      ];
      const failures: string[] = [];
      for (const c of cases) {
        await serving(c.session, async (url) => {
          for (const { width, height } of VIEWPORTS) {
            const at = `${c.name} @${width}`;
            await page.viewport(width, height);
            const loaded = performance.now();
            await page.goto(url);
            await page.waitFor(
              `document.getElementById("state").dataset.state !== "connecting" && document.querySelectorAll(".node").length === ${c.nodes} && document.querySelectorAll("#links tr").length === ${c.links}`,
              `${at}: ${c.nodes} nodes and ${c.links} table rows`,
              20_000,
            );
            // The page answers input soon after: a frame is painted within a second even with 2450 links.
            const frame = await page.eval<number>(
              `new Promise((r) => { const t0 = performance.now(); requestAnimationFrame(() => r(performance.now() - t0)); })`,
            );
            if (frame > 1000) failures.push(`${at}: a frame took ${frame.toFixed(0)} ms`);
            if (performance.now() - loaded > 15_000) {
              failures.push(
                `${at}: took ${((performance.now() - loaded) / 1000).toFixed(1)} s to show`,
              );
            }
            const m = await page.eval<Json>(MEASURE);
            if (m.scrollWidth > m.clientWidth) {
              failures.push(
                `${at}: the document scrolls sideways (${m.scrollWidth} > ${m.clientWidth})`,
              );
            }
            for (const outside of m.outside) {
              failures.push(`${at}: ${outside[0]} sticks out of ${outside[1]}`);
            }
            for (const clipped of m.clippedText) failures.push(`${at}: ${clipped[0]} is clipped`);
            for (const text of m.textOutside) {
              failures.push(`${at}: the text of ${text[0]} runs ${text[2]} px past its pane`);
            }
            const empty = await page.eval<string | null>(
              `(() => { const e = document.getElementById("links-empty"); return e.hidden ? null : e.textContent; })()`,
            );
            if (empty !== c.empty) {
              failures.push(
                `${at}: the empty-links line is ${JSON.stringify(empty)}, wanted ${
                  JSON.stringify(c.empty)
                }`,
              );
            }
            for (const problem of labelProblems(await page.eval<Json>(LABEL_BOXES))) {
              failures.push(`${at}: ${problem}`);
            }
            // The timeline keeps one row per link, on a canvas the browser really paints.
            const canvasHeight = c.timelineRows * ROW + AXIS;
            const css = await page.eval<string>(`document.getElementById("timeline").style.height`);
            if (css !== `${canvasHeight}px`) {
              failures.push(`${at}: the timeline is ${css} tall, wanted ${canvasHeight}px`);
            }
            if (c.links > 0 && c.session.state === "running") {
              const painted = await page.eval<boolean>(
                `(() => { const c = document.getElementById("timeline"); const ctx = c.getContext("2d"); if (!ctx) return false; const d = ctx.getImageData(0, 0, Math.min(c.width, 80), Math.min(c.height, 40)).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true; return false; })()`,
              );
              if (!painted) {
                failures.push(`${at}: the timeline canvas of ${canvasHeight} px is blank`);
              }
            }
          }
        });
      }
      assertEquals(failures, []);
      assertEquals(page.errors, []);
    });
  },
});

// ── Text from the run: long, hostile, missing ───────────────────────────────

Deno.test({
  name: "ui: long names and markup in a run's text neither break the layout nor become markup",
  ignore: CHROMIUM === null,
  fn: async () => {
    const hostile = `<img src=x onerror="window.pwned=1">`;
    const session = new FakeSession().setNodes([
      [hostile, 0, 0],
      ["a-node-with-an-identifier-far-longer-than-any-board-name-would-be", 10, 0],
      ["short", 5, 8],
    ]);
    session.scenario = `scenario-${"long".repeat(40)}`;
    session.problems = [
      `${hostile} the link to ${"x".repeat(150)} is below the threshold`,
      "<script>window.pwned = 2</script>",
      "word ".repeat(80),
    ];
    session.state = "failed";
    session.error = `board ${"E".repeat(300)}: <b>did not start</b>`;
    await withPage(async (page) => {
      await serving(session, async (url) => {
        const failures: string[] = [];
        for (const { width, height } of VIEWPORTS) {
          await page.viewport(width, height);
          await page.goto(url);
          await page.waitFor(`document.querySelectorAll(".node").length === 3`, "three nodes");
          const at = `@${width}`;
          const m = await page.eval<Json>(MEASURE);
          if (m.scrollWidth > m.clientWidth) {
            failures.push(
              `${at}: the document scrolls sideways (${m.scrollWidth} > ${m.clientWidth})`,
            );
          }
          for (const outside of m.outside) {
            failures.push(`${at}: ${outside[0]} sticks out of ${outside[1]}`);
          }
          for (const clipped of m.clippedText) failures.push(`${at}: ${clipped[0]} is clipped`);
          for (const text of m.textOutside) {
            failures.push(`${at}: the text of ${text[0]} runs ${text[2]} px past its pane`);
          }
          for (const problem of labelProblems(await page.eval<Json>(LABEL_BOXES))) {
            failures.push(`${at}: ${problem}`);
          }
          // The full name stays reachable wherever it is cut short.
          const names = await page.eval<string[]>(
            `[...document.querySelectorAll(".node")].map((n) => n.getAttribute("aria-label"))`,
          );
          if (
            !names.some((n) =>
              n.startsWith("a-node-with-an-identifier-far-longer-than-any-board-name-would-be,")
            )
          ) failures.push(`${at}: the long name is gone from the labels`);
        }
        // Text stays text.
        assertEquals(await page.eval(`window.pwned`), undefined, "markup from the run executed");
        assertEquals(
          await page.eval(`document.querySelectorAll("img, script:not([src]), b").length`),
          0,
        );
        assertEquals(
          await page.eval(
            `[...document.querySelectorAll("#problems li")].map((l) => l.textContent)`,
          ),
          [session.error, ...session.problems],
        );
        assertEquals(
          await page.eval(`document.getElementById("run").textContent`),
          `${session.scenario} · run run-1`,
        );
        assertEquals(failures, []);
        assertEquals(page.errors, []);
      });
    });
  },
});

// ── The states of a run, as the person reads them ───────────────────────────

Deno.test({
  name:
    "ui: every state of a run reads in words, the connection can drop and come back, and a new run replaces the old",
  ignore: CHROMIUM === null,
  fn: async () => {
    await withPage(async (page) => {
      await page.viewport(1280, 800);
      const read = () =>
        page.eval<Json>(`({
          state: document.getElementById("state").textContent,
          data: document.getElementById("state").dataset.state,
          run: document.getElementById("run").textContent,
          clock: document.getElementById("clock").textContent,
          problems: [...document.querySelectorAll("#problems li")].map((l) => l.textContent),
          fine: document.getElementById("fineprint").textContent,
        })`);
      const expected: Record<(typeof STATES)[number], Json> = {
        "idle": {
          state: "idle: waiting for a run",
          data: "idle",
          run: "No run yet",
          clock: "",
          problems: [],
        },
        "starting": {
          state: "starting",
          data: "starting",
          run: "fake-scenario · run run-1",
          clock: "",
          problems: [],
        },
        "running": {
          state: "running",
          data: "running",
          run: "fake-scenario · run run-1",
          clock: "5.0 s of 60 s · seed 7",
          problems: [],
        },
        "finished-passed": {
          state: "finished, passed",
          data: "finished",
          run: "fake-scenario · run run-1",
          clock: "5.0 s of 60 s · seed 7",
          problems: [],
        },
        "finished-failed": {
          state: "finished, failed",
          data: "finished",
          run: "fake-scenario · run run-1",
          clock: "5.0 s of 60 s · seed 7",
          problems: [],
        },
        "failed": {
          state: "failed",
          data: "failed",
          run: "fake-scenario · run run-1",
          clock: "5.0 s of 60 s · seed 7",
          problems: ["board a: the worker did not start within 30 s"],
        },
        "stopped": {
          state: "stopped",
          data: "stopped",
          run: "fake-scenario · run run-1",
          clock: "5.0 s of 60 s · seed 7",
          problems: [],
        },
      };
      for (const state of STATES) {
        await serving(inState(threeNodes(), state), async (url) => {
          await page.goto(url);
          await page.waitFor(
            `document.getElementById("state").dataset.state === ${
              JSON.stringify(expected[state].data)
            }`,
            `the ${state} state`,
          );
          const shown = await read();
          for (const [key, value] of Object.entries(expected[state])) {
            assertEquals(shown[key], value, `${state}: ${key}`);
          }
          // The state is announced to assistive technology, not only colored.
          assertEquals(
            await page.eval(`document.getElementById("state").getAttribute("role")`),
            "status",
          );
          assertEquals(
            await page.eval(`document.getElementById("state").getAttribute("aria-live")`),
            "polite",
          );
          const plain = "Latency is modelled by the channel model, not measured on a guest clock.";
          assertEquals(
            shown.fine,
            state === "idle"
              ? plain
              : `${plain} Scripted boards are traffic generators, not firmware.`,
          );
        });
      }
      // The footnote names scripted boards only when there are some.
      await serving(
        new FakeSession().setNodes([["a", 0, 0, "esp32"], ["b", 8, 0, "esp32"]]),
        async (url) => {
          await page.goto(url);
          await page.waitFor(`document.querySelectorAll(".node").length === 2`, "two nodes");
          assertEquals(
            (await read()).fine,
            "Latency is modelled by the channel model, not measured on a guest clock.",
          );
          assertEquals(
            await page.eval(`document.querySelectorAll("#map image").length`),
            2,
            "an ESP32 is drawn with its board picture",
          );
        },
      );
      await serving(threeNodes(), async (url) => {
        await page.goto(url);
        await page.waitFor(`document.querySelectorAll(".node").length === 3`, "three nodes");
        assertEquals(
          (await read()).fine,
          "Latency is modelled by the channel model, not measured on a guest clock. Scripted boards are traffic generators, not firmware.",
        );
      });

      // The connection drops, says why, and recovers by itself.
      const session = threeNodes();
      await serving(session, async (url) => {
        await page.goto(url);
        await page.waitFor(
          `document.getElementById("state").dataset.state === "running"`,
          "running",
        );
        session.statusError = new Error("the engine is gone");
        const quiet = console.error;
        console.error = () => {}; // the server prints the stack of the error it turns into a 500
        try {
          await page.waitFor(
            `document.getElementById("state").dataset.state === "disconnected"`,
            "disconnected",
          );
          assertEquals((await read()).state, "disconnected: the server answered 500");
          assertEquals(
            await page.eval(`document.querySelectorAll(".node").length`),
            3,
            "the last picture stays while disconnected",
          );
          session.statusError = null;
        } finally {
          console.error = quiet;
        }
        await page.waitFor(
          `document.getElementById("state").dataset.state === "running"`,
          "recovery",
          9000,
        );
        // Answers the page cannot use are a lost connection too, with the reason.
        for (
          const [status, body, text] of [
            [403, "unknown host", "disconnected: the server answered 403"],
            [200, "{not json", /^disconnected: /],
            [404, "", "disconnected: the server answered 404"],
          ] as const
        ) {
          let on = true;
          const stop = await page.intercept("/api/view", () => (on ? { status, body } : null));
          await page.waitFor(
            `document.getElementById("state").dataset.state === "disconnected"`,
            `disconnected by ${status}`,
          );
          const shown = (await read()).state;
          if (typeof text === "string") assertEquals(shown, text);
          else assertMatch(shown, text);
          on = false;
          await stop();
          await page.waitFor(
            `document.getElementById("state").dataset.state === "running"`,
            "recovery",
            9000,
          );
        }
      });

      // A new run replaces the old one: its nodes, its timeline, its map.
      const first = new FakeSession().setNodes([["old-1", 0, 0], ["old-2", 40, 0]]);
      first.elapsed = 12_000;
      first.add(delivered(11_000, "old-1", "old-2"));
      await serving(first, async (url) => {
        await page.goto(url);
        await page.waitFor(
          `document.getElementById("timeline").getAttribute("aria-label").includes("1 frames delivered")`,
          "the first run's frame",
        );
        first.runId = "run-2";
        first.setNodes([["new-1", 0, 0], ["new-2", 4, 0], ["new-3", 2, 3]]);
        first.events_ = [];
        first.add(lost(11_500, "new-1", "new-2"));
        await page.waitFor(
          `document.getElementById("run").textContent.endsWith("run run-2") && document.querySelectorAll(".node").length === 3`,
          "the second run",
        );
        await page.waitFor(
          `document.getElementById("timeline").getAttribute("aria-label").includes("0 frames delivered, 1 lost")`,
          "the second run's frame",
        );
        assertEquals(
          await page.eval(
            `[...document.querySelectorAll(".node")].map((n) => n.getAttribute("aria-label").split(",")[0]).sort()`,
          ),
          ["new-1", "new-2", "new-3"],
        );
        // The map was rescaled to the new nodes: they fill it instead of huddling where the old run's 40 m span left them.
        const spread = await page.eval<number>(
          `(() => { const c = (${CENTRES.trim()}); return Math.abs(c["new-2"][0] - c["new-1"][0]); })()`,
        );
        assert(spread > 100, `4 m is ${spread} px apart on the new map`);
      });
      assertEquals(
        page.errors.filter((e) => !/Failed to load resource|ERR_|status of 5/.test(e)),
        [],
      );
    });
  },
});

Deno.test({
  name:
    "ui: on a real wifi run a drag, a fault and interference show on the cable, the table, the labels and the timeline",
  ignore: CHROMIUM === null,
  fn: async () => {
    await realRun(REAL_SCENARIOS.wifi!.yaml, async ({ session, url }) => {
      await withPage(async (page) => {
        await page.viewport(1280, 800);
        await page.goto(url);
        await page.waitFor(
          `document.querySelectorAll("#map line.link").length === 2`,
          "the two halves",
        );
        const budget = (from: string, to: string) =>
          session.linkBudgets(session.run!).find((l) => l.from === from && l.to === to)!.budget;
        const pageAgrees = async (from: string, to: string, why: string) => {
          const expected = bucketOf(budget(from, to));
          await page.waitFor(
            halfClasses(from, to, expected),
            `${from}->${to} to be ${expected} ${why}`,
            8000,
          );
        };
        const positionOf = (id: string) => {
          const status = session.status();
          if (status.state === "idle") throw new Error("the session has no run");
          return status.nodes.find((n) => n.id === id)!.position;
        };

        // A real drag with the mouse reaches the engine's node and the cable follows its new budget.
        const centres = await page.eval<Record<string, [number, number]>>(CENTRES);
        const metre = (centres.b![0] - centres.a![0]) / 5;
        const to: [number, number] = [centres.b![0] + 20 * metre, centres.b![1] - 4 * metre];
        await drag(page, centres.b!, to);
        await until(() => Math.abs(positionOf("b").x - 25) < 0.5, "the engine to see the drag");
        assert(Math.abs(positionOf("b").y - 4) < 0.5, JSON.stringify(positionOf("b")));
        await pageAgrees("a", "b", "after the drag");
        await pageAgrees("b", "a", "after the drag");
        assertEquals(budget("a", "b").distanceM > 20, true);
        assertEquals(await page.eval(`document.querySelectorAll("#links tr").length`), 2);

        // A forced fault: marked with a star on the label, named in the table and on the timeline.
        session.move("b", { x: 6, y: 0 }, null);
        await pageAgrees("a", "b", "back near");
        session.fault({
          from: "a",
          to: "b",
          extraLossPct: 100,
          extraLatencyMs: 20,
          extraJitterMs: 5,
        }, "fault");
        await page.waitFor(
          `[...document.querySelectorAll("#map text.link-label")].filter((t) => t.textContent.endsWith("*")).length === 1`,
          "one starred label",
          8000,
        );
        assertMatch(
          await page.eval<string>(
            `[...document.querySelectorAll("#map text.link-label")].find((t) => t.textContent.endsWith("*")).textContent`,
          ),
          /^-?\d+ dBm \*$/,
        );
        await page.waitFor(
          `[...document.querySelectorAll("#links tr")].some((r) => r.firstChild.textContent === "a → b forced 100% loss, 20 ms, up to 5 ms jitter")`,
          "the table to name the fault",
          8000,
        );
        assertEquals(
          await page.eval(
            `[...document.querySelectorAll("#links tr")].filter((r) => r.querySelector(".override")).length`,
          ),
          1,
        );
        await page.waitFor(
          `__canvas.texts.some((t) => t.text === "a→b 100%")`,
          "the fault on the timeline",
        );
        const tl = await page.eval<Drawn>(DRAWN);
        assert(
          tl.rects.some((r) => sameColor(r.fill, tl.tokens.poor!) && r.h >= 2 * ROW),
          "a line across the rows for the fault",
        );
        // In loss mode the cable turns bad as the frames it loses fill the 2 s window; the other direction stays good.
        await page.eval(`document.querySelector('input[value="loss"]').click()`);
        await page.waitFor(halfClasses("a", "b", "bad"), "a->b to be bad in loss mode", 10_000);
        await page.waitFor(halfClasses("b", "a", "good"), "b->a to stay good in loss mode", 10_000);
        assertEquals(
          await page.eval(
            `[...document.querySelectorAll("#links tr")].find((r) => r.firstChild.textContent.startsWith("a → b")).querySelector(".quality").textContent`,
          ),
          "bad",
        );
        // The window fills as time passes: 50% when the cable turns bad, 100% once every frame in it was forced out.
        await page.waitFor(
          `[...document.querySelectorAll("#links tr")].find((r) => r.firstChild.textContent.startsWith("a → b")).children[4].textContent === "100.0%"`,
          "all of the window lost",
          10_000,
        );
        await page.eval(`document.querySelector('input[value="signal"]').click()`);

        // Interference lowers the SNR of one direction: the cable follows the model's own bucket.
        session.fault({
          from: "b",
          to: "a",
          extraLossPct: 0,
          extraLatencyMs: 0,
          interferenceDb: 45,
        }, null);
        const noisy = budget("b", "a");
        assert(
          noisy.snrDb < budget("a", "b").snrDb - 20,
          `interference left the SNR at ${noisy.snrDb}`,
        );
        await pageAgrees("b", "a", "under interference");
        assertNotEquals(bucketOf(noisy), "good");

        // Clearing both removes the marks, and the loss window refills with delivered frames.
        session.fault({ from: "a", to: "b", extraLossPct: 0, extraLatencyMs: 0 }, null);
        session.fault({ from: "b", to: "a", extraLossPct: 0, extraLatencyMs: 0 }, null);
        await page.waitFor(
          `document.querySelectorAll("#map text.link-label").length === 2 && ![...document.querySelectorAll("#map text.link-label")].some((t) => t.textContent.endsWith("*"))`,
          "the stars to go",
          8000,
        );
        await page.waitFor(
          `document.querySelectorAll("#links .override").length === 0`,
          "the table to forget the fault",
          8000,
        );
        await page.eval(`document.querySelector('input[value="loss"]').click()`);
        await page.waitFor(halfClasses("a", "b", "good"), "a->b to recover in loss mode", 12_000);
        assertEquals(page.errors, []);
      });
    });
  },
});

// ── Contrast of lines and marks ─────────────────────────────────────────────

/** Every line, mark and swatch that carries meaning, with the surface behind it. */
const GRAPHICS = String.raw`(() => {
  const t = window.__hzb;
  const items = [];
  const add = (what, el, prop, behind, pseudo) => {
    let opacity = 1;
    for (let a = el; a; a = a.parentElement) opacity *= Number(getComputedStyle(a).opacity);
    items.push({ what, color: t.parseColor(getComputedStyle(el, pseudo)[prop]), opacity, chain: t.backdrop(behind, true).chain });
  };
  const map = document.getElementById("map");
  for (const el of document.querySelectorAll("#map line.link")) add("link " + el.getAttribute("class"), el, "stroke", map);
  for (const el of document.querySelectorAll("#map line.wall")) add("wall", el, "stroke", map);
  for (const el of document.querySelectorAll("#map line.scale-bar")) add("scale bar", el, "stroke", map);
  for (const el of document.querySelectorAll("#map circle.node-dot")) {
    add("node dot fill", el, "fill", map);
    add("node dot outline", el, "stroke", map);
  }
  for (const el of document.querySelectorAll("#legend .swatch")) add("legend " + el.className, el, "backgroundColor", el.closest("li"));
  for (const el of document.querySelectorAll("#links .quality")) add("table dot " + el.className, el, "backgroundColor", el.closest("tr"), "::before");
  for (const el of document.querySelectorAll(".legend-inline .mark")) add("timeline legend " + el.className, el, "backgroundColor", el.closest("li"));
  return items;
})()`;

Deno.test({
  name:
    "ui: every line, mark and swatch that carries meaning keeps 3:1 against what is behind it, in both themes",
  ignore: CHROMIUM === null,
  fn: async () => {
    await withPage(async (page) => {
      await page.viewport(1280, 800);
      const failures: string[] = [];
      let measured = 0;
      for (const theme of THEMES) {
        await page.scheme(theme);
        await serving(richSession(), async (url) => {
          await page.goto(url);
          await page.waitFor(`document.querySelectorAll(".node").length === 4`, "the nodes");
          for (const mode of ["signal", "loss"]) {
            await page.eval(`document.querySelector('input[value="${mode}"]').click()`);
            for (
              const g of await page.eval<
                { what: string; color: Rgba; opacity: number; chain: Rgba[] }[]
              >(GRAPHICS)
            ) {
              measured++;
              const back = flatten(g.chain);
              const ratio = contrast(over(g.color, back, g.opacity), back);
              if (ratio < 3) {
                failures.push(`${theme}/${mode}: ${g.what} is ${ratio.toFixed(2)}:1, needs 3:1`);
              }
            }
          }
          // The focus ring of a node, and the marks of the timeline, on the surfaces they are drawn on.
          await page.key("Tab", 9);
          const ring = await page.eval<Json>(`(() => {
            const r = getComputedStyle(document.activeElement.querySelector("circle.node-ring"));
            return { color: __hzb.parseColor(r.stroke), chain: __hzb.backdrop(document.getElementById("map"), true).chain };
          })()`);
          const ringRatio = contrast(ring.color, flatten(ring.chain));
          if (ringRatio < 3) {
            failures.push(`${theme}: the focus ring is ${ringRatio.toFixed(2)}:1, needs 3:1`);
          }
          const drawn = await page.eval<Drawn>(DRAWN);
          const canvasBack = flatten(
            await page.eval<Rgba[]>(
              `__hzb.backdrop(document.getElementById("timeline"), true).chain`,
            ),
          );
          for (const [name, color] of Object.entries(drawn.tokens)) {
            const needed = name === "muted" ? 4.5 : 3; // muted is the text of the rows and the seconds
            const ratio = contrast(color, canvasBack);
            if (ratio < needed) {
              failures.push(
                `${theme}: the timeline's ${name} is ${ratio.toFixed(2)}:1, needs ${needed}:1`,
              );
            }
          }
        });
      }
      assert(measured > 150, `only ${measured} graphics were measured`);
      assertEquals([...new Set(failures)], []);
    });
  },
});
