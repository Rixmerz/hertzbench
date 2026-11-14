import { assertEquals, assertRejects } from "@std/assert";
import {
  openBrowserSafely,
  openCommandFor,
  openerFor,
  shouldOpenBrowser,
} from "../cli/browser_open.ts";

const URL_ = "http://127.0.0.1:8080/";

Deno.test("openCommandFor builds the right command per OS", () => {
  assertEquals(openCommandFor("windows", URL_), ["cmd", "/c", "start", "", URL_]);
  assertEquals(openCommandFor("darwin", URL_), ["open", URL_]);
  assertEquals(openCommandFor("linux", URL_), ["xdg-open", URL_]);
});

Deno.test("openCommandFor has no command for an unknown OS", () => {
  assertEquals(openCommandFor("freebsd", URL_), null);
});

Deno.test("openerFor an unknown OS is a no-op that resolves", async () => {
  await openerFor("freebsd")(URL_);
});

Deno.test("shouldOpenBrowser truth table", () => {
  for (const stdoutIsTerminal of [false, true]) {
    for (const ci of [false, true]) {
      for (const noOpen of [false, true]) {
        assertEquals(
          shouldOpenBrowser({ stdoutIsTerminal, ci, noOpen }),
          stdoutIsTerminal && !ci && !noOpen,
          JSON.stringify({ stdoutIsTerminal, ci, noOpen }),
        );
      }
    }
  }
});

Deno.test("openBrowserSafely passes the url to the opener", async () => {
  const seen: string[] = [];
  await openBrowserSafely(URL_, (url) => {
    seen.push(url);
    return Promise.resolve();
  });
  assertEquals(seen, [URL_]);
});

Deno.test("openBrowserSafely resolves when the opener rejects", async () => {
  await openBrowserSafely(URL_, () => Promise.reject(new Error("no display")));
});

Deno.test("openBrowserSafely resolves when the opener throws synchronously", async () => {
  await openBrowserSafely(URL_, () => {
    throw new Error("boom");
  });
});

Deno.test("openBrowserSafely resolves when the opener binary is missing", async () => {
  // The real opener must throw NotFound for a missing program, and the safe wrapper must hide it.
  const missing = async (url: string) => {
    await new Deno.Command("hertzbench-no-such-opener", { args: [url] }).output();
  };
  await assertRejects(() => missing(URL_), Deno.errors.NotFound);
  await openBrowserSafely(URL_, missing);
});
