import { createHash } from 'node:crypto';

// Reserved, non-confusable canonicalization marker. A plain object carrying this key
// is escaped below. `v` versions each envelope so a future change cannot silently alias
// today's hash.
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
  // Date has no enumerable keys, so the plain-object branch would canonicalize every
  // instant to {} and collide. Tag it like bigint so distinct instants stay distinct.
  if (value instanceof Date) {
    return { [CANON_MARKER]: { v: 1, t: 'date', value: value.toISOString() } };
  }
  // YUK-589 — canonicalization must be total and non-colliding. BigInt throws in
  // JSON.stringify; tag it in a versioned envelope. Other exotic objects would render
  // as {} and collide, so fail closed and let the caller skip the fingerprint.
  if (typeof value === 'bigint') {
    return { [CANON_MARKER]: { v: 1, t: 'bigint', value: value.toString() } };
  }
  // Functions and symbols are non-serializable (dropped or throwing); fail closed.
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`non-canonicalizable value: ${typeof value}`);
  }
  if (Array.isArray(value)) return value.map(stableCanonicalValue);
  if (value && typeof value === 'object') {
    // These have no meaningful enumerable keys; refuse rather than collide.
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
    // Escape a reserved marker key so it cannot collide with a bytes/date envelope.
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
