// A heads-up before the emulator boots: an AVD that asks for more RAM than the host has free
// starts swapping or gets killed, and the boot step only sees a timeout. The check never fails
// a run; it prints one line. Readers are injected, so a test supplies the host's answers.

import type { AndroidHostEnv } from "./platform.ts";

/** How `freeRamMb` looks at the host: a file's text and a command's output, undefined if unreadable. */
export interface RamReaders {
  readFile(path: string): string | undefined;
  run(cmd: string, args: string[]): string | undefined;
}

/** What an AVD without `hw.ramSize` in its config gets from the emulator. */
const DEFAULT_AVD_RAM_MB = 2048;

/** The host's free memory in MB (Linux: MemAvailable); undefined when it cannot be read. */
export function freeRamMb(host: AndroidHostEnv, readers: RamReaders): number | undefined {
  try {
    switch (host.platform) {
      case "linux": {
        const meminfo = readers.readFile("/proc/meminfo") ?? "";
        const kb = /^MemAvailable:\s+(\d+) kB/m.exec(meminfo) ??
          /^MemFree:\s+(\d+) kB/m.exec(meminfo);
        return kb ? Math.floor(Number(kb[1]) / 1024) : undefined;
      }
      case "windows": {
        // FreePhysicalMemory is in KB
        const out = readers.run("powershell", [
          "-NoProfile",
          "-Command",
          "(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory",
        ]);
        const kb = /^\s*(\d+)\s*$/m.exec(out ?? "");
        return kb ? Math.floor(Number(kb[1]) / 1024) : undefined;
      }
      case "darwin": {
        const out = readers.run("vm_stat", []) ?? "";
        const pageSize = /page size of (\d+) bytes/.exec(out);
        if (!pageSize) return undefined;
        let pages = 0;
        for (const name of ["free", "inactive", "speculative"]) {
          const count = new RegExp(`^Pages ${name}:\\s+(\\d+)`, "m").exec(out);
          if (!count) return undefined;
          pages += Number(count[1]);
        }
        return Math.floor((pages * Number(pageSize[1])) / (1024 * 1024));
      }
    }
  } catch {
    return undefined;
  }
}

/** One plain line with both numbers, or undefined when `freeMb` covers `requiredMb`. */
export function ramWarning(requiredMb: number, freeMb: number): string | undefined {
  if (freeMb >= requiredMb) return undefined;
  return `low memory: the AVD needs ${requiredMb} MB of RAM and the host has ${freeMb} MB free; ` +
    `the emulator may be slow or be killed. Close other programs or lower hw.ramSize.`;
}

/** The RAM an AVD asks for, from `hw.ramSize` in its config.ini. */
export function avdRamMb(avdDir: string, readers: RamReaders): number {
  const config = readers.readFile(`${avdDir}/config.ini`) ?? "";
  const size = /^hw\.ramSize\s*=\s*(\d+)/m.exec(config);
  return size ? Number(size[1]) : DEFAULT_AVD_RAM_MB;
}

/** Print the low-memory line for the AVD in `avdDir` to `print`. Never throws, never fails a run. */
export function warnIfLowRam(
  avdDir: string | null,
  host: AndroidHostEnv,
  readers: RamReaders,
  print: (line: string) => void = (line) => console.error(line),
): void {
  try {
    if (avdDir === null) return;
    const free = freeRamMb(host, readers);
    if (free === undefined) return;
    const line = ramWarning(avdRamMb(avdDir, readers), free);
    if (line !== undefined) print(line);
  } catch {
    // a warning is a courtesy: nothing here may stop a boot
  }
}

/** The real host's readers. A permission or command failure reads as undefined. */
export const processRamReaders: RamReaders = {
  readFile(path) {
    try {
      return Deno.readTextFileSync(path);
    } catch {
      return undefined;
    }
  },
  run(cmd, args) {
    try {
      const out = new Deno.Command(cmd, { args, stdin: "null", stdout: "piped", stderr: "null" })
        .outputSync();
      return out.success ? new TextDecoder().decode(out.stdout) : undefined;
    } catch {
      return undefined;
    }
  },
};
