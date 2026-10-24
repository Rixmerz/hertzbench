# Running the ESP32 example end to end

`hertzbench run hertzbench/scenarios/examples/udp-3-nodes.yaml` starts three ESP32 boards under QEMU, puts their Wi-Fi on the engine's virtual switch, and reports what the channel model did to their UDP traffic.

**Status: run on real firmware on 2026-10-23**, on a Linux x86_64 host without root, Docker or a velxio.dev licence key, against `libqemu-xtensa.so` built from the public [lcgamboa fork](https://github.com/lcgamboa/qemu) (`picsimlab-esp32`, commit `9c298984`); the ESP-NOW rows of 2026-10-24 use the same build with hertzbench's patch to the fork's Wi-Fi MAC ([upstream-sync.md, patch 3](upstream-sync.md#patch-3-the-qemu-forks-wi-fi-mac-esp-now-receive-and-tx-done-outside-this-tree)). What ran and what came out is in [Results on real firmware](#results-on-real-firmware); how to set the host up is in [Setting up a host without root](#setting-up-a-host-without-root). Points still marked **[unverified]** below were not settled by that run.

## What you need

| Need | Why | Check |
|---|---|---|
| Deno 2.x | the engine, adapter, orchestrator and CLI | `deno --version` |
| Python 3.11+ with `backend/requirements.txt` | the Velxio worker and the compile helper | `python3 -c "import app"` from `backend/` |
| `libqemu-xtensa.so` and its ROM files | the ESP32 machine | `ls "$QEMU_ESP32_LIB"` |
| The ESP-IDF toolchain Velxio uses | compiling the sketch | `python3 hertzbench/orchestrator/compile_sketch.py hertzbench/scenarios/examples/fw/udp-node` |

Skip the last row by giving the scenario a prebuilt flash image: set `firmware:` to a `.bin` path. Build it once in the Velxio UI or with `compile_sketch.py` and decode its `firmware_b64` into a file.

### Getting libqemu

Velxio's `Dockerfile.standalone` refuses to build without either a velxio.dev licence key or the QEMU runtime libraries in `prebuilt/qemu/` (`Dockerfile.standalone:46-58`). The build steps for the libraries are in `docs/BUILD-QEMU.md`; building them from the public fork without a key is in the next section. Put `libqemu-xtensa.so` and the ROM binaries it needs in one directory and point at it:

```bash
export QEMU_ESP32_LIB=/path/to/libqemu-xtensa.so   # the worker passes -L <that directory>
```

Without it `hertzbench run` stops at once with `libqemu-xtensa not found` and exit status 2.

### Setting up a host without root

Everything goes under `~/.local` and `~/.espressif`; nothing needs sudo. The host needs gcc, make, flex, bison, pkg-config, git, Python 3, and the development files of glib-2.0, pixman, zlib, libgcrypt and libslirp (the fork's script turns slirp on, so `pkg-config --modversion slirp` must answer).

1. **libqemu, from the public fork, optimized.** The fork's own `build_libqemu-esp32.sh` configures with `--enable-debug`, which builds QEMU at `-O0` with TCG debugging. Arduino-esp32 2.0.17 firmware does not survive that QEMU: its interrupt watchdog fires during the cross-core cache-off of every flash operation (CPU interrupt 26 at level 5, raised at `spi_flash_restore_cache`), and the board resets on `TG1WDT_SYS_RESET` before the sketch starts. MicroPython boots there; Arduino sketches do not. Drop `--enable-debug` (keep `--enable-debug-info`) and they boot:

   ```bash
   python3 -m venv ~/.local/opt/qemu-build-venv
   ~/.local/opt/qemu-build-venv/bin/pip install meson ninja
   git clone --depth 1 -b picsimlab-esp32 https://github.com/lcgamboa/qemu ~/.local/src/lcgamboa-qemu
   cd ~/.local/src/lcgamboa-qemu
   # ESP-NOW needs the fork's Wi-Fi MAC patched first: the `git apply` heredoc in
   # docs/upstream-sync.md, patch 3. Wi-Fi/IP, LoRa and BLE run without it.
   sed 's/--enable-debug --enable-debug-info/--enable-debug-info/' build_libqemu-esp32.sh > ../build_libqemu-esp32-optimized.sh
   PATH="$HOME/.local/opt/qemu-build-venv/bin:$PATH" bash ../build_libqemu-esp32-optimized.sh
   mkdir -p ~/.local/opt/velxio-qemu
   cp build/libqemu-xtensa.so build/libqemu-riscv32.so ~/.local/opt/velxio-qemu/
   cp pc-bios/esp32-v3-rom.bin pc-bios/esp32-v3-rom-app.bin pc-bios/esp32c3-rom.bin pc-bios/esp32s3_rev0_rom.bin ~/.local/opt/velxio-qemu/
   ```

   About ten minutes on 14 cores. The ROM files ship in the fork's `pc-bios/`. The public fork lacks the `esp32s3-picsimlab` machine and the S3/CAM devices of Velxio's own tree (BUILD-QEMU.md), which no hertzbench example uses.

2. **Python for the worker and the compiler**, here a Python 3.12 venv (`uv` fetched the interpreter):

   ```bash
   uv venv -p 3.12 ~/.local/opt/velxio-venv
   VIRTUAL_ENV=~/.local/opt/velxio-venv uv pip install -r backend/requirements.txt
   ```

3. **arduino-cli and the ESP32 core**, as `.github/workflows/backend-e2e-tests.yml` pins it, plus the one library the LoRa sketches use:

   ```bash
   curl -fsSL -o /tmp/install.sh https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh
   BINDIR=$HOME/.local/bin sh /tmp/install.sh
   U=https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
   arduino-cli core update-index --additional-urls "$U"
   arduino-cli core install esp32:esp32@2.0.17 --additional-urls "$U"
   arduino-cli lib install "LoRa"
   ```

   Without ESP-IDF, `orchestrator/compile_sketch.py` compiles with arduino-cli, as Velxio's compile route does. The core's build recipe calls `python3` with pyserial, so the venv's `bin` goes first on `PATH` while compiling. Velxio's `ArduinoCLIService` writes `~/.arduino15/arduino-cli.yaml` with its board-manager URLs the first time it runs.

4. **ESP-IDF v5.3.6, for the BLE firmware only:**

   ```bash
   git clone --depth 1 --recursive --shallow-submodules -b v5.3.6 https://github.com/espressif/esp-idf ~/.local/src/esp-idf-v5.3.6
   cd ~/.local/src/esp-idf-v5.3.6
   IDF_TOOLS_PATH=$HOME/.espressif ./install.sh esp32
   IDF_TOOLS_PATH=$HOME/.espressif ~/.espressif/python_env/idf5.3_py3.12_env/bin/python tools/idf_tools.py install cmake ninja
   ```

   `install.sh esp32` does not fetch cmake; `idf.py` then stops with `"cmake" must be available on the PATH`.

The environment for every run below, from `hertzbench/`:

```bash
export PATH="$HOME/.local/opt/velxio-venv/bin:$PATH"   # for the sketch compile only
export QEMU_ESP32_LIB=$HOME/.local/opt/velxio-qemu/libqemu-xtensa.so
export HERTZBENCH_PYTHON=$HOME/.local/opt/velxio-venv/bin/python
```

## Results on real firmware

Run on 2026-10-23, every scenario unmodified, with the setup above and the unpatched fork. The rows dated 2026-10-24 ran on the same build with [patch 3](upstream-sync.md#patch-3-the-qemu-forks-wi-fi-mac-esp-now-receive-and-tx-done-outside-this-tree) applied, and the ESP-NOW one with the sensor sketch that waits for the gateway's beacon. The LoRa, BLE and bridge rows were not rerun on the patched library. Firmware compiled through `compile_sketch.py` (arduino-cli, esp32:esp32 2.0.17) except `ble-sensor` (ESP-IDF v5.3.6).

| Scenario | Command | Result |
|---|---|---|
| `udp-3-nodes.yaml`, 2026-10-24, patched fork | `deno task hertzbench run scenarios/examples/udp-3-nodes.yaml --out /tmp/hzb-out-udp` | **PASS**, 5/5. The patch leaves Wi-Fi/IP as it was: `wifi up ip=192.168.4.11` at 4.0 s; behind the wall `c->a` loses 67.8% at p95 9.34 ms with 5.91 attempts per frame, `c->b` 0.2% |
| `udp-3-nodes.yaml`, 2026-10-23, unpatched fork | `deno task hertzbench run scenarios/examples/udp-3-nodes.yaml --out /tmp/hzb-out-udp` | **PASS**, 5/5. All three get their lease (`wifi up ip=192.168.4.11` at 9.0 s), UDP ping/pong flows; behind the wall `c->a` loses 69.8% at p95 9.34 ms with 5.93 attempts per frame, `c->b` 0% |
| `espnow-mesh-5-nodes.yaml`, 2026-10-24, patched fork | `deno task hertzbench run scenarios/examples/espnow-mesh-5-nodes.yaml --out /tmp/hzb-espnow` | **PASS**, 7/7. All five boot with their own MAC; sensors send once they hear the gateway's beacon. Before the move every sensor's sends are acked (`sensor-1..3->gw` 100%, `sensor-4->gw` 81.2%, ACK round trip p50 2.5 ms, max 4.0 ms); after it `sensor-4->gw` falls to 12.5% of frames acked with 409 lost on the air while `sensor-1->gw` stays at 100%. The gateway logs 102, 79, 112 and 119 readings from sensor-1 to -4, duplicates included (a reading whose ACK is lost arrives again). The boards boot 1.5 s to 19.8 s after the run starts (sensor-2 reset on its watchdogs 16 times first). A second run passed 7/7 too, with the gateway booting last (9.1 s, the sensors at 2.6 s to 8.6 s): `sensor-4->gw` 77.8% acked before the move, 12.8% after. That 75% threshold has a narrow margin: before the move the link already loses about a fifth of its frames to the wall and its 10% `extra_loss_pct`, and the table counts frames, so a run can fail it by chance |
| `espnow-mesh-5-nodes.yaml`, 2026-10-23, unpatched fork | `deno task hertzbench run scenarios/examples/espnow-mesh-5-nodes.yaml --out /tmp/hzb-espnow` | **FAIL**, 4 of 7 assertions pass. All five boot with their own MAC (`espnow up mac=02:68:7a:62:01:0N`), the gateway's broadcast beacon reaches the sensors, and the engine carries the sensors' action frames to it. The gateway's firmware logs 21 readings from sensor-1 in its first 0.1 s and none after, though the engine delivers 13,010 more frames to it; it sent 42 ACKs in total. Every sensor reports `espnow tx fail to gw`. The cause is in the fork: see ESP-NOW step 4 below |
| `lora-gateway-6-nodes.yaml` | `deno task hertzbench run scenarios/examples/lora-gateway-6-nodes.yaml --out /tmp/hzb-lora` | **PASS**, 4/4. arduino-LoRa drives the SX1276 model over the worker's SPI link; `node-1->gw` under 20% loss, `node-6->gw` 100% |
| `ble-sensors-3-nodes.yaml` | build `fw/ble-sensor` (BLE example below), then `deno task hertzbench run scenarios/examples/ble-sensors-3-nodes.yaml --out /tmp/hzb-ble` | **PASS**, 6/6. Bluedroid starts host-only over UART1 (`ble up` at 1.6 s), the central connects to all three, notifications arrive, sensor-3 drops with reason 0x08 after the walk. The only warning: the host sends HCI 0x2027 (LE Set Privacy Mode), which the virtual controller answers "Unknown HCI Command" and Bluedroid ignores |
| `bridge-web-esp32.yaml` | `deno task lan run scenarios/examples/bridge-web-esp32.yaml --out /tmp/hzb-web`, then `curl http://127.0.0.1:8080/status` | **PASS**, 1/1. `curl` from the host answers `web-node uptime_ms=69862 requests=1` (HTTP 200, 89 ms) through the bridge's TCP to the ESP32's `WebServer` |
| `bridge-ble-esp32.yaml` | `deno task hertzbench run scenarios/examples/bridge-ble-esp32.yaml --out /tmp/hzb-bble`, with the system `python3` (PyGObject) first on `PATH` | **PASS**, 2/2, step 1 only: the bridge mirrors the firmware's GATT and BlueZ advertises `hzb sensor` on `hci0`. No phone was used, so steps 2 and 3 are not run |
| Velxio backend e2e (`.github/workflows/backend-e2e-tests.yml`) | `uvicorn app.main:app --port 8001` from `backend/` with `QEMU_ESP32_LIB` and `QEMU_RISCV32_LIB` set, then each `node test/backend/e2e/<test>.mjs` and `pytest test/esp32_cam/` | **PASS**: HC-SR04, DHT22, MPU-6050, MicroPython ESP32, MicroPython Pico, the four ngspice tests, and 13 ESP32-CAM tests |

In the view: `udp-3-nodes.yaml`, `espnow-mesh-5-nodes.yaml`, `lora-gateway-6-nodes.yaml` and `ble-sensors-3-nodes.yaml` also pass when run with `hertzbench view` (2026-10-24, patched fork; 5/5, 7/7, 4/4 and 6/6).

Not run: the scenarios through `hertzbench mcp` with ESP32 boards, dragging an ESP32 node in the view, a phone on either bridge, and LAN mDNS seen from another host. No nRF24 scenario has an ESP32 board.

Three faults found on the way are fixed in this tree: the worker's NIC arguments (step 1), unicast between boards that the engine flooded as broadcast (step 2), and the BLE bridge handing BlueZ Bluedroid's GAP and GATT services (BLE bridge step 1). Two more are in the fork's Wi-Fi MAC and are fixed by a patch applied to the fork's source before building (ESP-NOW step 4).

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
   WiFi radio attached (sketch wants WiFi: True): -netdev socket,id=hzb-l2,connect=127.0.0.1:<port> -net nic,model=esp32_wifi,netdev=hzb-l2
   eFuse image attached: <out>/efuse-a.bin
   ```

   Settled on the fork: `-nic stream,...` is refused (`Parameter 'type' is missing`), and behind `-netdev stream` the guest sends nothing (QEMU on its own resets on its watchdogs over and over; under the worker the board boots and never associates), while the `socket` netdev boots and carries every frame. The `-global` binding to `nvram.esp32.efuse` is accepted.
2. **Each board has its own MAC.** The fork's Wi-Fi MAC writes its access point's MAC, `10:01:00:c4:0a:51` for `Espressif`, as both Ethernet addresses of every Wi-Fi/IP frame a station sends, so `air.pcap` shows that MAC and not the boards'. The station MAC is in the payload: the DHCP `offer 192.168.4.11 to 02:68:7a:62:01:01` events and the ARP sender addresses must show `02:68:7a:62:01:01`, `:02` and `:03`. The engine therefore finds the receiver of such a frame from its destination IP and the lease that holds it, and treats it as unicast (retries, ACK, rate fallback). Before that fix every UDP frame between boards was flooded unacknowledged, and the behind-the-wall link lost frames without retrying. ESP-NOW frames keep the station MACs (`02:68:7a:62:01:0N`), which is the Phase 1 gate for ESP-NOW and was met.
3. **The board connects and gets its address** (met: `Espressif` is on channel 5 in the fork's access-point table, `hw/misc/esp32_wifi_ap.c:67`, and lwIP takes the engine's offer). `events.jsonl` should hold `"type":"service"` events with `dhcp` details: `offer 192.168.4.11 to 02:68:7a:62:01:01`, then `ack`. The serial log should show `wifi up ip=192.168.4.11`. If DHCP never happens **[unverified]**:
   - the sketch is not associating: Velxio's compile step forces SSID `Espressif` on channel 5 (`espidf_compiler.py`), but Velxio's own docs say `Velxio-GUEST` on channel 6 (`docs/ESP32_WIFI_BLUETOOTH.md`). The access-point table lives in the shipped library; check which one it advertises and change the constants in `fw/udp-node/udp-node.ino` and the scenario's `channel` to match;
   - or lwIP's DHCP client rejects the offer (the engine sends it to the client's MAC with IP destination 255.255.255.255, with no DNS option). Capture with `air.pcap` and read the exchange. A sketch that calls `WiFi.config(ip, gateway, subnet)` before `WiFi.begin` skips DHCP, and the engine's static addresses are the same ones.
4. **UDP flows.** `serial-b.log` should show `rx ping:<n> from 192.168.4.11` and `rx pong:<n>`.
5. **The clock note.** The worker log says whether `-icount` is on. With Wi-Fi it is off, so guest time follows wall time. If a shipped library turns out to differ from the public fork (its beacon timer is on `QEMU_CLOCK_VIRTUAL` there and `QEMU_CLOCK_REALTIME` in the worker's comment), record it in the discovery notes.

## If the assertions fail

- `serial ... never seen`: the board did not boot, did not associate, or crashed. Read `serial-<node>.log` and `worker-<node>.stderr.log`. A `problem:` line in the report shows a worker that exited early.
- `metric ... no frames crossed a matching link`: nothing was sent between those nodes. Check the sketch's peer addresses against the report's `ip` column.
- `metric ... loss_pct` too high before the move: the link is already near the edge. Change `tx_power_dbm` or the positions, or lower the wall's `attenuation_db`. `hertzbench/tests/orchestrator_test.ts` checks the example's geometry against the engine with synthetic traffic, so a failure here with a clean engine check points at the traffic, not the model.

## The ESP-NOW example

`scenarios/examples/espnow-mesh-5-nodes.yaml` runs five ESP32 boards: a gateway (`fw/espnow-gateway`) and four sensors (`fw/espnow-sensor`) on Wi-Fi channel 1. Same needs as above; the sketches use the `esp_now_*` API of whichever arduino-esp32 core Velxio's compiler picks (2.x or 3.x; both callback signatures are guarded). **Run on real firmware: passes, 7/7, with the fork patched** (2026-10-24); on the unpatched fork the gateway stops taking frames after its first 21 (see [Results](#results-on-real-firmware)).

```bash
cd hertzbench
deno task hertzbench run scenarios/examples/espnow-mesh-5-nodes.yaml --out /tmp/hzb-espnow
```

60 s of engine time; at 30 s sensor-4 walks from 18 m to 44 m. Settle these in order, after steps 0 and 1 of "First run" above:

1. **ADR 0001 gate: distinct MACs, one frame, one ACK.** Each `serial-<node>.log` starts with `espnow up mac=02:68:7a:62:01:0N channel=1`, N going from 1 (gw) to 5 (sensor-4). In `events.jsonl`, `"kind":"espnow"` frames from `02:68:7a:62:01:02` to `:01`, then `"kind":"espnow-ack"` frames back, and `"type":"espnow-send"` events with `"outcome":"acked"`. `serial-sensor-1.log` shows `espnow tx ok to gw`. If every source MAC is `10:01:00:c4:0a:24`, the eFuse image was not read. If the frames arrive and no ACK comes back, the shipped library differs from the public fork. Either way stop and record it in ADR 0001: the F3 fallback may be needed.
2. **The frames are the fork's encoding.** No `"kind":"other"` frames of 14 bytes or more from the boards apart from ARP or DHCP. If ESP-NOW shows up as `other`, byte 12 or 13 differs from `0xA0|channel` and `0x0d`/`0x1d`; compare with `hw/misc/esp32_wifi_ap.c` in the shipped library.
3. **The channel.** No `sends ESP-NOW on channel` warning in the report. If one appears, `esp_wifi_set_channel` did not take effect, or the fork maps the register write to another channel (`hw/misc/esp32_ana.c:41-45`); set the scenario's `channel` to what the warning says.
4. **The fork's Wi-Fi MAC, patched.** The first defect was found on the 2026-10-23 run, the second read from the fork's code; both are fixed by [patch 3](upstream-sync.md#patch-3-the-qemu-forks-wi-fi-mac-esp-now-receive-and-tx-done-outside-this-tree), applied to the fork's source before building:
   - **The gateway went deaf.** The fork queues injected frames up to `Esp32_WLAN__MAX_INJECT_QUEUE_SIZE`, 20 (`hw/misc/esp32_wlan.h:135`); above that `Esp32_WLAN_can_receive` answers false and QEMU's socket netdev stops reading, and nothing in `hw/misc/esp32_wifi*.c` called `qemu_flush_queued_packets` when the queue drained. The sensors booted before the gateway and their driver resent each unacked frame dozens of times a second, so the gateway logged 21 frames, all from sensor-1, then none while the engine kept delivering. The patch flushes the NIC's queue as soon as the injection queue is back at its limit.
   - **tx-done before the ACK.** The fork raised the tx-done interrupt as the frame's DMA ended, with the status still NACK, and again from the 10 ms ACK timer. The patch keeps only the timer's for unicast action frames, which is what hertzbench's model of the fork assumed ([fidelity.md](fidelity.md#esp-now)).

   With the patch, a sensor whose gateway has not booted still gets no ACK and its driver keeps resending; the sensor sketch therefore sends its first reading only after it has heard a beacon from the gateway, so the `start` phase measures the link and not the boot order. To check a library carries the patch, run the scenario: the gateway's `serial-gw.log` should log readings from all four sensors for the whole run.

5. **The ACK window.** After the move, the ESP-NOW table shows sensor-4's `acked %` falling and `frame_lost` rising (2026-10-24, phase `far`: 12.5% of 472 frames acked, 409 lost on the air, 4 `no_ack`). The table counts frames on the air, and the closed Wi-Fi driver resends an unacked unicast frame itself before it calls the sketch's send callback, so the firmware sees far fewer failures than the table: in that run `serial-sensor-4.log` shows 115 `espnow tx ok to gw` and no `espnow tx fail to gw`.

Open `air-80211.pcap` in Wireshark: the action frames should decode as 802.11 action, category vendor specific, Espressif OUI `18:fe:34`. If every frame shows 4 extra bytes at the end, the guest's body carries an FCS; record it in [fidelity.md](fidelity.md#esp-now).

## The BLE example

`scenarios/examples/ble-sensors-3-nodes.yaml` runs three ESP32 sensors (`fw/ble-sensor`, an ESP-IDF project) and a scripted central. The sensors run Bluedroid host-only and send HCI over UART1; the board relays it to the engine's virtual controller through the worker's `uart_tx` and `uart_send` (BLE is F3, ADR 0002). **Run on real firmware: passes** (ESP-IDF v5.3.6, see [Results](#results-on-real-firmware)).

The firmware is not built by Velxio's compile pipeline: that pipeline builds Arduino sketches from its own template, which keeps the on-chip controller. Build it once with ESP-IDF v5.3 or later (the release that added `esp_bluedroid_attach_hci_driver` and the host-only example this firmware follows; older ones are untested), and merge it into the 4 MB flash image the worker loads, the same layout Velxio's compiler writes (bootloader at 0x1000):

```bash
. "$IDF_PATH/export.sh"
cd hertzbench/scenarios/examples/fw/ble-sensor
idf.py set-target esp32
idf.py build
cd build && esptool.py --chip esp32 merge_bin --fill-flash-size 4MB -o ble-sensor-flash.bin @flash_args
cd ../../../../..   # back to hertzbench/
deno task hertzbench run scenarios/examples/ble-sensors-3-nodes.yaml --out /tmp/hzb-ble
```

Until the image exists, `validate` and `run` stop with `firmware not found` and the path to build.

60 s of engine time; at 30 s sensor-3 walks from 40 m to 150 m. Settle these in order, after steps 0 and 1 of "First run" above:

1. **ADR 0002 gate: Bluedroid starts host-only.** `serial-sensor-1.log` shows `ble up addr=02:68:7a:62:01:02`, then `ble advertising`. `hci-sensor-1.btsnoop` (`btmon -r` or Wireshark) shows Reset, Read Local Version, Read BD_ADDR, Read Local Supported Commands and the LE reads answered with status 0. If the log stops before `ble up`:
   - the report's warnings name every HCI command the controller does not implement (`the host sent HCI command 0x....`). Bluedroid may stall on one it needs; implement it in `adapters/ble-hci/controller.ts` and add it to `SUPPORTED_COMMAND_BITS`;
   - an empty btsnoop means no byte crossed UART1: check `worker-sensor-1.stderr.log`, and whether the fork's UART1 raises `uart_tx` (only UART0 has been used through the worker so far);
   - if Bluedroid cannot run without the on-chip controller at all, stop and record it in ADR 0002: the fallback is the Arduino BLE API shim, with its own ADR.
2. **Advertising and connection.** `serial-gw.log` shows `ble connected to sensor-1 as central` for all three sensors, and `serial-sensor-N.log` shows `ble connected peer=02:68:7a:62:01:01`. In `events.jsonl`, `"type":"ble-link"` events with `"state":"up"`, six of them.
3. **Notifications.** `serial-gw.log` shows `ble rx "reading:<n>" from sensor-N`, and the sensors' `ble tx reading:<n>` lines match. The report's `ble-acl` rows hold the host-to-host delay, which should sit around the 30 ms interval. If the gateway never receives one, open `hci-gw.btsnoop`: ATT Handle Value Notifications on the handle Bluedroid gave the characteristic value carry the text.
4. **The walk.** After 30 s, `serial-sensor-3.log` shows `ble disconnected reason=0x08` and the report's BLE connections table shows both sides of sensor-3 down about 1 s after the move.
5. **Timing.** The relay carries each UART byte as one JSON event on the worker's stdout. If Bluedroid reports HCI command timeouts, that pipe is the suspect; record it in [fidelity.md](fidelity.md#ble).

Open `air.pcap` in Wireshark: it should decode as Bluetooth LE Link Layer, with `ADV_IND`, `CONNECT_IND` and data PDUs carrying L2CAP and ATT. If Wireshark marks every CRC wrong, the CRC bit order in `engine/ble.ts` (`bleCrcBytes`) is the suspect; record it in [fidelity.md](fidelity.md#ble).

## The mobile bridge

`scenarios/examples/bridge-web-esp32.yaml` puts an ESP32 running `fw/web-node` (the core's `WebServer`) behind the IP bridge, and `bridge-ble-esp32.yaml` mirrors the `fw/ble-sensor` firmware's GATT server through BlueZ. **Run on real firmware without a phone**: the IP bridge passes from the host's `curl`, and the BLE bridge passes its step 1. Steps that need a phone, or mDNS from another host, are not run. Do the Wi-Fi first run above (steps 0 and 1) before either.

IP bridge, in this order:

1. `deno task lan run scenarios/examples/bridge-web-esp32.yaml`. The progress lines print `bridge phone: http web:80 at 0.0.0.0:8080` and the mDNS line. If the run stops with "the bridge may not listen", the task was `hertzbench`, not `lan`.
2. `serial-web.log` shows `wifi up ip=192.168.4.11` and `http listening on 80`.
3. From the host: `curl http://127.0.0.1:8080/status` answers `web-node uptime_ms=... requests=1`, and `serial-phone.log` shows `bridge 127.0.0.1:<port> -> web:80 connected` then `closed: <n> B to the node, <n> B from it`. If the request hangs: `events.jsonl` should show `tx` from `phone` of kind `tcp`, then ARP from `web` for 192.168.4.250 and the bridge's answer. No SYN-ACK from `web` with the ARP answered means lwIP dropped the SYN: check its checksum in `air.pcap` (Wireshark validates TCP checksums when told to).
4. From the phone on the same Wi-Fi: `http://<host address>:8080/status`, then `http://hzb-web.local:8080/status`. `avahi-browse -art` on another Linux host should list `web-80` under `_http._tcp`. If it does not, the report's mDNS line says why.
5. After 60 s the bridge's station is behind the 12 dB wall: requests from the phone take longer, and the report's `phone->web` rows in phase `behind-wall` show more attempts and a higher latency.

BLE bridge, after the BLE example's step 1 (Bluedroid starts host-only):

1. `deno task hertzbench run scenarios/examples/bridge-ble-esp32.yaml` on a Linux host with `bluetoothd`, PyGObject and a powered adapter. The BlueZ helper runs the `python3` on `PATH`, so that one needs PyGObject: keep a venv without it off `PATH` for this run. Bluedroid's table carries GAP (0x1800) and GATT (0x1801); the bridge leaves both to BlueZ, which otherwise refuses the whole application with `Failed to create entry in database`. `serial-phone.log` shows `bridge connected to sensor`, `bridge discovered service 0000ff00-... with 1 characteristic(s)` and `bridge advertising "hzb sensor" to the phone (BlueZ on hci0)`. A BlueZ refusal is a problem in the report, with BlueZ's message.
2. In nRF Connect on the phone, connect to `hzb sensor`, subscribe to `0xFF01`: a reading arrives every 200 ms (the firmware's `NOTIFY_PERIOD_MS`), and `serial-phone.log` shows `bridge notify ...` for each.
3. A write to `0xFF01` fails with "write not permitted" (the firmware's characteristic is read-only), and `serial-phone.log` shows `bridge phone write ... failed: ATT error 0x03`.

## Without libqemu

`scenarios/examples/udp-3-scripted.yaml`, `espnow-mesh-scripted.yaml`, `ble-sensors-scripted.yaml`, `bridge-web-scripted.yaml` and `bridge-ble-scripted.yaml` are the same experiments with scripted boards. They need only Deno, take a few seconds each and exercise the adapter, engine, metrics, pcaps and assertions, but they say nothing about firmware.

```bash
cd hertzbench
deno task hertzbench run scenarios/examples/udp-3-scripted.yaml --out /tmp/hzb-out
```
