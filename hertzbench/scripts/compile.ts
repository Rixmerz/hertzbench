// Builds standalone hertzbench binaries with `deno compile`, one per target:
//   deno task compile                  every target, into dist/
//   deno task compile linux-x64 ...    only the named ones
//   deno task compile --list           the names
// Deno cross-compiles, so any host can build all of them. The files the program
// reads at run time (the view's page, the docs and examples served as MCP
// resources, the Python helpers) are embedded with --include.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Release asset name -> `deno compile --target` value. */
const TARGETS: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "macos-x64": "x86_64-apple-darwin",
  "macos-arm64": "aarch64-apple-darwin",
  "windows-x64": "x86_64-pc-windows-msvc",
  "windows-arm64": "aarch64-pc-windows-msvc",
};

// view/server.ts serves a few files of the Velxio frontend from the repository.
const EMBEDDED = [
  "view/static",
  "docs/fidelity.md",
  "docs/scenario-format.md",
  "scenarios/examples",
  "bridge/ble/bluez_gatt.py",
  "orchestrator/compile_sketch.py",
  "../frontend/src/tokens",
  "../frontend/public/fonts/Inter.var.woff2",
  "../frontend/public/fonts/JetBrainsMono.var.woff2",
  "../frontend/public/boards/esp32-devkit-v1.svg",
];

// A binary takes no permission flags, so it is built with the ones `deno task lan`
// grants: the mobile bridge may listen beyond loopback when a scenario says so.
const PERMISSIONS = [
  "--allow-net",
  "--allow-sys=networkInterfaces",
  "--allow-read",
  "--allow-write",
  "--allow-run",
  "--allow-env",
];

const args = Deno.args;
if (args.includes("--list")) {
  console.log(Object.keys(TARGETS).join("\n"));
  Deno.exit(0);
}
const wanted = args.length > 0 ? args : Object.keys(TARGETS);
const unknown = wanted.filter((name) => !(name in TARGETS));
if (unknown.length > 0) {
  console.error(`unknown target ${unknown.join(", ")}; known: ${Object.keys(TARGETS).join(", ")}`);
  Deno.exit(2);
}

const dist = join(ROOT, "dist");
await Deno.mkdir(dist, { recursive: true });
for (const name of wanted) {
  const output = join(dist, `hertzbench-${name}${name.startsWith("windows") ? ".exe" : ""}`);
  console.log(`compile ${name} -> ${output}`);
  const { code } = await new Deno.Command(Deno.execPath(), {
    args: [
      "compile",
      "--target",
      TARGETS[name]!,
      ...PERMISSIONS,
      ...EMBEDDED.flatMap((path) => ["--include", path]),
      "--output",
      output,
      "cli/main.ts",
    ],
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (code !== 0) {
    console.error(`compile ${name} failed (exit ${code})`);
    Deno.exit(code);
  }
}
