// Fake `emulator` and `adb` scripts on PATH, shared by the Android tests. They are POSIX sh,
// so a test that uses them skips on Windows.

import { delimiter, join } from "node:path";
import { buildDhcpClientMessage, DHCPDISCOVER } from "../engine/mod.ts";

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

/** What the guest does on its Wi-Fi socket: send one frame, keep the first reply. */
// The loop keeps reading after the reply: a real emulator outlives its exchange, and a guest
// that exits early closes the socket before a slow start-up (macOS) has seen it connected.
export const FAKE_GUEST = `
const [dir, ...args] = Deno.args;
const spec = args[args.indexOf("-wifi-socket") + 1];
const port = Number(spec.split(":").pop());
await Deno.writeTextFile(dir + "/emulator-args", args.join(" "));
const hex = (await Deno.readTextFile(dir + "/discover.hex")).trim();
const frame = Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const conn = await Deno.connect({ hostname: "127.0.0.1", port });
const out = new Uint8Array(4 + frame.length);
new DataView(out.buffer).setUint32(0, frame.length);
out.set(frame, 4);
await conn.write(out);
let pending = new Uint8Array(0);
let replied = false;
for await (const chunk of conn.readable) {
  const joined = new Uint8Array(pending.length + chunk.length);
  joined.set(pending);
  joined.set(chunk, pending.length);
  pending = joined;
  if (!replied && pending.length >= 4) {
    const length = new DataView(pending.buffer).getUint32(0);
    if (pending.length >= 4 + length) {
      const reply = pending.slice(4, 4 + length);
      await Deno.writeTextFile(dir + "/reply.hex", Array.from(reply, (b) => b.toString(16).padStart(2, "0")).join(""));
      replied = true;
    }
  }
}
`;

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * A fake SDK whose emulator starts a Deno process standing in for the guest: it runs `guest`
 * (default FAKE_GUEST) against the `-wifi-socket` port, sending a DHCP DISCOVER from `guestMac`.
 * The fake adb has the cases `adbCases`.
 */
export function fakeGuestSdk(adbCases: string, guestMac: string, guest = FAKE_GUEST) {
  const emulatorBody = `echo $$ > "$DIR/emulator-pid"; ` +
    `exec "${Deno.execPath()}" run --allow-net=127.0.0.1 --allow-read --allow-write "$DIR/guest.ts" "$DIR" "$@"`;
  return fakeSdk(adbCases, emulatorBody).then(async (sdk) => {
    try {
      await Deno.writeTextFile(join(sdk.dir, "guest.ts"), guest);
      await Deno.writeTextFile(
        join(sdk.dir, "discover.hex"),
        toHex(buildDhcpClientMessage(guestMac, DHCPDISCOVER, 0x1234)),
      );
      return sdk;
    } catch (error) {
      await sdk.restore();
      throw error;
    }
  });
}
