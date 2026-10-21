// Shared structural deep-diff for projection parity, used by both the in-tx assert and
// the offline audit so the two cannot disagree about what "fold == row" means.

// jsonb persists a Date as its ISO string, while the fold coerces the same payload back
// to a Date. Canonicalize both to epoch ms so they compare equal; the strict
// toISOString shape cannot collide with ordinary content.
const JSON_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Stable structural value for deep equality. Dates and ISO-date strings become epoch ms;
// object keys are sorted so jsonb key order never reads as drift. Arrays stay positional:
// merged_from is ordered merge history.
export function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && JSON_DATE_RE.test(value)) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? value : t;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = normalize(obj[k]);
    return out;
  }
  return value;
}

// JSON.stringify with a sentinel for undefined, which stringify would otherwise return as
// the non-string value `undefined`. Snapshots use null for absence; this is defensive.
function stableKey(value: unknown): string {
  const s = JSON.stringify(normalize(value));
  return s === undefined ? 'undefined' : s;
}

// Field-by-field diff with neutral wording so both call sites read correctly. An empty
// array means parity; a null on exactly one side is a whole-row mismatch.
export function diffSnapshots(
  live: Record<string, unknown> | null,
  folded: Record<string, unknown> | null,
): string[] {
  if (live === null && folded === null) return [];
  if (live === null) return ['<row>: absent → fold-produced (no live row but events fold to one)'];
  if (folded === null)
    return ['<row>: present → fold-null (live row not reproducible from events)'];
  const diffs: string[] = [];
  const keys = new Set([...Object.keys(live), ...Object.keys(folded)]);
  for (const k of keys) {
    const a = stableKey(live[k]);
    const b = stableKey(folded[k]);
    if (a !== b) diffs.push(`${k}: ${a} → ${b}`);
  }
  return diffs;
}
