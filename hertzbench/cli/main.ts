// `hertzbench run scenario.yaml` and `hertzbench validate scenario.yaml`.
// Exit status: 0 the run passed, 1 an assertion failed or a board reported a
// problem, 2 the scenario was invalid or the environment cannot run it, 130
// interrupted.

import { PRODUCT } from "../brand.ts";
import { BoardError } from "../orchestrator/boards/board.ts";
import { checkFirmwareFiles, loadScenario } from "../orchestrator/load.ts";
import { renderReport } from "../orchestrator/report.ts";
import { RunInterrupted, runScenario } from "../orchestrator/runner.ts";
import { ScenarioError } from "../orchestrator/scenario.ts";

const USAGE = `${PRODUCT.displayName}: simulate the radio network between boards

Usage:
  ${PRODUCT.cli} run <scenario.yaml> [--out DIR] [--seed N] [--quiet]
  ${PRODUCT.cli} validate <scenario.yaml>

  (${PRODUCT.cliAlias} is a short alias for ${PRODUCT.cli})

run        Run the scenario headless, print a report, write metrics.json,
           air.pcap and events.jsonl, and exit non-zero if an assertion fails.
validate   Check the scenario file and the firmware paths it names.

Options:
  --out DIR   Write every output file into DIR instead of the scenario's own.
  --seed N    Override the scenario seed.
  --quiet     Print only the result line.
`;

interface Args {
  command: string;
  file: string | undefined;
  out: string | undefined;
  seed: number | undefined;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args | string {
  const args: Args = {
    command: "",
    file: undefined,
    out: undefined,
    seed: undefined,
    quiet: false,
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
      const value = Number(rest.shift());
      if (!Number.isInteger(value) || value < 0 || value > 2 ** 32 - 1) {
        return "--seed needs an integer from 0 to 4294967295";
      }
      args.seed = value;
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
  const args = parseArgs(argv);
  if (typeof args === "string") {
    console.error(args === USAGE ? args : `${args}\n\n${USAGE}`);
    return args === USAGE ? 0 : 2;
  }
  if (args.command !== "run" && args.command !== "validate") {
    console.error(`unknown command ${JSON.stringify(args.command)}\n\n${USAGE}`);
    return 2;
  }
  if (args.file === undefined) {
    console.error(`${args.command} needs a scenario file\n\n${USAGE}`);
    return 2;
  }

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

if (import.meta.main) Deno.exit(await main(Deno.args));
