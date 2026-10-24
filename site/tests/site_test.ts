// The landing page in headless Chromium, driven over the DevTools protocol:
// the download section's OS detection and release states, layout at four
// widths, WCAG AA contrast in both color schemes, and keyboard focus.
//
// The page never reaches the real GitHub API: every request that is not for
// the local static server is intercepted, and the API's answer is a fixture.
// Run from site/: `deno task test`. Set HERTZBENCH_CHROMIUM to point at a
// browser; without one the test is skipped, except when CI is set.
//
// deno-lint-ignore-file no-explicit-any -- DevTools payloads are untyped JSON.
// The Cdp class is copied from hertzbench/tests/view_browser_test.ts (that
// folder is not ours to import from) with event listeners added.

import { assert, assertEquals } from "@std/assert";

const SITE = new URL("../", import.meta.url).pathname;
const CI = Boolean(Deno.env.get("CI"));

function findChromium(): string | null {
  const candidates = [
    Deno.env.get("HERTZBENCH_CHROMIUM"),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
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
if (CI && !CHROMIUM) throw new Error("CI is set but no Chromium or Chrome was found");

/** Reads a child's stderr as it comes, so a test can wait for a line on it. */
class StderrWatch {
  text = "";
  readonly done: Promise<void>;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.done = (async () => {
      for await (const chunk of stream.pipeThrough(new TextDecoderStream())) this.text += chunk;
    })();
  }

  async waitFor(pattern: RegExp, timeoutMs = 20_000): Promise<RegExpMatchArray> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const match = this.text.match(pattern);
      if (match) return match;
      if (performance.now() > deadline) {
        throw new Error(`timed out waiting for ${pattern}:\n${this.text}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

type Listener = (params: Record<string, any>, sessionId?: string) => void;

/** The DevTools protocol over one WebSocket, flat sessions. */
class Cdp {
  readonly #socket: WebSocket;
  readonly #waiting = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  readonly #listeners = new Map<string, Listener[]>();
  #nextId = 1;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.onmessage = (message) => {
      const data = JSON.parse(String(message.data));
      if (data.id === undefined) {
        for (const listener of this.#listeners.get(data.method) ?? []) {
          listener(data.params, data.sessionId);
        }
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

  on(method: string, listener: Listener): void {
    this.#listeners.set(method, [...(this.#listeners.get(method) ?? []), listener]);
  }

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

// ---- A static server for site/ -------------------------------------------------------------

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
};

function serveSite(): { origin: string; ready: Promise<void>; stop: () => Promise<void> } {
  let origin = "";
  const ready = Promise.withResolvers<void>();
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => {
      origin = `http://127.0.0.1:${port}`;
      ready.resolve();
    },
  }, async (request) => {
    const path = new URL(request.url).pathname;
    const name = path === "/" ? "index.html" : path.slice(1);
    const ext = name.split(".").pop() ?? "";
    if (name.includes("/") || name.includes("..") || !(ext in MIME) || name.startsWith("deno")) {
      return new Response("not found", { status: 404 });
    }
    try {
      return new Response(await Deno.readFile(`${SITE}${name}`), {
        headers: { "content-type": MIME[ext]! },
      });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return new Response("not found", { status: 404 });
      throw error;
    }
  });
  return {
    get origin() {
      return origin;
    },
    stop: () => server.shutdown(),
    ready: ready.promise,
  };
}

// ---- Fixtures for the GitHub API (hypothetical asset names, see download.js) ----------------

const BASE = "https://github.com/Rixmerz/hertzbench/releases/download/v0.0.0-fixture/";
interface Asset {
  name: string;
  size: number;
  browser_download_url: string;
}
const asset = (name: string, url = BASE + name): Asset => ({
  name,
  size: 5_242_880,
  browser_download_url: url,
});
const release = (assets: Asset[], extra: Record<string, unknown> = {}) => ({
  tag_name: "v0.0.0-fixture",
  published_at: "2026-01-02T03:04:05Z",
  html_url: "https://github.com/Rixmerz/hertzbench/releases/tag/v0.0.0-fixture",
  assets,
  ...extra,
});

const NAMES = {
  "windows-x64": "hertzbench-x86_64-pc-windows-msvc.zip",
  "windows-arm64": "hertzbench-aarch64-pc-windows-msvc.zip",
  "macos-x64": "hertzbench-x86_64-apple-darwin.tar.gz",
  "macos-arm64": "hertzbench-aarch64-apple-darwin.tar.gz",
  "linux-x64": "hertzbench-x86_64-unknown-linux-gnu.tar.gz",
  "linux-arm64": "hertzbench-aarch64-unknown-linux-gnu.tar.gz",
} as const;

// A checksum comes before every build: the page must skip it, not link it.
const ALL = release(
  Object.values(NAMES).flatMap((name) => [asset(`${name}.sha256`), asset(name)]),
);
const LONG_NAME = "hertzbench-" + "very-long-asset-name-".repeat(6) +
  "x86_64-unknown-linux-gnu.tar.gz";
const ALL_WITH_LONG = release([
  ...ALL.assets.filter((a) => !a.name.includes("x86_64-unknown-linux-gnu")),
  asset(LONG_NAME),
]);
const LINUX_ONLY = release([asset(NAMES["linux-x64"])]);
const HOSTILE = release(
  [
    asset("hertzbench-linux-x64", "https://evil.example/hertzbench-linux-x64"),
    asset("hertzbench-windows-x64.exe", "javascript:alert(1)"),
    asset("hertzbench-macos-arm64", "https://github.com.evil.example/releases/download/x"),
  ],
  { html_url: "https://evil.example/" },
);

type Api = { status: number; body?: unknown } | "unreachable";

// ---- Systems to detect -----------------------------------------------------------------------

const CHROME = "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
interface System {
  label: string;
  ua: string;
  hints?: { platform: string; architecture: string; bitness: string; mobile?: boolean };
  os: string;
  arch: string;
  detected: string[];
}

const SYSTEMS: System[] = [
  {
    label: "Windows x64",
    ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${CHROME}`,
    hints: { platform: "Windows", architecture: "x86", bitness: "64" },
    os: "windows",
    arch: "x64",
    detected: ["windows-x64"],
  },
  {
    // The user agent still says x64 on Windows for Arm; the client hint wins.
    label: "Windows arm64 (hint beats the user agent string)",
    ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${CHROME}`,
    hints: { platform: "Windows", architecture: "arm", bitness: "64" },
    os: "windows",
    arch: "arm64",
    detected: ["windows-arm64"],
  },
  {
    label: "macOS arm64",
    ua: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${CHROME}`,
    hints: { platform: "macOS", architecture: "arm", bitness: "64" },
    os: "macos",
    arch: "arm64",
    detected: ["macos-arm64"],
  },
  {
    // Safari and Firefox reveal no architecture and report Intel on Apple silicon:
    // both Mac rows are marked rather than guessing.
    label: "macOS without hints",
    ua:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    os: "macos",
    arch: "",
    detected: ["macos-x64", "macos-arm64"],
  },
  {
    label: "Linux x64",
    ua: `Mozilla/5.0 (X11; Linux x86_64) ${CHROME}`,
    hints: { platform: "Linux", architecture: "x86", bitness: "64" },
    os: "linux",
    arch: "x64",
    detected: ["linux-x64"],
  },
  {
    label: "Linux arm64",
    ua: `Mozilla/5.0 (X11; Linux aarch64) ${CHROME}`,
    hints: { platform: "Linux", architecture: "arm", bitness: "64" },
    os: "linux",
    arch: "arm64",
    detected: ["linux-arm64"],
  },
  {
    label: "Android (no desktop build)",
    ua: `Mozilla/5.0 (Linux; Android 14; Pixel 8) ${CHROME} Mobile`,
    hints: { platform: "Android", architecture: "", bitness: "", mobile: true },
    os: "",
    arch: "",
    detected: [],
  },
];

// ---- A page in the browser ---------------------------------------------------------------

interface PageOptions {
  width?: number;
  height?: number;
  scheme?: "light" | "dark";
  system?: System;
  api?: Api;
}

class Page {
  readonly external: string[] = [];
  readonly exceptions: string[] = [];

  constructor(
    private readonly cdp: Cdp,
    private readonly sessionId: string,
    private readonly targetId: string,
  ) {}

  send(method: string, params: Record<string, unknown> = {}) {
    return this.cdp.send(method, params, this.sessionId);
  }

  async evaluate<T = any>(expression: string): Promise<T> {
    const answer = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (answer.exceptionDetails) throw new Error(JSON.stringify(answer.exceptionDetails));
    return answer.result.value;
  }

  async waitFor(expression: string, timeoutMs = 10_000): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (!(await this.evaluate(expression))) {
      if (performance.now() > deadline) throw new Error(`timed out waiting for ${expression}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async key(key: string, code: string, keyCode: number) {
    const event = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
  }

  async close() {
    await this.cdp.send("Target.closeTarget", { targetId: this.targetId });
  }
}

async function openPage(
  cdp: Cdp,
  origin: string,
  options: PageOptions = {},
): Promise<Page> {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = new Page(cdp, sessionId, targetId);
  const api: Api = options.api ?? { status: 200, body: ALL };

  cdp.on("Runtime.exceptionThrown", (params, session) => {
    if (session === sessionId) page.exceptions.push(JSON.stringify(params.exceptionDetails));
  });
  cdp.on("Fetch.requestPaused", (params, session) => {
    if (session !== sessionId) return;
    const url: string = params.request.url;
    const id = params.requestId;
    if (url.startsWith(origin)) {
      page.send("Fetch.continueRequest", { requestId: id });
    } else if (url.startsWith("https://api.github.com/repos/Rixmerz/hertzbench/releases/latest")) {
      if (api === "unreachable") {
        page.send("Fetch.failRequest", { requestId: id, errorReason: "InternetDisconnected" });
      } else {
        page.send("Fetch.fulfillRequest", {
          requestId: id,
          responseCode: api.status,
          responseHeaders: [
            { name: "Content-Type", value: "application/json" },
            { name: "Access-Control-Allow-Origin", value: "*" },
          ],
          body: btoa(JSON.stringify(api.body ?? { message: "fixture" })),
        });
      }
    } else {
      page.external.push(url);
      page.send("Fetch.failRequest", { requestId: id, errorReason: "BlockedByClient" });
    }
  });

  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.send("Emulation.setEmulatedMedia", {
    // Reduced motion also turns off the page's smooth scrolling, which would still be
    // moving a focused control into view when the test reads where it is.
    features: [
      { name: "prefers-color-scheme", value: options.scheme ?? "light" },
      { name: "prefers-reduced-motion", value: "reduce" },
    ],
  });
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: options.width ?? 1280,
    height: options.height ?? 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  if (options.system) {
    const { ua, hints } = options.system;
    await page.send("Emulation.setUserAgentOverride", {
      userAgent: ua,
      ...(hints
        ? {
          userAgentMetadata: {
            platform: hints.platform,
            platformVersion: "10.0.0",
            architecture: hints.architecture,
            bitness: hints.bitness,
            model: "",
            mobile: hints.mobile ?? false,
            brands: [{ brand: "Chromium", version: "120" }],
            fullVersionList: [{ brand: "Chromium", version: "120.0.0.0" }],
          },
        }
        : {}),
    });
  }
  await page.send("Page.navigate", { url: `${origin}/` });
  await page.waitFor(
    `document.readyState === "complete" && !["idle", "loading"].includes(
      document.getElementById("release-status")?.dataset.state ?? "idle")`,
  );
  return page;
}

// ---- Measurements run inside the page ----------------------------------------------------

const LAYOUT_SCRIPT = `(() => {
  const vw = document.documentElement.clientWidth;
  const scroller = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const o = getComputedStyle(n).overflowX;
      if ((o === "auto" || o === "scroll") && n.scrollWidth > n.clientWidth) return n;
    }
    return null;
  };
  const boxes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node; (node = walker.nextNode());) {
    if (!node.nodeValue.trim()) continue;
    const el = node.parentElement;
    if (getComputedStyle(el).visibility === "hidden") continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1 || r.bottom <= 0) continue;
      boxes.push({ el, r, clipped: scroller(el) !== null });
    }
  }
  const name = (el) => el.tagName.toLowerCase() + (el.className ? "." + el.className : "") +
    ' "' + el.textContent.trim().slice(0, 30) + '"';
  const outside = boxes
    .filter((b) => !b.clipped && (b.r.right > vw + 0.5 || b.r.left < -0.5))
    .map((b) => name(b.el) + " " + Math.round(b.r.left) + ".." + Math.round(b.r.right));
  const overlaps = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.clipped || b.clipped || a.el === b.el) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w > 2 && h > 2) overlaps.push(name(a.el) + " x " + name(b.el));
    }
  }
  const root = document.documentElement;
  return {
    viewport: innerWidth, client: root.clientWidth, scroll: root.scrollWidth,
    bodyScroll: document.body.scrollWidth, texts: boxes.length, outside, overlaps,
  };
})()`;

const CONTRAST_SCRIPT = `(() => {
  for (const d of document.querySelectorAll("details")) d.open = true;
  const parse = (css) => {
    const m = css.match(/rgba?\\(([^)]+)\\)/);
    if (!m) throw new Error("unsupported color " + css);
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (top, under) => ({
    r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a),
    b: top.b * top.a + under.b * (1 - top.a), a: 1,
  });
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const background = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage !== "none") throw new Error("background image on " + n.tagName);
      layers.push(parse(cs.backgroundColor));
      if (layers.at(-1).a === 1) break;
    }
    let out = layers.at(-1).a === 1 ? layers.pop() : { r: 255, g: 255, b: 255, a: 1 };
    while (layers.length) out = over(layers.pop(), out);
    return out;
  };
  const label = (el) => el.tagName.toLowerCase() + (el.className && el.className.baseVal === undefined
    ? "." + el.className : "") + ' "' + el.textContent.trim().slice(0, 30) + '"';
  const failures = [];
  let checked = 0, lowest = Infinity;
  const check = (what, fg, bg, need) => {
    const value = ratio(fg, bg);
    checked++;
    lowest = Math.min(lowest, value / need);
    if (value < need) failures.push(what + " " + value.toFixed(2) + " < " + need);
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let node; (node = walker.nextNode());) {
    const el = node.parentElement;
    if (!node.nodeValue.trim() || seen.has(el)) continue;
    seen.add(el);
    const range = document.createRange();
    range.selectNodeContents(node);
    if (!range.getClientRects().length) continue;
    const cs = getComputedStyle(el);
    if (Number(cs.opacity) !== 1) failures.push(label(el) + " has opacity");
    const svg = el.closest("svg");
    const fg = svg ? parse(cs.fill) : parse(cs.color);
    const bed = svg ? parse(getComputedStyle(svg.querySelector("rect")).fill) : null;
    const bg = bed ?? background(el);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    check(label(el), over(fg, bg), bg, large ? 3 : 4.5);
  }
  // Marks and lines that carry meaning need 3:1: the map's links, nodes and wall,
  // the focus ring, and the border of the detected system.
  const svg = document.querySelector(".hero-art svg");
  const bed = parse(getComputedStyle(svg.querySelector("rect")).fill);
  for (const el of svg.querySelectorAll(".art-link, .art-wall, .art-node circle")) {
    check("svg " + label(el), parse(getComputedStyle(el).stroke), bed, 3);
  }
  const vars = getComputedStyle(document.documentElement);
  const token = (name) => {
    const probe = document.createElement("i");
    probe.style.color = "var(" + name + ")";
    document.body.append(probe);
    const c = parse(getComputedStyle(probe).color);
    probe.remove();
    return c;
  };
  for (const surface of ["--canvas", "--surface", "--panel"]) {
    check("focus ring on " + surface, token("--focus"), token(surface), 3);
    check("link border on " + surface, token("--link"), token(surface), 3);
  }
  return { checked, lowestMargin: Number(lowest.toFixed(2)), failures };
})()`;

const FOCUSABLE =
  `[...document.querySelectorAll('a[href], summary, button, input, select, textarea, [tabindex="0"]')]
  .filter((el) => el.getClientRects().length > 0)`;

// ---- The test -----------------------------------------------------------------------------

Deno.test({
  name: "site: download detection, release states, layout, contrast and keyboard",
  ignore: CHROMIUM === null,
  fn: async (t) => {
    const dir = await Deno.makeTempDir({ prefix: "hzb-site-" });
    const server = serveSite();
    await server.ready;
    const origin = server.origin;
    const browser = new Deno.Command(CHROMIUM!, {
      args: [
        "--headless=new",
        "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${dir}/profile`,
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1280,900",
        ...(CI ? ["--no-sandbox"] : []),
        "about:blank",
      ],
      stdout: "null",
      stderr: "piped",
    }).spawn();
    const browserLog = new StderrWatch(browser.stderr);
    let cdp: Cdp | null = null;
    try {
      const [, devtools] = await browserLog.waitFor(/DevTools listening on (ws:\/\/\S+)/);
      cdp = await Cdp.connect(devtools!);
      const open = (options: PageOptions = {}) => openPage(cdp!, origin, options);

      /** Closes the page after `body`, whatever it asserts, and checks it stayed local. */
      const withPage = async (options: PageOptions, body: (page: Page) => Promise<void>) => {
        const page = await open(options);
        try {
          await body(page);
          assertEquals(page.external, [], "the page requested something off the local server");
          assertEquals(page.exceptions, [], "the page threw");
        } finally {
          await page.close();
        }
      };

      const rows = `[...document.querySelectorAll("#downloads li")].map((li) => ({
        key: li.dataset.key, detected: li.dataset.detected === "true",
        text: li.querySelector(".build-action").textContent.trim(),
        href: li.querySelector(".build-action a")?.href ?? null }))`;

      for (const system of SYSTEMS) {
        await t.step(`detects ${system.label}`, () =>
          withPage({ system }, async (page) => {
            const list = await page.evaluate(
              `({ os: downloads.dataset.os, arch: downloads.dataset.arch })`,
            );
            assertEquals(list, { os: system.os, arch: system.arch });
            const found = await page.evaluate<{ key: string; detected: boolean; href: string }[]>(
              rows,
            );
            assertEquals(found.length, 6, "every platform stays listed");
            assertEquals(found.filter((r) => r.detected).map((r) => r.key), system.detected);
            for (const row of found) {
              assertEquals(row.href, BASE + NAMES[row.key as keyof typeof NAMES]);
            }
            // The install block of the detected system is open; the others fold away.
            const open = await page.evaluate<Record<string, boolean>>(
              `Object.fromEntries([...document.querySelectorAll("details.os")].map((d) => [d.id, d.open]))`,
            );
            for (const name of ["linux", "macos", "windows"]) {
              assertEquals(open[`os-${name}`], system.os === "" || system.os === name, name);
            }
            const status = await page.evaluate<string>(
              `document.getElementById("release-status").textContent`,
            );
            assert(status.includes("v0.0.0-fixture, published 2026-01-02"), status);
          }));
      }

      await t.step("classifies asset names", () =>
        withPage({}, async (page) => {
          const cases: [string, unknown][] = [
            ["hertzbench-windows-x64.exe", { os: "windows", arch: "x64" }],
            ["hertzbench-v1-x86_64-pc-windows-msvc.zip", { os: "windows", arch: "x64" }],
            ["hertzbench-v1-aarch64-pc-windows-msvc.zip", { os: "windows", arch: "arm64" }],
            ["hertzbench-macos-arm64", { os: "macos", arch: "arm64" }],
            ["hertzbench-v1-x86_64-apple-darwin.tar.gz", { os: "macos", arch: "x64" }],
            ["hertzbench-v1-universal-apple-darwin.tar.gz", { os: "macos", arch: null }],
            ["hertzbench-linux-amd64.deb", { os: "linux", arch: "x64" }],
            ["hertzbench-v1-aarch64-unknown-linux-gnu.tar.gz", { os: "linux", arch: "arm64" }],
            ["hertzbench-v1-x86_64-unknown-linux-gnu.tar.gz.sha256", null],
            ["checksums.txt", null],
            ["SHA256SUMS", null],
            ["hertzbench-linux-x64.sig", null],
            ["source.tar.gz", null],
          ];
          const got = await page.evaluate<unknown[]>(
            `${JSON.stringify(cases.map(([name]) => name))}.map((n) => hertzbenchSite.classify(n))`,
          );
          assertEquals(got, cases.map(([, expected]) => expected));
        }));

      await t.step(
        "no release published: says so and keeps the releases link",
        () =>
          withPage({ api: { status: 404, body: { message: "Not Found" } } }, async (page) => {
            const state = await page.evaluate<{ state: string; text: string; links: string[] }>(
              `({ state: document.getElementById("release-status").dataset.state,
               text: document.getElementById("release-status").textContent,
               links: [...document.querySelectorAll("#download a")].map((a) => a.href) })`,
            );
            assertEquals(state.state, "none");
            assert(state.text.includes("No release is published yet"), state.text);
            assert(state.links.includes("https://github.com/Rixmerz/hertzbench/releases"));
            assert(!state.links.some((href) => href.includes("/download/")));
            const found = await page.evaluate<{ text: string }[]>(rows);
            assertEquals(new Set(found.map((r) => r.text)), new Set(["No build published"]));
          }),
      );

      await t.step(
        "GitHub unreachable: falls back to the releases page",
        () =>
          withPage({ api: "unreachable" }, async (page) => {
            const state = await page.evaluate<{ state: string; text: string; href: string }>(
              `({ state: document.getElementById("release-status").dataset.state,
               text: document.getElementById("release-status").textContent,
               href: document.querySelector("#release-status a").href })`,
            );
            assertEquals(state.state, "error");
            assert(state.text.includes("Could not reach the GitHub API"), state.text);
            assertEquals(state.href, "https://github.com/Rixmerz/hertzbench/releases");
            // The rows keep their static link to the releases page.
            const found = await page.evaluate<{ href: string }[]>(rows);
            for (const row of found) {
              assertEquals(row.href, "https://github.com/Rixmerz/hertzbench/releases");
            }
          }),
      );

      await t.step(
        "rate limited: names the status, falls back",
        () =>
          withPage(
            { api: { status: 403, body: { message: "rate limit exceeded" } } },
            async (page) => {
              const text = await page.evaluate<string>(
                `document.getElementById("release-status").textContent`,
              );
              assert(text.includes("status 403"), text);
              assert(!text.includes("rate limit exceeded"), "the API's own words are not shown");
            },
          ),
      );

      await t.step(
        "a release with one build: the other platforms say so",
        () =>
          withPage({ api: { status: 200, body: LINUX_ONLY } }, async (page) => {
            const found = await page.evaluate<{ key: string; text: string; href: string | null }[]>(
              rows,
            );
            for (const row of found) {
              if (row.key === "linux-x64") assertEquals(row.href, BASE + NAMES["linux-x64"]);
              else {
                assertEquals(row.href, null, row.key);
                assertEquals(row.text, "Not in this release");
              }
            }
            // linux-arm64 must not pick up the x64 build.
            assertEquals(found.find((r) => r.key === "linux-arm64")!.href, null);
          }),
      );

      await t.step(
        "links off GitHub's release hosting are refused",
        () =>
          withPage({ api: { status: 200, body: HOSTILE } }, async (page) => {
            const found = await page.evaluate<{ href: string | null }[]>(rows);
            for (const row of found) assertEquals(row.href, null);
            const state = await page.evaluate<{ state: string; href: string }>(
              `({ state: document.getElementById("release-status").dataset.state,
               href: document.querySelector("#release-status a").href })`,
            );
            assertEquals(state.state, "empty");
            assertEquals(state.href, "https://github.com/Rixmerz/hertzbench/releases");
          }),
      );

      for (const width of [360, 768, 1280, 1920]) {
        await t.step(
          `layout at ${width}px: no sideways scroll, nothing outside, no overlap`,
          () =>
            withPage({ width, api: { status: 200, body: ALL_WITH_LONG } }, async (page) => {
              // A 120-character asset name with no spaces is the too-long case.
              await page.evaluate(
                `document.querySelectorAll("details").forEach((d) => (d.open = true))`,
              );
              const layout = await page.evaluate<any>(LAYOUT_SCRIPT);
              assert(layout.texts > 100, `measured only ${layout.texts} text boxes`);
              assert(
                layout.scroll <= layout.client,
                `page scrolls sideways: ${JSON.stringify(layout)}`,
              );
              assert(
                layout.bodyScroll <= layout.client,
                `body wider than the page: ${layout.bodyScroll}`,
              );
              assertEquals(layout.outside, []);
              assertEquals(layout.overlaps, []);
              const long = await page.evaluate<boolean>(
                `[...document.querySelectorAll("#downloads a")].some((a) => a.textContent === ${
                  JSON.stringify(LONG_NAME)
                })`,
              );
              assert(long, "the long asset name is on the page whole");
            }),
        );
      }

      await t.step(
        "the figure's text description matches the drawing",
        () =>
          withPage({}, async (page) => {
            // Which links cross the wall, from the SVG's own coordinates.
            const figure = await page.evaluate<
              { desc: string; links: { pair: string; crosses: boolean }[] }
            >(`(() => {
            const num = (el, name) => Number(el.getAttribute(name));
            const wall = document.querySelector(".art-wall");
            const x = num(wall, "x1");
            if (x !== num(wall, "x2")) throw new Error("the wall is no longer vertical");
            const [lo, hi] = [num(wall, "y1"), num(wall, "y2")].sort((a, b) => a - b);
            const nodes = [...document.querySelectorAll(".art-node")].map((g) => ({
              name: g.querySelector("text").textContent.trim(),
              x: num(g.querySelector("circle"), "cx"), y: num(g.querySelector("circle"), "cy") }));
            const at = (px, py) => nodes.find((n) => n.x === px && n.y === py).name;
            const links = [...document.querySelectorAll(".art-link")].map((l) => {
              const [ax, ay, bx, by] = ["x1", "y1", "x2", "y2"].map((n) => num(l, n));
              const crosses = (ax - x) * (bx - x) < 0 &&
                (y => y >= lo && y <= hi)(ay + (by - ay) * (x - ax) / (bx - ax));
              return { pair: [at(ax, ay), at(bx, by)].sort().join(""), crosses };
            });
            return { desc: document.getElementById("art-desc").textContent.replace(/\\s+/g, " "), links };
          })()`);
            assertEquals(figure.links.length, 3);
            for (const { pair, crosses } of figure.links) {
              const sentence = figure.desc.split(/\.\s*/).find((part) =>
                part.startsWith(`Node ${pair[0]} and node ${pair[1]} `)
              );
              assert(sentence, `the description says nothing about ${pair}: ${figure.desc}`);
              assertEquals(
                /cross/.test(sentence),
                crosses,
                `${pair} ${crosses ? "crosses" : "does not cross"} the wall: "${sentence}"`,
              );
            }
          }),
      );

      const states: [string, Api][] = [
        ["builds listed", { status: 200, body: ALL }],
        ["no release", { status: 404, body: {} }],
        ["unreachable", "unreachable"],
        ["release without builds", { status: 200, body: HOSTILE }],
      ];
      for (const scheme of ["light", "dark"] as const) {
        for (const [state, api] of states) {
          await t.step(
            `contrast, ${scheme} scheme, ${state}`,
            () =>
              withPage({ scheme, api, system: SYSTEMS[4] }, async (page) => {
                const dark = await page.evaluate<boolean>(
                  `matchMedia("(prefers-color-scheme: dark)").matches`,
                );
                assertEquals(dark, scheme === "dark");
                const result = await page.evaluate<any>(CONTRAST_SCRIPT);
                assert(result.checked > 90, `checked only ${result.checked} pairs`);
                assertEquals(result.failures, []);
              }),
          );
        }
      }

      await t.step(
        "keyboard: Tab reaches every control in order, each with a visible ring",
        () =>
          withPage({ system: SYSTEMS[6] }, async (page) => {
            // The unknown system leaves every install block open, so every control is reachable.
            const expected = await page.evaluate<string[]>(`${FOCUSABLE}.map((el) =>
            el.tagName.toLowerCase() + ":" + (el.getAttribute("aria-label") ?? el.textContent.trim().slice(0, 30)))`);
            assert(expected.length > 25, `only ${expected.length} focusable controls`);
            await page.evaluate(`document.activeElement.blur(); scrollTo(0, 0)`);
            const visited: string[] = [];
            for (let i = 0; i < expected.length; i++) {
              await page.key("Tab", "Tab", 9);
              const focus = await page.evaluate<any>(`(() => {
              const el = document.activeElement;
              const cs = getComputedStyle(el);
              const r = el.getBoundingClientRect();
              return {
                id: el.tagName.toLowerCase() + ":" + (el.getAttribute("aria-label") ?? el.textContent.trim().slice(0, 30)),
                style: cs.outlineStyle, width: parseFloat(cs.outlineWidth),
                onScreen: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth,
              };
            })()`);
              visited.push(focus.id);
              assertEquals(focus.style, "solid", `no ring on ${focus.id}`);
              assert(focus.width >= 2, `ring too thin on ${focus.id}`);
              assert(focus.onScreen, `${focus.id} took focus off screen`);
            }
            assertEquals(visited, expected);
          }),
      );
    } finally {
      await cdp?.close();
      browser.kill("SIGTERM");
      await browser.status;
      await browserLog.done;
      await server.stop();
      await Deno.remove(dir, { recursive: true });
    }
  },
});
