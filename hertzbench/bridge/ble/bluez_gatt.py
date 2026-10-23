#!/usr/bin/env python3
"""hertzbench BLE bridge helper: a GATT peripheral on BlueZ, driven over stdio.

The BLE bridge (bridge/ble/bluez.ts) starts this process, hands it the GATT
table it discovered on a simulated node, and answers every operation a phone
makes on it. This process only speaks D-Bus to BlueZ (org.bluez.GattManager1
and org.bluez.LEAdvertisingManager1, BlueZ's doc/org.bluez.GattManager.rst and
doc/org.bluez.LEAdvertisingManager.rst); it decides nothing.

Protocol, one JSON object per line.
  stdin  {"op": "start", "name": str, "services": [{"uuid": str,
              "characteristics": [{"id": int, "uuid": str, "flags": [str]}]}]}
         {"op": "reply", "id": int, "value": base64} or
         {"op": "reply", "id": int, "error": "failed" | "not-permitted", "message": str}
         {"op": "notify", "char": int, "value": base64}
         {"op": "stop"}
  stdout {"event": "ready"} once BlueZ accepted the application and the advertisement
         {"event": "error", "message": str}, then the process exits 1
         {"event": "read", "id": int, "char": int}
         {"event": "write", "id": int | null, "char": int, "value": base64}
             (id null: a write command, already answered)
         {"event": "subscribe", "char": int, "enabled": bool}

Needs PyGObject (python-gobject on Arch, python3-gi on Debian and Ubuntu) and
a running bluetoothd. Registering on the system bus may need the user in the
group your distribution gives BlueZ access to.
"""

import argparse
import base64
import json
import os
import sys

try:
    import gi

    gi.require_version("Gio", "2.0")
    gi.require_version("GLib", "2.0")
    from gi.repository import Gio, GLib
except (ImportError, ValueError) as error:  # pragma: no cover - depends on the host
    sys.stderr.write(
        f"hertzbench: PyGObject is needed for the BLE bridge ({error}); install python-gobject "
        "(Arch) or python3-gi (Debian, Ubuntu)\n"
    )
    sys.exit(2)

BLUEZ = "org.bluez"
APP_PATH = "/org/hertzbench/bridge"
ADV_PATH = APP_PATH + "/advertisement0"
PROPERTIES = "org.freedesktop.DBus.Properties"
SERVICE_IFACE = "org.bluez.GattService1"
CHAR_IFACE = "org.bluez.GattCharacteristic1"
ADV_IFACE = "org.bluez.LEAdvertisement1"

INTROSPECTION = Gio.DBusNodeInfo.new_for_xml(
    """
<node>
  <interface name="org.freedesktop.DBus.ObjectManager">
    <method name="GetManagedObjects">
      <arg type="a{oa{sa{sv}}}" direction="out"/>
    </method>
  </interface>
  <interface name="org.bluez.GattService1">
    <property name="UUID" type="s" access="read"/>
    <property name="Primary" type="b" access="read"/>
  </interface>
  <interface name="org.bluez.GattCharacteristic1">
    <method name="ReadValue">
      <arg type="a{sv}" direction="in"/>
      <arg type="ay" direction="out"/>
    </method>
    <method name="WriteValue">
      <arg type="ay" direction="in"/>
      <arg type="a{sv}" direction="in"/>
    </method>
    <method name="StartNotify"/>
    <method name="StopNotify"/>
    <property name="UUID" type="s" access="read"/>
    <property name="Service" type="o" access="read"/>
    <property name="Flags" type="as" access="read"/>
    <property name="Value" type="ay" access="read"/>
    <property name="Notifying" type="b" access="read"/>
  </interface>
  <interface name="org.bluez.LEAdvertisement1">
    <method name="Release"/>
    <property name="Type" type="s" access="read"/>
    <property name="ServiceUUIDs" type="as" access="read"/>
    <property name="LocalName" type="s" access="read"/>
  </interface>
</node>
"""
)

# The flags BlueZ takes, from the bridge's property names (they are the same words).
KNOWN_FLAGS = {"read", "write", "write-without-response", "notify", "indicate"}


def interface(name):
    return INTROSPECTION.lookup_interface(name)


def emit(event):
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def table_objects(name, services):
    """The object tree BlueZ reads with GetManagedObjects: path -> interface -> properties.

    Pure, so it is tested without D-Bus (tests/bridge_ble_test.ts runs it).
    """
    objects = {}
    chars = {}
    for i, service in enumerate(services):
        service_path = f"{APP_PATH}/service{i}"
        objects[service_path] = {
            SERVICE_IFACE: {"UUID": ("s", service["uuid"]), "Primary": ("b", True)}
        }
        for j, char in enumerate(service["characteristics"]):
            path = f"{service_path}/char{j}"
            flags = [f for f in char["flags"] if f in KNOWN_FLAGS]
            objects[path] = {
                CHAR_IFACE: {
                    "UUID": ("s", char["uuid"]),
                    "Service": ("o", service_path),
                    "Flags": ("as", flags),
                    "Value": ("ay", b""),
                    "Notifying": ("b", False),
                }
            }
            chars[path] = char["id"]
    advertisement = {
        ADV_IFACE: {
            "Type": ("s", "peripheral"),
            "ServiceUUIDs": ("as", [s["uuid"] for s in services][:1]),
            "LocalName": ("s", name),
        }
    }
    return objects, chars, advertisement


class Bridge:
    def __init__(self, bus, adapter, loop):
        self.bus = bus
        self.adapter_path = f"/org/bluez/{adapter}"
        self.loop = loop
        self.objects = {}
        self.advertisement = {}
        self.char_ids = {}
        self.paths_by_id = {}
        self.registrations = []
        self.pending = {}
        self.next_id = 1
        self.registered = {"app": False, "adv": False}

    # ── D-Bus objects ────────────────────────────────────────────────────

    def variant(self, typed):
        signature, value = typed
        return GLib.Variant(signature, value)

    def managed_objects(self):
        return {
            path: {iface: {k: self.variant(v) for k, v in props.items()} for iface, props in ifaces.items()}
            for path, ifaces in self.objects.items()
        }

    def get_property(self, _conn, _sender, path, iface, prop):
        table = self.advertisement if path == ADV_PATH else self.objects.get(path, {})
        return self.variant(table[iface][prop])

    def method_call(self, _conn, _sender, path, iface, method, params, invocation):
        if method == "GetManagedObjects":
            invocation.return_value(GLib.Variant("(a{oa{sa{sv}}})", (self.managed_objects(),)))
        elif method == "Release":
            invocation.return_value(None)
        elif method == "ReadValue":
            self.ask(invocation, {"event": "read", "char": self.char_ids[path]})
        elif method == "WriteValue":
            value, options = params.unpack()
            payload = {
                "event": "write",
                "char": self.char_ids[path],
                "value": base64.b64encode(bytes(value)).decode(),
            }
            if options.get("type") == "command":
                invocation.return_value(None)
                emit({**payload, "id": None})
            else:
                self.ask(invocation, payload)
        elif method in ("StartNotify", "StopNotify"):
            enabled = method == "StartNotify"
            self.set_char(path, "Notifying", ("b", enabled))
            invocation.return_value(None)
            emit({"event": "subscribe", "char": self.char_ids[path], "enabled": enabled})
        else:
            invocation.return_dbus_error("org.bluez.Error.NotSupported", method)

    def ask(self, invocation, event):
        request = self.next_id
        self.next_id += 1
        self.pending[request] = invocation
        emit({**event, "id": request})

    def set_char(self, path, prop, typed):
        self.objects[path][CHAR_IFACE][prop] = typed
        self.bus.emit_signal(
            None,
            path,
            PROPERTIES,
            "PropertiesChanged",
            GLib.Variant("(sa{sv}as)", (CHAR_IFACE, {prop: self.variant(typed)}, [])),
        )

    def register(self, path, iface):
        self.registrations.append(
            self.bus.register_object(path, interface(iface), self.method_call, self.get_property, None)
        )

    # ── commands from the bridge ─────────────────────────────────────────

    def start(self, message):
        self.objects, self.char_ids, self.advertisement = table_objects(message["name"], message["services"])
        self.paths_by_id = {char_id: path for path, char_id in self.char_ids.items()}
        self.register(APP_PATH, "org.freedesktop.DBus.ObjectManager")
        for path, ifaces in self.objects.items():
            for iface in ifaces:
                self.register(path, iface)
        self.register(ADV_PATH, ADV_IFACE)
        self.call("org.bluez.GattManager1", "RegisterApplication", APP_PATH, "app")
        self.call("org.bluez.LEAdvertisingManager1", "RegisterAdvertisement", ADV_PATH, "adv")

    def call(self, iface, method, path, key):
        def done(bus, result):
            try:
                bus.call_finish(result)
            except GLib.Error as error:
                emit({"event": "error", "message": f"BlueZ refused {method} on {self.adapter_path}: {error.message}"})
                self.loop.quit()
                return
            self.registered[key] = True
            if all(self.registered.values()):
                emit({"event": "ready"})

        self.bus.call(
            BLUEZ,
            self.adapter_path,
            iface,
            method,
            GLib.Variant("(oa{sv})", (path, {})),
            None,
            Gio.DBusCallFlags.NONE,
            -1,
            None,
            done,
        )

    def reply(self, message):
        invocation = self.pending.pop(message["id"], None)
        if invocation is None:
            return
        if "error" in message:
            name = "org.bluez.Error.NotPermitted" if message["error"] == "not-permitted" else "org.bluez.Error.Failed"
            invocation.return_dbus_error(name, message.get("message", "failed"))
        elif invocation.get_method_name() == "ReadValue":
            value = base64.b64decode(message.get("value", ""))
            invocation.return_value(GLib.Variant("(ay)", (value,)))
        else:
            invocation.return_value(None)

    def notify(self, message):
        path = self.paths_by_id.get(message["char"])
        if path is None or not self.objects[path][CHAR_IFACE]["Notifying"][1]:
            return
        self.set_char(path, "Value", ("ay", base64.b64decode(message["value"])))

    def stop(self):
        for iface, method, path in (
            ("org.bluez.LEAdvertisingManager1", "UnregisterAdvertisement", ADV_PATH),
            ("org.bluez.GattManager1", "UnregisterApplication", APP_PATH),
        ):
            try:
                self.bus.call_sync(BLUEZ, self.adapter_path, iface, method, GLib.Variant("(o)", (path,)),
                                   None, Gio.DBusCallFlags.NONE, 2000, None)
            except GLib.Error:
                pass  # bluetoothd may already have dropped them, e.g. when it restarted
        self.loop.quit()


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--adapter", default="hci0")
    parser.add_argument("--bus", choices=["system", "session"], default="system")
    args = parser.parse_args()

    loop = GLib.MainLoop()
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SYSTEM if args.bus == "system" else Gio.BusType.SESSION, None)
    except GLib.Error as error:
        emit({"event": "error", "message": f"cannot reach the {args.bus} D-Bus: {error.message}"})
        return 1
    bridge = Bridge(bus, args.adapter, loop)
    pending = b""

    fd = sys.stdin.fileno()

    def on_stdin(_channel, condition):
        nonlocal pending
        chunk = os.read(fd, 65536) if condition & GLib.IO_IN else b""
        if not chunk:
            bridge.stop()  # the bridge went away: withdraw everything
            return False
        pending += chunk
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            if not line.strip():
                continue
            message = json.loads(line)
            op = message.get("op")
            if op == "start":
                bridge.start(message)
            elif op == "reply":
                bridge.reply(message)
            elif op == "notify":
                bridge.notify(message)
            elif op == "stop":
                bridge.stop()
                return False
        return True

    GLib.io_add_watch(GLib.IOChannel.unix_new(fd), GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP, on_stdin)
    loop.run()
    return 0 if all(bridge.registered.values()) or not bridge.objects else 1


if __name__ == "__main__":
    sys.exit(main())
