// The browser side of `hertzbench view`: polls /api/view, draws the map, the
// link table and the packet timeline, and posts a move when a node is dragged
// or moved with the arrow keys. Every number comes from the server; this file
// only draws. Text from the run (node ids, labels, errors) goes in through
// textContent, never as markup.

const SVG = "http://www.w3.org/2000/svg";
const POLL_MS = 250;
const RETRY_MS = 1000;
const TIMELINE_SPAN_MS = 10_000;
// ponytail: past this many nodes the per-link labels would cover the map; the
// table and the tooltips still carry every value.
const MAX_LABELLED_NODES = 6;
/** A half link shorter than this has no room for its label. */
const MIN_LABELLED_HALF_PX = 50;
const KEY_STEP_M = 1;
const KEY_STEP_SHIFT_M = 5;

const MEANING = {
  signal: {
    good: "54 Mbit/s",
    fair: "24 to 48 Mbit/s",
    poor: "6 to 18 Mbit/s",
    bad: "under the 6 Mbit/s threshold: losses climb",
  },
  loss: {
    good: "under 1% lost",
    fair: "1 to 10% lost",
    poor: "10 to 50% lost",
    bad: "50% or more lost",
    idle: "no frames",
  },
};

const $ = (id) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`the page has no #${id}`);
  return element;
};

const ui = {
  run: $("run"),
  state: $("state"),
  clock: $("clock"),
  map: $("map"),
  mapBox: $("map-box"),
  notice: $("notice"),
  legend: $("legend"),
  window: $("window"),
  links: $("links"),
  linksEmpty: $("links-empty"),
  problems: $("problems"),
  fineprint: $("fineprint"),
  timeline: $("timeline"),
  timelineBox: $("timeline-box"),
};

const view = {
  runId: null,
  since: -1,
  latest: null,
  /** Timeline entries of the last TIMELINE_SPAN_MS. */
  entries: [],
  /** Grows to hold every position seen in this run, so the map does not jump. */
  bounds: null,
  mode: "signal",
  /** The node being dragged: { id, pointerId, position }. */
  drag: null,
  /** Moves posted and not yet seen in a view: id -> position. */
  pending: new Map(),
};

const layers = {
  grid: svg("g"),
  walls: svg("g"),
  links: svg("g"),
  nodes: svg("g"),
  // Above the nodes: a label near a node on a short link would be painted over by its ring.
  linkLabels: svg("g"),
};
for (const layer of Object.values(layers)) ui.map.append(layer);
/** One persistent element per node, so keyboard focus survives every redraw. */
const nodeElements = new Map();

function svg(tag, attributes = {}) {
  const element = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}

function html(tag, text = "", className = "") {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (className) element.className = className;
  return element;
}

const fixed = (value, digits = 1) => Number(value).toFixed(digits);

// ── Polling ─────────────────────────────────────────────────────────────────

async function poll() {
  let delay = POLL_MS;
  try {
    const response = await fetch(`/api/view?since=${view.since}`);
    if (!response.ok) throw new Error(`the server answered ${response.status}`);
    accept(await response.json());
  } catch (error) {
    setState("disconnected", `disconnected: ${error instanceof Error ? error.message : error}`);
    delay = RETRY_MS;
  }
  setTimeout(poll, delay);
}

function accept(data) {
  const runId = data.status.run_id ?? null;
  if (runId !== view.runId) {
    const fresh = view.since === -1;
    view.runId = runId;
    view.since = -1;
    view.entries = [];
    view.bounds = null;
    view.pending.clear();
    // This answer only holds what came after the old run's position.
    if (!fresh) return;
  }
  if (data.timeline) {
    view.entries.push(...data.timeline.entries);
    view.since = data.timeline.next_since;
  }
  const now = data.status.elapsed_ms;
  if (typeof now === "number") {
    view.entries = view.entries.filter((entry) => entry.t_ms >= now - TIMELINE_SPAN_MS);
  }
  for (const node of data.status.nodes ?? []) {
    const target = view.pending.get(node.id);
    if (target && target.x === node.position.x && target.y === node.position.y) {
      view.pending.delete(node.id);
    }
  }
  view.latest = data;
  render();
}

// ── Moves ───────────────────────────────────────────────────────────────────

function canMove(node) {
  return view.latest?.status.state === "running" && node.on_medium;
}

async function postMove(id, position) {
  const target = { x: Math.round(position.x * 10) / 10, y: Math.round(position.y * 10) / 10 };
  view.pending.set(id, target);
  render();
  try {
    const response = await fetch("/api/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node: id, position: [target.x, target.y] }),
    });
    if (!response.ok) {
      const body = await response.text();
      let message = body;
      try {
        message = JSON.parse(body).error ?? body;
      } catch {
        // Not JSON: the plain-text refusal is the message.
      }
      throw new Error(message);
    }
  } catch (error) {
    view.pending.delete(id);
    showNotice(`Could not move ${id}: ${error instanceof Error ? error.message : error}`);
    render();
  }
}

let noticeTimer = 0;
function showNotice(message) {
  ui.notice.textContent = message;
  ui.notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    ui.notice.hidden = true;
  }, 6000);
}

/** Where the map draws a node: the drag, then a move on its way, then the server. */
function shownPosition(node) {
  if (view.drag?.id === node.id) return view.drag.position;
  return view.pending.get(node.id) ?? node.position;
}

// ── Geometry ────────────────────────────────────────────────────────────────

function mapSize() {
  const box = ui.mapBox.getBoundingClientRect();
  return { width: Math.max(box.width, 100), height: Math.max(box.height, 100) };
}

function growBounds(nodes, obstacles) {
  if (view.drag) return; // the drag must not rescale the map under the pointer
  const xs = [];
  const ys = [];
  for (const node of nodes) {
    const p = shownPosition(node);
    xs.push(p.x);
    ys.push(p.y);
  }
  for (const wall of obstacles) {
    xs.push(wall.from[0], wall.to[0]);
    ys.push(wall.from[1], wall.to[1]);
  }
  if (xs.length === 0) return;
  const b = view.bounds ?? { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  view.bounds = {
    minX: Math.min(b.minX, ...xs),
    maxX: Math.max(b.maxX, ...xs),
    minY: Math.min(b.minY, ...ys),
    maxY: Math.max(b.maxY, ...ys),
  };
}

/** Metres to map pixels and back. y grows upwards, as on a floor plan. */
function projection() {
  const { width, height } = mapSize();
  const b = view.bounds ?? { minX: 0, maxX: 10, minY: 0, maxY: 10 };
  const spanX = Math.max(b.maxX - b.minX, 10);
  const spanY = Math.max(b.maxY - b.minY, 10);
  const pad = 48;
  const k = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return {
    width,
    height,
    k,
    to: (x, y) => [width / 2 + (x - cx) * k, height / 2 - (y - cy) * k],
    from: (sx, sy) => ({ x: cx + (sx - width / 2) / k, y: cy - (sy - height / 2) / k }),
  };
}

// ── Rendering ───────────────────────────────────────────────────────────────

function setState(state, text) {
  ui.state.dataset.state = state;
  if (ui.state.textContent !== text) ui.state.textContent = text;
}

function render() {
  const data = view.latest;
  if (!data) return;
  const { status } = data;
  if (status.state === "idle") {
    ui.run.textContent = "No run yet";
    setState("idle", "idle: waiting for a run");
  } else {
    ui.run.textContent = `${status.scenario} · run ${status.run_id}`;
    const verdict = status.state === "finished" ? (status.passed ? ", passed" : ", failed") : "";
    setState(status.state, `${status.state}${verdict}`);
  }
  ui.clock.textContent = typeof status.elapsed_ms === "number"
    ? `${fixed(status.elapsed_ms / 1000)} s of ${
      fixed(status.duration_ms / 1000, 0)
    } s · seed ${status.seed}`
    : "";
  ui.window.textContent = data.scene ? fixed(data.scene.window_ms / 1000, 0) : "2";

  const nodes = status.nodes ?? [];
  const scene = data.scene ?? { obstacles: [], links: [] };
  growBounds(nodes, scene.obstacles);
  const proj = projection();
  ui.map.setAttribute("viewBox", `0 0 ${proj.width} ${proj.height}`);
  drawGrid(proj);
  drawWalls(proj, scene.obstacles);
  drawLinks(proj, nodes, scene.links);
  drawNodes(proj, nodes, data.board_images ?? {});
  drawLegend();
  drawTable(scene.links);
  drawProblems(status);
  drawTimeline(scene.links, status.elapsed_ms);
  const scripted = nodes.some((node) => node.board === "scripted");
  ui.fineprint.textContent =
    "Latency is modelled by the channel model, not measured on a guest clock." +
    (scripted ? " Scripted boards are traffic generators, not firmware." : "");
}

function niceStep(metresPerPixel) {
  const target = metresPerPixel * 80;
  for (const step of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]) if (step >= target) return step;
  return 1000;
}

function drawGrid(proj) {
  layers.grid.replaceChildren();
  const step = niceStep(1 / proj.k);
  const topLeft = proj.from(0, 0);
  const bottomRight = proj.from(proj.width, proj.height);
  for (let x = Math.ceil(topLeft.x / step) * step; x <= bottomRight.x; x += step) {
    const [sx] = proj.to(x, 0);
    layers.grid.append(svg("line", { class: "grid-line", x1: sx, y1: 0, x2: sx, y2: proj.height }));
  }
  for (let y = Math.ceil(bottomRight.y / step) * step; y <= topLeft.y; y += step) {
    const [, sy] = proj.to(0, y);
    layers.grid.append(svg("line", { class: "grid-line", x1: 0, y1: sy, x2: proj.width, y2: sy }));
  }
  const length = step * proj.k;
  const y = proj.height - 16;
  layers.grid.append(svg("line", { class: "scale-bar", x1: 16, y1: y, x2: 16 + length, y2: y }));
  const label = svg("text", { class: "scale-label", x: 16, y: y - 6 });
  label.textContent = `${step} m`;
  layers.grid.append(label);
}

function drawWalls(proj, obstacles) {
  layers.walls.replaceChildren();
  for (const wall of obstacles) {
    const [x1, y1] = proj.to(wall.from[0], wall.from[1]);
    const [x2, y2] = proj.to(wall.to[0], wall.to[1]);
    const line = svg("line", { class: "wall", x1, y1, x2, y2 });
    const title = svg("title");
    title.textContent = `wall, ${wall.attenuation_db} dB`;
    line.append(title);
    const label = svg("text", { class: "wall-label", x: x1 + 8, y: y1 + 14 });
    label.textContent = `wall ${wall.attenuation_db} dB`;
    layers.walls.append(line, label);
  }
}

function linkQuality(link) {
  return view.mode === "signal" ? link.signal : link.loss;
}

function linkValue(link) {
  if (view.mode === "signal") return `${fixed(link.rssi_dbm, 0)} dBm`;
  return link.window_loss_pct === null ? "idle" : `${fixed(link.window_loss_pct, 0)}%`;
}

function linkSentence(link) {
  const loss = link.window_loss_pct === null
    ? "no frames in the window"
    : `${fixed(link.window_loss_pct)}% of ${link.window_frames} frames lost`;
  const forced = link.override
    ? `; forced ${link.override.extra_loss_pct}% loss, ${link.override.extra_latency_ms} ms latency`
    : "";
  return `${link.from} → ${link.to}: ${fixed(link.distance_m)} m, ${fixed(link.rssi_dbm)} dBm, ` +
    `SNR ${fixed(link.snr_db)} dB, ${link.rate_mbps} Mbit/s, ${loss}${forced}. ` +
    `Signal ${link.signal}, loss ${link.loss}.`;
}

function drawLinks(proj, nodes, links) {
  layers.links.replaceChildren();
  layers.linkLabels.replaceChildren();
  const byKey = new Map(links.map((link) => [`${link.from}>${link.to}`, link]));
  const where = new Map(nodes.map((node) => [node.id, shownPosition(node)]));
  const labelled = nodes.length <= MAX_LABELLED_NODES;
  for (const link of links) {
    // One line per pair: each half, from a node to the middle, is that node's sending side.
    const back = byKey.get(`${link.to}>${link.from}`);
    if (!back || link.from > link.to) continue;
    const a = where.get(link.from);
    const b = where.get(link.to);
    if (!a || !b) continue;
    const [ax, ay] = proj.to(a.x, a.y);
    const [bx, by] = proj.to(b.x, b.y);
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    for (const [half, x1, y1] of [[link, ax, ay], [back, bx, by]]) {
      const line = svg("line", { class: `link q-${linkQuality(half)}`, x1, y1, x2: mx, y2: my });
      const title = svg("title");
      title.textContent = linkSentence(half);
      line.append(title);
      layers.links.append(line);
      const halfLength = Math.hypot(mx - x1, my - y1);
      if (labelled && halfLength >= MIN_LABELLED_HALF_PX) {
        // Halfway along the sending half, pushed off the line to its left: the
        // two directions of a pair point opposite ways, so their labels land on
        // opposite sides instead of on top of each other.
        const nx = (my - y1) / halfLength;
        const ny = -(mx - x1) / halfLength;
        const label = svg("text", {
          class: "link-label",
          x: x1 + (mx - x1) * 0.5 + nx * 12,
          y: y1 + (my - y1) * 0.5 + ny * 12 + 4,
          "text-anchor": "middle",
        });
        label.textContent = `${linkValue(half)}${half.override ? " *" : ""}`;
        layers.linkLabels.append(label);
      }
    }
  }
}

function drawNodes(proj, nodes, boardImages) {
  const seen = new Set();
  for (const node of nodes) {
    seen.add(node.id);
    let element = nodeElements.get(node.id);
    if (!element) {
      element = createNode(node, boardImages[node.board]);
      nodeElements.set(node.id, element);
      layers.nodes.append(element);
    }
    const p = shownPosition(node);
    const [x, y] = proj.to(p.x, p.y);
    element.setAttribute("transform", `translate(${x} ${y})`);
    const movable = canMove(node);
    element.setAttribute("aria-disabled", String(!movable));
    element.classList.toggle("node-off", !node.on_medium);
    element.setAttribute(
      "aria-label",
      `${node.id}, ${node.board}, at x ${fixed(p.x)} m, y ${fixed(p.y)} m.` +
        (node.on_medium
          ? (movable ? " Arrow keys move it." : " Moves work while the run is running.")
          : " Not on the medium."),
    );
  }
  for (const [id, element] of nodeElements) {
    if (!seen.has(id)) {
      element.remove();
      nodeElements.delete(id);
    }
  }
}

function createNode(node, image) {
  const group = svg("g", { class: "node", tabindex: 0, role: "button" });
  group.append(svg("circle", { class: "node-ring", r: 22 }));
  if (image) {
    // Velxio's board drawing, about the board's real proportions.
    group.append(svg("image", { href: image, x: -9, y: -17, width: 18, height: 34 }));
  } else {
    group.append(svg("circle", { class: "node-dot", r: 9 }));
  }
  const label = svg("text", { class: "node-label", y: 34, "text-anchor": "middle" });
  label.textContent = node.id;
  group.append(label);

  group.addEventListener("pointerdown", (event) => {
    const current = view.latest?.status.nodes.find((n) => n.id === node.id);
    if (!current || !canMove(current) || event.button !== 0) return;
    event.preventDefault();
    group.setPointerCapture(event.pointerId);
    group.focus();
    view.drag = { id: node.id, pointerId: event.pointerId, position: shownPosition(current) };
    group.classList.add("dragging");
  });
  group.addEventListener("pointermove", (event) => {
    if (view.drag?.id !== node.id || view.drag.pointerId !== event.pointerId) return;
    const box = ui.map.getBoundingClientRect();
    view.drag.position = projection().from(event.clientX - box.left, event.clientY - box.top);
    render();
  });
  const finish = (event, commit) => {
    if (view.drag?.id !== node.id || view.drag.pointerId !== event.pointerId) return;
    const { position } = view.drag;
    view.drag = null;
    group.classList.remove("dragging");
    // One move per drag, not one per pointer event: every move is a logged event.
    if (commit) postMove(node.id, position);
    else render();
  };
  group.addEventListener("pointerup", (event) => finish(event, true));
  group.addEventListener("pointercancel", (event) => finish(event, false));
  group.addEventListener("keydown", (event) => {
    const delta = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, 1],
      ArrowDown: [0, -1],
    }[event.key];
    if (!delta) return;
    event.preventDefault();
    const current = view.latest?.status.nodes.find((n) => n.id === node.id);
    if (!current || !canMove(current)) {
      showNotice(
        `${node.id} can only be moved while the run is running and the node is on the medium.`,
      );
      return;
    }
    const step = event.shiftKey ? KEY_STEP_SHIFT_M : KEY_STEP_M;
    const from = shownPosition(current);
    postMove(node.id, { x: from.x + delta[0] * step, y: from.y + delta[1] * step });
  });
  return group;
}

function drawLegend() {
  const items = Object.entries(MEANING[view.mode]).map(([quality, meaning]) => {
    const item = html("li");
    item.append(html("span", "", `swatch q-${quality}`), html("span", `${quality}: ${meaning}`));
    return item;
  });
  ui.legend.replaceChildren(...items);
}

function drawTable(links) {
  ui.linksEmpty.hidden = links.length > 0;
  const rows = links.map((link) => {
    const row = html("tr");
    const name = html("td", `${link.from} → ${link.to}`);
    if (link.override) {
      name.append(
        html(
          "span",
          ` forced ${link.override.extra_loss_pct}% / ${link.override.extra_latency_ms} ms`,
          "override",
        ),
      );
    }
    const quality = linkQuality(link);
    const cell = html("td");
    cell.append(html("span", quality, `quality q-${quality}`));
    row.append(
      name,
      html("td", `${fixed(link.rssi_dbm)} dBm`, "num"),
      html("td", `${fixed(link.snr_db)} dB`, "num"),
      html("td", `${link.rate_mbps} Mb/s`, "num"),
      html("td", link.window_loss_pct === null ? "–" : `${fixed(link.window_loss_pct)}%`, "num"),
      cell,
    );
    row.title = linkSentence(link);
    return row;
  });
  ui.links.replaceChildren(...rows);
}

function drawProblems(status) {
  const problems = [...(status.problems ?? [])];
  if (status.error) problems.unshift(status.error);
  ui.problems.replaceChildren(...problems.map((problem) => html("li", problem)));
}

function cssValue(name, fallback = "#888") {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function drawTimeline(links, nowMs) {
  const rowHeight = 16;
  const axisHeight = 18;
  const labelWidth = 64;
  const rows = links.map((link) => `${link.from}>${link.to}`);
  const width = Math.max(ui.timelineBox.getBoundingClientRect().width, 200);
  const height = Math.max(rows.length, 1) * rowHeight + axisHeight;
  const ratio = globalThis.devicePixelRatio || 1;
  const canvas = /** @type {HTMLCanvasElement} */ (ui.timeline);
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const colors = {
    text: cssValue("--hzb-muted"),
    grid: "rgba(255, 255, 255, 0.06)",
    deliver: cssValue("--hzb-good"),
    drop: cssValue("--hzb-bad"),
    move: cssValue("--hzb-strong"),
    phase: cssValue("--hzb-accent"),
    override: cssValue("--hzb-poor"),
  };
  ctx.font = `11px ${cssValue("--font-mono", "monospace")}`;
  ctx.textBaseline = "middle";
  rows.forEach((row, index) => {
    ctx.fillStyle = colors.text;
    ctx.fillText(row.replace(">", "→"), 4, index * rowHeight + rowHeight / 2);
    ctx.fillStyle = colors.grid;
    ctx.fillRect(labelWidth, (index + 1) * rowHeight - 1, width - labelWidth, 1);
  });
  if (typeof nowMs !== "number") {
    canvas.setAttribute("aria-label", "Packet timeline: the run has not reached time zero yet.");
    return;
  }
  const start = nowMs - TIMELINE_SPAN_MS;
  const plot = width - labelWidth - 8;
  const x = (t) => labelWidth + ((t - start) / TIMELINE_SPAN_MS) * plot;
  const axisY = rows.length * rowHeight + axisHeight / 2;
  for (let second = Math.ceil(start / 1000); second * 1000 <= nowMs; second++) {
    if (second < 0) continue;
    const sx = x(second * 1000);
    ctx.fillStyle = colors.grid;
    ctx.fillRect(sx, 0, 1, rows.length * rowHeight);
    ctx.fillStyle = colors.text;
    ctx.fillText(`${second} s`, sx - 8, axisY);
  }
  const rowOf = new Map(rows.map((row, index) => [row, index]));
  let delivered = 0;
  let lost = 0;
  for (const entry of view.entries) {
    if (entry.t_ms < start) continue;
    const sx = x(entry.t_ms);
    if (entry.type === "deliver" || entry.type === "drop") {
      const row = rowOf.get(`${entry.from}>${entry.to}`);
      if (row === undefined) continue;
      const top = row * rowHeight;
      if (entry.type === "deliver") {
        delivered++;
        ctx.fillStyle = colors.deliver;
        ctx.fillRect(sx, top + 5, 1.5, rowHeight - 10);
      } else {
        lost++;
        ctx.fillStyle = colors.drop;
        ctx.fillRect(sx, top + 1, 2, rowHeight - 3);
      }
      continue;
    }
    const color = entry.type === "move"
      ? colors.move
      : entry.type === "phase"
      ? colors.phase
      : colors.override;
    const label = entry.type === "move"
      ? `move ${entry.node}`
      : entry.type === "phase"
      ? entry.label
      : `${entry.from}→${entry.to} ${entry.extra_loss_pct}%`;
    ctx.fillStyle = color;
    ctx.fillRect(sx, 0, 1.5, rows.length * rowHeight);
    ctx.fillText(label, sx + 4, axisY);
  }
  canvas.setAttribute(
    "aria-label",
    `Packet timeline, the last ${
      TIMELINE_SPAN_MS / 1000
    } s: ${delivered} frames delivered, ${lost} lost.`,
  );
}

for (const input of document.querySelectorAll('input[name="mode"]')) {
  input.addEventListener("change", () => {
    view.mode = /** @type {HTMLInputElement} */ (input).value === "loss" ? "loss" : "signal";
    render();
  });
}
new ResizeObserver(() => render()).observe(ui.mapBox);
poll();
