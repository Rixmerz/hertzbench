# PLAN.md — Hertzbench: local, open-source multi-board IoT network simulator

> Handoff document for Claude Code. Read fully before writing code.
> Owner: Rix (JP). Language of code, docs and commits: English.

---

## 1. Project in one paragraph

A **100% free, open-source, local-first** simulation environment for microcontroller boards (ESP32 family first, Arduino AVR / RP2040 later) focused on **what happens between boards**: N emulated boards running real firmware, talking to each other over **simulated wireless links** (Wi-Fi/IP, ESP-NOW, LoRa, BLE, nRF24) with configurable **distance, path loss, latency, jitter, packet loss and interference**, plus the ability for **real mobile apps** to connect to simulated boards, and an **MCP server** so AI agents (Claude Code) can build, run and assert on scenarios. Think "ns-3 for makers", built as a friendly fork of Velxio.

## 2. Name

- **"OpenIoT" is NOT usable**: already used by an EU-funded IoT middleware project (github.com/OpenIotOrg/openiot) and by an active OTA-update project (github.com/OpenIoT-tools/OpenIoT).
- Final name: **Hertzbench** ("hertz" = radio frequency + "bench" = test bench).
  - Display name: `Hertzbench`. Slug for directory, package scope, Docker image and repo: `hertzbench`.
  - CLI binary: `hertzbench`, with short alias `hzb`. **Never** ship a binary or package called just `hertz` (collides with CloudWeGo Hertz, a Go HTTP framework).
  - Before first public push: confirm GitHub org/repo, npm/JSR package names and a `.dev`/`.io` domain are free; report any conflict to the owner.
  - Keep the name in ONE config constant + README so a future rename stays a search-and-replace.
- Never use the name "Velxio" or its logo as our brand. Allowed and encouraged: "based on Velxio" in README/About.

## 3. Positioning vs Velxio (why we exist)

| | Velxio (upstream) | hertzbench (us) |
|---|---|---|
| Core focus | One **circuit**: boards + components + wires | One **network**: N boards talking over the air |
| Board-to-board | Wired: UART / I²C / SPI via drawn wires | Wireless: Wi-Fi/IP, ESP-NOW, LoRa, BLE, nRF24 |
| Wi-Fi | Single virtual AP, SLIRP NAT to internet | Virtual RF medium between boards with channel model |
| Physics | SPICE analog co-sim | Radio channel: path loss, RSSI, PER, airtime, collisions |
| Scale/UX | Interactive canvas | Headless scenarios first (CLI/CI), canvas optional |
| Mobile apps | No | Real phones connect to simulated boards |
| AI agent | Built-in, paid plans | Open MCP server, free |
| Distribution | Hosted + self-host Docker | Local only (Docker compose + CLI) |
| License | AGPLv3 (+ commercial) | AGPLv3 |

**Rule:** we do NOT compete on CPU emulation, component library, canvas or SPICE. We reuse Velxio for those and invest only in the network layer, mobile bridge, scenario runner and MCP.

## 4. Fixed decisions (ADR summary)

| ID | Decision | Rationale |
|---|---|---|
| D1 | Friendly **git fork of Velxio**, with full history, Velxio code stays at repo root | Lets us `git merge upstream/<default-branch>` cleanly |
| D2 | License **AGPLv3** for the whole repo | Required by Velxio; also blocks closed SaaS forks of our work. Project is free forever |
| D3 | Keep all Velxio copyright notices; every Velxio file we modify gets a header line `Modified by hertzbench contributors, <YYYY-MM>` | AGPLv3 §5 |
| D4 | All our code lives under top-level `hertzbench/`; touches to Velxio core are minimal, isolated, and tagged | Keeps upstream merges cheap |
| D5 | **Local-first**: `docker compose up` + headless CLI. No hosted service, no accounts, no paid tiers, no telemetry | Zero running cost, "completely free" |
| D6 | RF engine is a **separate process** (Deno + TypeScript) talking to emulator instances via sockets | Decoupled from Velxio backend language; testable alone |
| D7 | Deterministic by default: seeded RNG, simulation-time clock where the backend supports it | Reproducible tests and CI |
| D8 | Scenarios are declarative **YAML** files; results are **JSON metrics + pcap** | Diffable, CI-friendly, Wireshark-inspectable |
| D9 | We do not wait for upstream. Useful core fixes are offered upstream as PRs; if rejected, they stay as tagged patches | Our pace, their improvements |
| D10 | Fidelity is explicit: every protocol declares its fidelity level (see §7) and the CLI prints it | Never pretend a shimmed result is cycle-accurate |

## 5. Scope

### In scope (by phase, see §9)
- N ESP32-family boards (QEMU via Velxio backend) on a shared virtual RF medium.
- Channel model: positions in 2D (3D optional), log-distance path loss, shadowing, obstacles, RSSI, SNR → PER, airtime, collisions, per-link overrides.
- Protocols: Wi-Fi/IP (UDP/TCP/MQTT/HTTP between boards), LoRa (SX127x SPI model), ESP-NOW, BLE, nRF24L01.
- Scenario runner (headless), assertions, metrics, pcap export.
- Mobile bridge: real phone ↔ simulated board over Wi-Fi/IP first, BLE later (Linux/BlueZ host).
- MCP server exposing scenario lifecycle and metrics.
- Optional canvas view: map of nodes + live link quality, reusing Velxio UI where possible.

### Non-goals
- New CPU emulators, SPICE, component library, cloud hosting, user accounts, payments, mobile app builders, Windows-native BLE bridge (Linux first; macOS/Windows later if contributors appear).

## 6. Architecture

```
┌──────────────── hertzbench CLI / MCP server / optional UI ────────────────┐
│  scenario.yaml → Orchestrator → Metrics/pcap → assertions → report   │
└───────────────┬───────────────────────────────────────┬──────────────┘
                │ control API (WS/JSON)                  │
        ┌───────▼────────┐                     ┌─────────▼─────────┐
        │   RF Engine    │◄── frames/events ──►│  Mobile Bridge    │
        │ (Deno, TS)     │                     │ (IP proxy, BlueZ) │
        │ channel model  │                     └─────────▲─────────┘
        │ medium, clock  │                               │ real phone
        └──┬────────┬────┘
   radio   │        │  radio adapters (one per backend/protocol)
  sockets  │        │
   ┌───────▼──┐  ┌──▼───────┐
   │ Board 1  │  │ Board N  │   Velxio backend: QEMU (ESP32) / avr8js / rp2040js
   │ firmware │  │ firmware │   compiled with Velxio's arduino-cli / ESP-IDF chain
   └──────────┘  └──────────┘
```

### Components
1. **Orchestrator** — parses scenario, compiles firmware via Velxio toolchain, launches N board instances (headless, no canvas), wires their radio adapters to the RF engine, runs for `duration`, collects results.
2. **RF Engine** — owns the virtual medium. Receives TX frames `{node, phy, channel, payload, txPower, t}`, computes per-receiver RSSI/SNR, decides delivery (PER, collisions, half-duplex), schedules delivery at `t + airtime + propagation + latencyModel`. Emits every event to metrics/pcap.
3. **Radio adapters** — translate backend-specific I/O into engine frames (see §7).
4. **Metrics & pcap** — per-link RSSI, PER, latency p50/p95/p99, throughput, retries; pcap with radiotap-style headers where possible.
5. **Mobile Bridge** — exposes selected simulated nodes to real devices.
6. **MCP server** — thin layer over the orchestrator API.

### Proposed repo layout
```
/                      ← Velxio code (untouched as much as possible)
hertzbench/
  engine/              RF engine (Deno)
  adapters/            qemu-wifi-l2, espnow, lora-sx127x, ble-hci, nrf24
  orchestrator/        scenario runner, compile+launch, lifecycle
  bridge/              mobile bridge (ip-proxy, bluez-gatt)
  mcp/                 MCP server
  cli/                 `hertzbench run|validate|report|ls`
  scenarios/examples/  ready-to-run YAML scenarios
  docs/                discovery.md, adr/, fidelity.md, upstream-sync.md
  tests/
docker-compose.hertzbench.yml
```
Velxio integration hooks live ONLY in `hertzbench/adapters/` and, when unavoidable, in small tagged patches to Velxio code (list them in `hertzbench/docs/upstream-sync.md`).

## 7. Protocol strategy and fidelity levels

Fidelity levels: **F1** = same unmodified binary, frames captured at emulated hardware/MAC level. **F2** = same binary, captured at network (L2/IP) level. **F3** = firmware built with a sim-only HAL shim replacing the radio driver (binary differs from production).

| Protocol | Target approach | Fidelity | Notes |
|---|---|---|---|
| Wi-Fi / IP between boards | Replace per-board SLIRP with a QEMU socket/stream netdev into an hertzbench virtual L2 switch; engine applies per-link delay/loss/bandwidth from positions | F2 | **MVP.** Depends on how Velxio's QEMU exposes Wi-Fi networking (Phase 0) |
| LoRa | Emulate SX1276/77/78 register map as an SPI peripheral in TS (Velxio already routes SPI); TX/RX go to engine with LoRa airtime (SF, BW, CR) | F1 (radio chip level) | Works for ESP32, AVR, RP2040 alike. Strong 2nd milestone |
| nRF24L01 | Same as LoRa: SPI peripheral model | F1 | Cheap once LoRa model exists |
| ESP-NOW | Preferred: capture 802.11 action frames if Velxio's QEMU emulates the Wi-Fi MAC. Fallback: sim-only shim of the `esp_now_*` API over a socket | F1 or F3 | Decide in Phase 0; document in ADR |
| BLE | Preferred: HCI-level split (emulated host ↔ virtual controller in engine). Fallback: shim of Arduino BLE API | F1/F3 | Velxio moved ESP32 BLE to Bluedroid — check controller status in Phase 0 |

References to study before designing the engine (do not vendor without checking licenses): **ns-3** (channel/propagation models), **BabbleSim** (physical-layer simulator used by Zephyr for BLE/802.15.4), **Renode** (multi-node wireless medium).

## 8. Channel and timing model (v1)

- Path loss: `PL(d) = PL(d0) + 10·n·log10(d/d0) + Xσ`, defaults per environment preset (`free_space`, `indoor_office`, `urban`, `rural`); `Xσ` seeded Gaussian shadowing.
- `RSSI = txPower + antennaGains − PL − obstacleAttenuation`.
- `SNR = RSSI − noiseFloor(phy, bw)`; PER from per-PHY SNR→PER curves (simple logistic per PHY/rate; table-driven, replaceable).
- Latency = `airtime(payload, phy params) + propagation (d/c) + configurable base + jitter(dist)`; MAC behaviour (CSMA/backoff, retries) simple per PHY, documented.
- Collisions: overlapping receptions on same channel at a receiver → capture effect if ΔRSSI ≥ threshold, else both lost.
- Per-link overrides in scenario (force loss %, extra latency) for chaos testing.
- **Clock:** where the backend supports deterministic instruction counting (QEMU icount on ESP32-C3 RISC-V), use simulation time. Xtensa (ESP32/S3) runs wall-clock in current QEMU forks → engine timestamps on its own monotonic clock and reports latency as **modelled**, not measured. The report must say which clock was used per node.

### Scenario example
```yaml
name: espnow-mesh-5-nodes
seed: 42
duration: 60s
environment: { preset: indoor_office, obstacles: [{ polygon: [[5,0],[5,10]], attenuation_db: 12 }] }
nodes:
  - id: gw
    board: esp32-devkit-v1
    firmware: ./fw/gateway        # arduino or esp-idf project
    position: [0, 0]
    radios: [{ phy: wifi, channel: 1, tx_power_dbm: 20 }]
  - id: sensor
    count: 4                       # expands to sensor-1..4
    board: esp32-c3-devkit
    firmware: ./fw/sensor
    position: { grid: { origin: [10, 0], step: [8, 0] } }
    radios: [{ phy: wifi, channel: 1, tx_power_dbm: 8 }]
links:
  - { from: sensor-4, to: gw, extra_loss_pct: 10 }
assertions:
  - serial: { node: gw, contains: "received from sensor-4", within: 30s }
  - metric: { link: "sensor-*->gw", latency_p95_ms: { lt: 50 } }
outputs: { metrics: ./out/metrics.json, pcap: ./out/air.pcap }
```

## 9. Roadmap

Each phase ends with: passing tests, an example scenario in `hertzbench/scenarios/examples/`, README section updated.

### Phase 0 — Discovery (no feature code)
Fork, run Velxio locally via Docker, then write `hertzbench/docs/discovery.md` answering:
1. Default branch name, release cadence, CLA requirements (if any), license headers in use.
2. Backend language/framework and how it launches and manages QEMU / avr8js / rp2040js instances. Can boards run **headless** without the browser canvas?
3. How Wi-Fi is implemented for ESP32 (QEMU netdev type, custom Wi-Fi MAC emulation or not, where SLIRP is configured). Are 802.11 frames observable?
4. BLE: is a controller emulated? Where does HCI go?
5. Where the multi-board interconnect (UART/I²C/SPI) and SignalRouter live; how to attach a new SPI peripheral model.
6. Existing AI-agent tool surface: can our MCP reuse its typed tools?
7. Compile pipeline entry points (arduino-cli / ESP-IDF) callable without UI.
8. Minimal list of core patches we would need, with file paths.
Output also: ADRs for ESP-NOW and BLE approach (F1 vs F3), and confirmation or revision of D4/D6. **Stop and report to the owner before Phase 1.**

### Phase 1 — MVP: N ESP32 over Wi-Fi/IP with channel model
- RF engine skeleton: medium, nodes, positions, path loss, latency/loss per link, seeded RNG, event log.
- Adapter `qemu-wifi-l2`: each board's network goes into the engine's virtual switch instead of SLIRP. Optional single "internet gateway" node keeps SLIRP for MQTT brokers.
- Orchestrator + CLI: `hertzbench run scenario.yaml`, headless, N = 2–10.
- Metrics JSON + pcap. Assertions: serial contains, metric thresholds.
- Example: 3 ESP32 exchanging UDP; moving one farther raises loss/latency measurably.

### Phase 2 — MCP server
Tools: `list_boards`, `create_scenario`, `validate_scenario`, `run_scenario`, `get_status`, `get_serial(node)`, `get_metrics`, `move_node(node, pos)` (live), `inject_fault(link, …)`, `stop`. Resources: example scenarios, fidelity table. Enables Claude Code to iterate firmware ↔ scenario.

### Phase 3 — LoRa + nRF24 as SPI peripheral models
SX127x register-level model, LoRa airtime formula, SF/BW/CR in scenario; nRF24L01 model. Works on ESP32, Arduino Uno, Pico. Example: 1 gateway + 6 LoRa nodes at increasing distance.

### Phase 4 — ESP-NOW
Per Phase 0 ADR (F1 preferred, F3 fallback). Example mesh scenario above.

### Phase 5 — Mobile bridge
- 5a IP: phone on the host's LAN reaches a simulated node (HTTP/WebSocket/MQTT) through a host proxy with mDNS advertisement; engine applies the node's link model to that traffic.
- 5b BLE (Linux/BlueZ): host acts as a GATT peripheral proxy mirroring the simulated node's GATT server; phone's BLE traffic enters the engine as a virtual node at a configurable position.

### Phase 6 — BLE between simulated boards
Per Phase 0 ADR.

### Phase 7 — Visual layer (optional)
2D map of nodes, link lines colored by RSSI/PER, drag to move nodes live, timeline of packets. Reuse Velxio frontend components where it doesn't increase merge cost.

### Later
Mobility models (random waypoint), 802.15.4/Zigbee/Thread, energy/battery model, scenario sweeps (parameter grids), Wokwi-compatible `diagram.json` import if license allows.

## 10. Upstream sync policy (Velxio)

```bash
git remote add upstream https://github.com/davidmonterocrespo24/velxio.git
git config rerere.enabled true
git fetch upstream
git merge upstream/<default-branch>   # or cherry-pick specific commits
```
- Cadence: every 2–4 weeks, or on demand when upstream ships something we want (e.g. their in-browser ESP32 emulators, ESP32-P4).
- Every commit touching Velxio files is prefixed `core-patch:` and listed in `hertzbench/docs/upstream-sync.md` with reason and "upstreamable? yes/no".
- After each merge: run full hertzbench test suite + all example scenarios in CI; fix adapters, not Velxio.
- Generic fixes → open PR upstream; once merged there, drop our patch.
- Never block our roadmap waiting for upstream review.

## 11. Engineering conventions

- TypeScript strict, Deno for hertzbench services; follow Velxio's conventions inside Velxio files.
- Tests: unit tests for channel math (golden values), integration tests that boot 2–3 boards headless, scenario tests in CI (Linux runner, Docker).
- Determinism test: same scenario + seed ⇒ identical metrics on deterministic backends.
- Small PRs, conventional commits (`feat(engine): …`, `core-patch: …`).
- Every protocol adapter documents its fidelity level in `hertzbench/docs/fidelity.md`.
- No telemetry, no network calls except those the scenario explicitly requests.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Velxio's QEMU Wi-Fi does not expose a clean L2 hook | Phase 0 finding; fallback to QEMU-level netdev change as a tagged core patch |
| ESP-NOW/BLE not emulated at MAC/controller level | F3 shim with explicit fidelity label |
| Xtensa wall-clock makes latency non-reproducible | Modelled latency in engine; prefer ESP32-C3 for timing-critical examples |
| Performance with many QEMU instances | Measure in Phase 1; document limits (target ≥10 nodes on a laptop); LoRa/nRF24 on lightweight AVR/RP2040 for big swarms |
| Upstream diverges heavily | Minimal core surface (D4), frequent merges, adapters absorb changes |
| AGPL obligations misunderstood by contributors | LICENSE, NOTICE and CONTRIBUTING explain them in plain words |

## 13. Definition of done for the MVP

`docker compose -f docker-compose.hertzbench.yml up` + `hertzbench run hertzbench/scenarios/examples/udp-3-nodes.yaml` runs 3 ESP32 boards headless, prints a report with per-link RSSI/loss/latency and a pass/fail for assertions, writes `metrics.json` and `air.pcap` openable in Wireshark, and the same run is callable from Claude Code through the MCP server.

## 14. First instruction for Claude Code

Start with **Phase 0 only**. Fork/clone, run Velxio locally, produce `hertzbench/docs/discovery.md` and the two ADRs, then stop and summarize findings and proposed changes to this plan. Do not write engine code before the owner approves.
