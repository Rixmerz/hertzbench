// Runs one scenario: bring up the medium and the adapter, start the boards, play
// the timeline against the wall clock, then judge the assertions and write the
// outputs. Time zero is the moment every board's netdev has connected, so guest
// boot time counts toward `duration`.

import { QemuWifiL2Adapter } from "../adapters/qemu-wifi-l2/mod.ts";
import {
  computeMetrics,
  type EngineEvent,
  EventLog,
  Medium,
  type MetricsReport,
  PcapWriter,
  type Position,
  VirtualGateway,
  WallClock,
} from "../engine/mod.ts";
import { type AssertionResult, evaluateAssertions } from "./assertions.ts";
import { type BoardLauncher, type PeerInfo, type RunningBoard } from "./boards/board.ts";
import { esp32Launcher } from "./boards/qemu-esp32.ts";
import { scriptedLauncher } from "./boards/scripted.ts";
import { metricsDocument } from "./report.ts";
import {
  type BoardKind,
  GATEWAY_HOST,
  GATEWAY_MAC,
  type LinkRule,
  matchesPattern,
  type Scenario,
} from "./scenario.ts";

export interface OutputPaths {
  metrics: string;
  pcap: string;
  events: string;
}

export interface RunOptions {
  /** Directory for per-run files: eFuse images, worker logs, serial logs. */
  outDir: string;
  outputs: OutputPaths;
  launchers?: Partial<Record<BoardKind, BoardLauncher>>;
  /** How long to wait for every board's netdev to connect. Default 30 s. */
  startupTimeoutMs?: number;
  /** Progress lines for the person running the CLI. */
  progress?: (line: string) => void;
  /** Abort to end the run early: boards are stopped and the run rejects with RunInterrupted. */
  signal?: AbortSignal;
}

export class RunInterrupted extends Error {
  override name = "RunInterrupted";
}

export interface NodeReport {
  id: string;
  board: BoardKind;
  ip: string;
  mac: string;
  position: Position;
  channel: number;
  onMedium: boolean;
  clock: string;
  fidelity: string;
}

export interface RunResult {
  scenario: Scenario;
  nodes: NodeReport[];
  events: readonly EngineEvent[];
  metrics: MetricsReport;
  assertions: AssertionResult[];
  problems: string[];
  /** Every assertion passed and no board or adapter problem was reported. */
  passed: boolean;
  files: string[];
}

const DEFAULT_LAUNCHERS: Record<BoardKind, BoardLauncher> = {
  esp32: esp32Launcher,
  scripted: scriptedLauncher,
};

export function expandLinkRule(rule: LinkRule, mediumIds: readonly string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (const from of mediumIds) {
    if (!matchesPattern(rule.from, from)) continue;
    for (const to of mediumIds) {
      if (to !== from && matchesPattern(rule.to, to)) pairs.push([from, to]);
    }
  }
  return pairs;
}

async function ensureParentDir(path: string): Promise<void> {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (slash > 0) await Deno.mkdir(path.slice(0, slash), { recursive: true });
}

export async function runScenario(scenario: Scenario, options: RunOptions): Promise<RunResult> {
  const launchers = { ...DEFAULT_LAUNCHERS, ...options.launchers };
  const progress = options.progress ?? (() => {});
  await Deno.mkdir(options.outDir, { recursive: true });

  const clock = new WallClock();
  const log = new EventLog();
  const pcap = new PcapWriter(Date.now());
  const problems: string[] = [];
  const onMedium = scenario.nodes.filter((n) => !n.internetGateway);
  const mediumIds = onMedium.map((n) => n.id);

  const gatewayIp = `${scenario.subnetPrefix}.${GATEWAY_HOST}`;
  const gateway = new VirtualGateway({
    mac: GATEWAY_MAC,
    ip: gatewayIp,
    subnetMask: "255.255.255.0",
    leases: new Map(onMedium.map((n) => [n.mac, n.ip])),
  });
  const medium = new Medium({
    seed: scenario.seed,
    environment: scenario.environment,
    clock,
    log,
    gateway,
    retryLimit: scenario.retryLimit,
    tap: (tMs, _node, frame) => pcap.addFrame(tMs, frame),
  });
  const adapter = new QemuWifiL2Adapter(
    (id, frame) => medium.transmit(id, frame),
    (id, message) => problems.push(`${id}: ${message}`),
  );

  const ports = new Map<string, number>();
  for (const node of onMedium) {
    const attachment = adapter.listen(node.id);
    ports.set(node.id, attachment.port);
    medium.addNode(
      { id: node.id, mac: node.mac, position: node.position, radio: node.radio },
      attachment.sink,
    );
  }

  const peersOf = (id: string): PeerInfo[] =>
    onMedium.filter((n) => n.id !== id).map((n) => ({ id: n.id, ip: n.ip, mac: n.mac }));
  const running: RunningBoard[] = [];
  const clocks = new Map<string, string>();
  const stopAll = async () => {
    await Promise.allSettled(running.map((board) => board.stop()));
  };

  const interrupted = new Promise<never>((_, reject) => {
    const stop = () => reject(new RunInterrupted("run interrupted"));
    if (options.signal?.aborted) stop();
    else options.signal?.addEventListener("abort", stop, { once: true });
  });
  // Nobody may be awaiting `interrupted` when the run ends normally.
  interrupted.catch(() => {});

  try {
    progress(`starting ${scenario.nodes.length} board(s)`);
    // allSettled, not all: a board that fails must not leave its siblings
    // half-started and unowned while the first rejection unwinds the run.
    const started = await Promise.race([
      Promise.allSettled(scenario.nodes.map(async (node) => {
        const board = await launchers[node.board].start({
          node,
          netPort: ports.get(node.id) ?? null,
          peers: peersOf(node.id),
          gateway: { ip: gatewayIp, mac: GATEWAY_MAC, subnetMask: "255.255.255.0" },
          clock,
          outDir: options.outDir,
          onSerial: (text) => log.append({ type: "serial", t: clock.now(), node: node.id, text }),
          onProblem: (message) => problems.push(message),
        });
        running.push(board);
        clocks.set(node.id, board.clockDescription);
      })),
      interrupted,
    ]);
    for (const outcome of started) if (outcome.status === "rejected") throw outcome.reason;

    const startupTimeout = options.startupTimeoutMs ?? 30_000;
    await Promise.race([
      Promise.all(mediumIds.map((id) => adapter.waitConnected(id, startupTimeout))),
      interrupted,
    ]);
    progress(`all boards connected; running for ${scenario.durationMs} ms`);

    clock.restart();
    for (const rule of scenario.links) applyLinkRule(medium, rule, mediumIds);
    for (const event of scenario.timeline) {
      clock.schedule(event.atMs, () => {
        if (event.label !== null) medium.startPhase(event.label);
        for (const action of event.actions) {
          if (action.kind === "move") medium.moveNode(action.node, action.to);
          else applyLinkRule(medium, action.rule, mediumIds);
        }
      });
    }
    await Promise.race([
      new Promise<void>((resolve) => clock.schedule(scenario.durationMs, resolve)),
      interrupted,
    ]);
  } finally {
    await stopAll();
    await adapter.close();
    medium.close();
    clock.cancelAll();
  }

  const metrics = computeMetrics(log.events, scenario.durationMs);
  const assertions = evaluateAssertions(scenario.assertions, log.events, metrics.phases);
  const nodes = scenario.nodes.map((node): NodeReport => ({
    id: node.id,
    board: node.board,
    ip: node.ip,
    mac: node.mac,
    position: node.internetGateway ? node.position : medium.node(node.id).position,
    channel: node.radio.channel,
    onMedium: !node.internetGateway,
    clock: clocks.get(node.id) ?? "not started",
    fidelity: launchers[node.board].fidelity,
  }));
  const result: RunResult = {
    scenario,
    nodes,
    events: log.events,
    metrics,
    assertions,
    problems,
    passed: problems.length === 0 && assertions.every((a) => a.passed),
    files: [],
  };
  result.files = await writeOutputs(result, options, log, pcap);
  return result;
}

function applyLinkRule(medium: Medium, rule: LinkRule, mediumIds: readonly string[]): void {
  for (const [from, to] of expandLinkRule(rule, mediumIds)) {
    medium.setLinkOverride(from, to, {
      extraLossPct: rule.extraLossPct,
      extraLatencyMs: rule.extraLatencyMs,
    });
  }
}

async function writeOutputs(
  result: RunResult,
  options: RunOptions,
  log: EventLog,
  pcap: PcapWriter,
): Promise<string[]> {
  const files: string[] = [];
  const write = async (path: string, data: string | Uint8Array) => {
    await ensureParentDir(path);
    if (typeof data === "string") await Deno.writeTextFile(path, data);
    else await Deno.writeFile(path, data);
    files.push(path);
  };
  await write(options.outputs.metrics, JSON.stringify(metricsDocument(result), null, 2) + "\n");
  await write(options.outputs.pcap, pcap.toBytes());
  await write(options.outputs.events, log.toJsonl());
  const serialByNode = new Map<string, string[]>();
  for (const event of log.events) {
    if (event.type !== "serial") continue;
    const lines = serialByNode.get(event.node) ?? [];
    lines.push(`[${(event.t / 1000).toFixed(3)}s] ${event.text}`);
    serialByNode.set(event.node, lines);
  }
  for (const [node, lines] of serialByNode) {
    await write(`${options.outDir}/serial-${node}.log`, lines.join("\n") + "\n");
  }
  return files;
}
