import { customType } from 'drizzle-orm/pg-core';

// YUK-383 Phase 0 — pgvector `vector(dims)` column type. Drizzle has no native
// pgvector type, so we wrap it with customType: store as number[] in JS, encode
// to / decode from pgvector's text literal `[a,b,c]` at the driver boundary.

export function toSqlVector(v: number[]): string {
  // pgvector rejects NaN/Infinity inside a vector literal. Guard here so a future
  // misbehaving embedder surfaces a clear error instead of an opaque driver-side
  // pgvector parse failure (and keeps the backfill's idempotent retry meaningful).
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(v[i])) {
      throw new Error(`toSqlVector: non-finite element at index ${i} (${v[i]})`);
    }
  }
  return `[${v.join(',')}]`;
}

export function fromSqlVector(s: string): number[] {
  return s
    .replace(/^\[|\]$/g, '')
    .split(',')
    .filter(Boolean)
    .map(Number);
}

/**
 * pgvector `vector(dims)` column. Stores number[] in JS; DB type is pgvector.
 * `dims` MUST match the embedder dimension (1024 — see EMBED_DIMS in
 * src/server/ai/embed.ts). Fixed column name 'embedding' (one embedding col per
 * table in Phase 0); switch to a (name, dims) factory if a table needs more.
 */
export const vector = (dims: number) =>
  customType<{ data: number[]; driverData: string; config: { dims: number } }>({
    dataType() {
      return `vector(${dims})`;
    },
    toDriver(value: number[]): string {
      return toSqlVector(value);
    },
    fromDriver(value: string): number[] {
      return fromSqlVector(value);
    },
  })('embedding', { dims });
