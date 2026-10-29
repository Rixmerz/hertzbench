// `board: android` on Wi-Fi: the scenario schema and its refusals, and the launcher run
// through the real runner against a fake emulator (a sh script that starts a Deno process
// standing in for the guest's Wi-Fi). No Android SDK is needed. The runs skip on Windows
// because the fake tools are sh scripts.

import { join } from "node:path";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { parseEthernet, parseIpv4, parseUdp } from "../engine/mod.ts";
import {
  ANDROID_DEFAULT_MAC,
  ANDROID_FIDELITY,
  BoardError,
  checkFirmwareFiles,
  consolePortForMac,
  createAndroidLauncher,
  loadScenario,
  macForIndex,
  parseScenario,
  runScenario,
  ScenarioError,
} from "../orchestrator/mod.ts";
import {
  FAKE_EMULATOR_VERSION,
  FAKE_GUEST,
  fakeAvdHome,
  fakeGuestSdk,
  fakeSdk,
  fakeSnapshotSdk,
} from "./android_fake_sdk.ts";
import { skipOnWindows } from "./platform.ts";

const androidRun = skipOnWindows("the fake emulator and adb are sh scripts");

const PHONE = `
    id: phone
    board: android
    position: [3, 0]
    android: { avd: pixel8, apk: ./app.apk, package: dev.example.app }`;

const WEB = "  - { id: web, board: scripted, position: [0, 0] }";

const scenarioWith = (phone: string, rest = "") =>
  `name: android\nduration: 1500ms\nnodes:\n${WEB}\n  -${phone}\n${rest}`;

// ── schema ──────────────────────────────────────────────────────────────────

Deno.test("android node: the section is read, with the plan's defaults", () => {
  const scenario = parseScenario(scenarioWith(PHONE));
  const phone = scenario.nodes[1]!;
  assertEquals(phone.board, "android");
  assertEquals(phone.mac, ANDROID_DEFAULT_MAC);
  assertEquals(phone.ip, "192.168.4.12");
  assertEquals(phone.firmware, { kind: "apk", path: "./app.apk" });
  assertEquals(phone.android, {
    avd: "pixel8",
    package: "dev.example.app",
    extras: {},
    logcat: ["HZB"],
    bootTimeoutMs: 120_000,
    installTimeoutMs: 60_000,
    launchTimeoutMs: 20_000,
  });
});

Deno.test("android node: every option of the section, and a MAC override", () => {
  const scenario = parseScenario(`
name: android
duration: 5s
nodes:
${WEB}
  - id: phone
    board: android
    position: [3, 0]
    radios: [{ phy: wifi, channel: 5 }]
    mac: 02:AA:BB:CC:DD:EE
    android:
      avd: pixel8
      apk: ./app/build/app-debug.apk
      package: dev.example.iotapp
      activity: .MainActivity
      extras: { board_url: "http://192.168.4.11/" }
      logcat: [HZB, IotApp]
      boot_timeout: 90s
      install_timeout: 30s
      launch_timeout: 5s
`);
  const phone = scenario.nodes[1]!;
  assertEquals(phone.mac, "02:aa:bb:cc:dd:ee");
  assertEquals(phone.android, {
    avd: "pixel8",
    package: "dev.example.iotapp",
    activity: ".MainActivity",
    extras: { board_url: "http://192.168.4.11/" },
    logcat: ["HZB", "IotApp"],
    bootTimeoutMs: 90_000,
    installTimeoutMs: 30_000,
    launchTimeoutMs: 5000,
  });
});

Deno.test("android node: snapshot boot gives the node an ordinary MAC, and nodes may share a run", () => {
  const snapshotPhone = (id: string, extra = "") =>
    `  - id: ${id}\n    board: android\n    position: [3, 0]\n${extra}` +
    "    android: { avd: pixel8, apk: ./app.apk, package: dev.example.app, snapshot: true }\n";
  const scenario = parseScenario(
    `name: android\nduration: 1s\nnodes:\n${WEB}\n${snapshotPhone("phone")}` +
      snapshotPhone("tablet") + snapshotPhone("watch", "    mac: 02:AA:BB:CC:DD:EE\n"),
  );
  const [, phone, tablet, watch] = scenario.nodes;
  assertEquals(phone!.android!.snapshot, true);
  assertEquals(phone!.mac, macForIndex(2));
  assertEquals(tablet!.mac, macForIndex(3));
  assertEquals(watch!.mac, "02:aa:bb:cc:dd:ee");
  assertEquals(new Set(scenario.nodes.map((n) => n.mac)).size, 4);
  // a node that cold-boots may share the run with snapshot nodes, and keeps the AVD's MAC
  const mixed = parseScenario(
    `name: android\nduration: 1s\nnodes:\n${WEB}\n${snapshotPhone("phone")}  -${
      PHONE.replace("id: phone", "id: cold")
    }`,
  );
  assertEquals(mixed.nodes[2]!.mac, ANDROID_DEFAULT_MAC);
  assertEquals(mixed.nodes[2]!.android!.snapshot, undefined);
});

const refusals: [string, string, string][] = [
  [
    "no android section",
    scenarioWith("\n    id: phone\n    board: android\n    position: [3, 0]"),
    "nodes[1].android: board android needs an android section with avd, apk and package",
  ],
  [
    "no avd",
    scenarioWith(PHONE.replace("avd: pixel8, ", "")),
    "nodes[1].android.avd: is required on an android node",
  ],
  [
    "no apk",
    scenarioWith(PHONE.replace("apk: ./app.apk, ", "")),
    "nodes[1].android.apk: is required on an android node",
  ],
  [
    "no package",
    scenarioWith(PHONE.replace(", package: dev.example.app", "")),
    "nodes[1].android.package: is required on an android node",
  ],
  [
    "apk that is not an apk",
    scenarioWith(PHONE.replace("app.apk", "app.zip")),
    "nodes[1].android.apk: expected the path of an .apk file",
  ],
  [
    "package without a dot",
    scenarioWith(PHONE.replace("dev.example.app", "app")),
    "nodes[1].android.package: not an application id",
  ],
  [
    "avd that looks like a flag",
    scenarioWith(PHONE.replace("pixel8", "-wipe-data")),
    "nodes[1].android.avd: not an AVD name",
  ],
  [
    "unknown field of the section",
    scenarioWith(PHONE.replace("}", ", gpu: host }")),
    "nodes[1].android.gpu: unknown field",
  ],
  [
    "a zero timeout",
    scenarioWith(PHONE.replace("}", ", boot_timeout: 0s }")),
    "nodes[1].android.boot_timeout: must be positive",
  ],
  [
    "a timeout without a unit",
    scenarioWith(PHONE.replace("}", ", launch_timeout: 20 }")),
    "nodes[1].android.launch_timeout: expected a duration with a unit",
  ],
  [
    "firmware beside the app",
    scenarioWith(PHONE + "\n    firmware: ./fw"),
    "nodes[1].firmware: is not used by an android node",
  ],
  [
    "a BLE radio",
    scenarioWith(PHONE + "\n    radios: [{ phy: ble }]"),
    "bridge: { mirror: <node>, peripheral: netsim }",
  ],
  [
    "a LoRa radio",
    scenarioWith(PHONE + "\n    radios: [{ phy: lora }]"),
    "an android node has a Wi-Fi radio only",
  ],
  [
    "count above one",
    scenarioWith(PHONE + "\n    count: 2"),
    "nodes[1].count: cannot be set on an android node",
  ],
  [
    "a multicast MAC",
    scenarioWith(PHONE + "\n    mac: 01:00:5e:00:00:01"),
    "nodes[1].mac: a station cannot have a multicast MAC",
  ],
  [
    "a malformed MAC",
    scenarioWith(PHONE + "\n    mac: 02:15:d0"),
    "nodes[1].mac: not a MAC address",
  ],
  [
    "an android section on another board",
    `name: x\nduration: 1s\nnodes:\n${WEB}\n  - { id: b, board: scripted, position: [1, 0], android: {} }`,
    "nodes[1].android: is only for board: android",
  ],
  [
    "a MAC on another board",
    `name: x\nduration: 1s\nnodes:\n${WEB}\n  - { id: b, board: scripted, position: [1, 0], mac: "02:00:00:00:00:01" }`,
    "nodes[1].mac: is only for board: android",
  ],
  [
    "two android nodes",
    scenarioWith(
      PHONE,
      "  - id: tablet\n    board: android\n    position: [6, 0]\n" +
        "    android: { avd: pixel8, apk: ./app.apk, package: dev.example.app }\n",
    ),
    "a run has at most one android node that cold-boots",
  ],
  [
    "a snapshot flag that is not a boolean",
    scenarioWith(PHONE.replaceAll("}", ", snapshot: yes please }")),
    "nodes[1].android.snapshot: expected true or false",
  ],
  [
    "a cold-boot node beside a second one that cold-boots",
    scenarioWith(
      PHONE,
      "  - id: tablet\n    board: android\n    position: [6, 0]\n" +
        "    android: { avd: pixel8, apk: ./app.apk, package: dev.example.app, snapshot: false }\n",
    ),
    "set `snapshot: true` in each android section",
  ],
];

for (const [name, yaml, message] of refusals) {
  Deno.test(`android node refused: ${name}`, () => {
    const error = assertThrows(() => parseScenario(yaml), ScenarioError);
    assertStringIncludes(error.message, message);
  });
}

Deno.test("android node: the apk is resolved against the scenario file and must exist", async () => {
  const dir = await Deno.makeTempDir({ prefix: "hzb-android-scenario-" });
  try {
    await Deno.writeTextFile(join(dir, "s.yaml"), scenarioWith(PHONE));
    const loaded = await loadScenario(join(dir, "s.yaml"));
    const phone = loaded.scenario.nodes[1]!;
    assertEquals(phone.firmware, { kind: "apk", path: join(dir, "app.apk") });
    assertEquals(await checkFirmwareFiles(loaded.scenario), [
      `phone: ${join(dir, "app.apk")} does not exist`,
    ]);
    await Deno.writeTextFile(join(dir, "app.apk"), "PK");
    assertEquals(await checkFirmwareFiles(loaded.scenario), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ── the launcher, through the runner ────────────────────────────────────────

const ADB = `shell) echo 1 ;;
wait-for-device) exit 0 ;;
install) echo Success ;;
logcat) if [ "$1" = "-c" ]; then exit 0; fi; echo "HZB got temp 21.5"; exec sleep 60 ;;
emu) kill "$(cat "$DIR/emulator-pid")" ;;`;

/** Run a scenario whose phone is a fake emulator that sends a DHCP DISCOVER from `guestMac`. */
async function runWithFakeGuest(
  guestMac: string,
  phoneExtra = "",
  { guest = FAKE_GUEST, startupTimeoutMs, routeTimeoutMs }: {
    guest?: string;
    startupTimeoutMs?: number;
    routeTimeoutMs?: number;
  } = {},
) {
  const sdk = await fakeGuestSdk(ADB, guestMac, guest);
  const work = await Deno.makeTempDir({ prefix: "hzb-android-run-" });
  try {
    await Deno.writeTextFile(join(work, "app.apk"), "PK");
    await Deno.writeTextFile(join(work, "s.yaml"), scenarioWith(PHONE + phoneExtra));
    const loaded = await loadScenario(join(work, "s.yaml"), join(work, "out"));
    const run = () =>
      runScenario(loaded.scenario, {
        outDir: loaded.outDir,
        outputs: loaded.outputs,
        launchers: {
          android: createAndroidLauncher({
            checkKvm: () => null,
            ...(routeTimeoutMs !== undefined ? { routeTimeoutMs } : {}),
          }),
        },
        ...(startupTimeoutMs !== undefined ? { startupTimeoutMs } : {}),
      });
    return { sdk, work, run, outDir: loaded.outDir };
  } catch (error) {
    await sdk.restore();
    await Deno.remove(work, { recursive: true });
    throw error;
  }
}

androidRun(
  "android run: a DISCOVER from the AVD's MAC gets an OFFER of the node's IP, and the flags are the plan's",
  async () => {
    const { sdk, work, run, outDir } = await runWithFakeGuest(ANDROID_DEFAULT_MAC);
    try {
      const result = await run();
      assertEquals(result.problems, []);

      const reply = Uint8Array.from(
        (await Deno.readTextFile(join(sdk.dir, "reply.hex"))).match(/../g)!,
        (b) => parseInt(b, 16),
      );
      assertEquals(parseEthernet(reply)!.dst, ANDROID_DEFAULT_MAC);
      const bootp = parseUdp(reply, parseIpv4(reply)!)!.payload;
      assertEquals(Array.from(bootp.subarray(16, 20)), [192, 168, 4, 12]); // yiaddr: the phone's IP
      assertEquals(bootp[240 + 2], 2); // option 53 first: DHCPOFFER

      const args = await Deno.readTextFile(join(sdk.dir, "emulator-args"));
      assertStringIncludes(args, "-avd pixel8 -no-window");
      // The AVD's MAC comes from the console port: 5584 is what gives the default MAC.
      assertStringIncludes(args, "-port 5584 ");
      assertStringIncludes(args, "-feature -WiFiPacketStream -wifi-socket connect=127.0.0.1:");

      const phone = result.nodes.find((n) => n.id === "phone")!;
      assertEquals(phone.board, "android");
      assertEquals(phone.fidelity, ANDROID_FIDELITY);
      assert(
        result.events.some((e) =>
          e.type === "serial" && e.node === "phone" && e.text.includes("got temp")
        ),
        "logcat lines become the node's serial lines",
      );
      const log = await Deno.readTextFile(join(outDir, "phone-emulator.log"));
      assertStringIncludes(log, "emulator 37.1.11.0");
    } finally {
      await sdk.restore();
      await Deno.remove(work, { recursive: true });
    }
  },
);

// Issue #70: Android keeps eth0 (mobile data) as the default network unless data is disabled.
androidRun(
  "android run: mobile data is disabled and the route to a board is checked before the app starts",
  async () => {
    const { sdk, work, run } = await runWithFakeGuest(ANDROID_DEFAULT_MAC);
    try {
      const result = await run();
      assertEquals(result.problems, []);
      const calls = (await Deno.readTextFile(join(sdk.dir, "adb-calls"))).split("\n");
      const at = (needle: string) => calls.findIndex((c) => c.includes(needle));
      assert(at("shell svc data disable") >= 0, "svc data disable was never issued");
      assert(at("shell ip route get 192.168.4.") >= 0, "the route was never checked");
      assert(at("shell svc data disable") < at("shell am start"), "disable comes before the app");
      assert(at("shell ip route get") < at("shell am start"), "the check comes before the app");
    } finally {
      await sdk.restore();
      await Deno.remove(work, { recursive: true });
    }
  },
);

const ETH0_ROUTE = "192.168.4.11 via 10.0.2.2 dev eth0 table 1015 src 10.0.2.15 uid 2000";

androidRun("android run: a route through eth0 stops the run quoting the route line", async () => {
  const { sdk, work, run } = await runWithFakeGuest(ANDROID_DEFAULT_MAC, "", {
    routeTimeoutMs: 600,
  });
  try {
    await Deno.writeTextFile(join(sdk.dir, "route"), ETH0_ROUTE);
    const error = await assertRejects(run, BoardError);
    assertStringIncludes(error.message, "phone");
    assertStringIncludes(error.message, "wlan0");
    assertStringIncludes(error.message, ETH0_ROUTE);
    const calls = await Deno.readTextFile(join(sdk.dir, "adb-calls"));
    assert(!calls.includes("am start"), "the app must not start on the wrong network");
  } finally {
    await sdk.restore();
    await Deno.remove(work, { recursive: true });
  }
});

Deno.test("the console port that gives the guest a MAC is read back from the MAC", () => {
  assertEquals(consolePortForMac("02:15:d0:00:00:00"), 5584);
  assertEquals(consolePortForMac("02:15:b2:00:00:00"), 5554);
  assertEquals(consolePortForMac("02:16:32:00:00:00"), 5682);
  for (
    const mac of [
      "02:15:d1:00:00:00", // an odd port is not a console port
      "02:15:b0:00:00:00", // below 5554
      "02:16:34:00:00:00", // above 5682
      "02:15:d0:00:00:01", // not derived from a port
      "02:68:7a:62:01:01", // an ESP32's
    ]
  ) assertEquals(consolePortForMac(mac), null, mac);
});

androidRun(
  "android run: a console port that is taken stops the run before the emulator starts",
  async () => {
    let holder: Deno.TcpListener[];
    try {
      holder = [
        Deno.listen({ hostname: "127.0.0.1", port: 5584 }),
        Deno.listen({ hostname: "127.0.0.1", port: 5585 }),
      ];
    } catch {
      return; // a real emulator holds the port: the situation under test already exists
    }
    const { sdk, work, run } = await runWithFakeGuest(ANDROID_DEFAULT_MAC);
    try {
      const error = await assertRejects(run, BoardError);
      assertStringIncludes(error.message, "console port 5584 is taken");
      assertStringIncludes(error.message, ANDROID_DEFAULT_MAC);
      await assertRejects(() => Deno.stat(join(sdk.dir, "emulator-args")), Deno.errors.NotFound);
    } finally {
      holder.forEach((listener) => listener.close());
      await sdk.restore();
      await Deno.remove(work, { recursive: true });
    }
  },
);

androidRun("android run: a mac: override is the MAC the lease is for", async () => {
  const mac = "02:aa:bb:cc:dd:ee";
  const { sdk, work, run } = await runWithFakeGuest(mac, `\n    mac: ${mac}`);
  try {
    const result = await run();
    assertEquals(result.problems, []);
    const reply = await Deno.readTextFile(join(sdk.dir, "reply.hex"));
    assertEquals(
      parseEthernet(Uint8Array.from(reply.match(/../g)!, (b) => parseInt(b, 16)))!.dst,
      mac,
    );
  } finally {
    await sdk.restore();
    await Deno.remove(work, { recursive: true });
  }
});

androidRun("android run: another source MAC stops the run naming both", async () => {
  const { sdk, work, run } = await runWithFakeGuest("02:99:88:77:66:55");
  try {
    const error = await assertRejects(run, BoardError);
    assertStringIncludes(error.message, "phone");
    assertStringIncludes(error.message, "02:99:88:77:66:55"); // what the guest used
    assertStringIncludes(error.message, ANDROID_DEFAULT_MAC); // what the scenario gave the node
    await assertRejects(
      () => Deno.stat(join(sdk.dir, "reply.hex")),
      Deno.errors.NotFound,
      undefined,
      "no lease is offered to a MAC the scenario does not know",
    );
  } finally {
    await sdk.restore();
    await Deno.remove(work, { recursive: true });
  }
});

// The netdev connects but nothing is ever written: what netsim keeping the Wi-Fi looks like.
const SILENT_GUEST = `
const [, ...args] = Deno.args;
const port = Number(args[args.indexOf("-wifi-socket") + 1].split(":").pop());
const conn = await Deno.connect({ hostname: "127.0.0.1", port });
// Held open like a real emulator; see FAKE_GUEST.
for await (const _ of conn.readable) { /* drain until the host closes */ }
`;

androidRun(
  "android run: a guest that sends no Wi-Fi frames stops the run naming the flag",
  async () => {
    const { sdk, work, run } = await runWithFakeGuest(ANDROID_DEFAULT_MAC, "", {
      guest: SILENT_GUEST,
      startupTimeoutMs: 400,
    });
    try {
      const error = await assertRejects(run, BoardError);
      assertStringIncludes(error.message, "phone: the emulator sent no Wi-Fi frames within 400 ms");
      assertStringIncludes(error.message, "netsim Wi-Fi may be on");
      assertStringIncludes(error.message, "verified with emulator 37.1.11");
    } finally {
      await sdk.restore();
      await Deno.remove(work, { recursive: true });
    }
  },
);

androidRun("android run: an AVD that does not exist is refused before anything boots", async () => {
  const sdk = await fakeSdk(ADB);
  const work = await Deno.makeTempDir({ prefix: "hzb-android-run-" });
  try {
    await Deno.writeTextFile(join(work, "app.apk"), "PK");
    await Deno.writeTextFile(
      join(work, "s.yaml"),
      scenarioWith(PHONE.replace("pixel8", "no-such-avd")),
    );
    const loaded = await loadScenario(join(work, "s.yaml"), join(work, "out"));
    const error = await assertRejects(
      () =>
        runScenario(loaded.scenario, {
          outDir: loaded.outDir,
          outputs: loaded.outputs,
          launchers: { android: createAndroidLauncher({ checkKvm: () => null }) },
        }),
      BoardError,
    );
    assertStringIncludes(error.message, "no AVD named no-such-avd (found: pixel8, tablet)");
    await assertRejects(() => Deno.stat(join(sdk.dir, "adb-calls")), Deno.errors.NotFound);
  } finally {
    await sdk.restore();
    await Deno.remove(work, { recursive: true });
  }
});

// ── snapshot boot, through the runner ───────────────────────────────────────

const SNAPSHOT_ADB = `shell) echo 1 ;;
wait-for-device) exit 0 ;;
install) echo Success ;;
logcat) if [ "$1" = "-c" ]; then exit 0; fi; echo "HZB up"; exec sleep 60 ;;
emu) kill "$(cat "$DIR/emulator-pid-\${serial#emulator-}")" ;;`;

const SNAPSHOT_NODES = `
    android: { avd: pixel8, apk: ./app.apk, package: dev.example.app, snapshot: true }`;

/** Run two snapshot android nodes, `phone` and `tablet`, against a fake AVD home holding `marker`. */
async function runSnapshotNodes(marker: { emulator: string } | null, routeTimeoutMs?: number) {
  const avd = await fakeAvdHome("pixel8", marker);
  const work = await Deno.makeTempDir({ prefix: "hzb-android-run-" });
  const oldHome = Deno.env.get("ANDROID_AVD_HOME");
  Deno.env.set("ANDROID_AVD_HOME", avd.home);
  try {
    await Deno.writeTextFile(join(work, "app.apk"), "PK");
    await Deno.writeTextFile(
      join(work, "s.yaml"),
      scenarioWith(
        SNAPSHOT_NODES.replace(/^/, "\n    id: phone\n    board: android\n    position: [3, 0]"),
        `  - id: tablet\n    board: android\n    position: [6, 0]${SNAPSHOT_NODES}\n`,
      ),
    );
    const loaded = await loadScenario(join(work, "s.yaml"), join(work, "out"));
    return await runScenario(loaded.scenario, {
      outDir: loaded.outDir,
      outputs: loaded.outputs,
      launchers: {
        android: createAndroidLauncher({
          checkKvm: () => null,
          ...(routeTimeoutMs !== undefined ? { routeTimeoutMs } : {}),
        }),
      },
    });
  } finally {
    if (oldHome === undefined) Deno.env.delete("ANDROID_AVD_HOME");
    else Deno.env.set("ANDROID_AVD_HOME", oldHome);
    await avd.remove();
    await Deno.remove(work, { recursive: true });
  }
}

androidRun(
  "android run: two snapshot nodes boot with their own MAC and console port and get distinct leases",
  async () => {
    const sdk = await fakeSnapshotSdk(SNAPSHOT_ADB);
    try {
      const result = await runSnapshotNodes({ emulator: FAKE_EMULATOR_VERSION });
      assertEquals(result.problems, []);

      const leases: string[] = [];
      const ports: string[] = [];
      for (const [node, mac, ip] of [["phone", 2, 12], ["tablet", 3, 13]] as const) {
        const guestMac = macForIndex(mac);
        const reply = Uint8Array.from(
          (await Deno.readTextFile(join(sdk.dir, `reply-${guestMac}.hex`))).match(/../g)!,
          (b) => parseInt(b, 16),
        );
        assertEquals(parseEthernet(reply)!.dst, guestMac, node);
        const bootp = parseUdp(reply, parseIpv4(reply)!)!.payload;
        assertEquals(bootp[240 + 2], 2, node); // DHCPOFFER
        leases.push(Array.from(bootp.subarray(16, 20)).join("."));
        assertEquals(leases.at(-1), `192.168.4.${ip}`, node);

        const args = await Deno.readTextFile(join(sdk.dir, `emulator-args-${guestMac}`));
        assertStringIncludes(
          args,
          `-snapshot hertzbench -force-snapshot-load -wifi-mac-address ${guestMac} `,
        );
        assertStringIncludes(args, "-read-only -no-snapshot-save");
        ports.push(/-port (\d+)/.exec(args)![1]!);
        assert(!args.includes("-port 5584 "), "a snapshot boot does not need the MAC's own port");
      }
      assertEquals(new Set(leases).size, 2);
      assertEquals(new Set(ports).size, 2, "two emulators on one console port");
    } finally {
      await sdk.restore();
    }
  },
);

androidRun(
  "android run: a snapshot boot gets the same wlan0 route check and stops on eth0",
  async () => {
    const sdk = await fakeSnapshotSdk(SNAPSHOT_ADB);
    try {
      await Deno.writeTextFile(join(sdk.dir, "route"), ETH0_ROUTE);
      const error = await assertRejects(
        () => runSnapshotNodes({ emulator: FAKE_EMULATOR_VERSION }, 600),
        BoardError,
      );
      assertStringIncludes(error.message, ETH0_ROUTE);
      const calls = await Deno.readTextFile(join(sdk.dir, "adb-calls"));
      assertStringIncludes(calls, "shell svc data disable");
      assert(!calls.includes("am start"));
    } finally {
      await sdk.restore();
    }
  },
);

androidRun(
  "android run: a snapshot node refuses to start when the AVD has no snapshot or one from another emulator",
  async () => {
    const sdk = await fakeSdk(SNAPSHOT_ADB);
    try {
      for (
        const [marker, words] of [
          [null, "pixel8 has no prepared snapshot; run `hertzbench android prepare pixel8`"],
          [
            { emulator: "36.0.0.0" },
            `prepared with emulator 36.0.0.0, this is ${FAKE_EMULATOR_VERSION}`,
          ],
        ] as const
      ) {
        const error = await assertRejects(() => runSnapshotNodes(marker), BoardError);
        assertStringIncludes(error.message, words);
      }
      // refused in preflight: no emulator was ever started for either node
      await assertRejects(() => Deno.stat(join(sdk.dir, "emulator-args")), Deno.errors.NotFound);
    } finally {
      await sdk.restore();
    }
  },
);
