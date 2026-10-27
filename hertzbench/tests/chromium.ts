// How the browser tests start headless Chromium, shared so the two files that do cannot drift.

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
