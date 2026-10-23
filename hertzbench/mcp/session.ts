// What one MCP server remembers between calls: its workspace and at most one
// run, started in the background so the live tools can act on it while it
// plays. The last run stays readable after it ends, until the next one starts.

import { dirname, isAbsolute, relative, resolve } from "node:path";
import { computeMetrics, type EngineEvent, type Position } from "../engine/mod.ts";
import { BoardError, type BoardLauncher } from "../orchestrator/boards/board.ts";
import { resolveQemuLibrary } from "../orchestrator/boards/qemu-esp32.ts";
import { checkFirmwareFiles, type LoadedScenario, loadScenario } from "../orchestrator/load.ts";
import { linkJson, metricsDocument } from "../orchestrator/report.ts";
import {
  type LiveRun,
  RunInterrupted,
  type RunResult,
  runScenario,
} from "../orchestrator/runner.ts";
import type { BoardKind, LinkRule, Scenario } from "../orchestrator/scenario.ts";
import { ToolError } from "./protocol.ts";

export type RunState = "starting" | "running" | "finished" | "failed" | "stopped";

interface Run {
  id: string;
  loaded: LoadedScenario;
  state: RunState;
  live: LiveRun | null;
  result: RunResult | null;
  error: string | null;
  /** The log as it stood when the run was stopped or failed after time zero. */
  finalEvents: EngineEvent[] | null;
  finalElapsedMs: number | null;
  abort: AbortController;
  done: Promise<void>;
}

export interface SessionOptions {
  /** Every file the server writes goes under this directory. */
  workspace: string;
  /** Board launchers to use instead of the real ones (tests). */
  launchers?: Partial<Record<BoardKind, BoardLauncher>>;
  startupTimeoutMs?: number;
  /** Progress lines of a run. Never stdout: that is the protocol channel. */
  progress?: (line: string) => void;
}

export class Session {
  readonly workspace: string;
  readonly #options: SessionOptions;
  #run: Run | null = null;
  /** Set from the check to the moment the run exists, so two calls in flight cannot both start one. */
  #preparing = false;

  constructor(options: SessionOptions) {
    this.workspace = resolve(options.workspace);
    this.#options = options;
  }

  /** A path the caller gave, relative to the workspace. Reads may go anywhere, like the CLI. */
  resolvePath(path: string): string {
    return isAbsolute(path) ? path : resolve(this.workspace, path);
  }

  /**
   * A file or directory the server will write. It must stay inside the
   * workspace, also once symlinks are followed (CWE-22, CWE-59). Creates the
   * directory, or the file's parent directory.
   */
  async writablePath(path: string, what: string, kind: "file" | "dir"): Promise<string> {
    const target = this.resolvePath(path);
    if (!inside(this.workspace, target)) {
      throw new ToolError(`${what} must be inside the workspace ${this.workspace}, got ${path}`);
    }
    const escapes = () =>
      new ToolError(`${what} resolves outside the workspace through a symlink: ${path}`);
    const root = await Deno.realPath(this.workspace);
    const dir = kind === "dir" ? target : dirname(target);
    // Check the part that exists before mkdir, or mkdir would follow a symlink
    // and create directories outside before the check below refused them.
    if (!inside(root, await Deno.realPath(await nearestExisting(dir)))) throw escapes();
    await Deno.mkdir(dir, { recursive: true });
    if (!inside(root, await Deno.realPath(dir))) throw escapes();
    if (kind === "file") {
      // Writing through a symlink would land wherever it points.
      const existing = await Deno.lstat(target).catch((error) => {
        if (error instanceof Deno.errors.NotFound) return null;
        throw error;
      });
      if (existing?.isSymlink) throw escapes();
    }
    return target;
  }

  /** Load, check and start a run in the background. Fails at once on anything known before boot. */
  async start(path: string, options: { seed?: number; out?: string }): Promise<Run> {
    if (this.#preparing) {
      throw new ToolError("another run_scenario call is preparing a run; wait for its answer");
    }
    if (this.#run && (this.#run.state === "starting" || this.#run.state === "running")) {
      throw new ToolError(
        `run ${this.#run.id} (${this.#run.loaded.scenario.name}) is still ${this.#run.state}; ` +
          "call stop first",
      );
    }
    this.#preparing = true;
    try {
      return await this.#launch(path, options);
    } finally {
      this.#preparing = false;
    }
  }

  async #launch(path: string, options: { seed?: number; out?: string }): Promise<Run> {
    const file = this.resolvePath(path);
    const id = new Date().toISOString().replace(/[:.]/g, "-");
    const stem = file.replace(/^.*[\\/]/, "").replace(/\.ya?ml$/, "");
    const outDir = this.resolvePath(options.out ?? `out/${stem}/${id}`);
    const loaded = await loadScenario(file, outDir);
    if (options.seed !== undefined) loaded.scenario = { ...loaded.scenario, seed: options.seed };
    const missing = await checkFirmwareFiles(loaded.scenario);
    if (missing.length > 0) throw new ToolError(`firmware not found\n  ${missing.join("\n  ")}`);
    const usesEsp32 = loaded.scenario.nodes.some((n) => n.board === "esp32");
    if (usesEsp32 && !this.#options.launchers?.esp32) resolveQemuLibrary();
    // Only now, with nothing left to refuse, create the output directory.
    await this.writablePath(outDir, "out", "dir");

    const abort = new AbortController();
    const run: Run = {
      id,
      loaded,
      state: "starting",
      live: null,
      result: null,
      error: null,
      finalEvents: null,
      finalElapsedMs: null,
      abort,
      done: Promise.resolve(),
    };
    const progress = this.#options.progress ?? (() => {});
    run.done = runScenario(loaded.scenario, {
      outDir: loaded.outDir,
      outputs: loaded.outputs,
      launchers: this.#options.launchers,
      startupTimeoutMs: this.#options.startupTimeoutMs,
      signal: abort.signal,
      progress: (line) => progress(`[run ${id}] ${line}`),
      onUnderway: (live) => {
        run.live = live;
        run.state = "running";
      },
    }).then(
      (result) => {
        run.result = result;
        run.state = "finished";
      },
      (error) => {
        this.#freeze(run);
        if (error instanceof RunInterrupted) {
          run.state = "stopped";
        } else if (error instanceof BoardError) {
          run.state = "failed";
          run.error = error.message;
        } else {
          // A bug, not a board failure: keep it visible in the status and on stderr.
          run.state = "failed";
          run.error = `internal error: ${error instanceof Error ? error.stack : error}`;
          console.error(run.error);
        }
      },
    );
    this.#run = run;
    return run;
  }

  /** Stop the run in progress. Boards are stopped; no output files are written. */
  async stop(): Promise<Run> {
    const run = this.#active("stop");
    this.#freeze(run);
    run.abort.abort();
    await run.done;
    return run;
  }

  /** Stop whatever is running: the server is going away and must not leave boards behind. */
  async close(): Promise<void> {
    const run = this.#run;
    if (run && (run.state === "starting" || run.state === "running")) {
      run.abort.abort();
      await run.done;
    }
  }

  get run(): Run | null {
    return this.#run;
  }

  /** The run's events: live while it plays, frozen once it ended. */
  events(run: Run): readonly EngineEvent[] {
    if (run.result) return run.result.events;
    if (run.finalEvents) return run.finalEvents;
    return run.live?.events() ?? [];
  }

  elapsedMs(run: Run): number | null {
    if (run.result) return run.result.scenario.durationMs;
    if (run.finalElapsedMs !== null) return run.finalElapsedMs;
    return run.live ? Math.min(run.live.elapsedMs(), run.loaded.scenario.durationMs) : null;
  }

  status() {
    const run = this.#run;
    if (!run) return { state: "idle" as const };
    const { scenario } = run.loaded;
    const base = {
      state: run.state,
      run_id: run.id,
      scenario: scenario.name,
      file: run.loaded.file,
      out_dir: run.loaded.outDir,
      seed: scenario.seed,
      duration_ms: scenario.durationMs,
      elapsed_ms: this.elapsedMs(run),
      nodes: scenario.nodes.map((node) => ({
        id: node.id,
        board: node.board,
        ip: node.ip,
        on_medium: !node.internetGateway,
        position: !node.internetGateway && run.live ? run.live.position(node.id) : node.position,
      })),
      problems: run.result?.problems ?? run.live?.problems() ?? [],
    };
    if (run.state === "finished" && run.result) {
      return {
        ...base,
        passed: run.result.passed,
        assertions: run.result.assertions,
        files: run.result.files,
      };
    }
    if (run.state === "failed") return { ...base, error: run.error };
    if (run.state === "stopped") {
      return { ...base, note: "stopped before the end: no output files, assertions not judged" };
    }
    return base;
  }

  serial(node: string, sinceMs: number | null, tail: number) {
    const run = this.#any();
    this.#node(run.loaded.scenario, node);
    const lines = this.events(run).filter((e): e is Extract<EngineEvent, { type: "serial" }> =>
      e.type === "serial" && e.node === node && (sinceMs === null || e.t > sinceMs)
    );
    const shown = lines.slice(-tail);
    return {
      node,
      state: run.state,
      total: lines.length,
      truncated: lines.length > shown.length,
      lines: shown.map((e) => ({ t_ms: round(e.t), text: e.text })),
      // Pass back as since_ms to read only what is new.
      next_since_ms: lines.length ? lines[lines.length - 1]!.t : sinceMs,
    };
  }

  metrics() {
    const run = this.#any();
    if (run.result) return { state: run.state, ...metricsDocument(run.result) };
    const elapsed = this.elapsedMs(run);
    if (elapsed === null) {
      return { state: run.state, note: "the boards have not all connected yet: no metrics" };
    }
    const metrics = computeMetrics(this.events(run), elapsed);
    return {
      state: run.state,
      partial: true,
      scenario: run.loaded.scenario.name,
      seed: run.loaded.scenario.seed,
      elapsed_ms: round(elapsed),
      latency: "modelled",
      links: metrics.total.map(linkJson),
      phases: metrics.phases.map((p) => ({
        label: p.label,
        from_ms: p.fromMs,
        to_ms: p.toMs,
        links: p.links.map(linkJson),
      })),
      warnings: metrics.warnings,
    };
  }

  move(node: string, to: Position, phase: string | null) {
    const run = this.#underway("move_node");
    const scenarioNode = this.#node(run.loaded.scenario, node);
    if (scenarioNode.internetGateway) {
      throw new ToolError(`${node} is the internet gateway: it is not on the medium`);
    }
    const live = run.live!;
    const from = live.position(node);
    if (phase !== null) live.startPhase(phase);
    live.moveNode(node, to);
    const peers = run.loaded.scenario.nodes.filter((n) => !n.internetGateway && n.id !== node);
    return {
      node,
      from,
      to,
      at_ms: round(live.elapsedMs()),
      phase,
      // What the channel model now gives each link from this node, before any frame.
      links: peers.map((peer) => {
        const budget = live.budget(node, peer.id);
        return {
          link: `${node}->${peer.id}`,
          distance_m: round(budget.distanceM),
          rssi_dbm: round(budget.rssiDbm),
          snr_db: round(budget.snrDb),
        };
      }),
    };
  }

  fault(rule: LinkRule, phase: string | null) {
    const run = this.#underway("inject_fault");
    const live = run.live!;
    if (phase !== null) live.startPhase(phase);
    const pairs = live.setLink(rule);
    if (pairs.length === 0) {
      throw new ToolError(`${rule.from}->${rule.to} matches no link between nodes on the medium`);
    }
    return {
      links: pairs.map(([from, to]) => `${from}->${to}`),
      extra_loss_pct: rule.extraLossPct,
      extra_latency_ms: rule.extraLatencyMs,
      at_ms: round(live.elapsedMs()),
      phase,
    };
  }

  #freeze(run: Run): void {
    if (run.live && run.finalEvents === null) {
      run.finalElapsedMs = Math.min(run.live.elapsedMs(), run.loaded.scenario.durationMs);
      run.finalEvents = run.live.events();
    }
  }

  #any(): Run {
    if (!this.#run) throw new ToolError("no run yet: call run_scenario first");
    return this.#run;
  }

  #active(tool: string): Run {
    const run = this.#any();
    if (run.state !== "starting" && run.state !== "running") {
      throw new ToolError(`${tool}: no run in progress (the last one is ${run.state})`);
    }
    return run;
  }

  #underway(tool: string): Run {
    const run = this.#active(tool);
    if (run.state === "starting" || !run.live?.active) {
      throw new ToolError(
        `${tool}: the boards are still starting; poll get_status until state is "running"`,
      );
    }
    return run;
  }

  #node(scenario: Scenario, id: string) {
    const node = scenario.nodes.find((n) => n.id === id);
    if (!node) {
      throw new ToolError(
        `no node named ${JSON.stringify(id)} (nodes: ${
          scenario.nodes.map((n) => n.id).join(", ")
        })`,
      );
    }
    return node;
  }
}

async function nearestExisting(path: string): Promise<string> {
  for (let current = path;; current = dirname(current)) {
    try {
      await Deno.lstat(current);
      return current;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound) || dirname(current) === current) throw error;
    }
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
