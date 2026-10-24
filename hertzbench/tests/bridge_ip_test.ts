// Phase 5a end to end, without QEMU: a client on the host reaches a scripted
// node through the IP bridge over HTTP, WebSocket and MQTT, and the bridge's
// link to the node is the channel model's.

import { fileURLToPath } from "node:url";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type LiveRun,
  loadScenario,
  parseScenario,
  renderReport,
  runScenario,
} from "../orchestrator/mod.ts";

const EXAMPLES = fileURLToPath(new URL("../scenarios/examples/", import.meta.url));

const SCENARIO = `
name: bridge-ip
seed: 5
duration: 12s
environment: { preset: indoor_office, shadowing_sigma_db: 0 }
nodes:
  - id: web
    board: scripted
    position: [0, 0]
    radios: [{ phy: wifi, channel: 5 }]
    firmware: { serve: [{ port: 80, protocol: http }, { port: 1883, protocol: mqtt }] }
  - id: sensor
    board: scripted
    position: [8, 0]
    radios: [{ phy: wifi, channel: 5 }]
    firmware: { send: [{ to: web, every: 500ms, count: 20, payload: ping }] }
bridge:
  position: [3, 0]
  expose:
    - { node: web, port: 80, service: http }
    - { node: web, port: 1883, service: mqtt }
assertions:
  - serial: { node: web, contains: "http GET /status from 192.168.4.250" }
  - metric: { link: "phone->web", kind: tcp, delivered: { gt: 5 } }
`;

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = performance.now();
  const value = await fn();
  return [value, performance.now() - start];
}

async function get(port: number, path: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  return await response.text();
}

function websocketEcho(port: number, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.onopen = () => ws.send(message);
    ws.onmessage = (event) => {
      resolve(String(event.data));
      ws.close();
    };
    ws.onerror = () => reject(new Error("websocket failed"));
  });
}

/** MQTT 3.1.1 written out byte by byte, so the broker is not checked against its own encoder. */
async function mqttRoundTrip(port: number): Promise<string> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  const read = async (n: number) => {
    const out = new Uint8Array(n);
    let got = 0;
    while (got < n) {
      const r = await conn.read(out.subarray(got));
      if (r === null) throw new Error("broker closed the connection");
      got += r;
    }
    return out;
  };
  // CONNECT: "MQTT", level 4, clean session, keep-alive 60 s, client id "ph".
  await conn.write(Uint8Array.of(0x10, 14, 0, 4, 77, 81, 84, 84, 4, 2, 0, 60, 0, 2, 112, 104));
  assertEquals([...await read(4)], [0x20, 2, 0, 0]);
  // SUBSCRIBE id 1 to "t/#" at QoS 0.
  await conn.write(Uint8Array.of(0x82, 8, 0, 1, 0, 3, 116, 47, 35, 0));
  assertEquals([...await read(5)], [0x90, 3, 0, 1, 0]);
  // PUBLISH "t/a" = "hi" at QoS 0; the broker sends it back to this subscriber.
  await conn.write(Uint8Array.of(0x30, 7, 0, 3, 116, 47, 97, 104, 105));
  const back = await read(9);
  conn.close();
  assertEquals([...back.subarray(0, 7)], [0x30, 7, 0, 3, 116, 47, 97]);
  return new TextDecoder().decode(back.subarray(7));
}

Deno.test("bridge ip: HTTP, WebSocket and MQTT reach a scripted node over the medium", async () => {
  const out = await Deno.makeTempDir({ prefix: "hzb-bridge-ip-" });
  let underway: (live: LiveRun) => void = () => {};
  const live = new Promise<LiveRun>((resolve) => (underway = resolve));
  const run = runScenario(parseScenario(SCENARIO), {
    outDir: out,
    outputs: {
      metrics: `${out}/metrics.json`,
      pcap: `${out}/air.pcap`,
      events: `${out}/events.jsonl`,
    },
    onUnderway: underway,
  });
  const control = await live;
  const endpoints = control.bridge()?.kind === "ip" ? control.bridge() : null;
  assert(endpoints?.kind === "ip");
  const http = endpoints.endpoints.find((e) => e.service === "http");
  const mqtt = endpoints.endpoints.find((e) => e.service === "mqtt");
  assert(http && mqtt && http.hostPort > 0 && mqtt.hostPort > 0);
  // Until the scripted node has its lease it has no TCP, and a SYN waits out the 1 s retransmission timer.
  const listening = () =>
    control.events().filter((e) =>
      e.type === "serial" && e.node === "web" && e.text.startsWith("tcp listening on ")
    ).length;
  for (const deadline = Date.now() + 10_000; listening() < 2;) {
    if (Date.now() > deadline) throw new Error("the web node never opened its ports");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assertEquals(await get(http.hostPort, "/warm-up"), "web: GET /warm-up\n");

  const [first, nearMs] = await timed(() => get(http.hostPort, "/status"));
  assertEquals(first, "web: GET /status\n");
  // 150 ms each way on the bridge's link: the handshake and the request take at least four crossings.
  control.setLink({ from: "phone", to: "web", extraLossPct: 0, extraLatencyMs: 150 });
  control.setLink({ from: "web", to: "phone", extraLossPct: 0, extraLatencyMs: 150 });
  const [second, slowMs] = await timed(() => get(http.hostPort, "/status"));
  assertEquals(second, "web: GET /status\n");
  assert(slowMs > nearMs + 450, `the slow link should cost 600 ms, took ${slowMs} vs ${nearMs}`);
  control.setLink({ from: "*", to: "*", extraLossPct: 0, extraLatencyMs: 0 });

  assertEquals(await websocketEcho(http.hostPort, "hello"), "hello");
  assertEquals(await mqttRoundTrip(mqtt.hostPort), "hi");

  const result = await run;
  const serial = (node: string) =>
    result.events.flatMap((e) => (e.type === "serial" && e.node === node ? [e.text] : []));
  assertEquals(result.problems, []);
  assertEquals(result.passed, true, renderReport(result));
  assertStringIncludes(serial("web").join("\n"), 'ws rx "hello" from 192.168.4.250');
  assertStringIncludes(serial("web").join("\n"), 'mqtt publish t/a "hi" from ph');
  assert(serial("phone").some((l) => /bridge 127\.0\.0\.1:\d+ -> web:80 connected/.test(l)));
  // Both directions of the bridge's TCP crossed the medium and were judged by the channel model.
  const tcp = (from: string, to: string) =>
    result.events.filter((e) =>
      e.type === "deliver" && e.kind === "tcp" && e.from === from && e.to === to
    ).length;
  assert(tcp("phone", "web") > 5 && tcp("web", "phone") > 5);
  const report = renderReport(result);
  assertStringIncludes(report, "Mobile bridge");
  assertStringIncludes(report, "bridge: the phone's TCP ends at the host proxy");
  const metrics = JSON.parse(await Deno.readTextFile(`${out}/metrics.json`));
  assertEquals(metrics.bridge.kind, "ip");
  assertEquals(metrics.nodes.at(-1).board, "bridge");
  await Deno.remove(out, { recursive: true });
});

Deno.test("bridge ip: the example scenario is valid", async () => {
  const loaded = await loadScenario(`${EXAMPLES}bridge-web-scripted.yaml`);
  assertEquals(loaded.scenario.bridge?.kind, "ip");
});
