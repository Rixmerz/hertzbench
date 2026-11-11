# ble-app

A minimal Android app for a BLE scenario's top-level `android:` section. It scans for the device the
Hertzbench BLE bridge advertises through the emulator's netsim (the `device_name` launch extra,
default `hzb sensor-1`), connects, subscribes to characteristic `0xFF01` of service `0xFF00` and
reads it once a second. Each step is logged under the `HZB` logcat tag, which a scenario turns into
serial lines of the bridge's id:

| Logcat line (tag `HZB`)            | Meaning                                         |
| ---------------------------------- | ----------------------------------------------- |
| `scanning for "<name>"`            | started, or rescanning after a disconnection    |
| `found "<name>" <addr> rssi=<n>`   | the bridge's advertisement was seen             |
| `connected status=<n>`             | GATT connected                                  |
| `services discovered`              | `0xFF00`/`0xFF01` found                         |
| `subscribed status=<n>`            | notifications on `0xFF01` enabled               |
| `got reading "<value>"`            | a read of `0xFF01` succeeded                    |
| `got notification "<value>"`       | the sensor notified `0xFF01` through the bridge |
| `disconnected status=<n>`          | the link ended; it scans again after 2 s        |

`scenarios/examples/android-ble-scripted.yaml` runs it against a scripted `sensor-1`, and `scenarios/examples/android-ble-esp32.yaml` against the real `fw/ble-sensor` ESP32 firmware.

It needs the `BLUETOOTH_SCAN` and `BLUETOOTH_CONNECT` runtime permissions, which the launcher
grants by installing with `adb install -g`; it does not ask for them itself. `minSdk` is 33.

## Build

The APK is not committed and `deno task test` does not build it. It needs a JDK (17 or newer), the
Android SDK with platform 35 and build-tools 35, and Gradle 8.13 (there is no wrapper in the tree):

```sh
export ANDROID_HOME=~/Android
cd examples/android/ble-app
gradle assembleDebug   # app/build/outputs/apk/debug/app-debug.apk
```
