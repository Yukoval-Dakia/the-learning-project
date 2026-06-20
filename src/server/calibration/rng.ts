// Seeded deterministic RNG (mulberry32) — a small, fast, well-distributed 32-bit PRNG.
// Injected into the cluster bootstrap so its CI is reproducible (same seed → identical
// resampling → identical CI bounds), which lets the bootstrap unit tests assert exact
// numbers instead of relying on the non-deterministic global Math.random.
//
// PURE (given a seed): returns a closure with internal state; calling it advances the
// state and returns the next value in [0, 1).

/**
 * mulberry32 PRNG. Standard reference implementation.
 * @param seed any 32-bit integer seed.
 * @returns a function () → number in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
