# Fidelity

Every protocol and board declares how faithful it is (PLAN.md D10). `hertzbench run` prints this table in its report and writes it into `metrics.json`.

- **F1**: same unmodified binary, frames captured at the emulated hardware or MAC level.
- **F2**: same unmodified binary, frames captured at the network (layer 2 and up) level.
- **F3**: firmware built with a simulation-only shim in place of the radio driver.
- **none**: not firmware at all.

## What Phase 1 ships

| Component | Level | What it means |
|---|---|---|
| `qemu-wifi-l2` adapter, Wi-Fi/IP | **F2** | The board runs the production Wi-Fi driver. Its QEMU network device is a `stream` netdev to the engine. The engine sees Ethernet frames after the guest's embedded access point has converted 802.11 to Ethernet. It does not see the 802.11 exchange. |
| `esp32` board | F2 for Wi-Fi/IP | The classic ESP32 only, machine `esp32-picsimlab`. The C3 asserts in eFuse reload when a NIC is attached, and the S3 machine models no radio (`esp32_worker.py`, `wifi_nic_arg`). |
| `scripted` board | **none** | A traffic generator that speaks the netdev framing, answers DHCP and pings. It is not firmware and not an emulator. It exists so the engine, adapter, metrics and assertions run on a host without libqemu. Do not use it to say anything about firmware. |
| Internet gateway node (`internet_gateway: true`) | n/a | The one board that keeps SLIRP. See below. |
| ESP-NOW, BLE, LoRa, nRF24 | not in Phase 1 | ADRs [0001](adr/0001-espnow-approach.md) (F1) and [0002](adr/0002-ble-approach.md) (F3). |

## Clock and latency

- Every ESP32 node runs on **wall-clock time**: the Xtensa QEMU machine runs without `-icount` when Wi-Fi is on (`icount_shift_for_run`). The report says so per node, in `clock`.
- Latency is **modelled**: the delay the channel model assigned to a frame, which the engine then waits out in real time. It is not measured on a guest clock. `metrics.json` carries `"latency": "modelled"`.
- Time zero of a run is the moment every board's netdev has connected. Guest boot time counts toward `duration`.
- A move or fault made live through the MCP server (`move_node`, `inject_fault`) happens when the call arrives, on the wall clock. A run with live actions is not reproducible from its seed alone; put the same actions in the scenario `timeline` to replay it ([mcp.md](mcp.md)).

## Channel model v1

Per directed link (sender to receiver), per frame. Implemented in `hertzbench/engine/channel.ts`; golden values in `hertzbench/tests/engine_channel_test.ts`.

**Link budget**

```
PL(d)   = PL(d0) + 10 n log10(d / d0)          PL(d0) = free-space loss at d0 = 1 m on the channel's centre frequency
RSSI    = txPower + txGain + rxGain - PL(d) - shadowing - sum(wall attenuations crossed)
noise   = -174 dBm/Hz + 10 log10(20 MHz) + noise figure (10 dB)  = -90.99 dBm
SNR     = RSSI - noise
```

- Shadowing is one Gaussian sample per pair of nodes, `sigma` dB, drawn from the scenario seed and **kept when a node moves**. It is symmetric.
- A wall is a line segment; the direct path pays its attenuation once per wall crossed.
- Presets (`environment.preset`), all overridable per scenario:

| Preset | n | sigma (dB) | Jitter (ms): base + per metre |
|---|---|---|---|
| `free_space` | 2.0 | 0 | 0.05 + 0.001 |
| `indoor_office` (default) | 3.0 | 4 | 0.3 + 0.005 |
| `urban` | 3.5 | 6 | 0.5 + 0.005 |
| `rural` | 2.2 | 3 | 0.1 + 0.002 |

**MAC and PHY** (simple 802.11g, not a chip model)

- The sender uses the highest OFDM rate (6 to 54 Mbit/s) whose minimum SNR the link meets, else 6 Mbit/s. The thresholds are the 802.11 minimum receiver sensitivities (-82 dBm at 6 Mbit/s up to -65 dBm at 54 Mbit/s) over a -91 dBm noise floor.
- Frame error rate: the bit error rate rises tenfold per 1.5 dB below the rate's threshold and a frame survives only if every bit does, so loss is a cliff, not a slope. A 1000-byte frame is lost 10% of the time exactly at the threshold; a 100-byte frame goes from about 1% to certain loss within roughly 4 dB.
- A unicast frame is retried up to **7 attempts**, each with a random backoff from a contention window that doubles (15 to 1023 slots of 9 us) plus DIFS, airtime and, on failure, the ACK timeout. A frame that runs out of attempts is lost (`retry_exhausted`). Broadcast and multicast frames use the basic rate, one attempt, no ACK.
- Delay of a delivered frame = time spent in the attempts that ended at the successful one + propagation (d/c) + `base_latency_ms` + a uniform jitter up to `jitterBase + jitterPerMeter * d` + any `extra_latency_ms` override.
- Overrides per link (`links` and the timeline `link`): `extra_loss_pct` (applied after the MAC succeeded) and `extra_latency_ms`.
- Radios on different channels do not hear each other. Adjacent-channel interference is not modelled.

**Determinism.** Every frame draws from its own random stream named by `(seed, sender, receiver, ordinal of the frame on that link)`. Outcomes therefore do not depend on how frames from different links interleave, which on wall-clock boards differs every run. The same frame sequence on a link with the same seed gives the same outcomes. Tested in `engine_medium_test.ts`.

**Not modelled in Phase 1**

- Collisions, carrier-sense contention between stations, hidden nodes, and the capture effect. Each link is simulated alone.
- ACK loss (a lost ACK does not cause a duplicate), RTS/CTS, fragmentation, power save, 802.11n/ac rates and rate-adaptation dynamics. The rate is chosen from the link's SNR.
- The 802.11 association and beacon exchange. Each board associates with the access point that is part of its own QEMU; the engine models the hop between stations.
- Firmware-visible RSSI. The RSSI the firmware sees is a random number (`hw/misc/esp32_wifi.c:327`). The RSSI in the report comes from the engine.

## Addressing

A QEMU socket netdev has no DHCP, ARP or DNS peer (SLIRP provided them). The engine hosts a **virtual gateway** on the switch, at `.1` of the subnet (default `192.168.4.0/24`), with MAC `02:68:7a:62:00:01`:

- it answers ARP for its own address and DHCP with a **static lease per board** taken from the scenario, so addresses are fixed (`.11`, `.12`, ... in scenario order, or `ip:` per node);
- there is **no DNS**: peers are addressed by IP;
- its traffic bypasses the channel model. It carries nothing a scenario measures, and a far node must not fail to boot. Boards can still lose their own UDP.

Each board gets a distinct locally-administered station MAC (`02:68:7a:62:01:NN`) through a per-board eFuse image. The switch is **static** and never learns: every board's embedded access point uses the same AP MAC, so source learning would see one MAC on every port. Frames to the gateway, to a board's MAC, or flooded (broadcast, multicast, unknown MAC) are the only cases.

## The internet gateway node

A board has exactly one Wi-Fi NIC, so a board cannot be on the medium and on SLIRP at once. `internet_gateway: true` marks the one ESP32 that keeps SLIRP (and its `hostfwd`). It is **not on the medium**: it cannot exchange frames with the other boards and gives them no internet access. Use it to run a board that talks to an MQTT broker or a web server on the host. Routing between the medium and the internet needs a second QEMU or a user-space NAT in the engine and is not part of Phase 1.

## ESP-NOW ACK budget

The fork waits 10 ms of virtual time for the ACK of a unicast ESP-NOW frame; that is a round trip (`esp32_wifi_ap.c:45`). The engine carries the fork's pseudo-Ethernet ESP-NOW frames as opaque bytes and flags them (`espnow-pseudo-ethernet`). If a link's p95 one-way delay for such frames passes 5 ms, `metrics.json` and the report carry a warning. Phase 4 owns the rest (ADR 0001).
