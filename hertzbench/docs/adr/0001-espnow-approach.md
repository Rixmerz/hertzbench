# ADR 0001: ESP-NOW approach (F1)

- Status: Accepted for Phase 0. Implemented in Phase 4 (2026-10) before the gate below had run; the gate passed on real firmware on 2026-10-24, with a patch to the fork. See "Phase 4" and "On real firmware" at the end.
- Date: 2026-10-22
- Evidence: [discovery.md](../discovery.md), Q3 and Q8.

## Context

PLAN.md §7 gives two options for ESP-NOW:

- **Preferred:** capture the 802.11 action frames, if Velxio's QEMU emulates the Wi-Fi MAC. This is fidelity **F1**: the same unmodified binary, with frames taken at the emulated MAC level.
- **Fallback:** a simulation-only shim of the `esp_now_*` API over a socket. This is fidelity **F3**: a firmware build that differs from production.

The evidence for the preferred option is in the public `lcgamboa/qemu` fork, branch `picsimlab-esp32`, commit `9c29898`:

- The fork models an access point. Its ACTION-frame path converts pseudo-Ethernet frames from the netdev into 802.11 action frames, and converts outgoing action frames back to pseudo-Ethernet with `qemu_send_packet` (`hw/misc/esp32_wifi_ap.c:396-460` and `:561-643`). ACK pseudo-frames are handled at `:465-476`.
- The NIC is a standard QEMU NIC: `qemu_new_nic` at `:539`. Any QEMU netdev backend can sit behind it.
- The firmware-visible RSSI is synthetic (`hw/misc/esp32_wifi.c:327`).
- Unicast frames wait for an ACK for `WAIT_ACK_TIMEOUT` = 10 ms of virtual time (`esp32_wifi_ap.c:45`).

The Velxio worker currently attaches a SLIRP user-mode netdev, and it builds that argument from fixed fields: `backend/app/services/esp32_worker.py:425-475` and `:889-891`. Nothing reads a netdev override from the environment or the config.

Nothing has been run. There is no `libqemu` in this tree (`prebuilt/qemu/` holds only `.gitkeep`), and Docker is not installed. So "the fork carries ESP-NOW frames end to end" is an inference from the code, not a measured result.

## Decision

Use **F1**. The boards keep the production Wi-Fi driver and the fork's MAC model. Each board's NIC is changed from SLIRP to a QEMU `socket` netdev that connects to the hertzbench L2 switch. The engine carries the frames between boards and applies the channel model.

- The fork is **not** changed. Only the Velxio worker changes, in tagged core patches in `esp32_worker.py`: the netdev at `:425-475` and `:889-891`, and a per-instance eFuse image in the argv block at `:863-895` (discovery.md, Q8, items 1 and 1b).
- **Station MAC.** Without a per-instance eFuse image, every board takes the same default station MAC (`hw/nvram/esp32_efuse.c:164-168`), and the fork drops frames whose source is its own MAC (`hw/misc/esp32_wifi_ap.c:405`, `:471`). The per-board image is therefore part of the decision, not an option.
- The L2 switch forwards the pseudo-Ethernet frames as opaque bytes. It needs no 802.11 parser. It must carry the channel: the fork filters incoming frames by the channel in `buf[12] & 0x0F` (`esp32_wifi_ap.c:403`), so the engine must keep the channel with each frame.
- **Gate:** Phase 4 does not start until the Phase 1 spike shows two boards with **distinct station MACs** exchanging one ESP-NOW frame through the switch, and an ACK coming back. If the spike fails, the fallback is the F3 shim in PLAN §7. That change needs its own ADR.

## Consequences

- **ACK budget.** The ACK wait is 10 ms of guest virtual time, and it covers a round trip: the frame out, and the ACK back (`esp32_wifi_ap.c:45`, ACK sent at `:455-462`). The engine's latency for both legs, plus the receiver's processing, must fit inside that. Any link latency that does not fit makes the sender time out, and the failure looks like a radio problem, not a simulator one. Phase 1 must test this with a latency sweep.
- **Addressing.** A `socket` netdev has no DHCP or DNS, which SLIRP gives the guest today (`esp32_worker.py:472`). Phase 1 uses static addresses or an engine-side DHCP server. [I] Not tested.
- **Clock.** The fork's timers run on `QEMU_CLOCK_VIRTUAL`. The worker comment at `esp32_worker.py:443` says `QEMU_CLOCK_REALTIME`. Which one the shipped library uses is not settled (discovery.md, Q3). The report must say which clock each node used (PLAN §8).
- **RSSI.** The firmware sees a random RSSI (`esp32_wifi.c:327`). Link-quality metrics come from the engine, not the firmware. Any firmware-visible RSSI needs a patch to the fork, which we do not plan.
- **Pcap.** The frames are in the fork's pseudo-Ethernet encoding. Wireshark needs a converter to 802.11 with a radiotap header, or `air.pcap` shows the wrong layer. The converter belongs in the engine.
- **Platform limits.** The classic ESP32 always gets a radio (`esp32_worker.py:466-467`). The C3 gets one only for a sketch that uses Wi-Fi (`:462-465`), and it hits an eFuse assertion with a NIC present (worker comment `:449-460`). The S3 has no radio (`:468-471`). ESP-NOW examples therefore start with the classic ESP32.
- **Upstream.** Velxio's shipped library may differ from the public fork. Until the Phase 1 spike runs against the shipped `.so`, this ADR rests on the public fork.
- **Fidelity label.** The CLI reports this protocol as F1 (PLAN D10), with the caveats above.

## Phase 4

The owner asked for Phase 4 on a host without libqemu, so it was built against the fork's code and tested with a model of it instead of after the gate. What was built, and where this ADR's consequences went:

- **No change to the fork or to Velxio** beyond Phase 1's patch: the netdev and the per-board eFuse image already give each board its own station MAC on the switch.
- **ACK budget:** the engine measures each unicast frame's round trip and drops an ACK that would arrive after the 10 ms wait, because the fork does not check which frame an ACK answers. A latency sweep on both legs tests the boundary (`tests/espnow_test.ts`). This replaces the Phase 1 warning on one-way p95 over 5 ms.
- **Channel:** the engine reads it from byte 12 of each frame.
- **Pcap:** `air-80211.pcap` holds the 802.11 + radiotap view; `air.pcap` keeps the netdev bytes.
- **Platform:** the examples use the classic ESP32.

The gate is now the first step of the ESP-NOW run in [e2e-esp32.md](../e2e-esp32.md). If it fails, this ADR's fallback (the F3 shim) still applies, and so does the need for its own ADR. [fidelity.md](../fidelity.md#esp-now) lists what is read from the code rather than measured.

## On real firmware (2026-10-24)

The gate ran: `espnow-mesh-5-nodes.yaml` passes 7/7 on a libqemu built from the public fork, so F1 stands and the F3 fallback is not needed. It did take a change this ADR said would not happen: a small patch to the fork's Wi-Fi MAC, applied to its source before building and recorded as patch 3 in [upstream-sync.md](../upstream-sync.md#patch-3-the-qemu-forks-wi-fi-mac-esp-now-receive-and-tx-done-outside-this-tree). Unpatched, the fork's NIC stops reading its netdev for good once its 20-frame injection queue overflows, and it reports a unicast frame done before its ACK. No QEMU source or binary is kept in this tree. The "fork is not changed" line in the decision above held until this run.
