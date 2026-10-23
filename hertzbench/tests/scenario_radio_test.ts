// LoRa and nRF24 radios in a scenario: defaults, SF/BW/CR, pins, and the
// rules that keep a scenario to one PHY.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { parseScenario, ScenarioError } from "../orchestrator/scenario.ts";

function scenario(radio: string, extra = "", firmwareA = "{ send: [{ every: 1s, count: 2 }] }") {
  return `
name: radios
duration: 5s
nodes:
  - { id: a, board: scripted, position: [0, 0], radios: [${radio}], firmware: ${firmwareA}${extra} }
  - { id: b, board: scripted, position: [100, 0], radios: [${radio}], firmware: {} }
`;
}

function expectError(yaml: string, fragment: string): void {
  const error = assertThrows(() => parseScenario(yaml), ScenarioError);
  assert(error.message.includes(fragment), `expected "${fragment}" in: ${error.message}`);
}

Deno.test("lora: defaults are 868.1 MHz SF7 BW125 CR4/5, sync 0x12, CRC on, 14 dBm, pins 5/14/26", () => {
  const s = parseScenario(scenario("{ phy: lora }"));
  assertEquals(s.phy, "lora");
  assertEquals(s.nodes[0]!.radio, {
    phy: "lora",
    frequencyHz: 868_100_000,
    sf: 7,
    bandwidthHz: 125_000,
    codingRate: 5,
    syncWord: 0x12,
    preambleLength: 8,
    crc: true,
    txPowerDbm: 14,
    antennaGainDbi: 0,
    pins: { cs: 5, reset: 14, dio0: 26 },
  });
});

Deno.test("lora: SF, bandwidth, coding rate as 4/N or N, hex sync word, pins", () => {
  const s = parseScenario(scenario(
    "{ phy: lora, frequency_mhz: 915, sf: 12, bw_khz: 62.5, cr: 4/8, sync_word: 0x34, " +
      "preamble: 12, crc: false, tx_power_dbm: 20, pins: { cs: 18, reset: null, dio0: 33 } }",
  ));
  const radio = s.nodes[0]!.radio;
  assert(radio.phy === "lora");
  assertEquals(radio.frequencyHz, 915e6);
  assertEquals(radio.sf, 12);
  assertEquals(radio.bandwidthHz, 62_500);
  assertEquals(radio.codingRate, 8);
  assertEquals(radio.syncWord, 0x34);
  assertEquals(radio.crc, false);
  assertEquals(radio.pins, { cs: 18, reset: null, dio0: 33 });
  const numeric = parseScenario(scenario("{ phy: lora, cr: 6 }")).nodes[0]!.radio;
  assert(numeric.phy === "lora" && numeric.codingRate === 6);
});

Deno.test("lora: values the SX127x cannot take are refused with the field named", () => {
  expectError(scenario("{ phy: lora, sf: 13 }"), "radios[0].sf");
  expectError(scenario("{ phy: lora, bw_khz: 100 }"), "no 100 kHz bandwidth");
  expectError(scenario("{ phy: lora, cr: 4/9 }"), "radios[0].cr");
  expectError(scenario("{ phy: lora, frequency_mhz: 2400 }"), "frequency_mhz");
  expectError(scenario("{ phy: lora, tx_power_dbm: 30 }"), "tx_power_dbm");
  expectError(scenario("{ phy: lora, spreading: 7 }"), "unknown field");
  expectError(scenario("{ phy: lora, pins: { cs: null } }"), "chip select must be wired");
});

Deno.test("lora: sends have no `to`, listeners default to the nodes that send nothing", () => {
  const s = parseScenario(scenario("{ phy: lora }"));
  const [a, b] = s.nodes;
  assert(a!.firmware.kind === "script" && b!.firmware.kind === "script");
  assertEquals(a!.firmware.send[0]!.to, null);
  assertEquals(a!.firmware.listen, false);
  assertEquals(b!.firmware.listen, true);
  expectError(
    scenario("{ phy: lora }", "", "{ send: [{ to: b, every: 1s, count: 2 }] }"),
    "LoRa has no addresses",
  );
  const both = parseScenario(
    scenario("{ phy: lora }", "", "{ listen: true, send: [{ every: 1s, count: 2 }] }"),
  );
  assert(both.nodes[0]!.firmware.kind === "script" && both.nodes[0]!.firmware.listen);
});

Deno.test("nrf24: defaults follow RF24 after begin(): channel 76, 1 Mbit/s, 0 dBm, auto-ACK, ARD 1500 us, ARC 15", () => {
  const s = parseScenario(
    scenario("{ phy: nrf24 }", "", "{ send: [{ to: b, every: 1s, count: 2 }] }"),
  );
  assertEquals(s.phy, "nrf24");
  assertEquals(s.nodes[0]!.radio, {
    phy: "nrf24",
    channel: 76,
    dataRate: 1_000_000,
    txPowerDbm: 0,
    antennaGainDbi: 0,
    autoAck: true,
    retries: 15,
    retryDelayUs: 1500,
    pins: { csn: 5, ce: 4, irq: null },
  });
});

Deno.test("nrf24: data rate, power steps and retry delay are checked", () => {
  const send = "{ send: [{ to: b, every: 1s, count: 2 }] }";
  expectError(scenario("{ phy: nrf24, data_rate_kbps: 500 }", "", send), "250, 1000 or 2000");
  expectError(scenario("{ phy: nrf24, tx_power_dbm: -10 }", "", send), "-18, -12, -6 or 0");
  expectError(scenario("{ phy: nrf24, retry_delay_us: 300 }", "", send), "multiple of 250");
  expectError(scenario("{ phy: nrf24, channel: 126 }", "", send), "channel");
  expectError(scenario("{ phy: nrf24 }"), "expected a non-empty string");
});

Deno.test("chip radios: one PHY per scenario, and no IP notions", () => {
  expectError(
    `
name: mixed
duration: 5s
nodes:
  - { id: a, board: scripted, position: [0, 0], radios: [{ phy: lora }], firmware: {} }
  - { id: b, board: scripted, position: [1, 0], radios: [{ phy: nrf24 }], firmware: {} }
`,
    "a scenario runs one PHY, but a uses lora and b uses nrf24",
  );
  expectError(scenario("{ phy: lora }", ", ip: 192.168.4.20"), "no IP address");
});

Deno.test("chip radios: metric assertions accept the lora, nrf24 and nrf24-ack frame kinds", () => {
  for (const kind of ["lora", "nrf24", "nrf24-ack"]) {
    const s = parseScenario(
      scenario("{ phy: lora }") +
        `assertions:\n  - metric: { link: "a->b", kind: ${kind}, loss_pct: { lt: 5 } }\n`,
    );
    assertEquals(s.assertions.length, 1);
  }
});

// ── BLE ─────────────────────────────────────────────────────────────────────

function bleScenario(central: string, peripheral = "{ advertise: true }", radio = "{ phy: ble }") {
  return `
name: ble
duration: 5s
nodes:
  - { id: gw, board: scripted, position: [0, 0], radios: [${radio}], firmware: ${central} }
  - { id: s1, board: scripted, position: [5, 0], radios: [${radio}], firmware: ${peripheral} }
`;
}

Deno.test("ble: defaults are 0 dBm with HCI on UART1, and a script reads advertise, connect and gatt sends", () => {
  const s = parseScenario(bleScenario(
    "{ connect: { peers: [s1] }, send: [{ to: s1, every: 1s, count: 2 }] }",
    "{ advertise: { name: probe, interval: 40ms }, send: [{ to: gw, every: 1s, count: 2 }] }",
  ));
  assertEquals(s.phy, "ble");
  assertEquals(s.nodes[0]!.radio, { phy: "ble", txPowerDbm: 0, antennaGainDbi: 0, hciUart: 1 });
  const gw = s.nodes[0]!.firmware;
  const s1 = s.nodes[1]!.firmware;
  assert(gw.kind === "script" && s1.kind === "script");
  assertEquals(gw.ble, {
    advertise: null,
    connect: { peers: ["s1"], intervalMs: 30, timeoutMs: 1000 },
    scan: false,
  });
  assertEquals(s1.ble?.advertise, { name: "probe", intervalMs: 40 });
  assertEquals(gw.send[0]?.via, "gatt");
  // `advertise: true` advertises the node's own id.
  const plain = parseScenario(bleScenario("{ connect: { peers: [s1] } }")).nodes[1]!.firmware;
  assert(plain.kind === "script" && plain.ble?.advertise?.name === "s1");
  assertEquals(
    parseScenario(bleScenario("{}", "{}", "{ phy: ble, hci_uart: 2 }")).nodes[0]!.radio,
    {
      phy: "ble",
      txPowerDbm: 0,
      antennaGainDbi: 0,
      hciUart: 2,
    },
  );
});

Deno.test("ble: UART0, link-layer timings it cannot take and sends without a connection are refused", () => {
  expectError(bleScenario("{}", "{}", "{ phy: ble, hci_uart: 0 }"), "UART0 is the serial console");
  expectError(bleScenario("{ connect: { peers: [s1], interval: 31ms } }"), "multiple of 1.25 ms");
  expectError(bleScenario("{ connect: { peers: [s1], interval: 5ms } }"), "between 7.5 ms");
  expectError(
    bleScenario("{ connect: { peers: [s1], interval: 100ms, timeout: 150ms } }"),
    "more than twice the connection interval",
  );
  expectError(bleScenario("{ connect: { peers: [nobody] } }"), "connect.peers[0]");
  expectError(bleScenario("{ connect: { peers: [gw] } }"), "cannot connect to itself");
  expectError(
    bleScenario("{ send: [{ to: s1, every: 1s, count: 1 }] }"),
    "neither gw nor s1 connects to the other",
  );
  expectError(
    bleScenario("{ connect: { peers: [s1] }, send: [{ to: s1, every: 1s, count: 1, port: 9 }] }"),
    "GATT has no ports",
  );
  expectError(
    bleScenario(
      "{ connect: { peers: [s1] }, send: [{ to: s1, every: 1s, count: 1, payload: fifteen-bytes-x }] }",
    ),
    "within 14 bytes",
  );
  expectError(bleScenario("{ advertise: true, connect: { peers: [s1] } }"), "not both");
  expectError(bleScenario("{ listen: true }"), "not a BLE notion");
  expectError(scenario("{ phy: nrf24 }", "", "{ advertise: true }"), "is a BLE notion");
});
