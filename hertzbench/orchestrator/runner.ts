// Runs one scenario: bring up the medium and the adapter, start the boards, play
// the timeline against the wall clock, then judge the assertions and write the
// outputs. Time zero is the moment every board's netdev has connected, so guest
// boot time counts toward `duration`.

import { dirname, join } from "node:path";
import { QemuWifiL2Adapter } from "../adapters/qemu-wifi-l2/mod.ts";
import {
  bridgeFidelity,
  type BridgeHooks,
  bridgeLines,
  type BridgeReport,
  BridgeStartError,
  IpBridge,
  MdnsPublisher,
} from "../bridge/mod.ts";
import {
  type ChannelChanges,
  type ChipSignal,
  type Clock,
  computeMetrics,
  type EngineEvent,
  type Environment,
  espnowToRadiotap,
  EventLog,
  type LinkBudget,
  LINKTYPE_IEEE802_11_RADIOTAP,
  Medium,
  type MediumControl,
  type MetricsReport,
  PacedClock,
  PcapWriter,
  type Position,
  type RadioConfig,
  substream,
  VirtualGateway,
  WallClock,
} from "../engine/mod.ts";
import { createAirNetwork, declaredMismatches, type NetworkSetup } from "./air-network.ts";
import { boardLimitWarnings } from "./board-limits.ts";
import { type AssertionResult, evaluateAssertions } from "./assertions.ts";
import {
  BoardError,
  type BoardLauncher,
  type LiveMqttPublish,
  type LiveSend,
  type PeerInfo,
  type RunningBoard,
} from "./boards/board.ts";
import {
  type AndroidAppLauncher,
  createAndroidAppLauncher,
  createAndroidLauncher,
  VERIFIED_EMULATOR_VERSION,
} from "./boards/android.ts";
import { createEsp32Launcher } from "./boards/qemu-esp32.ts";
import { scriptedLauncher } from "./boards/scripted.ts";
import { MediumClock } from "./medium-clock.ts";
import { describeRadio, type NodeRadio } from "./radios.ts";
import { metricsDocument } from "./report.ts";
import {
  type AndroidApp,
  type BoardKind,
  type BridgeSpec,
  GATEWAY_HOST,
  GATEWAY_MAC,
  type InterferenceWindow,
  type LinkRule,
  matchesPattern,
  type Scenario,
  type TimelineAction,
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
  /** Boots the `android:` app of a BLE scenario; default: the real emulator. */
  androidApp?: AndroidAppLauncher;
  /** How long to wait for every board's netdev to connect. Default 30 s. */
  startupTimeoutMs?: number;
  /** Progress lines for the person running the CLI. */
  progress?: (line: string) => void;
  /** Abort to end the run early: boards are stopped and the run rejects with RunInterrupted. */
  signal?: AbortSignal;
  /** Called once, at time zero, with live control over the run (the MCP server's live tools). */
  onUnderway?: (run: LiveRun) => void;
  /** Replace the parts of the mobile bridge that touch the host's network or radio (tests). */
  bridge?: BridgeHooks;
}

/**
 * A run that is underway. Moves, link rules and phases go through the same
 * medium calls the timeline uses, so they land in the event log and the
 * metrics exactly like scripted ones. Readers keep working after the run ends;
 * the actions throw once it has.
 */
export interface LiveRun {
  /** False from the moment the run starts winding down. */
  readonly active: boolean;
  /** Milliseconds since time zero. */
  elapsedMs(): number;
  /** Every event so far, timed from time zero as in the final result. */
  events(): EngineEvent[];
  /** Board and adapter problems reported so far. */
  problems(): readonly string[];
  /** Where a node on the medium is now. */
  position(id: string): Position;
  /** The current budget of a directed link; on the chip-level air, with the signal it was read against. */
  budget(from: string, to: string): LinkBudget & { signal?: ChipSignal };
  moveNode(id: string, to: Position): void;
  /** Channel-model parameters, changed now for every later frame and budget. */
  setEnvironment(changes: ChannelChanges): void;
  /** The channel model as it is now: the walls (doors included) and which interference sources are on. */
  environment(): Environment;
  /** A station's radio as the medium models it; the chip-level air takes only the antenna gain. */
  setRadio(id: string, changes: Partial<RadioConfig>): void;
  /** Applies the rule now; returns the directed pairs it set. */
  setLink(rule: LinkRule): [string, string][];
  startPhase(label: string): void;
  /** The mobile bridge, with its host endpoints once started; null when the scenario has none. */
  bridge(): BridgeReport | null;
  /** Bytes into a board's serial console. Throws BoardError when the board has none. */
  writeSerial(id: string, bytes: Uint8Array): Promise<void>;
  /**
   * Publishes through the MQTT broker a scripted node serves; returns how many client sessions
   * it was written to. Throws BoardError when the node is not such a broker.
   */
  publishMqtt(id: string, publish: LiveMqttPublish): number;
  /** One send from a scripted Wi-Fi or BLE node. Throws BoardError when the node cannot make it. */
  sendPayload(id: string, send: LiveSend): Promise<void>;
  /**
   * A capture of the run so far, as the run writes it at the end: `pcap` the
   * air (air.pcap), `pcap-80211` its ESP-NOW frames as 802.11 (Wi-Fi only),
   * `btsnoop` one BLE node's HCI. Null when this run has no such capture.
   */
  capture(kind: CaptureKind, node?: string): { bytes: Uint8Array; packets: number } | null;
}

export const CAPTURE_KINDS = ["pcap", "pcap-80211", "btsnoop"] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

export class RunInterrupted extends Error {
  override name = "RunInterrupted";
}

export interface NodeReport {
  id: string;
  /** "bridge" for the mobile bridge's station, which is not a board. */
  board: BoardKind | "bridge";
  ip: string;
  mac: string;
  position: Position;
  /** Wi-Fi or nRF24 channel; null for LoRa, which `radio` describes by frequency, and for BLE, which hops. */
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
  bridge: BridgeReport | null;
}

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
  await Deno.mkdir(dirname(path), { recursive: true });
}

export async function runScenario(scenario: Scenario, options: RunOptions): Promise<RunResult> {
  const launchers: Record<BoardKind, BoardLauncher> = {
    esp32: createEsp32Launcher(),
    scripted: scriptedLauncher,
    android: createAndroidLauncher(),
    ...options.launchers,
  };
  const progress = options.progress ?? (() => {});
  await Deno.mkdir(options.outDir, { recursive: true });

  // Chip radios have sub-millisecond protocol timing (an nRF24 ACK 130 us after
  // its packet) that plain timers cannot keep in order; Wi-Fi does not.
  const clock = scenario.phy === "wifi" ? new WallClock() : new PacedClock();
  const log = new EventLog();
  const problems: string[] = [];
  const onMedium = scenario.nodes.filter((n) => !n.internetGateway);
  const boardIds = onMedium.map((n) => n.id);
  // The bridge is a station like the boards: links, moves and metrics name it too.
  const mediumIds = scenario.bridge ? [...boardIds, scenario.bridge.id] : boardIds;
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
  // A fault that makes the rest of the run meaningless, found at any moment of it: the run stops.
  let failRun: (error: BoardError) => void = () => {};
  const runFailed = new Promise<never>((_, reject) => {
    failRun = reject;
  });
  runFailed.catch(() => {});
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
  // The gateway leases by MAC and skips an unknown one, so an Android guest whose MAC is not the
  // one the node was given would never get an address and nothing would say why.
  const guestMacs = new Map(
    scenario.nodes.filter((n) => n.board === "android").map((n) => [n.id, n.mac]),
  );
  // Settled by the guest's first frame. With the feature flag ignored, netsim keeps the Wi-Fi
  // and the socket stays silent: only the absence of this frame tells.
  const guestFrames = new Map(
    [...guestMacs.keys()].map((id) => [id, Promise.withResolvers<void>()]),
  );
  const checkFirstFrame = (id: string, sourceMac: string) => {
    guestFrames.get(id)?.resolve();
    const expected = guestMacs.get(id);
    if (expected === undefined || sourceMac === expected) return;
    const message = `${id}: the guest's Wi-Fi MAC is ${sourceMac}, but the scenario gives this ` +
      `node ${expected}; the gateway would ignore it and no lease would arrive. ` +
      `Set mac: ${sourceMac} on the node.`;
    problems.push(message);
    failRun(new BoardError(message));
  };
  const network = scenario.phy === "wifi"
    ? wifiNetwork(scenario, gatewayIp, {
      ...networkContext,
      hooks: options.bridge ?? {},
      onFirstFrame: checkFirstFrame,
    })
    : createAirNetwork(scenario, { ...networkContext, hooks: options.bridge ?? {} });
  const { medium, ports } = network;

  const indexOf = (id: string) => scenario.nodes.findIndex((n) => n.id === id) + 1;
  const bridgePeer: PeerInfo[] = scenario.bridge
    ? [{
      id: scenario.bridge.id,
      index: scenario.nodes.length + 1,
      ip: scenario.bridge.kind === "ip" ? scenario.bridge.ip : "",
      mac: scenario.bridge.mac,
    }]
    : [];
  // The bridge is a peer too, so a board's log names it instead of printing its address.
  const peersOf = (id: string): PeerInfo[] => [
    ...onMedium.filter((n) => n.id !== id).map((n) => ({
      id: n.id,
      index: indexOf(n.id),
      ip: n.ip,
      mac: n.mac,
    })),
    ...bridgePeer,
  ];
  const running: RunningBoard[] = [];
  const boards = new Map<string, RunningBoard>();
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
  let endLive = () => {};
  // Intents and instrumentation the timeline started on a board. Intents are awaited before the
  // boards stop, or a healthy `am broadcast` would fail against a dying emulator; instrumentation
  // is ended by its board's stop() and awaited after.
  let ended = false;
  const intents = new Set<Promise<void>>();
  const instrumentations = new Set<Promise<void>>();
  const toBoard = (
    pending: Set<Promise<void>>,
    nodeId: string,
    what: string,
    call: (board: RunningBoard) => Promise<void> | undefined,
  ) => {
    if (ended) return;
    const started = boards.get(nodeId);
    const promise = started && call(started);
    if (!promise) {
      reportProblem(`${nodeId}: cannot ${what}: it is not a running android board`);
      return;
    }
    const tracked: Promise<void> = promise.catch((error) =>
      reportProblem(`${nodeId}: ${error instanceof Error ? error.message : error}`)
    ).finally(() => pending.delete(tracked));
    pending.add(tracked);
  };

  // The app of a BLE scenario is not a node, but starts beside the boards, before time zero: the
  // bridge connects to netsim, which the emulator brings up, only after the app is running.
  const startApp = async (app: AndroidApp): Promise<void> => {
    const bridge = scenario.bridge;
    if (bridge?.kind !== "ble") throw new BoardError("android: the app needs a BLE bridge");
    try {
      running.push(
        await (options.androidApp ?? createAndroidAppLauncher()).start({
          id: bridge.id,
          app,
          hciPort: bridge.netsimHci.port,
          outDir: options.outDir,
          onSerial: (text) => log.append({ type: "serial", t: clock.now(), node: bridge.id, text }),
        }),
      );
    } catch (error) {
      if (error instanceof BoardError) throw error;
      throw new BoardError(
        `${bridge.id}: could not start the app: ${error instanceof Error ? error.message : error}`,
      );
    }
  };

  try {
    progress(`starting ${scenario.nodes.length} board(s)`);
    // allSettled, not all: a board that fails must not leave its siblings
    // half-started and unowned while the first rejection unwinds the run.
    startAll = Promise.allSettled([
      ...scenario.nodes.map(async (node) => {
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
        boards.set(node.id, board);
        clocks.set(node.id, board.clockDescription);
      }),
      ...(scenario.android === null ? [] : [startApp(scenario.android)]),
    ]);
    const started = await Promise.race([startAll, interrupted, startupFailed, runFailed]);
    for (const outcome of started) if (outcome.status === "rejected") throw outcome.reason;

    const startupTimeout = options.startupTimeoutMs ?? 30_000;
    try {
      await Promise.race([
        Promise.all(boardIds.map((id) => network.waitConnected(id, startupTimeout))),
        interrupted,
        startupFailed,
        runFailed,
      ]);
    } catch (error) {
      if (error instanceof RunInterrupted || error instanceof BoardError) throw error;
      throw new BoardError(
        startupMessage(problems, error instanceof Error ? error.message : String(error)),
      );
    }
    const silenceTimers: ReturnType<typeof setTimeout>[] = [];
    try {
      await Promise.race([
        Promise.all([...guestFrames].map(([id, frame]) =>
          Promise.race([
            frame.promise,
            new Promise<never>((_, reject) => {
              silenceTimers.push(setTimeout(() =>
                reject(
                  new BoardError(
                    `${id}: the emulator sent no Wi-Fi frames within ${startupTimeout} ms of its ` +
                      `app running: netsim Wi-Fi may be on. -feature -WiFiPacketStream was ` +
                      `verified with emulator ${VERIFIED_EMULATOR_VERSION}.`,
                  ),
                ), startupTimeout));
            }),
          ])
        )),
        interrupted,
        startupFailed,
        runFailed,
      ]);
    } finally {
      silenceTimers.forEach(clearTimeout);
    }
    startupOver = true;
    zeroMs = clock.now();
    if (network.bridge) {
      try {
        await network.bridge.start();
      } catch (error) {
        if (error instanceof BridgeStartError) throw new BoardError(error.message);
        throw error;
      }
      for (const line of bridgeLines(network.bridge.report())) progress(line);
    }
    progress(`all boards connected; running for ${scenario.durationMs} ms`);

    for (const rule of scenario.links) applyLinkRule(medium, rule, mediumIds);
    if (options.onUnderway) {
      const whileActive = () => {
        if (!live.active) throw new Error("the run has ended");
      };
      /** The board `id`, if it can do `capability`: a refusal names what the node is and what would work. */
      const liveBoard = (
        id: string,
        capability: "publishMqtt" | "sendPayload",
        needs: string,
      ): RunningBoard => {
        const board = boards.get(id);
        if (!board) throw new BoardError(`${id} is not a board of this run`);
        if (!board[capability]) {
          const node = scenario.nodes.find((n) => n.id === id);
          throw new BoardError(
            `${id} is a ${node?.board} board on ${node?.radio.phy}: this needs ${needs}`,
          );
        }
        return board;
      };
      const live: { active: boolean } & LiveRun = {
        active: true,
        elapsedMs: () => clock.now() - zeroMs,
        events: () => log.events.map((event) => ({ ...event, t: event.t - zeroMs })),
        problems: () => problems,
        position: (id) => medium.node(id).position,
        budget: (from, to) => medium.budget(from, to),
        moveNode: (id, to) => {
          whileActive();
          medium.moveNode(id, to);
        },
        environment: () => medium.environment(),
        setEnvironment: (changes) => {
          whileActive();
          medium.setEnvironment(changes);
        },
        setRadio: (id, changes) => {
          whileActive();
          medium.setRadio(id, changes);
        },
        setLink: (rule) => {
          whileActive();
          return applyLinkRule(medium, rule, mediumIds);
        },
        startPhase: (label) => {
          whileActive();
          medium.startPhase(label);
        },
        bridge: () => network.bridge?.report() ?? null,
        writeSerial: (id, bytes) => {
          whileActive();
          const board = boards.get(id);
          if (!board) throw new BoardError(`${id} is not a board of this run`);
          if (!board.writeSerial) {
            throw new BoardError(
              `${id} is a ${
                scenario.nodes.find((n) => n.id === id)?.board
              } board: it has no serial console to write to`,
            );
          }
          return board.writeSerial(bytes);
        },
        publishMqtt: (id, publish) => {
          whileActive();
          return liveBoard(id, "publishMqtt", "a scripted Wi-Fi board serving MQTT").publishMqtt!(
            publish,
          );
        },
        sendPayload: (id, send) => {
          whileActive();
          return liveBoard(id, "sendPayload", "a scripted Wi-Fi or BLE board").sendPayload!(send);
        },
        capture: (kind, node) => {
          const writer = kind === "pcap"
            ? network.pcap
            : kind === "pcap-80211"
            ? network.dot11Pcap
            : node === undefined
            ? undefined
            : network.hciCaptures?.get(node);
          return writer ? { bytes: writer.toBytes(), packets: writer.packetCount } : null;
        },
      };
      endLive = () => {
        live.active = false;
      };
      options.onUnderway(live);
    }
    for (const { id, on, atMs } of interferenceSchedule(scenario.interferenceWindows)) {
      // A source due at time zero is on before the first frame, not racing it.
      if (atMs <= 0) medium.setInterference(id, on);
      else clock.schedule(zeroMs + atMs, () => medium.setInterference(id, on));
    }
    for (const event of scenario.timeline) {
      clock.schedule(zeroMs + event.atMs, () => {
        if (event.label !== null) medium.startPhase(event.label);
        for (const action of event.actions) {
          applyTimelineAction(medium, action, mediumIds, (intent) =>
            toBoard(
              intents,
              intent.node,
              `send ${intent.intent.action}`,
              (board) => board.sendIntent?.(intent.intent),
            ));
        }
      });
    }
    for (const node of scenario.nodes) {
      const instrument = node.android?.instrument;
      if (instrument === undefined) continue;
      clock.schedule(zeroMs + instrument.atMs, () =>
        toBoard(
          instrumentations,
          node.id,
          `run ${instrument.runner}`,
          (board) => board.runInstrumentation?.(),
        ));
    }
    await Promise.race([
      new Promise<void>((resolve) => clock.schedule(zeroMs + scenario.durationMs, resolve)),
      interrupted,
      runFailed,
    ]);
  } finally {
    ended = true;
    endLive();
    startupOver = true;
    await startAll;
    await Promise.allSettled([...intents]);
    await stopAll();
    await Promise.allSettled([...instrumentations]);
    await network.bridge?.close();
    await network.close();
    medium.close();
    clock.cancelAll();
  }

  const events = log.events.map((event) => ({ ...event, t: event.t - zeroMs }));
  const metrics = computeMetrics(events, scenario.durationMs);
  metrics.warnings.push(
    ...network.warnings,
    ...declaredMismatches(scenario, events),
    ...boardLimitWarnings(scenario.nodes, events),
  );
  const assertions = evaluateAssertions(scenario.assertions, events, metrics.phases);
  const nodes = scenario.nodes.map((node): NodeReport => ({
    id: node.id,
    board: node.board,
    ip: node.ip,
    mac: node.mac,
    position: node.internetGateway ? node.position : medium.node(node.id).position,
    channel: node.radio.phy === "lora" || node.radio.phy === "ble" ? null : node.radio.channel,
    radio: describeRadio(node.radio),
    onMedium: !node.internetGateway,
    clock: clocks.get(node.id) ?? "not started",
    fidelity: launchers[node.board].fidelity,
  }));
  if (scenario.bridge) nodes.push(bridgeNode(scenario.bridge, medium.node(scenario.bridge.id)));
  const result: RunResult = {
    scenario,
    nodes,
    events,
    metrics,
    assertions,
    problems,
    passed: problems.length === 0 && assertions.every((a) => a.passed),
    files: [],
    bridge: network.bridge?.report() ?? null,
  };
  result.files = await writeOutputs(result, options, network);
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
    hooks: BridgeHooks;
    onFirstFrame(nodeId: string, sourceMac: string): void;
  },
): NetworkSetup {
  const onMedium = scenario.nodes.filter((n) => !n.internetGateway);
  const pcap = new PcapWriter(ctx.epochMs);
  const dot11Pcap = new PcapWriter(ctx.epochMs, LINKTYPE_IEEE802_11_RADIOTAP);
  const gateway = new VirtualGateway({
    mac: GATEWAY_MAC,
    ip: gatewayIp,
    subnetMask: "255.255.255.0",
    leases: new Map(onMedium.map((n) => [n.mac, n.ip])),
  });
  const medium = new Medium({
    seed: scenario.seed,
    environment: scenario.environment,
    // Only a wall clock has timer ticks to skip; a manual clock must keep its exact order.
    clock: ctx.clock.kind === "wall" ? new MediumClock(ctx.clock) : ctx.clock,
    log: ctx.log,
    gateway,
    retryLimit: scenario.retryLimit,
    tap: (tMs, _node, frame) => {
      pcap.addFrame(tMs, frame);
      const dot11 = espnowToRadiotap(frame);
      if (dot11) dot11Pcap.addFrame(tMs, dot11);
    },
  });
  const adapter = new QemuWifiL2Adapter(
    (id, frame) => medium.transmit(id, frame),
    ctx.onProblem,
    ctx.onFirstFrame,
  );
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
  const spec = scenario.bridge;
  let bridge: IpBridge | undefined;
  if (spec?.kind === "ip") {
    const publisher = ctx.hooks.publisher
      ? ctx.hooks.publisher(spec)
      : spec.mdns
      ? new MdnsPublisher({ spec })
      : null;
    bridge = new IpBridge({
      spec,
      nodes: new Map(onMedium.map((n) => [n.id, { ip: n.ip, mac: n.mac }])),
      clock: ctx.clock,
      transmit: (frame) => medium.transmit(spec.id, frame),
      log: (text) => ctx.log.append({ type: "serial", t: ctx.clock.now(), node: spec.id, text }),
      rng: substream(scenario.seed, `bridge:${spec.id}`),
      ...(publisher ? { publisher } : {}),
    });
    if (spec.radio.phy !== "wifi") throw new Error("the IP bridge needs a Wi-Fi radio");
    medium.addNode(
      { id: spec.id, mac: spec.mac, position: spec.position, radio: spec.radio },
      bridge.sink,
    );
  }
  return {
    medium,
    ports,
    ...(bridge ? { bridge } : {}),
    waitConnected: (id, timeoutMs) => adapter.waitConnected(id, timeoutMs),
    close: () => adapter.close(),
    pcap,
    dot11Pcap,
    warnings: [],
  };
}

/** The bridge's station in the report's node table. */
function bridgeNode(spec: BridgeSpec, onMedium: { position: Position }): NodeReport {
  const radio: NodeRadio = spec.radio;
  return {
    id: spec.id,
    board: "bridge",
    ip: spec.kind === "ip" ? spec.ip : "",
    mac: spec.mac,
    position: onMedium.position,
    channel: radio.phy === "wifi" ? radio.channel : null,
    radio: radio.phy === "ble" ? `ble 1M ${radio.txPowerDbm} dBm` : describeRadio(radio),
    onMedium: true,
    clock: "wall clock (host proxy)",
    fidelity: bridgeFidelity(spec),
  };
}

/** What went wrong before the run began, for the person who has to fix it. */
function startupMessage(problems: readonly string[], cause?: string): string {
  const lines = [cause ?? "a board failed during start-up", ...problems.map((p) => `  ${p}`)];
  return `${lines.join("\n")}\n  (worker logs are in the output directory)`;
}

/**
 * What a timeline action does to the medium; the timeline and the test rigs share it. An android
 * action is no business of the medium's: `toBoard` takes it, and a rig with no boards omits it.
 */
export function applyTimelineAction(
  medium: MediumControl,
  action: TimelineAction,
  mediumIds: readonly string[],
  toBoard?: (action: Extract<TimelineAction, { kind: "android" }>) => void,
): void {
  switch (action.kind) {
    case "move":
      return medium.moveNode(action.node, action.to);
    case "link":
      applyLinkRule(medium, action.rule, mediumIds);
      return;
    case "obstacle":
      return medium.setObstacleAttenuation(action.id, action.attenuationDb);
    case "interference":
      return medium.setInterference(action.id, action.on);
    case "android":
      return toBoard?.(action);
  }
}

/**
 * The switches a scenario's `from`/`to` windows make, in time order. A source
 * is off before its window and after it; the timeline can still switch it, and
 * of two switches the later one wins.
 */
export function interferenceSchedule(
  windows: readonly InterferenceWindow[],
): { id: string; on: boolean; atMs: number }[] {
  return windows
    .flatMap((w) => [
      { id: w.id, on: true, atMs: w.fromMs },
      ...(w.toMs === null ? [] : [{ id: w.id, on: false, atMs: w.toMs }]),
    ])
    .sort((a, b) => a.atMs - b.atMs);
}

function applyLinkRule(
  medium: MediumControl,
  rule: LinkRule,
  mediumIds: readonly string[],
): [string, string][] {
  const pairs = expandLinkRule(rule, mediumIds);
  for (const [from, to] of pairs) {
    medium.setLinkOverride(from, to, {
      extraLossPct: rule.extraLossPct,
      extraLatencyMs: rule.extraLatencyMs,
      extraJitterMs: rule.extraJitterMs ?? 0,
      interferenceDb: rule.interferenceDb ?? 0,
    });
  }
  return pairs;
}

/** Where the 802.11 view of the ESP-NOW frames goes: next to the pcap, `air.pcap` -> `air-80211.pcap`. */
export function dot11CapturePath(pcapPath: string): string {
  return pcapPath.endsWith(".pcap") ? `${pcapPath.slice(0, -5)}-80211.pcap` : `${pcapPath}-80211`;
}

async function writeOutputs(
  result: RunResult,
  options: RunOptions,
  network: NetworkSetup,
): Promise<string[]> {
  const { pcap, dot11Pcap } = network;
  const files: string[] = [];
  const write = async (path: string, data: string | Uint8Array) => {
    await ensureParentDir(path);
    if (typeof data === "string") await Deno.writeTextFile(path, data);
    else await Deno.writeFile(path, data);
    files.push(path);
  };
  await write(options.outputs.metrics, JSON.stringify(metricsDocument(result), null, 2) + "\n");
  await write(options.outputs.pcap, pcap.toBytes());
  if (dot11Pcap && dot11Pcap.packetCount > 0) {
    await write(dot11CapturePath(options.outputs.pcap), dot11Pcap.toBytes());
  }
  await write(
    options.outputs.events,
    result.events.map((e) => JSON.stringify(e)).join("\n") + (result.events.length ? "\n" : ""),
  );
  for (const [node, snoop] of network.hciCaptures ?? []) {
    if (snoop.packetCount > 0) {
      await write(join(options.outDir, `hci-${node}.btsnoop`), snoop.toBytes());
    }
  }
  const serialByNode = new Map<string, string[]>();
  for (const event of result.events) {
    if (event.type !== "serial") continue;
    const lines = serialByNode.get(event.node) ?? [];
    lines.push(`[${(event.t / 1000).toFixed(3)}s] ${event.text}`);
    serialByNode.set(event.node, lines);
  }
  for (const [node, lines] of serialByNode) {
    await write(join(options.outDir, `serial-${node}.log`), lines.join("\n") + "\n");
  }
  return files;
}
