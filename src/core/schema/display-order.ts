// Deterministic display order for relation axes (matching `right`, ordering `object`).
//
// Starts from label-sorted entries and seeds the permutation from those labels, so the
// order never depends on the answer key or on the producer's declaration order, and
// re-applying it is a no-op. Rendering the declared order would let a learner read the
// answer straight off the screen when the key happens to align with the axis.
import { mulberry32 } from '../rng';

export function deterministicDisplayOrder<T extends { id: string; label_md: string }>(
  entries: readonly T[],
): T[] {
  const shuffled = [...entries].sort((a, b) =>
    a.label_md < b.label_md ? -1 : a.label_md > b.label_md ? 1 : 0,
  );
  let seed = 2166136261;
  for (const char of JSON.stringify(shuffled.map((entry) => entry.label_md))) {
    seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
  }
  const random = mulberry32(seed);
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const swap = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = swap;
  }
  return shuffled;
}
