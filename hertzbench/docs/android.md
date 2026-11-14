# Android nodes: setup, platforms and two nodes in one run

An Android app runs in the Android emulator as a node (`board: android`, see
[scenario-format.md](scenario-format.md#board-android-an-app-in-the-android-emulator-on-wi-fi)).
Hertzbench does not install Android for you. It needs the tools below, and it never creates or
downloads an AVD.

## What you need

- **The Android SDK**: `emulator` and `adb`, found on `PATH`, in `$ANDROID_HOME`,
  `$ANDROID_SDK_ROOT` or `~/Android`.
- **An AVD** with an x86_64 or arm64 system image. `emulator -list-avds` names the AVDs you have.
- **An APK** for the app, built beforehand. The example app is in `examples/android/`.
- **Hardware acceleration** for the emulator (see the platform table below). Without it the run
  stops before it boots anything, with exit status 2 and the reason.

## Platforms

| Platform | How Hertzbench checks acceleration                  | State                                                                                       |
| -------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Linux    | `/dev/kvm` must be readable and writable            | **Validated** on Linux with KVM: `pixel8` AVD, emulator 37.1.11, 2026-11-09 and 2026-11-10 |
| Windows  | `emulator -accel-check` must name WHPX, AEHD or HAXM | **Implemented, not validated** on a real Windows machine ([issue #102](https://github.com/Rixmerz/hertzbench/issues/102)) |
| macOS    | `emulator -accel-check` must name HVF               | **Implemented, not validated** on a real Mac                                                |

On Windows and macOS the check runs `emulator -accel-check` and accepts it only when the command
exits 0 and names an accelerator of that system. Otherwise the run stops and quotes what the
emulator printed. The tests for these paths run on Linux with a fake SDK and an injected command
runner, so they show the logic, not a real emulator. Until someone runs a node on a Windows or
macOS host, treat those platforms as untested.

## Two Android nodes in one run

Each Android node boots its own emulator. Two nodes in one run must both use `snapshot: true`:
a run may have at most one node that cold-boots.

1. Stop any emulator running on the AVD, then save its snapshot once per AVD:

   ```bash
   hertzbench android prepare <avd>
   ```

   `prepare` boots the AVD once, saves the `hertzbench` snapshot into it, writes a marker next to
   the snapshot and stops. It exits 0, or 2 with the reason. Run it again after every emulator
   update: a snapshot is tied to the emulator build that saved it.

2. Give each node an `android` section with `snapshot: true`, its `avd`, `apk` and `package`. Two
   nodes can name different AVDs, each prepared in step 1, or the same one.

3. Run the scenario as usual: `hertzbench run <scenario.yaml>`. The first line of
   `<out>/<node>-emulator.log` says `snapshot boot` or `cold boot`.

**Memory.** Each emulator takes the RAM its AVD asks for: `hw.ramSize` in the AVD's `config.ini`,
2048 MB when that line is missing. Two nodes therefore need about 4 GB for the two guests alone,
before the host system and Hertzbench. On a 4 GB machine that does not fit. The launcher prints
one `low memory` line when the host's free RAM is below what the AVD asks for, and it never stops
the run for that. To run on less, lower `hw.ramSize` in the AVD's `config.ini`. No lower value has
been tested here.

## Not validated

- **Two real AVDs in one run.** The procedure above is what the code does, and the fake-SDK tests
  cover it. No run has booted two emulators on a real host.
- **The snapshot boot time against a cold boot**, and whether two nodes on one AVD get distinct
  `192.168.4.x` leases on a real emulator.
- **Acceleration on Windows (WHPX, AEHD, HAXM) and macOS (HVF)**, see the table.
