# Tests that did not run

What the suite does not cover on some system or on the host this was written on, what each would
check, why it did not run, and the command to run it. Items the community can run are tracked in
[community-testing.md](community-testing.md). A test skipped on a system names the reason in
its own name (`[skipped on Windows: ...]`), so a skip is never silent.

The suite was run on Linux (674 passed, 0 failed) and on Windows 10 22H2 x64 in a VM with Deno 2.9.5
and Python 3.12.8 (628 passed, 0 failed, 34 ignored). The CI matrix
(`.github/workflows/hertzbench-ci.yml`) runs on GitHub and **passes on `ubuntu-latest`, `windows-latest` and `macos-latest` (arm64)** (run
40083042461). **arm64 Linux and Windows were not run.**

Known flaky: `browser: dragging a node ...` (`tests/view_browser_test.ts`) failed once and passed on
the rerun.

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
| `android run: ...` (`tests/android_scenario_test.ts`), `android logcat: ...` (`tests/android_logcat_test.ts`), `android intent: ...` and `android instrument: ...` (the runs of `tests/android_intent_test.ts`), the launch/boot/install/snapshot/prepare tests of `tests/android_tooling_test.ts`, the `cli: android` tests of `tests/cov_cli_test.ts` (the prepare run is skipped off Linux, where the KVM check is not wired) | `board: android` through the runner: a DISCOVER from the AVD's MAC gets the node's lease, another MAC and a silent guest stop the run; two `snapshot: true` nodes boot with `-snapshot hertzbench -wifi-mac-address <their MAC>`, different console ports and distinct leases, and a missing or stale snapshot stops the run before any emulator starts; `android prepare` boots writable with the run's Wi-Fi flags, saves the snapshot, writes its marker and stops, and a refused save is the snapshot step's failure; logcat lines of the subscribed tags become the node's serial lines and `serial:` assertions pass and fail on them; a timeline `am broadcast`/`am start` reaches adb at its time and a refused one is a problem; `am instrument` output becomes `test ... passed|failed|skipped` lines as it streams; each tooling step's timeout | The fake `emulator` and `adb` are POSIX shell scripts (`tests/android_fake_sdk.ts`) | Linux, macOS |
| `bridge netsim: the android: app boots before time zero ...` (`tests/bridge_netsim_scenario_test.ts`) | The `android:` app of a BLE scenario boots through the runner on a fake `emulator`/`adb`: `-netsim-args "--hci-port <port>"` and no Wi-Fi flags, logcat as the bridge's serial lines, the app running before the bridge's first line | The fake `emulator` and `adb` are POSIX shell scripts (`tests/android_fake_sdk.ts`) | Linux, macOS |
| `kvmProblem does not mistake Deno's own permission wall for a missing KVM [skipped: ...]` (`tests/android_tooling_test.ts`) | `kvmProblem` reports nothing when Deno refuses `/dev/kvm` without `--allow-all` | On macOS and Windows `kvmProblem` answers "only wired for Linux" before opening anything, and the `/dev` permission wall is Linux-specific | Linux |
| `bluez: the helper registers the mirrored table ... [skipped: ...]` (`tests/bridge_ble_test.ts`) | The real `bluez_gatt.py` against a fake `bluetoothd` | Needs `dbus-run-session` and PyGObject (`gi`) in the `python3` the test runs; the CI's `setup-python` interpreter has no `gi`, so it is skipped on the GitHub runners too | Linux with `dbus` and `python3-gi` (or `pip install PyGObject`) |

## Not run anywhere on this host

| What | What it would check | Why it did not run | Command |
| ---- | ------------------- | ------------------ | ------- |
| macOS x64 suite | Everything above on Intel macOS | CI runs only `macos-latest` (arm64) | `cd hertzbench && deno lint && deno task check && deno task test` on an Intel Mac |
| Linux arm64 suite | The suite on aarch64 | No aarch64 host | Same, on an arm64 Linux machine (CI: add `ubuntu-24.04-arm` to the matrix) |
| Windows arm64 suite | The suite on Windows on ARM | No such VM | Same, on a Windows ARM machine |
| Compiled binaries for macOS and Linux arm64 | `hertzbench-<target> run scenarios/examples/udp-3-scripted.yaml --quiet` prints `RESULT: PASS` | Cross-compiled but not run (no host). Linux x64 and Windows x64 binaries were run and passed | `deno task compile` then run the file on its system |
| Compiled Windows binary, BLE bridge refusal | `hertzbench.exe run scenarios/examples/bridge-ble-scripted.yaml` exits 2 with the BlueZ message | The refusal was added after the VM run | On Windows: `hertzbench-windows-x64.exe run bridge-ble-scripted.yaml` |
| Android emulator with a real app, TCP to a board | `board: android` on `pixel8`: the app (`examples/android/iot-app`) reaches a board over HTTP through the medium, logs `status ok 200`, and its GETs fail once the phone is walked out of range | On 2026-10-28 `wlan0` got `192.168.4.12/24` (emulator 37.1.11, a probe APK that only logs). The example app builds here (`gradle --offline assembleDebug`, AGP 8.9.1) but neither example scenario was run against an emulator: `tests/android_example_test.ts` checks the scenarios against the app's manifest and log lines and the walk out of range on the engine alone. Whether Android routes the app's GET over `wlan0` (A3) is still open | `cd examples/android/iot-app && gradle assembleDebug`, then `deno task hertzbench run scenarios/examples/android-web-scripted.yaml` (and `android-web-esp32.yaml` with libqemu) |
| Android emulator, timeline intents and instrumented tests | `android: { intent }` entries reach a real app's receiver at their time, and `instrument:` runs a real `AndroidJUnitRunner` whose results become `test ... passed` lines | Not run: the fake `adb` replays the `am instrument -r` format from memory of AndroidJUnitRunner (status codes 1, 0, -1, -2, -3, -4), not captured output, and no emulator ran piece 5. Whether a real runner's output matches, and whether `adb shell am instrument` on `pixel8` needs the test APK installed as described, are open | An app with a `BroadcastReceiver` that logs `HZB`, plus an `androidTest` APK, on `pixel8`: `deno task hertzbench run` a scenario with an `android:` timeline entry and an `instrument:` section |
| Android emulator, an app through the BLE bridge's netsim backend | `peripheral: netsim` with the app in `pixel8` (or one you started): a BLE test app scans and finds `hzb sensor-1`, connects, reads `0xFF01` and gets `reading:N`; `bridge phone read` is in the bridge's log | Not run: this machine cannot run the work's emulator. The host side is tested against a fake H4 controller only, so open: **A5** (an app's scan sees a device a client created through netsim's HCI port, and it connects and runs GATT), **A6** (`-netsim-args "--hci-port N"` reaches the emulator's netsimd; only the HCI Reset answer on 6402 was seen), whether the emulator takes one `-netsim-args` argument with a space in it, and Root-Canal's behaviour as the controller (advertising with the UUID in the advertising data and the name in the scan response, connection parameters, `LE Read Buffer Size` of 0) | An emulator with a BLE app (nRF Connect, LightBlue, or your own as `android:`), and a scenario with `bridge: { mirror: sensor-1, peripheral: netsim }` over a scripted advertising `sensor-1` (see [mobile-bridge.md](mobile-bridge.md#5b-with-netsim-an-app-in-the-android-emulator)) |
| Android snapshot boot: `hertzbench android prepare pixel8`, then runs with `snapshot: true` | Boot time drops against the cold boot, and two android nodes in one run get distinct `192.168.4.x` leases on `wlan0` (`adb shell ip -br addr`) | Not run: this machine cannot run the emulator for the work (it would also write a multi-GB snapshot into the person's `pixel8` AVD). Open, never estimated: the boot time before and after (a cold boot was 28.7 s and 30.9 s on 2026-10-28), **A4** (`-wifi-mac-address` really sets `wlan0`'s MAC on a read-only snapshot boot; the run's first-frame MAC check would stop the run naming both MACs if not), **A7** (a snapshot saved with `-feature -WiFiPacketStream -wifi-socket` reloads with the socket netdev reconnected; `prepare` points it at a throwaway listener that a run's port replaces), whether `adb emu avd snapshot save` prints `OK` as the fake does, and that the emulator tolerates `hertzbench.json` inside the snapshot's directory. Also open: cold boots pass no `-no-snapshot-load`, and `pixel8` now holds a `default_boot` snapshot, so a "cold boot" there may load it | `deno task hertzbench android prepare pixel8`, then time `deno task hertzbench run` on an android scenario with and without `snapshot: true`, and run one with two android nodes |
| Real phone, LAN mDNS, BlueZ on a real adapter | See [mobile-bridge.md](mobile-bridge.md) | No phone or adapter | See that file |
| Windows firewall prompt for the IP bridge on `0.0.0.0` | The bridge is reachable from a phone | VM has no LAN peer | `deno task lan run ...` on Windows |

ESP32 firmware under QEMU **was run** on this host (see [e2e-esp32.md](e2e-esp32.md)): UDP, ESP-NOW
(7/7), LoRa and BLE (6/6) pass on real firmware.
