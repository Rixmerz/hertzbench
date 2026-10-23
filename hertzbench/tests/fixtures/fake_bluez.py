"""A stand-in for bluetoothd, and a phone, on a private session bus.

Run under dbus-run-session by tests/bridge_ble_test.ts:
    fake_bluez.py REPORT.json HELPER.py

It owns org.bluez with the two managers the BLE bridge's helper registers
with, starts the helper (which inherits this process's stdin and stdout, so
the test talks to the helper directly), and once the helper has registered
it plays the phone: read the 0xFF01 characteristic, write it, write a value
the node refuses, subscribe, and wait for one notification. Everything it saw
goes to REPORT.json when the helper exits. Nothing is printed on stdout.
"""

import json
import subprocess
import sys

import gi

gi.require_version("Gio", "2.0")
gi.require_version("GLib", "2.0")
from gi.repository import Gio, GLib

report_path, helper = sys.argv[1], sys.argv[2]
CHAR_UUID = "0000ff01-0000-1000-8000-00805f9b34fb"
CHAR = "org.bluez.GattCharacteristic1"
XML = Gio.DBusNodeInfo.new_for_xml("""
<node>
  <interface name="org.bluez.GattManager1">
    <method name="RegisterApplication"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/></method>
    <method name="UnregisterApplication"><arg type="o" direction="in"/></method>
  </interface>
  <interface name="org.bluez.LEAdvertisingManager1">
    <method name="RegisterAdvertisement"><arg type="o" direction="in"/><arg type="a{sv}" direction="in"/></method>
    <method name="UnregisterAdvertisement"><arg type="o" direction="in"/></method>
  </interface>
</node>""")

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
              GLib.Variant("(su)", ("org.bluez", 4)), None, Gio.DBusCallFlags.NONE, -1, None)
loop = GLib.MainLoop()
state = {"objects": {}, "advertisement": {}, "unregistered": [], "phone": [], "notified": []}
registered = {"app": None, "adv": None}


def log(entry):
    state["phone"].append(entry)


def call(sender, path, iface, method, args, signature, done):
    def finish(conn, result):
        try:
            done(conn.call_finish(result).unpack(), None)
        except GLib.Error as error:
            done(None, Gio.DBusError.get_remote_error(error) or error.message)

    bus.call(sender, path, iface, method, args, GLib.VariantType(signature) if signature else None,
             Gio.DBusCallFlags.NONE, -1, None, finish)


def phone():
    sender, _ = registered["app"]
    char_path = next(p for p, ifaces in state["objects"].items()
                     if ifaces.get(CHAR, {}).get("UUID") == CHAR_UUID)

    def on_changed(_conn, _sender, _path, _iface, _signal, params):
        iface, changed, _ = params.unpack()
        if iface == CHAR and "Value" in changed:
            state["notified"].append(bytes(changed["Value"]).decode())

    bus.signal_subscribe(sender, "org.freedesktop.DBus.Properties", "PropertiesChanged", char_path,
                         None, Gio.DBusSignalFlags.NONE, on_changed)

    def step_read():
        call(sender, char_path, CHAR, "ReadValue", GLib.Variant("(a{sv})", ({},)), "(ay)",
             lambda r, e: (log({"read": bytes(r[0]).decode() if r else None, "error": e}), step_write()))

    def write(value, then):
        options = {"type": GLib.Variant("s", "request")}
        call(sender, char_path, CHAR, "WriteValue", GLib.Variant("(aya{sv})", (value, options)), None,
             lambda _r, e: (log({"write": value.decode(), "error": e}), then()))

    def step_write():
        write(b"hello", lambda: write(b"nope", step_subscribe))

    def step_subscribe():
        call(sender, char_path, CHAR, "StartNotify", None, None, lambda _r, e: log({"subscribe": e}))

    step_read()


def method_call(_conn, sender, _path, iface, method, params, invocation):
    args = params.unpack()
    if method.startswith("Unregister"):
        state["unregistered"].append(method)
        invocation.return_value(None)
        return
    if method == "RegisterApplication":
        def got(result, error):
            if error:
                invocation.return_dbus_error("org.bluez.Error.Failed", error)
                return
            state["objects"] = result[0]
            registered["app"] = (sender, args[0])
            invocation.return_value(None)
            if registered["adv"]:
                GLib.idle_add(phone)
        call(sender, args[0], "org.freedesktop.DBus.ObjectManager", "GetManagedObjects", None,
             "(a{oa{sa{sv}}})", got)
    else:
        def got_adv(result, error):
            state["advertisement"] = result[0] if result else {"error": error}
            registered["adv"] = (sender, args[0])
            invocation.return_value(None)
            if registered["app"]:
                GLib.idle_add(phone)
        call(sender, args[0], "org.freedesktop.DBus.Properties", "GetAll",
             GLib.Variant("(s)", ("org.bluez.LEAdvertisement1",)), "(a{sv})", got_adv)


for name in ("org.bluez.GattManager1", "org.bluez.LEAdvertisingManager1"):
    bus.register_object("/org/bluez/hci0", XML.lookup_interface(name), method_call, None, None)

child = subprocess.Popen([sys.executable, "-I", helper, "--bus", "session", "--adapter", "hci0"])


def on_exit(_pid, status):
    state["helper_exit"] = status
    with open(report_path, "w") as f:
        json.dump(state, f, default=lambda v: bytes(v).decode() if isinstance(v, (bytes, bytearray)) else str(v))
    loop.quit()


GLib.child_watch_add(GLib.PRIORITY_DEFAULT, child.pid, on_exit)
loop.run()
