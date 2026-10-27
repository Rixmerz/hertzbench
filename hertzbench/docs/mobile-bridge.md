# The mobile bridge

A real phone talks to a simulated board (PLAN.md §9, Phase 5). The phone enters the engine as one more station on the medium, the bridge's node, at a position the scenario gives and the timeline or `move_node` can change. Whatever the phone sends to the board crosses the simulated link from that position, so it pays the channel model: path loss, walls, MAC retries, collisions, link overrides.

There are two bridges, one per PHY. A scenario has at most one, under `bridge:` ([scenario-format.md](scenario-format.md#bridge)):

| | 5a, IP bridge | 5b, BLE bridge |
|---|---|---|
| Scenario radios | `wifi` | `ble` |
| What the phone uses | HTTP, WebSocket, MQTT, any TCP, to `host:port` | GATT, to a peripheral the host advertises |
| On the host | one TCP listener per exposed node port, mDNS (`_http._tcp`, `_ws._tcp`, `_mqtt._tcp`) | BlueZ: a GATT application and an LE advertisement over D-Bus |
| On the medium | the bridge's own TCP connection to the node | a central that connects to the node and replays the phone's operations as ATT |
| Needs | `deno task lan` to listen beyond 127.0.0.1 | Linux, a running `bluetoothd`, PyGObject, an adapter |
| Code | `bridge/ip/` | `bridge/ble/` |

Neither bridge changes any Velxio file, and the engine side of both runs on any host: the tests replace what touches the host's network or radio with stand-ins (see [Tests](#tests)).

## 5a: the IP bridge

```yaml
bridge:
  id: phone                 # default "phone"; links, moves and metrics name it
  position: [3, 0]
  ip: 192.168.4.250         # default .250 of the scenario's /24
  listen: 0.0.0.0           # default 127.0.0.1
  expose:
    - { node: web, port: 80, service: http, listen_port: 8080 }
    - { node: web, port: 1883, service: mqtt }   # listen_port 0 (default): the OS picks
```

How a request travels: the phone opens a TCP connection to `host:8080`. The bridge accepts it and opens its own connection from `192.168.4.250` to `web:80` over the engine's small TCP (`engine/tcp.ts`). Bytes are relayed both ways, half-close and reset included, so HTTP, a WebSocket upgrade and MQTT work without the bridge looking inside them. Only the declared `node:port` pairs are relayed: the bridge cannot be used to reach any other address or port.

On the medium the bridge is a Wi-Fi station like a board: it answers ARP for its address (lwIP asks before it replies to a SYN), its segments go through `Medium.transmit`, and the report and `metrics.json` show its links (`phone->web`, kind `tcp`) like any other. A frame lost on the channel is retransmitted by the TCP on either side; a far bridge position or an `extra_latency_ms` on its links slows every request the phone makes.

**Run it so a phone can reach it.** The default tasks keep Deno's network permission at 127.0.0.1, and a bridge told to listen anywhere else stops the run with a message naming the fix. `deno task lan` grants `--allow-net` (listening on 0.0.0.0 and the mDNS group) and `--allow-sys=networkInterfaces` (to find the address mDNS advertises):

```bash
cd hertzbench
deno task lan run scenarios/examples/bridge-web-scripted.yaml   # edit listen: 0.0.0.0 first
```

The report and the progress lines say where each service is: `bridge phone: http web:80 at 0.0.0.0:8080`. From the phone, on the same Wi-Fi as the host: `http://<host address>:8080/status`. Open the host's firewall for those ports if it has one. A release binary has no `lan` command and needs none: it is built with the same permissions, so `./hertzbench-<os> run <scenario>` listens beyond loopback as is.

**mDNS.** With `listen` other than loopback, the bridge advertises each endpoint as a DNS-SD service: `web-80._http._tcp.local`, SRV to `hzb-web.local:8080`, A to the host's first non-loopback IPv4 address, skipping link-local and virtual adapters (VirtualBox, VMware, Hyper-V, WSL, Docker, libvirt) while a real one exists (or `advertise_ip`, or `listen` when it is a specific address), TXT `node=web port=80 via=hertzbench`. It announces at start, withdraws with TTL 0 at the end, and answers multicast, QU and legacy unicast queries. A service browser (`avahi-browse -art` on Linux, a DNS-SD browser app on the phone) lists them; whether the phone's browser resolves `hzb-web.local` depends on its OS, so the host address always works as well. `_ws._tcp` is a convention, not an IANA-registered type. If the socket cannot open (no permission, or port 5353 held by a daemon that does not share it), the report says `mDNS not advertised: <why>` and the run goes on. No probing or conflict resolution: the names carry `hzb-` and the node id.

## 5b: the BLE bridge

```yaml
bridge:
  id: phone
  position: [3, 0]
  mirror: sensor-1          # the peripheral whose GATT server the host mirrors
  name: hzb sensor-1        # what the host advertises; default the node's id
  adapter: hci0             # default hci0
  interval: 30ms            # the bridge's connection to the node
  timeout: 1s
```

At time zero the bridge's node, a virtual controller on the simulated air driven by a small central (`orchestrator/boards/drivers/hci-host.ts`), connects to `sensor-1` through its accept list and discovers the GATT server: primary services, characteristics, CCCDs (`orchestrator/boards/drivers/att.ts`). It hands that table to BlueZ, which advertises `name` with the first service's UUID. When the phone:

- **reads**, the bridge sends an ATT Read Request over the simulated connection and BlueZ answers the phone with the node's value, once it has crossed the air;
- **writes**, with or without response, the bridge sends a Write Request or Write Command; the node's error comes back as `org.bluez.Error.NotPermitted` or `org.bluez.Error.Failed`;
- **subscribes**, the bridge writes the node's CCCD, and each notification or indication the node sends is passed on as a change of the characteristic's value;
- does anything while the simulated link is down (out of range, supervision timeout), it gets `org.bluez.Error.Failed: not connected to sensor-1`. The bridge reconnects on its own and turns the phone's subscriptions back on.

**Run it.** Linux with a BlueZ that offers the `GattManager1` and `LEAdvertisingManager1` D-Bus interfaces (older releases kept them behind `bluetoothd --experimental`), `bluetoothd` running, an adapter powered on (`bluetoothctl power on`), and PyGObject (`python-gobject` on Arch, `python3-gi` on Debian and Ubuntu). Registering on the system bus is subject to the D-Bus policy for `org.bluez` (`/usr/share/dbus-1/system.d/bluetooth.conf`); if BlueZ refuses with an access error, that policy is where to look.

```bash
cd hertzbench
deno task hertzbench run scenarios/examples/bridge-ble-scripted.yaml
```

Then in nRF Connect or LightBlue on the phone: scan, connect to `hzb sensor-1`, open service `0xFF00`, read `0xFF01`, write it, subscribe to it. The bridge's log (its serial lines, also `get_serial` on the MCP server) shows each operation: `bridge phone read 0000ff01-...: "reading:12"`, `bridge phone wrote ...`, `bridge notify ...`. If BlueZ refuses the application or the advertisement, or `python3` or PyGObject is missing, the run reports it as a problem with BlueZ's reason.

The helper that talks to BlueZ is `bridge/ble/bluez_gatt.py`. It exports `/org/hertzbench/bridge` (ObjectManager, one GattService1 per service, one GattCharacteristic1 per characteristic) and an LEAdvertisement1, registers them with `org.bluez.GattManager1` and `org.bluez.LEAdvertisingManager1` on `/org/bluez/<adapter>`, and unregisters them when the run ends. It speaks JSON lines with `bridge/ble/bluez.ts`; the protocol is at the top of the file.

## What is modelled and what is not

| Leg | Modelled? |
|---|---|
| Phone to host (the real LAN, or the real BLE link to the host's adapter) | **No.** Real, with its own latency, loss and range. The bridge adds that on top of the simulated leg. |
| Bridge's node to the board, on the medium | **Yes**, at the bridge's position, with every link override, move and phase the scenario has. |
| The phone's TCP connection (5a) | Ends at the host. The connection on the medium is the bridge's own, with its own sequence numbers, MSS (1460) and retransmission timer. The phone sees the simulated link as delay, never as loss. |
| ATT (5b) | Translated, not passed through: BlueZ assigns its own handles, the phone's MTU is the phone's, and the simulated leg stays at ATT_MTU 23 (the virtual controller has no data length extension). A phone write longer than 20 bytes is refused. No long reads or writes, no reliable writes, no security: a characteristic that needs encryption cannot be reached. |
| Advertising (5b) | The host advertises the mirrored name and first service UUID; the node's own advertising data is not copied. |

The report prints the bridge's fidelity line next to the boards' ([fidelity.md](fidelity.md#mobile-bridge)).

## Windows and macOS

The BLE bridge (5b) needs BlueZ, which exists only on Linux. On Windows and macOS a scenario with
`bridge: { kind: ble }` is refused before any board starts, with
`the BLE bridge needs BlueZ, which only exists on Linux ...`; the run exits with status 2. Options:

- **Run the BLE bridge on a Linux machine** (a laptop, or a Raspberry Pi with its built-in adapter)
  and run the same scenario there. The simulation does not need to share a host with the phone.
- **Windows: WSL2.** Install a distribution, attach a USB Bluetooth adapter to it with
  [usbipd-win](https://github.com/dorssel/usbipd-win), start `bluetoothd` inside, and run the Linux
  steps above in WSL2. The WSL2 kernel must include Bluetooth support (the default kernel does not;
  a custom kernel is needed). This route has not been tried on this project.
- **macOS: a Linux VM or machine** with a USB adapter passed through. CoreBluetooth has no
  equivalent of BlueZ's GATT application API that the helper could use, so a native port would be a
  new helper, not a change to this one.
- **Use the IP bridge (5a)** with a Wi-Fi radio instead: it works on every system. For BLE
  behaviour without a phone, use the scripted BLE scenarios, which need no adapter.

The IP bridge's mDNS needs UDP port 5353 on the LAN. On Windows the firewall asks to allow the
program the first time it listens beyond loopback; on macOS the system may ask too. If the port is
held by a daemon that does not share it, the report says `mDNS not advertised: <why>` and the run
goes on; the host address always works.

## Tests

| What | How | File |
|---|---|---|
| Scenario `bridge:` and `serve:` | parse, defaults, every refusal | `tests/bridge_scenario_test.ts` |
| The engine's TCP | checksums against a Python implementation, a 20 KB transfer through 30% loss each way, refusal, timeout, ARP | `tests/tcp_test.ts` |
| 5a end to end | `runScenario` with scripted boards: `fetch`, a real WebSocket, MQTT written byte by byte; 150 ms on the bridge's links raises a request from 22 ms to 600 ms | `tests/bridge_ip_test.ts` |
| mDNS | the codec against hand-written bytes, the three kinds of asker, announce and goodbye, the UDP transport on loopback, the report line | `tests/bridge_mdns_test.ts` |
| 5b on the air | `runScenario` with a stand-in for BlueZ: discovery, read, write, subscribe, notifications, the walk out of range | `tests/bridge_ble_test.ts` |
| 5b BlueZ helper | the real `bluez_gatt.py` under `dbus-run-session` against a fake `bluetoothd` that plays the phone (`tests/fixtures/fake_bluez.py`); skipped when `dbus-run-session` is missing | `tests/bridge_ble_test.ts` |
| MCP | `get_status` shows the bridge, `move_node` moves it, `get_serial` reads its log | `tests/mcp_test.ts` |

**Never run** on the host this was written on: a real phone through either bridge, the mDNS multicast group on a LAN, and BlueZ on a real adapter. The checks for the first run are in [e2e-esp32.md](e2e-esp32.md#the-mobile-bridge).
