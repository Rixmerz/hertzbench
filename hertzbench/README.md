# Hertzbench

Simulate the radio network between microcontroller boards: N boards running real firmware, talking
over simulated wireless links with a distance, a path loss, a latency and a loss. Local, free,
AGPLv3, based on [Velxio](https://github.com/davidmonterocrespo24/velxio) (which does the CPU
emulation).

The plan is in [docs/PLAN.md](docs/PLAN.md). This is **Phase 1**: N ESP32 boards over Wi-Fi/IP with
a channel model, run headless from a scenario file.

## Status

| Part                                                                                                  | State                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RF engine: medium, nodes, positions, path loss, rate and retries, jitter, loss, seeded RNG, event log | done, unit-tested on a manual clock                                                                                                                         |
| `qemu-wifi-l2` adapter: each board's QEMU network device on the engine instead of SLIRP               | done, tested against a fake QEMU peer over real sockets                                                                                                     |
| Orchestrator and CLI: `hertzbench run`, `validate`                                                    | done, tested through the real CLI                                                                                                                           |
| `metrics.json`, `air.pcap`, `events.jsonl`, assertions                                                | done                                                                                                                                                        |
| ESP32 boards under QEMU                                                                               | **written, not run**: this was built on a host without libqemu or Docker. [docs/e2e-esp32.md](docs/e2e-esp32.md) says how to run it and what to check first |
| `docker-compose.hertzbench.yml`                                                                       | not started                                                                                                                                                 |
| ESP-NOW, LoRa, BLE, nRF24, MCP server, mobile bridge, canvas                                          | later phases                                                                                                                                                |

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
```

`hzb` is the short alias. Exit status: 0 passed, 1 an assertion failed, 2 invalid scenario or a host
that cannot run it.

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
engine/          RF engine: channel model, medium, switch, gateway, metrics, pcap
adapters/        qemu-wifi-l2 (QEMU stream netdev <-> engine), eFuse image builder
orchestrator/    scenario parser, runner, assertions, report, boards (esp32, scripted)
cli/             hertzbench run | validate
scenarios/       examples/
tests/           deno tests (engine, adapter, scenario, orchestrator, CLI)
docs/            PLAN, discovery, ADRs, fidelity, scenario format, e2e, upstream sync
brand.ts         the product name, in one place
```

## Tests

```bash
cd hertzbench
deno task test      # unit + adapter + CLI end to end; no QEMU needed
deno task check     # type check
deno lint && deno fmt --check
```

The Velxio core patch has its own tests: `pytest test/backend/unit/test_esp32_wifi_l2_args.py` from
the repository root. It touches one Velxio file; see [docs/upstream-sync.md](docs/upstream-sync.md).

## Docs

- [docs/scenario-format.md](docs/scenario-format.md): every scenario field and the `metrics.json`
  layout
- [docs/fidelity.md](docs/fidelity.md): fidelity levels, the channel model, what is not modelled
- [docs/e2e-esp32.md](docs/e2e-esp32.md): running the ESP32 example, and what to verify on the first
  run
- [docs/upstream-sync.md](docs/upstream-sync.md): the Velxio patches and the sync policy
- [docs/discovery.md](docs/discovery.md) and [docs/adr/](docs/adr/): Phase 0 findings and decisions

Hertzbench is based on Velxio. The name and logo of Velxio are not ours to use as a brand.
