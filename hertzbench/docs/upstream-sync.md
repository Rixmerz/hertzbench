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

Phase 1 touches **one** Velxio file. Phase 2 (the MCP server) touches **none**: it is new code under `hertzbench/mcp/` and does not import or mount Velxio's own MCP server (`backend/app/mcp/server.py`). Phase 4 (ESP-NOW) touches **none** either: it rides on patch 1, which already puts each board's NIC on the engine and gives it its own station MAC, and the QEMU fork is used as it is (ADR 0001). Its sketches go through Velxio's compiler unchanged. Phase 6 (BLE) touches **none**: the ESP32 board relays the firmware's HCI UART through the worker's existing `uart_tx` event and `uart_send` command, and its firmware is an ESP-IDF project hertzbench builds itself instead of a change to Velxio's template (ADR 0002).

| # | File | Commit subject | Upstreamable |
|---|---|---|---|
| 1 | `backend/app/services/esp32_worker.py` | `core-patch: attach the ESP32 Wi-Fi NIC to an external stream netdev` | Possibly, as an opt-in. See below. |

### Patch 1: `esp32_worker.py`, external Wi-Fi netdev and per-board eFuse image

Why: the worker builds the QEMU argv from fixed fields and reads no override for the NIC (discovery Q3, Q8; ADR 0001). Without a change, every board gets a private SLIRP network and boards cannot reach each other. Two boards also share the default station MAC, and the fork drops frames from its own MAC.

What changed, all of it in that one file:

1. A header line after the shebang: `# Modified by hertzbench contributors, 2026-10`.
2. `valid_tcp_port(value)`: new, 3 lines. True only for an `int` from 1 to 65535 (a `bool` is not a port).
3. `wifi_nic_arg(machine, wifi_enabled, hostfwd_port=0, l2_port=0)`: new last parameter `l2_port`. When set, the result is

   ```
   stream,model=<esp32_wifi|esp32c3_wifi>,server=off,addr.type=inet,addr.host=127.0.0.1,addr.port=<l2_port>
   ```

   instead of the `user,...` SLIRP string, and `hostfwd_port` is ignored. With `l2_port` unset or 0 the result is byte-for-byte what it was. The machine rules (classic always, C3 only for Wi-Fi sketches, S3 never) are untouched. An invalid port raises `ValueError`.
4. `efuse_drive_args(image_path)`: new. Returns the QEMU arguments `-drive file=<path>,if=none,format=raw,id=hzb-efuse` and `-global driver=nvram.esp32.efuse,property=drive,value=hzb-efuse`. A comma in the path is doubled so it cannot add an option.
5. `main()`:
   - reads two optional stdin config fields, `wifi_l2_port` and `efuse_image`;
   - exits with a message on stderr if `wifi_l2_port` is not a port or `efuse_image` is not an existing file, before loading the library;
   - passes `wifi_l2_port` to `wifi_nic_arg`;
   - appends `efuse_drive_args(efuse_image)` to the argv, only for the classic ESP32 machine (the C3 eFuse is a different device).

The contract with the adapter is the two config fields; `hertzbench/adapters/qemu-wifi-l2/mod.ts` (`workerNetworkConfig`) produces them.

Tests: `test/backend/unit/test_esp32_wifi_l2_args.py` (12 tests, including the worker's real entrypoint for the config checks).

**Not verified on this host**, because there is no libqemu: that QEMU accepts `-nic stream,...` for the onboard NIC, and that the `-global` binding takes the eFuse drive. Both follow QEMU 9.2 (`VERSION` of the fork) and the way the worker already uses `-nic`, but neither has been run. If `-nic stream` is refused, the fallback is `-netdev stream,id=hzb-l2,...` plus `-net nic,model=<model>,netdev=hzb-l2`, a change confined to `wifi_nic_arg`.

Upstreamable: the two config fields are opt-in and change nothing when absent, so they could be offered as they are. We have not discussed it with the maintainers; the CLA described in `README.md` applies to a pull request.

### Velxio behaviours hertzbench depends on but does not change

Recorded so a merge that moves them gets noticed:

- `esp32_worker.py` stdin protocol: one JSON config line, then `{"cmd": "stop"}` to end the run; stdout JSON lines with `uart_tx`, `serial_output`, `system` and `error` events.
- `espidf_compiler.compile(files, board_fqbn)` returns `binary_content` (base64) and rewrites any `WiFi.begin()` to SSID `Espressif`, open auth, channel 5 (`espidf_compiler.py`, `_QEMU_WIFI_SSID` and `_QEMU_WIFI_CHANNEL`). The example sketch says so explicitly.
- `QEMU_ESP32_LIB` names the libqemu shared library, as in `esp32_lib_manager.py`.
- `esp32_worker.py` `uart_send` command, `{"cmd": "uart_send", "uart": N, "data": "<base64>"}` (header line 17), feeds bytes to any UART through `qemu_picsimlab_uart_receive`, and the `uart_tx` event, `{"type": "uart_tx", "uart": N, "byte": V}` (header line 32), reports every byte any UART sends. The BLE relay uses both on the radio's `hci_uart`; `tests/cli_test.ts` pins the shapes with a stand-in worker.
