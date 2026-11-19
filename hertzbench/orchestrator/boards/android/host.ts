// The real host, for the code that needs one: which OS this process runs on, and a runner that
// starts real commands. Tests pass an `AndroidHostEnv` and a fake `CommandRunner` instead.

import { BoardError } from "../board.ts";
import { delimiter as posixDelimiter, win32 } from "node:path";
import type { AndroidTools } from "./tooling.ts";
import {
  adbExecutableName,
  type AndroidHostEnv,
  type AndroidPlatform,
  type CommandRunner,
  defaultSdkRoot,
  emulatorExecutableName,
  joinHostPath,
  resolveSdkRoot,
} from "./platform.ts";

const PLATFORMS: Record<string, AndroidPlatform> = {
  linux: "linux",
  windows: "windows",
  darwin: "darwin",
};

/** The host this process runs on; an OS the launcher has no seam for is treated as Linux. */
export function detectHost(): AndroidHostEnv {
  const env: Record<string, string | undefined> = {};
  for (const name of ["ANDROID_HOME", "ANDROID_SDK_ROOT", "LOCALAPPDATA", "PATH"]) {
    env[name] = Deno.env.get(name);
  }
  const platform = PLATFORMS[Deno.build.os] ?? "linux";
  return {
    platform,
    env,
    home: Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "",
    localAppData: env.LOCALAPPDATA,
    arch: Deno.build.arch,
  };
}

function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

/**
 * Find `emulator` and `adb` on `host`: PATH first, then the SDK root `resolveSdkRoot` names
 * (`emulator/` and `platform-tools/` under it). File names and separators are the host's, so a
 * test can stand in for Windows; `exists` replaces the real file and directory check. Throws a
 * BoardError that says where it looked.
 */
export function findAndroidToolsOnHost(
  host: AndroidHostEnv,
  exists?: (path: string) => boolean,
): AndroidTools {
  const pathDirs = (host.env.PATH ?? "")
    .split(host.platform === "windows" ? win32.delimiter : posixDelimiter)
    .filter((dir) => dir !== "");
  const root = resolveSdkRoot(host, exists);
  const found: Record<"emulator" | "adb", string | undefined> = {
    emulator: undefined,
    adb: undefined,
  };
  for (
    const [key, file, subdir] of [
      ["emulator", emulatorExecutableName(host.platform), "emulator"],
      ["adb", adbExecutableName(host.platform), "platform-tools"],
    ] as const
  ) {
    const candidates = [...pathDirs, ...(root ? [joinHostPath(host, root, subdir)] : [])]
      .map((dir) => joinHostPath(host, dir, file));
    found[key] = candidates.find(exists ?? isFile);
  }
  if (!found.emulator || !found.adb) {
    const missing = (["emulator", "adb"] as const).filter((key) => !found[key]);
    throw new BoardError(
      `${missing.join(" and ")} not found on PATH or in the Android SDK ` +
        `(${root ?? defaultSdkRoot(host)}). Install the Android SDK emulator and platform-tools ` +
        `and set ANDROID_HOME.`,
    );
  }
  return { emulator: found.emulator, adb: found.adb };
}

/** Runs a real command; a command that outlives `timeoutMs` is killed and answers code 124. */
export const processRunner: CommandRunner = {
  async run(cmd, args, opts = {}) {
    const controller = new AbortController();
    const timer = opts.timeoutMs === undefined
      ? undefined
      : setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const out = await new Deno.Command(cmd, {
        args,
        env: opts.env,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        signal: controller.signal,
      }).output();
      const text = new TextDecoder();
      return { code: out.code, stdout: text.decode(out.stdout), stderr: text.decode(out.stderr) };
    } catch (error) {
      if (controller.signal.aborted) {
        return { code: 124, stdout: "", stderr: `timed out after ${opts.timeoutMs} ms` };
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  },
};
