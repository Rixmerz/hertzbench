// Opens the viewer URL in the default browser. Opening is a convenience: a missing opener binary,
// a headless host or a failing command must never break the command that asked for it.

export type Opener = (url: string) => Promise<void>;

/** The command line that opens `url` on `os`, or null when the OS has no known opener. */
export function openCommandFor(os: string, url: string): string[] | null {
  switch (os) {
    // The empty "" is the window title: without it `start` treats a quoted URL as the title.
    case "windows":
      return ["cmd", "/c", "start", "", url];
    case "darwin":
      return ["open", url];
    case "linux":
      return ["xdg-open", url];
    default:
      return null;
  }
}

export function openerFor(os: string): Opener {
  return async (url) => {
    const command = openCommandFor(os, url);
    if (command === null) return;
    const [program, ...args] = command;
    await new Deno.Command(program as string, {
      args,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
  };
}

/** True only for an interactive run: a terminal on stdout, not CI, and no `--no-open`. */
export function shouldOpenBrowser(
  input: { stdoutIsTerminal: boolean; ci: boolean; noOpen: boolean },
): boolean {
  return input.stdoutIsTerminal && !input.ci && !input.noOpen;
}

/** Never throws and never rejects, whatever the opener does (even a synchronous throw). */
export async function openBrowserSafely(
  url: string,
  opener: Opener = openerFor(Deno.build.os),
): Promise<void> {
  try {
    await opener(url);
  } catch {
    // Best effort by design: the URL is printed by the caller, so the user can open it by hand.
  }
}
