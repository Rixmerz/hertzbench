// compile_sketch.py is the one Python file the orchestrator runs. Everything
// short of the real ESP-IDF build can be checked here: reading the sketch and
// failing clearly. The build itself needs the toolchain (docs/e2e-esp32.md).

import { assertEquals, assertStringIncludes } from "@std/assert";

const HELPER = new URL("../orchestrator/compile_sketch.py", import.meta.url).pathname;
const EXAMPLE_SKETCH = new URL("../scenarios/examples/fw/udp-node", import.meta.url).pathname;

async function python(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const output = await new Deno.Command("python3", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  return { code: output.code, stdout: text(output.stdout), stderr: text(output.stderr) };
}

Deno.test("compile helper: a missing sketch directory is a clear error", async () => {
  const result = await python([HELPER, "/nonexistent/sketch"]);
  assertEquals(result.code, 1);
  assertStringIncludes(result.stderr, "sketch directory not found");
});

Deno.test("compile helper: a directory without an .ino file is refused", async () => {
  const dir = await Deno.makeTempDir({ prefix: "hzb-sketch-" });
  try {
    await Deno.writeTextFile(`${dir}/notes.txt`, "no sketch here");
    const result = await python([HELPER, dir]);
    assertEquals(result.code, 1);
    assertStringIncludes(result.stderr, "no .ino file");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("compile helper: reads the example sketch the way the Velxio compiler is called", async () => {
  const script = [
    "import importlib.util, json, pathlib, sys",
    `spec = importlib.util.spec_from_file_location('compile_sketch', ${JSON.stringify(HELPER)})`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    `files = module.read_sketch(pathlib.Path(${JSON.stringify(EXAMPLE_SKETCH)}))`,
    "json.dump([{'name': f['name'], 'size': len(f['content'])} for f in files], sys.stdout)",
  ].join("\n");
  const result = await python(["-c", script]);
  assertEquals(result.code, 0, result.stderr);
  const files = JSON.parse(result.stdout) as { name: string; size: number }[];
  assertEquals(files.map((f) => f.name), ["udp-node.ino"]);
  assertEquals(files[0]!.size > 500, true);
});
