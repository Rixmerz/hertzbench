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
  readonly #origin = performance.now();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();

  now(): number {
    return performance.now() - this.#origin;
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

  /** When the earliest pending callback is due, or null when nothing is pending. */
  nextDueMs(): number | null {
    return this.#queue.reduce<number | null>(
      (min, p) => (min === null || p.at < min ? p.at : min),
      null,
    );
  }

  cancelAll(): void {
    this.#queue = [];
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

/**
 * Discrete events paced to real time, for chip-level radios whose protocols
 * live below the timer resolution: an nRF24 ACK follows its packet by 130 us,
 * and a setTimeout fires 1 to 4 ms late. Each callback runs when real time
 * reaches it, in due-time order, and sees `now()` equal to its own due time,
 * so a chain of sub-millisecond steps keeps its order against a later deadline
 * however late the timer fired. Outside a callback `now()` is real time.
 * Firmware polling the chip sees results at timer granularity; durations the
 * engine models (time on air, latency) stay exact.
 */
export class PacedClock implements Clock {
  readonly kind = "wall";
  readonly #origin = performance.now();
  readonly #events = new ManualClock();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #armedFor = Infinity;
  #draining = false;

  now(): number {
    return this.#draining ? this.#events.now() : Math.max(this.#real(), this.#events.now());
  }

  schedule(atMs: number, fn: () => void): () => void {
    const cancel = this.#events.schedule(atMs, fn);
    if (!this.#draining) this.#arm();
    return cancel;
  }

  cancelAll(): void {
    this.#events.cancelAll();
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#armedFor = Infinity;
  }

  #real(): number {
    return performance.now() - this.#origin;
  }

  #arm(): void {
    const next = this.#events.nextDueMs();
    if (next === null) {
      if (this.#timer !== null) clearTimeout(this.#timer);
      this.#timer = null;
      this.#armedFor = Infinity;
      return;
    }
    if (this.#timer !== null && this.#armedFor <= next) return;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#armedFor = next;
    this.#timer = setTimeout(() => this.#drain(), Math.max(0, next - this.#real()));
  }

  #drain(): void {
    this.#timer = null;
    this.#armedFor = Infinity;
    this.#draining = true;
    try {
      // Everything due by now, including what those callbacks schedule for before now.
      this.#events.advanceTo(Math.max(this.#real(), this.#events.now()));
    } finally {
      this.#draining = false;
      this.#arm();
    }
  }
}
