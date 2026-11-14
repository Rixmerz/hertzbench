// The host platform seam of the Android launcher: which OS the tools run on, where the SDK
// lives by default, and the file names that differ per OS. Everything here takes the host as
// an argument (`AndroidHostEnv`) instead of reading `Deno.build.os`, so a test can stand in for
// Windows or macOS on a Linux machine. Nothing here touches the real OS except the SDK
// existence check in `resolveSdkRoot`, which a test can replace.

import { posix, win32 } from "node:path";

export type AndroidPlatform = "linux" | "windows" | "darwin";

/** The host the launcher runs on, as data: tests build one per platform. */
export interface AndroidHostEnv {
  platform: AndroidPlatform;
  env: Record<string, string | undefined>;
  home: string;
  /** `%LOCALAPPDATA%`, Windows only. */
  localAppData?: string;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a host command; a test supplies a fake that records calls and returns scripted results. */
export interface CommandRunner {
  run(
    cmd: string,
    args: string[],
    opts?: { timeoutMs?: number; env?: Record<string, string> },
  ): Promise<CommandResult>;
}

export const emulatorExecutableName = (platform: AndroidPlatform): string =>
  platform === "windows" ? "emulator.exe" : "emulator";

export const adbExecutableName = (platform: AndroidPlatform): string =>
  platform === "windows" ? "adb.exe" : "adb";

/** Join with the platform's separator, whatever OS this process runs on. */
export function joinHostPath(host: { platform: AndroidPlatform }, ...parts: string[]): string {
  return (host.platform === "windows" ? win32 : posix).join(...parts);
}

/** Where Android Studio puts the SDK on this platform. */
export function defaultSdkRoot(host: AndroidHostEnv): string {
  switch (host.platform) {
    case "windows":
      return joinHostPath(
        host,
        host.localAppData ?? joinHostPath(host, host.home, "AppData", "Local"),
        "Android",
        "Sdk",
      );
    case "darwin":
      return joinHostPath(host, host.home, "Library", "Android", "sdk");
    case "linux":
      return joinHostPath(host, host.home, "Android", "Sdk");
  }
}

function isDirectory(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}

/**
 * The SDK root: $ANDROID_HOME, then $ANDROID_SDK_ROOT, then the default location. The first that
 * exists wins (a variable that names a missing directory is skipped); undefined when none does.
 * `exists` is the directory check, replaceable so a test need not create a Windows-shaped path.
 */
export function resolveSdkRoot(
  host: AndroidHostEnv,
  exists: (path: string) => boolean = isDirectory,
): string | undefined {
  const candidates = [host.env.ANDROID_HOME, host.env.ANDROID_SDK_ROOT, defaultSdkRoot(host)];
  return candidates.find((path): path is string => !!path && exists(path));
}
