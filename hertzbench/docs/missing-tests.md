# Tests that did not run

What the suite does not cover on some system or on the host this was written on, what each would
check, why it did not run, and the command to run it. Items the community can run are tracked in
[community-testing.md](community-testing.md). A test skipped on a system names the reason in
its own name (`[skipped on Windows: ...]`), so a skip is never silent.

The suite was last run on Linux with 680 passed, 0 failed, and earlier on Windows 10 22H2 x64 in a
VM with Deno 2.9.5 and Python 3.12.8 (628 passed, 0 failed, 34 ignored). The CI matrix
(`.github/workflows/hertzbench-ci.yml`) runs on `ubuntu-latest`, `windows-latest` and `macos-latest`
(arm64). Its last green run on all three was 40083042461; the master runs after it failed on Ubuntu
(the browser test, below) and once on macOS (the scripted mesh, below). The changes below were
checked locally and no CI run has seen them yet. **arm64 Linux and Windows were not run.**

Fixed: `browser: dragging a node ...` (`tests/view_browser_test.ts`) failed on Ubuntu with `timed out
waiting for /DevTools listening on .../` after 20 s, and Chromium's stderr held only `dbus` lines.
The runner image was the same (`ubuntu-26.04` 20261012.163.1) in the run that passed in 19 s and in
the ones that failed. The test is the first Chromium launch of the job and starts `hertzbench view`
beside it on two cores: in run 40124661330 Chromium's first stderr line came 19 s after the spawn.
The wait for that line and for the view's URL is now 90 s (`BROWSER_START_TIMEOUT_MS` in
`tests/chromium.ts`, shared with `tests/view_ui_test.ts`), and a Chromium that exits still fails at
once. With `HERTZBENCH_CHROMIUM` pointing at a script that sleeps 25 s before starting Chromium, the
old limit failed with the CI message and the new one passes. The flags are unchanged.

Fixed: the same test also failed on the drag itself, with the node at x = 16.8 m where the pointer
was dropped at 18 m (run 40121322706, and a local full-suite run). The test took the nodes' screen
positions in the first frame the page drew as `running`. That frame is drawn at the size the map's
box had before the layout settled (`viewBox` 819 x 320 while the box was already 834 x 468), and the
page redraws tens of ms later: the scale was 5.7 px/m in the first frame and 9.3 px/m after it
(0.195 px/m in another run, where the press missed the node and it stayed at x = 12 m). The press
and the drop were placed with one scale and read by the page with the other. The test now measures
only when the `viewBox` equals the box, and takes a reading as true when a second one 300 ms later
agrees. The page is unchanged (`view/` was not touched). The failure depends on how loaded the
machine is: with the file pinned to 2 CPUs on a busy machine, copies of the old logic that logged
the frames failed in 7 of 34 runs, each measured in a frame whose scale was not the final one; on a quieter machine the old
test passed 55 of 55 and 24 of 25 with a 300 ms pause before the press, and the new one passed
40 of 40, 25 of 25 and 25 of 25 in the same conditions.

Fixed: `run: the scripted ESP-NOW mesh passes end to end ...` (`tests/cli_test.ts`) failed once on
macOS with `ack_rtt_p95_ms lt 10` over the `start` phase: 3 of 30 ACKs per link took 12 to 17 ms.
The engine judges an ACK from the wall clock between the frame reaching the medium and the ACK
coming back, and the delivery to the receiver was a timer: the medium's 0.2 to 0.5 ms of airtime
became a timer tick of about 2.5 ms of the 3 ms round trip, more when the machine is busy. The
medium now runs delays below one timer tick right after the current task (`MediumClock` in
`orchestrator/medium-clock.ts`, tested in `tests/medium_clock_test.ts`); the median round trip fell
from 3.0 to 0.7 ms. The scenario and its assertions are unchanged. With 14 busy loops on 14 cores,
20 alternating runs each: ACKs over 8 ms on sensors 1 to 3 in `start` fell from 49 to 12, the runs
with one from 14 to 5, and the runs that failed from 3 to 1. A stall of the whole process still
delays an ACK past 10 ms; ending that needs the engine to judge the ACK in modelled time, which is
outside what the orchestrator can change. ESP32 Wi-Fi runs use the same medium clock and were not
run here (no libqemu).

Fixed: `runner: scripted ESP-NOW unicast is acknowledged, broadcast is heard, metrics count both`
(`tests/espnow_test.ts`) counted 19 `espnow tx ok to b` lines against 20 ACKs on macOS in the v0.1.0
release run. The scripted board's 10 ms ACK wait started at its own send, one loopback hop before
the engine's clock, and the ACK needed another hop back, so on a busy runner the board gave up on
ACKs the engine had counted. The board now waits the fork's 10 ms plus 30 ms for the hops
(`ESPNOW_HOP_ALLOWANCE_MS`), and the test keeps its exact `ok == acked` check. A second test puts 7
ms on the leg, which left 0 of 20 sends ok before the fix on an idle Linux machine. With every core
busy, the old assertion failed 4 of 5 runs and the file now passes 29 of 30.

## Skipped on Windows (by design)

| Test | What it checks | Why it cannot run there | Where it runs |
| ---- | -------------- | ----------------------- | ------------- |
| `SIGINT: the CLI stops the run, exits 130 ...` (`tests/cli_test.ts`) | Ctrl-C ends a run through the runner and writes nothing | A child process cannot be sent SIGINT or SIGTERM from Deno on Windows; `kill()` ends it without its handlers | Linux, macOS |
| `mcp: SIGINT and SIGTERM stop the run ...` (`tests/mcp_test.ts`) | The MCP server stops its run on a signal | same | Linux, macOS |
| `cli: view runs the scenario ... exits 0 on SIGINT` (`tests/cov_cli_test.ts`) | `hertzbench view` shuts down on a signal | same | Linux, macOS |
| `view: serves the live map ... stops on SIGINT` (`tests/view_test.ts`) | The view process stops on a signal | same | Linux, macOS |
| `bluez: a helper that ignores stop is terminated ...` (`tests/cov_bridge_test.ts`) | The BlueZ helper gets SIGTERM after the grace period | same; the BLE bridge is Linux only | Linux |
| `bluez: a missing program is named` | The BlueZ helper's missing-program message | Windows reports a missing path as a generic error | Linux, macOS |
| `bluez: a spawn failure other than a missing program ...` | A file without the execute bit is refused | Windows has no execute bit | Linux, macOS |
| `cov mcp: no tool starts a host program ...` and `... the stub PATH catches ...` | No MCP tool starts a shell or interpreter; the control run does start one | The stubs are POSIX shell scripts found through PATH | Linux, macOS |
| `cov mcp regression: ... unreadable scenario file`, `... path the file modes forbid writing` | File modes turn into tool errors | Windows has no mode bits | Linux, macOS |
| `run: the scripted ESP-NOW mesh passes ...` (`tests/cli_test.ts`), `runner: scripted ESP-NOW unicast is acknowledged ...` (`tests/espnow_test.ts`) | Scripted boards answer an ESP-NOW unicast inside the fork's 10 ms ACK wait on a wall clock | Windows timers tick every 15.6 ms (measured: `setTimeout(1)` takes 15.6 ms), so no ACK arrives in time. This is a real limit of the scripted ESP-NOW model on Windows | Linux, macOS |
| `view_ui_test.ts`, `view_browser_test.ts` (headless Chromium) | The page's layout, contrast and drag | Chromium is looked up at the Linux paths in `findChromium` or `HERTZBENCH_CHROMIUM`; none on the Windows VM | Linux with Chromium: `deno task test`; elsewhere set `HERTZBENCH_CHROMIUM` |
| `ble hci: BlueZ's btmon reads ...`, the `btmon` part of the BLE CLI test | The capture decodes in BlueZ's own tool | `btmon` is part of BlueZ, Linux only | Linux with `bluez` installed |
| `bluez: the helper registers the mirrored table ... [skipped: ...]` (`tests/bridge_ble_test.ts`) | The real `bluez_gatt.py` against a fake `bluetoothd` | Needs `dbus-run-session` and PyGObject (`gi`) in the `python3` the test runs; the CI's `setup-python` interpreter has no `gi`, so it is skipped on the GitHub runners too | Linux with `dbus` and `python3-gi` (or `pip install PyGObject`) |

## Not run anywhere on this host

| What | What it would check | Why it did not run | Command |
| ---- | ------------------- | ------------------ | ------- |
| macOS x64 suite | Everything above on Intel macOS | CI runs only `macos-latest` (arm64) | `cd hertzbench && deno lint && deno task check && deno task test` on an Intel Mac |
| Linux arm64 suite | The suite on aarch64 | No aarch64 host | Same, on an arm64 Linux machine (CI: add `ubuntu-24.04-arm` to the matrix) |
| Windows arm64 suite | The suite on Windows on ARM | No such VM | Same, on a Windows ARM machine |
| Compiled binaries for macOS and Linux arm64 | `hertzbench-<target> run scenarios/examples/udp-3-scripted.yaml --quiet` prints `RESULT: PASS` | Cross-compiled but not run (no host). Linux x64 and Windows x64 binaries were run and passed | `deno task compile` then run the file on its system |
| Compiled Windows binary, BLE bridge refusal | `hertzbench.exe run scenarios/examples/bridge-ble-scripted.yaml` exits 2 with the BlueZ message | The refusal was added after the VM run | On Windows: `hertzbench-windows-x64.exe run bridge-ble-scripted.yaml` |
| Real phone, LAN mDNS, BlueZ on a real adapter | See [mobile-bridge.md](mobile-bridge.md) | No phone or adapter | See that file |
| Windows firewall prompt for the IP bridge on `0.0.0.0` | The bridge is reachable from a phone | VM has no LAN peer | `deno task lan run ...` on Windows |

ESP32 firmware under QEMU **was run** on this host (see [e2e-esp32.md](e2e-esp32.md)): UDP, ESP-NOW
(7/7), LoRa and BLE (6/6) pass on real firmware.
