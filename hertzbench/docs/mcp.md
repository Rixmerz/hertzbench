# The MCP server

`hertzbench mcp` lets an AI agent such as Claude Code build, run and inspect scenarios, and change a
run while it plays. It speaks the [Model Context Protocol](https://modelcontextprotocol.io) over
stdin and stdout. It is a thin layer over the same orchestrator as `hertzbench run`: same scenario
format, same engine, same `metrics.json`.

Velxio has its own MCP server (`backend/app/mcp/server.py`). It compiles sketches and converts
circuits, but it starts no simulation, and the Velxio app does not mount it (discovery Q6). This
server is separate, new code. It does not use Velxio's server.

## Register it with Claude Code

With the commands installed (`deno task install-cli`):

```bash
claude mcp add hertzbench -- hertzbench mcp --workspace /path/to/your/project
```

Without installing them:

```bash
claude mcp add hertzbench -- deno run --allow-net=127.0.0.1 --allow-read --allow-write \
  --allow-run --allow-env /path/to/repo/hertzbench/cli/main.ts mcp --workspace /path/to/your/project
```

Or, for everyone working on a project, in its `.mcp.json`:

```json
{
  "mcpServers": {
    "hertzbench": {
      "command": "hertzbench",
      "args": ["mcp", "--workspace", "."],
      "env": { "QEMU_ESP32_LIB": "/path/to/libqemu-xtensa.so" }
    }
  }
}
```

`QEMU_ESP32_LIB` is only needed for ESP32 boards (see
[Running the ESP32 example](#running-the-esp32-example)). Scripted boards need nothing but Deno.

From the `hertzbench/` directory, `deno task mcp --workspace DIR` starts the server by hand. It
waits for JSON-RPC on stdin, so this is only useful for debugging.

## The workspace

`--workspace DIR` defaults to the current directory. Claude Code starts stdio servers in the project
directory, so the default is usually what you want.

- **Paths you give** (`path`, `out`) are relative to the workspace. An absolute path works too, if
  it is inside a root (below).
- **Every file the server reads or writes by a path you give stays inside its roots.** Reads
  (`read_scenario`, `validate_scenario`, `run_scenario`) may use two roots: the workspace and the
  shipped example scenarios (`scenarios/examples/`), so `run_scenario` can run the examples where
  they are. Writes (`create_scenario`, `edit_scenario`, `add_node`, `remove_node`, `export_capture`
  and every run output) may use the workspace only: the examples are never modified.
- **A path outside the roots is a tool error** (`isError`), not a server fault. That covers `..`,
  an absolute path elsewhere, and a symlink, also a dangling one, that leads out: symlinks are
  resolved before the check. A path with a NUL byte is refused too. The error is the same whether
  or not the file outside exists, and never contains its text.
- **To change the roots**, start the server with another `--workspace DIR` (for Claude Code,
  `claude mcp add hertzbench -- hertzbench mcp --workspace /path/to/project`). There is one
  workspace per server and no other option; to read scenarios elsewhere, copy or link them in,
  with a link that stays inside the workspace.
  A run always writes to its own `out` directory. The scenario's `outputs:` paths are ignored there,
  as `hertzbench run --out` ignores them.
- **Firmware paths inside a scenario** resolve from the scenario file's directory, as with the CLI.
  For scenario text given to `validate_scenario` as `yaml`, they resolve from the workspace.

## Tools

Everything the CLI, the orchestrator, the media and the view can do is a tool. Arguments marked `?`
are optional.

### Boards and scenario files

| Tool                | Arguments                                   | What it does                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_boards`       | none                                        | Board kinds, the names a scenario may give them, their fidelity level, and whether this host can run them (`esp32` needs libqemu). Also lists the boards that are refused, and why.                                                                                                                                                             |
| `create_scenario`   | `path`, `yaml`, `overwrite?`                | Validates the text and writes it to `path` (`.yaml` or `.yml`). Invalid text is refused and nothing is written. An existing file is kept unless `overwrite: true`. Missing firmware is listed in `missing_firmware` but not refused, so you can write the scenario first.                                                                     |
| `read_scenario`     | `path`                                      | The file's text and what it parses to (nodes with addresses, positions, radios, firmware), or `valid: false` with the first error and its field path. Reads anywhere, like the CLI.                                                                                                                                                         |
| `edit_scenario`     | `path`, `set?`, `nodes?`, `add?`            | Changes a scenario file in one step. `set` is a JSON merge patch on the top level (`name`, `seed`, `duration`, `environment` with its walls, doors (`obstacles[].id`) and `interference` sources, `links`, `timeline`, `assertions`, `outputs`, `bridge`, ...): objects merge, `null` removes a key, arrays are replaced whole. `nodes` patches node entries by `id` the same way; `null` removes the node. `add` appends node entries. See [Editing a scenario](#editing-a-scenario). |
| `add_node`          | `path`, `node`                              | Appends one node entry (`{ id, board, position, radios, firmware, count?, ip?, internet_gateway? }`).                                                                                                                                                                                                                                      |
| `remove_node`       | `path`, `id`                                | Removes one node entry. Refused while a link rule, timeline entry, assertion or scripted send still names the node; remove those in the same `edit_scenario` call.                                                                                                                                                                         |
| `validate_scenario` | `path` or `yaml`                            | Parses and checks a scenario, and checks that its firmware exists. Returns the expanded nodes with their addresses and positions, or the first error with its field path (`nodes[0].board: ...`).                                                                                                                                           |

### Running

| Tool           | Arguments                   | What it does                                                                                                                                                                                                                                                                                                                                    |
| -------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_scenario` | `path`, `seed?`, `out?`     | Starts the run in the background and returns at once with state `starting`. Errors known before boot come back here: an invalid scenario, missing firmware, no libqemu for an ESP32 node, a run already in progress.                                                                                                                             |
| `get_status`   | none                        | `idle` before the first run. Then `starting`, `running`, `finished` (with `passed`, the assertions and the files), `failed` (with the error) or `stopped`. Also elapsed time, live node positions, board problems and, with a mobile bridge, `bridge`: its host endpoints (or mirrored GATT table) and its live position.                       |
| `get_report`   | none                        | The text report `hertzbench run` prints, once the run has finished.                                                                                                                                                                                                                                                                             |
| `stop`         | none                        | Stops the run and its boards. See [Stopping](#stopping).                                                                                                                                                                                                                                                                                      |

### Changing a run while it plays

Every one of these acts at the moment the call arrives, logs an event, and refuses while the run is
still `starting`. `phase?` starts a metrics phase with that label at the same instant.

| Tool           | Arguments                                                                                                       | What it does                                                                                                                                                                                                                                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `move_node`    | `node`, `position` (`[x, y]` or `[x, y, z]`), `phase?`                                                          | Moves a node, or the mobile bridge's station (its id, `phone` by default). Returns the new distance, RSSI and SNR from that node to each of the others, on every PHY.                                                                                                                                                              |
| `inject_fault` | `link` (`from->to`, `*` allowed), `extra_loss_pct?`, `extra_latency_ms?`, `extra_jitter_ms?`, `interference_db?`, `phase?` | Chaos on the matching directed links: forced loss, extra latency, jitter (extra latency drawn uniformly from 0 to the value, per frame) and interference (a noise rise at the receiver: the link's SNR falls by that many dB, so the channel model loses frames by itself, and the budget, the map and `move_node` show it). Replaces any earlier override on those links; all values 0 clears it. Same effect as a `links` rule. |
| `set_channel`  | `path_loss_exponent?`, `shadowing_sigma_db?`, `noise_figure_db?`, `base_latency_ms?`, `obstacles?`, `phase?`     | Changes the channel model for every later frame and budget, in the units and ranges of the scenario's `environment`. `shadowing_sigma_db` rescales each pair's seeded draw, so the pairs keep their sign and order. `obstacles` replaces every wall; a wall may carry an `id`, which the scenario's timeline uses to open and close a door (an id the timeline names that no wall has any more is logged as a warning and the change ignored). `noise_figure_db` is the Wi-Fi receiver's; it is refused on chip-level runs, whose radios use their own. |
| `set_radio`    | `node`, `channel?`, `tx_power_dbm?`, `antenna_gain_dbi?`, `phase?`                                              | Changes a station's radio as the medium models it. Wi-Fi: the channel the medium hears it on, its transmit power and antenna gain. LoRa, nRF24 and BLE: the antenna gain only, because the chip's channel and power are in its registers, where the firmware put them. The firmware is not told. Returns the new RSSI and SNR from that station. |
| `start_phase`  | `label`                                                                                                         | Starts a metrics phase now without changing anything, for something that happens by itself (firmware behaviour, a serial command).                                                                                                                                                                                                |
| `send_serial`  | `node`, `text` and `newline?`, or `data_base64`                                                                 | Types into a board's serial console (UART0). On an ESP32 the bytes go to QEMU's UART through the worker's `uart_send`, with its RX interrupt, as from a terminal; the answer shows in `get_serial`. A newline is added to `text` unless `newline: false`. At most 4096 bytes per call. Scripted boards have no console and refuse.       |
| `mqtt_publish` | `node`, `topic`, `payload`, `retain?`, `port?`                                                                  | Publishes through a scripted broker node (one whose firmware `serve`s `mqtt`) as if a client had: every client subscribed to a matching filter gets it, the scripted boards' subscriptions (serial line `mqtt rx <topic> <payload>`) and a phone on the [IP bridge](mobile-bridge.md) alike, and the broker logs `mqtt publish <topic> "<payload>" from mcp`. Returns `delivered_to`, the number of client sessions the broker wrote it to: it counts sessions, not frames that arrived, so a session behind a faulty link still counts and `get_serial` or `get_metrics` shows what got through. `retain: true` also keeps it for clients that subscribe later; an empty `payload` with `retain` clears the topic's. `port` picks the service when the node serves more than one MQTT port. A node that is not a scripted broker (an ESP32, a BLE or LoRa board, the bridge, a node with no `serve: mqtt`) refuses and says why. `payload` is UTF-8, at most 4096 bytes; the topic takes no `+` or `#`. |
| `send_payload` | `node`, `to`, `via`, `payload`, `topic?`, `port?`                                                                | Makes a scripted Wi-Fi or BLE board send one message now, over a path its `send` entries could use. `via: udp`: a datagram to the node `to` (port 5000 unless `port`; at most 1472 bytes). `via: espnow`: a frame to `to`, or to `broadcast` (at most 250 bytes); its ACK result shows in `get_serial` as `espnow tx ok\|fail to <peer>`. `via: mqtt`: a publish to the broker node `to` (`topic` required, `port` default 1883); the board opens its session first if its script had none, and waits up to 5 s for it. `via: gatt` (BLE boards): a notification from a peripheral, or a write from a central, on its connection to the node `to`; at most 20 bytes at the default MTU, and refused while the two are not connected. The payload goes out as given, without the `:<n>` a scheduled send adds. Scripted LoRa and nRF24 boards and ESP32 boards refuse: their sends are inside the driver or the firmware. To publish from the broker node itself, use `mqtt_publish`. |

Both tools act when the call arrives, like the others here, and are refused while the run is
`starting`. They are the way to make a simulated node emit an application message on demand, for
example to trigger an event in a live demo and check that a phone on the bridge receives it:

1. `run_scenario {"path": "<repo>/hertzbench/scenarios/examples/mqtt-clients-scripted.yaml"}`, then
   `get_status` until `running`.
2. `mqtt_publish {"node": "broker", "topic": "riego/cmd", "payload": "OPEN"}` answers
   `{"node": "broker", "topic": "riego/cmd", "bytes": 4, "retain": false, "delivered_to": 1, ...}`:
   `valve` is the one client subscribed to `riego/cmd`.
3. `get_serial {"node": "valve"}` ends with `mqtt rx riego/cmd OPEN`. A phone connected to the
   bridge's MQTT endpoint and subscribed to `riego/#` receives the same message.
4. Combine it with `inject_fault` on a node's links, publish again, and compare what the
   subscribers print in `get_serial` and what `get_metrics` counts as dropped.

Nodes cannot be added to or removed from a run in progress: the runner starts every board before
time zero. Change the scenario file and run it again.

### Reading a run

| Tool             | Arguments                                       | What it does                                                                                                                                                                                                                                                                                       |
| ---------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_serial`     | `node`, `since_ms?`, `tail?`                    | The node's serial lines, each with its engine time; the bridge's id gives the bridge's log. Returns the last `tail` lines (default 200, at most 2000). Pass the returned `next_since_ms` back as `since_ms` to read only new lines.                                                                  |
| `get_metrics`    | none                                            | Per-link metrics for the whole run and per phase. While the run plays, and after `stop`, they are computed from the event log so far and marked `partial: true`. Once the run has finished, this is the `metrics.json` document.                                                                    |
| `get_events`     | `since_seq?`, `types?`, `node?`, `limit?`       | The engine's event stream, oldest first: the records of `events.jsonl` (`tx`, `deliver`, `drop` with its reason, RSSI and SNR, `move`, `link-override`, `channel` (also a door opening or closing), `interference` (a source switched on or off), `radio`, `phase`, `serial`, `espnow-send`, `ble-link`, `warning`). `node` keeps the events a node sent, received, moved or printed. At most `limit` (default 500, at most 5000); pass `next_since_seq` back as `since_seq` to follow the stream. |
| `export_capture` | `kind` (`pcap`, `pcap-80211`, `btsnoop`), `node?`, `path?` | Writes a capture of the run as it stands, also mid-run and after `stop`, which writes no files of its own: `pcap` the whole air (Ethernet on Wi-Fi, LoRaTap, the nRF24 record, or BLE link-layer packets), `pcap-80211` the ESP-NOW frames as 802.11 (Wi-Fi runs), `btsnoop` one BLE node's HCI. Default file: `air-live.pcap`, `air-live-80211.pcap` or `hci-<node>-live.btsnoop` in the run's `out_dir`. |

### The view

| Tool             | Arguments | What it does                                                                                                                                                                                                                                                                                       |
| ---------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open_view`      | `port?`   | Serves the [view](view.md) of this server's runs on a loopback port (default: a free one) and returns its URL. It launches nothing: a person opens the URL. One view per server; with `--view-port`, or on a second call, it returns the URL already served.                                       |
| `get_view_state` | `since?`  | What the page draws, as data: the status, every directed link with distance, RSSI, SNR, rate, signal quality, loss over the last 2 s and any forced chaos, the walls, and the packet timeline after `since` (pass back `next_since`). Works on every PHY.                                           |

Errors you can fix yourself come back as tool results with `isError: true` and a plain message: a
bad argument, an invalid scenario, an unknown node, a link pattern that matches nothing, a board
that cannot start. A JSON-RPC error means a protocol mistake (unknown tool, unknown method) or a
bug in the server; a bug's stack trace is written to the server's stderr.

### What no tool does

No tool runs a command on the host, and none takes a program, an interpreter, a library path or an
environment variable as an argument: an agent that needs a shell has its own, and the server would
only widen what it can reach. The few things outside the simulation are fixed by the person who
starts the server: the workspace (`--workspace`), the QEMU library and Python interpreter
(`QEMU_ESP32_LIB`, `HERTZBENCH_PYTHON` in the server's environment). `open_view` only returns a URL;
it never starts a browser. `tests/mcp_drive_test.ts` checks every tool's schema for this.

### Editing a scenario

`edit_scenario`, `add_node` and `remove_node` work on the file as its author wrote it, before
`count:` expands a node into several. A node made by `count: 4` (`sensor-1` to `sensor-4`) has no
entry of its own: edit the group by its id, `sensor`, or lower its count. Every edit is parsed as a
scenario before anything is written; an invalid result is refused with the field that is wrong, and
the file stays as it was. The new text replaces the file in one step. It is written from the data,
so **comments and the original layout are lost**. The file must be inside the workspace; to change
an example, copy it in with `create_scenario` first.

```json
{
  "path": "lab.yaml",
  "set": {
    "seed": 9,
    "environment": { "preset": "urban", "shadowing_sigma_db": 0 },
    "links": [{ "from": "sensor-*", "to": "gw", "extra_jitter_ms": 3, "interference_db": 6 }]
  },
  "nodes": {
    "gw": { "position": [0, 5], "radios": [{ "phy": "wifi", "channel": 11, "tx_power_dbm": 8 }] },
    "old": null
  },
  "add": [{ "id": "probe", "board": "scripted", "position": [30, 0], "firmware": {} }]
}
```

An edit changes the next run, not the one in progress; for that, use the live tools above.

## Resources

| URI                                      | What                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `hertzbench://docs/fidelity.md`          | The fidelity table (F1, F2, F3, none), the channel model, and what is not modelled             |
| `hertzbench://docs/scenario-format.md`   | Every scenario field, for writing one with `create_scenario`                                   |
| `hertzbench://examples/<file>.yaml`      | Each example in `scenarios/examples/`, read from disk when asked, so the list follows the folder |

## A live session

The usual loop, with the example meant for it, `scenarios/examples/live-3-scripted.yaml`. In this
example three scripted boards ping each other for two minutes, and nothing is scheduled.

1. `run_scenario {"path": "<repo>/hertzbench/scenarios/examples/live-3-scripted.yaml"}`
2. `get_status` until `state` is `running`. The live tools refuse to act while the run is
   `starting` (boards booting, netdevs connecting).
3. `move_node {"node": "c", "position": [42, 0], "phase": "behind-wall"}`. The result shows the new
   RSSI of both links from `c`: about -86 dBm to `a` (from -58) and -83 dBm to `b` (from -48). The
   drop is distance plus the 12 dB wall.
4. `get_metrics`, and compare the phases `start` and `behind-wall`. `c->a` is now at the edge of
   what the slowest rate decodes, and it loses about half its frames with p95 latency near 9 ms.
   `c->b`, 3 dB stronger, still loses nothing.
5. `inject_fault {"link": "*->a", "extra_loss_pct": 50, "phase": "lossy-a"}`, then
   `get_serial {"node": "a"}` to see what still arrives.
6. `inject_fault {"link": "a->b", "interference_db": 80, "phase": "jammed"}`. Nothing is forced
   lost this time: the noise at `b` leaves no rate that decodes, so `get_metrics` shows `a->b`
   frames dropped as `retry_exhausted`, and `get_view_state` draws the link `bad`.
7. `export_capture {"kind": "pcap"}` writes what the air carried so far, for Wireshark.
8. `stop`.

`phase` is optional on `move_node` and `inject_fault`. It starts a metrics phase with that label at
the same instant, exactly like a timeline entry with `label`, so you can compare before and after
in `get_metrics`. A metric assertion in the scenario can only name a phase from the timeline,
because assertions are checked before the run.

### Watching it

Start the server with `--view-port 7480` (add it after `mcp` in the `claude mcp add` line), or let
the agent call `open_view`, and open the URL to watch the agent's run on a map with a packet
timeline. Dragging a node there calls `move_node`, so the agent sees the move in `get_status`.
`get_view_state` gives the agent the same picture as data. See [view.md](view.md).

## How a run works through the server

- **One run at a time.** `run_scenario` refuses while a run is `starting` or `running`. The last run
  stays readable (status, serial, metrics) until the next one starts.
- **Time.** Every time the tools report (`elapsed_ms`, `at_ms`, `t_ms`, phase bounds) is engine time
  in milliseconds since time zero: the moment every board's netdev connected, as in
  `metrics.json`. Serial lines from before time zero have negative times.
- **While `starting`** nothing of the run is readable yet: serial lines, problems and metrics show up
  from `running` on, boot lines included. If start-up fails, `get_status` carries the error, and
  each ESP32 board's own complaint is in `worker-<node>.stderr.log` in the run's `out_dir`.
- **Outputs.** By default each run writes to its own directory, `out/<scenario file name>/<run
  id>/`, inside the workspace. Its contents are the same as for `hertzbench run`: `metrics.json`,
  `air.pcap`, `events.jsonl` and `serial-<node>.log`, plus `efuse-<node>.bin` and
  `worker-<node>.stderr.log` for ESP32 boards. Files are written when the run finishes.
- **Firmware.** Each run compiles its sketches again, so an edited sketch is picked up by the next
  `run_scenario`, and so is a fixed compile error.
- **The run ends by itself** at the scenario's `duration`. Then the assertions are judged and
  `get_status` reports `finished`.

### Stopping

`stop` ends the run the way Ctrl-C ends `hertzbench run`:

- every board is stopped;
- **no output file is written**;
- the assertions are not judged.

What the run did up to the stop stays readable: `get_metrics` returns the partial metrics of that
moment, and `get_serial` the lines up to then.

Closing the server, by ending its stdin or with SIGINT or SIGTERM, also stops the run in progress
first, so no QEMU worker is left behind.

### Reproducibility

A move, a fault, a channel or radio change, a serial line, a published MQTT message or a payload
sent with a live tool happens at the moment the call arrives, on the wall clock. A run with live actions is therefore **not reproducible
from its seed alone**. To replay an experiment, write the moves and link rules into the scenario's
`timeline` (`move`, `link`, `label`) once you have found them; channel and radio changes go into
the scenario's `environment` and `radios` with `edit_scenario`; a message you sent becomes a `send`
entry of the board's script (`via: mqtt` with a `topic` for a publish).

## Running the ESP32 example

`scenarios/examples/udp-3-nodes.yaml` runs three ESP32 boards on real firmware. Through the MCP
server it is the same run as `hertzbench run`, with the same needs (the full list is in
[e2e-esp32.md](e2e-esp32.md)):

1. Python 3.11+ with `backend/requirements.txt` installed, and `libqemu-xtensa.so` plus its ROM
   files.
2. **The server's environment** must carry `QEMU_ESP32_LIB`. That means `-e` on `claude mcp add`,
   or `env` in `.mcp.json`. Exporting it in your own shell does not reach a server Claude Code
   starts. Set `HERTZBENCH_PYTHON` the same way if `python3` is not the right interpreter.
3. The ESP-IDF toolchain Velxio uses, to compile the sketch. Or set the nodes' `firmware:` to a
   prebuilt `.bin`.

```bash
claude mcp add hertzbench -e QEMU_ESP32_LIB=/path/to/libqemu-xtensa.so \
  -- hertzbench mcp --workspace /path/to/repo
```

Then, from the agent:

1. `list_boards`: `esp32` should say `available: true` and name the library. If it says `false`, the
   `detail` field says which path it tried.
2. `run_scenario {"path": "hertzbench/scenarios/examples/udp-3-nodes.yaml"}`.
3. `get_status` until `running`. This takes the sketch's compile time plus the boards' boot. A
   board that dies at start-up turns the state to `failed` within seconds, with each board's
   problem and the path of its `worker-<node>.stderr.log`.
4. `get_serial {"node": "b"}` should show `wifi up ip=192.168.4.12`, then `rx ping:<n>` lines.
5. Let it run to the end (90 s of engine time; `c` moves behind the wall at 40 s). `get_status`
   should then say `finished` and `passed: true`, and `get_metrics` gives the per-phase metrics.

**Status: not run.** The host this was built on has neither libqemu nor Docker. The MCP layer adds
nothing ESP32-specific: it calls the same runner as the CLI. So everything e2e-esp32.md marks
**[unverified]** applies here too, and its "First run" checks are the ones to do. Everything else is
tested with scripted boards through the real `hertzbench mcp` process (`tests/mcp_test.ts`).

## Protocol notes

- JSON-RPC 2.0, one message per line. stdout carries only protocol messages; progress lines and
  diagnostics go to stderr.
- Protocol versions `2025-11-25`, `2025-06-18`, `2025-03-26` and `2024-11-05`. The server answers
  with the client's version when it is one of these, and otherwise with the newest.
- Capabilities: `tools` and `resources`, without change notifications or subscriptions. No
  progress notifications and no cancellation. `run_scenario` returns at once, so no call takes long.
- Written by hand, not with the official SDK, which would bring an HTTP and OAuth stack into a
  stdio-only server (`mcp/protocol.ts`).
