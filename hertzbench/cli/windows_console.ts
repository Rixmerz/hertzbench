// Windows double-click support: a person who opens the .exe from Explorer gets a console that
// closes the moment the process exits, so the usage text is gone before it can be read.

export type WelcomeInput = { os: string; ownsConsole: boolean; argCount: number };

/** Pure: the welcome screen only makes sense for a bare launch from Explorer on Windows. */
export function shouldShowWelcome(input: WelcomeInput): boolean {
  return input.os === "windows" && input.ownsConsole && input.argCount === 0;
}

/**
 * True when this process is the only one attached to its console, which is what a double-click
 * produces. A shell (cmd, PowerShell) is attached too, so the count is then 2 or more.
 * Any failure (not Windows, no --allow-ffi, missing symbol) returns false so the caller keeps
 * today's behaviour.
 */
export function ownsConsoleWindow(): boolean {
  try {
    // Never trigger a permission prompt (it would hang a test run on a terminal), and never touch
    // kernel32 on another OS.
    if (Deno.build.os !== "windows") return false;
    if (Deno.permissions.querySync({ name: "ffi" }).state !== "granted") return false;
    const kernel32 = Deno.dlopen("kernel32.dll", {
      GetConsoleProcessList: { parameters: ["buffer", "u32"], result: "u32" },
    });
    try {
      return kernel32.symbols.GetConsoleProcessList(new Uint32Array(2), 2) === 1;
    } finally {
      kernel32.close();
    }
  } catch {
    return false;
  }
}

export function welcomeText(exeName: string): string {
  return [
    `${exeName} is a command-line tool: it has no window of its own.`,
    "",
    "Open a terminal in this folder first, then try these three commands:",
    "",
    `  ${exeName} examples   list the example scenarios and copy one out`,
    `  ${exeName} run        run a scenario`,
    `  ${exeName} view       watch a scenario in your browser`,
    "",
    "Press Enter to close this window.",
    "",
  ].join("\n");
}

/** Reads one line from stdin, then resolves. Resolves at once on end of input. */
export async function waitForEnter(): Promise<void> {
  const reader = Deno.stdin.readable.getReader();
  try {
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done || decoder.decode(value, { stream: true }).includes("\n")) return;
    }
  } finally {
    reader.releaseLock();
  }
}
