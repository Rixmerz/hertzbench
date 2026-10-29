// The `bridge:` section of a scenario (Phase 5) and the `serve:` list of a
// scripted Wi-Fi board: what is accepted, what defaults are filled in, and
// what is refused with which message.

import { fileURLToPath } from "node:url";
import { assertEquals, assertThrows } from "@std/assert";
import { BRIDGE_MAC, parseScenario, ScenarioError } from "../orchestrator/mod.ts";

const WIFI = `
name: bridge
duration: 2s
nodes:
  - id: web
    board: scripted
    position: [0, 0]
    radios: [{ phy: wifi, channel: 5 }]
    firmware: { serve: [{ port: 80, protocol: http }, { port: 1883, protocol: mqtt }] }
  - id: other
    board: scripted
    position: [10, 0]
    radios: [{ phy: wifi, channel: 5 }]
`;

const BLE = `
name: bridge
duration: 2s
nodes:
  - id: sensor
    board: scripted
    position: [0, 0]
    radios: [{ phy: ble }]
    firmware: { advertise: true }
  - id: gw
    board: scripted
    position: [5, 0]
    radios: [{ phy: ble }]
    firmware: { connect: { peers: [sensor] } }
`;

function refuses(yaml: string, message: string): void {
  assertThrows(() => parseScenario(yaml), ScenarioError, message);
}

Deno.test("bridge: an IP bridge takes its defaults and the exposed nodes' channel", () => {
  const scenario = parseScenario(`${WIFI}
bridge:
  position: [3, 4]
  expose:
    - { node: web, port: 80, service: http }
    - { node: web, port: 1883, service: mqtt, listen_port: 18830 }
`);
  assertEquals(scenario.bridge, {
    kind: "ip",
    id: "phone",
    position: { x: 3, y: 4 },
    mac: BRIDGE_MAC,
    radio: { phy: "wifi", channel: 5, txPowerDbm: 15, antennaGainDbi: 0 },
    ip: "192.168.4.250",
    listen: "127.0.0.1",
    mdns: false,
    advertiseIp: null,
    expose: [
      { node: "web", port: 80, service: "http", listenPort: 0 },
      { node: "web", port: 1883, service: "mqtt", listenPort: 18830 },
    ],
  });
  const web = scenario.nodes[0]?.firmware;
  assertEquals(web?.kind === "script" ? web.serve : null, [
    { port: 80, protocol: "http" },
    { port: 1883, protocol: "mqtt" },
  ]);
});

Deno.test("bridge: listening beyond loopback turns mDNS on unless the scenario says otherwise", () => {
  const lan = (extra: string) =>
    parseScenario(`${WIFI}
bridge:
  position: [0, 1]
  listen: 0.0.0.0
  ${extra}
  expose: [{ node: web, port: 80, service: http }]
`).bridge;
  const on = lan("");
  assertEquals(on?.kind === "ip" && on.mdns, true);
  const off = lan("mdns: false");
  assertEquals(off?.kind === "ip" && off.mdns, false);
  const pinned = lan("advertise_ip: 192.168.1.20");
  assertEquals(pinned?.kind === "ip" && pinned.advertiseIp, "192.168.1.20");
});

Deno.test("bridge: the bridge is a station the timeline, links and metrics can name", () => {
  const scenario = parseScenario(`${WIFI}
bridge:
  id: handset
  position: [1, 0]
  expose: [{ node: web, port: 80, service: websocket }]
links: [{ from: handset, to: web, extra_latency_ms: 20 }]
timeline: [{ at: 1s, move: { node: handset, to: [40, 0] } }]
assertions:
  - metric: { link: "handset->web", kind: tcp, loss_pct: { lt: 50 } }
  - serial: { node: handset, contains: "bridge" }
`);
  assertEquals(scenario.bridge?.id, "handset");
});

Deno.test("bridge: an IP bridge refuses what it could not relay", () => {
  const bridge = (body: string) => `${WIFI}\nbridge:\n  position: [1, 0]\n${body}`;
  refuses(bridge("  expose: []"), "bridge.expose: names no node port to relay");
  refuses(
    bridge("  expose: [{ node: ghost, port: 80, service: http }]"),
    'bridge.expose[0].node: no node named "ghost"',
  );
  refuses(
    bridge("  expose: [{ node: web, port: 80, service: ftp }]"),
    "bridge.expose[0].service: expected one of http, websocket, mqtt",
  );
  refuses(
    bridge(`  expose:
    - { node: web, port: 80, service: http, listen_port: 8080 }
    - { node: web, port: 81, service: http, listen_port: 8080 }`),
    "bridge.expose[1].listen_port: 8080 is already used by the bridge",
  );
  refuses(
    bridge("  ip: 192.168.4.11\n  expose: [{ node: web, port: 80, service: http }]"),
    "bridge.ip: 192.168.4.11 is already web's address",
  );
  refuses(
    bridge("  ip: 10.0.0.5\n  expose: [{ node: web, port: 80, service: http }]"),
    "bridge.ip: 10.0.0.5 is not inside 192.168.4.0/24",
  );
  refuses(
    bridge("  id: web\n  expose: [{ node: web, port: 80, service: http }]"),
    'bridge.id: "web" is already a node\'s id',
  );
  refuses(
    bridge("  id: gateway\n  expose: [{ node: web, port: 80, service: http }]"),
    'bridge.id: "gateway" is reserved',
  );
  refuses(
    bridge(
      "  radios: [{ phy: wifi, channel: 1 }]\n  expose: [{ node: web, port: 80, service: http }]",
    ),
    "bridge.expose[0].node: web is on channel 5 and the bridge on 1",
  );
  refuses(
    bridge("  mirror: web\n  expose: [{ node: web, port: 80, service: http }]"),
    "bridge.mirror: unknown field",
  );
  refuses(
    bridge("  listen: everywhere\n  expose: [{ node: web, port: 80, service: http }]"),
    'bridge.listen: not an IPv4 address: "everywhere"',
  );
});

Deno.test("bridge: scripted TCP servers are a Wi-Fi notion with distinct ports", () => {
  refuses(
    WIFI.replace(
      "{ port: 1883, protocol: mqtt }",
      "{ port: 80, protocol: mqtt }",
    ),
    "nodes[0].firmware.serve[1].port: is already served",
  );
  refuses(
    WIFI.replace("protocol: mqtt", "protocol: coap"),
    'nodes[0].firmware.serve[1].protocol: expected "http" or "mqtt"',
  );
  refuses(
    BLE.replace(
      "{ advertise: true }",
      "{ advertise: true, serve: [{ port: 80, protocol: http }] }",
    ),
    "nodes[0].firmware.serve: is a Wi-Fi notion",
  );
});

Deno.test("bridge: a BLE bridge mirrors an advertising peripheral", () => {
  const scenario = parseScenario(`${BLE}
bridge:
  position: [2, 0]
  mirror: sensor
`);
  assertEquals(scenario.bridge, {
    kind: "ble",
    id: "phone",
    position: { x: 2, y: 0 },
    mac: BRIDGE_MAC,
    radio: { phy: "ble", txPowerDbm: 0, antennaGainDbi: 0, hciUart: 1 },
    mirror: "sensor",
    peripheral: "bluez",
    adapter: "hci0",
    netsimHci: { host: "127.0.0.1", port: 6402 },
    name: "sensor",
    intervalMs: 30,
    timeoutMs: 1000,
  });
  const notifying = parseScenario(
    `${
      BLE.replace(
        "{ advertise: true }",
        "{ advertise: true, send: [{ to: phone, every: 1s, count: 2 }] }",
      )
    }
bridge: { position: [2, 0], mirror: sensor }
`,
  );
  assertEquals(notifying.bridge?.kind, "ble", "the mirrored node may notify the bridge");
  refuses(
    `${
      BLE.replace(
        "{ connect: { peers: [sensor] } }",
        "{ connect: { peers: [sensor] }, send: [{ to: phone, every: 1s, count: 2 }] }",
      )
    }
bridge: { position: [2, 0], mirror: sensor }
`,
    'nodes[1].firmware.send[0].to: no node named "phone" on the medium',
  );
  const bridge = (body: string) => `${BLE}\nbridge:\n  position: [1, 0]\n${body}`;
  refuses(bridge("  mirror: gw"), "bridge.mirror: gw is a scripted central");
  refuses(bridge("  mirror: ghost"), 'bridge.mirror: no node named "ghost"');
  refuses(bridge("  mirror: sensor\n  adapter: usb0"), "bridge.adapter: expected a BlueZ adapter");
  refuses(
    bridge("  mirror: sensor\n  interval: 31ms"),
    "bridge.interval: must be a multiple of 1.25 ms",
  );
  refuses(
    bridge("  mirror: sensor\n  expose: [{ node: sensor, port: 80, service: http }]"),
    "bridge.expose: unknown field",
  );
  refuses(
    bridge("  mirror: sensor\n  radios: [{ phy: wifi }]"),
    "bridge.radios: the bridge's radio must be ble",
  );
});

Deno.test("bridge: peripheral: netsim takes netsim's HCI port, and refuses BlueZ's adapter", () => {
  const bridge = (body: string) => `${BLE}\nbridge:\n  position: [1, 0]\n  mirror: sensor\n${body}`;
  const own = parseScenario(bridge("  peripheral: netsim"));
  assertEquals(own.bridge?.kind === "ble" && own.bridge.peripheral, "netsim");
  assertEquals(own.bridge?.kind === "ble" && own.bridge.netsimHci, {
    host: "127.0.0.1",
    port: 6402,
  });
  const elsewhere = parseScenario(bridge("  peripheral: netsim\n  netsim_hci: 127.0.0.1:16402"));
  assertEquals(elsewhere.bridge?.kind === "ble" && elsewhere.bridge.netsimHci, {
    host: "127.0.0.1",
    port: 16402,
  });
  refuses(bridge("  peripheral: usb"), 'bridge.peripheral: expected "bluez" or "netsim"');
  refuses(
    bridge("  peripheral: netsim\n  adapter: hci0"),
    "bridge.adapter: is a BlueZ adapter: it needs peripheral: bluez",
  );
  refuses(
    bridge("  netsim_hci: 127.0.0.1:6402"),
    "bridge.netsim_hci: is netsim's HCI port: it needs peripheral: netsim",
  );
  refuses(
    bridge("  peripheral: netsim\n  netsim_hci: localhost:6402"),
    "bridge.netsim_hci: not an IPv4 address",
  );
  refuses(
    bridge("  peripheral: netsim\n  netsim_hci: 127.0.0.1"),
    "bridge.netsim_hci: expected <IPv4 address>:<port>",
  );
  refuses(
    bridge("  peripheral: netsim\n  netsim_hci: 127.0.0.1:99999"),
    "bridge.netsim_hci: not a port",
  );
});

const APP = `
android:
  avd: pixel8
  apk: ./app.apk
  package: dev.example.bleapp
`;

Deno.test("android: a BLE scenario's app is read with the node section's defaults", () => {
  const scenario = parseScenario(`${BLE}${APP}
bridge: { position: [3, 0], mirror: sensor, peripheral: netsim }
`);
  assertEquals(scenario.android, {
    avd: "pixel8",
    apk: "./app.apk",
    package: "dev.example.bleapp",
    extras: {},
    logcat: ["HZB"],
    bootTimeoutMs: 120_000,
    installTimeoutMs: 60_000,
    launchTimeoutMs: 20_000,
  });
  assertEquals(
    parseScenario(
      WIFI + "bridge: { position: [3, 0], expose: [{ node: web, port: 80, service: http }] }\n",
    ).android,
    null,
  );
});

Deno.test("android: the app of a BLE scenario needs the netsim bridge, and none of the node-only options", () => {
  const withBridge = (peripheral: string) =>
    `bridge: { position: [3, 0], mirror: sensor${peripheral} }\n`;
  refuses(
    `${BLE}${APP}${withBridge(", peripheral: bluez")}`,
    "android: needs `bridge: { mirror: <node>, peripheral: netsim }`",
  );
  refuses(`${BLE}${APP}`, "android: needs `bridge: { mirror: <node>, peripheral: netsim }`");
  refuses(
    `${WIFI}${APP}`,
    "android: is for a BLE scenario; on Wi-Fi the app is a node: `board: android`",
  );
  refuses(
    `${BLE}${APP}  snapshot: true\n${withBridge(", peripheral: netsim")}`,
    "android.snapshot: is for a node of board: android",
  );
  refuses(
    `${BLE}${APP}  instrument: { runner: dev.example.test/androidx.test.runner.AndroidJUnitRunner, at: 1s }\n${
      withBridge(", peripheral: netsim")
    }`,
    "android.instrument: is for a node of board: android",
  );
  refuses(
    `${BLE}${APP}${withBridge(", peripheral: netsim, netsim_hci: '192.168.1.5:6402'")}`,
    "bridge.netsim_hci: must be on this host when the scenario starts the emulator",
  );
  refuses(
    `${BLE}android: { avd: pixel8, apk: ./app.apk }\n${withBridge(", peripheral: netsim")}`,
    "android.package: is required on an android node",
  );
});

Deno.test("bridge: LoRa and nRF24 scenarios have no phone to bridge", () => {
  refuses(
    `
name: lora
duration: 1s
nodes:
  - { id: a, board: scripted, position: [0, 0], radios: [{ phy: lora }] }
  - { id: b, board: scripted, position: [5, 0], radios: [{ phy: lora }] }
bridge: { position: [1, 0] }
`,
    "bridge: bridges a phone over Wi-Fi/IP or BLE; this scenario's radios are lora",
  );
});

const EXAMPLES = fileURLToPath(new URL("../scenarios/examples/", import.meta.url));

Deno.test("bridge: the four bridge examples are valid scenarios", async () => {
  const { loadScenario } = await import("../orchestrator/mod.ts");
  const kinds: Record<string, string> = {};
  for (
    const file of [
      "bridge-web-scripted",
      "bridge-web-esp32",
      "bridge-ble-scripted",
      "bridge-ble-esp32",
    ]
  ) {
    const { scenario } = await loadScenario(`${EXAMPLES}${file}.yaml`);
    kinds[file] = `${scenario.phy}:${scenario.bridge?.kind}`;
  }
  assertEquals(kinds, {
    "bridge-web-scripted": "wifi:ip",
    "bridge-web-esp32": "wifi:ip",
    "bridge-ble-scripted": "ble:ble",
    "bridge-ble-esp32": "ble:ble",
  });
});
