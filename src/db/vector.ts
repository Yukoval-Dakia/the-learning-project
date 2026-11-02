import { customType } from 'drizzle-orm/pg-core';

// pgvector `vector(dims)` column type. Drizzle has no native pgvector type, so we wrap
// it with customType: store number[] in JS, encode/decode pgvector's `[a,b,c]` text
// literal at the driver boundary.

export function toSqlVector(v: number[]): string {
  // pgvector rejects NaN/Infinity inside a vector literal. Guard here so a misbehaving
  // embedder surfaces a clear error instead of an opaque pgvector parse failure at the
  // driver.
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
 * pgvector `vector(dims)` column: number[] in JS. `dims` MUST match the embedder
 * dimension (EMBED_DIMS in src/server/ai/embed.ts). Fixed column name 'embedding'
 * (one embedding col per table); switch to a (name, dims) factory if a table needs more.
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
