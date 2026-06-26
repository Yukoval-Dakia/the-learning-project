// YUK-471 W1 — the SHARED structural deep-diff for projection parity. ONE definition used by
// both the in-tx accept-time assert (src/server/projections/parity.ts) and the offline B3
// audit (scripts/audit-projection.ts), so the two can NEVER disagree on what "fold == row"
// means. A divergence here would make the B3 audit blind to exactly the drift the runtime
// assert checks (and vice-versa) — and the B3 audit is what authorizes the PR-B SoT flip, so
// its notion of equality must be identical to the assert's. (OCR #580 de-dup: these were
// previously copy-pasted into both files with "identical" comments that had already started
// to drift in the whole-row messages.)

// JSON-serialized-Date format — EXACTLY what JSON.stringify(new Date()) / Date.prototype.toJSON
// produces (`YYYY-MM-DDTHH:mm:ss.sssZ`). A jsonb column persists a Date as this string, so reading
// the raw row back yields the STRING form while the fold (which Zod-`coerce.date()`s the same jsonb
// payload) yields a Date OBJECT. To make the two compare equal we canonicalize BOTH to epoch ms.
// The regex is the strict toISOString() shape (always millis + trailing Z), so a normal content
// string can never collide with it; even if one did, two equal such strings still compare equal.
// W1/W2 entities carry NO jsonb-nested dates, so this only affects W3's artifact.history[].at /
// figures[].last_reassigned_at — closing the fold(Date) vs raw-row(ISO-string) parity gap (W3-C3).
const JSON_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// normalize — stable structural value for deep-equality. Dates → epoch ms; ISO-date STRINGS (the
// jsonb-persisted form of a Date) → the SAME epoch ms; object keys are sorted so a downstream
// stringify is OBJECT-KEY-ORDER-INSENSITIVE (a jsonb object such as created_by whose keys come back
// from Postgres in a different order than the fold built them must NOT read as drift). ARRAYS keep
// their order — element compare stays POSITIONAL (order-SENSITIVE); the one top-level array field,
// knowledge.merged_from, is meaningfully ordered (merge history) and matches on both sides by
// construction (imperative append and fold replay both follow chronological order).
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

// stableKey — JSON.stringify(normalize(x)) with a stable sentinel for `undefined`. Plain
// JSON.stringify(undefined) returns the JS value `undefined` (NOT the string "undefined"), so
// an undefined field would stringify to the value `undefined` and could read inconsistently
// against null/absent. The bare token below is never a real JSON.stringify output (the string
// value "undefined" stringifies WITH quotes as "\"undefined\""), so it cannot collide with a
// real field value. Our snapshots use `null` (never `undefined`) for an absent value, so this
// is defensive against a future optional field rather than a live case. (OCR #580.)
function stableKey(value: unknown): string {
  const s = JSON.stringify(normalize(value));
  return s === undefined ? 'undefined' : s;
}

// diffSnapshots — field-by-field deep-diff; returns human-readable "col: live → folded" lines
// (empty array = parity). A null on EXACTLY one side is a whole-row mismatch. The wording is
// neutral so it reads correctly from both call sites (in-tx assert and offline audit).
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
