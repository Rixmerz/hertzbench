# Scenario format

A scenario is one YAML file. `hertzbench validate` checks it; every error names the field (`nodes[1].position: expected [x, y] or [x, y, z]`). Unknown fields are errors, not ignored. Durations need a unit: `500ms`, `60s`, `1.5s`, `2m`. A bare number is refused.

Examples: [`udp-3-nodes.yaml`](../scenarios/examples/udp-3-nodes.yaml) (ESP32) and [`udp-3-scripted.yaml`](../scenarios/examples/udp-3-scripted.yaml) (scripted boards, no QEMU).

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
network:
  subnet: 192.168.4.0/24     # only a /24; the gateway is .1, boards start at .11
nodes: [...]                 # 2 to 10 boards
links: [...]                 # per-link overrides
timeline: [...]
assertions: [...]
outputs: { metrics: ./out/metrics.json, pcap: ./out/air.pcap, events: ./out/events.jsonl }
```

## `nodes`

```yaml
- id: sensor                 # letters, digits, "_", "." and "-"
  count: 4                   # optional; expands to sensor-1 .. sensor-4 and needs a grid position
  board: esp32               # esp32 | esp32-devkit-v1 (same board) | scripted
  firmware: ./fw/udp-node    # esp32: a sketch directory, or a .bin flash image. Relative to the scenario file
  position: [0, 0]           # metres: [x, y] or [x, y, z]. Walls ignore z
  # position: { grid: { origin: [10, 0], step: [8, 0] } }    # for count > 1
  radios: [{ phy: wifi, channel: 5, tx_power_dbm: 15, antenna_gain_dbi: 0 }]   # exactly one in Phase 1
  ip: 192.168.4.20           # optional; default .11, .12, ... in node order
  internet_gateway: true     # optional; see below
```

- Only the classic ESP32 does Wi-Fi networking in Phase 1. `esp32-c3` and `esp32-s3` are refused with the reason.
- `channel` is the channel the node's radio uses in the model. Velxio's compile step forces channel 5 on the firmware, so use 5 for ESP32 sketches built through it.
- `internet_gateway: true` marks the one ESP32 that keeps SLIRP. It is **off the medium**: it cannot exchange frames with the other boards. At most one. See [fidelity.md](fidelity.md).
- A `scripted` board takes `firmware: { send: [...] }`. It is a traffic generator for hosts without libqemu, not firmware:

  ```yaml
  send:
    - { to: b, every: 50ms, count: 100, payload: ping, port: 5000, start: 0ms }
  ```

  It does DHCP at start-up, then sends `<payload>:<n>` over UDP to the named node, answers any datagram that starts with `ping` with `pong<same suffix>`, and logs `rx <text> from <node>` on its serial line.

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
```

Needs at least a `move`, a `link` or a `label`. Events past `duration` are an error. Metrics are reported for the whole run and per phase; the first phase is called `start`.

## `assertions`

```yaml
- serial: { node: a, contains: "wifi up", within: 30s }     # `within` optional
- metric:
    link: "c->a"                  # from->to, either side may use *
    phase: behind-wall            # optional; `start` or a timeline label. Default: whole run
    kind: udp                     # optional frame kind: arp dhcp udp tcp icmp ipv4 espnow-pseudo-ethernet other
    loss_pct: { gt: 20 }          # fields below, comparisons lt lte gt gte eq
    latency_p95_ms: { gt: 4 }
```

Metric fields: `sent`, `delivered`, `loss_pct`, `latency_p50_ms`, `latency_p95_ms`, `latency_p99_ms`, `latency_mean_ms`, `rssi_dbm`, `snr_db`, `mean_attempts`. `sent` counts frames that reached an outcome (delivered or dropped). A link pattern must match at least one link that carried frames, and **every** matching link must satisfy every comparison. A latency check on a link that delivered nothing fails.

## `outputs`

Paths are relative to the scenario file. Defaults are `metrics.json`, `air.pcap` and `events.jsonl` in `<scenario dir>/out`. `--out DIR` on the command line overrides all of them. Per-board files (`serial-<node>.log`, `efuse-<node>.bin`, `worker-<node>.stderr.log`) go in the output directory.

## `metrics.json`

`schema: 1`. Top level: `scenario`, `seed`, `duration_ms`, `latency` (`"modelled"`), `fidelity`, `nodes`, `links` (whole run), `phases` (each with `label`, `from_ms`, `to_ms`, `links`), `warnings`, `problems`, `assertions`, `passed`. A link holds `from`, `to`, `sent`, `delivered`, `dropped` (by reason: `retry_exhausted`, `extra_loss`, `channel_mismatch`, `no_peer`), `loss_pct`, `latency_ms` (`p50`, `p95`, `p99`, `mean`, `max`, or `null`), `rssi_dbm`, `snr_db`, `mean_attempts`, `bytes_delivered`.

## Exit status

`0` the run passed. `1` an assertion failed, or a board or the adapter reported a problem. `2` the scenario is invalid, a firmware path is missing, or the host cannot run it (for example, no libqemu). `130` interrupted with Ctrl-C or SIGTERM: every board is stopped and no results are written.
