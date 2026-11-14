// `hertzbench examples [name] [--out DIR]`: lists the bundled example scenarios, or copies one
// out as <name>.yaml. The examples are embedded (examples_bundle.ts), so this works from a
// compiled binary with no checkout beside it.

import { join, resolve } from "node:path";
import { PRODUCT } from "../brand.ts";
import { BUNDLED_EXAMPLES } from "./examples_bundle.ts";

export function listExamples(): Array<{ name: string; description: string }> {
  return Object.entries(BUNDLED_EXAMPLES)
    .map(([name, { description }]) => ({ name, description }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Exit codes: 0 done, 1 unknown name or the file already exists, 2 bad arguments. */
export async function examplesCommand(
  args: string[],
  options: { cwd?: string } = {},
): Promise<number> {
  let name: string | undefined;
  let out: string | undefined;
  const rest = [...args];
  while (rest.length > 0) {
    const arg = rest.shift() as string;
    if (arg === "--out") {
      out = rest.shift();
      if (out === undefined) return usageError("--out needs a directory");
    } else if (arg.startsWith("-")) {
      return usageError(`unknown option ${arg}`);
    } else if (name === undefined) {
      name = arg;
    } else {
      return usageError(`unexpected argument ${arg}`);
    }
  }

  if (name === undefined) {
    if (out !== undefined) return usageError("--out needs an example name");
    const examples = listExamples();
    const width = Math.max(...examples.map((example) => example.name.length));
    for (const { name, description } of examples) {
      console.log(`${name.padEnd(width)}  ${description}`);
    }
    console.log(`\nCopy one out with: ${PRODUCT.cli} examples <name> [--out <dir>]`);
    return 0;
  }

  // Object.hasOwn: "constructor" and "__proto__" are not examples.
  if (!Object.hasOwn(BUNDLED_EXAMPLES, name)) {
    console.error(`unknown example "${name}"; run \`${PRODUCT.cli} examples\` to list them`);
    return 1;
  }

  const dir = resolve(options.cwd ?? Deno.cwd(), out ?? ".");
  const path = join(dir, `${name}.yaml`);
  try {
    await Deno.mkdir(dir, { recursive: true });
  } catch (error) {
    console.error(`cannot create ${dir}: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
  try {
    // createNew is an exclusive create (O_EXCL): it fails if the path exists, even when another
    // process made it a moment ago, so no existing file is ever replaced.
    await Deno.writeTextFile(path, BUNDLED_EXAMPLES[name]!.yaml, { createNew: true });
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) {
      console.error(`${path} already exists; not overwriting it. Move it or use another --out.`);
    } else {
      console.error(`cannot write ${path}: ${error instanceof Error ? error.message : error}`);
    }
    return 1;
  }
  console.log(`wrote ${path}`);
  console.log(`run it with: ${PRODUCT.cli} run ${path}`);
  return 0;
}

function usageError(message: string): number {
  console.error(`${message}\nusage: ${PRODUCT.cli} examples [name] [--out <dir>]`);
  return 2;
}
