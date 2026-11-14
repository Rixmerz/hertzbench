// The real host, for the code that needs one: which OS this process runs on, and a runner that
// starts real commands. Tests pass an `AndroidHostEnv` and a fake `CommandRunner` instead.

import type { AndroidHostEnv, AndroidPlatform, CommandRunner } from "./platform.ts";

const PLATFORMS: Record<string, AndroidPlatform> = {
  linux: "linux",
  windows: "windows",
  darwin: "darwin",
};

/** The host this process runs on; an OS the launcher has no seam for is treated as Linux. */
export function detectHost(): AndroidHostEnv {
  const env: Record<string, string | undefined> = {};
  for (const name of ["ANDROID_HOME", "ANDROID_SDK_ROOT", "LOCALAPPDATA"]) {
    env[name] = Deno.env.get(name);
  }
  const platform = PLATFORMS[Deno.build.os] ?? "linux";
  return {
    platform,
    env,
    home: Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "",
    localAppData: env.LOCALAPPDATA,
  };
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
