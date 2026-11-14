import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { examplesCommand, listExamples } from "../cli/examples.ts";
import { BUNDLED_EXAMPLES } from "../cli/examples_bundle.ts";
import { loadScenario } from "../orchestrator/load.ts";
import { collectExamples, isSelfContained, renderBundle } from "../scripts/bundle-examples.ts";

const EXPECTED = [
  "ble-sensors-scripted",
  "bridge-ble-scripted",
  "bridge-web-scripted",
  "door-and-interference-scripted",
  "espnow-mesh-scripted",
  "live-3-scripted",
  "lora-gateway-6-scripted",
  "mqtt-clients-scripted",
  "udp-3-scripted",
];

/** Runs the command with console output captured, so a test can read what a person would see. */
async function run(args: string[], cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...parts: unknown[]) => void out.push(parts.join(" "));
  console.error = (...parts: unknown[]) => void err.push(parts.join(" "));
  try {
    const code = await examplesCommand(args, { cwd });
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

async function entries(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(dir)) names.push(entry.name);
  return names;
}

async function withTempDir(body: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "hzb-examples-" });
  try {
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("listExamples names every scripted example with a one-line description", () => {
  const examples = listExamples();
  assertEquals(examples.map((example) => example.name), EXPECTED);
  for (const { name, description } of examples) {
    assert(description.length > 0, `${name} has no description`);
    assert(!description.includes("\n"), `${name} description spans lines`);
    assert(description.length <= 100, `${name} description is ${description.length} characters`);
  }
});

Deno.test("examples with no name prints the list and exits 0", async () => {
  await withTempDir(async (dir) => {
    const { code, out } = await run([], dir);
    assertEquals(code, 0);
    for (const { name, description } of listExamples()) {
      assertStringIncludes(out, name);
      assertStringIncludes(out, description);
    }
    assertEquals(await entries(dir), [], "listing must not write files");
  });
});

Deno.test("an example is written to the working directory, byte for byte", async () => {
  await withTempDir(async (dir) => {
    const { code, out } = await run(["udp-3-scripted"], dir);
    assertEquals(code, 0);
    const path = join(dir, "udp-3-scripted.yaml");
    assertEquals(await Deno.readTextFile(path), BUNDLED_EXAMPLES["udp-3-scripted"]!.yaml);
    assertStringIncludes(out, path);
  });
});

Deno.test("--out writes into that directory, creating it, and leaves the cwd alone", async () => {
  await withTempDir(async (dir) => {
    const { code } = await run(["--out", "nested/dir", "live-3-scripted"], dir);
    assertEquals(code, 0);
    const written = await Deno.readTextFile(join(dir, "nested", "dir", "live-3-scripted.yaml"));
    assertEquals(written, BUNDLED_EXAMPLES["live-3-scripted"]!.yaml);
    assertEquals(await entries(dir), ["nested"]);
  });
});

Deno.test("every written example is a scenario the loader accepts", async () => {
  await withTempDir(async (dir) => {
    for (const { name } of listExamples()) {
      assertEquals((await run([name], dir)).code, 0, name);
      const loaded = await loadScenario(join(dir, `${name}.yaml`));
      assertEquals(loaded.scenario.name, name);
    }
  });
});

Deno.test("an existing file is never overwritten", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "udp-3-scripted.yaml");
    await Deno.writeTextFile(path, "mine\n");
    const { code, err } = await run(["udp-3-scripted"], dir);
    assertEquals(code, 1);
    assertStringIncludes(err, "already exists");
    assertEquals(await Deno.readTextFile(path), "mine\n");
  });
});

Deno.test("a dangling symlink is not followed or replaced", async () => {
  if (Deno.build.os === "windows") return; // creating symlinks needs a privilege there
  await withTempDir(async (dir) => {
    const target = join(dir, "elsewhere.txt");
    await Deno.symlink(target, join(dir, "udp-3-scripted.yaml"));
    const { code } = await run(["udp-3-scripted"], dir);
    assertEquals(code, 1);
    await Deno.stat(target).then(
      () => assert(false, "the symlink target was created"),
      (error) => assert(error instanceof Deno.errors.NotFound),
    );
  });
});

Deno.test("an unknown name exits 1 and writes nothing", async () => {
  await withTempDir(async (dir) => {
    for (const name of ["no-such-example", "constructor", "__proto__"]) {
      const { code, err } = await run([name], dir);
      assertEquals(code, 1, name);
      assertStringIncludes(err, "unknown example");
    }
    assertEquals(await entries(dir), []);
  });
});

Deno.test("bad arguments exit 2", async () => {
  await withTempDir(async (dir) => {
    for (const args of [["--out"], ["--bogus"], ["a", "b"], ["--out", "x"]]) {
      assertEquals((await run(args, dir)).code, 2, args.join(" "));
    }
  });
});

Deno.test("the bundle is current: regenerating it from scenarios/examples changes nothing", async () => {
  const text = renderBundle(await collectExamples());
  // A Windows checkout may hold the file with CRLF line endings; the generator writes LF.
  const committed = (await Deno.readTextFile(new URL("../cli/examples_bundle.ts", import.meta.url)))
    .replaceAll("\r\n", "\n");
  assertEquals(
    committed,
    text,
    "run `deno run --allow-read --allow-write scripts/bundle-examples.ts`",
  );
});

Deno.test("isSelfContained rejects firmware paths, APKs and other boards", () => {
  const node = { board: "scripted", firmware: { advertise: {} } };
  assert(isSelfContained({ nodes: [node] }));
  assert(isSelfContained({ nodes: [{ board: "scripted" }] }));
  assertEquals(isSelfContained({ nodes: [{ board: "scripted", firmware: "./fw/x" }] }), false);
  assertEquals(isSelfContained({ nodes: [{ board: "esp32", firmware: "./fw/x" }] }), false);
  assertEquals(isSelfContained({ nodes: [node], bridge: { apk: "../app.apk" } }), false);
  assertEquals(isSelfContained({ nodes: [] }), false);
});
