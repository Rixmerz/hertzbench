// The rules of the repository's PR Guard (zizmor, .github/zizmor.yml) that this
// workflow has to meet, checked on its text so a regression shows up here and
// not as a red pull request: tokens scoped to the job that needs them, every
// third-party action pinned by commit SHA, checkout without a persisted token.
// This does not replace running zizmor; it is the part that needs no network.

import { assert, assertEquals } from "@std/assert";

const PATH = new URL("../../.github/workflows/pages.yml", import.meta.url).pathname;
const text = await Deno.readTextFile(PATH);
const lines = text.split("\n");

Deno.test("pages workflow: no write scope at workflow level", () => {
  const top = lines.slice(0, lines.findIndex((line) => line.startsWith("jobs:")));
  assert(
    top.some((line) => /^permissions:\s*\{\}\s*$/.test(line)),
    "workflow permissions are not {}",
  );
  assert(!top.some((line) => /^\s+(pages|id-token|contents):\s*write/.test(line)));
});

Deno.test("pages workflow: write scopes only on the deploy job", () => {
  const deploy = text.slice(text.indexOf("\n  deploy:"));
  const build = text.slice(text.indexOf("\n  build:"), text.indexOf("\n  deploy:"));
  assert(/pages:\s*write/.test(deploy) && /id-token:\s*write/.test(deploy));
  assert(!/:\s*write/.test(build), "the build job asks for a write scope");
});

Deno.test("pages workflow: third-party actions are pinned by SHA", () => {
  const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]!);
  assert(uses.length >= 4, `only ${uses.length} actions found`);
  for (const use of uses) {
    // .github/zizmor.yml: actions/* and github/* may use a tag, everything else a hash.
    if (/^(actions|github)\//.test(use)) continue;
    assert(/@[0-9a-f]{40}$/.test(use), `${use} is not pinned by a 40-character SHA`);
  }
});

Deno.test("pages workflow: checkout does not persist its token", () => {
  const at = lines.findIndex((line) => line.includes("actions/checkout@"));
  assert(at >= 0);
  assertEquals(lines.slice(at, at + 4).some((l) => /persist-credentials:\s*false/.test(l)), true);
});

Deno.test("pages workflow: stages the page and site/img, and nothing else of site/", () => {
  const stage = text.slice(
    text.indexOf("name: Stage the site"),
    text.indexOf("upload-pages-artifact"),
  );
  assert(/cp site\/index\.html site\/style\.css site\/download\.js _site\//.test(stage), stage);
  assert(/cp -r site\/img _site\/img/.test(stage), "site/img is not staged");
  assert(!/site\/tests|deno\.json/.test(stage), "the test or deno.json would be published");
  assert(/"site\/\*\*"/.test(text), "a change under site/ does not trigger the deploy");
});
