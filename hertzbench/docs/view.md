# The view

`hertzbench view` runs a scenario and draws it live in the browser:

- a **2D map** of the nodes at their positions in metres, with the walls of the scenario, a door that stands open (a named wall at 0 dB) drawn dashed, and the interference sources as rings, filled while they are on;
- a **line per pair of nodes**, each half colored by the sending side's **signal** (RSSI and the
  rate it allows) or by its **loss** over the last 2 s;
- **drag a node** to move it while the run plays, or focus it and use the arrow keys (1 m a press,
  5 m with Shift);
- a **packet timeline** of the last 10 s: one row per directed link, a mark per frame delivered or
  lost, and a vertical mark for every move, phase and forced loss or latency;
- a link table with RSSI, SNR, rate, loss and any override in force, and the run's problems.

It is optional. Everything it shows is also in `metrics.json`, `events.jsonl` and the MCP tools,
and nothing in the engine depends on it.

## Run it

Needs Deno 2.x and a browser. No QEMU for scripted boards:

```bash
cd hertzbench
deno task hertzbench view scenarios/examples/live-3-scripted.yaml --out /tmp/hzb-view
```

Open the address printed on stderr (`http://127.0.0.1:7480/` by default). The run is two minutes
of three scripted boards pinging each other ten times a second. Drag `c` to the right of the wall
at x = 30 m, to about [42, 0]: in signal mode its links turn red at once, and in loss mode its
links to `a` turn orange (about a third of the frames lost) as the 2 s window fills, while the
shorter links to `b` still get through.

```
hertzbench view <scenario.yaml> [--port N] [--out DIR] [--seed N]
```

- `--port N` picks the loopback port (default 7480; 0 picks a free one).
- `--out DIR` is where the run writes `metrics.json`, `air.pcap` and `events.jsonl`, as with
  `hertzbench run`. Without it they go to `out/<scenario>/<run id>/` in the current directory.
- When the run ends, the report is printed, the output files are written and the page keeps showing
  the finished run until Ctrl-C. Ctrl-C during the run stops every board first and, as with
  `hertzbench run`, writes **no** output file and judges no assertion.
- Exit status 2 for an invalid scenario or a port in use, 0 otherwise. The view never fails on an
  assertion: use `hertzbench run` in CI.

## With an AI agent

The MCP server can draw the agent's run too:

```bash
claude mcp add hertzbench -- hertzbench mcp --workspace /path/to/project --view-port 7480
```

Open `http://127.0.0.1:7480/` and watch what the agent starts. A drag on the page goes through the
same `move_node` tool the agent calls, so the agent sees it in `get_status` and in the move events,
and the page sees the agent's moves and faults. The page shows "idle" until the agent starts a run,
and follows each new run.

## With real firmware (ESP32)

Nothing changes in the view: the boards in the scenario decide what runs. With libqemu installed
and `QEMU_ESP32_LIB` set, as in [e2e-esp32.md](e2e-esp32.md):

```bash
QEMU_ESP32_LIB=/path/to/libqemu-xtensa.so \
  deno task hertzbench view scenarios/examples/udp-3-nodes.yaml --out /tmp/hzb-view
```

ESP32 nodes are drawn with Velxio's ESP32 DevKit drawing. On real firmware (2026-10-24, Linux
x86_64, the libqemu of [e2e-esp32.md](e2e-esp32.md)) `udp-3-nodes.yaml`, `espnow-mesh-5-nodes.yaml`,
`lora-gateway-6-nodes.yaml` and `ble-sensors-3-nodes.yaml` ran in the view and passed their
assertions, with the map, the link table and the timeline drawn; the screenshots on the
[landing page](https://rixmerz.github.io/hertzbench/) come from those runs. Dragging a node was tested
with scripted boards only. A scripted board is a traffic generator, not firmware; the page says so
under the link table.

## What the colors mean

Both color scales come from the channel model, not from thresholds made up for the picture
(`view/scene.ts`):

| Color | Signal mode (from SNR and the Wi-Fi rate table) | Loss mode (last 2 s of engine time) |
| ----- | ----------------------------------------------- | ----------------------------------- |
| good  | SNR ≥ 26 dB: 54 Mbit/s                          | under 1% of frames lost             |
| fair  | SNR ≥ 17 dB: 24 to 48 Mbit/s                    | 1 to 10%                            |
| poor  | SNR ≥ 9 dB: 6 to 18 Mbit/s                      | 10 to 50%                           |
| bad   | below 9 dB: loss climbs to certain within ~4 dB | 50% or more                         |
| idle  | (not used)                                      | no frame on that link in the window |

Signal follows the node's position at once. Loss counts frames with an outcome, so it trails a move
by up to the 2 s window. A link with a forced loss or latency (`inject_fault`, or the scenario's
`links:` and timed rules) is marked with `*` on the map and "forced" in the table.

On LoRa, nRF24 and BLE runs there are no link lines and no link table: those PHYs share the
chip-level air, which reports no live link budget, and the page says so. The nodes, the walls, the
drag and the timeline work as on Wi-Fi; the timeline gets one row per pair that sent a packet.
Coloring those links needs a live budget on the air medium first.

Latency is modelled by the channel model, not measured on a guest clock (see
[fidelity.md](fidelity.md)).

## How it works

```
browser ── GET /api/view?since=N (every 250 ms) ──► view server ──► Session (same as MCP)
        ── POST /api/move {node, position} ───────►             ──► MCP move_node tool
```

- `view/server.ts` serves the page and two endpoints over loopback HTTP. It reads what the MCP tools
  read and writes only through the MCP `move_node` tool.
- `view/scene.ts` turns the run's link budgets and event log into what is drawn: the quality
  buckets, the loss window and the timeline entries after sequence number `since` (at most 4000 per
  answer; a client that fell further behind gets the newest).
- `view/static/` is the page: plain HTML, CSS and one ES module, no build step and no dependency.
  The map is SVG, the timeline a canvas. Text from the run goes in as text, never as markup.
- One drag is one move, posted on release, because every move is an event in the log.

### Security

The server listens on 127.0.0.1 only. Any page open in the same browser can still send requests to
a loopback port, so:

- every request must name this server in its `Host` header, which stops DNS rebinding (CWE-350);
- a move must be `application/json` from no origin or this one, which stops cross-site requests
  (CWE-352): a cross-site JSON POST needs a CORS preflight, and the server never answers one;
- the page runs under a strict Content Security Policy: only its own scripts, styles, fonts and
  images.

A move can only reach a node of the current run, and only while it runs, with the same validation
as `move_node`.

## What comes from Velxio

The view reuses Velxio's frontend **files as they are**, served read-only from `frontend/` at
request time, with nothing built and nothing changed:

- the design tokens in `frontend/src/tokens/*.css` (colors, spacing, type, radius, elevation,
  motion), so the page matches the Velxio look;
- the fonts they name, `frontend/public/fonts/Inter.var.woff2` and `JetBrainsMono.var.woff2`;
- the board drawing `frontend/public/boards/esp32-devkit-v1.svg`.

It does **not** reuse Velxio's React canvas, stores or components. They are built for one circuit
with wires between pins, and mounting them would need the Vite build, its store wiring and a patch
to the app's routes, which is the merge cost [PLAN.md](PLAN.md) §9 asks to avoid. So Phase 7 adds
**no Velxio patch**. If upstream moves or renames one of those files, that request answers 404 and the
page falls back to its own colors and the system font, and an ESP32 node is drawn without its board
picture (its ring and name stay, and it can still be dragged); nothing else fails. They are listed in
[upstream-sync.md](upstream-sync.md).

## Tests

- `tests/view_test.ts`: the quality buckets, the loss window, the timeline, and the real
  `hertzbench view` and `hertzbench mcp --view-port` processes over HTTP, including refused hosts,
  origins and content types, and a LoRa run with no link budgets.
- `tests/view_browser_test.ts`: headless Chromium over the DevTools protocol drags a node with real
  mouse events and checks that the engine moved it once, to where it was dropped. It is skipped when
  no Chromium is found; set `HERTZBENCH_CHROMIUM` to point at one.
- `tests/view_esp32_browser_test.ts`: the same drag on three real ESP32 boards, away behind the wall
  and back, checking the page's link table and the medium's deliveries. Skipped without a Chromium
  or without `QEMU_ESP32_LIB`; the first run compiles the sketch.
