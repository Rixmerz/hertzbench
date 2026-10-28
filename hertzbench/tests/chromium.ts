// How the browser tests start and drive headless Chromium, shared so the files that do cannot drift.

/**
 * How long a Chromium may take to print its DevTools line, and a `hertzbench view` its URL.
 * The first launch in a CI job is a cold one on a two-core runner with a `deno run` compiling
 * beside it: the GitHub Ubuntu runner took 19 s to print its first line and passed once in 19 s
 * and failed twice at a 20 s limit on the same image. A process that exits earlier fails at once
 * (`StderrWatch.waitFor`), so a long limit costs nothing but the time a hung one takes to be
 * called hung.
 */
export const BROWSER_START_TIMEOUT_MS = 90_000;

export function chromiumArgs(profileDir: string): string[] {
  return [
    "--headless=new",
    // Ubuntu 23.10+ (and its GitHub runners) forbid the unprivileged user namespaces
    // Chromium's sandbox needs, and Chromium then exits with "No usable sandbox!".
    // The page under test is the project's own, served on loopback.
    "--no-sandbox",
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,900",
    "about:blank",
  ];
}

/** The Chromium to use, or null: `HERTZBENCH_CHROMIUM`, then the usual system paths. */
export function findChromium(): string | null {
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

/** SIGTERM a child that may have exited already, as a Chromium that failed to start has. */
export function terminate(child: Deno.ChildProcess): void {
  try {
    child.kill("SIGTERM");
  } catch (error) {
    // It exited already: the error that ended the test says why.
    if (!(error instanceof TypeError)) throw error;
  }
}

/** Reads a child's stderr as it comes, so a test can wait for a line on it. */
export class StderrWatch {
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
export class Cdp {
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
