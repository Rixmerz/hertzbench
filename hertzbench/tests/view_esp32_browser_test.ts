// Real ESP32 firmware under `hertzbench view`, in headless Chromium: a node is dragged away behind
// the wall and back, and the page's link table and the medium's deliveries must follow. Skipped
// without a Chromium (HERTZBENCH_CHROMIUM) or without the ESP32 runtime (QEMU_ESP32_LIB pointing at
// libqemu-xtensa.so, see docs/e2e-esp32.md); the first run compiles the sketch.

import { fileURLToPath } from "node:url";
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  BROWSER_START_TIMEOUT_MS,
  Cdp,
  chromiumArgs,
  findChromium,
  StderrWatch,
  terminate,
} from "./chromium.ts";

const MAIN = fileURLToPath(new URL("../cli/main.ts", import.meta.url));
const FIRMWARE = fileURLToPath(new URL("../scenarios/examples/fw/udp-node", import.meta.url));

function hasEsp32Runtime(): boolean {
  const lib = Deno.env.get("QEMU_ESP32_LIB");
  if (!lib) return false;
  try {
    return Deno.statSync(lib).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

const CHROMIUM = findChromium();

// udp-3-nodes.yaml without its timed move and with a run long enough to drag in: the drag is the
// only thing that moves c.
const SCENARIO = (firmware: string) => `
name: drag-esp32
seed: 42
duration: 600s
environment:
  preset: indoor_office
  shadowing_sigma_db: 0
  obstacles:
    - { polygon: [[30, -20], [30, 20]], attenuation_db: 12 }
nodes:
  - { id: a, board: esp32, firmware: ${firmware}, position: [0, 0], radios: [{ phy: wifi, channel: 5, tx_power_dbm: 15 }] }
  - { id: b, board: esp32, firmware: ${firmware}, position: [8, 0], radios: [{ phy: wifi, channel: 5, tx_power_dbm: 15 }] }
  - { id: c, board: esp32, firmware: ${firmware}, position: [12, 4], radios: [{ phy: wifi, channel: 5, tx_power_dbm: 15 }] }
`;

type Entry = { seq: number; type: string; from?: string; to?: string; kind?: string };

Deno.test({
  name: "browser: dragging a real ESP32 node away and back moves its links and its loss",
  ignore: CHROMIUM === null || !hasEsp32Runtime(),
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "hzb-esp32-browser-" });
    await Deno.writeTextFile(`${dir}/drag.yaml`, SCENARIO(FIRMWARE));
    const view = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-net=127.0.0.1",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "--allow-env",
        MAIN,
        "view",
        `${dir}/drag.yaml`,
        "--port",
        "0",
        "--out",
        `${dir}/out`,
      ],
      stdout: "null",
      stderr: "piped",
    }).spawn();
    const viewLog = new StderrWatch(view.stderr);
    const browser = new Deno.Command(CHROMIUM!, {
      args: chromiumArgs(`${dir}/profile`),
      stdout: "null",
      stderr: "piped",
    }).spawn();
    const browserLog = new StderrWatch(browser.stderr);
    let cdp: Cdp | null = null;
    try {
      const [, url] = await viewLog.waitFor(
        /view: (http:\/\/127\.0\.0\.1:\d+\/)/,
        BROWSER_START_TIMEOUT_MS,
      );
      const [, devtools] = await browserLog.waitFor(
        /DevTools listening on (ws:\/\/\S+)/,
        BROWSER_START_TIMEOUT_MS,
      );
      cdp = await Cdp.connect(devtools!);
      const { targetId } = await cdp.send("Target.createTarget", { url: url! });
      const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      const page = (method: string, params: Record<string, unknown> = {}) =>
        cdp!.send(method, params, sessionId);
      const evaluate = async (expression: string) =>
        (await page("Runtime.evaluate", { expression, returnByValue: true })).result.value;

      /** Polls `read` until it returns something other than null, or fails naming `what`. */
      const until = async <T>(what: string, timeoutMs: number, read: () => Promise<T | null>) => {
        const deadline = performance.now() + timeoutMs;
        for (;;) {
          const found = await read();
          if (found !== null) return found;
          if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      };
      const scene = async () => await (await fetch(`${url}api/view?since=-1`)).json();
      // The loss the page's link table shows for `from → to`, as a number, or null while "–".
      const tableLoss = (link: string) =>
        evaluate(`(() => {
          const row = [...document.querySelectorAll("#links tr")]
            .find((r) => r.cells[0].textContent.startsWith(${JSON.stringify(link)}));
          const text = row?.cells[4].textContent ?? "–";
          return text === "–" ? null : parseFloat(text);
        })()`) as Promise<number | null>;
      // Frames of c->a with an outcome after `seq`: deliveries and drops, from the medium's log.
      const outcomes = async (afterSeq: number) => {
        const entries: Entry[] = (await scene()).timeline.entries;
        const mine = entries.filter((e) =>
          e.seq > afterSeq && e.from === "c" && e.to === "a" && e.kind === "udp"
        );
        return {
          delivered: mine.filter((e) => e.type === "deliver").length,
          dropped: mine.filter((e) => e.type === "drop").length,
        };
      };
      const lastSeq = async () => (await scene()).timeline.next_since - 1;

      // Real firmware: the boards boot, take a lease, and only then do udp frames cross the links.
      // Wait until the page shows a loss figure for c → a, with clean links.
      await until("udp traffic on c -> a", 240_000, async () => {
        const loss = await tableLoss("c → a");
        const { delivered } = await outcomes(-1);
        return loss !== null && delivered >= 5 ? true : null;
      });
      assertEquals(await tableLoss("c → a"), 0);

      const centres = `(() => {
        if (document.getElementById("state").dataset.state !== "running") return null;
        const box = document.getElementById("map-box").getBoundingClientRect();
        const [, , width, height] = document.getElementById("map").getAttribute("viewBox")
          .split(" ").map(Number);
        if (Math.abs(width - box.width) > 0.5 || Math.abs(height - box.height) > 0.5) return null;
        const out = {};
        for (const node of document.querySelectorAll(".node")) {
          const r = node.querySelector("circle.node-ring").getBoundingClientRect();
          out[node.getAttribute("aria-label").split(",")[0]] = [r.x + r.width / 2, r.y + r.height / 2];
        }
        return Object.keys(out).length === 3 ? out : null;
      })()`;
      type Centres = Record<string, [number, number]>;
      // a is at (0, 0) m and b at (8, 0) m: that fixes the map's scale and origin. The map fits
      // itself to the nodes, so a move rescales it: read it again before every drag.
      const layout = async () => {
        const at = await until("three drawn nodes", 20_000, async () => {
          const first: Centres | null = await evaluate(centres);
          if (!first) return null;
          await new Promise((resolve) => setTimeout(resolve, 300));
          const second: Centres | null = await evaluate(centres);
          return second &&
              Object.entries(first).every(([id, [x, y]]) =>
                Math.abs(x - second[id]![0]) < 0.5 && Math.abs(y - second[id]![1]) < 0.5
              )
            ? second
            : null;
        });
        const [ax, ay] = at.a!;
        const pxPerMetre = (at.b![0] - ax) / 8;
        return (x: number, y: number): [number, number] => [
          ax + x * pxPerMetre,
          ay - y * pxPerMetre,
        ];
      };
      const mouse = (type: string, x: number, y: number) =>
        page("Input.dispatchMouseEvent", {
          type,
          x,
          y,
          button: "left",
          buttons: type === "mouseReleased" ? 0 : 1,
          clickCount: 1,
        });
      /** Presses c where the map shows it now and drops it at (x, y) m, with real mouse events. */
      const dragC = async (from: [number, number], to: [number, number]) => {
        const screen = await layout();
        const [fx, fy] = screen(...from);
        const [tx, ty] = screen(...to);
        await mouse("mouseMoved", fx, fy);
        await mouse("mousePressed", fx, fy);
        for (let step = 1; step <= 10; step++) {
          await mouse("mouseMoved", fx + ((tx - fx) * step) / 10, fy + ((ty - fy) * step) / 10);
        }
        await mouse("mouseReleased", tx, ty);
        await until(`c at ${to}`, 5_000, async () => {
          const c = (await scene()).status.nodes.find((n: { id: string }) => n.id === "c");
          return Math.abs(c.position.x - to[0]) < 0.25 && Math.abs(c.position.y - to[1]) < 0.25
            ? true
            : null;
        });
      };
      const lossOfLinks = async () => {
        const links: {
          from: string;
          to: string;
          snr_db: number;
          window_loss_pct: number | null;
        }[] = (await scene()).scene.links;
        return Object.fromEntries(links.map((l) => [`${l.from}>${l.to}`, l]));
      };

      const nearSnr = (await lossOfLinks())["c>a"]!.snr_db;

      // Away: behind the wall at x = 30 m, 42 m from a.
      const beforeAway = await lastSeq();
      await dragC([12, 4], [42, 0]);
      await until("the page to show c -> a lossy", 60_000, async () => {
        const loss = await tableLoss("c → a");
        return loss !== null && loss > 20 ? true : null;
      });
      const away = await lossOfLinks();
      assert(away["c>a"]!.snr_db < nearSnr - 15, `c>a SNR ${away["c>a"]!.snr_db} vs ${nearSnr}`);
      assertAlmostEquals(
        away["c>a"]!.snr_db,
        away["a>c"]!.snr_db,
        0.01,
        "both halves of the pair follow the node",
      );
      const lineClasses = await evaluate(
        `[...document.querySelectorAll(".link")].map((l) => l.getAttribute("class"))`,
      );
      assert(String(lineClasses).includes("q-bad") || String(lineClasses).includes("q-poor"));
      // The medium's own log: frames of c->a sent after the drop are mostly lost.
      const farFrames = await until("20 c->a frames after the drop", 60_000, async () => {
        const f = await outcomes(beforeAway);
        return f.delivered + f.dropped >= 20 ? f : null;
      });
      assert(
        farFrames.dropped / (farFrames.delivered + farFrames.dropped) > 0.2,
        `behind the wall the medium dropped ${farFrames.dropped} of ${
          farFrames.delivered + farFrames.dropped
        } c->a frames`,
      );

      // Back: next to a and b again, the loss window empties and the medium delivers.
      await dragC([42, 0], [12, 4]);
      await until("the page to show c -> a clean", 60_000, async () => {
        const loss = await tableLoss("c → a");
        return loss !== null && loss < 5 ? true : null;
      });
      // Frames still in flight from behind the wall land after the drop: count from the moment
      // the page shows the 2 s window clean.
      const cleanSeq = await lastSeq();
      const back = await lossOfLinks();
      assertAlmostEquals(back["c>a"]!.snr_db, nearSnr, 0.5);
      const nearFrames = await until("20 c->a frames after the return", 60_000, async () => {
        const f = await outcomes(cleanSeq);
        return f.delivered + f.dropped >= 20 ? f : null;
      });
      assert(
        nearFrames.dropped / (nearFrames.delivered + nearFrames.dropped) < 0.1,
        `back in range the medium dropped ${nearFrames.dropped} of ${
          nearFrames.delivered + nearFrames.dropped
        } c->a frames`,
      );
    } finally {
      await cdp?.close();
      terminate(browser);
      await browser.status;
      await browserLog.done;
      view.kill("SIGINT");
      const status = await view.status;
      await viewLog.done;
      await Deno.remove(dir, { recursive: true });
      assertEquals(status.code, 0, viewLog.text);
    }
  },
});
