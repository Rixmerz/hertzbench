import { assert, assertEquals } from "@std/assert";
import { ManualClock, WallClock } from "../engine/mod.ts";
import { MediumClock } from "../orchestrator/medium-clock.ts";

Deno.test("medium clock: a delay below one timer tick runs before any timer could fire", async () => {
  const base = new WallClock();
  const clock = new MediumClock(base);
  const order: string[] = [];
  const timer = new Promise<void>((resolve) =>
    setTimeout(() => {
      order.push("timer");
      resolve();
    }, 0)
  );
  clock.schedule(clock.now() + 0.2, () => order.push("first"));
  clock.schedule(clock.now() + 0.05, () => order.push("second"));
  order.push("sync");
  await timer;
  base.cancelAll();
  // The plain wall clock turns a 0.2 ms delay into a timer, so it would come after "timer".
  assertEquals(order, ["sync", "first", "second", "timer"]);
});

Deno.test("medium clock: a cancelled sub-tick callback never runs", async () => {
  const clock = new MediumClock(new ManualClock());
  let ran = false;
  const cancel = clock.schedule(0.1, () => (ran = true));
  cancel();
  await Promise.resolve();
  assertEquals(ran, false);
});

Deno.test("medium clock: a delay of a tick or more is the base clock's, and time is the base's", async () => {
  const base = new ManualClock();
  const clock = new MediumClock(base);
  const ran: number[] = [];
  base.advanceTo(10);
  assertEquals(clock.now(), 10);
  assertEquals(clock.kind, "manual");
  clock.schedule(12, () => ran.push(12));
  clock.schedule(10.5, () => ran.push(10.5));
  assertEquals(base.nextDueMs(), 12, "only the 2 ms delay reached the base clock's queue");
  base.advanceTo(11);
  assertEquals(ran, []);
  await Promise.resolve();
  assertEquals(ran, [10.5]);
  base.advanceTo(12);
  assertEquals(ran, [10.5, 12]);
});

Deno.test("medium clock: a sub-tick callback sees the time it was scheduled at, not a tick later", async () => {
  const base = new WallClock();
  const clock = new MediumClock(base);
  const start = clock.now();
  const seen = await new Promise<number>((resolve) =>
    clock.schedule(start + 0.3, () => resolve(clock.now()))
  );
  base.cancelAll();
  assert(seen - start < 1, `the callback ran ${seen - start} ms later`);
});
