# Upstream sync and core patches

hertzbench is a friendly fork of Velxio (`upstream`, default branch `master`). Our code lives in `hertzbench/`. When we have to touch a Velxio file, the commit is prefixed `core-patch:`, the file gets the header line `Modified by hertzbench contributors, <YYYY-MM>`, and the change is listed here.

Policy, from [PLAN.md](PLAN.md) §10:

```bash
git remote add upstream https://github.com/davidmonterocrespo24/velxio.git
git config rerere.enabled true
git fetch upstream
git merge upstream/master   # or cherry-pick specific commits
```

- Every two to four weeks, or when upstream ships something we want.
- After each merge: run `deno task test` in `hertzbench/`, the backend unit tests, and every example scenario. Fix adapters, not Velxio.
- A generic fix is offered upstream as a pull request. Once merged there, we drop our patch.

## Patches

Phase 1 and Phase 3 touch the **same** Velxio file, `esp32_worker.py`, in two separate patches. Phase 2 (the MCP server) touches **none**: it is new code under `hertzbench/mcp/` and does not import or mount Velxio's own MCP server (`backend/app/mcp/server.py`). Phase 4 (ESP-NOW) touches **no Velxio file** either: it rides on patch 1, which already puts each board's NIC on the engine and gives it its own station MAC. It does need a small patch to the QEMU fork's Wi-Fi MAC (patch 3), applied to the fork's source before building libqemu; no QEMU source or binary is kept in this tree, only the diffs (patch 3 inline below, patch 4 as a file next to this page). Its sketches go through Velxio's compiler unchanged. Phase 5 (the mobile bridge) touches **none**: the IP bridge is a station on the engine's own medium, and the BLE bridge a virtual controller on its air; BlueZ is reached through hertzbench's own helper (`bridge/ble/bluez_gatt.py`). Phase 6 (BLE) touches **none**: the ESP32 board relays the firmware's HCI UART through the worker's existing `uart_tx` event and `uart_send` command, and its firmware is an ESP-IDF project hertzbench builds itself instead of a change to Velxio's template (ADR 0002). Phase 7 (the view) touches **none** either: it serves a few Velxio frontend files read-only, listed below.

| # | File | Commit subject | Upstreamable |
|---|---|---|---|
| 1 | `backend/app/services/esp32_worker.py` | `core-patch: attach the ESP32 Wi-Fi NIC to an external stream netdev` | Possibly, as an opt-in. See below. |
| 2 | `backend/app/services/esp32_worker.py` | `Implement Phase 3 of hertzbench/docs/PLAN.md: LoRa SX127x register-level…` (79b4e960; not prefixed `core-patch:`, see below) | Possibly, as an opt-in. See below. |
| 3 | `hw/misc/esp32_wifi.c`, `hw/misc/esp32_wifi_ap.c`, `include/hw/misc/esp32_wifi.h` in the lcgamboa QEMU fork (not in this tree) | none: applied by hand before building libqemu, see below | Yes, as a bug fix. Not offered yet. |
| 3 (doc) | `docs/BUILD-QEMU.md` (section 7 and the header line, pointing at patch 3) | `core-patch: make ESP-NOW pass on real firmware with a QEMU fork patch` | No: it documents hertzbench's build. |
| 4 | `target/xtensa/op_helper.c`, `target/xtensa/cpu.h`, `hw/xtensa/esp32.c`, `hw/xtensa/esp32_picsimlab.c`, `hw/timer/esp32_timg.c`, `hw/timer/esp32_frc_timer.c` in the lcgamboa QEMU fork (not in this tree; the diff is kept as [`qemu-esp32-clock-switch.patch`](qemu-esp32-clock-switch.patch)) | none: applied before building libqemu, see below | Yes, as a bug fix. Not offered yet. |

### Patch 1: `esp32_worker.py`, external Wi-Fi netdev and per-board eFuse image

Why: the worker builds the QEMU argv from fixed fields and reads no override for the NIC (discovery Q3, Q8; ADR 0001). Without a change, every board gets a private SLIRP network and boards cannot reach each other. Two boards also share the default station MAC, and the fork drops frames from its own MAC.

What changed, all of it in that one file:

1. A header line after the shebang: `# Modified by hertzbench contributors, 2026-10`.
2. `valid_tcp_port(value)`: new, 3 lines. True only for an `int` from 1 to 65535 (a `bool` is not a port).
3. `wifi_nic_argv(machine, wifi_enabled, hostfwd_port=0, l2_port=0)`: new, after Velxio's `wifi_nic_arg`, which is left exactly as upstream has it. It returns the whole list of QEMU arguments for the radio: `[]` when `wifi_nic_arg` gives none, `['-nic', wifi_nic_arg(...)]` when `l2_port` is unset or 0 (byte-for-byte what the worker passed before), and with `l2_port`

   ```
   -netdev socket,id=hzb-l2,connect=127.0.0.1:<l2_port> -net nic,model=<esp32_wifi|esp32c3_wifi>,netdev=hzb-l2
   ```

   instead of SLIRP, `hostfwd_port` ignored. The machine rules (classic always, C3 only for Wi-Fi sketches, S3 never) are `wifi_nic_arg`'s and untouched. An invalid port raises `ValueError`.
4. `efuse_drive_args(image_path)`: new. Returns the QEMU arguments `-drive file=<path>,if=none,format=raw,id=hzb-efuse` and `-global driver=nvram.esp32.efuse,property=drive,value=hzb-efuse`. A comma in the path is doubled so it cannot add an option.
5. `main()`:
   - reads two optional stdin config fields, `wifi_l2_port` and `efuse_image`;
   - exits with a message on stderr if `wifi_l2_port` is not a port or `efuse_image` is not an existing file, before loading the library;
   - builds the radio's arguments with `wifi_nic_argv` instead of `wifi_nic_arg`, and logs them in its `WiFi radio attached` line;
   - appends `efuse_drive_args(efuse_image)` to the argv, only for the classic ESP32 machine (the C3 eFuse is a different device).

The contract with the adapter is the two config fields; `hertzbench/adapters/qemu-wifi-l2/mod.ts` (`workerNetworkConfig`) produces them.

Tests: `test/backend/unit/test_esp32_wifi_l2_args.py` (14 tests, including the worker's real entrypoint for the config checks).

**Verified on real firmware** (2026-10-23, [e2e-esp32.md](e2e-esp32.md#results-on-real-firmware)), against a libqemu built from the public lcgamboa fork (QEMU 9.2.2). The first form of this patch, `-nic stream,...`, was refused at start-up (`Parameter 'type' is missing`); `-netdev stream` plus `-net nic` was accepted, but the guest sent no frame: QEMU on its own reset on its watchdogs again and again, and under the worker the board booted and never associated; `-netdev socket,connect=...` boots, associates and carries DHCP, UDP and ESP-NOW. Its framing on TCP is the stream netdev's, a 4-byte big-endian length before each frame, so the engine side did not change. The `-global` binding takes the eFuse drive: each board's DHCP request carries the station MAC of its image.

Upstreamable: the two config fields are opt-in and change nothing when absent, so they could be offered as they are. We have not discussed it with the maintainers; the CLA described in `README.md` applies to a pull request.

### Patch 2: `esp32_worker.py`, `radio_spi` and `RadioSpiLink` (a radio chip model on the SPI bus)

Why: Phase 3 models the LoRa SX127x and the nRF24 as register-level chips inside the engine. The guest drives them over SPI, so the worker must forward each SPI byte and chip-select edge to the engine and let the chip drive DIO0/IRQ back. Velxio's worker only knows chip models built from the browser's `bus_map`.

The commit that landed this (`79b4e960`) does not carry the `core-patch:` prefix, so `git log --grep core-patch` does not find it. Find it with `git log -S RadioSpiLink -- backend/app/services/esp32_worker.py`.

What changed, all of it in that one file (line numbers are at the time of writing and move with every upstream sync; search by name):

1. `import queue`, added to the imports (about line 49).
2. `_RADIO_SPI_GPIO_MAX = 48` and `radio_spi_problem(value)`: new, after `valid_tcp_port` (about lines 432-454). Returns why a `radio_spi` config entry is unusable, or `None`. `port` must be a TCP port (`valid_tcp_port`), `cs` a GPIO from 0 to 48, `watch` an optional list of such GPIOs.
3. `class RadioSpiLink`: new (about lines 457-558). The board side of the spi-link protocol, one ordered TCP stream to `127.0.0.1:<port>`:
   - board to engine: `0x01 <mosi>` (answered by `0x81 <miso>`) and `0x02 <gpio> <level>`;
   - engine to board: `0x81 <miso>` and `0x03 <gpio> <level>` (the chip drives a board input);
   - `transfer(mosi)` blocks the calling QEMU thread until the MISO arrives, so edges and bytes reach the model in the guest's order. After a failure, or no answer within `timeout_s` (1 s), it reports once through `on_error` and answers `0xFF`, the level of an undriven bus;
   - `pin(gpio, level)` sends a chip-select or watched-pin edge;
   - drive messages are applied on a thread of their own (`_drive_loop`), because the QEMU thread may hold the IO-thread lock while it waits for a MISO;
   - `close()`; the protocol's other end is `hertzbench/adapters/spi-link/protocol.ts`.
4. `main()`:
   - reads the optional stdin config field `radio_spi` and exits with a message on stderr if `radio_spi_problem` rejects it (about lines 861-865);
   - declares `_radio_spi` (the link, one slot) and `_radio_spi_resp` (its responder) next to `_spi_models` (about lines 1117-1118);
   - `_on_pin_change`: forwards a change on a `watch` GPIO to `_radio_spi[0].pin` (2 lines, about 1881);
   - `_rebuild_spi_responders`: `resp = list(_spi_models) + _radio_spi_resp` instead of `list(_spi_models)` (1 line, about 2503);
   - a new block after `_spi_population_changed` (about lines 2623-2643): when `radio_spi` is set, opens `RadioSpiLink`, builds a `_responder('hertzbench-radio', ...)` selected by `_cs_active` on the `cs` GPIO, sets `responder['fast']` to the link's `transfer`, appends it to `_radio_spi_resp`, and calls `_spi_population_changed()`. An unreachable engine port exits the worker;
   - `_set_pin_locked(pin, value)`: new (about lines 3513-3535), the body of the old `set_pin` command, taking the QEMU IO-thread lock, calling `qemu_picsimlab_set_pin` and `_pads.inject`. The `set_pin` command now calls it, and so does the link's `on_drive`. This is the one place the patch moves upstream code instead of only adding to it: the `set_pin` branch lost its inline body and its #273 comment, which now live in `_set_pin_locked`;
   - the `stop` command closes the link (2 lines, about 3877).

The contract with the adapter is the `radio_spi` config field, `{port, cs, watch}`; `workerRadioSpiConfig` in `hertzbench/adapters/spi-link/mod.ts` produces it. It uses Velxio's `_responder(...)` and `_cs_active(...)` helpers inside `main()` as they are.

Tests: `test/backend/unit/test_esp32_radio_spi.py` (9 tests, none needs libqemu: `RadioSpiLink` against a loopback socket, and the worker's real entrypoint for the config checks).

Re-applying it after an upstream sync, if the merge conflicts or silently drops it:

1. Check it is still there: `grep -n "RadioSpiLink\|radio_spi\|_set_pin_locked" backend/app/services/esp32_worker.py`, and `pytest test/backend/unit/test_esp32_radio_spi.py`. If the tests pass, nothing to do.
2. Otherwise take the patch from our history and replay it on the merged file: `git show 79b4e960 -- backend/app/services/esp32_worker.py | git apply --3way`, or cherry-pick the hunks listed above by hand. The additions (`radio_spi_problem`, `RadioSpiLink`, the block after `_spi_population_changed`) are self-contained; the four one-to-two-line hooks are the ones that conflict.
3. If upstream renamed `_responder`, `_cs_active`, `_rebuild_spi_responders`, `_spi_population_changed` or the `set_pin` command, adapt the hooks to the new names. The `_responder` entry must keep `bus_id=None`, `drives=True`, the chip-select predicate and the `xfer` callable, and `['fast']` (the single-responder shortcut that `_spi_one` reads) must stay set to the link's `transfer`.
4. If upstream already moved the `set_pin` body into a helper, point `on_drive` at that helper instead of keeping `_set_pin_locked`. It must still hold the IO-thread lock (issue #273).
5. Keep the header line `Modified by hertzbench contributors` and run the backend unit tests and `deno task test` in `hertzbench/`.

Not verified on this host: there is no libqemu, so no guest has clocked SPI bytes through the link; the arbitration with `_responder` and `_cs_active` is read from the code, not run.

Upstreamable: `radio_spi` is opt-in and changes nothing when absent; the `_set_pin_locked` extraction behaves as before. We have not discussed it with the maintainers.

### Patch 3: the QEMU fork's Wi-Fi MAC, ESP-NOW receive and tx-done (outside this tree)

Why: on real firmware `espnow-mesh-5-nodes.yaml` failed 4 of 7 assertions against a libqemu built from the public fork, `lcgamboa/qemu` branch `picsimlab-esp32` commit `9c298984` ([e2e-esp32.md](e2e-esp32.md#the-esp-now-example)). Two defects in the fork's MAC model, both read from its code:

1. **The netdev never reads again after the injection queue overflows.** Frames from the netdev go into the guest through a queue drained one per `INTER_FRAME_TIME` by `Esp32_WLAN_inject_timer` (`hw/misc/esp32_wifi_ap.c`). Above `Esp32_WLAN__MAX_INJECT_QUEUE_SIZE` (20, `hw/misc/esp32_wlan.h:135`) `Esp32_WLAN_can_receive` answers false; QEMU's net layer then queues the packet in hand and the socket netdev stops polling its socket until someone calls `qemu_flush_queued_packets` on the NIC. Nothing in the fork does. The sensors' driver resends an unacked frame dozens of times a second (66 a second measured), so a gateway that boots a few seconds after them sees more than 20 frames at once and is deaf for the rest of the run: it logged 21 readings, then none, while the engine delivered 13,010 more. The patch flushes the NIC's queue in the inject timer as soon as the queue drops back to the limit.
2. **A unicast ESP-NOW frame was reported done before its ACK.** `esp32_wifi_write` raises the tx-done interrupt (`0x80`) as soon as the DMA of an outgoing frame ends, with the packet status still `ESP32_PHYA_NACK`; `Esp32_WLAN_handle_frame` arms `wait_ack_timer`, which raises it again when the ACK arrives or after 10 ms. The patch keeps the first interrupt for every frame that does not wait for an ACK, and leaves unicast action frames to the timer. This is the behaviour hertzbench's model of the fork (`orchestrator/boards/espnow-fork-model.ts`) already assumed ([fidelity.md](fidelity.md#esp-now)).

The two hunks were not measured apart: every run on 2026-10-24 used both. The first one's effect is shown by the run (the gateway kept reading its netdev for the whole run); the second is reasoned from the code and from the model the tests already use.

Nothing else changes: broadcasts, Wi-Fi/IP data frames and management frames still raise tx-done at the end of the DMA, and the queue limit stays 20.

Apply it to a clean checkout of the fork, then build as in [e2e-esp32.md](e2e-esp32.md#setting-up-a-host-without-root):

```bash
cd ~/.local/src/lcgamboa-qemu    # lcgamboa/qemu, picsimlab-esp32, 9c298984
git apply <<'PATCH'
diff --git a/hw/misc/esp32_wifi.c b/hw/misc/esp32_wifi.c
index 5791444..98b51e1 100644
--- a/hw/misc/esp32_wifi.c
+++ b/hw/misc/esp32_wifi.c
@@ -305,8 +305,15 @@ static void esp32_wifi_write(void *opaque, hwaddr addr, uint64_t value,
                 // frame from esp32 to ap
                 frame.frame_length=item.length;
                 frame.next_frame=0;
+                s->ack_wait_armed = 0;
                 Esp32_WLAN_handle_frame(s, &frame);
-                set_interrupt(s,0x80);
+                /* A unicast frame is done when its ACK arrives or the ACK wait
+                 * runs out (wait_ack_timer), not when the DMA ends. Raised now,
+                 * the driver reads the NACK status still set and retries the
+                 * frame about 25 times in a few milliseconds. */
+                if (!s->ack_wait_armed) {
+                    set_interrupt(s,0x80);
+                }
             }
     }
     s->mem[addr/4]=value;
diff --git a/hw/misc/esp32_wifi_ap.c b/hw/misc/esp32_wifi_ap.c
index 6686115..5cc8fdb 100644
--- a/hw/misc/esp32_wifi_ap.c
+++ b/hw/misc/esp32_wifi_ap.c
@@ -105,6 +105,13 @@ static void Esp32_WLAN_inject_timer(void *opaque)
         s->inject_queue = frame->next_frame;
         Esp32_sendFrame(s, (void *)frame, frame->frame_length,frame->signal_strength);
         free(frame);
+        /* Esp32_WLAN_can_receive answers false while the queue is over its
+         * limit, which parks the netdev's packet and stops it reading its
+         * socket until the NIC is flushed. Nothing else flushes it: do it as
+         * soon as room opens, or the netdev never reads again. */
+        if (s->inject_queue_size == Esp32_WLAN__MAX_INJECT_QUEUE_SIZE) {
+            qemu_flush_queued_packets(qemu_get_queue(s->nic));
+        }
     }
     if (s->inject_queue_size > 0) {
         // there are more packets... schedule
@@ -640,6 +647,7 @@ void Esp32_WLAN_handle_frame(Esp32WifiState *s, struct mac80211_frame *frame)
                 //if destination is not broadcast wait for ack 
                 if(memcmp(&ethernet_frame[0],BROADCAST,6)){ 
                    Esp32_WLAN_Set_Packet_Status(ESP32_PHYA_NACK);
+                   s->ack_wait_armed = 1;
                    timer_mod(s->wait_ack_timer, qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL) + WAIT_ACK_TIMEOUT);
                    return;
                 }
diff --git a/include/hw/misc/esp32_wifi.h b/include/hw/misc/esp32_wifi.h
index 7ac57c1..9fa55aa 100644
--- a/include/hw/misc/esp32_wifi.h
+++ b/include/hw/misc/esp32_wifi.h
@@ -35,6 +35,7 @@ typedef struct Esp32WifiState {
     int inject_timer_running;
     unsigned int inject_sequence_number;
     int beacon_ap;
+    int ack_wait_armed;
 
     hwaddr receive_queue_address;
     uint32_t receive_queue_count;
PATCH
```

Check that a checkout carries it: `git -C ~/.local/src/lcgamboa-qemu apply --check -R` with the same heredoc succeeds. After a fork update, re-apply; if a hunk fails, the two places to find are the `A_WIFI_DMA_OUTLINK` case of `esp32_wifi_write` and the end of `Esp32_WLAN_inject_timer`. Drop the patch once the fork flushes its NIC queue and defers unicast tx-done itself.

Velxio's own QEMU source archive (`docs/BUILD-QEMU.md`) was not checked: it may carry the same defects. The one Velxio file this patch touches is that doc: its section 7, "The ESP-NOW patch hertzbench applies to the public fork", points here, and the file carries the header line.

**Verified on real firmware** (2026-10-24): see [e2e-esp32.md](e2e-esp32.md#results-on-real-firmware).

### Patch 4: the QEMU fork's clocks across a CPU clock switch (outside this tree)

Why: Arduino-ESP32 boards reset on `TG1WDT_SYS_RESET`, then `TG0WDT_SYS_RESET`, about 2 s after `entry 0x400805e4` and before `setup()`, a variable number of times per run ([missing-tests.md](missing-tests.md), the Android rows). The cause is in the fork's models, read from its code and measured with a traced build on 2026-11-14:

1. **CCOUNT is not a counter in the model.** `HELPER(update_ccount)` (`target/xtensa/op_helper.c`) computes `CCOUNT = ccount_base + ticks(now - time_base)` at the clock's *current* period, and `esp32_clk_update` (`hw/xtensa/esp32_picsimlab.c` and `esp32.c`) changes that period with a bare `clock_update_hz`, which runs no callback on the CPU's own clock. Every switch rescales all the time since boot: CCOUNT jumps by `elapsed x delta_f`, backwards when the clock slows down, and the CCOMPARE timers stay armed for the old frequency. On silicon CCOUNT only changes rate.
2. **Arduino switches the clock while the FreeRTOS tick runs.** `initArduino()` calls `setCpuFrequencyMhz(240)`, which goes 160 MHz -> XTAL (40 MHz) -> 240 MHz. In the traces the XTAL window lasted 0.3 to 1.2 ms. A tick taken in it reads a CCOUNT that just fell by 390 to 400 million cycles and arms the next tick 9.5 to 10.1 s away (five failing boots traced). That core stops ticking.
3. **The interrupt watchdog then fires.** The int WDT (TG1, 300 ms) is fed from core 0's tick hook only after core 1 ticked (`CONFIG_ESP_INT_WDT_CHECK_CPU1`). With one core silent, stage 0 fires 300 ms later. Both cores park in the busy-wait of `panic_handler` (PC `0x400df66f` on both) and nothing is printed. Stage 1 resets the chip 600 ms after that: `TG1WDT_SYS_RESET`.
4. **The `TG0WDT_SYS_RESET` right after is a cascade, not a stale timer.** The bootloader does disarm the TG0 flash-boot watchdog (`TIMG_WDTCONFIG0=0x00048000` at about 362 ms). After the TG1 reset the hardware re-arms it, as it should, with 26,000,000 ticks. Two model quirks then trip it:
   - The model keeps the timer group's APB at the previous boot's 80 MHz, so the budget is 325 ms instead of 650 ms.
   - The ROM spends about 300 ms in `_reload_efuses_and_check`, because the fork's eFuse op timer is 100 ms per command. Its own comment in `hw/nvram/esp32_efuse.c` says 10 ms.

   Patch 4 leaves both alone; without the TG1 reset this path is not reached.
5. **The same switch rescales the APB-clocked timers.** The timer groups (T0, T1, the LAC timer behind `esp_timer`, and the MWDT) and the FRC timer also compute their count as `base + (now - ns_base) x apb / divider`. The switch takes APB 80 -> 40 -> 80 MHz, and the `apb_freq` property setters only store the new rate. A count read, or a config or alarm written, inside that window is off by `elapsed / 2`. A config write folds that error into the base for good. This one is read from the code, not caught in a trace.

What the patch changes:

- **`xtensa_cpu_set_clock_hz()` (CPU clock).** It folds CCOUNT at the old period (`ccount_base = CCOUNT`, `time_base = now`), changes the clock, then re-arms the comparators that are still pending at the new period. Both machines' `esp32_clk_update` call it.
- **The `apb_freq` setters of `esp32_timg.c` and `esp32_frc_timer.c` (APB timers).** They do the same for each timer's count and pending alarm. For the MWDT this applies only while it is enabled.
- **A timer already due is left to fire.** That is a deadline already passed, or a CCOUNT already at CCOMPARE, or an alarm already reached. Re-arming it would push it a whole wrap away. The first version of this patch did that, and 1 boot in 6 still reset.
- **MTTCG race.** Under MTTCG the CPU part writes the other vCPU's timebase from the switching thread, so a CCOUNT read racing the switch can see it half-updated. Clock switches are a handful per boot.

**Board silent for 20 s.** This may also explain the board found silent for 20 s with both vCPU threads in `qemu_wait_io_event`, since a core whose next tick is armed seconds away sits in `WAITI`. That was not reproduced. The silent boards under load on 2026-11-14 were something else: they ticked normally and were waiting for Wi-Fi (see [e2e-esp32.md](e2e-esp32.md#boot-resets-and-patch-4)).

Apply it to the fork, with or without patch 3 (they touch different files; `git apply --check --cached` passes against a clean `9c298984`), then build as in [e2e-esp32.md](e2e-esp32.md#setting-up-a-host-without-root):

```bash
cd ~/.local/src/lcgamboa-qemu    # lcgamboa/qemu, picsimlab-esp32, 9c298984
git apply /path/to/hertzbench/docs/qemu-esp32-clock-switch.patch
```

**Checking and maintaining it.** A checkout carries the patch when `git apply --check -R` with the same file succeeds. After a fork update, these are the places to find again:

- `HELPER(update_ccompare)` in `target/xtensa/op_helper.c`.
- The two `clock_update_hz(s->cpu[...` lines at the end of `esp32_clk_update`.
- The `apb_freq` setters in `hw/timer/esp32_timg.c` and `hw/timer/esp32_frc_timer.c`.

Drop the patch once the fork keeps these counts continuous across a clock change itself.

**Verified on real firmware** (2026-11-14), with `udp-3-nodes.yaml` through hertzbench and default threading: 10 runs in a row on an idle host and 10 beside 10 busy loops, 0 resets and 0 watchdog lines in all 60 boots, against 9 to 26 resets per run with the installed library. Two of the loaded runs failed because Wi-Fi did not associate, which the installed library without its watchdogs does too. `-accel tcg,thread=single` still resets, for another reason (round robin against cross-core spins). See [e2e-esp32.md](e2e-esp32.md#boot-resets-and-patch-4).

### Velxio behaviours hertzbench depends on but does not change

Recorded so a merge that moves them gets noticed:

- `esp32_worker.py` stdin protocol: one JSON config line, then `{"cmd": "stop"}` to end the run; stdout JSON lines with `uart_tx`, `serial_output`, `system` and `error` events.
- `espidf_compiler.compile(files, board_fqbn)` returns `binary_content` (base64) and rewrites any `WiFi.begin()` to SSID `Espressif`, open auth, channel 5 (`espidf_compiler.py`, `_QEMU_WIFI_SSID` and `_QEMU_WIFI_CHANNEL`). The example sketch says so explicitly.
- `QEMU_ESP32_LIB` names the libqemu shared library, as in `esp32_lib_manager.py`.
- `esp32_worker.py` `uart_send` command, `{"cmd": "uart_send", "uart": N, "data": "<base64>"}` (header line 17), feeds bytes to any UART through `qemu_picsimlab_uart_receive`, and the `uart_tx` event, `{"type": "uart_tx", "uart": N, "byte": V}` (header line 32), reports every byte any UART sends. The BLE relay uses both on the radio's `hci_uart`; `tests/cli_test.ts` pins the shapes with a stand-in worker.
- The view (`hertzbench/view/server.ts`) serves these frontend files as they are, at request time: `frontend/src/tokens/{index,colors,spacing,typography,radius,elevation,motion,z-index}.css` (and their `@import` of each other), `frontend/public/fonts/{Inter,JetBrainsMono}.var.woff2` at `/fonts/` (the path `typography.css` names), and `frontend/public/boards/esp32-devkit-v1.svg`. A rename upstream makes that request answer 404 and the page fall back to its own colors and the system font; see [view.md](view.md#what-comes-from-velxio).
