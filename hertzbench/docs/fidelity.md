# Fidelity

Every protocol and board declares how faithful it is (PLAN.md D10). `hertzbench run` prints this table in its report and writes it into `metrics.json`.

- **F1**: same unmodified binary, frames captured at the emulated hardware or MAC level.
- **F2**: same unmodified binary, frames captured at the network (layer 2 and up) level.
- **F3**: firmware built with a simulation-only shim in place of the radio driver.
- **none**: not firmware at all.

## What ships

| Component | Level | What it means |
|---|---|---|
| `qemu-wifi-l2` adapter, Wi-Fi/IP | **F2** | The board runs the production Wi-Fi driver. Its QEMU network device is a `stream` netdev to the engine. The engine sees Ethernet frames after the guest's embedded access point has converted 802.11 to Ethernet. It does not see the 802.11 exchange. |
| `qemu-wifi-l2` adapter, ESP-NOW (Phase 4) | **F1** | The same adapter and netdev. The fork's Wi-Fi MAC model turns each 802.11 action frame into pseudo-Ethernet; the engine carries it as bytes and applies the channel model. See [ESP-NOW](#esp-now) below. |
| `esp32` board | F2 for Wi-Fi/IP, F1 for ESP-NOW | The classic ESP32 only, machine `esp32-picsimlab`. The C3 asserts in eFuse reload when a NIC is attached, and the S3 machine models no radio (`esp32_worker.py`, `wifi_nic_arg`). |
| `scripted` board | **none** | A traffic generator that speaks the netdev framing, answers DHCP and pings, and sends ESP-NOW through a model of the fork's MAC (`orchestrator/boards/espnow-fork-model.ts`). It is not firmware and not an emulator. It exists so the engine, adapter, metrics and assertions run on a host without libqemu. Do not use it to say anything about firmware. |
| Internet gateway node (`internet_gateway: true`) | n/a | The one board that keeps SLIRP. See below. |
| BLE, LoRa, nRF24 | not yet | ADR [0002](adr/0002-ble-approach.md) (BLE, F3). |

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

## ESP-NOW

**Status: built from the fork's code, never run against QEMU.** The host this was written on has no libqemu. The ADR 0001 gate, two boards with distinct station MACs exchanging one ESP-NOW frame through the switch and an ACK coming back, has not been run; [e2e-esp32.md](e2e-esp32.md) makes it the first check. Everything below about the fork is read from `lcgamboa/qemu`, branch `picsimlab-esp32`, commit `9c29898`, which may differ from the library Velxio ships. The tests run the engine against a model of that code.

**Level F1.** The firmware is the production binary and calls the real `esp_now_*` API. Its Wi-Fi driver hands 802.11 action frames to the fork's MAC model, which writes them to the netdev as pseudo-Ethernet (`hw/misc/esp32_wifi_ap.c:608-645`):

| Bytes | Action frame | ACK |
|---|---|---|
| 0-5 | destination MAC (a peer, or `ff:ff:ff:ff:ff:ff`) | the sender of the frame it answers |
| 6-11 | the board's station MAC | the board's station MAC |
| 12 | `0xA0` \| channel, or `0xB0` \| channel when protected | `0xA0` \| channel |
| 13 | `0x0d` | `0x1d` |
| 14- | the 802.11 frame body (the ESP-NOW vendor-specific action) | nothing |

The engine classifies them as frame kinds `espnow` and `espnow-ack`, with the fork's own checks.

**Station MACs.** Every board gets `02:68:7a:62:01:NN` from a per-board eFuse image (NN is the board's place in the scenario). The fork drops any frame whose source is its own MAC (`:405`, `:471`), so two boards with the default MAC could not hear each other. Sketches that need a peer's MAC can compute it from that scheme; the example sketches do.

**Channel.** An ESP-NOW frame is on the channel the guest wrote into byte 12, not the one the scenario gives its sender: the receiving fork drops any other (`:403`). A node hears it when its scenario `channel` matches. When a node transmits on a channel its scenario does not say, `metrics.json` and the report carry a warning. Set each node's `channel` to the channel its sketch selects.

**Action frames** take the channel model of any frame: rate from SNR, backoff, up to `retry_limit` attempts, loss, jitter, overrides. A unicast frame stands for the whole 802.11 exchange including its ACK, as for Wi-Fi/IP. A broadcast frame gets one attempt at the basic rate and no ACK.

**ACKs** are not frames of their own on the channel model; the action frame's MAC outcome already counted the ACK. The receiving fork sends one for every unicast frame it accepts, at once (`:425-462`). The engine delays it by SIFS, its airtime at 6 Mbit/s and propagation, plus the reverse link's `extra_latency_ms`. No loss, no retries, no `base_latency_ms` and no jitter.

**The 10 ms ACK wait.** A unicast sender waits `WAIT_ACK_TIMEOUT` = 10 ms of guest time for the ACK, then reports the frame as failed (`:45`, `:640-643`). The **round trip** is the time from the action frame going on the air to its ACK reaching the sender: the frame's modelled delay, then the receiver's processing, then the ACK's delay. When it passes 10 ms the engine **drops the ACK** (`ack_timeout`) instead of delivering it late:

- the fork does not check which frame an ACK answers (`:465-476`). A late ACK for one frame would complete the sender's *next* frame, which then reports success it never earned;
- it calls `timer_mod_anticipate` on the ACK timer. On a timer that already fired, upstream QEMU arms it again, so a late ACK would also give the guest a second completion [inferred from upstream QEMU; `util/qemu-timer.c` is not in the checkout read];
- no real radio sends an ACK 10 ms late.

An ACK for which no frame is waiting (already answered, or lost on the way) is dropped as `ack_unmatched`.

**Outcomes.** Every unicast ESP-NOW frame ends in one of four outcomes, in `events.jsonl` (`"type":"espnow-send"`, with `roundTripMs`), per link in `metrics.json` (`espnow`) and in the report's ESP-NOW table:

| Outcome | Meaning | The sender's firmware sees |
|---|---|---|
| `acked` | the ACK came back within 10 ms | success |
| `frame_lost` | the channel model, a loss override, a channel mismatch or a disconnected peer lost the frame | failure, after 10 ms |
| `ack_timeout` | the frame arrived, the ACK would have come too late | failure, after 10 ms; **the receiver still got the data** |
| `no_ack` | the frame arrived and the receiver never answered (its fork filtered it, for example on another channel) | failure, after 10 ms |

`acked_pct` and `ack_rtt_p95_ms` can be asserted. A link with any `ack_timeout` gets a warning that names its slowest round trip.

**Retries count against the wait.** At the edge of range a frame takes several attempts, each with a backoff from a doubling window. Their time is part of the round trip, so a frame that the channel model delivers on its sixth attempt may still fail at the sender. `espnow-mesh-5-nodes.yaml` shows it when sensor-4 walks away.

**Clock.** On the manual clock of the tests the round trip is exact. In a real run the engine judges it on its own wall clock. That clock sees the receiver's processing and the loopback hop from the receiver, but not the hop from the sender's QEMU to the engine. On loopback that hop is well under a millisecond, but within it of 10 ms the engine and the guest's timer can disagree. If the engine forwards an ACK the guest has already given up on, the guest gets the spurious completion described above. The scripted board logs it as `espnow tx done (...) with nothing in flight`. The Xtensa guest runs without `-icount`, so its virtual clock follows host time; the report says so per node.

**Not known without running the fork.** The fork's DMA path raises a tx-done interrupt as soon as the guest hands it a frame, and a second one when the ACK timer fires (`hw/misc/esp32_wifi.c:296-309`, `esp32_wifi_ap.c:121-126`). Which of the two the binary Wi-Fi driver turns into the ESP-NOW send callback, and with which status, depends on the closed driver. The model, the scripted board and this page assume the second. If the first wins, every unicast send would report its status at once.

**Captures.** `air.pcap` keeps every frame as the netdev carries it, so ESP-NOW frames there are the fork's pseudo-Ethernet, which Wireshark shows as an unknown EtherType. A run that carried ESP-NOW also writes `air-80211.pcap` (link type 127) with each action frame and ACK rebuilt as 802.11 behind a radiotap header that holds the channel. The fork does not carry the BSSID or the sequence number, so the BSSID is `ff:ff:ff:ff:ff:ff` and the sequence is 0. Whether the guest's frame body ends in an FCS is not known, so the radiotap header does not claim one. The byte layout is pinned by a test; the file has not been opened in Wireshark on this host.

**Not modelled.**

- ESP-NOW's default rate is 1 Mbit/s (802.11b DSSS); the model uses the OFDM rates of Wi-Fi/IP. A real 1 Mbit/s frame spends longer on the air, so the model's round trips are a little shorter than a real radio's.
- Encryption: the protected flag passes through, nothing is ciphered or checked.
- The RSSI the firmware reads in its receive callback is the fork's random number (`esp32_wifi.c:327`); the report's RSSI comes from the engine.
- Long-range mode, per-peer channels and channel changes while running. The engine reads each frame's channel, but the warning only flags a sender that disagrees with the scenario.
