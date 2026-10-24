# Upstream sync and core patches

hertzbench is a friendly fork of Velxio (`upstream`, default branch `master`). Our code lives in `hertzbench/`. When we have to touch a Velxio file, the commit is prefixed `core-patch:`, the file gets the header line `Modified by hertzbench contributors, <YYYY-MM>`, and the change is listed here.

Policy, from [PLAN.md](PLAN.md) §10:

```bash
git remote add upstream https://github.com/davidmonterocrespo24/velxio.git
git config rerere.enabled true
git fetch upstream
git merge upstream/master   # or cherry-pick specific commits
```

- Every two to four weeks, or when upstream ships something we want.
- After each merge: run `deno task test` in `hertzbench/`, the backend unit tests, and every example scenario. Fix adapters, not Velxio.
- A generic fix is offered upstream as a pull request. Once merged there, we drop our patch.

## Patches

Phase 1 and Phase 3 touch the **same** Velxio file, `esp32_worker.py`, in two separate patches. Phase 2 (the MCP server) touches **none**: it is new code under `hertzbench/mcp/` and does not import or mount Velxio's own MCP server (`backend/app/mcp/server.py`). Phase 4 (ESP-NOW) touches **none** either: it rides on patch 1, which already puts each board's NIC on the engine and gives it its own station MAC, and the QEMU fork is used as it is (ADR 0001). Its sketches go through Velxio's compiler unchanged. Phase 5 (the mobile bridge) touches **none**: the IP bridge is a station on the engine's own medium, and the BLE bridge a virtual controller on its air; BlueZ is reached through hertzbench's own helper (`bridge/ble/bluez_gatt.py`). Phase 6 (BLE) touches **none**: the ESP32 board relays the firmware's HCI UART through the worker's existing `uart_tx` event and `uart_send` command, and its firmware is an ESP-IDF project hertzbench builds itself instead of a change to Velxio's template (ADR 0002). Phase 7 (the view) touches **none** either: it serves a few Velxio frontend files read-only, listed below.

| # | File | Commit subject | Upstreamable |
|---|---|---|---|
| 1 | `backend/app/services/esp32_worker.py` | `core-patch: attach the ESP32 Wi-Fi NIC to an external stream netdev` | Possibly, as an opt-in. See below. |
| 2 | `backend/app/services/esp32_worker.py` | `Implement Phase 3 of hertzbench/docs/PLAN.md: LoRa SX127x register-level…` (79b4e960; not prefixed `core-patch:`, see below) | Possibly, as an opt-in. See below. |

### Patch 1: `esp32_worker.py`, external Wi-Fi netdev and per-board eFuse image

Why: the worker builds the QEMU argv from fixed fields and reads no override for the NIC (discovery Q3, Q8; ADR 0001). Without a change, every board gets a private SLIRP network and boards cannot reach each other. Two boards also share the default station MAC, and the fork drops frames from its own MAC.

What changed, all of it in that one file:

1. A header line after the shebang: `# Modified by hertzbench contributors, 2026-10`.
2. `valid_tcp_port(value)`: new, 3 lines. True only for an `int` from 1 to 65535 (a `bool` is not a port).
3. `wifi_nic_argv(machine, wifi_enabled, hostfwd_port=0, l2_port=0)`: new, after Velxio's `wifi_nic_arg`, which is left exactly as upstream has it. It returns the whole list of QEMU arguments for the radio: `[]` when `wifi_nic_arg` gives none, `['-nic', wifi_nic_arg(...)]` when `l2_port` is unset or 0 (byte-for-byte what the worker passed before), and with `l2_port`

   ```
   -netdev socket,id=hzb-l2,connect=127.0.0.1:<l2_port> -net nic,model=<esp32_wifi|esp32c3_wifi>,netdev=hzb-l2
   ```

   instead of SLIRP, `hostfwd_port` ignored. The machine rules (classic always, C3 only for Wi-Fi sketches, S3 never) are `wifi_nic_arg`'s and untouched. An invalid port raises `ValueError`.
4. `efuse_drive_args(image_path)`: new. Returns the QEMU arguments `-drive file=<path>,if=none,format=raw,id=hzb-efuse` and `-global driver=nvram.esp32.efuse,property=drive,value=hzb-efuse`. A comma in the path is doubled so it cannot add an option.
5. `main()`:
   - reads two optional stdin config fields, `wifi_l2_port` and `efuse_image`;
   - exits with a message on stderr if `wifi_l2_port` is not a port or `efuse_image` is not an existing file, before loading the library;
   - builds the radio's arguments with `wifi_nic_argv` instead of `wifi_nic_arg`, and logs them in its `WiFi radio attached` line;
   - appends `efuse_drive_args(efuse_image)` to the argv, only for the classic ESP32 machine (the C3 eFuse is a different device).

The contract with the adapter is the two config fields; `hertzbench/adapters/qemu-wifi-l2/mod.ts` (`workerNetworkConfig`) produces them.

Tests: `test/backend/unit/test_esp32_wifi_l2_args.py` (14 tests, including the worker's real entrypoint for the config checks).

**Verified on real firmware** (2026-10-23, [e2e-esp32.md](e2e-esp32.md#results-on-real-firmware)), against a libqemu built from the public lcgamboa fork (QEMU 9.2.2). The first form of this patch, `-nic stream,...`, was refused at start-up (`Parameter 'type' is missing`); `-netdev stream` plus `-net nic` was accepted, but the guest sent no frame: QEMU on its own reset on its watchdogs again and again, and under the worker the board booted and never associated; `-netdev socket,connect=...` boots, associates and carries DHCP, UDP and ESP-NOW. Its framing on TCP is the stream netdev's, a 4-byte big-endian length before each frame, so the engine side did not change. The `-global` binding takes the eFuse drive: each board's DHCP request carries the station MAC of its image.

Upstreamable: the two config fields are opt-in and change nothing when absent, so they could be offered as they are. We have not discussed it with the maintainers; the CLA described in `README.md` applies to a pull request.

### Patch 2: `esp32_worker.py`, `radio_spi` and `RadioSpiLink` (a radio chip model on the SPI bus)

Why: Phase 3 models the LoRa SX127x and the nRF24 as register-level chips inside the engine. The guest drives them over SPI, so the worker must forward each SPI byte and chip-select edge to the engine and let the chip drive DIO0/IRQ back. Velxio's worker only knows chip models built from the browser's `bus_map`.

The commit that landed this (`79b4e960`) does not carry the `core-patch:` prefix, so `git log --grep core-patch` does not find it. Find it with `git log -S RadioSpiLink -- backend/app/services/esp32_worker.py`.

What changed, all of it in that one file (line numbers are at the time of writing and move with every upstream sync; search by name):

1. `import queue`, added to the imports (about line 49).
2. `_RADIO_SPI_GPIO_MAX = 48` and `radio_spi_problem(value)`: new, after `valid_tcp_port` (about lines 432-454). Returns why a `radio_spi` config entry is unusable, or `None`. `port` must be a TCP port (`valid_tcp_port`), `cs` a GPIO from 0 to 48, `watch` an optional list of such GPIOs.
3. `class RadioSpiLink`: new (about lines 457-558). The board side of the spi-link protocol, one ordered TCP stream to `127.0.0.1:<port>`:
   - board to engine: `0x01 <mosi>` (answered by `0x81 <miso>`) and `0x02 <gpio> <level>`;
   - engine to board: `0x81 <miso>` and `0x03 <gpio> <level>` (the chip drives a board input);
   - `transfer(mosi)` blocks the calling QEMU thread until the MISO arrives, so edges and bytes reach the model in the guest's order. After a failure, or no answer within `timeout_s` (1 s), it reports once through `on_error` and answers `0xFF`, the level of an undriven bus;
   - `pin(gpio, level)` sends a chip-select or watched-pin edge;
   - drive messages are applied on a thread of their own (`_drive_loop`), because the QEMU thread may hold the IO-thread lock while it waits for a MISO;
   - `close()`; the protocol's other end is `hertzbench/adapters/spi-link/protocol.ts`.
4. `main()`:
   - reads the optional stdin config field `radio_spi` and exits with a message on stderr if `radio_spi_problem` rejects it (about lines 861-865);
   - declares `_radio_spi` (the link, one slot) and `_radio_spi_resp` (its responder) next to `_spi_models` (about lines 1117-1118);
   - `_on_pin_change`: forwards a change on a `watch` GPIO to `_radio_spi[0].pin` (2 lines, about 1881);
   - `_rebuild_spi_responders`: `resp = list(_spi_models) + _radio_spi_resp` instead of `list(_spi_models)` (1 line, about 2503);
   - a new block after `_spi_population_changed` (about lines 2623-2643): when `radio_spi` is set, opens `RadioSpiLink`, builds a `_responder('hertzbench-radio', ...)` selected by `_cs_active` on the `cs` GPIO, sets `responder['fast']` to the link's `transfer`, appends it to `_radio_spi_resp`, and calls `_spi_population_changed()`. An unreachable engine port exits the worker;
   - `_set_pin_locked(pin, value)`: new (about lines 3513-3535), the body of the old `set_pin` command, taking the QEMU IO-thread lock, calling `qemu_picsimlab_set_pin` and `_pads.inject`. The `set_pin` command now calls it, and so does the link's `on_drive`. This is the one place the patch moves upstream code instead of only adding to it: the `set_pin` branch lost its inline body and its #273 comment, which now live in `_set_pin_locked`;
   - the `stop` command closes the link (2 lines, about 3877).

The contract with the adapter is the `radio_spi` config field, `{port, cs, watch}`; `workerRadioSpiConfig` in `hertzbench/adapters/spi-link/mod.ts` produces it. It uses Velxio's `_responder(...)` and `_cs_active(...)` helpers inside `main()` as they are.

Tests: `test/backend/unit/test_esp32_radio_spi.py` (9 tests, none needs libqemu: `RadioSpiLink` against a loopback socket, and the worker's real entrypoint for the config checks).

Re-applying it after an upstream sync, if the merge conflicts or silently drops it:

1. Check it is still there: `grep -n "RadioSpiLink\|radio_spi\|_set_pin_locked" backend/app/services/esp32_worker.py`, and `pytest test/backend/unit/test_esp32_radio_spi.py`. If the tests pass, nothing to do.
2. Otherwise take the patch from our history and replay it on the merged file: `git show 79b4e960 -- backend/app/services/esp32_worker.py | git apply --3way`, or cherry-pick the hunks listed above by hand. The additions (`radio_spi_problem`, `RadioSpiLink`, the block after `_spi_population_changed`) are self-contained; the four one-to-two-line hooks are the ones that conflict.
3. If upstream renamed `_responder`, `_cs_active`, `_rebuild_spi_responders`, `_spi_population_changed` or the `set_pin` command, adapt the hooks to the new names. The `_responder` entry must keep `bus_id=None`, `drives=True`, the chip-select predicate and the `xfer` callable, and `['fast']` (the single-responder shortcut that `_spi_one` reads) must stay set to the link's `transfer`.
4. If upstream already moved the `set_pin` body into a helper, point `on_drive` at that helper instead of keeping `_set_pin_locked`. It must still hold the IO-thread lock (issue #273).
5. Keep the header line `Modified by hertzbench contributors` and run the backend unit tests and `deno task test` in `hertzbench/`.

Not verified on this host: there is no libqemu, so no guest has clocked SPI bytes through the link; the arbitration with `_responder` and `_cs_active` is read from the code, not run.

Upstreamable: `radio_spi` is opt-in and changes nothing when absent; the `_set_pin_locked` extraction behaves as before. We have not discussed it with the maintainers.

### Velxio behaviours hertzbench depends on but does not change

Recorded so a merge that moves them gets noticed:

- `esp32_worker.py` stdin protocol: one JSON config line, then `{"cmd": "stop"}` to end the run; stdout JSON lines with `uart_tx`, `serial_output`, `system` and `error` events.
- `espidf_compiler.compile(files, board_fqbn)` returns `binary_content` (base64) and rewrites any `WiFi.begin()` to SSID `Espressif`, open auth, channel 5 (`espidf_compiler.py`, `_QEMU_WIFI_SSID` and `_QEMU_WIFI_CHANNEL`). The example sketch says so explicitly.
- `QEMU_ESP32_LIB` names the libqemu shared library, as in `esp32_lib_manager.py`.
- `esp32_worker.py` `uart_send` command, `{"cmd": "uart_send", "uart": N, "data": "<base64>"}` (header line 17), feeds bytes to any UART through `qemu_picsimlab_uart_receive`, and the `uart_tx` event, `{"type": "uart_tx", "uart": N, "byte": V}` (header line 32), reports every byte any UART sends. The BLE relay uses both on the radio's `hci_uart`; `tests/cli_test.ts` pins the shapes with a stand-in worker.
- The view (`hertzbench/view/server.ts`) serves these frontend files as they are, at request time: `frontend/src/tokens/{index,colors,spacing,typography,radius,elevation,motion,z-index}.css` (and their `@import` of each other), `frontend/public/fonts/{Inter,JetBrainsMono}.var.woff2` at `/fonts/` (the path `typography.css` names), and `frontend/public/boards/esp32-devkit-v1.svg`. A rename upstream makes that request answer 404 and the page fall back to its own colors and the system font; see [view.md](view.md#what-comes-from-velxio).
