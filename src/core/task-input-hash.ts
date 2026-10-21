import { createHash } from 'node:crypto';

// Reserved, non-confusable canonicalization marker. Any plain object that
// happens to carry this key is escaped below, so a synthetic JSON object can
// never alias the byte / escape envelopes. `v` version-tags each envelope so a
// future canonicalization change produces a structurally different (therefore
// non-colliding) hash instead of silently aliasing today's form.
const CANON_MARKER = '__ykv_canon__';

function bytesEnvelope(value: Uint8Array): Record<string, unknown> {
  return {
    [CANON_MARKER]: {
      v: 1,
      t: 'bytes',
      byteLength: value.byteLength,
      sha256: createHash('sha256').update(value).digest('hex'),
    },
  };
}

export function stableCanonicalValue(value: unknown): unknown {
  if (value instanceof URL) return value.toString();
  if (value instanceof Uint8Array) return bytesEnvelope(value);
  // Date has NO enumerable own keys, so the plain-object branch below would
  // canonicalize every Date to `{}` — all instants colliding in the digest.
  // (Date.toJSON only saves a TOP-LEVEL JSON.stringify, never our key-iteration
  // branch.) Tag it like bigint so distinct instants get distinct, non-confusable
  // digests, and a Date never aliases its own ISO string.
  if (value instanceof Date) {
    return { [CANON_MARKER]: { v: 1, t: 'date', value: value.toISOString() } };
  }
  // YUK-589 (J4) — canonicalization must be TOTAL and non-colliding, never
  // throwing for advisory metadata while silently aliasing distinct inputs.
  //  - BigInt: JSON.stringify throws on it, which would abort the whole hash.
  //    Tag it in a versioned, non-confusable envelope so it produces a stable,
  //    unique digest instead. (Number and BigInt render to different envelopes,
  //    so `1` and `1n` never collide.)
  //  - Map / Set / RegExp / other exotic non-plain objects: these fall into the
  //    `typeof === 'object'` branch below and JSON.stringify them as `{}`,
  //    silently colliding every distinct instance. Refuse them loudly so the
  //    caller's fail-closed guard (invoker metadata try/catch) skips the
  //    fingerprint rather than trusting a colliding hash.
  if (typeof value === 'bigint') {
    return { [CANON_MARKER]: { v: 1, t: 'bigint', value: value.toString() } };
  }
  // YUK-589 (K4a) — functions and symbols are non-serializable: JSON.stringify
  // drops a function-valued key entirely (or renders a bare function as
  // `undefined`) and throws on a symbol, silently aliasing distinct callables /
  // symbols. Refuse them loudly with the same fail-closed treatment as
  // Map/Set/RegExp so the caller's guard skips the fingerprint rather than
  // trusting a colliding hash.
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`non-canonicalizable value: ${typeof value}`);
  }
  if (Array.isArray(value)) return value.map(stableCanonicalValue);
  if (value && typeof value === 'object') {
    // Date is handled by the tagged branch above (it would collide here). These
    // exotics have no meaningful enumerable keys either — JSON.stringify renders
    // them as `{}` or a lossy shape, silently colliding — so refuse them loudly.
    if (
      value instanceof Map ||
      value instanceof Set ||
      value instanceof RegExp ||
      value instanceof ArrayBuffer ||
      ArrayBuffer.isView(value)
    ) {
      throw new Error(`non-canonicalizable value: ${value.constructor?.name ?? typeof value}`);
    }
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = stableCanonicalValue(source[key]);
    }
    // A plain object that itself uses the reserved marker key is wrapped in a
    // distinct escape envelope so it can never collide with a `bytes` envelope
    // (or a nested escape envelope) produced for real binary data.
    if (Object.hasOwn(source, CANON_MARKER)) {
      return { [CANON_MARKER]: { v: 1, t: 'escaped', body: out } };
    }
    return out;
  }
  return value;
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableCanonicalValue(value)) ?? 'null')
    .digest('hex');
}

export function taskInputHash(input: unknown): string {
  return sha256Canonical(input);
}
