// The clock the Wi-Fi medium schedules its deliveries on in a wall-clock run.

import type { Clock } from "../engine/mod.ts";

/** A wall-clock timer cannot fire sooner than this; shorter delays are rounded up to it. */
const TIMER_TICK_MS = 1;

/**
 * The medium models a frame's delivery a fraction of a millisecond after the send (0.2 to 0.5 ms
 * of airtime on a short link), and a wall-clock timer turns that into a tick of 2 to 3 ms on an
 * idle machine and more under load. Everything the sender measures against the fork's 10 ms ACK
 * window then includes a timer wake-up that the model does not have: on a busy runner a stalled
 * wake-up pushed the ACK round trip of a scripted ESP-NOW mesh past 10 ms. Delays below one tick
 * run right after the current task instead, with no sleep to be descheduled in, in the order they
 * were scheduled; anything longer is the base clock's.
 */
export class MediumClock implements Clock {
  readonly #base: Clock;

  constructor(base: Clock) {
    this.#base = base;
  }

  get kind(): Clock["kind"] {
    return this.#base.kind;
  }

  now(): number {
    return this.#base.now();
  }

  schedule(atMs: number, fn: () => void): () => void {
    if (atMs - this.#base.now() >= TIMER_TICK_MS) return this.#base.schedule(atMs, fn);
    let live = true;
    queueMicrotask(() => {
      if (live) fn();
    });
    return () => {
      live = false;
    };
  }
}
