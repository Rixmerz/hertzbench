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
    for (const line of decode(text!).split("\n")) {
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
