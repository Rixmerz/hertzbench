# Community test checklist

Things nobody has run yet, because the maintainers have no such machine or device. If you have one,
run the command, then open a **[test report](https://github.com/Rixmerz/hertzbench/issues/new?template=test-report.yml)**
with what you saw. A pass or a failure are both useful. Once a report lands, the box gets ticked and
the issue linked.

Before you start, download the binary for your system from the
[latest release](https://github.com/Rixmerz/hertzbench/releases/latest) and check it against
`SHA256SUMS`, or run from source with Deno (`cd hertzbench`).

Status: `[ ]` not run, `[x]` passed (link the report), `[!]` failed (link the issue).

## Platforms

- [ ] **macOS x64 (Intel), test suite.** `deno lint && deno task check && deno task test`. Expect
      0 failed. CI only runs macOS arm64.
- [ ] **macOS x64 binary.** `./hertzbench-macos-x64 run scenarios/examples/udp-3-scripted.yaml --quiet`
      prints `RESULT: PASS`.
- [ ] **macOS arm64 binary.** Same command with `hertzbench-macos-arm64`.
- [ ] **Linux arm64 (Raspberry Pi 4/5, Graviton, ...), test suite.** Same as the macOS suite.
- [ ] **Linux arm64 binary.** Same command with `hertzbench-linux-arm64`.
- [ ] **Windows arm64, test suite and binary.** Same, with `hertzbench-windows-arm64.exe`.
- [ ] **Windows x64 binary, BLE bridge refusal.**
      `hertzbench-windows-x64.exe run scenarios/examples/bridge-ble-scripted.yaml` exits 2 and names
      BlueZ.

## Real hardware and networks

- [ ] **A real phone through the IP bridge.** Follow [mobile-bridge.md](mobile-bridge.md). The phone
      app reaches a simulated node.
- [ ] **LAN mDNS discovery.** A second machine on the same network finds the bridge
      (see [discovery.md](discovery.md)).
- [ ] **BlueZ on a real Bluetooth adapter.** The BLE bridge advertises the simulated GATT table and a
      phone can read it ([mobile-bridge.md](mobile-bridge.md)).
- [ ] **Windows firewall prompt.** `deno task lan run ...` on Windows: the prompt appears and, once
      allowed, a phone on the LAN reaches the bridge on `0.0.0.0`.

## ESP32 firmware

These ran on one Linux host under QEMU ([e2e-esp32.md](e2e-esp32.md)). More hosts are welcome.

- [ ] **ESP32 scenarios on another Linux distribution.** UDP, ESP-NOW, LoRa and BLE pass.
- [ ] **ESP32 scenarios on macOS.** Same.
- [ ] **Dragging a node that runs real ESP32 firmware** in `hertzbench view`: links and loss follow
      the new position and the firmware keeps running.

## Done

- [x] Test suite on Linux x64, Windows x64 and macOS arm64 (CI).
- [x] Linux x64 and Windows x64 binaries print `RESULT: PASS`.
- [x] Release workflow: `v0.1.0` built six binaries and `SHA256SUMS`.
