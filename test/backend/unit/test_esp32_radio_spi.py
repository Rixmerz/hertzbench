"""
Tests for the hertzbench radio_spi addition to the ESP32 worker: the config
check and the spi-link client (RadioSpiLink) that puts a radio chip model
(LoRa SX127x, nRF24L01+) on the guest's SPI bus. They call the SHIPPED
`radio_spi_problem` and `RadioSpiLink` against a fake engine on loopback, and
run the worker itself for the config boundary.

Nothing here needs libqemu. hertzbench/tests/spi_link_python_test.ts runs the
same client against the real TypeScript adapter and chip model.
"""
import json
import pathlib
import socket
import subprocess
import sys
import threading
import time
import unittest

from app.services.esp32_worker import RadioSpiLink, radio_spi_problem

WORKER = pathlib.Path(__file__).resolve().parents[3] / 'backend' / 'app' / 'services' / 'esp32_worker.py'


class FakeEngine:
    """A one-connection loopback server that records what the board sent and
    answers each XFER with `miso_for(mosi)`, optionally sending DRIVE first."""

    def __init__(self, miso_for=lambda mosi: mosi ^ 0xFF, drive_before_miso=None, answer=True):
        self.server = socket.socket()
        self.server.bind(('127.0.0.1', 0))
        self.server.listen(1)
        self.port = self.server.getsockname()[1]
        self.received: list = []
        self.miso_for = miso_for
        self.drive_before_miso = drive_before_miso
        self.answer = answer
        self.conn = None
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self):
        self.conn, _ = self.server.accept()
        pending = bytearray()
        while True:
            try:
                chunk = self.conn.recv(4096)
            except OSError:
                return
            if not chunk:
                return
            pending += chunk
            while pending:
                if pending[0] == 0x01 and len(pending) >= 2:
                    mosi = pending[1]
                    self.received.append(('xfer', mosi))
                    del pending[:2]
                    if not self.answer:
                        continue
                    out = b''
                    if self.drive_before_miso is not None:
                        out += bytes((0x03, *self.drive_before_miso))
                    out += bytes((0x81, self.miso_for(mosi)))
                    self.conn.sendall(out)
                elif pending[0] == 0x02 and len(pending) >= 3:
                    self.received.append(('pin', pending[1], pending[2]))
                    del pending[:3]
                else:
                    break

    def send(self, data: bytes):
        self.conn.sendall(data)

    def close(self):
        # shutdown first: a plain close() while _serve sits in recv() sends no FIN.
        try:
            self.conn.shutdown(socket.SHUT_RDWR)
            self.conn.close()
        except (OSError, AttributeError):
            pass
        self.server.close()


def wait_for(predicate, timeout=2.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(0.005)
    return False


class TestRadioSpiProblem(unittest.TestCase):
    def test_a_good_entry_has_no_problem(self):
        self.assertIsNone(radio_spi_problem({'port': 40123, 'cs': 5, 'watch': [5, 14]}))
        self.assertIsNone(radio_spi_problem({'port': 40123, 'cs': 5}))

    def test_each_bad_field_is_named(self):
        cases = [
            ('not an object', 'radio_spi must be an object'),
            ({'port': 'x', 'cs': 5}, 'radio_spi.port'),
            ({'port': 40123, 'cs': True}, 'radio_spi.cs'),
            ({'port': 40123, 'cs': 49}, 'radio_spi.cs'),
            ({'port': 40123, 'cs': 5, 'watch': [5, '14']}, 'radio_spi.watch'),
            ({'port': 40123, 'cs': 5, 'watch': 14}, 'radio_spi.watch'),
        ]
        for value, fragment in cases:
            with self.subTest(value=value):
                self.assertIn(fragment, radio_spi_problem(value))


class TestRadioSpiLink(unittest.TestCase):
    def setUp(self):
        self.errors: list = []
        self.drives: list = []

    def link(self, engine, **kw):
        link = RadioSpiLink(engine.port, on_drive=lambda g, l: self.drives.append((g, l)),
                            on_error=self.errors.append, **kw)
        self.addCleanup(link.close)
        self.addCleanup(engine.close)
        return link

    def test_bytes_and_pin_edges_reach_the_engine_in_order(self):
        engine = FakeEngine()
        link = self.link(engine)
        link.pin(5, 0)
        self.assertEqual(link.transfer(0x42), 0xBD)
        self.assertEqual(link.transfer(0x00), 0xFF)
        link.pin(5, 1)
        self.assertTrue(wait_for(lambda: len(engine.received) == 4))
        self.assertEqual(engine.received, [('pin', 5, 0), ('xfer', 0x42), ('xfer', 0x00), ('pin', 5, 1)])
        self.assertEqual(self.errors, [])

    def test_a_drive_while_a_transfer_waits_does_not_deadlock(self):
        # The QEMU thread holds the IO-thread lock while it waits for MISO;
        # applying the DRIVE needs that lock. The MISO must still come back.
        bql = threading.Lock()
        engine = FakeEngine(drive_before_miso=(26, 1))

        def on_drive(gpio, level):
            with bql:
                self.drives.append((gpio, level))

        link = RadioSpiLink(engine.port, on_drive=on_drive, on_error=self.errors.append)
        self.addCleanup(link.close)
        self.addCleanup(engine.close)
        with bql:
            started = time.monotonic()
            self.assertEqual(link.transfer(0x12), 0xED)
            self.assertLess(time.monotonic() - started, 0.5)
        self.assertTrue(wait_for(lambda: self.drives == [(26, 1)]))
        self.assertEqual(self.errors, [])

    def test_an_engine_that_never_answers_gives_ff_once_and_reports_it(self):
        engine = FakeEngine(answer=False)
        link = self.link(engine, timeout_s=0.2)
        self.assertEqual(link.transfer(0x01), 0xFF)
        self.assertEqual(link.transfer(0x02), 0xFF)  # at once: the link is down
        self.assertEqual(len(self.errors), 1)
        self.assertIn('no MISO', self.errors[0])

    def test_a_corrupt_stream_is_reported(self):
        engine = FakeEngine()
        self.link(engine)
        self.assertTrue(wait_for(lambda: engine.conn is not None))
        engine.send(bytes((0x99, 0x00)))
        self.assertTrue(wait_for(lambda: len(self.errors) == 1))
        self.assertIn('unknown message 0x99', self.errors[0])

    def test_the_engine_closing_is_reported_but_the_worker_closing_is_not(self):
        engine = FakeEngine()
        self.link(engine)
        self.assertTrue(wait_for(lambda: engine.conn is not None))
        engine.close()
        self.assertTrue(wait_for(lambda: len(self.errors) == 1))
        self.assertIn('closed the connection', self.errors[0])

        quiet_errors: list = []
        engine2 = FakeEngine()
        link2 = RadioSpiLink(engine2.port, on_drive=lambda g, l: None, on_error=quiet_errors.append)
        link2.close()
        time.sleep(0.05)
        engine2.close()
        self.assertEqual(quiet_errors, [])


class TestWorkerRadioSpiBoundary(unittest.TestCase):
    """The real entrypoint: a bad radio_spi stops the worker before it loads libqemu."""

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

    def test_a_bad_radio_spi_stops_the_worker(self):
        result = self.run_worker(self.base(radio_spi={'port': 40123, 'cs': 'five'}))
        self.assertEqual(result.returncode, 1)
        self.assertIn('radio_spi.cs must be a GPIO number', result.stderr)
        self.assertNotIn('Loading library', result.stderr)

    def test_a_good_radio_spi_reaches_the_library_load(self):
        result = self.run_worker(self.base(radio_spi={'port': 40123, 'cs': 5, 'watch': [5, 14]}))
        self.assertIn('Loading library', result.stderr)


if __name__ == '__main__':
    unittest.main()
