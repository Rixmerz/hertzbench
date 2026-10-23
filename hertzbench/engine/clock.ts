// The engine never reads the system clock directly. A Clock tells it what time
// it is (milliseconds since the run started) and runs callbacks later, so tests
// can drive time by hand and a real run can use the wall clock.

export interface Clock {
  /** Milliseconds since the run started. */
  now(): number;
  /** Run `fn` when the clock reaches `atMs`. Calls scheduled for the same instant run in call order. */
  schedule(atMs: number, fn: () => void): () => void;
  /** Which kind of time this is, for the report (PLAN.md §8: say which clock each node used). */
  readonly kind: "wall" | "manual";
}

/** Real time. Delays shorter than the timer resolution round up to one tick. */
export class WallClock implements Clock {
  readonly kind = "wall";
  #origin = performance.now();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();

  now(): number {
    return performance.now() - this.#origin;
  }

  /** Make "now" time zero again, e.g. once every board has connected. Call before scheduling anything. */
  restart(): void {
    this.#origin = performance.now();
  }

  schedule(atMs: number, fn: () => void): () => void {
    const handle = setTimeout(() => {
      this.#timers.delete(handle);
      fn();
    }, Math.max(0, atMs - this.now()));
    this.#timers.add(handle);
    return () => {
      clearTimeout(handle);
      this.#timers.delete(handle);
    };
  }

  /** Cancel everything still pending. A run that ends with live timers leaks them. */
  cancelAll(): void {
    for (const handle of this.#timers) clearTimeout(handle);
    this.#timers.clear();
  }
}

interface Pending {
  at: number;
  order: number;
  fn: () => void;
}

/** Time that only moves when the test says so. */
export class ManualClock implements Clock {
  readonly kind = "manual";
  #now = 0;
  #order = 0;
  #queue: Pending[] = [];

  now(): number {
    return this.#now;
  }

  schedule(atMs: number, fn: () => void): () => void {
    const entry: Pending = { at: Math.max(atMs, this.#now), order: this.#order++, fn };
    this.#queue.push(entry);
    return () => {
      this.#queue = this.#queue.filter((p) => p !== entry);
    };
  }

  /** Move time forward to `toMs`, running everything due on the way, in time order. */
  advanceTo(toMs: number): void {
    if (toMs < this.#now) {
      throw new RangeError(`cannot move time back to ${toMs} from ${this.#now}`);
    }
    for (;;) {
      this.#queue.sort((a, b) => a.at - b.at || a.order - b.order);
      const next = this.#queue[0];
      if (!next || next.at > toMs) break;
      this.#queue.shift();
      this.#now = next.at;
      next.fn();
    }
    this.#now = toMs;
  }

  advanceBy(deltaMs: number): void {
    this.advanceTo(this.#now + deltaMs);
  }

  /** Run every scheduled callback, however far in the future. */
  runAll(): void {
    while (this.#queue.length > 0) {
      this.#queue.sort((a, b) => a.at - b.at || a.order - b.order);
      const next = this.#queue.shift();
      if (!next) break;
      this.#now = Math.max(this.#now, next.at);
      next.fn();
    }
  }
}
