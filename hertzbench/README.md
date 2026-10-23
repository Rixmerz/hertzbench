# Hertzbench

Simulate the radio network between microcontroller boards: N boards running real firmware, talking
over simulated wireless links with a distance, a path loss, a latency and a loss. Local, free,
AGPLv3, based on [Velxio](https://github.com/davidmonterocrespo24/velxio) (which does the CPU
emulation).

The plan is in [docs/PLAN.md](docs/PLAN.md). This is **Phase 1**, N ESP32 boards over Wi-Fi/IP with
a channel model, run headless from a scenario file, **Phase 2**, an MCP server so an AI agent can
build, run and steer those scenarios, and **Phase 4**, ESP-NOW between the boards.

## Status

| Part                                                                                                   | State                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RF engine: medium, nodes, positions, path loss, rate and retries, jitter, loss, seeded RNG, event log  | done, unit-tested on a manual clock                                                                                                                         |
| `qemu-wifi-l2` adapter: each board's QEMU network device on the engine instead of SLIRP                | done, tested against a fake QEMU peer over real sockets                                                                                                     |
| Orchestrator and CLI: `hertzbench run`, `validate`                                                     | done, tested through the real CLI                                                                                                                           |
| `metrics.json`, `air.pcap`, `events.jsonl`, assertions                                                 | done                                                                                                                                                        |
| ESP32 boards under QEMU                                                                                | **written, not run**: this was built on a host without libqemu or Docker. [docs/e2e-esp32.md](docs/e2e-esp32.md) says how to run it and what to check first |
| MCP server: `hertzbench mcp`, ten tools, examples and fidelity table as resources, live move and fault | done, tested through the real `hertzbench mcp` process with scripted boards; ESP32 through MCP not run, same reason as above                                |
| `docker-compose.hertzbench.yml`                                                                        | not started                                                                                                                                                 |
| ESP-NOW (F1): action frames from the QEMU fork's MAC on the switch, the 10 ms ACK wait, 802.11 capture | done against a model of the fork, tested on a manual clock and through the CLI with scripted boards; **not run against QEMU**, see [ESP-NOW](#esp-now)      |
| LoRa, BLE, nRF24, mobile bridge, canvas                                                                | later phases                                                                                                                                                |

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
engine/          RF engine: channel model, medium, switch, gateway, ESP-NOW framing, metrics, pcap
adapters/        qemu-wifi-l2 (QEMU stream netdev <-> engine), eFuse image builder
orchestrator/    scenario parser, runner, assertions, report, boards (esp32, scripted, ESP-NOW fork model)
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

## Docs

- [docs/scenario-format.md](docs/scenario-format.md): every scenario field and the `metrics.json`
  layout
- [docs/fidelity.md](docs/fidelity.md): fidelity levels, the channel model, what is not modelled
- [docs/mcp.md](docs/mcp.md): the MCP server, its tools and resources, registering it with Claude
  Code
- [docs/e2e-esp32.md](docs/e2e-esp32.md): running the ESP32 example, and what to verify on the first
  run
- [docs/upstream-sync.md](docs/upstream-sync.md): the Velxio patches and the sync policy
- [docs/discovery.md](docs/discovery.md) and [docs/adr/](docs/adr/): Phase 0 findings and decisions

Hertzbench is based on Velxio. The name and logo of Velxio are not ours to use as a brand.
