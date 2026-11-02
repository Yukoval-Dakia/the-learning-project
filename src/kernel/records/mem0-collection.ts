// The mem0 pgvector collection table: created at runtime by mem0's PGVector provider
// (mem0ai/oss createCol()), so it is not drizzle-managed and never appears in a
// migration (so it stays out of FK_ORDER). The live Mem0 client and the backup/restore engine both resolve the table
// name here, so a backup taken with a custom collection name restores to the same table
// the client reads from.

export const MEM0_COLLECTION_DEFAULT = 'learning_project_memories';

/** Resolve the mem0 pgvector collection (= table) name from env, mirroring
 * createMem0Config()'s `optionalEnv(env, 'MEM0_PGVECTOR_COLLECTION', DEFAULT)`. A
 * bare `MEM0_PGVECTOR_COLLECTION=` (empty after trim) falls back to the default. */
export function mem0CollectionTable(env: Record<string, string | undefined> = process.env): string {
  const v = env.MEM0_PGVECTOR_COLLECTION?.trim();
  return v ? v : MEM0_COLLECTION_DEFAULT;
}

// Fixed column set fixed by mem0: `id UUID PRIMARY KEY, vector vector(<dims>), payload
// JSONB`. Restore uses it as the column allowlist because the schema-derived allowlist
// cannot cover a non-pgTable; `vector` round-trips as text with an explicit ::vector cast.
export const MEM0_COLLECTION_COLUMNS: ReadonlySet<string> = new Set<string>([
  'id',
  'vector',
  'payload',
]);
