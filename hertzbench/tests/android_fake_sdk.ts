// Fake `emulator` and `adb` scripts on PATH, shared by the Android tests. They are POSIX sh,
// so a test that uses them skips on Windows.

import { delimiter, join } from "node:path";

/** A temp dir holding fake tools; `adbCase` is the body of the fake adb's `case "$cmd"`. */
export async function fakeSdk(
  adbCases: string,
  emulatorBody = 'echo "$@" > "$DIR/emulator-args"; echo $$ > "$DIR/emulator-pid"; exec sleep 60',
): Promise<{ dir: string; restore(): Promise<void> }> {
  const dir = await Deno.makeTempDir({ prefix: "hzb-android-" });
  await Deno.writeTextFile(
    join(dir, "emulator"),
    `#!/bin/sh
DIR="$(dirname "$0")"
if [ "$1" = "-list-avds" ]; then printf 'INFO | Storing crashdata\\npixel8\\ntablet\\n'; exit 0; fi
if [ "$1" = "-version" ]; then echo 'Android emulator version 37.1.11.0 (build_id 15917651) (CL:N/A)'; exit 0; fi
${emulatorBody}
`,
  );
  // adb -s SERIAL <cmd> ...: the command is the word after the serial.
  await Deno.writeTextFile(
    join(dir, "adb"),
    `#!/bin/sh
DIR="$(dirname "$0")"
echo "$@" >> "$DIR/adb-calls"
shift 2
cmd="$1"; shift
case "$cmd" in
${adbCases}
esac
`,
  );
  await Deno.chmod(join(dir, "emulator"), 0o755);
  await Deno.chmod(join(dir, "adb"), 0o755);
  const oldPath = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}${delimiter}${oldPath}`);
  return {
    dir,
    async restore() {
      Deno.env.set("PATH", oldPath);
      await Deno.remove(dir, { recursive: true });
    },
  };
}
