"""
Tests for the hertzbench additions to the ESP32 worker's launch arguments:
the Wi-Fi NIC on a QEMU `stream` netdev (instead of SLIRP) and the per-board
eFuse image. They call the SHIPPED `wifi_nic_arg`, `efuse_drive_args` and
`valid_tcp_port`, and run the worker itself for the config boundary.

Nothing here needs libqemu; whether QEMU accepts these arguments can only be
settled on a host that has it (hertzbench/docs/e2e-esp32.md).
"""
import json
import pathlib
import subprocess
import sys
import unittest

from app.services.esp32_worker import efuse_drive_args, valid_tcp_port, wifi_nic_arg

WORKER = pathlib.Path(__file__).resolve().parents[3] / 'backend' / 'app' / 'services' / 'esp32_worker.py'


class TestL2NicArg(unittest.TestCase):
    def test_classic_esp32_gets_a_stream_netdev_to_the_engine(self):
        arg = wifi_nic_arg('esp32-picsimlab', wifi_enabled=True, l2_port=40123)
        self.assertEqual(
            arg,
            'stream,model=esp32_wifi,server=off,'
            'addr.type=inet,addr.host=127.0.0.1,addr.port=40123',
        )

    def test_l2_replaces_slirp_entirely(self):
        arg = wifi_nic_arg('esp32-picsimlab', wifi_enabled=True, hostfwd_port=8080, l2_port=40123)
        self.assertNotIn('user', arg.split(',')[0])
        self.assertNotIn('hostfwd', arg)
        self.assertNotIn('net=192.168.4.0/24', arg)

    def test_radio_is_attached_even_when_the_sketch_looks_wifi_less(self):
        # Same rule as SLIRP (issue #260): a real ESP32 always has a radio.
        self.assertIsNotNone(wifi_nic_arg('esp32-picsimlab', wifi_enabled=False, l2_port=40123))

    def test_machines_without_a_radio_still_get_none(self):
        self.assertIsNone(wifi_nic_arg('esp32s3-picsimlab', wifi_enabled=True, l2_port=40123))
        self.assertIsNone(wifi_nic_arg('esp32c3-picsimlab', wifi_enabled=False, l2_port=40123))

    def test_without_l2_port_nothing_changes(self):
        """The Velxio behaviour, byte for byte."""
        self.assertEqual(
            wifi_nic_arg('esp32-picsimlab', wifi_enabled=True),
            'user,model=esp32_wifi,net=192.168.4.0/24',
        )
        self.assertEqual(
            wifi_nic_arg('esp32-picsimlab', wifi_enabled=True, hostfwd_port=12345),
            'user,model=esp32_wifi,net=192.168.4.0/24,hostfwd=tcp::12345-192.168.4.15:80',
        )
        self.assertEqual(
            wifi_nic_arg('esp32-picsimlab', wifi_enabled=True, l2_port=0),
            'user,model=esp32_wifi,net=192.168.4.0/24',
        )

    def test_a_bad_port_is_an_error_not_an_argument(self):
        for bad in (-1, 65536, '40123', 1.5, True, '1,addr.host=evil'):
            with self.subTest(port=bad):
                with self.assertRaises(ValueError):
                    wifi_nic_arg('esp32-picsimlab', wifi_enabled=True, l2_port=bad)


class TestValidTcpPort(unittest.TestCase):
    def test_accepts_real_ports_only(self):
        self.assertTrue(valid_tcp_port(1))
        self.assertTrue(valid_tcp_port(65535))
        for bad in (0, -5, 65536, '80', None, 80.0, True, False):
            with self.subTest(value=bad):
                self.assertFalse(valid_tcp_port(bad))


class TestEfuseDriveArgs(unittest.TestCase):
    def test_drive_and_global_binding(self):
        self.assertEqual(
            efuse_drive_args('/tmp/run/efuse-a.bin'),
            [
                '-drive', 'file=/tmp/run/efuse-a.bin,if=none,format=raw,id=hzb-efuse',
                '-global', 'driver=nvram.esp32.efuse,property=drive,value=hzb-efuse',
            ],
        )

    def test_a_comma_in_the_path_cannot_inject_an_option(self):
        args = efuse_drive_args('/tmp/a,readonly=on/efuse.bin')
        self.assertEqual(args[1], 'file=/tmp/a,,readonly=on/efuse.bin,if=none,format=raw,id=hzb-efuse')


class TestWorkerConfigBoundary(unittest.TestCase):
    """The real entrypoint: bad hertzbench fields stop the worker before it loads libqemu."""

    def run_worker(self, config: dict) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(WORKER)],
            input=json.dumps(config) + '\n',
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )

    def base(self, **extra) -> dict:
        return {'lib_path': '/nonexistent/libqemu-xtensa.so', 'firmware_b64': 'AA==', **extra}

    def test_a_bad_l2_port_stops_the_worker(self):
        result = self.run_worker(self.base(wifi_l2_port='abc'))
        self.assertEqual(result.returncode, 1)
        self.assertIn('wifi_l2_port must be a TCP port number', result.stderr)
        self.assertNotIn('Loading library', result.stderr)

    def test_a_missing_efuse_image_stops_the_worker(self):
        result = self.run_worker(self.base(efuse_image='/nonexistent/efuse.bin'))
        self.assertEqual(result.returncode, 1)
        self.assertIn('efuse_image must be the path of an existing file', result.stderr)
        self.assertNotIn('Loading library', result.stderr)

    def test_good_fields_reach_the_library_load(self):
        result = self.run_worker(self.base(wifi_l2_port=40123))
        self.assertIn('Loading library', result.stderr)


if __name__ == '__main__':
    unittest.main()
