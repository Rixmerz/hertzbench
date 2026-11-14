// What the page says it ran must be something a visitor can run: every scenario
// file a command bar or an install block names is in the repository's examples,
// or the page prints its whole text. Needs no browser.

import { assert, assertEquals } from "@std/assert";

const html = await Deno.readTextFile(new URL("../index.html", import.meta.url));
const EXAMPLES = new URL("../../hertzbench/scenarios/examples/", import.meta.url);
const decode = (text: string) =>
  text.replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");

/** The scenario file names that follow a command on the page, outside any scenario text. */
function namedScenarios(): Set<string> {
  const names = new Set<string>();
  const sources = [
    ...html.matchAll(/<span class="frame-cmd">([^<]*)<\/span>/g),
    ...html.matchAll(/<pre[^>]*><code>([\s\S]*?)<\/code><\/pre>/g),
  ];
  for (const [, text] of sources) {
    // A placeholder in a usage line, `<scenario.yaml>`, names no file.
    for (const line of decode(text!).replaceAll(/<[\w.-]+>/g, "").split("\n")) {
      if (!/hertzbench|deno task|^\$ /.test(line) && !/^[\w./-]+\.yaml$/.test(line.trim())) {
        continue;
      }
      for (const [name] of line.matchAll(/[\w-]+\.yaml/g)) names.add(name);
    }
  }
  return names;
}

Deno.test("content: every scenario the page runs is in the examples or printed in full", async () => {
  const printed = new Set(
    [...html.matchAll(
      /<span class="frame-cmd">([\w-]+\.yaml)<\/span>\s*<span class="frame-tag">scenario<\/span>/g,
    )]
      .map((m) => m[1]!),
  );
  const names = namedScenarios();
  assert(names.size >= 8, `found only ${[...names]}`);
  for (const name of names) {
    if (printed.has(name)) continue;
    const stat = await Deno.stat(new URL(name, EXAMPLES)).catch(() => null);
    assert(
      stat?.isFile,
      `${name} is neither in hertzbench/scenarios/examples/ nor printed on the page`,
    );
  }
});

Deno.test("content: a scenario printed on the page is the one the CLI test runs", async () => {
  const test = await Deno.readTextFile(
    new URL("../../hertzbench/tests/cli_test.ts", import.meta.url),
  );
  const block = /aria-label="nRF24 scenario"><code>([\s\S]*?)<\/code>/.exec(html)![1]!;
  const printed = decode(block).trim();
  assertEquals(printed.split("\n")[0], "name: nrf24-scripted");
  assert(test.includes(printed), "the nRF24 scenario on the page differs from tests/cli_test.ts");
});

Deno.test("content: no release number is typed into the page outside its run record", () => {
  // The newest release comes from the GitHub API in download.js, so the text must not name one
  // that goes stale. The only release number allowed is in the dated run record (a <figure>),
  // which says what was run on which day. ESP-IDF's own version is not a release.
  const outside = html
    .replace(/<figure class="frame">[\s\S]*?<\/figure>/g, "")
    .replaceAll(/ESP-IDF\s+v\d+\.\d+\.\d+/g, "");
  const found = outside.match(/\bv\d+\.\d+\.\d+\b/g) ?? [];
  assertEquals(found, [], "a release number is typed into the page: it goes stale");
});

Deno.test("content: the Download section takes its release from the API, not from text", () => {
  const section = /<section id="download"[\s\S]*?<\/section>/.exec(html)![0];
  assert(section.includes('id="release-status"'), "no status line for the API's answer");
  assert(/<script src="download\.js"/.test(html), "download.js is not loaded");
});
