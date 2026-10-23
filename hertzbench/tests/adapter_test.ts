import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  buildEfuseImage,
  EFUSE_IMAGE_BYTES,
  efuseMacCrc8,
  encodeFrame,
  FrameDecoder,
  FramingError,
  LOOPBACK,
  MAX_FRAME_BYTES,
  QemuWifiL2Adapter,
  workerNetworkConfig,
} from "../adapters/qemu-wifi-l2/mod.ts";
import { environmentFromPreset, EventLog, macToBytes, ManualClock, Medium } from "../engine/mod.ts";
import { macFor, makeRig, udpFrame, until } from "./helpers.ts";

Deno.test("framing: 4-byte big-endian length prefix, byte-exact", () => {
  const encoded = encodeFrame(Uint8Array.from([0xaa, 0xbb, 0xcc]));
  assertEquals(Array.from(encoded), [0, 0, 0, 3, 0xaa, 0xbb, 0xcc]);
  assertThrows(() => encodeFrame(new Uint8Array(MAX_FRAME_BYTES + 1)), RangeError);
});

Deno.test("framing: frames survive being cut at any byte and glued together", () => {
  const a = Uint8Array.from({ length: 60 }, (_, i) => i);
  const b = Uint8Array.from({ length: 1514 }, (_, i) => i % 251);
  const stream = new Uint8Array([...encodeFrame(a), ...encodeFrame(b)]);
  for (const chunkSize of [1, 3, 7, 61, 4096]) {
    const decoder = new FrameDecoder();
    const out: Uint8Array[] = [];
    for (let i = 0; i < stream.length; i += chunkSize) {
      out.push(...decoder.push(stream.subarray(i, i + chunkSize)));
    }
    assertEquals(out.map((f) => f.length), [60, 1514], `chunk size ${chunkSize}`);
    assertEquals(out[0], a);
    assertEquals(out[1], b);
  }
});

Deno.test("framing: a corrupt length is an error, an empty frame is skipped", () => {
  const decoder = new FrameDecoder();
  assertThrows(() => decoder.push(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 1])), FramingError);
  assertEquals(new FrameDecoder().push(Uint8Array.from([0, 0, 0, 0])), []);
});

Deno.test("efuse: CRC8 of the fork's default MAC is the 0xfe the fork stores", () => {
  // hw/nvram/esp32_efuse.c:164-168 hard-codes blk0[2] = 0x00fe1001 for 10:01:00:c4:0a:24.
  assertEquals(efuseMacCrc8(macToBytes("10:01:00:c4:0a:24")), 0xfe);
});

/** The fork's own decoding of the image (hw/xtensa/esp32_picsimlab.c:1070-1075), transcribed. */
function macSeenByFork(image: Uint8Array): string {
  const blk0Words = new Uint8Array(image.buffer, 0, 28); // little-endian uint32 blk0[7]
  const mptr = blk0Words.subarray(4); // &blk0[1]
  return Array.from({ length: 6 }, (_, i) => mptr[5 - i]!.toString(16).padStart(2, "0")).join(":");
}

Deno.test("efuse: the default MAC reproduces the fork's default words, and every MAC round-trips", () => {
  const image = buildEfuseImage("10:01:00:c4:0a:24");
  const view = new DataView(image.buffer);
  assertEquals(image.length, EFUSE_IMAGE_BYTES);
  assertEquals(view.getUint32(4, true), 0x00c40a24);
  assertEquals(view.getUint32(8, true), 0x00fe1001);

  for (const index of [1, 2, 3, 10, 200]) {
    const mac = macFor(index);
    assertEquals(macSeenByFork(buildEfuseImage(mac)), mac);
  }
  // Everything outside blk0[1..2] stays zero, as for a board with no image.
  const custom = buildEfuseImage(macFor(1));
  assert(custom.subarray(0, 4).every((b) => b === 0));
  assert(custom.subarray(12).every((b) => b === 0));
});

Deno.test("efuse: assigned MACs are locally administered and differ from the fork's own addresses", () => {
  const forkAddresses = new Set([
    "10:01:00:c4:0a:24",
    "10:01:00:c4:0a:56",
    "10:01:00:c4:0a:51",
    "10:01:00:c4:0a:52",
    "10:13:46:bf:31:50",
  ]);
  for (let i = 1; i <= 10; i++) {
    const mac = macFor(i);
    assert((macToBytes(mac)[0]! & 0x02) !== 0, "locally administered bit");
    assert((macToBytes(mac)[0]! & 0x01) === 0, "unicast");
    assert(!forkAddresses.has(mac));
  }
});

Deno.test("worker contract: the two fields the Velxio patch reads", () => {
  assertEquals(workerNetworkConfig(40123, "/tmp/efuse.bin"), {
    wifi_l2_port: 40123,
    efuse_image: "/tmp/efuse.bin",
  });
});

/** Stands in for a board's QEMU: a TCP client that speaks the netdev framing. */
class FakeQemu {
  readonly received: Uint8Array[] = [];
  readonly #decoder = new FrameDecoder();
  readonly #conn: Deno.TcpConn;
  readonly #reading: Promise<void>;

  private constructor(conn: Deno.TcpConn) {
    this.#conn = conn;
    this.#reading = this.#read();
  }

  static async connect(port: number): Promise<FakeQemu> {
    return new FakeQemu(await Deno.connect({ hostname: LOOPBACK, port }));
  }

  async #read(): Promise<void> {
    const buffer = new Uint8Array(65536);
    try {
      for (;;) {
        const n = await this.#conn.read(buffer);
        if (n === null) return;
        this.received.push(...this.#decoder.push(buffer.subarray(0, n)));
      }
    } catch {
      // The adapter closed the connection on shutdown; that ends the stream.
    }
  }

  async send(frame: Uint8Array, chunk = frame.length + 4): Promise<void> {
    const bytes = encodeFrame(frame);
    for (let i = 0; i < bytes.length; i += chunk) {
      await this.#conn.write(bytes.subarray(i, i + chunk));
    }
  }

  async close(): Promise<void> {
    try {
      this.#conn.close();
    } catch {
      // Already closed by the adapter.
    }
    await this.#reading;
  }
}

interface Bench {
  clock: ManualClock;
  log: EventLog;
  medium: Medium;
  adapter: QemuWifiL2Adapter;
  ports: Map<string, number>;
  problems: string[];
}

function bench(ids: string[], connectedBoards = true): Bench {
  const clock = new ManualClock();
  const log = new EventLog();
  const medium = new Medium({
    seed: 5,
    environment: environmentFromPreset("indoor_office"),
    clock,
    log,
  });
  const problems: string[] = [];
  const adapter = new QemuWifiL2Adapter(
    (id, frame) => medium.transmit(id, frame),
    (id, message) => problems.push(`${id}: ${message}`),
  );
  const ports = new Map<string, number>();
  ids.forEach((id, i) => {
    const attachment = adapter.listen(id);
    ports.set(id, attachment.port);
    medium.addNode({
      id,
      mac: macFor(i + 1),
      position: { x: i * 5, y: 0 },
      radio: { channel: 6, txPowerDbm: 15, antennaGainDbi: 0 },
    }, attachment.sink);
  });
  void connectedBoards;
  return { clock, log, medium, adapter, ports, problems };
}

Deno.test("adapter: a frame from one board's netdev reaches the other board's netdev", async () => {
  const b = bench(["a", "b"]);
  const qa = await FakeQemu.connect(b.ports.get("a")!);
  const qb = await FakeQemu.connect(b.ports.get("b")!);
  try {
    await Promise.all([b.adapter.waitConnected("a", 2000), b.adapter.waitConnected("b", 2000)]);
    const rig = makeRig({ positions: { a: { x: 0, y: 0 }, b: { x: 5, y: 0 } } });
    const frame = udpFrame(rig, "a", "b", "over the wire");
    await qa.send(frame, 5); // dribbled in 5-byte pieces, as TCP may deliver it
    await until(() => b.log.events.some((e) => e.type === "tx"), "the engine to see the frame");
    b.clock.runAll();
    await until(() => qb.received.length === 1, "the frame to reach board b");
    assertEquals(qb.received[0], frame);
    assertEquals(qa.received.length, 0);
    assertEquals(b.problems, []);
  } finally {
    await qa.close();
    await qb.close();
    await b.adapter.close();
  }
});

Deno.test("adapter: frames to a board that has not connected are dropped as no_peer", async () => {
  const b = bench(["a", "b"]);
  const qa = await FakeQemu.connect(b.ports.get("a")!);
  try {
    await b.adapter.waitConnected("a", 2000);
    assert(!b.adapter.isConnected("b"));
    const rig = makeRig({ positions: { a: { x: 0, y: 0 }, b: { x: 5, y: 0 } } });
    await qa.send(udpFrame(rig, "a", "b"));
    await until(() => b.log.events.some((e) => e.type === "drop"), "the drop to be logged");
    const drop = b.log.events.find((e) => e.type === "drop");
    assert(drop && drop.type === "drop" && drop.reason === "no_peer");
  } finally {
    await qa.close();
    await b.adapter.close();
  }
});

Deno.test("adapter: a second connection to a node's port is refused", async () => {
  const b = bench(["a"]);
  const first = await FakeQemu.connect(b.ports.get("a")!);
  let second: FakeQemu | undefined;
  try {
    await b.adapter.waitConnected("a", 2000);
    second = await FakeQemu.connect(b.ports.get("a")!);
    await until(() => b.problems.length === 1, "the refusal to be reported");
    assert(b.problems[0]!.includes("second connection"));
    assert(b.adapter.isConnected("a"), "the first board stays attached");
  } finally {
    await second?.close();
    await first.close();
    await b.adapter.close();
  }
});

Deno.test("adapter: a corrupt stream is reported and the board is cut off", async () => {
  const b = bench(["a"]);
  const conn = await Deno.connect({ hostname: LOOPBACK, port: b.ports.get("a")! });
  try {
    await b.adapter.waitConnected("a", 2000);
    await conn.write(Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0]));
    await until(() => b.problems.length === 1, "the framing error to be reported");
    assert(b.problems[0]!.includes("corrupt"));
    await until(() => !b.adapter.isConnected("a"), "the board to be disconnected");
  } finally {
    conn.close();
    await b.adapter.close();
  }
});

Deno.test("adapter: waitConnected times out when the board never comes", async () => {
  const b = bench(["a"]);
  try {
    await assertRejects(() => b.adapter.waitConnected("a", 30), Error, "did not connect");
    await assertRejects(() => b.adapter.waitConnected("ghost", 30), Error, "not attached");
  } finally {
    await b.adapter.close();
  }
});

Deno.test("adapter: a board can reconnect after it drops", async () => {
  const b = bench(["a"]);
  const first = await FakeQemu.connect(b.ports.get("a")!);
  await b.adapter.waitConnected("a", 2000);
  await first.close();
  await until(() => !b.adapter.isConnected("a"), "the drop to be noticed");
  const again = await FakeQemu.connect(b.ports.get("a")!);
  try {
    await b.adapter.waitConnected("a", 2000);
    assert(b.adapter.isConnected("a"));
  } finally {
    await again.close();
    await b.adapter.close();
  }
});
