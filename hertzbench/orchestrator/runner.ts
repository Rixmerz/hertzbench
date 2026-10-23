// Runs one scenario: bring up the medium and the adapter, start the boards, play
// the timeline against the wall clock, then judge the assertions and write the
// outputs. Time zero is the moment every board's netdev has connected, so guest
// boot time counts toward `duration`.

import { QemuWifiL2Adapter } from "../adapters/qemu-wifi-l2/mod.ts";
import {
  type Clock,
  computeMetrics,
  type EngineEvent,
  EventLog,
  Medium,
  type MediumControl,
  type MetricsReport,
  PacedClock,
  PcapWriter,
  type Position,
  VirtualGateway,
  WallClock,
} from "../engine/mod.ts";
import { createAirNetwork, declaredMismatches, type NetworkSetup } from "./air-network.ts";
import { type AssertionResult, evaluateAssertions } from "./assertions.ts";
import {
  BoardError,
  type BoardLauncher,
  type PeerInfo,
  type RunningBoard,
} from "./boards/board.ts";
import { esp32Launcher } from "./boards/qemu-esp32.ts";
import { scriptedLauncher } from "./boards/scripted.ts";
import { describeRadio } from "./radios.ts";
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
  /** Wi-Fi or nRF24 channel; null for LoRa, which `radio` describes by frequency. */
  channel: number | null;
  /** The declared radio in one line, e.g. "lora 868.1 MHz SF7 BW125 CR4/5". */
  radio: string;
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

  // Chip radios have sub-millisecond protocol timing (an nRF24 ACK 130 us after
  // its packet) that plain timers cannot keep in order; Wi-Fi does not.
  const clock = scenario.phy === "wifi" ? new WallClock() : new PacedClock();
  const log = new EventLog();
  const problems: string[] = [];
  const onMedium = scenario.nodes.filter((n) => !n.internetGateway);
  const mediumIds = onMedium.map((n) => n.id);
  const gatewayIp = `${scenario.subnetPrefix}.${GATEWAY_HOST}`;

  const interrupted = new Promise<never>((_, reject) => {
    const stop = () => reject(new RunInterrupted("run interrupted"));
    if (options.signal?.aborted) stop();
    else options.signal?.addEventListener("abort", stop, { once: true });
  });
  // A board that reports a problem before the run is underway (it crashed, or
  // its worker exited) will never connect: end startup at once instead of
  // waiting out the connect timeout.
  let startupOver = false;
  let failStartup: (error: BoardError) => void = () => {};
  const startupFailed = new Promise<never>((_, reject) => {
    failStartup = reject;
  });
  // Nobody awaits these when the run ends normally.
  interrupted.catch(() => {});
  startupFailed.catch(() => {});
  const reportProblem = (message: string) => {
    problems.push(message);
    if (!startupOver) failStartup(new BoardError(startupMessage(problems)));
  };
  const networkContext = {
    clock,
    log,
    epochMs: Date.now(),
    onProblem: (id: string, message: string) => reportProblem(`${id}: ${message}`),
  };
  const network = scenario.phy === "wifi"
    ? wifiNetwork(scenario, gatewayIp, networkContext)
    : createAirNetwork(scenario, networkContext);
  const { medium, ports } = network;

  const indexOf = (id: string) => scenario.nodes.findIndex((n) => n.id === id) + 1;
  const peersOf = (id: string): PeerInfo[] =>
    onMedium.filter((n) => n.id !== id).map((n) => ({
      id: n.id,
      index: indexOf(n.id),
      ip: n.ip,
      mac: n.mac,
    }));
  const running: RunningBoard[] = [];
  const clocks = new Map<string, string>();
  const stopAll = async () => {
    await Promise.allSettled(running.map((board) => board.stop()));
  };

  // Logged times are raw clock readings, so the log never steps backwards.
  // Time zero of the scenario is the instant every netdev has connected;
  // everything the scenario measures (timeline, duration, phases, `within`)
  // is relative to it, and the log is shifted by it at the end.
  let zeroMs = 0;
  // Boards still starting when the run is cut short must be waited for, or they
  // would come up after the cleanup below and nobody would stop them.
  let startAll: Promise<PromiseSettledResult<void>[]> = Promise.resolve([]);

  try {
    progress(`starting ${scenario.nodes.length} board(s)`);
    // allSettled, not all: a board that fails must not leave its siblings
    // half-started and unowned while the first rejection unwinds the run.
    startAll = Promise.allSettled(scenario.nodes.map(async (node) => {
      let board: RunningBoard;
      try {
        board = await launchers[node.board].start({
          node,
          nodeIndex: indexOf(node.id),
          netPort: ports.get(node.id) ?? null,
          peers: peersOf(node.id),
          gateway: { ip: gatewayIp, mac: GATEWAY_MAC, subnetMask: "255.255.255.0" },
          clock,
          outDir: options.outDir,
          onSerial: (text) => log.append({ type: "serial", t: clock.now(), node: node.id, text }),
          onProblem: reportProblem,
        });
      } catch (error) {
        if (error instanceof BoardError) throw error;
        throw new BoardError(
          `${node.id}: could not start: ${error instanceof Error ? error.message : error}`,
        );
      }
      running.push(board);
      clocks.set(node.id, board.clockDescription);
    }));
    const started = await Promise.race([startAll, interrupted, startupFailed]);
    for (const outcome of started) if (outcome.status === "rejected") throw outcome.reason;

    const startupTimeout = options.startupTimeoutMs ?? 30_000;
    try {
      await Promise.race([
        Promise.all(mediumIds.map((id) => network.waitConnected(id, startupTimeout))),
        interrupted,
        startupFailed,
      ]);
    } catch (error) {
      if (error instanceof RunInterrupted || error instanceof BoardError) throw error;
      throw new BoardError(
        startupMessage(problems, error instanceof Error ? error.message : String(error)),
      );
    }
    startupOver = true;
    zeroMs = clock.now();
    progress(`all boards connected; running for ${scenario.durationMs} ms`);

    for (const rule of scenario.links) applyLinkRule(medium, rule, mediumIds);
    for (const event of scenario.timeline) {
      clock.schedule(zeroMs + event.atMs, () => {
        if (event.label !== null) medium.startPhase(event.label);
        for (const action of event.actions) {
          if (action.kind === "move") medium.moveNode(action.node, action.to);
          else applyLinkRule(medium, action.rule, mediumIds);
        }
      });
    }
    await Promise.race([
      new Promise<void>((resolve) => clock.schedule(zeroMs + scenario.durationMs, resolve)),
      interrupted,
    ]);
  } finally {
    startupOver = true;
    await startAll;
    await stopAll();
    await network.close();
    medium.close();
    clock.cancelAll();
  }

  const events = log.events.map((event) => ({ ...event, t: event.t - zeroMs }));
  const metrics = computeMetrics(events, scenario.durationMs);
  metrics.warnings.push(...network.warnings, ...declaredMismatches(scenario, events));
  const assertions = evaluateAssertions(scenario.assertions, events, metrics.phases);
  const nodes = scenario.nodes.map((node): NodeReport => ({
    id: node.id,
    board: node.board,
    ip: node.ip,
    mac: node.mac,
    position: node.internetGateway ? node.position : medium.node(node.id).position,
    channel: node.radio.phy === "lora" ? null : node.radio.channel,
    radio: describeRadio(node.radio),
    onMedium: !node.internetGateway,
    clock: clocks.get(node.id) ?? "not started",
    fidelity: launchers[node.board].fidelity,
  }));
  const result: RunResult = {
    scenario,
    nodes,
    events,
    metrics,
    assertions,
    problems,
    passed: problems.length === 0 && assertions.every((a) => a.passed),
    files: [],
  };
  result.files = await writeOutputs(result, options, network.pcap);
  return result;
}

/** Phase 1's network: the Wi-Fi medium with its virtual gateway, reached over qemu-wifi-l2. */
function wifiNetwork(
  scenario: Scenario,
  gatewayIp: string,
  ctx: {
    clock: Clock;
    log: EventLog;
    epochMs: number;
    onProblem(nodeId: string, message: string): void;
  },
): NetworkSetup {
  const onMedium = scenario.nodes.filter((n) => !n.internetGateway);
  const pcap = new PcapWriter(ctx.epochMs);
  const gateway = new VirtualGateway({
    mac: GATEWAY_MAC,
    ip: gatewayIp,
    subnetMask: "255.255.255.0",
    leases: new Map(onMedium.map((n) => [n.mac, n.ip])),
  });
  const medium = new Medium({
    seed: scenario.seed,
    environment: scenario.environment,
    clock: ctx.clock,
    log: ctx.log,
    gateway,
    retryLimit: scenario.retryLimit,
    tap: (tMs, _node, frame) => pcap.addFrame(tMs, frame),
  });
  const adapter = new QemuWifiL2Adapter((id, frame) => medium.transmit(id, frame), ctx.onProblem);
  const ports = new Map<string, number>();
  for (const node of onMedium) {
    if (node.radio.phy !== "wifi") throw new Error(`${node.id}: not a Wi-Fi node`);
    const attachment = adapter.listen(node.id);
    ports.set(node.id, attachment.port);
    medium.addNode(
      { id: node.id, mac: node.mac, position: node.position, radio: node.radio },
      attachment.sink,
    );
  }
  return {
    medium,
    ports,
    waitConnected: (id, timeoutMs) => adapter.waitConnected(id, timeoutMs),
    close: () => adapter.close(),
    pcap,
    warnings: [],
  };
}

/** What went wrong before the run began, for the person who has to fix it. */
function startupMessage(problems: readonly string[], cause?: string): string {
  const lines = [cause ?? "a board failed during start-up", ...problems.map((p) => `  ${p}`)];
  return `${lines.join("\n")}\n  (worker logs are in the output directory)`;
}

function applyLinkRule(
  medium: MediumControl,
  rule: LinkRule,
  mediumIds: readonly string[],
): void {
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
  await write(
    options.outputs.events,
    result.events.map((e) => JSON.stringify(e)).join("\n") + (result.events.length ? "\n" : ""),
  );
  const serialByNode = new Map<string, string[]>();
  for (const event of result.events) {
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
