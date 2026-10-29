# Scenario format

A scenario is one YAML file. `hertzbench validate` checks it; every error names the field (`nodes[1].position: expected [x, y] or [x, y, z]`). Unknown fields are errors, not ignored. Durations need a unit: `500ms`, `60s`, `1.5s`, `2m`. A bare number is refused.

Examples: [`udp-3-nodes.yaml`](../scenarios/examples/udp-3-nodes.yaml) (ESP32) and [`udp-3-scripted.yaml`](../scenarios/examples/udp-3-scripted.yaml) (scripted boards, no QEMU) for Wi-Fi/IP; [`espnow-mesh-5-nodes.yaml`](../scenarios/examples/espnow-mesh-5-nodes.yaml) (ESP32) and [`espnow-mesh-scripted.yaml`](../scenarios/examples/espnow-mesh-scripted.yaml) (scripted) for ESP-NOW; [`ble-sensors-3-nodes.yaml`](../scenarios/examples/ble-sensors-3-nodes.yaml) (ESP32 sensors) and [`ble-sensors-scripted.yaml`](../scenarios/examples/ble-sensors-scripted.yaml) (scripted) for BLE; [`bridge-web-scripted.yaml`](../scenarios/examples/bridge-web-scripted.yaml), [`bridge-web-esp32.yaml`](../scenarios/examples/bridge-web-esp32.yaml), [`bridge-ble-scripted.yaml`](../scenarios/examples/bridge-ble-scripted.yaml) and [`bridge-ble-esp32.yaml`](../scenarios/examples/bridge-ble-esp32.yaml) for the mobile bridge; [`mqtt-clients-scripted.yaml`](../scenarios/examples/mqtt-clients-scripted.yaml) (scripted) for boards that publish to and subscribe on an MQTT broker node; [`door-and-interference-scripted.yaml`](../scenarios/examples/door-and-interference-scripted.yaml) (scripted) for a door that opens and a noise source that switches on and off; [`android-web-scripted.yaml`](../scenarios/examples/android-web-scripted.yaml) (scripted board) and [`android-web-esp32.yaml`](../scenarios/examples/android-web-esp32.yaml) (ESP32) for an app in the Android emulator that polls a web board and is walked out of range (the app is [`examples/android/iot-app`](../examples/android/iot-app/README.md)).

```yaml
name: udp-3-nodes            # required
seed: 42                     # default 1; 0 to 4294967295. Same seed, same channel decisions
duration: 90s                # required; counted from the moment every board's netdev connects
environment:
  preset: indoor_office      # free_space | indoor_office (default) | urban | rural
  path_loss_exponent: 3.0    # optional overrides of the preset
  shadowing_sigma_db: 0
  noise_figure_db: 10
  base_latency_ms: 0         # fixed delay added to every frame
  retry_limit: 7             # transmit attempts for a unicast frame, 1 to 32
  obstacles:                 # walls
    - { polygon: [[30, -20], [30, 20]], attenuation_db: 12 }
    - { id: front-door, polygon: [[10, -5], [10, 5]], attenuation_db: 12 }   # a named wall: a door the timeline can change
  interference:              # noise sources (a microwave oven, a neighbour's access point)
    - { id: oven, position: [12, 3], power_dbm: 20, band: 2.4ghz, from: 30s, to: 45s }
network:
  subnet: 192.168.4.0/24     # only a /24; the gateway is .1, boards start at .11
nodes: [...]                 # 2 to 10 boards
links: [...]                 # per-link overrides
timeline: [...]
assertions: [...]
outputs: { metrics: ./out/metrics.json, pcap: ./out/air.pcap, events: ./out/events.jsonl }
bridge: {...}                # optional: a real phone reaches the boards (see below)
```

## `environment`: walls, doors and interference

**Walls.** `obstacles` is a list of `{ polygon, attenuation_db }`. Two points are one wall; three or more are a closed outline. A frame pays a wall's attenuation once if the straight line between the stations crosses it.

**Doors.** A wall may carry an `id` (letters, digits, `_`, `.`, `-`; unique among the walls). Every edge of a polygon carries the polygon's id. A `timeline` entry `obstacle: { id, attenuation_db }` sets the attenuation of every edge with that id from then on, so a door opens with `attenuation_db: 0` and closes with its old value. The medium reads the new value for every frame sent after the entry; a frame already on the air keeps what it was sent with. The entry names an id that no wall has: error `timeline[i].obstacle.id`. Like any entry, it starts a metrics phase only if it has a `label`.

**Interference.** `interference` is a list of noise sources:

```yaml
interference:
  - id: oven                # letters, digits, "_", "." and "-"; unique among the sources
    position: [12, 3]       # metres: [x, y] or [x, y, z]
    power_dbm: 20           # radiated power, -50 to 60
    band: 2.4ghz            # 2.4ghz | 868mhz
    from: 30s               # optional: when it switches on, from time zero. Default: time zero
    to: 45s                 # optional: when it switches off. Default: the end of the run
```

- A source is on from `from` to `to` and **off before time zero**, so board start-up (DHCP, pairing) is not disturbed. One whose `from` is 0 or absent is on before the first frame of the run. `from` and `to` are at most `duration`, and `to` is after `from`.
- A `timeline` entry `interference: { id, on: true | false }` switches a source on or off at its time, whatever its window said. Of two switches the later one wins: a window's own switches are events like the timeline's.
- While on, a source raises the noise floor of every receiver in its band by its power **after the same path loss the signal would pay**: the log-distance model of the environment (`path_loss_exponent`, reference distance) from the source's position to the receiver, plus the walls between them (a door counts), plus the receiver's antenna gain. The received interference adds to the thermal noise in milliwatts, so one source that arrives at the thermal floor adds 3 dB, and one 20 dB above it adds about 20 dB. The SNR falls by as much and the RSSI does not move. It stacks with a link's `interference_db`, which raises the floor further.
- `band` is compared with the receiver's centre frequency: `2.4ghz` is 2400 to 2500 MHz (Wi-Fi, ESP-NOW, nRF24 and BLE), `868mhz` is 863 to 870 MHz (LoRa at the 868 MHz settings). A LoRa radio at 433 or 915 MHz hears neither. Radios have no band setting of their own; this is the whole band-matching rule.
- The frames it costs are lost by the reasons the PHY already has: `noise` on LoRa, nRF24 and BLE; `retry_exhausted` on Wi-Fi, UDP/TCP and ESP-NOW (the sender has used up its attempts at the lower SNR). No new reason.
- Not modelled: duty cycle or modulation of the source (it is constant while on), selectivity between channels (a source in the band is heard across all of it, so a Wi-Fi access point on channel 1 hurts a node on channel 11 as much as one on channel 1), shadowing on the source's path, and the source hearing or being heard by anything. Collisions between stations are still the ones of [fidelity.md](fidelity.md).
- Both are deterministic: a source adds no random draw, so the same seed gives the same run, and a scenario without sources or doors draws and decides exactly as before.
- Both can be changed in a run in progress only through [MCP](mcp.md): `set_channel` replaces the walls (keep the `id`s the timeline names, or the entry is logged as a warning and ignored). Sources are fixed by the file; switch them with the timeline.

## `nodes`

```yaml
- id: sensor                 # letters, digits, "_", "." and "-"
  count: 4                   # optional; expands to sensor-1 .. sensor-4 and needs a grid position
  board: esp32               # esp32 | esp32-devkit-v1 (same board) | scripted | android
  firmware: ./fw/udp-node    # esp32: a sketch directory, or a .bin flash image. Relative to the scenario file
  position: [0, 0]           # metres: [x, y] or [x, y, z]. Walls ignore z
  # position: { grid: { origin: [10, 0], step: [8, 0] } }    # for count > 1
  radios: [{ phy: wifi, channel: 5, tx_power_dbm: 15, antenna_gain_dbi: 0 }]   # exactly one: wifi, lora, nrf24 or ble
  ip: 192.168.4.20           # optional; default .11, .12, ... in node order
  internet_gateway: true     # optional; see below
```

- Only the classic ESP32 does Wi-Fi networking in Phase 1. `esp32-c3` and `esp32-s3` are refused with the reason.
- `channel` is the channel the node's radio uses in the model. Velxio's compile step forces channel 5 on any `WiFi.begin()`, so use 5 for ESP32 sketches that join Wi-Fi through it. An ESP-NOW sketch picks its own channel (`esp_wifi_set_channel`); give the node the same one. ESP-NOW frames travel on the channel the firmware wrote into them, and a mismatch with the scenario is reported as a warning ([fidelity.md](fidelity.md#esp-now)).
- ESP32 station MACs are `02:68:7a:62:01:NN`, NN being the node's place in the file counting from 01 (after `count` expansion). ESP-NOW sketches that address a peer by MAC depend on that order.
- `internet_gateway: true` marks the one ESP32 that keeps SLIRP. It is **off the medium**: it cannot exchange frames with the other boards. At most one. See [fidelity.md](fidelity.md).
- A `scripted` board takes `firmware: { send: [...] }`. It is a traffic generator for hosts without libqemu, not firmware:

  ```yaml
  send:
    - { to: b, every: 50ms, count: 100, payload: ping, port: 5000, start: 0ms }
  ```

  It does DHCP at start-up, then sends `<payload>:<n>` over UDP to the named node, answers any datagram that starts with `ping` with `pong<same suffix>`, and logs `rx <text> from <node>` on its serial line.

  With `via: espnow` the send is an ESP-NOW frame instead, through a model of the QEMU fork's ESP-NOW MAC; `to` may then be `broadcast`, and `port` is refused. The payload stays within 200 bytes.

  ```yaml
  send:
    - { to: gw, via: espnow, every: 100ms, count: 50, payload: reading }
    - { to: broadcast, via: espnow, every: 1s, count: 5, payload: beacon }
  ```

  With `serve`, the board runs TCP servers once it has its lease, for the [mobile bridge](#bridge) to reach:

  ```yaml
  serve:
    - { port: 80, protocol: http }      # one plain-text line per request, "<node>: GET /path"; a WebSocket upgrade echoes messages
    - { port: 1883, protocol: mqtt }    # an MQTT 3.1.1 broker at QoS 0: subscribe (+ and #), publish, retained messages, ping
  ```

  Ports are distinct, 1 to 65535. Serial lines: `tcp listening on <port> (<protocol>)`, `http <METHOD> <path> from <ip>`, `ws open <path> from <ip>`, `ws rx "<text>" from <ip>`, `ws closed from <ip>`, `mqtt connect <client id> from <ip>`, `mqtt subscribe <filter> from <client id>`, `mqtt publish <topic> "<payload>" from <client id>`. A PUBLISH with the RETAIN flag is kept, one message per topic (an empty one clears it), and sent to a client when it subscribes to a matching filter. The `mqtt_publish` [MCP tool](mcp.md) publishes through the broker too, as client `mcp`.

  With `via: mqtt` the board is an MQTT 3.1.1 client of a broker node (a scripted node that `serve`s `mqtt`, or an ESP32 running one) and publishes periodically; `subscribe` lists the topics it listens on:

  ```yaml
  send:
    - { to: broker, via: mqtt, topic: riego/estado, every: 10s, payload: [ON, OFF] }
  subscribe:
    - { to: broker, topic: riego/cmd }
  ```

  - `topic` is required with `via: mqtt` and refused with any other `via`; a publish topic takes no `+` or `#`. `payload` is a string or a list of strings: each publish sends the next one and the list starts over after the last. The payload goes out as written, with no `:<n>` suffix. `port` is the broker's port, default 1883. `count` is optional for MQTT and defaults to 100000, that is, until the run ends. An MQTT send is Wi-Fi only.
  - `subscribe` entries are `{ to, topic, port }`: `to` the broker node, `topic` a filter (`+` for one level, `#` as the whole last level), `port` default 1883. Each message that arrives is a serial line `mqtt rx <topic> <payload>`. Wi-Fi only.
  - `to` must be a node on the medium other than the board itself. If it is a scripted node, it must `serve` `mqtt` on that port (`<node> serves no MQTT broker on port <port>` otherwise); any other board is taken at its word.
  - One connection per broker (node and port) carries all the board's publishes and subscriptions to it. It connects as soon as the board has its lease, with the board's id as client id, a clean session and a 10 s keep-alive. The `start` of a publish counts from the first time the session is up, so the handshake does not eat the first publish; later publishes keep the `every` cadence, and one that falls while the session is down is skipped and logged as `mqtt tx <topic> skipped: not connected to <node>`.
  - **Reconnection.** If the TCP connection closes or resets, or the broker says nothing for 15 s (1.5 keep-alives, with a PINGREQ every 10 s), the board connects again after 1 s and subscribes again; the same retry covers a broker that is not listening yet. The board never sets RETAIN on its own publishes. No QoS above 0, will or authentication: the broker of `serve` has none either.
  - Serial lines: `mqtt connected to <node>`, `mqtt disconnected from <node>`, `mqtt rx <topic> <payload>`, `mqtt tx <topic> skipped: not connected to <node>`. On the broker node, `mqtt connect|subscribe|publish ...` as for any client, so a phone on the [bridge](#bridge) that exposes the broker sees the same topics.

  Frames go one at a time, each waiting for its ACK or, if none comes, for the fork's 10 ms timeout plus a 30 ms allowance for the loopback hops (a failed send is logged about 40 ms after it). The board logs `espnow rx <text> from <node>` for each frame it accepts and `espnow tx ok to <node>` or `espnow tx fail to <node>` for each send it completes. The ESP32 example sketches print the same lines.

### `board: android`: an app in the Android emulator, on Wi-Fi

An `android` node is an Android Virtual Device booted headless under the Android emulator, with an app installed and launched. Its Wi-Fi is one more station on the medium: it gets a DHCP lease from the virtual gateway, and its ARP, UDP, TCP and broadcast traffic pay the channel model from its position, like an ESP32's. The node takes the usual `id`, `position`, `radios` (Wi-Fi only) and `ip`; it takes no `firmware` and no `count`.

```yaml
- id: phone
  board: android
  position: [6, 0]
  radios: [{ phy: wifi, channel: 5 }]
  mac: 02:15:d0:00:00:00         # optional; default: the MAC the AVD gives wlan0
  android:
    avd: pixel8                  # an existing AVD; Hertzbench never creates or downloads one
    apk: ./app/build/app-debug.apk   # relative to the scenario file
    package: dev.example.iotapp
    activity: .MainActivity      # optional; default: the launcher activity
    extras: { board_url: "http://192.168.4.11/" }   # optional: --es key value on launch
    logcat: [HZB]                # tags whose lines become the node's serial lines; default [HZB]
    boot_timeout: 120s           # default 120s
    install_timeout: 60s         # default 60s
    launch_timeout: 20s          # default 20s
    snapshot: true               # optional: boot the prepared snapshot, see below; default false
    instrument:                  # optional: instrumented UI tests, see below
      runner: dev.example.test/androidx.test.runner.AndroidJUnitRunner
      at: 5s                     # after time zero
      apk: ./app/build/app-debug-androidTest.apk   # the test APK, installed after the app
```

- `avd`, `apk` and `package` are required. The section is refused on any other board. A run has at most one android node that cold-boots (one AVD cold-boots with one MAC); several need `snapshot: true`, see below.
- A BLE or other chip radio is refused. The app reaches BLE nodes through the mobile bridge, not as a node: [`peripheral: netsim`](#bridge) and the top-level `android:` section.
- **Start-up.** The node's start resolves only once the app is running (boot, `adb install`, logcat, `am start -W`), so time zero comes after the app, and the emulator's boot time (about 30 s for `pixel8`) is spent before it. Each step has its own timeout, named in its failure. The emulator's last output goes to `<out>/<node>-emulator.log`.
- **Logcat.** Every line the app logs under one of the `logcat` tags is a `serial` line of the node, so `- serial: { node: phone, contains: "got temp", within: 20s }` works unchanged. Times are host arrival times, good to about 100 ms. adb's own buffer banner (`--------- beginning of main`) is not a serial line.
- **MAC.** The gateway leases by MAC and skips an unknown one, and the medium needs the MAC before the guest boots. The emulator derives `wlan0`'s MAC from its console port: `02:<port high byte>:<port low byte>:00:00:00` (port 5554 gives `02:15:b2:00:00:00`, port 5584 gives `02:15:d0:00:00:00`; seen with emulator 37.1.11). The default `mac:` is `02:15:d0:00:00:00`, and the launcher starts the emulator on console port 5584 to match; if that port is taken the run stops and says so. A `mac:` of that shape picks its own port (even, 5554 to 5682); any other `mac:` says the guest was set to it by other means and gets a free port. Either way the run checks the source MAC of the first frame the emulator sends and, if it differs, stops naming both MACs.
- **Host.** Linux with KVM (`/dev/kvm` usable), and `emulator` and `adb` found on `PATH`, in `$ANDROID_HOME`, `$ANDROID_SDK_ROOT` or `~/Android`. A missing tool, KVM or AVD stops the run with exit status 2 and the reason.
- **Undocumented flag.** The emulator is started with `-feature -WiFiPacketStream -wifi-socket connect=127.0.0.1:<port>`. Without the feature flag netsim owns the guest's Wi-Fi and the socket stays silent. The flag is not a documented API; it was verified with emulator 37.1.11, and a failure on another build says so.
- **Snapshot boot and several android nodes.** `snapshot: true` boots the snapshot that `hertzbench android prepare <avd>` saved instead of cold-booting, and gives the guest's `wlan0` the node's MAC with `-wifi-mac-address`, so any number of android nodes (up to the 10 boards a run takes) share a run, each with its own lease, console port and position. Such a node's default `mac:` is the usual `02:68:7a:62:01:NN` of its place in the node list, not the AVD's; a `mac:` override still applies. A cold-boot node may share the run with snapshot nodes and keeps the AVD's MAC. `prepare` boots the AVD once, writable, from a cold boot and with the Wi-Fi flags a run uses, waits for it, saves the snapshot `hertzbench` into the AVD (its own snapshots, `default_boot` included, are untouched), writes `hertzbench.json` beside it naming the emulator build, and stops the emulator. The AVD must not be running. It exits 0, or 2 with the reason (no KVM, no such AVD, a boot timeout with the emulator's log, a refused save). A run with `snapshot: true` stops before booting anything, exit status 2, when the AVD has no such snapshot or it was prepared by another emulator build: snapshots are tied to the build, so run `prepare` again after an emulator update. The emulator is started with `-snapshot hertzbench -force-snapshot-load`, so a snapshot that cannot be loaded ends the emulator instead of silently cold-booting with a MAC the medium does not know; the run still checks the first frame's source MAC. The boot is still `-read-only`: runs do not change the AVD, and the app is installed on every run. The first line of `<out>/<node>-emulator.log` says `snapshot boot` or `cold boot`.
- ESP-NOW frames share the medium, but an app cannot send or receive them.
- **Driving the app.** A `timeline` entry `android: { node, intent: { action, via, extras } }` runs `adb shell am broadcast -a <action> -p <package> --es key value ...` (`via: broadcast`, the default) or `am start` (`via: start`) at its time. The intent is always limited to the node's `package`, so a test hook cannot reach another app. `action` is a dotted name (`dev.example.REFRESH`); `extras` are strings. The node must be an `android` node, else `timeline[i].android.node: <id> is not an android node`. The entry returns once the system has taken the intent, not once the app has handled it, so assert on what the app logs. A failed `am` (it exits 0 and prints `Error: ...`) is a problem of the run, quoting adb. `broadcast` reaches a receiver declared in the manifest as well as one registered at run time; `start` needs an activity whose intent filter has `android.intent.category.DEFAULT`.
- **Instrumented tests.** `instrument` runs `am instrument -w -r <runner>` at `at` (not after `duration`) and turns each test result into a serial line as the test ends: `test <class>#<method> passed`, `failed` (a failure or an error) or `skipped` (ignored, or an assumption that did not hold). `serial:` assertions judge them: `- serial: { node: phone, contains: "MainTest#shows_temp passed", within: 30s }`. A test that fails is a line, not a problem of the run; a runner that cannot start, a crashed process or an `adb` that ends before the instrumentation does is a problem, and a test that had started and never ended is reported `failed`. `apk` is the test APK: the emulator boots with `-read-only`, so nothing installed earlier survives, and `am instrument` needs the test package on the device; it is installed with `adb install -r -t` after the app, within `install_timeout`, and must exist like `android.apk`. Without it the runner must come from an APK installed some other way. The run ends instrumentation when `duration` does.
- **Example.** [`examples/android/iot-app`](../examples/android/iot-app/README.md) is a small Kotlin app that sends `GET /status` to a board once a second and logs `HZB status ok 200 ...` or `HZB status failed: ...`; its APK path in the example scenarios is where `gradle assembleDebug` leaves it, and `validate` reports it as missing until it is built.

### BLE radios

```yaml
radios: [{ phy: ble, tx_power_dbm: 0, antenna_gain_dbi: 0, hci_uart: 1 }]
```

- Every node of a BLE scenario has a `ble` radio. Its controller is the engine's (F3, [fidelity.md](fidelity.md#ble)); the firmware brings its own host stack and configures everything else (advertising, scanning, connection parameters) over HCI.
- `tx_power_dbm`: -20 to 20, default 0. The ESP32 transmits BLE at -12 to +9 dBm.
- `hci_uart`: 1 (default) or 2, the UART the firmware's host stack writes HCI to. UART0 is refused: it is the serial console. Scripted boards ignore it.
- A node's device address is its MAC, `02:68:7a:62:01:NN`.
- `ip` and `internet_gateway` are refused.

A `scripted` BLE board plays a host (not firmware). It is a peripheral or a central:

```yaml
firmware:
  advertise: { name: sensor-1, interval: 50ms }   # or `advertise: true`: the node's id, 100 ms
  send: [{ to: gw, every: 200ms, count: 35, payload: reading }]
```

```yaml
firmware:
  connect: { peers: [sensor-1, sensor-2], interval: 30ms, timeout: 1s }
  scan: true                                       # optional: log every advertiser heard
  send: [{ to: sensor-1, every: 1s, count: 5, payload: cmd }]
```

- A peripheral advertises connectable, and again after a disconnection. A central connects to its `peers` through the filter accept list and reconnects whenever a link drops. `interval` is 7.5 ms to 4 s in steps of 1.25 ms (default 30 ms), `timeout` 100 ms to 32 s in steps of 10 ms (default 1 s) and more than twice the interval.
- A send goes over the connection to `to` (`via: gatt` is implied): an ATT notification from a peripheral, an ATT Write Command from a central, on handle 0x0010, carrying `<payload>:<n>`. The payload stays within 14 bytes. `to` must be a node the board connects to or that connects to it; `port` is refused. A send while not connected is skipped and logged.
- Serial lines: `ble ready addr=<address>`, `ble advertising as <name>`, `ble connected to <node> as central|peripheral`, `ble disconnected from <node> reason=0x08`, `ble tx <text> to <node>`, `ble rx "<text>" from <node>`, and with `scan: true` `ble adv "<name>" from <node> rssi=<dBm>`.

## `bridge`

At most one, on a Wi-Fi or BLE scenario. The bridge is a station on the medium: `links`, `timeline.move`, metric assertions (`phone->web`) and `serial` assertions (its log) can name it. It does not count toward the 2 to 10 boards. How it works and how to run it: [mobile-bridge.md](mobile-bridge.md).

Common fields: `id` (default `phone`; not a node's id, not `gateway` or `broadcast`), `position` (required), `radios` (optional, one radio of the scenario's PHY; Wi-Fi defaults to the exposed nodes' channel at 15 dBm, BLE to 0 dBm). Its MAC and BLE address is `02:68:7a:62:02:01`.

On Wi-Fi (Phase 5a, the IP bridge):

```yaml
bridge:
  position: [3, 0]
  ip: 192.168.4.250          # default .250; inside the subnet, no node's address
  listen: 127.0.0.1          # the host address the proxy binds; 0.0.0.0 for a phone on the LAN
  mdns: true                 # default: on when `listen` is not a loopback address
  advertise_ip: 192.168.1.20 # optional: the A record mDNS gives; default `listen` if specific, else the host's first LAN address
  expose:                    # at least one
    - { node: web, port: 80, service: http, listen_port: 8080 }   # service: http | websocket | mqtt
```

- `listen_port` 0 (the default) lets the OS pick; the report and the progress lines print the port. Two entries cannot share a non-zero `listen_port`.
- Only the listed `node:port` pairs are reachable through the bridge. An exposed node must be on the medium and on the bridge's channel.
- `service` only chooses the mDNS service type (`_http._tcp`, `_ws._tcp`, `_mqtt._tcp`); the relay carries any TCP.
- The bridge's log lines: `bridge listening on <host>:<port> for <node>:<port> (<service>)`, `bridge <client> -> <node>:<port> connected`, `... closed: <n> B to the node, <n> B from it`, `... failed: <reason>`.

On BLE (Phase 5b, the GATT mirror):

```yaml
bridge:
  position: [3, 0]
  mirror: sensor-1           # required: the peripheral whose GATT server the host mirrors
  name: hzb sensor-1         # what the host advertises; default the node's id; at most 26 bytes
  peripheral: bluez          # the host side: bluez (default, a real phone) or netsim (an app in the Android emulator)
  adapter: hci0              # BlueZ adapter, default hci0; refused with peripheral: netsim
  netsim_hci: 127.0.0.1:6402 # netsimd's HCI port, default as shown; needs peripheral: netsim
  interval: 30ms             # the bridge's connection to the node, as for a scripted central
  timeout: 1s
```

- A scripted `mirror` must advertise. Its sends may go `to:` the bridge's id: they are notifications to the bridge, which passes them to a subscribed phone.
- `peripheral: netsim` replaces BlueZ with the Android emulator's netsim (it is a TCP client of `netsim_hci`, an IPv4 address and a port, so it needs no adapter and runs on every OS; a host other than 127.0.0.1 needs `deno task lan`). A port that cannot be reached, or is not a Bluetooth controller, stops the run before it starts with exit status 2. How it works, its limits and what has not been run: [mobile-bridge.md](mobile-bridge.md#5b-with-netsim-an-app-in-the-android-emulator).
- The bridge's log lines: `bridge ready addr=<address>`, `bridge connected to <node>`, `bridge discovered service <uuid> with <n> characteristic(s)`, `bridge advertising "<name>" to the phone (<host side>)`, `bridge phone read|wrote <uuid>: "<value>"`, `bridge phone subscribed to <uuid>`, `bridge notify <uuid> "<value>" to the phone`, `bridge phone <operation> failed: <reason>`, `bridge disconnected from <node> reason=0x08`; with netsim also `bridge phone connected`, `bridge phone disconnected reason=0x13` and `bridge netsim closed the HCI connection (the emulator stopped?)`.

### `android`: the app of a BLE scenario

```yaml
android:
  avd: pixel8
  apk: ./app/build/app-debug.apk   # relative to the scenario file
  package: dev.example.bleapp
  activity: .MainActivity          # optional, as on a node
  extras: { key: value }           # optional
  logcat: [HZB]                    # default [HZB]
  boot_timeout: 120s               # default 120s
  install_timeout: 60s             # default 60s
  launch_timeout: 20s              # default 20s
```

The app that connects to a BLE bridge, run in the Android emulator. It is **not a node**: it has no position, radio or MAC of its own; the bridge's `position` stands in for it. The fields and the start-up are those of a [node's `android` section](#board-android-an-app-in-the-android-emulator-on-wi-fi), less `instrument` and `snapshot`, which are refused. The emulator starts with `-netsim-args "--hci-port <port>"`, the port of `bridge.netsim_hci`, and without the Wi-Fi flags. The runner starts it beside the boards and waits for it before time zero, and its logcat lines are serial lines of the **bridge's id** (`- serial: { node: phone, contains: "got reading", within: 20s }`). The section needs a BLE scenario with `bridge: { peripheral: netsim }` whose `netsim_hci` is on this host (a refusal names which is missing); `board: android` on a BLE node is refused. `validate` reports a missing APK like a node's. The host needs what a node's does (Linux with KVM, `emulator` and `adb`); without this section nothing is booted and the emulator is yours to start.

## `links`

```yaml
- { from: sensor-*, to: gw, extra_loss_pct: 10, extra_latency_ms: 5 }
```

Directional. `*` matches any run of characters. Both extras default to 0. Applied from time zero; the same entry under `timeline.link` applies it later.

## `timeline`

```yaml
- at: 40s
  label: behind-wall                          # optional; starts a new metrics phase of this name
  move: { node: c, to: [42, 0] }              # optional; live move
  link: { from: c, to: a, extra_loss_pct: 50 }  # optional; chaos override from now on
  obstacle: { id: front-door, attenuation_db: 0 }   # optional; a door opens (or closes again with its old value)
  interference: { id: oven, on: false }      # optional; switch a noise source off or on
  android: { node: phone, intent: { action: dev.example.REFRESH, via: broadcast, extras: { k: v } } }   # optional; see `board: android`
```

Needs at least a `move`, a `link`, an `obstacle`, an `interference`, an `android` intent or a `label`. Events past `duration` are an error. A door or source the entry names must exist in `environment`: `timeline[i].obstacle.id` and `timeline[i].interference.id` say which one does not. A door or source entry makes a phase only with a `label`. Metrics are reported for the whole run and per phase; the first phase is called `start`.

## `assertions`

```yaml
- serial: { node: a, contains: "wifi up", within: 30s }     # `within` optional
- metric:
    link: "c->a"                  # from->to, either side may use *
    phase: behind-wall            # optional; `start` or a timeline label. Default: whole run
    kind: udp                     # optional frame kind: arp dhcp udp tcp icmp ipv4 espnow espnow-ack lora nrf24 nrf24-ack ble-adv ble-data ble-acl other
    loss_pct: { gt: 20 }          # fields below, comparisons lt lte gt gte eq
    latency_p95_ms: { gt: 4 }
```

Metric fields: `sent`, `delivered`, `loss_pct`, `latency_p50_ms`, `latency_p95_ms`, `latency_p99_ms`, `latency_mean_ms`, `rssi_dbm`, `snr_db`, `mean_attempts`, `acked_pct`, `ack_rtt_p95_ms`. `sent` counts frames that reached an outcome (delivered or dropped). `acked_pct` and `ack_rtt_p95_ms` are about unicast ESP-NOW sends on the link: the share whose ACK came back within the fork's 10 ms, and the 95th percentile of their round trip. Use them with `kind: espnow` or no `kind`; with any other kind they have no value and the check fails. A link pattern must match at least one link that carried frames, and **every** matching link must satisfy every comparison. A latency check on a link that delivered nothing fails.

## `outputs`

Paths are relative to the scenario file. Defaults are `metrics.json`, `air.pcap` and `events.jsonl` in `<scenario dir>/out`. A run that carried ESP-NOW also writes the same frames as 802.11 with a radiotap header next to the capture: `air.pcap` gives `air-80211.pcap`. A BLE run's `air.pcap` holds LE link-layer packets (link type 256), and each node's HCI goes to `hci-<node>.btsnoop` in the output directory. `--out DIR` on the command line overrides all of them. Per-board files (`serial-<node>.log`, `efuse-<node>.bin`, `worker-<node>.stderr.log`) go in the output directory.

## `events.jsonl` and time zero

One JSON event per line, in the order the engine logged them, with `t` in milliseconds. Time zero is the moment every board's netdev has connected, and `timeline`, `duration`, phases and `within` are all measured from it. A board that connects early can already have talked: those events carry **negative** `t`. They are in the log and in `air.pcap` (whose timestamps are real clock time and never step back) but outside every metric window, which starts at 0.

## `metrics.json`

`schema: 1`. Top level: `scenario`, `seed`, `duration_ms`, `latency` (`"modelled"`), `fidelity`, `nodes`, `links` (whole run), `phases` (each with `label`, `from_ms`, `to_ms`, `links`), `warnings`, `problems`, `assertions`, `passed`. A link holds `from`, `to`, `sent`, `delivered`, `dropped` (by reason: `retry_exhausted`, `extra_loss`, `channel_mismatch`, `no_peer`, for ESP-NOW ACKs `ack_timeout`, `ack_unmatched`, for chip radios `collision`, `noise`, `phy_mismatch`, `not_listening`, and for BLE ACL data `link_lost`), `loss_pct`, `latency_ms` (`p50`, `p95`, `p99`, `mean`, `max`, or `null`), `rssi_dbm`, `snr_db`, `mean_attempts`, `bytes_delivered`, and `espnow`: `null`, or for unicast ESP-NOW sends on the link `sends`, `acked`, `outcomes` (by `acked`, `frame_lost`, `ack_timeout`, `no_ack`), `acked_pct` and `round_trip_ms` (same shape as `latency_ms`). With a bridge, `metrics.json` also has `bridge`: `kind` (`ip` or `ble`), `id`, and either `endpoints` (each `node`, `port`, `service`, `listenPort`, `host`, `hostPort`) and `mdns` (one line: what was advertised, or why nothing was), or `mirror`, `adapter` (`netsim` with `peripheral: netsim`), `name`, `services` (the discovered table) and `peripheral` (the host side, e.g. `BlueZ on hci0` or `netsim HCI port 127.0.0.1:6402`). The bridge's station is the last entry of `nodes`, with `board: "bridge"`. `events.jsonl` has a `channel` event (with the walls as they are now) each time a door changes, an `interference` event (`id`, `active`) each time a source switches, one `espnow-send` event per unicast ESP-NOW send with its outcome and `roundTripMs`, a `ble-link` event each time a BLE controller sees a connection come up or go down (`node`, `peer`, `role`, `state`, the HCI `reason`, `intervalMs`), and `warning` events.

## Exit status

`0` the run passed. `1` an assertion failed, or a board or the adapter reported a problem. `2` the scenario is invalid, a firmware path is missing, or the host cannot run it (for example, no libqemu). `130` interrupted with Ctrl-C or SIGTERM: every board is stopped and no results are written.
