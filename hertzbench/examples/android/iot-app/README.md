# iot-app

A minimal Android app for Hertzbench's `board: android` node. It sends `GET /status` to the board
named by the `board_url` launch extra once a second, over the Wi-Fi network, and logs each outcome
under the `HZB` logcat tag, which a scenario turns into serial lines of the phone node:

| Logcat line (tag `HZB`)                  | Meaning                                           |
| ---------------------------------------- | ------------------------------------------------- |
| `polling <url> every 1000 ms`            | started                                           |
| `status ok 200 <first line of the body>` | the board answered                                |
| `status http <code>`                     | the board answered with another status            |
| `status failed: <exception> <message>`   | no answer: timeout, refused, unreachable          |
| `status failed: no Wi-Fi network`        | the guest has no Wi-Fi network yet                |
| `no board_url extra; nothing to poll`    | launched without `--es board_url http://<board>/` |

The scenarios that run it are `scenarios/examples/android-web-scripted.yaml` (a scripted board) and
`android-web-esp32.yaml` (an ESP32). Each asserts on these lines, on the board's own log of the same
request, and on the phone's frames on the medium before and after it is walked out of range.

## Build

The APK is not committed and `deno task test` does not build it. It needs a JDK (17 or newer), the
Android SDK with platform 35 and build-tools 35, and Gradle 8.13 (there is no wrapper in the tree):

```sh
export ANDROID_HOME=~/Android
cd examples/android/iot-app
gradle assembleDebug   # app/build/outputs/apk/debug/app-debug.apk
```

The plugins (Android Gradle plugin 8.9.1, Kotlin 2.1.20) come from Google's and Maven Central's
repositories; the app has no dependencies of its own. The APK path is the one the example scenarios
name, so `deno task hertzbench validate` reports it as missing until you build.

## Run

Needs Linux with KVM and an AVD named `pixel8` (see `docs/scenario-format.md`, `board: android`):

```sh
deno task hertzbench run scenarios/examples/android-web-scripted.yaml
```

To try the app by hand against any HTTP server on the host, install it and launch it with the extra:

```sh
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -W -n dev.hertzbench.iotapp/.MainActivity --es board_url http://10.0.2.2:8080/
adb logcat -s HZB:V
```

The manifest allows cleartext HTTP (Android blocks it by default since API 28) because the simulated
boards do not speak TLS.
