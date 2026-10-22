# Phase 0 discovery

Answers to the eight Phase 0 questions in [PLAN.md](PLAN.md) §9, with file paths and line references.

- Base commit: `e6efa4ce` (branch `cauce/task-456`, Velxio tree at the repository root).
- Date of the reading: 2026-10-22.
- Upstream fork read: `lcgamboa/qemu`, branch `picsimlab-esp32`, commit `9c29898` (2026-10-20), sparse clone at `/tmp/hzb-qemu-src`.

Labels used below:

- **[V]**: verified in this session, by reading the file at the cited line or by running the command shown.
- **[I]**: inference from the code. Not run. Needs the Phase 1 spike to settle.
- **[R]**: reported by task #454 and not re-checked here.

## Environment and the Docker step

Docker is **not installed** on this host. This was checked, not assumed:

```
$ docker --version
/bin/bash: line 1: docker: command not found
$ command -v podman nerdctl
(no output, exit 1)
```

So the step "run Velxio locally via Docker" was **not done**. Nothing was built or started, and there is no image size, no startup log and no measured port behaviour. What the code says instead:

- The image listens on port 80 (`Dockerfile.standalone:428`, `EXPOSE 80`).
- `docker-compose.yml:16` maps host port `3080` to container port `80`.
- [R] The image `davidmonterocrespo/velxio` on Docker Hub is 1.62 GB compressed (tag `master`, pushed 2026-10-20). Not re-checked here.

A Docker build would also fail on this tree even with Docker installed [V]:

- `prebuilt/qemu/` holds only `.gitkeep` (`ls -la prebuilt/qemu`).
- `Dockerfile.standalone:46-58` exits with `ERROR: Velxio docker build needs the QEMU runtime libraries` unless `VELXIO_LICENSE_KEY` is set (velxio.dev gated download) or the `.so` files and ROM binaries are dropped into `prebuilt/qemu/`. The message points to `docs/BUILD-QEMU.md`, which exists.

The toolchains are not installed either [V]: `command -v arduino-cli` and `command -v idf.py` print nothing. [R] Task #454 also recorded Python 3.14.7, Node v26.7.0 and Deno as present. Not re-checked.

**Consequence:** every runtime claim below is [I] until someone builds libqemu (or installs Docker and an image) and runs a board. This is the first item for Phase 1.

## Q1. Default branch, release cadence, CLA, license headers

- **Default branch: `master`** [V]. `git ls-remote --symref upstream HEAD` returns `ref: refs/heads/master`.
- **Release cadence** [V], from `gh release list -R davidmonterocrespo24/velxio`:

  | Tag | Date |
  |---|---|
  | v3.0.0 | 2026-06-11 |
  | v3.0.1 | 2026-07-18 |
  | v3.0.2 | 2026-08-05 |
  | v3.0.3 | 2026-08-10 |
  | v3.0.4 | 2026-08-25 |
  | v3.0.5 | 2026-09-02 (latest) |

  Gaps between releases: 37, 18, 5, 15 and 8 days. A `qemu-prebuilt` release exists (2026-04-04). [R] 156 upstream commits in the 30 days before 2026-10-22.

- **CLA** [V]. `README.md:403` says all contributors must sign a CLA and that "a CLA check runs automatically on pull requests". `COMMERCIAL_LICENSE.md:59-66` says the CLA assigns joint copyright to David Montero Crespo. None of the 11 workflows in `.github/workflows/` is a CLA check. A case-insensitive grep for `cla` only matches `clang-format` (`frontend-tests.yml:42`) and comment text (`library-compile.yml:4,63`). **[I]:** the check is probably a GitHub App outside this repository. We cannot verify that from here.
- **License** [V]. `LICENSE` is AGPLv3 (`LICENSE:1-3`). `README.md:405-410` describes the dual licence: AGPLv3 for free use, a commercial licence otherwise.
- **License headers** [V]. Counted with grep:
  - `backend/**/*.py`: 0 of 73 files carry `Copyright` or `SPDX`. (Task #454 reported 0 of 55. The difference is the file count; the result is the same.)
  - `frontend/src/**/*.ts(x)`: 2 of 824 files.
  - So there is no per-file notice to keep under AGPLv3 §5. The notice lives in `LICENSE` and `README.md`. This affects D3 (see the D4 and D6 review below).
- **Publishing trigger** [V]. `.github/workflows/docker-publish.yml:3-7` runs on push to `master`. The tag trigger is commented out.

## Q2. Backend language, QEMU instance management, headless operation

- **Language: Python, FastAPI** [V]. `backend/app/main.py:13-15` imports FastAPI. The QEMU worker is a separate Python script.
- **Entry point** [V]. `backend/app/api/routes/simulation.py:110-137` handles the WebSocket message `start_esp32`. If the QEMU library loads, it calls `esp_lib_manager.start_instance` (`:129`). Otherwise it falls back to `esp_qemu_manager.start_instance` (`:135`).
- **Process launch** [V]. `backend/app/services/esp32_lib_manager.py:282-299` runs `subprocess.Popen([sys.executable, esp32_worker.py], stdin=PIPE, stdout=PIPE, stderr=PIPE)`. It then writes the JSON config as the first stdin line.
- **Worker** [V]:
  - `backend/app/services/esp32_worker.py:707` loads the library with `ctypes.CDLL(lib_path)`.
  - `:863-895` builds the QEMU argv: `-M <machine> -nographic -L <rom dir> -drive ...`, then `-icount` when needed (`:875-877`), then the NIC (`:889-891`).
  - `:3305-3307` is the command loop. It reads stdin line by line after the config.
  - Header `:9-38` lists the stdin commands (`set_pin`, `uart_send`, `bus_map`, `stop`, ...) and the stdout events (JSON lines).
- **Events emitted** [V]. The worker emits `uart_tx` (`:1851`), `gpio_change`, `gpio_dir`, `gpio_pull`, `gpio_routing`, `ledc_duty`, `rmt_event`, `serial_output`, `spi_batch` (`:2066`), `spi_event` (`:2691`), `bus_diag`, `chip_net`, `error` and `system`. No event carries an 802.11 frame.
- **Headless without the browser** [V in code, not run]. The ESP32 path has no browser dependency. `test/backend/integration/test_esp32_examples_qemu.py:313-353` (`_run_worker`) starts the worker with `subprocess.Popen`, writes the JSON config to stdin and reads the events. It does not start FastAPI. **So an orchestrator can drive the worker directly.**
- **AVR and RP2040** [V]. The backend has no `avr8js` or `rp2040js` code. They run in the frontend (`frontend/src/simulation/AVRSimulator.ts`). The frontend tests import them under Vitest with `environment: 'node'` (`frontend/vitest.config.ts:84`): `frontend/src/__tests__/attiny85-simulation.test.ts`, `frontend/src/__tests__/helpers/avrTestHarness.ts`, `frontend/src/__tests__/RP2040Simulator.test.ts`. **[I]:** these run headless in tests, but there is no product path to run an AVR or RP2040 board without the browser.

## Q3. ESP32 Wi-Fi

- **NIC type today: SLIRP user-mode** [V]. `backend/app/services/esp32_worker.py:472` builds `user,model=<esp32_wifi|esp32c3_wifi>,net=192.168.4.0/24`. `:473-474` adds `hostfwd=tcp::<port>-192.168.4.15:80` when Wi-Fi is enabled. The function is `wifi_nic_arg` (`:425-475`) and its result is appended to argv at `:889-891`.
- **Which machines get the radio** [V]:
  - Classic ESP32: always (`:466-467`, docstring `:429-431`).
  - ESP32-C3: only when the sketch uses Wi-Fi (`:462-465`).
  - ESP32-S3: never (`:468-471`). The fork's S3 machine does not look for a NIC.
- **Custom Wi-Fi MAC** [V in the fork]. The fork models an access point in `hw/misc/esp32_wifi_ap.c`:
  - `:539` registers the NIC with `qemu_new_nic`.
  - `:561` `Esp32_WLAN_handle_frame` is the 802.11 receive path. The ACTION subtype case starts at `:608`, and it sends the frame to the netdev with `qemu_send_packet` at `:638`.
  - `:396-460` takes pseudo-Ethernet ACTION frames from the netdev, rebuilds 802.11 action frames, filters by channel (`buf[12] & 0x0F`, `:403`) and puts them in the RX ring. `:460` sends an ACK back.
  - `:465-476` handles incoming ACK pseudo-frames and releases the wait timer.
  - The machine Velxio runs is `esp32-picsimlab` (`esp32_worker.py:686`, and the default in `esp32_lib_manager.py:131` and `:259`). Its NIC lookup is `hw/xtensa/esp32_picsimlab.c:916-917` (the Wi-Fi child exists only when a NIC is present) and `:1068-1076` (MAC from eFuse, see below). `hw/xtensa/esp32.c:693` and `:838` are the generic `esp32` machine, which Velxio does not run.
  - C3 calls the same handler (`hw/misc/esp32c3_wifi.c:137`).
- **Timers** [V in the fork]. `esp32_wifi_ap.c:43` `BEACON_TIME` = 500 ms. `:44` `INTER_FRAME_TIME` = 5 ms. `:45` `WAIT_ACK_TIMEOUT` = 10 ms. The timers run on `QEMU_CLOCK_VIRTUAL` (`:530-537`). The ACK budget is a **round trip**: the sender's frame goes out, the receiver's ACK comes back (`:455-462` sends the ACK), and both legs plus the receiver's own processing must fit in 10 ms of guest time. [I] Roughly 5 ms per leg, before processing.
- **Discrepancy** [V]. `esp32_worker.py:443` says the beacon timer runs on `QEMU_CLOCK_REALTIME`. The public fork uses `QEMU_CLOCK_VIRTUAL`. Velxio ships its own library, which we have not got. The `.so` Velxio ships is the source of truth; we need it to settle this.
- **Station MAC: every board gets the same one unless an eFuse image is attached** [V for the code, [I] for the arithmetic]:
  - `hw/xtensa/esp32_picsimlab.c:1068-1075` copies the station MAC from eFuse `blk0[1..2]`, reversed byte by byte.
  - `hw/nvram/esp32_efuse.c:164-168` fills `blk0[1] = 0x00c40a24` and `blk0[2] = 0x00fe1001` when the eFuse image does not define a MAC. That is the default.
  - `hw/nvram/esp_efuse.c:634` makes the eFuse image a `drive` property. Nothing in `picsimlab.c` or in the worker sets it: the worker's argv (`esp32_worker.py:863-895`) has no eFuse drive, only the firmware `-drive`.
  - Result, computed from the code and not run: the default writes bytes `24 0a c4 00 01 10` and the reversed copy is station MAC `10:01:00:c4:0a:24`. Every board started without an eFuse image gets that same MAC.
  - The fork drops any frame whose source is our own MAC: `hw/misc/esp32_wifi_ap.c:405` (ACTION path) and `:471` (ACK path). Two boards with the same MAC discard each other's frames. An L2 switch then delivers nothing. This is a blocker for F1 unless each board gets its own eFuse image.
- **RSSI is synthetic** [V]. `hw/misc/esp32_wifi.c:327`: `rssi = signal_strength + rand()%10 + 96`. The firmware sees a random RSSI. A channel model that needs firmware-visible RSSI needs a patch here.
- **Are 802.11 frames observable?** [V] at the netdev boundary: any QEMU netdev backend receives the pseudo-Ethernet frames. [V] Velxio's worker exposes nothing about them: no event type carries a frame. [I] With SLIRP the frames reach the user-mode stack and nothing in Velxio reads them.
- **SLIRP does more than carry frames** [I]. User-mode networking (`net=192.168.4.0/24`) also acts as the DHCP and DNS server for the guest. A `socket` netdev has none of that. Phase 1 boards either get static addresses, or the engine serves DHCP itself. Not tested.
- **Wi-Fi in the serial text** [V]. `esp32_worker.py:1889` matches the words `wifi`, `connect` and `wl_connected` in the serial output. That is log parsing, not frame capture.

## Q4. BLE: controller and HCI

- **No controller is emulated** [V]. `hw/xtensa/esp32_picsimlab.c:746` maps the Bluetooth block as an unimplemented device: `esp32_soc_add_unimp_device(sys_mem, "esp32.bluetooth", DR_REG_BT_BASE, 0x1000, -1)`. `DR_REG_BT_BASE` is `0x3ff51000` (`include/hw/misc/esp32_reg.h:31`). Task #454 cited `esp32.c:746`; the line is in `esp32_picsimlab.c`.
- **No HCI anywhere** [V]. A grep of `hw` and `include` for `bluetooth`, `hci` and `vhci` finds only that stub, plus unrelated CAN and RISC-V files.
- **Velxio says so itself** [V]. `docs/ESP32_WIFI_BLUETOOTH.md:185` says, in Spanish, that BLE is detection only and that real scan, connect and notify are not emulated, because the lcgamboa fork does not implement a VHCI (virtual HCI controller). The paraphrase here is ours; the repository file is not translated.
- **Firmware side** [V]. `backend/app/services/esp-idf-template/sdkconfig.defaults:59-62` enables the Bluetooth controller (`CONFIG_BT_ENABLED`, `CONFIG_BTDM_CTRL_MODE_BR_EDR_BLE`, `CONFIG_BT_BLE_ENABLED`) and the Bluedroid host stack (`:60`). So the firmware starts the stack and the emulator gives it nothing to talk to.
- **Where HCI goes** [V]: nowhere. There is no HCI transport in Velxio or in the fork.
- **[I]** BLE init may "succeed" against the stub. We have not run it.

## Q5. Multi-board interconnect, SignalRouter, adding an SPI model

- **`SignalRouter` is not a board-to-board router.** [V] `backend/app/services/signal_router.py:48-62` is a mirror of the ESP32 GPIO Matrix: it maps each output pin to a signal ID and back, inside one board. PLAN §9 expects a router for the interconnect. The interconnect is a different module (below). Task #454 said `SignalRouter` has 15 callers (livespec); that is about its use inside one board.
- **The multi-board interconnect exists, and it lives in the frontend** [V]:
  - `frontend/src/simulation/Interconnect.ts:1-30` is a "cross-board interconnect router". It watches the wires in `useSimulatorStore` and propagates digital pin transitions between boards along them. Its exports include `bindBoard`, `unbindBoard`, `updateWires` and `getChipNetLinks` (`:635`, `:648`, `:669`, `:166`).
  - UART between boards goes through the bus fabric, not the byte fan-out: `frontend/src/simulation/buses/fabric.ts` (per-board `BoardBusFabric`) and `buses/registry.ts` (`relinkUart`, `:244`). The fan-out in `Interconnect.ts` is kept only for engines that publish no UART controller port.
  - A chip-to-chip net that crosses two workers is published as `chip_net` events: `esp32_worker.py:353-358`, and the single `chip_net` emit in the worker.
  - The spec for cross-board serial passthrough is in `frontend/src/__tests__/dual-pico-serial-passthrough.test.ts:354-362`. Its comment says the target behaviour is "cross-board UART routing respects the wire list AND covers simulator-to-simulator paths". The comment mentions `it.skip`, but the file has no `it.skip`. **We did not run the file**, so whether that case passes is unknown.
  - Also relevant: `frontend/src/__tests__/chipnets-cross-board.test.ts:1-7` tests a net with chips on two boards.
  - **Consequence:** the wired interconnect is real and separate from anything wireless. Our RF engine must not replace it by accident. Wires stay wires; the RF layer is a new path.
- **Where the on-board buses live** [V]:
  - UART chips: `backend/app/services/uart_bus_table.py:1-10` (a custom chip reads the guest UART through QEMU's `picsimlab_uart_tx_event`).
  - I2C: `backend/app/services/i2c_bus_table.py`, `backend/app/services/esp32_i2c_slaves.py`, `backend/app/services/wasm_i2c_models.py`.
  - SPI responders: `esp32_worker.py:2314-2335` (`_rebuild_spi_responders`) and `:2450-2490` (selection and per-byte answer).
  - The browser sends the SPI population as `bus_map` (stdin command, header `:18-19`). `esp32_worker.py:2546-2616` turns each entry into a responder and retires the ones that were removed.
- **How to attach a new SPI peripheral** [I]. Add an entry to the `bus_map` the browser sends (`{"owner","bus_id","cs","model"}`). The worker builds a responder for it (`:2546-2616`), and the responder gets its chip-select watch and timers the same way a custom chip does (comment around `:2519-2523`). The comment names `pi_spi_responders.py` as the origin of that design. **That file is not in this tree** [V: `ls` fails].
- **Not yet done** [I]: a hertzbench SPI model would still need its own device model on the browser side (the `bus_map` builder). We did not read that builder.

## Q6. AI-agent tool surface and whether our MCP can reuse it

- **Tools** [V]. `backend/app/mcp/server.py` declares a `FastMCP` server named `velxio` with seven tools: `compile_project` (`:54`), `run_project` (`:106`), `import_wokwi_json` (`:133`), `export_wokwi_json` (`:169`), `create_circuit` (`:196`), `update_circuit` (`:269`), `generate_code_files` (`:372`).
- **`run_project` does not run anything** [V]. It compiles and sets `simulation_ready` (`:106-130`). The docstring says execution "happens client-side in the browser". **No tool starts, steps or stops a simulation.**
- **Transports** [V]: `backend/mcp_server.py` runs over stdio (`mcp.run(transport="stdio")`). `backend/mcp_sse_server.py` serves `mcp.sse_app()` with uvicorn. **The module docstring of `server.py` says the SSE server is "mounted at /mcp in the FastAPI app". It is not:** `backend/app/main.py` does not import the MCP module. Record this as drift in Velxio, not as something to copy.
- **Dependency pin** [V]. `backend/requirements.txt:19` is `mcp>=1.0.0,<2`. The comment at `:12-18` says `mcp` 2.0 removed `mcp.server.fastmcp`.
- **Reuse** [V for the compile and circuit tools; [I] for the rest]. The compile and circuit tools call Python functions directly. `server.py:89` calls `_arduino.compile(files, board)` with no HTTP in between. Our MCP can import them. The simulation tools (`run`, `get_serial`, `move_node`, ...) of PLAN Phase 2 do not exist and must be built on the worker in Q2.

## Q7. Compile pipeline without the UI

- **Arduino CLI** [V]. `ArduinoCLIService` is at `backend/app/services/arduino_cli.py:247`. Its `compile` is at `:532`. It takes a list of `{name, content}` files and a board FQBN, and it is called from the MCP with no HTTP request (`server.py:89`).
- **ESP-IDF** [V]. `ESPIDFCompiler` is at `backend/app/services/espidf_compiler.py:1093`. Its `compile` is at `:5179`. It takes a list of file dicts and a `board_fqbn`, plus an optional progress callback. We did not trace its full call chain.
- **HTTP entry points** [V]. `backend/app/api/routes/compile.py:1224` (`POST /`) and `:1372` (`POST /start`, async job) wrap the same services.
- **Toolchain on this host** [V]: `arduino-cli` and `idf.py` are not installed (see the Docker section). [R] `arduino:avr` core install status not checked.

## Q8. Minimal list of core patches

Velxio files we would touch, in order of need. Each one is a tagged `core-patch:` commit under D4.

1. **Mandatory:** `backend/app/services/esp32_worker.py:425-475` (`wifi_nic_arg`) and `:889-891` (where the result is appended to argv). Replace `user,model=...` with a configurable netdev, for example `socket,...`, that connects to the hertzbench L2 switch. Needed for ESP-NOW (F1, ADR 0001) and for the Phase 1 Wi-Fi adapter.
   - Why it cannot be avoided: `argv` is built from fixed fields (`:863-895`). The worker reads no environment variable for the NIC. The only env read is `VELXIO_I2C_TRACE` (`:307-310`).
1b. **Mandatory for ESP-NOW with two or more boards:** a per-instance eFuse image in the same argv block (`esp32_worker.py:863-895`). Without it every board has the same station MAC (Q3) and the fork drops the frames between them. [I] The mechanism is a `-drive` for the eFuse image plus a QEMU property binding, probably `-global` on the eFuse device. The argument form is not tested. The same image can carry the C3 eFuse mirror that the worker comment at `esp32_worker.py:449-460` says is missing, so this one change may fix both.
2. **Probably needed:** the config read in `esp32_worker.py:672-690`, where `wifi_enabled` and `wifi_hostfwd_port` are read (`:688-689`). Add a field that selects the netdev backend and its address. The config is written as the first stdin line by `esp32_lib_manager.py` before `:282`. **[I]** We did not trace where that config dict is built.
3. **Not needed for Phase 1:** `backend/app/api/routes/simulation.py:110-137`. Only the Velxio browser uses it. Our orchestrator can call the worker directly.
4. **Not needed for ESP-NOW (F1):** the QEMU fork. The pseudo-Ethernet path exists in the public fork (above). [I] The Velxio library may differ from the public fork (see Q3).
5. **BLE (F3):** the change lives in a hertzbench-owned firmware build, not in a Velxio file. If the shim has to touch `backend/app/services/esp-idf-template/sdkconfig.defaults:59-62`, that is a core patch and must be tagged.
6. **Multi-board wired interconnect:** nothing to patch for Phase 1. It lives in the frontend (Q5), and our adapter does not touch it.
7. **MCP:** nothing to patch. We reuse `ArduinoCLIService` as it is.

Known fork limits that are not patches for Phase 1: the C3 radio needs an eFuse drive or a fork fix (the worker comment at `esp32_worker.py:449-460` records a reproduced assertion), and the S3 has no radio (`:468-471`).

## D4 and D6 review

### D4. All our code under `hertzbench/`; core touches minimal, isolated, tagged

**Revise.** The principle holds, but the claim "minimal" is weaker than the plan says:

- At least one core patch is unavoidable: the NIC argument in `esp32_worker.py` (Q8, item 1). The fork cannot be used with the current worker without it, and no environment variable or config field changes the NIC today.
- A second change in the same file is also needed: the per-instance eFuse image (Q8, item 1b). Without it the boards cannot talk to each other over ESP-NOW (Q3, station MAC).
- The patches are small (one function, a few argv entries, one or two config fields) and stay in one file.
- Because D3 applies to every Velxio file we modify, that file gets the header line `Modified by hertzbench contributors, 2026-10` (the header is new to the file: none of the 73 Velxio Python files has one, and only 2 of 824 TypeScript files do; see Q1).

### D6. RF engine is a separate Deno process talking to emulator instances over sockets

**Confirm, with a note.**

- The worker's own control channel is stdin and stdout with JSON lines (`esp32_worker.py:9-38`). It is not a socket. Our engine should not talk to the worker that way.
- The emulator-to-engine link would be QEMU's own netdev socket (Q8, item 1). That is a standard QEMU backend, so the engine only has to speak the frame format the backend uses.
- Nothing in the code stops a Deno process from being that peer. [I] Deno's UDP datagram sockets are the simplest match for one Ethernet frame per datagram. Not tested.
- The orchestrator, not the Velxio backend, should spawn the worker (Q2). That is consistent with D6.

### D5 conflict found while reviewing D4 and D6

Not a D4 or D6 question, but it affects the plan: `Dockerfile.standalone:46-58` needs either a velxio.dev licence key or our own libqemu build in `prebuilt/qemu/`. PLAN D5 says "no accounts". So `docker compose up` on a fresh clone cannot work until we publish a libqemu build, or write the build steps into `hertzbench/docs/`. Recorded as a finding for the owner.

## Proposed changes to PLAN.md

These are proposals. The owner decides. Nothing in `PLAN.md` was changed.

1. **§7, ESP-NOW row:** set to **F1**, per ADR 0001. Keep F3 only as the fallback that a failed Phase 1 spike triggers.
2. **§7, BLE row:** set to **F3, HCI-over-UART shim**, per ADR 0002. Remove "F1/F3". F1 is not reachable in this fork.
3. **§7, Wi-Fi row:** the text "depends on how Velxio's QEMU exposes Wi-Fi networking (Phase 0)" is answered: SLIRP is set in `esp32_worker.py:472`, and it is replaceable at `:889-891`.
4. **§4 D4:** replace "minimal" with the revised wording in the D4 review, and name the one mandatory patch.
5. **§4 D5:** add that the Docker build needs a libqemu build (`Dockerfile.standalone:46-58`). Either publish one or document the steps.
6. **§4 D6:** keep it, and add that the worker's control channel is stdin and stdout, not a socket.
7. **§5/§9 Phase 2 (MCP):** note that Velxio's MCP only compiles and converts circuits. The simulation tools are new work, not a reuse.
8. **§9 Phase 0, item 5:** rename `SignalRouter` in the question. It is a GPIO-matrix mirror within one board (`signal_router.py:48-62`). Ask instead how the wired interconnect (`frontend/src/simulation/Interconnect.ts`) and the wireless RF engine coexist, so that a wire and a radio link between the same two boards do not both deliver the same data.
9. **§8 Clock:** add that the fork's ACK wait is **10 ms** of virtual time (`esp32_wifi_ap.c:45`), and that it is a round trip: frame out plus ACK back. Any engine latency that pushes that round trip past 10 ms makes the sender time out. Phase 1 and Phase 4 must test this with a latency sweep.
10. **§8 Clock, RSSI:** add that the RSSI the firmware sees is synthetic (`esp32_wifi.c:327`). Channel-model metrics come from the engine, not from firmware.
11. **§10 Upstream sync:** add that the public `lcgamboa/qemu` fork and the library Velxio ships may differ (Q3, the timer clock). The shipped library is the reference.
12. **§12 Risks:** add "ESP-NOW ACK timeout (10 ms virtual)", "Velxio's Docker build needs a libqemu build", and "identical station MACs across boards (Q3, eFuse)".
13. **§7 ESP-NOW gate and §9 Phase 4:** add a precondition: "two boards with distinct station MACs exchange an ACKed frame through the switch". Without distinct MACs the spike cannot pass.
14. **§7 Wi-Fi/IP row and §9 Phase 1:** note that a `socket` netdev has no DHCP or DNS, which SLIRP provides (Q3). Phase 1 must choose static addressing or an engine-side DHCP server.

## Corrections to task #454's report

Checked against the code. The plan's conclusions hold; these details do not:

- BT stub: `hw/xtensa/esp32_picsimlab.c:746`, not `esp32.c:746`.
- Docker build gate: `Dockerfile.standalone:46-58`, not `:11-16`. Lines 11 and 25 only have the comment and the ARG.
- Backend Python files: 73 (`find backend -name '*.py'`), not 55. Zero carry a licence header either way.
- `pi_spi_responders.py` is named in a comment (`esp32_worker.py:2519`). The file is not in this tree.
- The MCP "mounted at /mcp" docstring is stale. See Q6.

- The first draft of Q5 said no board-to-board link exists. That was wrong: `frontend/src/simulation/Interconnect.ts` and `buses/` are that link. Corrected above.
- Task #454 gave the default station MAC as `24:0a:c4:00:01:10`. That is the eFuse byte order. The MAC the code copies into the NIC is the reversed order, `10:01:00:c4:0a:24` (Q3).

## Still open

- **Station MAC:** the arithmetic in Q3 is from reading the code. Running one board and reading its MAC settles it.
- Nothing has been run. No libqemu, no Docker, no arduino-cli or ESP-IDF. Every runtime claim is an inference until Phase 1.
- **ESP-NOW F1 end to end:** whether two boards exchange an ESP-NOW frame through a `socket` netdev (ADR 0001 gate).
- **BLE F3:** whether an ESP-IDF build can drop the on-chip controller and run Bluedroid over an external HCI UART on the ESP32. Not known from this tree (ADR 0002 gate).
- **Public fork vs shipped library:** the timer clock (Q3) and any other difference.
