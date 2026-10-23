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

- **Paths you give** (`path`, `out`) are relative to the workspace. An absolute path also works for
  reading, so `run_scenario` can run the examples where they are, as the CLI can.
- **Every file the server writes stays inside the workspace**: `create_scenario` files and every run
  output. A path that leaves the workspace is refused, including through `..` and through a symlink.
  A run always writes to its own `out` directory. The scenario's `outputs:` paths are ignored there,
  as `hertzbench run --out` ignores them.
- **Firmware paths inside a scenario** resolve from the scenario file's directory, as with the CLI.
  For scenario text given to `validate_scenario` as `yaml`, they resolve from the workspace.

## Tools

| Tool                | Arguments                                                                   | What it does                                                                                                                                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_boards`       | none                                                                        | Board kinds, the names a scenario may give them, their fidelity level, and whether this host can run them (`esp32` needs libqemu). Also lists the boards that are refused, and why.                                                                                  |
| `create_scenario`   | `path`, `yaml`, `overwrite?`                                                | Validates the text and writes it to `path` (`.yaml` or `.yml`). Invalid text is refused and nothing is written. An existing file is kept unless `overwrite: true`. Missing firmware is listed in `missing_firmware` but not refused, so you can write the scenario first. |
| `validate_scenario` | `path` or `yaml`                                                            | Parses and checks a scenario, and checks that its firmware exists. Returns the expanded nodes with their addresses and positions, or the first error with its field path (`nodes[0].board: ...`).                                                                    |
| `run_scenario`      | `path`, `seed?`, `out?`                                                     | Starts the run in the background and returns at once with state `starting`. Errors known before boot come back here: an invalid scenario, missing firmware, no libqemu for an ESP32 node, a run already in progress.                                                  |
| `get_status`        | none                                                                        | `idle` before the first run. Then `starting`, `running`, `finished` (with `passed`, the assertions and the files), `failed` (with the error) or `stopped`. Also elapsed time, live node positions, board problems and, with a mobile bridge, `bridge`: its host endpoints (or mirrored GATT table) and its live position.                                                 |
| `get_serial`        | `node`, `since_ms?`, `tail?`                                                | The node's serial lines, each with its engine time; the bridge's id gives the bridge's log. Returns the last `tail` lines (default 200, at most 2000). Pass the returned `next_since_ms` back as `since_ms` to read only new lines.                                                                           |
| `get_metrics`       | none                                                                        | Per-link metrics for the whole run and per phase. While the run plays, and after `stop`, they are computed from the event log so far and marked `partial: true`. Once the run has finished, this is the `metrics.json` document.                                     |
| `move_node`         | `node`, `position` (`[x, y]` or `[x, y, z]`), `phase?`                      | Moves a node now, or the mobile bridge's station (its id, `phone` by default). Every later frame uses the new position. Returns the new distance, RSSI and SNR from that node to each of the others.                                                                                                                             |
| `inject_fault`      | `link` (`from->to`, `*` allowed), `extra_loss_pct?`, `extra_latency_ms?`, `phase?` | Forces loss and/or extra latency on the matching directed links, now. It replaces any earlier override on those links; setting both values to 0 clears it. Same effect as a `links` rule in the scenario.                                                     |
| `stop`              | none                                                                        | Stops the run and its boards. See [Stopping](#stopping).                                                                                                                                                                                                             |

Errors you can fix yourself come back as tool results with `isError: true` and a plain message: a
bad argument, an invalid scenario, an unknown node, a link pattern that matches nothing, a board
that cannot start. A JSON-RPC error means a protocol mistake (unknown tool, unknown method) or a
bug in the server; a bug's stack trace is written to the server's stderr.

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
6. `stop`.

`phase` is optional on `move_node` and `inject_fault`. It starts a metrics phase with that label at
the same instant, exactly like a timeline entry with `label`, so you can compare before and after
in `get_metrics`. A metric assertion in the scenario can only name a phase from the timeline,
because assertions are checked before the run.

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

A move or a fault made with a live tool happens at the moment the call arrives, on the wall clock. A
run with live actions is therefore **not reproducible from its seed alone**. To replay an experiment,
write the same actions into the scenario's `timeline` (`move`, `link`, `label`) once you have found
them.

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
