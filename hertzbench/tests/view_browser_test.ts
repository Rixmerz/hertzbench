// The page in a real browser: headless Chromium, driven over the DevTools
// protocol with real mouse input, drags a node on the map of a running
// `hertzbench view` and the engine must see the move. Skipped when no Chromium
// is installed; set HERTZBENCH_CHROMIUM to point at one.

import { fileURLToPath } from "node:url";
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  BROWSER_START_TIMEOUT_MS,
  Cdp,
  chromiumArgs,
  findChromium,
  PAGE_TIMEOUT_MS,
  StderrWatch,
  terminate,
} from "./chromium.ts";

const MAIN = fileURLToPath(new URL("../cli/main.ts", import.meta.url));
const LIVE = fileURLToPath(new URL("../scenarios/examples/live-3-scripted.yaml", import.meta.url));

const CHROMIUM = findChromium();

Deno.test({
  name: "browser: dragging a node on the map moves it in the engine",
  ignore: CHROMIUM === null,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "hzb-browser-" });
    // The run's clock starts with the view, before Chromium is up, and a 120 s run can end
    // inside the budgets the waits below get: the drag needs one that outlives them all.
    const live = await Deno.readTextFile(LIVE);
    assert(live.includes("\nduration: 120s\n"), "live-3-scripted.yaml no longer lasts 120 s");
    await Deno.writeTextFile(
      `${dir}/live.yaml`,
      live.replace("\nduration: 120s\n", "\nduration: 600s\n"),
    );
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
        `${dir}/live.yaml`,
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
    let status: Deno.CommandStatus;
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

      // Centre of each node on screen, once the page shows the run as running and has drawn the
      // map at the size its box has. The first frame of a run is drawn at the box's earlier size
      // and redrawn when the box settles, tens of ms later: the map's scale was 5.7 px/m in that
      // frame and 9.3 after it, so coordinates taken in it put the press and the drop off.
      // Until then the answer says what the page shows instead, for the error a timeout raises.
      const centres = `(() => {
        const state = document.getElementById("state");
        if (!state) return { waiting: "the page at " + location.href };
        if (["finished", "failed", "stopped"].includes(state.dataset.state)) {
          return { ended: state.textContent };
        }
        if (state.dataset.state !== "running") return { waiting: "state " + state.textContent };
        const box = document.getElementById("map-box").getBoundingClientRect();
        const [, , width, height] = document.getElementById("map").getAttribute("viewBox")
          .split(" ").map(Number);
        if (Math.abs(width - box.width) > 0.5 || Math.abs(height - box.height) > 0.5) {
          return { waiting: "the map drawn at its box's earlier size" };
        }
        const out = {};
        for (const node of document.querySelectorAll(".node")) {
          const r = node.querySelector("circle.node-dot").getBoundingClientRect();
          out[node.getAttribute("aria-label").split(",")[0]] = [r.x + r.width / 2, r.y + r.height / 2];
        }
        const count = Object.keys(out).length;
        return count === 3 ? { out } : { waiting: count + " nodes" };
      })()`;
      type Centres = Record<string, [number, number]>;
      const deadline = performance.now() + PAGE_TIMEOUT_MS;
      let showing = "nothing yet";
      const settled = async (): Promise<Centres> => {
        for (;;) {
          const found: { out?: Centres; waiting?: string; ended?: string } | undefined =
            await evaluate(centres);
          if (found?.out) return found.out;
          // A run that is over cannot be dragged in: waiting longer would only hide why.
          if (found?.ended) throw new Error(`the run ended before the drag: ${found.ended}`);
          showing = found?.waiting ?? showing;
          if (performance.now() > deadline) {
            throw new Error(`the page never showed three running nodes; it showed ${showing}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      };
      const sameCentres = (x: Centres, y: Centres) =>
        Object.entries(x).every(([id, [px, py]]) =>
          Math.abs(px - y[id]![0]) < 0.5 && Math.abs(py - y[id]![1]) < 0.5
        );
      // A reading is taken as true when one more, a poll of the page (250 ms) later, agrees.
      let at = await settled();
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const again = await settled();
        if (sameCentres(at, again)) break;
        at = again;
      }
      // a is at (0, 0) m and b at (8, 0) m: that fixes the map's scale and origin.
      const [ax, ay] = at.a!;
      const [bx] = at.b!;
      const pxPerMetre = (bx - ax) / 8;
      const [cx, cy] = at.c!;
      // Screen y grows down and the map's y grows up: 3 m up the map is 3 m less on screen.
      const [toX, toY] = [cx + 6 * pxPerMetre, cy - 3 * pxPerMetre];

      const mouse = (type: string, x: number, y: number) =>
        page("Input.dispatchMouseEvent", {
          type,
          x,
          y,
          button: "left",
          buttons: type === "mouseReleased" ? 0 : 1,
          clickCount: 1,
        });
      await mouse("mouseMoved", cx, cy);
      await mouse("mousePressed", cx, cy);
      for (let step = 1; step <= 10; step++) {
        await mouse("mouseMoved", cx + ((toX - cx) * step) / 10, cy + ((toY - cy) * step) / 10);
      }
      await mouse("mouseReleased", toX, toY);

      const expected = { x: (toX - ax) / pxPerMetre, y: -(toY - ay) / pxPerMetre };
      let position: { x: number; y: number } | null = null;
      const moveDeadline = performance.now() + PAGE_TIMEOUT_MS;
      for (;;) {
        const scene = await (await fetch(`${url}api/view?since=999999999`)).json();
        position = scene.status.nodes.find((n: { id: string }) => n.id === "c").position;
        if (position!.x !== 12 || performance.now() > moveDeadline) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assertAlmostEquals(position!.x, expected.x, 0.25);
      assertAlmostEquals(position!.y, expected.y, 0.25);
      assertAlmostEquals(position!.x, 18, 0.25);
      assertAlmostEquals(position!.y, 7, 0.25);
      // One drag is one move in the engine, not one per pointer event.
      const timeline = await (await fetch(`${url}api/view?since=-1`)).json();
      const moves = timeline.timeline.entries.filter((e: { type: string }) => e.type === "move");
      assertEquals(moves.length, 1);
      const label = await evaluate(
        `[...document.querySelectorAll(".node")].map((n) => n.getAttribute("aria-label")).find((l) => l.startsWith("c,"))`,
      );
      assert(String(label).includes("at x 18.0 m, y 7.0 m"), String(label));
    } finally {
      await cdp?.close();
      terminate(browser);
      await browser.status;
      await browserLog.done;
      view.kill("SIGINT");
      status = await view.status;
      await viewLog.done;
      await Deno.remove(dir, { recursive: true });
    }
    // Not in the finally: a view killed before it started exits 130, and that would replace the
    // error that says why the test failed.
    assertEquals(status.code, 0, viewLog.text);
  },
});
