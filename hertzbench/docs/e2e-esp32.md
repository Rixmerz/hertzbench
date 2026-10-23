# Running the ESP32 example end to end

`hertzbench run hertzbench/scenarios/examples/udp-3-nodes.yaml` starts three ESP32 boards under QEMU, puts their Wi-Fi on the engine's virtual switch, and reports what the channel model did to their UDP traffic.

**Status: never run.** The host this was written on has no Docker and no libqemu, so nothing below the engine, adapter and orchestrator has been exercised against QEMU. Everything marked **[unverified]** is read from the code. Use the checks in "First run" to settle each one, and report what you find.

## What you need

| Need | Why | Check |
|---|---|---|
| Deno 2.x | the engine, adapter, orchestrator and CLI | `deno --version` |
| Python 3.11+ with `backend/requirements.txt` | the Velxio worker and the compile helper | `python3 -c "import app"` from `backend/` |
| `libqemu-xtensa.so` and its ROM files | the ESP32 machine | `ls "$QEMU_ESP32_LIB"` |
| The ESP-IDF toolchain Velxio uses | compiling the sketch | `python3 hertzbench/orchestrator/compile_sketch.py hertzbench/scenarios/examples/fw/udp-node` |

Skip the last row by giving the scenario a prebuilt flash image: set `firmware:` to a `.bin` path. Build it once in the Velxio UI or with `compile_sketch.py` and decode its `firmware_b64` into a file.

### Getting libqemu

Velxio's `Dockerfile.standalone` refuses to build without either a velxio.dev licence key or the QEMU runtime libraries in `prebuilt/qemu/` (`Dockerfile.standalone:46-58`). The build steps for the libraries are in `docs/BUILD-QEMU.md`. Put `libqemu-xtensa.so` and the ROM binaries it needs in one directory and point at it:

```bash
export QEMU_ESP32_LIB=/path/to/libqemu-xtensa.so   # the worker passes -L <that directory>
```

Without it `hertzbench run` stops at once with `libqemu-xtensa not found` and exit status 2.

## Run it

```bash
cd hertzbench
deno task hertzbench run scenarios/examples/udp-3-nodes.yaml --out /tmp/hzb-out
```

The run lasts 90 s of engine time from the moment all three netdevs connect, plus the sketch's compile time on the first run. At 40 s board `c` moves behind the wall.

What a good run looks like:

- The report lists three nodes with clock `wall clock (QEMU Xtensa ...)`.
- `Phase "start"`: all six links at 0% loss, p95 under 2 ms.
- `Phase "behind-wall"`: `c->a` and `a->c` lose more than 20% of their frames and their p95 latency passes 4 ms; `c->b` and `b->c` stay clean.
- All assertions `PASS`, `RESULT: PASS`, exit status 0.
- Files in `/tmp/hzb-out`: `metrics.json`, `air.pcap`, `events.jsonl`, `serial-<node>.log`, `efuse-<node>.bin`, `worker-<node>.stderr.log`.

Open `air.pcap` in Wireshark. It has Ethernet frames: DHCP, ARP and the UDP datagrams, one record per frame a board put on the air. Frames lost on the channel are in `events.jsonl` (`"type":"drop"`), not in the capture.

## First run: settle the unverified points in this order

0. **A worker that dies at start-up stops the run at once.** `hertzbench` exits with status 2 within seconds, prints each board's problem (`worker exited early (code 1); see <out>/worker-a.stderr.log`) and does not wait out the 30 s connect timeout. Read that log first; QEMU's own complaint is in it.
1. **The worker accepts the arguments.** Look in `worker-a.stderr.log` for these two lines:

   ```
   WiFi radio attached (sketch wants WiFi: True): -nic stream,model=esp32_wifi,server=off,addr.type=inet,addr.host=127.0.0.1,addr.port=<port>
   eFuse image attached: <out>/efuse-a.bin
   ```

   If QEMU exits with an error about `-nic stream` **[unverified]**, change `wifi_nic_arg` to emit `-netdev stream,id=hzb-l2,...` and `-net nic,model=<model>,netdev=hzb-l2` (the note in [upstream-sync.md](upstream-sync.md)). If it complains about the `-global` binding **[unverified]**, check the device name `nvram.esp32.efuse` against the shipped library.
2. **Each board has its own MAC.** In `air.pcap` or `events.jsonl`, the source MACs must be `02:68:7a:62:01:01`, `:02` and `:03`. If every source is `10:01:00:c4:0a:24`, the eFuse image was not read and the boards cannot hear each other (ADR 0001, station MAC). This is also the Phase 1 gate for ESP-NOW: two boards with distinct MACs exchanging frames through the switch.
3. **The board connects and gets its address.** `events.jsonl` should hold `"type":"service"` events with `dhcp` details: `offer 192.168.4.11 to 02:68:7a:62:01:01`, then `ack`. The serial log should show `wifi up ip=192.168.4.11`. If DHCP never happens **[unverified]**:
   - the sketch is not associating: Velxio's compile step forces SSID `Espressif` on channel 5 (`espidf_compiler.py`), but Velxio's own docs say `Velxio-GUEST` on channel 6 (`docs/ESP32_WIFI_BLUETOOTH.md`). The access-point table lives in the shipped library; check which one it advertises and change the constants in `fw/udp-node/udp-node.ino` and the scenario's `channel` to match;
   - or lwIP's DHCP client rejects the offer (the engine sends it to the client's MAC with IP destination 255.255.255.255, with no DNS option). Capture with `air.pcap` and read the exchange. A sketch that calls `WiFi.config(ip, gateway, subnet)` before `WiFi.begin` skips DHCP, and the engine's static addresses are the same ones.
4. **UDP flows.** `serial-b.log` should show `rx ping:<n> from 192.168.4.11` and `rx pong:<n>`.
5. **The clock note.** The worker log says whether `-icount` is on. With Wi-Fi it is off, so guest time follows wall time. If a shipped library turns out to differ from the public fork (its beacon timer is on `QEMU_CLOCK_VIRTUAL` there and `QEMU_CLOCK_REALTIME` in the worker's comment), record it in the discovery notes.

## If the assertions fail

- `serial ... never seen`: the board did not boot, did not associate, or crashed. Read `serial-<node>.log` and `worker-<node>.stderr.log`. A `problem:` line in the report shows a worker that exited early.
- `metric ... no frames crossed a matching link`: nothing was sent between those nodes. Check the sketch's peer addresses against the report's `ip` column.
- `metric ... loss_pct` too high before the move: the link is already near the edge. Change `tx_power_dbm` or the positions, or lower the wall's `attenuation_db`. `hertzbench/tests/orchestrator_test.ts` checks the example's geometry against the engine with synthetic traffic, so a failure here with a clean engine check points at the traffic, not the model.

## The ESP-NOW example

`scenarios/examples/espnow-mesh-5-nodes.yaml` runs five ESP32 boards: a gateway (`fw/espnow-gateway`) and four sensors (`fw/espnow-sensor`) on Wi-Fi channel 1. Same needs as above; the sketches use the `esp_now_*` API of whichever arduino-esp32 core Velxio's compiler picks (2.x or 3.x; both callback signatures are guarded). **Never compiled or run**: the host this was written on has neither the toolchain nor libqemu.

```bash
cd hertzbench
deno task hertzbench run scenarios/examples/espnow-mesh-5-nodes.yaml --out /tmp/hzb-espnow
```

60 s of engine time; at 30 s sensor-4 walks from 18 m to 44 m. Settle these in order, after steps 0 and 1 of "First run" above:

1. **ADR 0001 gate: distinct MACs, one frame, one ACK.** Each `serial-<node>.log` starts with `espnow up mac=02:68:7a:62:01:0N channel=1`, N going from 1 (gw) to 5 (sensor-4). In `events.jsonl`, `"kind":"espnow"` frames from `02:68:7a:62:01:02` to `:01`, then `"kind":"espnow-ack"` frames back, and `"type":"espnow-send"` events with `"outcome":"acked"`. `serial-sensor-1.log` shows `espnow tx ok to gw`. If every source MAC is `10:01:00:c4:0a:24`, the eFuse image was not read. If the frames arrive and no ACK comes back, the shipped library differs from the public fork. Either way stop and record it in ADR 0001: the F3 fallback may be needed.
2. **The frames are the fork's encoding.** No `"kind":"other"` frames of 14 bytes or more from the boards apart from ARP or DHCP. If ESP-NOW shows up as `other`, byte 12 or 13 differs from `0xA0|channel` and `0x0d`/`0x1d`; compare with `hw/misc/esp32_wifi_ap.c` in the shipped library.
3. **The channel.** No `sends ESP-NOW on channel` warning in the report. If one appears, `esp_wifi_set_channel` did not take effect, or the fork maps the register write to another channel (`hw/misc/esp32_ana.c:41-45`); set the scenario's `channel` to what the warning says.
4. **Which tx-done the driver reports.** Before the move, the sensors' `espnow tx ok` lines should match the report's `acked` counts. If every send reports at once, success or failure, the driver takes the fork's first tx-done interrupt (raised as the frame leaves) and not the ACK timer's ([fidelity.md](fidelity.md#esp-now)). Record it there.
5. **The ACK window.** After the move, the ESP-NOW table shows sensor-4's `acked %` falling and `frame_lost` and `ack_timeout` rising, and `serial-sensor-4.log` shows `espnow tx fail to gw`. The firmware's own failures should roughly match `frame_lost + ack_timeout + no_ack`; near 10 ms of round trip they may differ by a few frames, because the engine judges on its own clock.

Open `air-80211.pcap` in Wireshark: the action frames should decode as 802.11 action, category vendor specific, Espressif OUI `18:fe:34`. If every frame shows 4 extra bytes at the end, the guest's body carries an FCS; record it in [fidelity.md](fidelity.md#esp-now).

## Without libqemu

`scenarios/examples/udp-3-scripted.yaml` and `espnow-mesh-scripted.yaml` are the same experiments with scripted boards. They need only Deno, take 6 s each and exercise the adapter, engine, metrics, pcaps and assertions, but they say nothing about firmware.

```bash
cd hertzbench
deno task hertzbench run scenarios/examples/udp-3-scripted.yaml --out /tmp/hzb-out
```
