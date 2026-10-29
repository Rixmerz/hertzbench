// Fake `emulator` and `adb` scripts on PATH, shared by the Android tests. They are POSIX sh,
// so a test that uses them skips on Windows.

import { delimiter, join } from "node:path";
import { buildDhcpClientMessage, DHCPDISCOVER } from "../engine/mod.ts";

/** A temp dir holding fake tools; `adbCases` is the body of the fake adb's `case "$cmd"` (`$serial` is the device). */
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
serial="$2"
shift 2
cmd="$1"; shift
# The two commands the launcher issues to make wlan0 the network app sockets use. A test that
# wants another route writes it to $DIR/route; the default is the healthy one.
if [ "$cmd" = shell ] && [ "$1" = svc ]; then exit 0; fi
if [ "$cmd" = shell ] && [ "$1" = ip ]; then
  if [ -f "$DIR/route" ]; then cat "$DIR/route"; else echo "$5 dev wlan0 table 1016 src 192.168.4.12 uid 2000"; fi
  exit 0
fi
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

/**
 * What each guest of a snapshot boot does: read its MAC from `-wifi-mac-address`, send a DHCP
 * DISCOVER from it on the `-wifi-socket` port, and keep the first reply in `reply-<mac>.hex`.
 * Its arguments are saved in `emulator-args-<mac>`.
 */
const snapshotGuest = (engine: string) => `
import { buildDhcpClientMessage, DHCPDISCOVER } from ${JSON.stringify(engine)};
const [dir, ...args] = Deno.args;
const value = (flag) => args[args.indexOf(flag) + 1];
const mac = value("-wifi-mac-address");
const port = Number(value("-wifi-socket").split(":").pop());
await Deno.writeTextFile(dir + "/emulator-args-" + mac, args.join(" "));
const frame = buildDhcpClientMessage(mac, DHCPDISCOVER, 0x1234);
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
      await Deno.writeTextFile(dir + "/reply-" + mac + ".hex", Array.from(reply, (b) => b.toString(16).padStart(2, "0")).join(""));
      replied = true;
    }
  }
}
`;

/**
 * A fake SDK whose emulators are Deno processes standing in for snapshot-booted guests (see
 * `snapshotGuest`), as many as the run starts. Each writes its pid to `emulator-pid-<console port>`,
 * which is what `$serial` of the fake adb ends in, so `adb -s emulator-N emu kill` ends the right one.
 */
export function fakeSnapshotSdk(adbCases: string) {
  const emulatorBody = `port=""; prev=""
for arg in "$@"; do if [ "$prev" = "-port" ]; then port="$arg"; fi; prev="$arg"; done
echo $$ > "$DIR/emulator-pid-$port"
exec "${Deno.execPath()}" run --allow-net=127.0.0.1 --allow-read --allow-write "$DIR/guest.ts" "$DIR" "$@"`;
  return fakeSdk(adbCases, emulatorBody).then(async (sdk) => {
    try {
      const engine = new URL("../engine/mod.ts", import.meta.url).href;
      await Deno.writeTextFile(join(sdk.dir, "guest.ts"), snapshotGuest(engine));
      return sdk;
    } catch (error) {
      await sdk.restore();
      throw error;
    }
  });
}

/**
 * An AVD directory tree under a temp dir, with the snapshot marker `android prepare` writes (or
 * none: `marker: null`). `ANDROID_AVD_HOME` should name the returned `home`.
 */
export async function fakeAvdHome(
  avd: string,
  marker: { emulator: string } | null,
): Promise<{ home: string; avdDir: string; remove(): Promise<void> }> {
  const home = await Deno.makeTempDir({ prefix: "hzb-avd-home-" });
  const avdDir = join(home, `${avd}.avd`);
  await Deno.mkdir(join(avdDir, "snapshots", "hertzbench"), { recursive: true });
  if (marker !== null) {
    await Deno.writeTextFile(
      join(avdDir, "snapshots", "hertzbench", "hertzbench.json"),
      JSON.stringify(marker),
    );
  }
  return { home, avdDir, remove: () => Deno.remove(home, { recursive: true }) };
}

/** The version the fake `emulator -version` prints. */
export const FAKE_EMULATOR_VERSION = "37.1.11.0 (build_id 15917651) (CL:N/A)";
