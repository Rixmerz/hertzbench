// compile_sketch.py is the one Python file the orchestrator runs. Everything
// short of a real build can be checked here: reading the sketch, failing
// clearly and picking the compiler. A real build needs a toolchain (docs/e2e-esp32.md).

import { PYTHON } from "./platform.ts";
import { fileURLToPath } from "node:url";
import { assertEquals, assertStringIncludes } from "@std/assert";

const HELPER = fileURLToPath(new URL("../orchestrator/compile_sketch.py", import.meta.url));
const EXAMPLE_SKETCH = fileURLToPath(new URL("../scenarios/examples/fw/udp-node", import.meta.url));

async function python(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const output = await new Deno.Command(PYTHON, {
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

/**
 * Runs the helper's main() with stand-ins for Velxio's two compilers, so the
 * choice between them is checked without either toolchain. Each stand-in
 * prints to stdout and starts a child that does too, as the real ones do.
 */
async function compileWithStandIns(
  espidfAvailable: boolean,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const script = [
    "import importlib.util, subprocess, sys, types",
    "calls = []",
    "def noisy(tag):",
    "    print(f'{tag} progress')",
    "    subprocess.run([sys.executable, '-c', f'print(\"{tag} child\")'], check=True)",
    "class FakeEspidf:",
    `    available = ${espidfAvailable ? "True" : "False"}`,
    "    async def compile(self, files, fqbn):",
    "        noisy('espidf'); calls.append(('espidf', [f['name'] for f in files], fqbn))",
    "        return {'success': True, 'binary_content': 'RVNQSURG'}",
    "class FakeArduinoCLI:",
    "    def __init__(self):",
    "        noisy('arduino-cli init')",
    "    async def ensure_core_for_board(self, fqbn):",
    "        calls.append(('ensure', fqbn)); return {'needed': False}",
    "    async def compile(self, files, fqbn):",
    "        noisy('arduino-cli'); calls.append(('arduino-cli', [f['name'] for f in files], fqbn))",
    "        return {'success': True, 'binary_content': 'QVJEVUlOTw=='}",
    "for name in ('app', 'app.services'):",
    "    sys.modules[name] = types.ModuleType(name)",
    "espidf = types.ModuleType('app.services.espidf_compiler')",
    "espidf.espidf_compiler = FakeEspidf()",
    "arduino = types.ModuleType('app.services.arduino_cli')",
    "arduino.ArduinoCLIService = FakeArduinoCLI",
    "sys.modules['app.services.espidf_compiler'] = espidf",
    "sys.modules['app.services.arduino_cli'] = arduino",
    `spec = importlib.util.spec_from_file_location('compile_sketch', ${JSON.stringify(HELPER)})`,
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    `sys.argv = ['compile_sketch.py', ${JSON.stringify(EXAMPLE_SKETCH)}]`,
    "module.main()",
    "sys.stdout.flush()",
    "print(repr(calls), file=sys.stderr)",
  ].join("\n");
  return await python(["-c", script]);
}

Deno.test("compile helper: without ESP-IDF it compiles with arduino-cli, as Velxio's compile route does", async () => {
  const result = await compileWithStandIns(false);
  assertEquals(result.code, 0, result.stderr);
  assertEquals(JSON.parse(result.stdout), { firmware_b64: "QVJEVUlOTw==" });
  assertStringIncludes(
    result.stderr,
    "[('ensure', 'esp32:esp32:esp32'), ('arduino-cli', ['udp-node.ino'], 'esp32:esp32:esp32')]",
  );
  // The compilers' own output and their children's went to stderr, not into the JSON.
  assertStringIncludes(result.stderr, "arduino-cli progress");
  assertStringIncludes(result.stderr, "arduino-cli child");
});

Deno.test("compile helper: with ESP-IDF set up it uses Velxio's ESP-IDF pipeline only", async () => {
  const result = await compileWithStandIns(true);
  assertEquals(result.code, 0, result.stderr);
  assertEquals(JSON.parse(result.stdout), { firmware_b64: "RVNQSURG" });
  assertStringIncludes(result.stderr, "[('espidf', ['udp-node.ino'], 'esp32:esp32:esp32')]");
  assertStringIncludes(result.stderr, "espidf child");
});
