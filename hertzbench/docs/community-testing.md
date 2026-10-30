# Community test checklist

Things nobody has run yet, because the maintainers have no such machine or device. If you have one,
run the command, then open a **[test report](https://github.com/Rixmerz/hertzbench/issues/new?template=test-report.yml)**
with what you saw. A pass or a failure are both useful. Once a report lands, the box gets ticked and
the issue linked.

Before you start, download the binary for your system from the
[latest release](https://github.com/Rixmerz/hertzbench/releases/latest) and check it against
`SHA256SUMS`, or run from source with Deno (`cd hertzbench`).

In a container, mount the repo root, not only `hertzbench/`. The compile step embeds
`../frontend/src/tokens` and `../frontend/public/` files ([`scripts/compile.ts`](../scripts/compile.ts) lines 32 to 35),
and [`view/server.ts`](../view/server.ts) reads `frontend/` beside `hertzbench/` (line 40). Run the
commands from `hertzbench/`, where `deno.json` defines the tasks.

Status: `[ ]` not run or not fixed, `[x]` passed (link the report), `[!]` failed (link the issue).

## Platforms

- [ ] **macOS x64 (Intel), test suite.** `deno lint && deno task check && deno task test`. Expect
      0 failed. CI only runs macOS arm64.
- [ ] **macOS x64 binary.** `./hertzbench-macos-x64 run scenarios/examples/udp-3-scripted.yaml --quiet`
      prints `RESULT: PASS`.
- [ ] **macOS arm64 binary.** Same command with `hertzbench-macos-arm64`.
- [ ] **Linux arm64 (Raspberry Pi 4/5, Graviton, ...), test suite.** Same as the macOS suite.
      Run only under emulation, in `denoland/deno:2.9.5` arm64 with qemu-user: lint and check clean,
      707 passed, 6 failed. The six are timing bounds, attributed to emulation slowness; no arm64 bug
      found. One of them, the 1 ms bound in `tests/medium_clock_test.ts`, was fixed in
      [#51](https://github.com/Rixmerz/hertzbench/pull/51), after that count. Not yet run on real arm64 hardware.
- [x] **Linux arm64 binary, in an emulated container.** `deno task compile linux-arm64` builds it, and
      it prints `RESULT: PASS` in an arm64 Debian container under qemu emulation, not on a Pi or
      Graviton. The record does not say which scenario was passed to it.
- [ ] **Windows arm64, test suite and binary.** Same, with `hertzbench-windows-arm64.exe`.
- [x] **Windows x64 binary, BLE bridge refusal.** ([#36](https://github.com/Rixmerz/hertzbench/issues/36))
      `hertzbench-windows-x64.exe run scenarios/examples/bridge-ble-scripted.yaml` exits 2 and names
      BlueZ.

## Real hardware and networks

- [x] **A real phone through the IP bridge.** Follow [mobile-bridge.md](mobile-bridge.md). The phone
      app reaches a simulated node. ([#37](https://github.com/Rixmerz/hertzbench/issues/37): HTTP from Android Chrome on Windows 11; WebSocket
      and MQTT not run yet.)
- [ ] **LAN mDNS discovery.** A second machine on the same network finds the bridge
      (see [discovery.md](discovery.md)).
- [ ] **BlueZ on a real Bluetooth adapter.** The BLE bridge advertises the simulated GATT table and a
      phone can read it ([mobile-bridge.md](mobile-bridge.md)).
      Advertising is done: BlueZ advertises `hzb sensor` on `hci0` of a Linux host with a powered
      adapter ([e2e-esp32.md](e2e-esp32.md#the-mobile-bridge), BLE bridge step 1). No phone has read
      the table. BLE over the air is unverified: it needs a second BLE device, for example a phone
      running nRF Connect.
- [ ] **Windows firewall prompt.** `deno task lan run ...` on Windows: the prompt appears and, once
      allowed, a phone on the LAN reaches the bridge on `0.0.0.0`. ([#38](https://github.com/Rixmerz/hertzbench/issues/38): reachability
      passed; the prompt itself is still unseen, because allow rules already existed. The mDNS
      address it found on a VirtualBox adapter is fixed.)

## ESP32 firmware

These ran on one Linux host under QEMU ([e2e-esp32.md](e2e-esp32.md)), and in containers on two other
distributions (below). More hosts are welcome.

- [x] **ESP32 scenarios on another Linux distribution.** UDP, ESP-NOW, LoRa and BLE pass on real
      firmware, 8/8: Debian 13 (`debian:stable-slim`) and Fedora 44 (`fedora:latest`) containers, run
      as root, with libqemu built in each container. The distribution-specific differences are in
      [e2e-esp32.md](e2e-esp32.md#other-linux-distributions). Containers only; not a desktop install.
- [ ] **ESP32 scenarios on macOS.** Same. Untested so far; the blockers and a best-effort build outline are in [e2e-esp32.md](e2e-esp32.md#macos).
- [ ] **Dragging a node that runs real ESP32 firmware** in `hertzbench view`: links and loss follow
      the new position and the firmware keeps running.

## Known problems, open for contributions

The project is now maintained by the community: these are known and unfixed. Pull requests are
welcome; each one links the evidence.

- [x] **Browser drag test fails on GitHub's ubuntu-latest.** Fixed: a 90 s Chromium cold-start
      budget, and the drag waits for the map to settle at its box's size. `tests/view_browser_test.ts:115`
      times out with `timed out waiting for /DevTools listening on`: Chromium does not start in
      time on the runner. It passes locally and on macOS and Windows.
- [x] **ESP-NOW mesh test in `tests/cli_test.ts` is flaky on macOS CI.** Mitigated: the Wi-Fi
      medium runs sub-millisecond deliveries without a timer tick (`orchestrator/medium-clock.ts`).
      A stall of the whole process can still push an ACK past 10 ms.
- [x] **`test_mpu6050_worker.py::TestIntTimerCost` (compiled) fails on loaded CI runners.** Fixed
      in the worker by 0662c32f, after this item was written; the bound stays 2200. It measured
      3228 lock takes a second, even with three 1 s windows. Neither catch-up bursts nor the
      test's window can reach that: the INT driver's next look is a millisecond of guest time
      after the last look, however late that ran, so it never replays missed ticks (at most
      2,000 takes a second), and a stalled test process inflates one window at most. The cause
      was a race in `_MpuIntPin`: a look that came to end a pulse and found the next 8 kHz sample
      already pulsing changed nothing and left the end due at once, so on a host where one round
      of the compiled model's deadlines lasts about a sample period the thread took the lock for
      nearly every sample. `test_a_pulse_that_starts_before_the_floor_waits_for_it` and
      `test_a_pulse_found_over_by_the_next_one_ends_and_owes_it` fail on the driver before that
      commit and pass after it. The 3228 itself was not reproduced locally: the driver before the
      fix reads 1,998 takes a second in CI's shape (Python 3.11, two CPUs shared with four busy
      loops), against about 1,000 now.
      The test is also robust to descheduling now. Rates are per second of guest time, with both
      ends of the window read on the worker's side (`clock_run` and the new `clock_stop` of the
      fake libqemu), and the three-window retry, which hid bad windows, is gone.
      `test_a_stalled_test_process_does_not_move_the_bound` stalls the test process inside the
      window. `test_a_long_gap_in_the_guest_time_is_not_made_up` jumps the guest clock by half a
      second and checks the next look waits a full millisecond. Each one fails when it should:
      with `_MPU_INT_LOOK_NS = 0` (7,478 takes a second), with looks counted from the previous
      look instead of from now, and with the window divided by 1 s of the test's time (2,340).
      The test runs in `backend-unit-tests.yml` (`pytest test/backend/unit/`, Python 3.11);
      `backend-e2e-tests.yml` does not run it. The compiled variant builds nothing in CI: it loads
      the committed `frontend/public/bus-chips/mpu6050.wasm`.
- An unfinished attempt at the first two is on the branch
  [`wip/ci-flakes`](https://github.com/Rixmerz/hertzbench/tree/wip/ci-flakes): a Chromium
  cold-start budget and a sub-tick clock for the medium. It was never verified; start from it or
  ignore it.
- [x] **ESP-NOW mesh on real firmware is intermittent.** Mitigated in the scenario's bars; the
      simulator's accounting was right. `espnow-mesh-5-nodes.yaml` passed 10 of 13 runs, each failure
      an `acked_pct` bar. The engine's loss draws are fixed by the seed, and they left sensor-4
      between 75.6% and 90% acked before the move (by how many readings fall before it), against a
      bar of 75. The fork answers an ACK from inside the gateway's QEMU, so when the host does not
      schedule that process for 10 ms the ACK is late, and the driver resends every 10 ms meanwhile:
      one missed ACK failed the run, and one stall on a loaded host cost sensor-4 17 frames, what
      the engine gives for 200 ms. The bars now hold for a 200 ms gateway stall in each phase when
      the sensors send by 22.5 s, which `tests/espnow_test.ts` checks on the engine alone. On
      2026-10-29 the scenario passed 13 of 13 on an idle host with the old bars and 2 of 2 with the
      new ones. Still failing: a longer stall (a 600 ms one with a late boot did, beside 10 busy
      loops on 14 cores), or a gateway that resets on its watchdog mid-run; past 200 ms no bar that
      counts frames tells the start phase from the far one. Details in
      [e2e-esp32.md](e2e-esp32.md#results-on-real-firmware). The macOS flake in the 15 ms ACK test
      (`tests/espnow_test.ts`) is the same mechanism: in both failed CI runs (2026-10-28) some of
      the 20 sends ended `no_ack` instead of `ack_timeout`, because the receiver's ACK reached the
      engine only after the sender's next frame. That test is unchanged.
- [x] **Publish Docker Image fails on master.** It is Velxio's workflow and needs Velxio's Docker
      Hub secrets and build license; it now runs only in the upstream repository.
- [x] **Dependency review passes again**: it was red while the repository's dependency graph was disabled; it passed on PRs #82 to #85.

## Done

- [x] Test suite on Linux x64, Windows x64 and macOS arm64 (CI). Apart from the phone-bridge report on
      Windows 11 ([#37](https://github.com/Rixmerz/hertzbench/issues/37)), Windows and macOS are verified
      by CI only, not by a person on real hardware.
- [x] Dependabot alerts fixed: [#47](https://github.com/Rixmerz/hertzbench/pull/47),
      [#48](https://github.com/Rixmerz/hertzbench/pull/48) and [#49](https://github.com/Rixmerz/hertzbench/pull/49).
- [x] Linux x64 and Windows x64 binaries print `RESULT: PASS`.
- [x] Release workflow: `v0.1.0` built six binaries and `SHA256SUMS`.
