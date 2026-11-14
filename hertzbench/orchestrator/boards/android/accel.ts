// The hardware-acceleration gate of the Android emulator: KVM on Linux, and on Windows and macOS
// whatever `emulator -accel-check` reports (WHPX, AEHD or HAXM; HVF). Takes the host and a
// command runner as arguments, so a test can stand in for either OS.

import type { AndroidHostEnv, CommandRunner } from "./platform.ts";

export type AccelCheck =
  | { ok: true; accelerator: string }
  | { ok: false; output: string; message: string };

const ACCEL_CHECK_TIMEOUT_MS = 20_000;

/**
 * Whether /dev/kvm can be opened for read and write; null when it can, else the reason. Also
 * null when Deno's own permissions forbid the look: it demands --allow-all for any device
 * node, which the CLI's task never has. The emulator then answers for itself: it exits at
 * once without acceleration and the boot step quotes its log.
 *
 * Null as well off Linux, where there is no /dev/kvm to look at: `checkHardwareAcceleration`
 * is the gate there, and a caller that can only ask this synchronously leaves the answer to the
 * emulator, as it does for a permission wall.
 */
export function kvmProblem(device = "/dev/kvm"): string | null {
  if (Deno.build.os !== "linux") return null;
  try {
    Deno.openSync(device, { read: true, write: true }).close();
    return null;
  } catch (error) {
    if (error instanceof Deno.errors.NotCapable) return null;
    return `${device} is not usable: ${(error as Error).message}. ` +
      `Enable virtualization and add your user to the kvm group.`;
  }
}

/** What each non-Linux platform accepts, and what to do when none of it is usable. */
const ACCEL_RULES = {
  windows: {
    accelerators: ["WHPX", "AEHD", "HAXM"],
    fix: 'Enable "Windows Hypervisor Platform" in Windows Features and reboot.',
  },
  darwin: {
    accelerators: ["HVF"],
    fix: "Hypervisor.framework (HVF) needs a Mac whose CPU supports virtualization, and it is " +
      "not available inside most virtual machines.",
  },
} as const;

/**
 * Whether the emulator can use hardware acceleration on `host`. Linux keeps the KVM check.
 * Windows and macOS run `<emulatorPath> -accel-check` and accept it when it exits 0 and names an
 * accelerator the platform supports; otherwise `message` quotes what it said and names the fix.
 */
export async function checkHardwareAcceleration(
  host: AndroidHostEnv,
  runner: CommandRunner,
  emulatorPath: string,
): Promise<AccelCheck> {
  if (host.platform === "linux") {
    const problem = kvmProblem();
    return problem === null
      ? { ok: true, accelerator: "KVM" }
      : { ok: false, output: "", message: problem };
  }
  const rule = ACCEL_RULES[host.platform];
  let output: string;
  let code: number;
  try {
    const result = await runner.run(emulatorPath, ["-accel-check"], {
      timeoutMs: ACCEL_CHECK_TIMEOUT_MS,
    });
    code = result.code;
    output = `${result.stdout}${result.stderr}`.trim();
  } catch (error) {
    code = -1;
    output = `could not run ${emulatorPath} -accel-check: ${(error as Error).message}`;
  }
  if (code === 0) {
    const named = new RegExp(`\\b(${rule.accelerators.join("|")})\\b`, "i").exec(output);
    if (named) return { ok: true, accelerator: named[1]!.toUpperCase() };
  }
  return {
    ok: false,
    output,
    message: `hardware acceleration for the emulator is not usable: ` +
      `\`emulator -accel-check\` said (exit ${code}): ${output || "nothing"}\n${rule.fix}`,
  };
}
