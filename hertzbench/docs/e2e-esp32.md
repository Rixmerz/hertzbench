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

## Without libqemu

`scenarios/examples/udp-3-scripted.yaml` is the same experiment with scripted boards. It needs only Deno, takes 6 s and exercises the adapter, engine, metrics, pcap and assertions, but it says nothing about firmware.

```bash
cd hertzbench
deno task hertzbench run scenarios/examples/udp-3-scripted.yaml --out /tmp/hzb-out
```
