# Plan: an Android app as a node of the simulation

Status: design only, nothing here is built yet. Written 2026-10-28.

**Goal.** An Android app, running unmodified in the Android emulator, talks to the simulated boards
over the simulated radio: over Wi-Fi/IP to ESP32 boards under QEMU (and, through such a board, to
ESP-NOW nodes), and over BLE to simulated peripherals. Scenarios assert on what the app did.

**Decision in two sentences.** For Wi-Fi the Android emulator becomes a **board**, not a bridge: its
virtio Wi-Fi netdev connects to the same `qemu-wifi-l2` port an ESP32 uses, so the phone is a real
station on the medium with its own DHCP lease, position and channel model. For BLE the existing
**mirror bridge (5b) gets a second host-side backend**: instead of BlueZ on a real adapter, it drives
the emulator's netsim controller over its HCI TCP port with Hertzbench's own `HciHost` and
`GattServer`, so the app scans and connects inside netsim and every operation is replayed on the
simulated air.

Each claim below is marked **[V]** (verified on this machine on 2026-10-28, with the command) or
**[A]** (assumed, with the piece that checks it).

## 0. What exists today and what it means for this plan

**The "phone" in the tests is the mobile bridge** ([mobile-bridge.md](mobile-bridge.md), PLAN.md §9
Phase 5). The test `mirror: the node's refusals reach the phone as not-permitted, the rest as failed`
(`tests/cov_bridge_test.ts:1541`) drives `BleBridge` (`bridge/ble/mirror.ts`) with a stand-in for
BlueZ: the bridge's node is a virtual controller on the simulated air with a central host
(`orchestrator/boards/drivers/hci-host.ts`), it discovers the mirrored node's GATT table
(`orchestrator/boards/drivers/att.ts`) and hands it to a `GattPeripheral`
(`bridge/ble/peripheral.ts`), whose `PeripheralHandlers` (`read`, `write`, `subscribe`) the phone's
operations call; refusals map to `GattOperationError` kinds `not-permitted` and `failed`. The IP
bridge (5a, `bridge/ip/proxy.ts`) is a station on the Wi-Fi medium that relays host TCP listeners
to declared `node:port` pairs over the engine's TCP (`engine/tcp.ts`). **[V]** read in the code.

**Can it be the base?**

- **BLE: yes, directly.** `GattPeripheral` is already the seam between "the simulated leg" and
  "whatever the phone connects to". BlueZ is one implementation (`bridge/ble/bluez.ts`); the tests'
  stand-in is another. A netsim-backed implementation is a third, and `BleBridge` does not change.
- **Wi-Fi: only as a zero-code fallback.** An emulated app can already reach the IP bridge today:
  the emulator's default user-mode network maps the host's loopback to `10.0.2.2`, so the app opens
  `http://10.0.2.2:<listen_port>` and the bridge relays it **[A]**, standard emulator behaviour, not
  run here. That costs nothing, but the app never sees the simulated network (no mDNS name of a
  board, no UDP, no broadcast, no board-initiated connection, the phone's TCP ends at the host). The
  plan below makes the emulator a real station instead; the 10.0.2.2 path stays documented as the
  fallback for hosts where piece 2 cannot run.

**How boards attach today** **[V]** read in the code:

| PHY | Attachment | Code |
|---|---|---|
| Wi-Fi (UDP/TCP, ESP-NOW) | one loopback TCP port per node, QEMU `socket`/`stream` netdev, every Ethernet frame prefixed with a 4-byte big-endian length; `Medium.addNode` with the node's MAC; `VirtualGateway` answers ARP and DHCP with one static lease per MAC and ignores an unknown MAC (`engine/gateway.ts:145`) | `adapters/qemu-wifi-l2/`, `orchestrator/runner.ts:445` |
| BLE | one loopback TCP port per node carrying H4 HCI; the engine plays the controller (`adapters/ble-hci/controller.ts`), the board or a scripted `HciHost` plays the host | `adapters/ble-hci/adapter.ts` |
| LoRa, nRF24 | SPI-link register models | `adapters/spi-link/`, `adapters/lora-sx127x/`, `adapters/nrf24/` |

Time zero is "every node's netdev connected" (`runner.ts:297-311`), measured with `WallClock` on
Wi-Fi and `PacedClock` (paced to real time) on chip radios (`runner.ts:190`). Both follow real
time, so a real-time Android emulator fits either.

**Scope limits the scenario format already imposes** (stated as scope, not as future work):

- **One PHY per run** (`scenario.ts:212`). One run puts the app on Wi-Fi **or** on BLE, not both.
- **ESP-NOW**: ESP-NOW frames travel on the Wi-Fi medium, so an Android node and ESP-NOW boards
  share a run, but Android cannot send or receive ESP-NOW frames (no vendor action frames from an
  app). The app reaches an ESP-NOW mesh only through an ESP32 that also serves IP.
- **LoRa and nRF24**: a phone has neither radio and they are separate PHYs. Not reachable from the
  app in the same run; out of scope.
- **At most one bridge per scenario** (`scenario.ts:227`). The BLE path uses that one bridge.

## Verified on this machine

| Fact | How it is known |
|---|---|
| SDK at `~/Android`: `emulator` 37.1.11 (build 15917651), `platform-tools` 37.0.1, `build-tools` 34.0.0, 35.0.0, 36.0.0, 36.1.0, `platforms` android-35, 36, 37.0 | `sdkmanager --list_installed`, `emulator/source.properties` |
| One system image: `system-images;android-36;google_apis;x86_64` (rev 7). No Play Store image, no ARM image | `sdkmanager --list_installed` |
| One AVD: `pixel8` (android-36, google_apis, x86_64, 4 cores, 2048 MB RAM, `PlayStore.enabled = no`) | `emulator -list-avds`, `~/.android/avd/pixel8.avd/config.ini` |
| `sdkmanager` warns "This version only understands SDK XML versions up to 3 but an SDK XML file of version 4 was encountered": `cmdline-tools/latest` is older than the rest of the SDK. Listing works; installing may not | `sdkmanager --list_installed` |
| KVM usable: `/dev/kvm` is `crw-rw-rw- root kvm`; "KVM (version 12) is installed and usable" | `emulator-check accel` |
| `pixel8` boots headless (`-no-window -no-audio -no-boot-anim -read-only -no-snapshot-save -gpu swiftshader_indirect`) to `sys.boot_completed=1` from a cold boot (no `default_boot` snapshot exists) in **28.7 s and 30.9 s**; stopped with `adb emu kill` | two runs; emulator log `Boot completed in 28734 ms` / `30886 ms`; `adb -s emulator-5584 shell getprop sys.boot_completed` |
| The image `system-images/android-36/google_apis/x86_64` takes 4.3 GB on disk | `du -sh` |
| With the default features, `-wifi-socket connect=127.0.0.1:P` opens the TCP connection but **QEMU sends 0 bytes** on it: `netsim WiFi` owns the guest's Wi-Fi (log: "Successfully initialized netsim WiFi"). The guest reports `"AndroidWifi"`, `IP: null` | listener on P; `ss -tni` showed `bytes_acked:1` only; `cmd wifi status` |
| With **`-feature -WiFiPacketStream -wifi-socket connect=127.0.0.1:P`** the guest's `wlan0` sends **plain Ethernet frames with the same 4-byte big-endian length prefix** `qemu-wifi-l2` reads: IPv6 multicast (`0x86dd`) and **DHCP DISCOVER** (UDP 68 to 67, type 1) to `ff:ff:ff:ff:ff:ff`, repeated while nobody answers | a throwaway loopback listener that decodes the length-prefixed frames and logs length, MACs and ethertype; log line `len=354 dst=ff:ff:ff:ff:ff:ff src=02:15:d0:00:00:00 ethertype=0x800 udp 68->67 DHCP type=1` |
| The guest's Wi-Fi MAC was `02:15:d0:00:00:00` in both boots (netsim and socket), driver `mac80211_hwsim`, `ro.boot.qemu.virtiowifi=1` | `cmd wifi status`, frame source MAC |
| The emulator starts its own `netsimd`, which listens on **127.0.0.1:6402**; a standalone `netsimd --hci-port 16402` listens there. Both answer an H4 **HCI Reset** (`01 03 0c 00`) with **Command Complete, status 0x00** (`04 0e 04 01 03 0c 00`) | `ss -tlnp`; a throwaway H4 client that writes the Reset and prints the reply |
| `emulator -help` lists `-wifi-socket`, `-wifi-tap`, `-net-socket`, `-net-tap`, `-netsim-args`, `-packet-streamer-endpoint`, `-wifi-mac-address` (only with a read-only snapshot boot), `-read-only`, `-grpc`, `-quit-after-boot` | `emulator -help` |
| Hertzbench CI (`.github/workflows/hertzbench-ci.yml`) runs lint, `deno task check` and `deno task test` on an OS matrix; no QEMU, no emulator | read the workflow |

## Assumed, and the piece that checks each

| Assumption | Checked by |
|---|---|
| A3: `VirtualGateway` answering the DISCOVER gives `wlan0` its lease and Android marks the network usable (no captive-portal block on plain HTTP to a /24 without internet) | piece 2 |
| A4: `-wifi-mac-address` sets `wlan0`'s MAC when booting a read-only snapshot, so several Android nodes from one AVD get distinct MACs | piece 6 |
| A5: an app's scan sees a device that a client created through netsim's HCI port (the same netsim instance as the emulator), and can connect and run GATT against it | piece 7 |
| A6: `-netsim-args --hci-port N` reaches the emulator's netsimd, so a run picks its own HCI port instead of the default 6402 | piece 7 |
| A7: a snapshot saved with `-feature -WiFiPacketStream` loads with the socket netdev reconnected | piece 6 |
| A8: GitHub-hosted Linux runners give `/dev/kvm` after the udev step (source below), and an x86_64 API 36 image boots there within the boot timeout | piece 8 |
| A9: `10.0.2.2` reaches the host's loopback from the default user-mode network | the fallback note, piece 2 |

## 1. The Android node in a scenario

A new board kind, `android`, with its own `BoardLauncher` (`orchestrator/boards/android.ts`). It is
a node like an ESP32: it has an id, a position, one radio, a MAC and an IP, and links, moves,
metrics and `serial:` assertions name it.

```yaml
nodes:
  - id: web
    board: esp32
    firmware: ./fw/web-server
    position: [0, 0]
    radios: [{ phy: wifi, channel: 5 }]
  - id: phone
    board: android
    position: [6, 0]
    radios: [{ phy: wifi, channel: 5 }]
    android:
      avd: pixel8                     # an existing AVD; Hertzbench never creates or downloads one
      apk: ./app/build/app-debug.apk  # relative to the scenario file
      package: dev.example.iotapp
      activity: .MainActivity         # optional; default: the launcher activity
      extras: { board_url: "http://192.168.4.11/" }   # optional: --es key value on launch
      logcat: [HZB]                   # tags turned into serial lines; default [HZB]
      boot_timeout: 120s              # default 120s: four times the 29-31 s cold boot measured on pixel8
      install_timeout: 60s            # default 60s (not measured: depends on the APK's size)
      launch_timeout: 20s             # default 20s (not measured)
```

The schema is parsed in `orchestrator/scenario.ts` with the existing readers (`known`, durations
with units, errors that name the field). `android` is refused on a node whose board is not
`android`, and `board: android` without `android.avd`, `apk` and `package` is refused. On a
`ble` scenario the Android device is not a node (see §3); `board: android` there is refused with
"the app reaches BLE nodes through `bridge: { kind: ble, peripheral: netsim }`".

**Lifecycle**, all inside `BoardLauncher.start()`, which resolves only when the app is running.
This matters: `waitConnected` is satisfied as soon as the QEMU netdev connects, seconds after
launch and long before Android finishes booting, and time zero is "every netdev connected". If
`start()` resolved early, the app would start outside the scenario's clock.

1. **Preflight**, before any board starts: `emulator`, `adb` found (`$ANDROID_HOME`, then
   `~/Android`), the AVD exists (`emulator -list-avds`), the APK exists, `/dev/kvm` is usable
   (`emulator-check accel`). Any failure stops the run with exit status 2 and the reason, like the
   BlueZ check does on Windows.
2. **Launch**: `emulator -avd <avd> -no-window -no-audio -no-boot-anim -read-only
   -no-snapshot-save -gpu swiftshader_indirect -port <even port from 5554..5682>
   -feature -WiFiPacketStream -wifi-socket connect=127.0.0.1:<netPort>`. `netPort` is the
   `qemu-wifi-l2` port the runner already allocates for every Wi-Fi node (`BoardContext.netPort`).
   `-read-only` lets runs and the person's own emulator share an AVD; the console port is picked
   free so two runs do not collide. The child process is owned by the `RunningBoard`.
3. **Boot**: poll `adb -s emulator-<port> shell getprop sys.boot_completed` until `1`, then
   `adb wait-for-device`. Bounded by `boot_timeout`; on expiry the emulator is killed and the
   problem names the timeout and the last 20 lines of the emulator's log, kept in
   `<outDir>/<node>-emulator.log`.
4. **Install**: `adb install -r -t <apk>`, bounded by `install_timeout`. A failure quotes adb's
   `Failure [...]` line.
5. **Logcat**: `adb logcat -c`, then a long-lived `adb logcat -v raw -s <tags>:V` whose lines go to
   `onSerial`. Started before the launch so the app's first lines are kept.
6. **Launch the app**: `adb shell am start -W -n <package>/<activity> --es <k> <v>...`, bounded by
   `launch_timeout`; `-W` returns when the activity is displayed. `start()` resolves here.
7. **Stop**: `adb emu kill`, then wait up to 10 s for the process, then SIGKILL. Logcat is stopped
   first so its last lines are kept.

The runner's `startupTimeoutMs` (30 s) applies after `start()` resolves, when the netdev is already
up, so it needs no change. ESP32 boards start in parallel and run during Android's boot, before
time zero, as they already do during their own DHCP. Fidelity line for the report: "Android
emulator (QEMU, x86_64 system image): the app, its OS and its IP stack run unchanged; the radio
below `wlan0` is the medium, 802.11 is not modelled (as for ESP32, F2)".

**MAC and lease.** The medium routes by the MAC given to `Medium.addNode`, and the gateway leases
by MAC, both before the board boots. The Android node's MAC therefore cannot be the usual
`02:68:7a:62:01:NN` unless the guest is told to use it. Decision:

- Cold boot (pieces 2 to 5): the node's MAC defaults to the value the AVD uses,
  `02:15:d0:00:00:00` (observed twice, [V]); a scenario may override it with `mac:`. The launcher
  checks the source MAC of the first frame on its port; a different MAC stops the run with both
  values named; without that check a wrong MAC fails silently, because the gateway skips an unknown
  MAC and no lease ever arrives. The launcher never sees frames (`qemu-wifi-l2` hands them straight
  to `Medium.transmit`), so piece 2 adds one hook: the adapter reports the source MAC of the first
  frame on a node's port (`QemuWifiL2Adapter`, an `onFirstFrame(nodeId, mac)` callback), and the
  runner compares it with the node's MAC. One Android node per run until piece 6.
- Snapshot boot (piece 6): the launcher passes `-wifi-mac-address <the node's 02:68:7a:62:01:NN>`
  (A4), which lifts the one-node limit.

No change to `engine/gateway.ts` or `engine/medium.ts` is needed for either.

## 2. Wi-Fi/IP: how the app's traffic reaches the medium

| Option | What it is | Verdict |
|---|---|---|
| **`-feature -WiFiPacketStream -wifi-socket connect=`** | the guest's virtio Wi-Fi as a QEMU socket netdev | **Chosen.** Verified to emit Ethernet frames in exactly the framing `qemu-wifi-l2` reads, DHCP first. The phone becomes one more station: DHCP from `VirtualGateway`, ARP, UDP, broadcast, mDNS, TCP in both directions, all paying the channel model from the phone's position. No root, no host privileges, no new adapter code. |
| netsim Wi-Fi (default) | netsimd plays the access point and NATs to the host | Rejected: the frames go to netsim's own slirp, not to a socket Hertzbench can read; reaching them would mean speaking netsim's gRPC packet streamer. `-wifi-socket` is silent while it is on ([V]). |
| `-wifi-tap` / `-net-tap` / `netsimd --wifi-tap` | a host TAP interface | Rejected: needs `CAP_NET_ADMIN` or a pre-created TAP, and Hertzbench would still have to read the TAP. Breaks "runs as a normal user", and CI images differ. |
| `-net-socket` | the same, for the "radio" (`eth0`) network | Rejected: `eth0` is the emulator's "radio" network, which Android presents as mobile data [A]; apps that check for Wi-Fi would refuse it. |
| A proxy in the IP bridge, app uses `10.0.2.2` | today's 5a bridge | Kept as the **fallback only**: zero code, but the app sees the host, not the network (no UDP, no discovery, no board-initiated traffic). |

What it costs: `-feature -WiFiPacketStream` is an emulator feature flag, not a documented API, and
emulator updates can rename or drop it. Piece 1 pins the emulator version it was checked with and
the preflight reports the version; a run on another version that sees no frame within the boot
timeout says "the emulator sent no Wi-Fi frames: netsim Wi-Fi may be on; this was verified with
emulator 37.1.11". **Revisit** if a release removes the flag, or if Google documents a supported
external Wi-Fi medium for netsim.

The app addresses boards by IP (`192.168.4.11`) or by mDNS once Hertzbench answers it on the
medium. Android validates a new Wi-Fi network by probing the internet, which this one has not; it
may then mark `wlan0` "no internet" and keep the default route on `eth0`. An app talking to
`192.168.4.0/24` should still use `wlan0`, because that is the connected route (A3, piece 2 checks
it). Android does not: it keeps `eth0` (the emulator's mobile data) as the default network, so
an unbound `Socket()` leaves through `eth0` (issue #70). After boot, on cold and snapshot boots
alike, the launcher runs `adb shell svc data disable` and then checks that
`adb shell ip route get <a board's IP on the medium>` names `wlan0`, polling for up to 10 s while
the lease arrives. If it still does not, the run stops quoting the route line, before the app
starts. This was checked against the fake adb only, never against a real emulator.

## 3. BLE: what can be bridged, and the realistic scope

**Facts**: the emulator's Bluetooth runs on netsim, which hosts Root-Canal controllers; netsimd
offers an HCI port (default 127.0.0.1:6402 for the emulator's instance) where an external **host**
connects over H4 and gets a new controller on netsim's air ([V], HCI Reset answered). Hertzbench
already has an H4 **host** (`HciHost`) that can advertise and accept connections, and an ATT server
(`GattServer`), both used by the scripted peripheral (`orchestrator/boards/scripted-ble.ts`).

**Chosen: a netsim backend for the mirror bridge.** `bridge/ble/netsim.ts` implements
`GattPeripheral`: it connects to netsim's HCI port, runs an `HciHost` that advertises `name` with
the first service's UUID, and serves a `GattServer` built from the discovered table; each ATT
request the app sends becomes a `PeripheralHandlers` call, exactly what BlueZ's D-Bus callbacks do
today. `BleBridge` itself does not change: it already replays read, write and subscribe on the
simulated air and maps refusals.

```yaml
bridge:
  kind: ble
  id: phone
  position: [3, 0]
  mirror: sensor-1
  peripheral: netsim          # new; default bluez
  netsim_hci: 127.0.0.1:6402  # default: the emulator's netsimd
android:                      # new top-level section on BLE scenarios: the app that connects
  avd: pixel8
  apk: ./app/build/app-debug.apk
  package: dev.example.bleapp
```

The Android lifecycle of §1 (launch, boot, install, logcat, launch, stop) is reused unchanged; only
the Wi-Fi socket flags are left out. Its logcat goes to the bridge's node as serial lines.

**Where it runs.** On a BLE scenario the Android device is not a node, so nothing would start it in
the board phase, and the bridge only starts after time zero (`runner.ts:311-314`): booting there
would spend 30 s or more of `duration`, and the netsim peripheral could not connect before the
emulator has started netsimd. So the runner starts the scenario's `android:` device as one more
entry of `startAll`, beside the boards, bounded by the same three timeouts, and waits for it before
`waitConnected`; time zero then comes after the app is running, and `BleBridge.start()` connects the
netsim peripheral to an instance that is already up.

**Scope, plainly:**

- The app sees **one mirrored peripheral per run**, with the limits mobile-bridge.md already lists
  for 5b: ATT_MTU 23 on the simulated leg, no long reads or writes, no security, the node's own
  advertising data not copied.
- **The app's own radio is not on Hertzbench's air.** The app-to-mirror leg is netsim's, with
  netsim's (unmodelled) channel; only the mirror-to-node leg pays Hertzbench's channel model. The
  bridge's `position` stands in for the phone, as it does for a real phone.
- **The app cannot be a peripheral** that a simulated central connects to, and it cannot scan the
  simulated nodes' own advertisements.

**Rejected for now: Android as a true BLE node on Hertzbench's air.** It would mean pointing the
guest's HCI at Hertzbench's virtual controller, either by implementing netsim's gRPC
`PacketStreamer` service in Deno for `-packet-streamer-endpoint` (HTTP/2 and protobuf in the
engine, a large and version-coupled surface) or by replacing netsimd. That is the only way to get
multiple peripherals, scanning and the app as a peripheral. **Revisit** when a scenario needs one of
those, and start from `-packet-streamer-endpoint`.

## 4. Assertions on what the app did

In order of cost, each usable without the next:

1. **Logcat as serial lines (piece 3).** The app logs with a tag (`Log.i("HZB", "got temp 21.5")`)
   and the launcher's logcat stream turns each line into a `serial` event of the Android node. The
   existing assertion works unchanged: `- serial: { node: phone, contains: "got temp", within: 20s }`.
   Times are host arrival times; adb adds a few milliseconds, so `within` is good to about 100 ms,
   not to a frame. The bridge's node gets the same on BLE scenarios.
2. **The app's traffic on the medium (piece 2, free).** The phone is a station, so `metric`
   assertions on `phone->web` and `web->phone` (sent, delivered, latency, loss) and the pcap show
   what it sent and received, independent of what the app logs.
3. **Driving the app from the timeline (piece 5).** A new timeline action
   `android: { node: phone, intent: { action: dev.example.REFRESH, extras: {...} } }` runs
   `am broadcast` or `am start` at its time, so a scenario can make the app act after a door closes
   or a node moves. An app built for testing exposes such intents as its test hooks.
4. **Instrumented UI tests (piece 5).** `android.instrument: { runner: dev.example.test/androidx.test.runner.AndroidJUnitRunner, at: 5s }`
   runs `am instrument -w -r` (Espresso or UI Automator, inside the test APK) and turns each
   `INSTRUMENTATION_STATUS` test result into a serial line `test <class>#<method> passed|failed`, so
   UI checks are `serial:` assertions too. `uiautomator dump` is kept for debugging only: it is a
   snapshot with no timing and is flaky to parse.

No new assertion type is planned. Assertions stay judged after the run from `events.jsonl`, so a
verdict is still reproducible from the files.

## 5. CI feasibility

- **GitHub-hosted Linux runners have KVM.** GitHub's changelog of 2024-04-02 says "Actions users of
  our 2-vCPU GitHub-hosted Linux runners will be able to make use of hardware acceleration for
  Android testing", after a step that writes `/etc/udev/rules.d/99-kvm4all.rules`, then runs
  `udevadm control --reload-rules` and `udevadm trigger --name-match=kvm`
  (<https://github.blog/changelog/2024-04-02-github-actions-hardware-accelerated-android-virtualization-now-available/>).
  The `ReactiveCircus/android-emulator-runner` README documents the same step. A8 is that this
  still holds and that an API 36 image boots within the 120 s default there; piece 8 checks it.
- **What runs in the existing CI** (`deno task test`, every OS): everything except the emulator.
  The launcher's command lines, timeouts and logcat parsing are tested with a fake `emulator` and
  `adb` (scripts on `PATH` in a temp dir) and a scripted board that replays the captured DISCOVER;
  the netsim peripheral is tested against a fake H4 controller over loopback, like
  `bridge_ble_test.ts` fakes BlueZ.
- **An opt-in job** `android-e2e` (Ubuntu, `workflow_dispatch` and nightly, not on every PR):
  enable KVM, install `emulator` and one x86_64 image with `sdkmanager` (4.3 GB unpacked here; cache it),
  build the example app, run the example scenarios with scripted boards. Not ESP32: CI has no
  libqemu today.
- **Local only**: ESP32 under QEMU plus Android in the same run (libqemu is not in CI), macOS and
  Windows (KVM is Linux; macOS needs Hypervisor.framework and an ARM image, Windows needs WHPX;
  neither is planned), and anything needing the person's own AVD or a Play Store image.

## 6. Build sequence

Each piece is buildable and testable alone, and the system works after each one. "Verify" is what
the piece is accepted on.

| # | Piece | Files | Verify | Risk |
|---|---|---|---|---|
| 1 | **Android tooling module**: find `emulator`/`adb`, list AVDs, check KVM, launch with the flags of §1, wait for boot, install, logcat, launch, kill; every step with its timeout | `orchestrator/boards/android/tooling.ts` (new), `tests/android_tooling_test.ts` (new) | unit tests with fake `emulator`/`adb` scripts on `PATH`: each timeout fires and names the step, a failed install quotes adb; plus a manual run against `pixel8` that reaches `sys.boot_completed=1` | Low. Emulator CLI flags change between releases; record the version in the report |
| 2 | **`board: android` on Wi-Fi**: scenario schema (§1), the launcher using piece 1 with `-feature -WiFiPacketStream -wifi-socket`, MAC check on the first frame, fidelity line, report row | `orchestrator/scenario.ts`, `orchestrator/boards/android.ts` (new), `orchestrator/runner.ts` (launcher registry, the first-frame MAC check), `adapters/qemu-wifi-l2/adapter.ts` (`onFirstFrame` hook), `docs/scenario-format.md`, `tests/android_scenario_test.ts` (new) | parse/refusal tests; a test where a fake emulator writes a synthesized DISCOVER with chaddr `02:15:d0:00:00:00` into `netPort` and gets an OFFER for the node's IP, and one with another MAC that stops the run naming both; manual: `pixel8` gets `192.168.4.x` on `wlan0` (`adb shell ip -br addr`) | **Medium-high.** Depends on an undocumented feature flag ([V] today on 37.1.11); A3 (lease accepted, route used) is unverified |
| 3 | **Logcat to serial lines** and the `serial:` assertion on the Android node | `orchestrator/boards/android.ts`, `tests/android_logcat_test.ts` (new) | fake `adb logcat` emits tagged lines; the assertion passes and fails on them | Low |
| 4 | **Example app and scenario**: a minimal app (Kotlin, built with the installed build-tools and Gradle 8.13) that GETs `http://<board>/status`, logs `HZB` lines; `scenarios/examples/android-web-scripted.yaml` (scripted `serve: http` board) and `android-web-esp32.yaml` | `examples/android/iot-app/` (new), `scenarios/examples/` | local run passes its `serial:` and `metric:` assertions; moving the phone out of range in the timeline makes the GET fail and the assertion on that fails | Medium. A Gradle build in the repo is a new toolchain; keep the APK build out of `deno task test` |
| 5 | **Timeline intents and instrumentation** (§4 items 3, 4) | `orchestrator/scenario.ts`, `orchestrator/runner.ts` (`applyTimelineAction`), `orchestrator/boards/android.ts`, tests | fake `adb` records `am broadcast` at the scheduled time; `am instrument` output parsed into `test ... passed` lines | Low-medium. Adds a timeline action kind that only one board kind accepts |
| 6 | **Snapshot boot and several Android nodes**: `hertzbench android prepare <avd>` saves a snapshot with the run's feature flags; runs boot it with `-wifi-mac-address` | `cli/`, `orchestrator/boards/android/tooling.ts`, docs | boot time drops (measure before/after on `pixel8`); two Android nodes in one run get distinct leases | Medium. A4 and A7 unverified; snapshots are tied to the emulator version |
| 7 | **BLE: netsim backend for the mirror bridge** (§3): `peripheral: netsim`, top-level `android:` on BLE scenarios, `-netsim-args --hci-port` | `bridge/ble/netsim.ts` (new), `bridge/bridge.ts` (hook), `orchestrator/scenario.ts`, `orchestrator/runner.ts` (start the `android:` device in `startAll`), `orchestrator/air-network.ts`, `docs/mobile-bridge.md`, `tests/bridge_netsim_test.ts` (new) | unit: against a fake H4 controller on loopback, the backend resets, advertises, answers an ATT Read by calling `handlers.read`; manual: nRF Connect-like test app in `pixel8` scans, connects to the mirrored scripted `sensor-1`, reads `reading:N` | **High.** A5 and A6 unverified; Root-Canal behaviour (advertising, connection parameters) may need host work `HciHost` has not done as a peripheral to a foreign controller |
| 8 | **Opt-in CI job** `android-e2e` (§5) | `.github/workflows/hertzbench-android.yml` (new) | the job boots an image, runs piece 4's scripted scenario green, and is red when the app's assertion is inverted | Medium. Runner time (boot plus image download), A8 |

Order rationale: pieces 1 to 4 deliver the person's main case (an app talking to ESP32 boards over
simulated Wi-Fi) and retire the largest risk first (piece 2's feature flag); BLE comes after,
because it depends on two unverified netsim behaviours and is reachable meanwhile with a real phone
through the existing BlueZ bridge.

**What would change this plan**: the emulator dropping `-feature -WiFiPacketStream` or the
socket netdev (go to the 10.0.2.2 fallback for Wi-Fi and look at netsim's packet streamer); netsim
not exposing a client's controller to the guest's scan (BLE stays real-phone only); a need for
the app to be a BLE peripheral or to see several nodes (start the packet-streamer route of §3).
