// What differs between the operating systems the suite runs on (Linux, macOS,
// Windows): the Python executable, launcher scripts, and tests that only make
// sense where the OS has the feature they check.

import { delimiter } from "node:path";

export const IS_WINDOWS = Deno.build.os === "windows";
/** The interpreter name Python installs under: python3 on Linux and macOS, python on Windows. */
export const PYTHON = IS_WINDOWS ? "python" : "python3";
/** Separator of the PATH variable. */
export const PATH_DELIMITER = delimiter;

/**
 * Deno.test that is skipped on Windows, with the reason in the test's name so
 * a skip is never silent.
 */
export function skipOnWindows(reason: string) {
  return (name: string, fn: () => void | Promise<void>): void =>
    Deno.test({
      name: IS_WINDOWS ? `${name} [skipped on Windows: ${reason}]` : name,
      ignore: IS_WINDOWS,
      fn,
    });
}

/** The text with every path separator as "/", to compare a path the program printed on any OS. */
export const forward = (text: string): string => text.replaceAll("\\", "/");

/** Whether a program can be started: Deno.Command throws when it is not on PATH. */
export async function commandExists(program: string, args: string[]): Promise<boolean> {
  try {
    await new Deno.Command(program, { args, stdout: "null", stderr: "null" }).output();
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** Deno cannot send SIGINT or SIGTERM to a child on Windows; kill() ends it without its handlers. */
export const signalTest = skipOnWindows(
  "a child process cannot be sent SIGINT or SIGTERM, so graceful stop cannot be driven from a test",
);

/**
 * The scripted boards answer an ESP-NOW unicast within the fork's 10 ms ACK
 * wait on a wall clock, which needs timers finer than 10 ms. Windows timers
 * tick every 15.6 ms (setTimeout(1) takes 15.6 ms there), so no ACK arrives in time.
 */
export const ackWindowTest = skipOnWindows(
  "the 10 ms ESP-NOW ACK wait is below the 15.6 ms Windows timer tick",
);

/** chmod, which Windows does not implement; a file there is runnable by its extension. */
export async function makeExecutable(path: string): Promise<void> {
  if (!IS_WINDOWS) await Deno.chmod(path, 0o755);
}

/**
 * A stand-in for the Python interpreter: a program HERTZBENCH_PYTHON can name
 * that runs `source` with the real interpreter, whatever arguments it is
 * given (they arrive in sys.argv). A launcher is a shell script on Linux and
 * macOS and a .cmd file on Windows. Returns the launcher's path.
 */
export async function writeFakePython(dir: string, source: string): Promise<string> {
  const script = `${dir}/fake_python_main.py`;
  await Deno.writeTextFile(script, source);
  if (IS_WINDOWS) {
    const launcher = `${dir}\\fake-python.cmd`;
    await Deno.writeTextFile(launcher, `@echo off\r\n"${PYTHON}" "${script}" %*\r\n`);
    return launcher;
  }
  const launcher = `${dir}/fake-python`;
  await Deno.writeTextFile(launcher, `#!/bin/sh\nexec ${PYTHON} '${script}' "$@"\n`);
  await makeExecutable(launcher);
  return launcher;
}
