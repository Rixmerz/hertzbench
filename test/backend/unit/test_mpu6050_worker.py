"""
test_mpu6050_worker.py: the MPU-6050 a QEMU worker hosts (project
i2c-model-fidelity-2026-09).

The model itself is held to the shared bus vectors in test_i2c_slaves.py. This
file is about what only the worker does with it, on the rig of the board-buses
suite (app/services/esp32_worker.py running unmodified, libqemu replaced at the
ctypes boundary, the guest played by calling the worker's own callbacks):

  - the worker's copy starts from the values its sensor record carries, which
    are where the panel's sliders are, and a later update changes only what it
    names. The copy used to start from values of its own and to take the
    record's at the first slider move: the gallery sketch printed 25.0 C
    beside a panel that said 24;
  - answering an I2C event logs nothing and emits nothing unless
    VELXIO_I2C_TRACE is set, and with it set the trace is what it always was.

Every test runs twice: with the record the tab files by default, which
carries the part's compiled model (buses/models/mpu6050.c, `wasmB64`, P5 of
the project), and with the record of a tab whose i2cwasm flag is off, which
the worker answers with its Python twin (esp32_i2c_slaves.mpu6050_slave).
"""
from __future__ import annotations

import base64
import time
from pathlib import Path

import pytest

# The rig loads custom chips, so its module skips itself where wasmtime is
# missing; that skip is handed to the fixture, as the F5 suite does.
try:
    from .test_board_buses_repro_worker import (  # noqa: F401  (worker fixture)
        I2C_FINISH,
        I2C_READ,
        I2C_START_RECV,
        I2C_START_SEND,
        I2C_WRITE,
        worker,
    )
except pytest.skip.Exception as _no_rig:
    _RIG_MISSING = str(_no_rig)
    I2C_START_RECV, I2C_START_SEND, I2C_FINISH, I2C_WRITE, I2C_READ = 0x00, 0x01, 0x03, 0x05, 0x06

    @pytest.fixture
    def worker():
        pytest.skip(_RIG_MISSING)

ADDR = 0x68
PIN = 200 + ADDR
PWR_MGMT_1, ACCEL_XOUT_H = 0x6B, 0x3B

# Where a project left the sliders: nothing here is the value the panel, the
# tab model or the twin starts from.
PANEL = {'accelX': 0.5, 'accelY': -0.25, 'accelZ': 0.75,
         'gyroX': 100, 'gyroY': -50, 'gyroZ': 10, 'temp': 30}
# The same, as counts at the power-on ranges (16384 per g, 131 per deg/s) and
# (T - 36.53) * 340.
PANEL_COUNTS = [8192, -4096, 12288, -2220, 13100, -6550, 1310]
REST_COUNTS = [0, 0, 16384, -4260, 0, 0, 0]


MODEL_B64 = base64.b64encode(
    (Path(__file__).resolve().parents[3] / 'frontend' / 'public' / 'bus-chips' / 'mpu6050.wasm')
    .read_bytes()).decode()
# What the tab adds to every record: the compiled model, or nothing.
_RECORD_MODEL: dict = {}


@pytest.fixture(autouse=True, params=['compiled', 'twin'])
def model(request, monkeypatch):
    """The worker's copy of the chip: the part's compiled model, which the
    tab sends by default, or the twin of a tab with the i2cwasm flag off."""
    monkeypatch.setattr(
        __import__(__name__, fromlist=['_RECORD_MODEL']), '_RECORD_MODEL',
        {'wasmB64': MODEL_B64} if request.param == 'compiled' else {})
    return request.param


def record(**values) -> dict:
    """The record the tab's part files for the worker (parts/i2cPart.ts)."""
    return {'sensor_type': 'mpu6050', 'pin': PIN, 'addr': ADDR, 'owner': 'imu1',
            **_RECORD_MODEL, **values}


def write_reg(w, reg: int, *values: int) -> None:
    ret = w.i2c(0, ADDR, [I2C_START_SEND, I2C_WRITE | (reg << 8),
                          *[I2C_WRITE | (v << 8) for v in values], I2C_FINISH])
    assert ret[:-1] == [0] * (len(ret) - 1), 'the chip acknowledges its address and every byte'


def read_sample(w) -> list[int]:
    """The 14-byte burst of getEvent(), as seven signed counts."""
    ret = w.i2c(0, ADDR, [I2C_START_SEND, I2C_WRITE | (ACCEL_XOUT_H << 8), I2C_FINISH,
                          I2C_START_RECV, *[I2C_READ] * 14, I2C_FINISH])
    block = ret[4:18]
    words = [(block[i] << 8) | block[i + 1] for i in range(0, 14, 2)]
    return [v - 0x10000 if v & 0x8000 else v for v in words]


def stderr_after(w, marker: str, timeout: float = 5.0) -> list[str]:
    """The worker's log up to the line that holds `marker`. The log is one
    pipe written in order, so whatever came before the marker is in."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        lines = list(w.stderr)
        for i, line in enumerate(lines):
            if marker in line:
                return lines[:i]
        time.sleep(0.02)
    raise AssertionError(f'"{marker}" never reached the log:\n' + ''.join(w.stderr[-20:]))


def event_lines(log: list[str]) -> list[str]:
    """The lines the worker logs per I2C event, without its prefix."""
    lines = [line.rstrip('\n').split('] ', 1)[-1] for line in log]
    return [line for line in lines if line.startswith(('I2C #', 'I2C bus='))]


class TestSeededFromTheRecord:
    def test_the_compiled_model_runs_when_the_record_carries_it(self, worker, model):
        w = worker(sensors=[record(**PANEL)])
        write_reg(w, PWR_MGMT_1, 0x00)
        assert read_sample(w) == PANEL_COUNTS
        w.flush()
        w.send({'cmd': 'sensor_attach', 'sensor_type': 'trace-marker', 'pin': 77})
        log = ''.join(stderr_after(w, 'Sensor trace-marker attached'))
        assert 'the compiled model could not be run' not in log

    def test_the_start_config_record_sets_the_first_read(self, worker):
        w = worker(sensors=[record(**PANEL)])
        write_reg(w, PWR_MGMT_1, 0x00)
        assert read_sample(w) == PANEL_COUNTS

    def test_a_record_attached_while_running_sets_the_first_read(self, worker):
        w = worker()
        w.send({'cmd': 'sensor_attach', **record(**PANEL)})
        w.sync()
        write_reg(w, PWR_MGMT_1, 0x00)
        assert read_sample(w) == PANEL_COUNTS

    def test_a_record_with_no_values_reads_the_panels_rest(self, worker):
        """A tab that sends no values gets 1 g on Z and 24 C, which is where
        its panel starts."""
        w = worker(sensors=[record()])
        write_reg(w, PWR_MGMT_1, 0x00)
        assert read_sample(w) == REST_COUNTS

    def test_an_update_changes_what_it_names_and_nothing_else(self, worker):
        """One slider moves. The temperature used to fall back to 25 C with
        it, and every value the record never carried to the twin's own."""
        w = worker(sensors=[record(**PANEL)])
        write_reg(w, PWR_MGMT_1, 0x00)
        w.send({'cmd': 'sensor_update', 'pin': PIN, 'accelX': -1})
        w.sync()
        assert read_sample(w) == [-16384, *PANEL_COUNTS[1:]]

    def test_the_record_picks_the_die_and_the_address(self, worker):
        """The tab sends the variant and the address it resolved from AD0."""
        w = worker(sensors=[record(variant='mpu9250'),
                            {**record(), 'pin': PIN + 1, 'addr': 0x69, 'owner': 'imu2'}])
        assert w.read_reg(0, ADDR, 0x75) == (0, 0x71)
        assert w.read_reg(0, 0x69, 0x75) == (0, 0x68)

    def test_the_chip_is_asleep_until_the_sketch_wakes_it(self, worker):
        w = worker(sensors=[record(**PANEL)])
        assert w.read_reg(0, ADDR, PWR_MGMT_1) == (0, 0x40)
        assert read_sample(w) == [0] * 7


INT_GPIO = 4
SMPLRT_DIV, INT_PIN_CFG, INT_ENABLE, INT_STATUS = 0x19, 0x37, 0x38, 0x3A


def int_levels(w) -> list[int]:
    """Every level the worker put on the INT pad, in order."""
    calls = w.guest('calls')['calls']
    return [c[2] for c in calls if c[:2] == ['set_pin', INT_GPIO + 1]]


def wait_levels(w, want: list[int], timeout: float = 3.0) -> list[int]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        got = int_levels(w)
        if got == want:
            return got
        time.sleep(0.01)
    return int_levels(w)


class TestSampledOnTheGuestClock:
    """The twin samples on QEMU_CLOCK_VIRTUAL: DATA_RDY and the INT pad follow
    the guest's time, which the fake libqemu moves by hand."""

    @pytest.fixture
    def clocked(self, worker, monkeypatch):
        monkeypatch.setenv('BB_FAKE_GUEST_CLOCK', '1')
        w = worker(sensors=[record(int_pin=INT_GPIO)])
        write_reg(w, SMPLRT_DIV, 0x07)     # 1 kHz at DLPF_CFG 0
        write_reg(w, INT_ENABLE, 0x01)     # DATA_RDY_EN
        write_reg(w, PWR_MGMT_1, 0x00)     # awake at guest time 0
        return w

    def test_data_ready_comes_with_the_guest_time_and_goes_with_the_read(self, clocked):
        w = clocked
        assert w.read_reg(0, ADDR, INT_STATUS) == (0, 0x00)
        w.guest('clock', ns=1_000_000)
        assert w.read_reg(0, ADDR, INT_STATUS) == (0, 0x01)
        assert w.read_reg(0, ADDR, INT_STATUS) == (0, 0x00)

    def test_int_pulses_on_the_pad_the_record_names(self, clocked):
        w = clocked
        # The pad is driven from the first event on: push-pull, active high.
        assert int_levels(w)[:1] == [0]
        w.guest('clock', ns=1_000_000)
        assert wait_levels(w, [0, 1]) == [0, 1], 'the timer thread raises INT at the sample'
        w.guest('clock', ns=1_050_000)
        assert wait_levels(w, [0, 1, 0]) == [0, 1, 0], 'and lowers it 50 us later'

    def test_pulses_the_thread_woke_too_late_for_reach_the_pad_as_one(self, clocked):
        """The guest ran past a sample and the end of its pulse before the
        timer thread looked: the pad still pulses, once for all of them."""
        w = clocked
        w.guest('clock', ns=3_200_000)
        assert wait_levels(w, [0, 1, 0]) == [0, 1, 0]
        time.sleep(0.1)
        assert int_levels(w) == [0, 1, 0], 'one pulse for the three samples'

    def test_a_latched_int_waits_for_the_read(self, clocked):
        w = clocked
        write_reg(w, INT_PIN_CFG, 0x20)    # LATCH_INT_EN
        w.guest('clock', ns=3_000_000)
        assert wait_levels(w, [0, 1]) == [0, 1]
        assert w.read_reg(0, ADDR, INT_STATUS) == (0, 0x01)
        assert int_levels(w) == [0, 1, 0]

    def test_no_pad_is_driven_when_int_is_not_wired(self, worker, monkeypatch):
        monkeypatch.setenv('BB_FAKE_GUEST_CLOCK', '1')
        w = worker(sensors=[record()])
        write_reg(w, INT_ENABLE, 0x01)
        write_reg(w, PWR_MGMT_1, 0x00)
        w.guest('clock', ns=5_000_000)
        assert w.read_reg(0, ADDR, INT_STATUS) == (0, 0x01)
        calls = w.guest('calls')['calls']
        assert [c for c in calls if c[0] == 'set_pin' and c[1] < 100] == []


class TestIntTimerCost:
    """The INT pad costs the worker's chip timer thread a bounded number of
    wake-ups, however fast the chip samples. At 8 kHz with DATA_RDY_EN set,
    a pulse edge comes due every 50 or 75 us of guest time; the thread used
    to wake for each and take QEMU's I/O-thread lock every time, some 16,000
    times a second of a guest running at the host's pace."""

    TAG = 'esp32_worker.py:chip_timer'

    def test_an_8khz_int_takes_the_lock_at_most_twice_a_millisecond_and_pulses_at_each_look(
            self, worker, monkeypatch):
        monkeypatch.setenv('BB_FAKE_GUEST_CLOCK', '1')
        monkeypatch.setenv('BB_FAKE_BQL', '1')
        w = worker(sensors=[record(int_pin=INT_GPIO)])
        write_reg(w, INT_ENABLE, 0x01)     # DATA_RDY_EN; SMPLRT_DIV 0, DLPF off: 8 kHz
        write_reg(w, PWR_MGMT_1, 0x00)
        takes, pulses, seconds = self._measure(w)
        print(f'chip timer lock takes: {takes:.0f}/s, INT pulses delivered: {pulses:.0f}/s'
              f' (per second of guest time, over {seconds:.2f} s of it)')
        # One sample per millisecond at most is looked at between bus events,
        # and its pulse end: 2,000 a second of the guest's time, with room for
        # the edges of the window. The thread cannot burst past it: its next
        # look is a millisecond of guest time after the last, however late
        # the last one ran, so a host that stalls it only makes this lower.
        assert takes <= 2200, f'{takes:.0f} lock takes a second of guest time'
        # And a pulse per look: a look past the floor finds samples that
        # pulsed since the last one and gives the guest one edge for them;
        # the only other look is the end of a pulse it caught live. So at
        # least one pulse for every two takes, with room for the host.
        # Measured on the rig: 5,747 takes and 740 pulses a second before the
        # floor, 522 and 225 with the floor alone, about 1,000 and 750 now.
        assert pulses >= 0.4 * takes, f'{pulses:.0f} pulses for {takes:.0f} lock takes a second'

    def test_a_pulse_that_starts_before_the_floor_waits_for_it(self, worker, monkeypatch):
        """The guest stands still between the thread's looks. A look at the
        end of a pulse lets the pad go; the next 8 kHz sample pulses 75 us
        later, before the floor, and is owed to the look the floor allows.
        The thread used to take the lock for it at once whenever it asked
        while that pulse was under way: on a loaded host, where a round of
        the compiled model's deadlines lasts about a sample period, that was
        a take for nearly every sample."""
        monkeypatch.setenv('BB_FAKE_GUEST_CLOCK', '1')
        monkeypatch.setenv('BB_FAKE_BQL', '1')
        w = worker(sensors=[record(int_pin=INT_GPIO)])
        write_reg(w, INT_ENABLE, 0x01)     # DATA_RDY_EN; SMPLRT_DIV 0, DLPF off: 8 kHz
        write_reg(w, PWR_MGMT_1, 0x00)     # awake at guest time 0
        w.guest('clock', ns=1_000_010)     # inside the pulse of the sample at 1 ms
        assert wait_levels(w, [0, 1]) == [0, 1]
        w.guest('clock', ns=1_060_000)     # past its end: the pad lets go
        assert wait_levels(w, [0, 1, 0]) == [0, 1, 0]
        takes = w.guest('bql')['takes'].get(self.TAG, 0)
        w.guest('clock', ns=1_130_000)     # inside the pulse of the sample at 1.125 ms
        time.sleep(0.1)
        assert int_levels(w) == [0, 1, 0], 'no look before the floor'
        assert w.guest('bql')['takes'].get(self.TAG, 0) == takes
        w.guest('clock', ns=2_070_000)     # past the floor, between two pulses
        assert wait_levels(w, [0, 1, 0, 1, 0]) == [0, 1, 0, 1, 0], \
            'the look the floor allows gives the guest one pulse for the samples since'

    def test_a_pulse_found_over_by_the_next_one_ends_and_owes_it(self, worker, monkeypatch):
        """The thread looks some time after it decides to: it can come to end
        a pulse and find the next sample already pulsing. The pulse on the pad
        ends there, and the new one waits for the floor. The look used to
        change nothing (the pad was active, as the driver left it) and leave
        the end due at once: under load the thread took the lock for nearly
        every sample and delivered almost no pulse."""
        monkeypatch.setenv('BB_FAKE_GUEST_CLOCK', '1')
        monkeypatch.setenv('BB_FAKE_BQL', '1')
        w = worker(sensors=[record(int_pin=INT_GPIO)])
        write_reg(w, INT_ENABLE, 0x01)     # DATA_RDY_EN; SMPLRT_DIV 0, DLPF off: 8 kHz
        write_reg(w, PWR_MGMT_1, 0x00)     # awake at guest time 0
        w.guest('clock', ns=1_000_010)     # inside the pulse of the sample at 1 ms
        assert wait_levels(w, [0, 1]) == [0, 1]
        w.guest('clock', ns=1_130_000)     # inside the pulse of the sample at 1.125 ms
        assert wait_levels(w, [0, 1, 0]) == [0, 1, 0], 'the pulse on the pad ends'
        takes = w.guest('bql')['takes'].get(self.TAG, 0)
        time.sleep(0.1)
        assert int_levels(w) == [0, 1, 0], 'the new pulse waits for the floor'
        assert w.guest('bql')['takes'].get(self.TAG, 0) == takes
        w.guest('clock', ns=2_200_000)     # past the floor, between two pulses
        assert wait_levels(w, [0, 1, 0, 1, 0]) == [0, 1, 0, 1, 0], \
            'and the samples that pulsed after it get one pulse there'

    def test_a_long_gap_in_the_guest_time_is_not_made_up(self, worker, monkeypatch):
        """A host that deschedules the thread lets the guest run on without
        it. The next look comes a millisecond after the one that ends the gap,
        not a millisecond after the last before it: looks counted from the
        old one would replay the missed milliseconds, a look at every sample
        until they caught up."""
        monkeypatch.setenv('BB_FAKE_GUEST_CLOCK', '1')
        monkeypatch.setenv('BB_FAKE_BQL', '1')
        w = worker(sensors=[record(int_pin=INT_GPIO)])
        write_reg(w, INT_ENABLE, 0x01)     # DATA_RDY_EN; SMPLRT_DIV 0, DLPF off: 8 kHz
        write_reg(w, PWR_MGMT_1, 0x00)     # awake at guest time 0
        w.guest('clock', ns=1_000_010)     # inside the pulse of the sample at 1 ms
        assert wait_levels(w, [0, 1]) == [0, 1]
        w.guest('clock', ns=1_060_000)     # past its end: the pad lets go
        assert wait_levels(w, [0, 1, 0]) == [0, 1, 0]
        w.guest('clock', ns=500_060_000)   # half a second later, between two pulses
        assert wait_levels(w, [0, 1, 0, 1, 0]) == [0, 1, 0, 1, 0], \
            'one pulse for the samples of the gap'
        takes = w.guest('bql')['takes'].get(self.TAG, 0)
        for ns in (500_130_000, 500_380_000, 500_630_000, 500_880_000):
            w.guest('clock', ns=ns)        # inside the pulse of a sample before the floor
            time.sleep(0.05)
        assert int_levels(w) == [0, 1, 0, 1, 0], 'no look before the floor after the gap'
        assert w.guest('bql')['takes'].get(self.TAG, 0) == takes
        w.guest('clock', ns=501_130_000)   # past the floor, inside a pulse
        assert wait_levels(w, [0, 1, 0, 1, 0, 1]) == [0, 1, 0, 1, 0, 1]

    def test_a_stalled_test_process_does_not_move_the_bound(self, worker, monkeypatch):
        """The rates are per second of the guest's time, read on the worker's
        side at both ends of the window. A window timed on the test process's
        clock reads high when a CI runner deschedules the process between the
        guest's clock starting and its own: the guest ran longer than the
        window it is divided by. A test process stalled inside the window
        must leave the rate where it was."""
        monkeypatch.setenv('BB_FAKE_GUEST_CLOCK', '1')
        monkeypatch.setenv('BB_FAKE_BQL', '1')
        w = worker(sensors=[record(int_pin=INT_GPIO)])
        write_reg(w, INT_ENABLE, 0x01)
        write_reg(w, PWR_MGMT_1, 0x00)
        takes, pulses, seconds = self._measure(w, stall=1.5)
        print(f'stalled window, per guest second: {takes:.0f} takes, {pulses:.0f} pulses, '
              f'{seconds:.2f} s of guest time')
        assert takes <= 2200, f'{takes:.0f} lock takes a second'

    def _measure(self, w, stall=0.0):
        """Lock takes and INT pulses per second of the guest's time, over a
        window the worker's side opens and closes (clock_run, clock_stop):
        the guest runs at the host's pace in between, and the counts are
        divided by the guest time that passed, not by a stretch the test
        process timed on its own. Returns (takes, pulses, guest seconds)."""
        seen = len(int_levels(w))    # levels of an earlier window
        before = w.guest('bql')['takes'].get(self.TAG, 0)
        start = w.guest('clock_run')['ns']
        time.sleep(1.0 + stall)    # a stall: the process descheduled while the guest runs
        stop = w.guest('clock_stop')['ns']
        seconds = (stop - start) / 1e9
        takes = (w.guest('bql')['takes'].get(self.TAG, 0) - before) / seconds
        edges = int_levels(w)[max(seen - 1, 0):]
        pulses = sum(1 for a, b in zip(edges, edges[1:]) if a == 0 and b == 1) / seconds
        return takes, pulses, seconds


class TestI2cTrace:
    def _traffic(self, w) -> None:
        write_reg(w, PWR_MGMT_1, 0x00)
        assert w.read_reg(0, ADDR, PWR_MGMT_1) == (0, 0x00)

    def test_silent_unless_asked(self, worker, monkeypatch):
        monkeypatch.delenv('VELXIO_I2C_TRACE', raising=False)
        w = worker(sensors=[record()])
        self._traffic(w)
        # Both are behind the traffic now: an event emitted after it, and a
        # log line written after it.
        w.flush()
        w.send({'cmd': 'sensor_attach', 'sensor_type': 'trace-marker', 'pin': 77})
        log = stderr_after(w, 'Sensor trace-marker attached')
        assert w.events('i2c_trace') == []
        assert event_lines(log) == []

    def test_the_trace_is_what_it_was_when_asked_for(self, worker, monkeypatch):
        monkeypatch.setenv('VELXIO_I2C_TRACE', '1')
        w = worker(sensors=[record()])
        self._traffic(w)
        w.flush()
        w.send({'cmd': 'sensor_attach', 'sensor_type': 'trace-marker', 'pin': 77})
        log = stderr_after(w, 'Sensor trace-marker attached')

        assert w.events('i2c_trace') == [
            {'type': 'i2c_trace', 'bus': 0, 'addr': ADDR, 'event': ev, 'op': op,
             'result': result, 'reg_ptr': ptr}
            for ev, op, result, ptr in [
                (I2C_START_SEND, 'START_SEND', 0, 0x00),
                (I2C_WRITE | (PWR_MGMT_1 << 8), 'WRITE', 0, 0x6B),
                (I2C_WRITE, 'WRITE', 0, 0x6C),
                (I2C_FINISH, 'FINISH', 0, 0x6C),
                (I2C_START_SEND, 'START_SEND', 0, 0x6C),
                (I2C_WRITE | (PWR_MGMT_1 << 8), 'WRITE', 0, 0x6B),
                (I2C_FINISH, 'FINISH', 0, 0x6B),
                (I2C_START_RECV, 'START_RECV', 0, 0x6B),
                (I2C_READ, 'READ', 0x00, 0x6C),
                (I2C_FINISH, 'FINISH', 0, 0x6C),
            ]
        ]
        assert event_lines(log) == [
            'I2C #001 bus=0 addr=0x68 START_SEND → reg_ptr=0x00',
            'I2C #002 bus=0 addr=0x68 WRITE byte=0x6b → reg_ptr=0x6b',
            'I2C #003 bus=0 addr=0x68 WRITE byte=0x00 → reg_ptr=0x6c',
            'I2C #004 bus=0 addr=0x68 FINISH ',
            'I2C #005 bus=0 addr=0x68 START_SEND → reg_ptr=0x6c',
            'I2C #006 bus=0 addr=0x68 WRITE byte=0x6b → reg_ptr=0x6b',
            'I2C #007 bus=0 addr=0x68 FINISH ',
            'I2C #008 bus=0 addr=0x68 START_RECV → reg_ptr=0x6b',
            'I2C #009 bus=0 addr=0x68 READ → PWR_MGMT1=0x00',
            'I2C #010 bus=0 addr=0x68 FINISH ',
        ]
