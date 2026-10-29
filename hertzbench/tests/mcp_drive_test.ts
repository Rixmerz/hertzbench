// The MCP tools an agent drives the whole simulator with, through the real
// `hertzbench mcp` process: link chaos, the channel and radios of a live run,
// serial input, the event stream, captures, scenario edits and the view.

import { join } from "node:path";
import { writeFakePython } from "./platform.ts";
import { assert, assertAlmostEquals, assertEquals, assertStringIncludes } from "@std/assert";
import {
  EXAMPLES,
  type Json,
  McpClient,
  pollMetrics,
  pollStatus,
  withServer,
} from "./mcp_client.ts";

const LIVE = `${EXAMPLES}live-3-scripted.yaml`;

const link = (m: Json, phase: string, from: string, to: string) =>
  m.phases.find((p: Json) => p.label === phase)?.links.find((l: Json) =>
    l.from === from && l.to === to
  );

Deno.test("mcp drive: inject_fault adds jitter and interference; interference costs frames by itself", async () => {
  await withServer(async (client) => {
    await client.ok("run_scenario", { path: LIVE });
    await pollStatus(client, (s) => s.state === "running", "the boards to connect");

    const fault = await client.ok("inject_fault", {
      link: "a->b",
      interference_db: 80,
      extra_jitter_ms: 5,
      phase: "jammed",
    });
    assertEquals(
      [fault.links, fault.interference_db, fault.extra_jitter_ms, fault.extra_loss_pct],
      [["a->b"], 80, 5, 0],
    );
    // 80 dB of noise rise at b: no rate decodes, so the MAC gives up; nothing is forced lost.
    const jammed = await pollMetrics(
      client,
      (m) => (link(m, "jammed", "a", "b")?.dropped.retry_exhausted ?? 0) >= 2,
    );
    assertEquals(link(jammed, "jammed", "a", "b").delivered, 0);
    assertEquals(link(jammed, "jammed", "a", "b").dropped.extra_loss, undefined);
    assertEquals(link(jammed, "jammed", "b", "a").delivered > 0, true, "b->a is not jammed");

    assertStringIncludes(
      await client.refused("inject_fault", { link: "a->b", interference_db: -1 }),
      "interference_db",
    );
    await client.ok("stop");
  });
});

Deno.test("mcp drive: get_events follows the stream by sequence number, filtered by type and node", async () => {
  await withServer(async (client) => {
    await client.ok("run_scenario", { path: LIVE });
    await pollStatus(client, (s) => s.state === "running", "the boards to connect");
    await client.ok("move_node", { node: "c", position: [30, 0], phase: "moved" });

    const moves = await client.ok("get_events", { types: ["move", "phase"] });
    assertEquals(moves.state, "running");
    assertEquals(
      moves.events.map((e: Json) => e.type === "move" ? `move ${e.node}` : `phase ${e.label}`),
      // The phase opens at the instant of the move, just before it.
      ["phase moved", "move c"],
    );
    // Nothing new of those types since: the cursor moved past every event read.
    const again = await client.ok("get_events", {
      types: ["move"],
      since_seq: moves.next_since_seq,
    });
    assertEquals(again.events, []);

    // A small limit cuts the stream; the cursor then resumes right after the last one returned.
    const first = await client.ok("get_events", { node: "a", limit: 2 });
    assertEquals([first.events.length, first.truncated], [2, true]);
    assert(first.events.every((e: Json) => e.node === "a" || e.from === "a" || e.to === "a"));
    const next = await client.ok("get_events", {
      node: "a",
      limit: 1,
      since_seq: first.next_since_seq,
    });
    assert(next.events[0].seq > first.events[1].seq);

    assertStringIncludes(
      await client.refused("get_events", { types: ["nope"] }),
      "unknown event type",
    );
    await client.ok("stop");
  });
});

Deno.test("mcp drive: export_capture writes the air mid-run and after stop, inside the workspace", async () => {
  await withServer(async (client, workspace) => {
    assertStringIncludes(await client.refused("export_capture", { kind: "pcap" }), "no run yet");
    await client.ok("run_scenario", { path: LIVE, out: "runs/live" });
    await pollStatus(client, (s) => s.state === "running", "the boards to connect");
    await pollMetrics(client, (m) => (link(m, "start", "a", "b")?.sent ?? 0) >= 2);

    const live = await client.ok("export_capture", { kind: "pcap" });
    assertEquals(live.file, join(workspace, "runs", "live", "air-live.pcap"));
    assert(live.packets > 0);
    const bytes = await Deno.readFile(live.file);
    assertEquals(bytes.length, live.bytes);
    assertEquals(new DataView(bytes.buffer).getUint32(0, true), 0xa1b2c3d4, "pcap magic");

    await client.ok("stop");
    // A stopped run writes no files of its own; the capture is still there to take.
    const after = await client.ok("export_capture", { kind: "pcap", path: "kept/air.pcap" });
    assertEquals([after.file, after.state], [join(workspace, "kept", "air.pcap"), "stopped"]);
    assert(after.packets >= live.packets);

    assertStringIncludes(
      await client.refused("export_capture", { kind: "btsnoop", node: "a" }),
      "BLE",
    );
    assertStringIncludes(
      await client.refused("export_capture", { kind: "pcap", path: "../escape.pcap" }),
      "inside the workspace",
    );
    assertStringIncludes(await client.refused("export_capture", { kind: "zip" }), "kind must be");
  });
});

Deno.test("mcp drive: export_capture takes one BLE node's HCI as btsnoop", async () => {
  await withServer(async (client) => {
    await client.ok("run_scenario", { path: `${EXAMPLES}ble-sensors-scripted.yaml` });
    await pollStatus(client, (s) => s.state === "running", "the boards to connect");
    await pollMetrics(client, (m) => m.links?.some((l: Json) => l.delivered > 0) ?? false);
    const snoop = await client.ok("export_capture", { kind: "btsnoop", node: "gw" });
    assert(snoop.packets > 0);
    const bytes = await Deno.readFile(snoop.file);
    assertEquals(new TextDecoder().decode(bytes.subarray(0, 8)), "btsnoop\0");
    assertStringIncludes(
      await client.refused("export_capture", { kind: "btsnoop" }),
      "needs the node",
    );
    await client.ok("stop");
  });
});

Deno.test("mcp drive: send_serial is refused by a scripted board, which has no console", async () => {
  await withServer(async (client) => {
    assertStringIncludes(
      await client.refused("send_serial", { node: "a", text: "hi" }),
      "no run",
    );
    await client.ok("run_scenario", { path: LIVE });
    await pollStatus(client, (s) => s.state === "running", "the boards to connect");
    assertStringIncludes(
      await client.refused("send_serial", { node: "a", text: "hi" }),
      "scripted board: it has no serial console",
    );
    assertStringIncludes(
      await client.refused("send_serial", { node: "a", text: "hi", data_base64: "aGk=" }),
      "exactly one",
    );
    assertStringIncludes(
      await client.refused("send_serial", { node: "zz", text: "hi" }),
      "no node named",
    );
    await client.ok("stop");
  });
});

// A stand-in for backend/app/services/esp32_worker.py that speaks only its
// stdin/stdout protocol: the firmware's HCI UART sends HCI Reset as `uart_tx`
// on UART1 (so the BLE node connects), and its console echoes every byte that
// `uart_send` puts into UART0 back out of UART0.
const FAKE_CONSOLE_WORKER = `
import base64, json, sys
config = json.loads(sys.stdin.readline())
def emit(event):
    print(json.dumps(event), flush=True)
for byte in (0x01, 0x03, 0x0c, 0x00):
    emit({"type": "uart_tx", "uart": 1, "byte": byte})
for line in sys.stdin:
    command = json.loads(line)
    if command.get("cmd") == "stop":
        break
    if command.get("cmd") == "uart_send" and command.get("uart") == 0:
        for byte in b"echo:" + base64.b64decode(command["data"]):
            emit({"type": "uart_tx", "uart": 0, "byte": byte})
`;

Deno.test("mcp drive: send_serial types into an ESP32's UART0 through the worker, and the answer is in get_serial", async () => {
  const fake = await Deno.makeTempDir({ prefix: "hzb-fake-worker-" });
  try {
    await Deno.writeFile(`${fake}/libqemu-xtensa.so`, new Uint8Array(0));
    // HERTZBENCH_PYTHON runs the worker script; this one ignores it and runs the fake.
    const python = await writeFakePython(fake, FAKE_CONSOLE_WORKER);
    const env = {
      QEMU_ESP32_LIB: `${fake}/libqemu-xtensa.so`,
      HERTZBENCH_PYTHON: python,
    };
    await withServer(async (client, workspace) => {
      await Deno.writeFile(`${workspace}/fw.bin`, new Uint8Array(16));
      await client.ok("create_scenario", {
        path: "console.yaml",
        yaml: `name: console\nduration: 60s\nnodes:\n` +
          `  - { id: a, board: esp32, firmware: ./fw.bin, position: [0, 0], radios: [{ phy: ble }] }\n` +
          `  - { id: b, board: esp32, firmware: ./fw.bin, position: [5, 0], radios: [{ phy: ble }] }\n`,
      });
      await client.ok("run_scenario", { path: "console.yaml" });
      await pollStatus(client, (s) => s.state === "running", "the fake boards to connect");

      const sent = await client.ok("send_serial", { node: "a", text: "status" });
      assertEquals([sent.node, sent.bytes], ["a", 7]);
      await client.ok("send_serial", { node: "a", data_base64: btoa("raw\n") });
      const deadline = performance.now() + 10_000;
      let lines: string[] = [];
      while (lines.length < 2 && performance.now() < deadline) {
        lines = (await client.ok("get_serial", { node: "a" })).lines.map((l: Json) => l.text);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assertEquals(lines, ["echo:status", "echo:raw"]);
      assertEquals((await client.ok("get_serial", { node: "b" })).total, 0, "only a was typed to");
      await client.ok("stop");
    }, env);
  } finally {
    await Deno.remove(fake, { recursive: true });
  }
});

const PAIR = `# two scripted boards
name: pair
seed: 5
duration: 2s
nodes:
  - id: a
    board: scripted
    position: [0, 0]
    firmware: { send: [{ to: b, every: 100ms, count: 5 }] }
  - { id: b, board: scripted, position: [5, 0], firmware: {} }
  - { id: s, count: 2, board: scripted, position: { grid: { origin: [0, 10], step: [5, 0] } }, firmware: {} }
`;

Deno.test("mcp drive: read, edit, add and remove nodes in a scenario file, checked before writing", async () => {
  await withServer(async (client, workspace) => {
    await client.ok("create_scenario", { path: "pair.yaml", yaml: PAIR });
    const read = await client.ok("read_scenario", { path: "pair.yaml" });
    assertEquals([read.valid, read.yaml], [true, PAIR]);
    assertEquals(read.scenario.nodes.map((n: Json) => n.id), ["a", "b", "s-1", "s-2"]);

    const edited = await client.ok("edit_scenario", {
      path: "pair.yaml",
      set: {
        seed: 9,
        environment: { preset: "urban", shadowing_sigma_db: 0 },
        links: [{ from: "a", to: "b", extra_jitter_ms: 3, interference_db: 6 }],
      },
      nodes: { b: { position: [40, 0], radios: [{ phy: "wifi", channel: 6, tx_power_dbm: 8 }] } },
    });
    assertStringIncludes(edited.note, "comments");
    assertEquals(edited.scenario.seed, 9);
    assertEquals(edited.scenario.links, 1);
    const b = edited.scenario.nodes.find((n: Json) => n.id === "b");
    assertEquals([b.position, b.channel], [{ x: 40, y: 0 }, 6]);
    const text = await Deno.readTextFile(`${workspace}/pair.yaml`);
    assertStringIncludes(text, "interference_db: 6");
    assert(!text.includes("# two scripted boards"), "comments do not survive a rewrite");

    const added = await client.ok("add_node", {
      path: "pair.yaml",
      node: { id: "c", board: "scripted", position: [0, 20], firmware: {} },
    });
    assertEquals(added.scenario.nodes.length, 5);
    const removed = await client.ok("remove_node", { path: "pair.yaml", id: "c" });
    assertEquals(removed.scenario.nodes.length, 4);

    // Refusals leave the file exactly as it was.
    const before = await Deno.readTextFile(`${workspace}/pair.yaml`);
    assertStringIncludes(
      await client.refused("remove_node", { path: "pair.yaml", id: "b" }),
      "nothing was written",
    );
    assertStringIncludes(
      await client.refused("edit_scenario", {
        path: "pair.yaml",
        nodes: { "s-2": { position: [1, 1] } },
      }),
      "group s",
    );
    assertStringIncludes(
      await client.refused("edit_scenario", { path: "pair.yaml", set: { duration: "forever" } }),
      "duration",
    );
    assertStringIncludes(
      await client.refused("edit_scenario", {
        path: "pair.yaml",
        set: JSON.parse('{"__proto__": {"polluted": true}}'),
      }),
      "not allowed",
    );
    assertStringIncludes(
      await client.refused("add_node", { path: "pair.yaml", node: { id: "a", board: "scripted" } }),
      "already exists",
    );
    assertEquals(await Deno.readTextFile(`${workspace}/pair.yaml`), before);
    assertStringIncludes(
      await client.refused("edit_scenario", { path: LIVE, set: { seed: 1 } }),
      "inside the workspace",
    );

    // A node edited in the file is the node the next run plays.
    await client.ok("run_scenario", { path: "pair.yaml" });
    const status = await pollStatus(client, (s) => s.state === "running", "the boards to connect");
    assertEquals(status.nodes.find((n: Json) => n.id === "b").position, { x: 40, y: 0 });
    assertEquals(status.seed, 9);
    await client.ok("stop");
  });
});

Deno.test("mcp drive: edit_scenario sets doors and interference, refuses a bad one by field", async () => {
  await withServer(async (client, workspace) => {
    await client.ok("create_scenario", { path: "pair.yaml", yaml: PAIR });
    const edited = await client.ok("edit_scenario", {
      path: "pair.yaml",
      set: {
        environment: {
          obstacles: [{ id: "front-door", polygon: [[2, -5], [2, 5]], attenuation_db: 12 }],
          interference: [{
            id: "oven",
            position: [3, 3],
            power_dbm: 20,
            band: "2.4ghz",
            from: "1s",
          }],
        },
        timeline: [{ at: "2s", obstacle: { id: "front-door", attenuation_db: 0 } }],
      },
    });
    assertEquals(edited.scenario.nodes.length, 4);
    const text = await Deno.readTextFile(`${workspace}/pair.yaml`);
    assertStringIncludes(text, "front-door");
    assertStringIncludes(text, "oven");

    const before = await Deno.readTextFile(`${workspace}/pair.yaml`);
    assertStringIncludes(
      await client.refused("edit_scenario", {
        path: "pair.yaml",
        set: { timeline: [{ at: "2s", obstacle: { id: "back-door", attenuation_db: 0 } }] },
      }),
      "timeline[0].obstacle.id",
    );
    assertStringIncludes(
      await client.refused("edit_scenario", {
        path: "pair.yaml",
        set: {
          environment: {
            interference: [{ id: "x", position: [0, 0], power_dbm: 1, band: "5ghz" }],
          },
        },
      }),
      "environment.interference[0].band",
    );
    assertEquals(await Deno.readTextFile(`${workspace}/pair.yaml`), before);
  });
});

Deno.test("mcp drive: set_channel and set_radio change a live Wi-Fi run; start_phase marks it", async () => {
  await withServer(async (client) => {
    await client.ok("run_scenario", { path: LIVE });
    await pollStatus(client, (s) => s.state === "running", "the boards to connect");

    const quiet = await client.ok("set_radio", { node: "c", antenna_gain_dbi: 0 });
    const rssi = (r: Json, to: string) => r.links.find((l: Json) => l.link === `c->${to}`).rssi_dbm;
    const louder = await client.ok("set_radio", { node: "c", tx_power_dbm: 25 });
    assert(rssi(louder, "a") > rssi(quiet, "a"), `${rssi(quiet, "a")} -> ${rssi(louder, "a")}`);

    const channel = await client.ok("set_channel", {
      path_loss_exponent: 4,
      obstacles: [{ id: "lobby-door", polygon: [[1, -50], [1, 50]], attenuation_db: 20 }],
      phase: "harsh",
    });
    assertEquals(channel.phase, "harsh");
    assertEquals(channel.changes.obstacles.length, 1);
    assertEquals(channel.changes.obstacles[0].id, "lobby-door");
    const harsh = await client.ok("set_radio", { node: "c", tx_power_dbm: 25 });
    assert(rssi(harsh, "a") < rssi(louder, "a") - 20, "steeper path loss and a wall");

    await client.ok("set_radio", { node: "b", channel: 11, phase: "b-retuned" });
    const retuned = await pollMetrics(
      client,
      (m) => (link(m, "b-retuned", "a", "b")?.dropped.channel_mismatch ?? 0) >= 2,
    );
    assertEquals(link(retuned, "b-retuned", "a", "b").delivered, 0);
    await client.ok("start_phase", { label: "calm" });
    const changes = await client.ok("get_events", { types: ["channel", "radio", "phase"] });
    assertEquals(
      changes.events.map((e: Json) => e.type === "phase" ? e.label : e.type),
      ["radio", "radio", "harsh", "channel", "radio", "b-retuned", "radio", "calm"],
    );

    assertStringIncludes(await client.refused("set_channel", {}), "nothing to change");
    assertStringIncludes(
      await client.refused("set_channel", { path_loss_exponent: 0.5 }),
      "path_loss_exponent",
    );
    assertStringIncludes(await client.refused("set_radio", { node: "c", channel: 15 }), "channel");
    await client.ok("stop");
    assertStringIncludes(await client.refused("start_phase", { label: "x" }), "no run in progress");
  });
});

Deno.test("mcp drive: on a LoRa run only the antenna gain is the medium's to change", async () => {
  await withServer(async (client) => {
    await client.ok("run_scenario", { path: `${EXAMPLES}lora-gateway-6-scripted.yaml` });
    await pollStatus(client, (s) => s.state === "running", "the boards to connect");
    assertStringIncludes(
      await client.refused("set_radio", { node: "gw", tx_power_dbm: 20 }),
      "only antenna_gain_dbi",
    );
    assertStringIncludes(
      await client.refused("set_channel", { noise_figure_db: 3 }),
      "chip's own receiver noise figure",
    );
    const before = await client.ok("set_radio", { node: "gw", antenna_gain_dbi: 0 });
    const after = await client.ok("set_radio", { node: "gw", antenna_gain_dbi: 9 });
    const snr = (r: Json) => r.links.find((l: Json) => l.link === "gw->node-1").snr_db;
    assertAlmostEquals(snr(after), snr(before) + 9, 1e-6);
    await client.ok("set_channel", { shadowing_sigma_db: 2, base_latency_ms: 1 });
    await client.ok("stop");
  });
});

Deno.test("mcp drive: open_view serves the agent's run once; get_view_state draws a LoRa run's links", async () => {
  await withServer(async (client) => {
    const opened = await client.ok("open_view", {});
    assertEquals(opened.already_open, false);
    const again = await client.ok("open_view", { port: 1 });
    assertEquals(again, { url: opened.url, already_open: true });

    await client.ok("run_scenario", { path: `${EXAMPLES}lora-gateway-6-scripted.yaml` });
    await pollStatus(client, (s) => s.state === "running", "the boards to connect");
    const state = await client.ok("get_view_state", {});
    assertEquals(state.scene.phy, "lora");
    assertEquals(state.scene.links.length, 42);
    const gw = state.scene.links.find((l: Json) => l.from === "node-1" && l.to === "gw");
    assertEquals([gw.signal, gw.required_snr_db], ["good", -7.5]);
    const page = await fetch(new URL("/api/view", opened.url));
    const served = await page.json();
    assertEquals(served.scene.links.length, 42, "the page and the tool show the same links");
    assertEquals(served.status.run_id, state.status.run_id);
    await client.ok("stop");
  });
});

Deno.test("mcp drive: get_report gives the CLI's report once the run has finished", async () => {
  await withServer(async (client) => {
    await client.ok("create_scenario", { path: "pair.yaml", yaml: PAIR });
    await client.ok("run_scenario", { path: "pair.yaml" });
    assertStringIncludes(await client.refused("get_report"), "when a run finishes");
    await pollStatus(client, (s) => s.state === "finished", "the run to finish");
    const { report } = await client.ok("get_report");
    assertStringIncludes(report, "pair  (seed 5, 2000 ms)");
    assertStringIncludes(report, "RESULT: PASS");
  });
});

const PAYLOADS = `name: payloads
seed: 5
duration: 60s
environment: { shadowing_sigma_db: 0 }
nodes:
  - id: broker
    board: scripted
    position: [0, 0]
    firmware: { serve: [{ port: 1883, protocol: mqtt }, { port: 80, protocol: http }] }
  - id: valve
    board: scripted
    position: [6, 0]
    firmware: { subscribe: [{ to: broker, topic: 'riego/#' }] }
  - { id: panel, board: scripted, position: [-6, 0], firmware: {} }
`;

/** Poll get_serial until `node` has printed a line containing `text`; fails instead of hanging. */
async function serialContains(client: McpClient, node: string, text: string): Promise<string[]> {
  const deadline = performance.now() + 10_000;
  for (;;) {
    const lines = (await client.ok("get_serial", { node })).lines.map((l: Json) => l.text);
    if (lines.some((line: string) => line.includes(text))) return lines;
    if (performance.now() > deadline) {
      throw new Error(`${node} never printed ${text}: ${JSON.stringify(lines)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function runPayloads(client: McpClient): Promise<void> {
  await client.ok("create_scenario", { path: "payloads.yaml", yaml: PAYLOADS });
  await client.ok("run_scenario", { path: "payloads.yaml" });
  await pollStatus(client, (s) => s.state === "running", "the boards to connect");
  await serialContains(client, "valve", "mqtt connected to broker");
}

Deno.test("mcp drive: mqtt_publish publishes through the broker node to a subscribed board, retained or not", async () => {
  await withServer(async (client) => {
    await runPayloads(client);

    const sent = await client.ok("mqtt_publish", {
      node: "broker",
      topic: "riego/bomba",
      payload: "ON",
    });
    assertEquals(
      [sent.node, sent.topic, sent.bytes, sent.retain, sent.delivered_to],
      ["broker", "riego/bomba", 2, false, 1],
    );
    await serialContains(client, "valve", "mqtt rx riego/bomba ON");
    await serialContains(client, "broker", 'mqtt publish riego/bomba "ON" from mcp');

    // Retained, on the one MQTT port of the node (given explicitly this time).
    const kept = await client.ok("mqtt_publish", {
      node: "broker",
      topic: "riego/estado",
      payload: "REGANDO",
      retain: true,
      port: 1883,
    });
    assertEquals([kept.retain, kept.delivered_to], [true, 1]);
    await serialContains(client, "valve", "mqtt rx riego/estado REGANDO");
    // A topic nobody follows reaches no session; an empty retained payload is allowed.
    assertEquals(
      (await client.ok("mqtt_publish", { node: "broker", topic: "x/y", payload: "" }))
        .delivered_to,
      0,
    );
    await client.ok("stop");
  });
});

Deno.test("mcp drive: mqtt_publish refuses a node that is not a broker, and bad arguments", async () => {
  await withServer(async (client) => {
    const publish = { topic: "riego/bomba", payload: "ON" };
    assertStringIncludes(
      await client.refused("mqtt_publish", { node: "broker", ...publish }),
      "no run yet",
    );
    await runPayloads(client);
    assertStringIncludes(
      await client.refused("mqtt_publish", { node: "valve", ...publish }),
      "valve serves no MQTT broker",
    );
    assertStringIncludes(
      await client.refused("mqtt_publish", { node: "broker", port: 80, ...publish }),
      "broker serves no MQTT broker on port 80 (its MQTT ports: 1883)",
    );
    assertStringIncludes(
      await client.refused("mqtt_publish", { node: "zz", ...publish }),
      "no node named",
    );
    assertStringIncludes(
      await client.refused("mqtt_publish", { node: "broker", topic: "a/+", payload: "x" }),
      "no + or # wildcard",
    );
    assertStringIncludes(
      await client.refused("mqtt_publish", { node: "broker", topic: "t", payload: 1 }),
      "payload must be a string",
    );
    assertStringIncludes(
      await client.refused("mqtt_publish", {
        node: "broker",
        topic: "t",
        payload: "x".repeat(4097),
      }),
      "at most 4096 bytes",
    );
    await client.ok("stop");
  });
});

Deno.test("mcp drive: send_payload makes a scripted board send once by udp, espnow and mqtt", async () => {
  await withServer(async (client) => {
    await runPayloads(client);

    const udp = await client.ok("send_payload", {
      node: "panel",
      to: "valve",
      via: "udp",
      payload: "hola",
    });
    assertEquals([udp.node, udp.to, udp.via, udp.bytes], ["panel", "valve", "udp", 4]);
    await serialContains(client, "valve", "rx hola from panel");

    await client.ok("send_payload", { node: "panel", to: "valve", via: "espnow", payload: "e1" });
    await serialContains(client, "valve", "espnow rx e1 from panel");
    await serialContains(client, "panel", "espnow tx ok to valve");
    await client.ok("send_payload", {
      node: "panel",
      to: "broadcast",
      via: "espnow",
      payload: "todos",
    });
    await serialContains(client, "valve", "espnow rx todos from panel");

    // `panel` has no MQTT in its script: the call opens a session to the broker, then publishes.
    const mqtt = await client.ok("send_payload", {
      node: "panel",
      to: "broker",
      via: "mqtt",
      topic: "riego/cmd",
      payload: "ABRIR",
    });
    assertEquals([mqtt.via, mqtt.topic], ["mqtt", "riego/cmd"]);
    await serialContains(client, "valve", "mqtt rx riego/cmd ABRIR");
    await serialContains(client, "broker", 'mqtt publish riego/cmd "ABRIR" from panel');
    // The session stays open: a second send needs no waiting and reaches the same subscriber.
    await client.ok("send_payload", {
      node: "panel",
      to: "broker",
      via: "mqtt",
      topic: "riego/cmd",
      payload: "CERRAR",
    });
    await serialContains(client, "valve", "mqtt rx riego/cmd CERRAR");
    await client.ok("stop");
  });
});

Deno.test("mcp drive: send_payload refuses what the board cannot send, naming the field", async () => {
  await withServer(async (client) => {
    const udp = { node: "panel", to: "valve", via: "udp", payload: "x" };
    assertStringIncludes(await client.refused("send_payload", udp), "no run yet");
    await runPayloads(client);
    const cases: [Record<string, unknown>, string][] = [
      [{ ...udp, to: "zz" }, "no node named"],
      [{ ...udp, node: "zz" }, "no node named"],
      [{ ...udp, to: "panel" }, "cannot send to itself"],
      [{ ...udp, to: "broadcast" }, '"broadcast" needs via: espnow'],
      [{ ...udp, via: "frob" }, "via must be one of udp, espnow, mqtt, gatt"],
      [{ ...udp, topic: "t" }, "topic needs via: mqtt"],
      [{ ...udp, via: "espnow", port: 5000 }, "ESP-NOW has no ports"],
      [{ ...udp, via: "gatt" }, "panel is a Wi-Fi board"],
      [{ ...udp, via: "gatt", port: 5000 }, "GATT has no ports"],
      [{ ...udp, via: "espnow", payload: "x".repeat(251) }, "at most 250 bytes"],
      [{ ...udp, payload: "x".repeat(1473) }, "at most 1472 bytes"],
      [{ ...udp, payload: "" }, "payload must be a non-empty string"],
      [{ ...udp, via: "mqtt" }, "topic: expected a non-empty string"],
      [{ ...udp, via: "mqtt", topic: "a/#" }, "no + or # wildcard"],
      [{ ...udp, via: "mqtt", topic: "t" }, "valve serves no MQTT broker on port 1883"],
      [
        { ...udp, to: "broker", via: "mqtt", topic: "t", port: 80 },
        "serves no MQTT broker on port 80",
      ],
    ];
    for (const [args, message] of cases) {
      assertStringIncludes(await client.refused("send_payload", args), message);
    }
    await client.ok("stop");
  });
});

Deno.test("mcp drive: send_payload sends over a BLE connection from either end, and refuses without one", async () => {
  await withServer(async (client) => {
    await client.ok("run_scenario", { path: `${EXAMPLES}ble-sensors-scripted.yaml` });
    await pollStatus(client, (s) => s.state === "running", "the boards to connect");
    await serialContains(client, "gw", "ble connected to sensor-1 as central");
    await serialContains(client, "sensor-1", "ble connected to gw as peripheral");

    // The central writes to a peripheral; the peripheral notifies the central.
    const write = await client.ok("send_payload", {
      node: "gw",
      to: "sensor-1",
      via: "gatt",
      payload: "hola",
    });
    assertEquals([write.node, write.to, write.via, write.bytes], ["gw", "sensor-1", "gatt", 4]);
    await serialContains(client, "sensor-1", 'ble rx "hola" from gw');
    await client.ok("send_payload", { node: "sensor-1", to: "gw", via: "gatt", payload: "pong" });
    await serialContains(client, "gw", 'ble rx "pong" from sensor-1');

    const ble = { node: "gw", to: "sensor-1", via: "gatt", payload: "x" };
    for (
      const [args, message] of [
        [{ ...ble, payload: "x".repeat(21) }, "at most 20 bytes"],
        [{ ...ble, node: "sensor-2" }, "sensor-2 is not connected to sensor-1"],
        [{ ...ble, via: "udp" }, "gw is a BLE board: it sends via: gatt, not udp"],
      ] as [Record<string, unknown>, string][]
    ) {
      assertStringIncludes(await client.refused("send_payload", args), message);
    }
    await client.ok("stop");
  });
});

Deno.test("mcp drive: mqtt_publish and send_payload refuse a board that is not scripted Wi-Fi", async () => {
  await withServer(async (client) => {
    await client.ok("run_scenario", { path: `${EXAMPLES}lora-gateway-6-scripted.yaml` });
    await pollStatus(client, (s) => s.state === "running", "the boards to connect");
    assertStringIncludes(
      await client.refused("mqtt_publish", { node: "gw", topic: "t", payload: "x" }),
      "gw is a scripted board on lora: this needs a scripted Wi-Fi board serving MQTT",
    );
    assertStringIncludes(
      await client.refused("send_payload", {
        node: "node-1",
        to: "gw",
        via: "udp",
        payload: "x",
      }),
      "node-1 is a scripted board on lora: this needs a scripted Wi-Fi or BLE board",
    );
    await client.ok("stop");
  });
});

// No tool may run a host command, directly or by proxy: no argument names a
// program, an interpreter, a library or the environment it runs in.
const HOST_EXEC_KEYS =
  /^(command|cmd|commands|shell|exec|execute|argv|args|env|environment_variables|interpreter|python|program|binary|executable|library|lib|lib_path|script|cwd)$/i;

Deno.test("mcp drive: no tool takes a command, a program or an environment to run", async () => {
  await withServer(async (client) => {
    const listed = (await client.request("tools/list")).result!.tools as Json[];
    assert(listed.length >= 20, `${listed.length} tools`);
    const keys = (schema: Json, path: string): string[] => {
      if (typeof schema !== "object" || schema === null) return [];
      return Object.entries(schema.properties ?? {}).flatMap(([key, sub]) => [
        `${path}.${key}`,
        ...keys(sub, `${path}.${key}`),
        ...keys((sub as Json).items, `${path}.${key}[]`),
      ]);
    };
    for (const tool of listed) {
      assert(!/exec|shell|command|spawn/i.test(tool.name), tool.name);
      for (const key of keys(tool.inputSchema, tool.name)) {
        assert(!HOST_EXEC_KEYS.test(key.split(".").pop()!.replace("[]", "")), key);
      }
    }
  });
});
