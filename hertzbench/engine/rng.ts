// Seeded, dependency-free PRNG. Every random decision in the engine comes from
// here so a scenario seed reproduces a run (PLAN.md D7).

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Standard normal (mean 0, stddev 1), Box-Muller. */
  gaussian(): number;
}

function stringHash(text: string): () => number {
  // xmur3: turns an arbitrary string into a stream of well-mixed 32-bit words.
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

export function createRng(seed: number | string): Rng {
  const words = stringHash(String(seed));
  let a = words();
  let b = words();
  let c = words();
  let d = words();
  let spare: number | null = null;

  // sfc32: small, fast, passes PractRand; state is four 32-bit words.
  const next = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  // Warm up: the first outputs of sfc32 are correlated with a weak seed.
  for (let i = 0; i < 12; i++) next();

  return {
    next,
    int(maxExclusive) {
      if (!Number.isInteger(maxExclusive) || maxExclusive < 1) {
        throw new RangeError(`int() needs a positive integer bound, got ${maxExclusive}`);
      }
      return Math.floor(next() * maxExclusive);
    },
    gaussian() {
      if (spare !== null) {
        const value = spare;
        spare = null;
        return value;
      }
      const u1 = Math.max(next(), Number.EPSILON);
      const u2 = next();
      const radius = Math.sqrt(-2 * Math.log(u1));
      spare = radius * Math.sin(2 * Math.PI * u2);
      return radius * Math.cos(2 * Math.PI * u2);
    },
  };
}

/**
 * An independent stream named by `label`. Streams are keyed, not drawn from a
 * shared generator, so a decision depends on its own label and never on how
 * other events interleaved - wall-clock runs interleave differently every time.
 */
export function substream(seed: number, label: string): Rng {
  return createRng(`${seed}:${label}`);
}
