import { createHash } from 'node:crypto';

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
  return `{${entries.join(',')}}`;
}

/** Stable SHA-256 for JSON-compatible business contracts, independent of key insertion order. */
export function sha256CanonicalJson(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}
