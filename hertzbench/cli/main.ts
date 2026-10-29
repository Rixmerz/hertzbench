// `hertzbench run scenario.yaml`, `hertzbench validate scenario.yaml`,
// `hertzbench view scenario.yaml` and `hertzbench mcp`. Exit status: 0 the run
// passed, 1 an assertion failed or a board reported a problem, 2 the scenario
// was invalid or the environment cannot run it, 130 interrupted. `view` and
// `mcp` are servers: Ctrl-C is how they end, and they exit 0.

import { resolve } from "node:path";
import { PRODUCT } from "../brand.ts";
import { androidCommand } from "./android.ts";
import { runMcpServer, Session, ToolError } from "../mcp/mod.ts";
import { BoardError } from "../orchestrator/boards/board.ts";
import { checkFirmwareFiles, loadScenario } from "../orchestrator/load.ts";
import { renderReport } from "../orchestrator/report.ts";
import { RunInterrupted, runScenario } from "../orchestrator/runner.ts";
import { ScenarioError } from "../orchestrator/scenario.ts";
import { serveView } from "../view/server.ts";

const USAGE = `${PRODUCT.displayName}: simulate the radio network between boards

Usage:
  ${PRODUCT.cli} run <scenario.yaml> [--out DIR] [--seed N] [--quiet]
  ${PRODUCT.cli} validate <scenario.yaml>
  ${PRODUCT.cli} view <scenario.yaml> [--port N] [--out DIR] [--seed N]
  ${PRODUCT.cli} mcp [--workspace DIR] [--view-port N]
  ${PRODUCT.cli} android prepare <avd>

  (${PRODUCT.cliAlias} is a short alias for ${PRODUCT.cli})

run        Run the scenario headless, print a report, write metrics.json,
           air.pcap and events.jsonl, and exit non-zero if an assertion fails.
validate   Check the scenario file and the firmware paths it names.
view       Run the scenario and draw it live in the browser: a map of the
           nodes, links colored by signal or loss, a packet timeline; drag a
           node to move it (see docs/view.md). Serves until Ctrl-C.
mcp        Serve the Model Context Protocol on stdin and stdout, for an AI
           agent such as Claude Code (see docs/mcp.md).
android    prepare: save the AVD snapshot that \`snapshot: true\` android nodes boot
           from (see docs/scenario-format.md, \`board: android\`).

Options:
  --out DIR   Write every output file into DIR instead of the scenario's own.
  --seed N    Override the scenario seed.
  --quiet     Print only the result line.
  --port N    view: the loopback port to serve on. Default 7480; 0 picks a
              free one. The address is printed on stderr.
  --workspace DIR
              mcp: the directory scenario paths are relative to and the only
              place the server writes. Default: the current directory.
  --view-port N
              mcp: also serve the view of the agent's run on this loopback
              port (0 picks a free one).
`;

interface Args {
  command: string;
  file: string | undefined;
  out: string | undefined;
  seed: number | undefined;
  quiet: boolean;
  workspace: string | undefined;
  port: number | undefined;
  viewPort: number | undefined;
}

const DEFAULT_VIEW_PORT = 7480;

/** Decimal digits only: Number() reads "" and " " as 0, and "0x10" or "1e3" are not what a person types. */
function parseWhole(value: string | undefined, max: number): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return n <= max ? n : undefined;
}

function parsePort(value: string | undefined): number | undefined {
  return parseWhole(value, 65535);
}

function parseArgs(argv: string[]): Args | string {
  const args: Args = {
    command: "",
    file: undefined,
    out: undefined,
    seed: undefined,
    quiet: false,
    workspace: undefined,
    port: undefined,
    viewPort: undefined,
  };
  const rest = [...argv];
  const command = rest.shift();
  if (command === undefined || command === "--help" || command === "-h") return USAGE;
  args.command = command;
  while (rest.length > 0) {
    const arg = rest.shift() as string;
    if (arg === "--out") {
      args.out = rest.shift();
      if (args.out === undefined) return "--out needs a directory";
    } else if (arg === "--seed") {
      const value = parseWhole(rest.shift(), 2 ** 32 - 1);
      if (value === undefined) return "--seed needs an integer from 0 to 4294967295";
      args.seed = value;
    } else if (arg === "--workspace") {
      args.workspace = rest.shift();
      if (args.workspace === undefined) return "--workspace needs a directory";
    } else if (arg === "--port" || arg === "--view-port") {
      const port = parsePort(rest.shift());
      if (port === undefined) return `${arg} needs a port from 0 to 65535`;
      if (arg === "--port") args.port = port;
      else args.viewPort = port;
    } else if (arg === "--quiet") {
      args.quiet = true;
    } else if (arg === "--help" || arg === "-h") {
      return USAGE;
    } else if (arg.startsWith("-")) {
      return `unknown option ${arg}`;
    } else if (args.file === undefined) {
      args.file = arg;
    } else {
      return `unexpected argument ${arg}`;
    }
  }
  return args;
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === "android") return await androidCommand(argv.slice(1));
  const args = parseArgs(argv);
  if (typeof args === "string") {
    console.error(args === USAGE ? args : `${args}\n\n${USAGE}`);
    return args === USAGE ? 0 : 2;
  }
  if (args.command === "mcp") {
    if (args.file !== undefined) {
      console.error(`mcp takes no scenario file\n\n${USAGE}`);
      return 2;
    }
    await runMcpServer({
      workspace: args.workspace ?? Deno.cwd(),
      ...(args.viewPort !== undefined ? { viewPort: args.viewPort } : {}),
    });
    return 0;
  }
  if (args.command !== "run" && args.command !== "validate" && args.command !== "view") {
    console.error(`unknown command ${JSON.stringify(args.command)}\n\n${USAGE}`);
    return 2;
  }
  if (args.file === undefined) {
    console.error(`${args.command} needs a scenario file\n\n${USAGE}`);
    return 2;
  }

  if (args.command === "view") return await view(args.file, args);

  try {
    const loaded = await loadScenario(args.file, args.out);
    const scenario = args.seed === undefined
      ? loaded.scenario
      : { ...loaded.scenario, seed: args.seed };
    const missing = await checkFirmwareFiles(scenario);
    if (missing.length > 0) {
      console.error(`${loaded.file}: firmware not found\n  ${missing.join("\n  ")}`);
      return 2;
    }
    if (args.command === "validate") {
      console.log(
        `${loaded.file}: ok (${scenario.nodes.length} nodes, ${scenario.durationMs} ms, seed ${scenario.seed})`,
      );
      return 0;
    }
    // Ctrl-C and SIGTERM end the run through the runner, which stops every board.
    // Exiting straight away would leave QEMU workers running.
    const abort = new AbortController();
    const onSignal = () => abort.abort();
    const signals: Deno.Signal[] = Deno.build.os === "windows" ? ["SIGINT"] : ["SIGINT", "SIGTERM"];
    for (const signal of signals) Deno.addSignalListener(signal, onSignal);
    let result;
    try {
      result = await runScenario(scenario, {
        signal: abort.signal,
        outDir: loaded.outDir,
        outputs: loaded.outputs,
        progress: args.quiet ? undefined : (line) => console.error(`[${PRODUCT.slug}] ${line}`),
      });
    } finally {
      for (const signal of signals) Deno.removeSignalListener(signal, onSignal);
    }
    if (args.quiet) console.log(result.passed ? "RESULT: PASS" : "RESULT: FAIL");
    else console.log(renderReport(result));
    return result.passed ? 0 : 1;
  } catch (error) {
    if (error instanceof RunInterrupted) {
      console.error(`${PRODUCT.cli}: interrupted; boards stopped, no results written`);
      return 130;
    }
    if (error instanceof ScenarioError || error instanceof BoardError) {
      console.error(`${PRODUCT.cli}: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

/**
 * Run the scenario through the same session the MCP server uses and serve its
 * view until Ctrl-C or SIGTERM. The run's files go to --out, or to
 * out/<scenario>/<run id>/ in the current directory, which is also the only
 * place this command writes.
 */
async function view(file: string, args: Args): Promise<number> {
  const log = (line: string) => console.error(`[${PRODUCT.slug}] ${line}`);
  const out = args.out === undefined ? undefined : resolve(args.out);
  // The session's workspace must exist; `run --out` creates its directory too.
  if (out !== undefined) await Deno.mkdir(out, { recursive: true });
  const session = new Session({ workspace: out ?? Deno.cwd(), progress: log });
  let server;
  try {
    server = serveView(session, { port: args.port ?? DEFAULT_VIEW_PORT });
  } catch (error) {
    if (!(error instanceof Deno.errors.AddrInUse)) throw error;
    console.error(`${PRODUCT.cli}: port ${args.port ?? DEFAULT_VIEW_PORT} is in use; pass --port`);
    return 2;
  }
  const signals: Deno.Signal[] = Deno.build.os === "windows" ? ["SIGINT"] : ["SIGINT", "SIGTERM"];
  const quit = Promise.withResolvers<void>();
  for (const signal of signals) Deno.addSignalListener(signal, quit.resolve);
  try {
    let run;
    try {
      run = await session.start(resolve(file), {
        ...(args.seed !== undefined ? { seed: args.seed } : {}),
        ...(out !== undefined ? { out } : {}),
      });
    } catch (error) {
      if (error instanceof ToolError || error instanceof ScenarioError) {
        console.error(`${PRODUCT.cli}: ${error.message}`);
        return 2;
      }
      throw error;
    }
    log(`view: ${server.url}`);
    let quitting = false;
    run.done.then(() => {
      if (quitting) return;
      if (run.result) console.log(renderReport(run.result));
      log(`run ${run.state}${run.error ? `: ${run.error}` : ""}; the view stays up until Ctrl-C`);
    });
    await quit.promise;
    quitting = true;
    return 0;
  } finally {
    for (const signal of signals) Deno.removeSignalListener(signal, quit.resolve);
    await session.close();
    await server.shutdown();
  }
}

if (import.meta.main) Deno.exit(await main(Deno.args));
