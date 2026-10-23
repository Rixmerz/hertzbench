# Hertzbench

Simulate the radio network between microcontroller boards: N boards running real firmware, talking
over simulated wireless links with a distance, a path loss, a latency and a loss. Local, free,
AGPLv3, based on [Velxio](https://github.com/davidmonterocrespo24/velxio) (which does the CPU
emulation).

The plan is in [docs/PLAN.md](docs/PLAN.md). This is **Phase 1**, N ESP32 boards over Wi-Fi/IP with
a channel model, run headless from a scenario file, **Phase 2**, an MCP server so an AI agent can
build, run and steer those scenarios, **Phase 3**, LoRa and nRF24 radio chips modelled at their SPI
interface, **Phase 4**, ESP-NOW between the boards, **Phase 5**, a mobile bridge that lets a real
phone reach a simulated board over Wi-Fi/IP or BLE, and **Phase 6**, BLE between the boards through
a virtual controller on an HCI UART.

## Status

| Part                                                                                                   | State                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RF engine: medium, nodes, positions, path loss, rate and retries, jitter, loss, seeded RNG, event log  | done, unit-tested on a manual clock                                                                                                                                           |
| `qemu-wifi-l2` adapter: each board's QEMU network device on the engine instead of SLIRP                | done, tested against a fake QEMU peer over real sockets                                                                                                                       |
| Orchestrator and CLI: `hertzbench run`, `validate`                                                     | done, tested through the real CLI                                                                                                                                             |
| `metrics.json`, `air.pcap`, `events.jsonl`, assertions                                                 | done                                                                                                                                                                          |
| ESP32 boards under QEMU                                                                                | **written, not run**: this was built on a host without libqemu or Docker. [docs/e2e-esp32.md](docs/e2e-esp32.md) says how to run it and what to check first                   |
| MCP server: `hertzbench mcp`, ten tools, examples and fidelity table as resources, live move and fault | done, tested through the real `hertzbench mcp` process with scripted boards; ESP32 through MCP not run, same reason as above                                                  |
| `docker-compose.hertzbench.yml`                                                                        | not started                                                                                                                                                                   |
| ESP-NOW (F1): action frames from the QEMU fork's MAC on the switch, the 10 ms ACK wait, 802.11 capture | done against a model of the fork, tested on a manual clock and through the CLI with scripted boards; **not run against QEMU**, see [ESP-NOW](#esp-now)                        |
| LoRa (SX127x) and nRF24L01+ chip models over `spi-link` (Phase 3)                                      | see `adapters/lora-sx127x/`, `adapters/nrf24/` and `scenarios/examples/lora-gateway-6-*.yaml`                                                                                 |
| BLE (F3, Phase 6): virtual HCI controller per node on the chip-level air, ESP32 HCI UART relay         | done, tested on a manual clock and through the CLI with scripted hosts; ESP32 relay tested with a fake worker; **Bluedroid firmware not run**, see [BLE](#ble)                |
| Mobile bridge (Phase 5): IP proxy with mDNS (5a), BlueZ GATT mirror (5b), the phone as a node          | done, tested end to end with scripted boards and stand-ins for the host's network and BlueZ; **no real phone, LAN mDNS or adapter used**, see [Mobile bridge](#mobile-bridge) |
| Canvas                                                                                                 | later phase                                                                                                                                                                   |

## Quick start (no QEMU needed)

Needs [Deno](https://deno.com) 2.x.

```bash
cd hertzbench
deno task hertzbench run scenarios/examples/udp-3-scripted.yaml --out /tmp/hzb-out
```

It runs three **scripted** boards (a traffic generator, not firmware) for 6 s. Board `c` walks
behind a wall at 2.5 s; the report shows its links to `a` slowing down and losing frames while the
link to `b` holds. It prints per-link RSSI, loss and latency, a pass or fail per assertion, and
writes `metrics.json`, `air.pcap` (open it in Wireshark) and `events.jsonl` to `/tmp/hzb-out`.

The same experiment with three ESP32 boards is `scenarios/examples/udp-3-nodes.yaml`; it needs
libqemu, see [docs/e2e-esp32.md](docs/e2e-esp32.md).

```
hertzbench run <scenario.yaml> [--out DIR] [--seed N] [--quiet]
hertzbench validate <scenario.yaml>
hertzbench mcp [--workspace DIR]
```

To get the `hertzbench` and `hzb` commands on your PATH (they go to Deno's bin directory, usually
`~/.deno/bin`), run `deno task install-cli` once from this directory. Without it, use
`deno task hertzbench ...` from here as above.

`hzb` is the short alias. Exit status: 0 passed, 1 an assertion failed, 2 invalid scenario or a host
that cannot run it, 130 interrupted (boards are stopped first).

## ESP-NOW

```bash
cd hertzbench
deno task hertzbench run scenarios/examples/espnow-mesh-scripted.yaml --out /tmp/hzb-espnow
```

A gateway and four sensors on channel 1, scripted boards again. The sensors send readings to the
gateway over unicast ESP-NOW and the gateway broadcasts a beacon. A wall stands between the gateway
and the two farther sensors. At 3 s sensor-4 walks away: its frames need more retries, some run past
the 10 ms the QEMU fork waits for an ACK, most are lost. The report has an ESP-NOW table with each
link's sends as the sender's firmware sees them (`acked`, `frame_lost`, `ack_timeout`, `no_ack`) and
the round trip of each ACK. `air-80211.pcap` holds the frames as 802.11 for Wireshark.

With real firmware the boards run the production ESP-NOW stack. The fork's Wi-Fi MAC model turns
their 802.11 action frames into pseudo-Ethernet on the same netdev as Wi-Fi/IP, and the engine
carries them. `scenarios/examples/espnow-mesh-5-nodes.yaml` and its sketches in
`scenarios/examples/fw/espnow-*` do it with five ESP32 boards; they need libqemu and the ESP-IDF
toolchain, and have **not been run**: see
[docs/e2e-esp32.md](docs/e2e-esp32.md#the-esp-now-example). What the engine models, the 10 ms ACK
rule, and what is read from the fork's code rather than measured are in
[docs/fidelity.md](docs/fidelity.md#esp-now).

## BLE

```bash
cd hertzbench
deno task hertzbench run scenarios/examples/ble-sensors-scripted.yaml --out /tmp/hzb-ble
```

A central and three sensor peripherals, scripted hosts again. The central connects to the three
through its filter accept list, and each sensor notifies a reading every 200 ms. At 4 s sensor-3
walks out of range: its packets stop, both sides drop the connection on the 1 s supervision timeout
(reason 0x08), and the central keeps scanning for it. The report lists every connection and
disconnection, and per link the packets on the air (`ble-adv`, `ble-data`) and the host-to-host ACL
data (`ble-acl`, whose latency includes waiting for connection events and retransmissions).
`air.pcap` holds the air as LE link-layer packets for Wireshark, and `hci-<node>.btsnoop` each
node's HCI, readable by Wireshark and by BlueZ's `btmon -r`.

The QEMU fork has no Bluetooth controller, so BLE is **F3** (ADR
[0002](docs/adr/0002-ble-approach.md)): the firmware runs its real Bluedroid host stack, built
host-only, and sends HCI over UART1; the board relays that UART to a link-layer controller the
engine plays. The binary differs from production by that build option and the UART driver.
`scenarios/examples/ble-sensors-3-nodes.yaml` runs three ESP32 sensors built from
`scenarios/examples/fw/ble-sensor` (an ESP-IDF project) and has **not been run**: see
[docs/e2e-esp32.md](docs/e2e-esp32.md#the-ble-example). What the controller models and what it
leaves out are in [docs/fidelity.md](docs/fidelity.md#ble).

## Mobile bridge

```bash
cd hertzbench
deno task hertzbench run scenarios/examples/bridge-web-scripted.yaml
curl http://127.0.0.1:8080/status     # in another terminal, while it runs
```

A scripted web node serves HTTP (and WebSocket on the same port) and an MQTT broker; the bridge's
station stands 3 m from it on the medium. Every connection to the host's port 8080 or 1883 becomes
the bridge's own TCP connection to the node, so its segments pay the channel model from the bridge's
position: at 40 s the bridge walks away and requests slow down. With `listen: 0.0.0.0` and
`deno task lan run ...`, a phone on the same Wi-Fi reaches it, and mDNS advertises it as
`web-80._http._tcp.local`.

On BLE, `scenarios/examples/bridge-ble-scripted.yaml` mirrors a simulated peripheral's GATT server
through BlueZ: a phone connects to the host, and each read, write and subscription is replayed from
the bridge's node on the simulated air. That one needs Linux, `bluetoothd` and PyGObject. What each
bridge models and leaves out (the phone-to-host leg is real, not modelled), how to run it and how it
is tested are in [docs/mobile-bridge.md](docs/mobile-bridge.md). No Velxio file changed.

## Use it from Claude Code (MCP)

```bash
claude mcp add hertzbench -- hertzbench mcp --workspace /path/to/your/project
```

The agent gets `list_boards`, `create_scenario`, `validate_scenario`, `run_scenario`, `get_status`,
`get_serial`, `get_metrics`, `move_node`, `inject_fault` and `stop`. As resources it gets the
example scenarios, the scenario format and the fidelity table. A run plays in the background, so the
agent can move a node or break a link while it runs and read the effect in the metrics.
`scenarios/examples/live-3-scripted.yaml` is a two-minute run made for that. Every file the server
writes stays inside its workspace. Registration without installing, the tool reference and the ESP32
setup are in [docs/mcp.md](docs/mcp.md).

## How it works

```
board 1 (QEMU) ──┐                                   ┌── metrics.json
board 2 (QEMU) ──┼─ stream netdev ─ adapter ─ engine ┼── air.pcap
board N (QEMU) ──┘   (loopback TCP)     switch + channel model   └── events.jsonl
```

- Each board's Wi-Fi NIC is a QEMU `stream` netdev to its own loopback port. The adapter reads
  Ethernet frames from it and hands them to the engine, and writes the engine's deliveries back.
- The engine is a static layer-2 switch. For every frame and every receiver it computes RSSI and SNR
  from the positions, picks a rate, rolls retries and loss, and delivers the frame after the
  modelled delay. All randomness comes from the scenario seed.
- A virtual gateway at `192.168.4.1` answers ARP and DHCP with a static lease per board; there is no
  DNS.
- The fidelity of every part is printed in the report. See [docs/fidelity.md](docs/fidelity.md) for
  the model, what it leaves out, and the clock caveat: **latency is modelled, not measured**.

## Layout

```
engine/          RF engine: channel model, medium, switch, gateway, ESP-NOW framing, LoRa, nRF24
                 and BLE PHYs, metrics, pcap, a small TCP for the stations it plays
adapters/        qemu-wifi-l2 (QEMU stream netdev <-> engine), eFuse image builder, spi-link and the
                 LoRa and nRF24 chip models, ble-hci (virtual BLE controller, H4, btsnoop)
orchestrator/    scenario parser, runner, assertions, report, boards (esp32, scripted, ESP-NOW fork
                 model, scripted LoRa/nRF24/BLE hosts, scripted TCP servers, ATT/GATT)
bridge/          mobile bridge: ip/ (host TCP proxy, mDNS), ble/ (GATT mirror, BlueZ helper)
mcp/             MCP server: JSON-RPC over stdio, tools, resources, the live run
cli/             hertzbench run | validate | mcp
scenarios/       examples/
tests/           deno tests (engine, adapter, scenario, orchestrator, CLI, MCP)
docs/            PLAN, discovery, ADRs, fidelity, scenario format, e2e, upstream sync
brand.ts         the product name, in one place
```

## Tests

```bash
cd hertzbench
deno task test      # unit + adapter + CLI and MCP end to end; no QEMU needed
deno task check     # type check
deno lint && deno fmt --check
```

The Velxio core patch has its own tests: `pytest test/backend/unit/test_esp32_wifi_l2_args.py` from
the repository root. It touches one Velxio file; see [docs/upstream-sync.md](docs/upstream-sync.md).
BLE and the mobile bridge touch no Velxio file. The BlueZ helper's test runs it on a private D-Bus
(`dbus-run-session`) against a fake `bluetoothd`, and skips when `dbus-run-session` is missing. One
CLI test decodes a node's HCI capture with BlueZ's `btmon` when it is installed, and skips that
check when it is not.

## Docs

- [docs/scenario-format.md](docs/scenario-format.md): every scenario field and the `metrics.json`
  layout
- [docs/fidelity.md](docs/fidelity.md): fidelity levels, the channel model, what is not modelled
- [docs/mcp.md](docs/mcp.md): the MCP server, its tools and resources, registering it with Claude
  Code
- [docs/mobile-bridge.md](docs/mobile-bridge.md): a real phone to a simulated board, over IP (with
  mDNS) or BLE (through BlueZ)
- [docs/e2e-esp32.md](docs/e2e-esp32.md): running the ESP32 example, and what to verify on the first
  run
- [docs/upstream-sync.md](docs/upstream-sync.md): the Velxio patches and the sync policy
- [docs/discovery.md](docs/discovery.md) and [docs/adr/](docs/adr/): Phase 0 findings and decisions

Hertzbench is based on Velxio. The name and logo of Velxio are not ours to use as a brand.
