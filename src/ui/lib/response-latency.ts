// Solo and placement use the submit contract range [0, 3_600_000].
// Paper timing keeps its separate cumulative safe-integer contract.
export function computeLatencyMs(shownAtMs: number | null, nowMs: number): number | null {
  if (shownAtMs === null) return null;
  return Math.max(0, Math.min(3_600_000, Math.trunc(nowMs - shownAtMs)));
}
