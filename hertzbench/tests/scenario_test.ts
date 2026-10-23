import { assert, assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import {
  matchesPattern,
  parseDuration,
  parseScenario,
  ScenarioError,
} from "../orchestrator/mod.ts";

const MINIMAL = `
name: t
duration: 10s
nodes:
  - { id: a, board: scripted, position: [0, 0] }
  - { id: b, board: scripted, position: [5, 0] }
`;

function expectError(yaml: string, fragment: string): void {
  const error = assertThrows(() => parseScenario(yaml), ScenarioError);
  assert(error.message.includes(fragment), `expected "${fragment}" in: ${error.message}`);
}

Deno.test("durations need a unit", () => {
  assertEquals(parseDuration("500ms", "d"), 500);
  assertEquals(parseDuration("60s", "d"), 60_000);
  assertEquals(parseDuration("1.5s", "d"), 1500);
  assertEquals(parseDuration("2m", "d"), 120_000);
  assertThrows(() => parseDuration(60, "d"), ScenarioError, "unit");
  assertThrows(() => parseDuration("soon", "d"), ScenarioError, "not a duration");
});

Deno.test("patterns: * matches any run, everything else is literal", () => {
  assert(matchesPattern("sensor-*", "sensor-4"));
  assert(matchesPattern("*", "gw"));
  assert(matchesPattern("a.b", "a.b"));
  assert(!matchesPattern("a.b", "axb"));
  assert(!matchesPattern("sensor-*", "gw"));
});

Deno.test("a minimal scenario gets sensible defaults", () => {
  const s = parseScenario(MINIMAL);
  assertEquals(s.seed, 1);
  assertEquals(s.durationMs, 10_000);
  assertEquals(s.environment.preset, "indoor_office");
  assertEquals(s.retryLimit, 7);
  assertEquals(s.nodes.map((n) => [n.id, n.ip, n.mac]), [
    ["a", "192.168.4.11", "02:68:7a:62:01:01"],
    ["b", "192.168.4.12", "02:68:7a:62:01:02"],
  ]);
  assertEquals(s.nodes[0]!.radio, { channel: 6, txPowerDbm: 15, antennaGainDbi: 0 });
});

Deno.test("count expands to id-1..n on a grid, with distinct addresses and MACs", () => {
  const s = parseScenario(`
name: grid
duration: 5s
nodes:
  - { id: gw, board: scripted, position: [0, 0] }
  - id: sensor
    count: 4
    board: scripted
    position: { grid: { origin: [10, 0], step: [8, 0] } }
`);
  assertEquals(s.nodes.map((n) => n.id), ["gw", "sensor-1", "sensor-2", "sensor-3", "sensor-4"]);
  assertEquals(s.nodes.slice(1).map((n) => n.position.x), [10, 18, 26, 34]);
  assertEquals(new Set(s.nodes.map((n) => n.mac)).size, 5);
  assertEquals(new Set(s.nodes.map((n) => n.ip)).size, 5);
});

Deno.test("obstacles: two points are one wall, three or more a closed outline", () => {
  const s = parseScenario(MINIMAL.replace(
    "nodes:",
    `environment:
  obstacles:
    - { polygon: [[5, 0], [5, 10]], attenuation_db: 12 }
    - { polygon: [[0, 0], [4, 0], [4, 4]], attenuation_db: 6 }
nodes:`,
  ));
  assertEquals(s.environment.obstacles.length, 1 + 3);
  assertEquals(s.environment.obstacles[0]!.attenuationDb, 12);
});

Deno.test("environment overrides reach the model", () => {
  const s = parseScenario(MINIMAL.replace(
    "nodes:",
    `environment: { preset: urban, path_loss_exponent: 4.1, shadowing_sigma_db: 0, retry_limit: 3 }
nodes:`,
  ));
  assertEquals(s.environment.preset, "urban");
  assertAlmostEquals(s.environment.pathLossExponent, 4.1);
  assertEquals(s.environment.shadowingSigmaDb, 0);
  assertEquals(s.retryLimit, 3);
});

Deno.test("the esp32 board and its alias both map to the esp32 kind; C3 and S3 are refused with the reason", () => {
  const kinds = parseScenario(`
name: boards
duration: 5s
nodes:
  - { id: a, board: esp32, firmware: ./fw/x, position: [0, 0] }
  - { id: b, board: esp32-devkit-v1, firmware: ./fw/x, position: [1, 0] }
`).nodes.map((n) => n.board);
  assertEquals(kinds, ["esp32", "esp32"]);
  expectError(
    MINIMAL.replace(
      "board: scripted, position: [5, 0]",
      "board: esp32-c3, firmware: ./x, position: [5, 0]",
    ),
    "eFuse",
  );
  expectError(
    MINIMAL.replace(
      "board: scripted, position: [5, 0]",
      "board: esp32-s3, firmware: ./x, position: [5, 0]",
    ),
    "no radio",
  );
});

Deno.test("firmware: a .bin is a binary, anything else a sketch directory", () => {
  const s = parseScenario(`
name: fw
duration: 5s
nodes:
  - { id: a, board: esp32, firmware: ./fw/app.bin, position: [0, 0] }
  - { id: b, board: esp32, firmware: ./fw/sketch, position: [1, 0] }
`);
  assertEquals(s.nodes.map((n) => n.firmware), [
    { kind: "binary", path: "./fw/app.bin" },
    { kind: "sketch", path: "./fw/sketch" },
  ]);
});

Deno.test("validation errors name the field", () => {
  expectError("name: t\nduration: 10\nnodes: []", "duration");
  expectError(MINIMAL.replace("duration: 10s", "duration: 10s\nbogus: 1"), "scenario.bogus");
  expectError(MINIMAL.replace("{ id: b,", "{ id: a,"), "duplicate node id");
  expectError(MINIMAL.replace("[5, 0]", "[5]"), "nodes[1].position");
  expectError(MINIMAL.replace("duration: 10s\n", ""), "duration");
  expectError("nodes: [", "not valid YAML");
  expectError("- 1", "expected a mapping");
  expectError(MINIMAL.replace("nodes:", "environment: { preset: moon }\nnodes:"), "unknown preset");
  expectError(MINIMAL.replace("nodes:", "network: { subnet: 10.0.0.0/16 }\nnodes:"), "/24");
});

Deno.test("Phase 1 scale: 2 to 10 boards", () => {
  expectError(
    "name: t\nduration: 5s\nnodes:\n  - { id: a, board: scripted, position: [0, 0] }",
    "2 to 10",
  );
  const eleven = Array.from(
    { length: 11 },
    (_, i) => `  - { id: n${i}, board: scripted, position: [${i}, 0] }`,
  );
  expectError(`name: t\nduration: 5s\nnodes:\n${eleven.join("\n")}`, "2 to 10");
  const ten = Array.from(
    { length: 10 },
    (_, i) => `  - { id: n${i}, board: scripted, position: [${i}, 0] }`,
  );
  assertEquals(parseScenario(`name: t\nduration: 5s\nnodes:\n${ten.join("\n")}`).nodes.length, 10);
});

Deno.test("one radio per node, wifi only, in range", () => {
  expectError(
    MINIMAL.replace("position: [0, 0] }", "position: [0, 0], radios: [{ phy: lora }] }"),
    "wifi",
  );
  expectError(
    MINIMAL.replace(
      "position: [0, 0] }",
      "position: [0, 0], radios: [{ phy: wifi, channel: 20 }] }",
    ),
    "channel",
  );
  expectError(
    MINIMAL.replace(
      "position: [0, 0] }",
      "position: [0, 0], radios: [{ phy: wifi }, { phy: wifi }] }",
    ),
    "exactly one",
  );
});

Deno.test("references are checked: nodes, patterns, phases, times", () => {
  expectError(MINIMAL + "links: [{ from: ghost, to: b, extra_loss_pct: 5 }]", "matches no node");
  expectError(
    MINIMAL + "timeline: [{ at: 1s, move: { node: ghost, to: [1, 1] } }]",
    "no node named",
  );
  expectError(MINIMAL + "timeline: [{ at: 99s, move: { node: a, to: [1, 1] } }]", "after the end");
  expectError(MINIMAL + "assertions: [{ serial: { node: ghost, contains: x } }]", "no node named");
  expectError(
    MINIMAL + "assertions: [{ metric: { link: 'a->b', phase: far, loss_pct: { lt: 1 } } }]",
    "no timeline label",
  );
  expectError(
    MINIMAL + "assertions: [{ metric: { link: 'a->b', loss_pct: { near: 1 } } }]",
    "unknown comparison",
  );
  expectError(MINIMAL + "assertions: [{ metric: { link: 'a->b' } }]", "at least one");
});

Deno.test("the internet gateway keeps SLIRP: at most one, an esp32, off the medium", () => {
  const withGateway = `
name: gw
duration: 5s
nodes:
  - { id: a, board: scripted, position: [0, 0] }
  - { id: b, board: scripted, position: [5, 0] }
  - { id: net, board: esp32, firmware: ./fw/x, position: [9, 9], internet_gateway: true }
`;
  const s = parseScenario(withGateway);
  assertEquals(s.nodes.filter((n) => n.internetGateway).map((n) => n.id), ["net"]);
  expectError(
    withGateway.replace("board: esp32, firmware: ./fw/x,", "board: scripted,"),
    "single esp32",
  );
  expectError(
    withGateway +
      "  - { id: net2, board: esp32, firmware: ./fw/x, position: [8, 8], internet_gateway: true }",
    "at most one",
  );
  expectError(
    withGateway + "timeline: [{ at: 1s, move: { node: net, to: [1, 1] } }]",
    "not on the medium",
  );
  expectError(
    withGateway.replace("  - { id: b, board: scripted, position: [5, 0] }\n", ""),
    "at least two nodes must be on the medium",
  );
});

Deno.test("scripted sends must name another node on the medium", () => {
  const withSend = (to: string) =>
    MINIMAL.replace(
      "{ id: a, board: scripted, position: [0, 0] }",
      `{ id: a, board: scripted, position: [0, 0], firmware: { send: [{ to: ${to}, every: 50ms, count: 3 }] } }`,
    );
  assertEquals(parseScenario(withSend("b")).nodes[0]!.firmware.kind, "script");
  expectError(withSend("ghost"), "no node named");
  expectError(withSend("a"), "itself");
});

Deno.test("an explicit ip must be a usable host address inside the subnet", () => {
  const withIp = (ip: string) =>
    MINIMAL.replace("{ id: a, board: scripted,", `{ id: a, ip: ${ip}, board: scripted,`);
  assertEquals(parseScenario(withIp("192.168.4.50")).nodes[0]!.ip, "192.168.4.50");
  expectError(withIp("192.168.5.50"), "not inside 192.168.4.0/24");
  expectError(withIp("192.168.4.0"), "cannot be used");
  expectError(withIp("192.168.4.1"), "gateway");
  expectError(withIp("192.168.4.255"), "broadcast");
  expectError(withIp("not-an-ip"), "not inside");
  expectError(
    MINIMAL.replace("{ id: a, board: scripted,", "{ id: a, ip: 192.168.4.12, board: scripted,"),
    "share the address 192.168.4.12",
  );
});
