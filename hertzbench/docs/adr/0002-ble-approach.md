# ADR 0002: BLE approach (F3, HCI-over-UART shim)

- Status: Accepted for Phase 0. Implemented in Phase 6 (2026-10) **without the gate below having been run**: no host used so far has libqemu or ESP-IDF. See "Phase 6" at the end.
- Date: 2026-10-22
- Evidence: [discovery.md](../discovery.md), Q4.

## Context

PLAN.md §7 gives two options for BLE:

- **Preferred:** an HCI-level split, with the emulated host talking to a virtual controller in the engine. This is **F1** when the controller is the production one.
- **Fallback:** a shim of the Arduino BLE API. This is **F3**.

The lcgamboa fork has no Bluetooth controller and no HCI:

- The Bluetooth block is an unimplemented device: `hw/xtensa/esp32_picsimlab.c:746` maps `esp32.bluetooth` at `DR_REG_BT_BASE` (`0x3ff51000`, `include/hw/misc/esp32_reg.h:31`), with no model behind it.
- A grep of `hw` and `include` for `bluetooth`, `hci` and `vhci` finds only that stub and unrelated CAN and RISC-V files.
- Velxio's own documentation says the same. `docs/ESP32_WIFI_BLUETOOTH.md:185` states that real scan, connect and notify are not emulated, because the fork has no VHCI.

Velxio's firmware build enables the controller and the Bluedroid host stack (`backend/app/services/esp-idf-template/sdkconfig.defaults:59-62`). Firmware therefore initialises BLE and then finds no radio. [I] In a production ESP32 build the controller is supplied by Espressif's own Bluetooth software for the chip, which this fork does not model (not checked in this tree). An F1 path would need a controller model that does not exist here.

So F1 is not reachable in this fork. An F3 shim is the only option that keeps a real host stack.

Velxio already gives us a bidirectional UART path into the worker, which an HCI transport can use: the `uart_send` command (`backend/app/services/esp32_worker.py:16`) and the `uart_tx` event (`:31`, emitted at `:1851`).

Nothing has been run. Whether an ESP-IDF build can drop the on-chip controller and run Bluedroid over an external HCI UART on the ESP32 is not known from this tree.

## Decision

Use **F3**: a simulation-only firmware build in which the Bluedroid host stack runs unchanged, and HCI goes over a dedicated UART. The engine bridges that UART to a virtual controller.

- The HCI transport uses a UART other than UART0. UART0 is the serial monitor, and mixing HCI bytes into it would corrupt the console.
- The firmware variant lives in a hertzbench-owned build (under `hertzbench/`). Changing the Velxio template at `backend/app/services/esp-idf-template/sdkconfig.defaults` would be a tagged core patch, and we avoid that.
- The CLI reports BLE as **F3**, because the firmware binary differs from production (PLAN D10).
- **Gate:** Phase 6 does not start until the Phase 1 spike shows an ESP-IDF build that boots Bluedroid over the external HCI UART and reports a controller, with the on-chip controller left out. If the build cannot drop the controller, the fallback is the Arduino BLE API shim (PLAN §7), which needs its own ADR.

## Consequences

- **Fidelity.** Every BLE result is labelled F3. A scan or connect result shows that the host stack and the application ran. It does not show radio timing or link-layer behaviour. The report must say so.
- **A second firmware.** Users build BLE sketches against the hertzbench variant, not the Velxio build. That split must be visible in the CLI and in the scenario file, or a BLE sketch can run on one and fail on the other.
- **Phase 5b depends on this.** The BLE mobile bridge (PLAN §9, Phase 5b) needs the same HCI path on the host side, so it inherits this decision and its limits.
- **Dedicated UART.** One UART is taken for HCI. Sketches that need every UART must be told so, and the adapter must reject the conflict up front, not at run time.
- **Velxio coupling.** Only the worker's existing UART commands are used (`uart_send`, `uart_tx`). The fork and the worker need no BLE change, which keeps the upstream merge cost at zero for this part.
- **Open risk.** The on-chip controller may be the only thing the firmware's BLE library will start. If so, the F3 shim needs a different ESP-IDF configuration than the one planned here. That is the Phase 1 spike's question, not this ADR's.

## Phase 6

The owner asked for Phase 6 on a host without libqemu or ESP-IDF, so it was built against the HCI specification and tested with scripted hosts instead of after the gate. What was built, and where this ADR's consequences went:

- **The controller is the engine's.** `adapters/ble-hci/` holds a virtual controller per node that answers HCI over H4 and plays the link layer (advertising, scanning, connections, retransmission, supervision timeout) on the chip-level air, so every packet pays the channel model. What it models and leaves out is in [fidelity.md](../fidelity.md#ble).
- **The transport is the worker's own UART commands**, as decided: the ESP32 board relays `uart_tx` events of the radio's `hci_uart` to the node's `ble-hci` port and answers with `uart_send`. No Velxio file changed, and the fork is untouched.
- **The firmware variant is hertzbench-owned**: `scenarios/examples/fw/ble-sensor` is an ESP-IDF project with `CONFIG_BT_CONTROLLER_DISABLED=y` and Bluedroid attached to an H4 driver on UART1 through `esp_bluedroid_attach_hci_driver`, after ESP-IDF's `bluedroid_host_only_uart` example. Velxio's compile pipeline builds Arduino sketches from its own template, which keeps the on-chip controller, and Arduino's `BLEDevice` starts that controller; so the variant is built with `idf.py` and handed to the scenario as a `.bin`. No core patch.
- **The second firmware is visible** in the scenario (`radios: [{ phy: ble, hci_uart: 1 }]`) and the CLI labels BLE F3.
- **UART0 is refused** for `hci_uart` when the scenario is read, not at run time.
- **The risk this ADR names is still open**: whether Bluedroid starts host-only against this controller. The first step of the BLE run in [e2e-esp32.md](../e2e-esp32.md#the-ble-example) is the gate. If the stack cannot run host-only, the fallback is still the Arduino BLE API shim of PLAN §7, which needs its own ADR.
