# Android nodes: setup, platforms and two nodes in one run

An Android app runs in the Android emulator as a node (`board: android`, see
[scenario-format.md](scenario-format.md#board-android-an-app-in-the-android-emulator-on-wi-fi)).
A run needs the tools below and never installs or creates anything itself. One command does that
beforehand, without Android Studio: `hertzbench android setup`
([below](#android-without-android-studio)).

## What you need

- **The Android SDK**: `emulator` and `adb`, found on `PATH`, in `$ANDROID_HOME`,
  `$ANDROID_SDK_ROOT` or `~/Android`.
- **An AVD** with an x86_64 or arm64 system image. `emulator -list-avds` names the AVDs you have.
- **An APK** for the app, built beforehand. The example app is in `examples/android/`.
- **Hardware acceleration** for the emulator (see the platform table below). Without it the run
  stops before it boots anything, with exit status 2 and the reason.
- **An app that targets Android 17 (API 37) and the bridge.** It needs the runtime permission
  `android.permission.ACCESS_LOCAL_NETWORK` to reach `10.0.2.2` or a LAN host. Manifest line, the
  runtime request and `adb shell pm grant` are in [mobile-bridge.md](mobile-bridge.md#5a-the-ip-bridge),
  reported in [#114](https://github.com/Rixmerz/hertzbench/issues/114).

## Android without Android Studio

Android Studio is not required. Hertzbench starts the emulator and `adb` itself, so the SDK needs only
the command-line tools, the emulator, `platform-tools` and one system image. Without the Studio IDE
open beside the emulator, that RAM stays free for the guest.

### One command: `hertzbench android setup`

```bash
hertzbench android setup --dry-run   # print each step, change nothing
hertzbench android setup             # sdkmanager asks you to accept the licences
hertzbench android setup --accept-licenses
hertzbench android prepare pixel8    # the next step, as the command prints
```

It goes from an empty machine to a bootable `pixel8` AVD:

1. **SDK folder.** `--sdk <dir>`, else `$ANDROID_HOME`, else `$ANDROID_SDK_ROOT`, else the platform
   default: `~/Android/Sdk` on Linux, `~/Library/Android/sdk` on macOS, `%LOCALAPPDATA%\Android\Sdk`
   on Windows. A run looks only in the two variables and that default, so after `--sdk` the command
   tells you to set `ANDROID_HOME`.
2. **Command-line tools**, when `<sdk>/cmdline-tools/latest/bin/sdkmanager` is missing. It prints the
   URL, downloads Google's official zip for your OS from `dl.google.com`, checks its SHA-256 against
   the value Google publishes for that build, and unpacks it to `<sdk>/cmdline-tools/latest`. Hertzbench
   does not bundle or redistribute any Google binary. The unpack uses `unzip` (Linux, macOS) or `tar`
   (Windows 10 and later).
3. **`platform-tools`, `emulator` and one system image** with `sdkmanager`, for the ones not already
   installed. The default image is `system-images;android-36;google_apis;x86_64`
   (`arm64-v8a` on an Arm host); `--image <id>` replaces it. Google's licences are accepted only
   with `--accept-licenses`; without it `sdkmanager` shows them on your terminal and waits for you,
   and setup stops before downloading anything when there is no terminal.
4. **The AVD** with `avdmanager`, unless it exists: `--avd` (default `pixel8`), `--device`
   (default `pixel_8`) and `--ram` (default `2048`, written as a plain number of MB to `hw.ramSize`,
   see step 4 of the manual steps).
5. **The acceleration check** `android prepare` uses, then the next command to run.

Run it again at any time: it skips what exists (the tools, each installed package, the AVD).
`sdkmanager` and `avdmanager` need a Java 17 or newer runtime (`JAVA_HOME` or `java` on `PATH`).
The download needs network permission: the release binary has it; from source, run
`deno run --allow-net ...` or `deno task lan android setup`, as `deno task hertzbench` allows only
127.0.0.1.

Only the dry run, the path rules and the steps with fake tools are tested
(`tests/android_setup_test.ts`). The Linux zip's checksum and layout were checked against Google's
download; the whole command has not been run from an empty SDK, and not on macOS or Windows.

### The manual steps (fallback)

The steps below do by hand what `android setup` does. Use them when the command cannot run, for
example without network permission, or to see what each tool does.

The maintainer's validated AVD is `pixel8`: device `pixel_8`, system image
`system-images;android-36;google_apis;x86_64`, `hw.ramSize` 2048, on Linux with KVM (emulator 37.1.11).
The manual steps below were not rerun from an empty SDK for this page. The `pixel8` AVD on the
maintainer's machine matches them (its `config.ini` and the emulator version were checked). macOS and
Windows are not validated; see the notes after the steps.

1. **Install the command-line tools.** Download "Command line tools only" from
   developer.android.com/studio and unpack it so that `sdkmanager` sits in
   `$ANDROID_HOME/cmdline-tools/latest/bin/`:

   ```bash
   export ANDROID_HOME="$HOME/Android"
   mkdir -p "$ANDROID_HOME/cmdline-tools"
   unzip commandlinetools-linux-*_latest.zip -d "$ANDROID_HOME/cmdline-tools"
   mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
   export PATH="$PATH:$ANDROID_HOME/cmdline-tools/latest/bin"
   ```

2. **Install the emulator, `adb` and one system image** (accept the licences once):

   ```bash
   sdkmanager --licenses
   sdkmanager "platform-tools" "emulator" "system-images;android-36;google_apis;x86_64"
   ```

3. **Create the AVD** with `avdmanager`. Answer `no` when it asks about a custom hardware profile:

   ```bash
   avdmanager create avd -n pixel8 -k "system-images;android-36;google_apis;x86_64" -d pixel_8
   ```

4. **Set the RAM to 2048** in `~/.android/avd/pixel8.avd/config.ini`: `hw.ramSize=2048`. With
   `-d pixel_8`, avdmanager wrote `hw.ramSize=2G` on the machine where this was checked. Hertzbench's
   low-RAM check reads a plain number of MB, so `2G` would be read as 2 MB and the warning would
   never fire. The validated AVD uses `2048`.

5. **Prepare it for the runs**, then give the scenario's `android:` section `avd: pixel8`:

   ```bash
   hertzbench android prepare pixel8
   ```

Hertzbench looks for `emulator` and `adb` on `PATH` first, then in `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`
and `~/Android`, as `emulator/emulator` and `platform-tools/adb` under that folder. A run never runs
`sdkmanager` or `avdmanager`; only `android setup` does. AVDs are read from `$ANDROID_AVD_HOME`, then `$ANDROID_USER_HOME/avd`,
then `~/.android/avd`. `/dev/kvm` must be readable and writable (the check `android prepare` runs).

**macOS (Apple Silicon), not validated by the maintainer.** Use an arm64 image in steps 2 and 3:
`system-images;android-36;google_apis;arm64-v8a` or `system-images;android-36;google_apis_playstore;arm64-v8a`
(both listed by `sdkmanager --list` for API 36). The M2 runs in
[#110](https://github.com/Rixmerz/hertzbench/issues/110) and [#116](https://github.com/Rixmerz/hertzbench/issues/116)
used an Android 17 (API 37) `google_apis_playstore` arm64-v8a image; the API 37 package was not listed here. Hertzbench checks for HVF with `emulator -accel-check`. No Android node
has booted on a Mac yet; see [Platforms](#platforms).

**Windows, not validated by the maintainer.** The same commands with `sdkmanager.bat` and
`avdmanager.bat`, and an x86_64 image. Hertzbench checks WHPX. An AVD has not booted there yet; the
RAM check stopped the emulator on one machine (see [Platforms](#platforms)).

## Platforms

| Platform | How Hertzbench checks acceleration                  | State                                                                                       |
| -------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Linux    | `/dev/kvm` must be readable and writable            | **Validated** on Linux with KVM: `pixel8` AVD, emulator 37.1.11, 2026-11-09 and 2026-11-10 |
| Windows  | `emulator -accel-check` must name WHPX, AEHD or HAXM | **Acceleration gate seen on a real machine, AVD boot not validated** ([issue #102](https://github.com/Rixmerz/hertzbench/issues/102#issuecomment-6883607259) and below) |
| macOS    | `emulator -accel-check` must name HVF               | **Implemented, not validated**: an emulator started by hand on an M2 Mac reached the IP bridge ([#110](https://github.com/Rixmerz/hertzbench/issues/110)), and a Kotlin/Compose app ran there as panel and node in the Android 17 emulator ([#116](https://github.com/Rixmerz/hertzbench/issues/116)), but no `board: android` node has booted on a Mac |

On Windows and macOS the check runs `emulator -accel-check` and accepts it only when the command
exits 0 and names an accelerator of that system. Otherwise the run stops and quotes what the
emulator printed. The tests for these paths run on Linux with a fake SDK and an injected command
runner, so they show the logic, not a real emulator.

One report from a real Windows machine exists, by the reporter of [issue #102](https://github.com/Rixmerz/hertzbench/issues/102), on
2026-11-14 with the v0.4.0 Windows x64 binary and the AVD `Medium_Phone_API_37.0`:
`android prepare` no longer refused the host, the WHPX check passed, and the low-memory warning
printed (the AVD needs 2048 MB, 514 MB were free). The emulator then stopped by itself: the machine
has 4007 MiB of RAM and the emulator asks for at least 4096 MiB. So the gate and the tool lookup ran
on Windows, and no AVD has booted there yet. Treat a booted Android node on Windows, and everything
on macOS, as untested.

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
- **An AVD booting on Windows** (the WHPX gate has run on a real machine; AEHD and HAXM have not),
  and **anything on macOS (HVF)**, see the table.
