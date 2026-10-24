# Fidelity

Every protocol and board declares how faithful it is (PLAN.md D10). `hertzbench run` prints this table in its report and writes it into `metrics.json`.

- **F1**: same unmodified binary, frames captured at the emulated hardware or MAC level.
- **F2**: same unmodified binary, frames captured at the network (layer 2 and up) level.
- **F3**: firmware built with a simulation-only shim in place of the radio driver.
- **none**: not firmware at all.

## What ships

| Component | Level | What it means |
|---|---|---|
| `qemu-wifi-l2` adapter, Wi-Fi/IP | **F2** | The board runs the production Wi-Fi driver. Its QEMU network device is a `socket` netdev to the engine. The engine sees Ethernet frames after the guest's embedded access point has converted 802.11 to Ethernet. It does not see the 802.11 exchange. |
| `qemu-wifi-l2` adapter, ESP-NOW (Phase 4) | **F1** | The same adapter and netdev. The fork's Wi-Fi MAC model turns each 802.11 action frame into pseudo-Ethernet; the engine carries it as bytes and applies the channel model. See [ESP-NOW](#esp-now) below. |
| `esp32` board | F2 for Wi-Fi/IP, F1 for ESP-NOW, F3 for BLE | The classic ESP32 only, machine `esp32-picsimlab`. The C3 asserts in eFuse reload when a NIC is attached, and the S3 machine models no radio (`esp32_worker.py`, `wifi_nic_arg`). |
| `scripted` board | **none** | A traffic generator that speaks the netdev framing, answers DHCP and pings, and sends ESP-NOW through a model of the fork's MAC (`orchestrator/boards/espnow-fork-model.ts`). On LoRa, nRF24 and BLE it replays the host side of a sketch over the same socket firmware would use (for BLE, a small HCI host in `orchestrator/boards/drivers/hci-host.ts`). It is not firmware and not an emulator. It exists so the engine, adapter, metrics and assertions run on a host without libqemu. Do not use it to say anything about firmware. |
| Internet gateway node (`internet_gateway: true`) | n/a | The one board that keeps SLIRP. See below. |
| LoRa (SX127x) and nRF24L01+ (Phase 3) | **F1** | The same firmware binary; the radio chip is modelled at its SPI interface (`adapters/lora-sx127x/`, `adapters/nrf24/`, over `adapters/spi-link/`). |
| Mobile bridge (Phase 5) | n/a | Not a board: a real phone's traffic, replayed by a station on the medium. The phone-to-host leg is real and not modelled; the bridge-to-board leg pays the channel model. See [Mobile bridge](#mobile-bridge) below. |
| `ble-hci` adapter, BLE (Phase 6) | **F3** | The firmware's own BLE host stack (Bluedroid) runs, built host-only with HCI over UART1; the board relays that UART to a virtual link-layer controller in the engine. The binary differs from production. See [BLE](#ble) below. |

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

**Status: passes on real firmware (2026-10-24) with the fork patched.** With a libqemu built from the fork named below plus hertzbench's patch to its Wi-Fi MAC ([upstream-sync.md, patch 3](upstream-sync.md#patch-3-the-qemu-forks-wi-fi-mac-esp-now-receive-and-tx-done-outside-this-tree)), `espnow-mesh-5-nodes.yaml` passes 7/7: distinct station MACs, one frame and one ACK per send (the ADR 0001 gate), every reading acked before the move and sensor-4's frames mostly lost after it. On the unpatched fork the gateway stops reading its netdev for good once its 20-frame injection queue overflows (no `qemu_flush_queued_packets`), and the run failed 4 of 7; see [e2e-esp32.md](e2e-esp32.md#the-esp-now-example). Everything below about the fork is read from `lcgamboa/qemu`, branch `picsimlab-esp32`, commit `9c29898`, which may differ from the library Velxio ships. The tests run the engine against a model of that code.

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

**Clock.** On the manual clock of the tests the round trip is exact. In a real run the engine judges it on its own wall clock. That clock sees the receiver's processing and the loopback hop from the receiver, but not the hop from the sender's QEMU to the engine. On loopback that hop is well under a millisecond, but within it of 10 ms the engine and the guest's timer can disagree. If the engine forwards an ACK the guest has already given up on, the guest gets the spurious completion described above. The scripted board logs it as `espnow tx done (...) with nothing in flight`. The scripted board is not a guest, so it avoids the disagreement: it waits 10 ms plus a 30 ms allowance for the two loopback hops, which makes the ACK the engine's verdict (a failed send is reported about 40 ms after it, not 10). The Xtensa guest runs without `-icount`, so its virtual clock follows host time; the report says so per node.

**Which tx-done counts.** The unpatched fork's DMA path raises a tx-done interrupt as soon as the guest hands it a frame, and a second one when the ACK timer fires (`hw/misc/esp32_wifi.c:296-309`, `esp32_wifi_ap.c:121-126`). Patch 3 drops the first for unicast action frames, so the only completion the driver sees is the ACK timer's, which is what the model and the scripted board do. **Frames, not sends.** The engine's ESP-NOW counts are per frame on the air. On real firmware the closed Wi-Fi driver resends an unacked unicast frame itself before calling the sketch's send callback: in the 2026-10-24 run sensor-4's 60 readings after the move took 472 frames, 12.5% of them acked, and its sketch saw every reading succeed. The scripted board sends each frame once, so its sketch-level and frame-level counts are the same.

**Captures.** `air.pcap` keeps every frame as the netdev carries it, so ESP-NOW frames there are the fork's pseudo-Ethernet, which Wireshark shows as an unknown EtherType. A run that carried ESP-NOW also writes `air-80211.pcap` (link type 127) with each action frame and ACK rebuilt as 802.11 behind a radiotap header that holds the channel. The fork does not carry the BSSID or the sequence number, so the BSSID is `ff:ff:ff:ff:ff:ff` and the sequence is 0. Whether the guest's frame body ends in an FCS is not known, so the radiotap header does not claim one. The byte layout is pinned by a test; the file has not been opened in Wireshark on this host.

**Not modelled.**

- ESP-NOW's default rate is 1 Mbit/s (802.11b DSSS); the model uses the OFDM rates of Wi-Fi/IP. A real 1 Mbit/s frame spends longer on the air, so the model's round trips are a little shorter than a real radio's.
- Encryption: the protected flag passes through, nothing is ciphered or checked.
- The RSSI the firmware reads in its receive callback is the fork's random number (`esp32_wifi.c:327`); the report's RSSI comes from the engine.
- Long-range mode, per-peer channels and channel changes while running. The engine reads each frame's channel, but the warning only flags a sender that disagrees with the scenario.

## BLE

**Status: run with firmware on 2026-10-23, passing.** The ADR 0002 gate is met: the `fw/ble-sensor` build of ESP-IDF v5.3.6 boots Bluedroid host-only over the external HCI UART under the fork's QEMU, and `ble-sensors-3-nodes.yaml` passes ([e2e-esp32.md](e2e-esp32.md#results-on-real-firmware)). Bluedroid sends one command the controller does not implement, 0x2027 (LE Set Privacy Mode), and carries on after the "Unknown HCI Command" answer.

**Level F3.** The QEMU fork maps the Bluetooth block as an unimplemented device and has no HCI (discovery Q4). So the firmware is a simulation-only build: Bluedroid with `CONFIG_BT_CONTROLLER_DISABLED=y`, attached to an H4 driver on UART1 with `esp_bluedroid_attach_hci_driver` (`scenarios/examples/fw/ble-sensor`, adapted from ESP-IDF's `bluedroid_host_only_uart` example). Everything above HCI, GAP, GATT, ATT, L2CAP and the application, is the real stack. Everything below HCI is the engine's.

**The path.** UART1's bytes leave the Velxio worker one `uart_tx` event at a time. The ESP32 board (`orchestrator/boards/qemu-esp32.ts`) gathers them and writes them to the node's `ble-hci` port; the controller's answers go back as `uart_send` commands. Both commands already exist in the worker, so BLE needs **no Velxio patch**. The UART's baud rate and pins do not matter to the emulated UART; hardware flow control is off in the example firmware because nothing drives CTS. Which UART carries HCI is the radio's `hci_uart` (1 or 2; UART0 is refused, it is the console).

**The virtual controller** (`adapters/ble-hci/controller.ts`) answers the HCI commands a host sends to bring LE up and use it (the list is `SUPPORTED_COMMAND_BITS` in `adapters/ble-hci/hci.ts`; its Supported Commands bitmap was checked by decoding it with BlueZ's `btmon`). A command it does not implement is answered "Unknown HCI Command" and named once in the report's warnings: on the first run with real firmware, that list is where to look if the stack stalls during start-up. It reports HCI and LL version 4.2, company 0xFFFF, no optional LE features, 10 LE buffers of 27 bytes. Below HCI it plays the link layer on the 1M PHY (Core v5.x, Vol 6 Part B):

| Modelled | How |
|---|---|
| Legacy advertising | `ADV_IND`, `ADV_SCAN_IND`, `ADV_NONCONN_IND` on the channels of the map, 1 ms apart, every interval plus a random 0-10 ms advDelay. After each connectable or scannable packet the advertiser listens for a request for T_IFS (150 us) plus 50 us. |
| Scanning | Passive and active (`SCAN_REQ`/`SCAN_RSP`), windows rotating over 37, 38, 39, duplicate filtering, the filter accept list. An active scanner requests every advertisement it hears (no backoff). |
| Connecting | The initiator answers a connectable advertisement from its peer, or from any device on the accept list, with `CONNECT_IND` T_IFS later. It picks the transmit window offset so the anchors of its connections stay 3 ms apart when their intervals are equal. |
| Connections | Connection events at the interval, channel selection algorithm #1 over all 37 data channels, SN/NESN acknowledgement with retransmission of the unacknowledged packet, the MD bit (more exchanges while there is room before the next anchor), empty PDUs, supervision timeout (0x08), failure to establish within 6 events (0x3E). |
| Procedures | Connection update from the central (`LL_CONNECTION_UPDATE_IND`, instant 6 events ahead; a peripheral that gets it late drops the link, 0x28), termination (`LL_TERMINATE_IND`), version and feature exchange, `LL_UNKNOWN_RSP` to anything else. |
| Data | HCI ACL packets of up to 27 bytes go out one per data PDU (longer ones are fragmented). Number Of Completed Packets returns a buffer when the peer acknowledges the packet. |
| RSSI | The RSSI in an LE Advertising Report and in Read RSSI is the **engine's**, rounded to a dBm. Unlike Wi-Fi, the firmware sees the channel model. |

**The air.** Every packet is a frame on the chip-level air (`engine/air.ts`): log-distance path loss at the channel's frequency, shadowing, walls, a 1 MHz noise floor with the environment's noise figure, and the error rate of `engine/channel.ts` set so a 39-byte PDU is lost 10% of the time at the ESP32's -97 dBm sensitivity. Two packets on the same BLE channel that overlap at a receiver collide unless one is 10 dB stronger (the ESP32 datasheet's co-channel C/I). A radio that is transmitting, or locked onto another packet, does not hear. `extra_loss_pct` drops packets; `extra_latency_ms` and `base_latency_ms` delay every packet, and the link layer's timing is tight: a reply that starts more than 50 us after its window opened is missed, so a few hundred microseconds of extra latency break the link the way distance does.

**Metrics.** Three frame kinds: `ble-adv` (advertising-channel packets), `ble-data` (data-channel packets, empty and control PDUs included) and `ble-acl` (one HCI ACL packet carried from one host to the other). `ble-adv` and `ble-data` delays are time on air plus propagation. A `ble-acl` delivery is logged once, when the peer first receives the packet's last fragment; its delay runs from the moment the host handed it to its controller, so it includes the wait for a connection event and every retransmission, and its `attempts` counts the transmissions. A `ble-acl` packet still queued when its connection ends is dropped as `link_lost`. While a connection holds, the link layer retransmits until a packet gets through, so ACL loss is zero and the cost of a bad link shows in the latency. `events.jsonl` has a `ble-link` event each time a side's controller sees a connection come up or go down, with the HCI reason; the report lists them.

**Captures.** `air.pcap` uses `LINKTYPE_BLUETOOTH_LE_LL_WITH_PHDR` (256): each packet as on the air without its preamble (access address, PDU, CRC) behind a 10-byte header that holds the RF channel and the transmit power. The CRC is computed with the Core spec's LFSR and the record's flags do not claim it was checked, so Wireshark checks it itself; the layout is pinned by tests and the file has not been opened in Wireshark on this host. `hci-<node>.btsnoop` holds every HCI packet between a node's host and its controller (btsnoop, datalink 1002); BlueZ's `btmon -r` decodes them, and a CLI test does.

**Addresses.** A node's public device address is its station MAC, `02:68:7a:62:01:NN`, NN being its place in the scenario. Read BD_ADDR returns it; firmware that connects to a peer by address can compute it.

**Clock.** BLE runs on the paced clock of the chip radios: each link-layer step happens at its modelled instant, in order, paced to real time. HCI is not timing-critical, but on an ESP32 board it rides the worker's stdout and stdin pipes, so a command's answer reaches the firmware later than on silicon.

**Not modelled.**

- Encryption and pairing: no LE Start Encryption, no LTK request, and the LE features say so. A GATT server that requires an encrypted link refuses the access, and SMP pairing does not complete.
- Directed advertising (refused with 0x11), extended and periodic advertising, the 2M and Coded PHYs, the data length extension (PDUs carry at most 27 bytes), privacy and resolvable private addresses (the identity address is used, with a warning), channel map updates, LE ping.
- Peripheral latency: a peripheral listens at every connection event. The connection parameters request procedure: a peripheral's host gets "Unsupported Remote Feature" from LE Connection Update and must use the L2CAP request instead, which works because it is ordinary ACL data.
- Sleep clock accuracy and window widening: both sides keep exact time; every receive window is 50 us wide. A controller's connection events that would overlap are skipped, not rescheduled.
- Event masks and controller-to-host flow control are accepted and not enforced: every event is sent.
- Interference between BLE and Wi-Fi: a scenario runs one PHY.

**Not known without running the firmware.** Whether Bluedroid host-only starts against this controller (the ADR 0002 gate); which vendor-specific commands it sends first (each is listed as a warning); and whether the fork's UART1 carries bytes both ways through `uart_tx` and `uart_send` (the worker relays any UART number, but only UART0 has been used).

## Mobile bridge

**Status: built and tested with scripted boards and stand-ins; no phone, LAN or Bluetooth adapter used.** [mobile-bridge.md](mobile-bridge.md) has the guide and the test list.

**IP (5a).** The phone's TCP connection ends at the host's proxy. A second connection, the bridge's, runs on the medium from the bridge's station (`engine/tcp.ts`): real segments with pseudo-header checksums, the MSS option, an RFC 6298 retransmission timer with go-back-N recovery, the peer's window, FIN and RST. Its segments are frames like any other: per-receiver RSSI and SNR from the bridge's position, rate fallback, MAC retries, link overrides. So the channel shows up to the phone as **delay** (MAC retries, then TCP retransmissions), never as loss or reordering, and the phone's own TCP behaviour (its window, its retransmissions) never reaches the board. Not modelled in the bridge's TCP: congestion control, fast retransmit, SACK, window scaling, timestamps, TIME_WAIT; received data is handed over at once, so the window it advertises is always 65535. The phone-to-host leg (the real Wi-Fi) adds its own latency on top and is not in any metric.

**BLE (5b).** The phone's GATT operations end at BlueZ. Each is replayed as one ATT request from the bridge's node, a central on the simulated air with its own virtual controller, so it waits for connection events and pays retransmissions like any ACL data, and the phone gets the node's answer once it has crossed the air. The phone's MTU, BlueZ's handles and the phone's link parameters are not mirrored: the simulated connection keeps ATT_MTU 23 and the bridge's `interval` and `timeout`. Writes over 20 bytes are refused; long and reliable writes, security and pairing are not carried. The host advertises the mirrored name and the first service UUID, not the node's advertising data.

**Metrics.** The bridge's links are in the report and `metrics.json` like a board's: `phone->web` with kind `tcp` for IP, `phone->sensor-1` with kinds `ble-data` and `ble-acl` for BLE. They measure the simulated leg only.

