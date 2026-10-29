// `hertzbench android prepare <avd>`: save the snapshot that `snapshot: true` android nodes boot
// from (docs/android-device-plan.md, piece 6). Kept apart from main.ts because it takes an AVD
// name where every other command takes a scenario file.

import { PRODUCT } from "../brand.ts";
import { BoardError } from "../orchestrator/boards/board.ts";
import {
  findAndroidTools,
  PREPARED_SNAPSHOT,
  prepareSnapshot,
} from "../orchestrator/boards/android/tooling.ts";

export const ANDROID_USAGE = `Usage:
  ${PRODUCT.cli} android prepare <avd>

prepare   Boot the AVD once with the flags a run uses, save the snapshot "${PREPARED_SNAPSHOT}" in
          it and stop it. Scenarios with \`snapshot: true\` in an android section boot that
          snapshot, which is faster than a cold boot and lets several android nodes share a run.
          The AVD must not be running, and its own snapshots are left alone. Run it again after
          the emulator is updated.
`;

/** Exit status: 0 prepared, 2 bad usage or an environment that cannot do it. */
export async function androidCommand(argv: string[]): Promise<number> {
  const [subcommand, avd, ...rest] = argv;
  if (subcommand === "--help" || subcommand === "-h") {
    console.error(ANDROID_USAGE);
    return 0;
  }
  if (subcommand !== "prepare") {
    console.error(
      `${
        subcommand === undefined
          ? "android needs a subcommand"
          : `unknown android subcommand ${JSON.stringify(subcommand)}`
      }\n\n${ANDROID_USAGE}`,
    );
    return 2;
  }
  if (avd === undefined || avd.startsWith("-")) {
    console.error(`android prepare needs the name of an AVD\n\n${ANDROID_USAGE}`);
    return 2;
  }
  if (rest.length > 0) {
    console.error(`unexpected argument ${rest[0]}\n\n${ANDROID_USAGE}`);
    return 2;
  }
  try {
    console.error(`[${PRODUCT.slug}] booting ${avd} to save its snapshot; this takes a minute`);
    const { snapshotDir, emulatorVersion } = await prepareSnapshot(findAndroidTools(), avd);
    console.log(
      `${avd}: snapshot ${PREPARED_SNAPSHOT} saved in ${snapshotDir} (emulator ${emulatorVersion})`,
    );
    return 0;
  } catch (error) {
    if (error instanceof BoardError) {
      console.error(`${PRODUCT.cli}: ${error.message}`);
      return 2;
    }
    throw error;
  }
}
