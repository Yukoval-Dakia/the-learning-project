import { eq, isNull, sql } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { memory_reconciliation_log } from '@/db/schema';

// P2 (YUK-342): softSupersede + write-ahead log data layer for mem0 reconcile.
// Self-built — does NOT depend on mem0 history. The mem0 pgvector collection
// table (dynamic name from config) is operated on via raw SQL (sql.raw for table
// name); memory_reconciliation_log is a drizzle-managed table.

export type ReconcileAction = 'KEEP_BOTH' | 'SUPERSEDE' | 'MERGE' | 'RETRACT_NEW';

// The collection name is interpolated raw into the table identifier (sql.raw).
// Today it is always config-derived (env/default) or a test constant — both
// trusted — but guard the raw interpolation so a future caller can't turn it
// into a SQL-injection vector. Double-quoting alone does not neutralize a name
// containing a `"`.
function assertSafeCollectionName(name: string): void {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`Unsafe mem0 collection name for raw SQL: ${JSON.stringify(name)}`);
  }
}

/** A planned write-ahead row: one per LLM decision. */
export type PlannedRow = {
  id: string;
  user_id: string;
  new_memory_id: string | null;
  old_memory_id: string | null;
  action: ReconcileAction;
  reason: string;
  llm_raw: unknown;
  planned_at: Date;
};

/**
 * Batch INSERT planned rows into memory_reconciliation_log (write-ahead).
 * applied_at left NULL — set by markApplied after the apply step succeeds.
 */
export async function insertPlannedRows(db: Db, rows: PlannedRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(memory_reconciliation_log).values(
    rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      new_memory_id: r.new_memory_id,
      old_memory_id: r.old_memory_id,
      action: r.action,
      reason: r.reason,
      llm_raw: r.llm_raw as Record<string, unknown> | null,
      planned_at: r.planned_at,
    })),
  );
}

/**
 * Soft-supersede a mem0 vector row by merging superseded_by / invalid_at /
 * created_ms into its jsonb payload. Uses `payload || jsonb_build_object(...)`
 * (jsonb merge — never whole-object SET) so existing keys (data, createdAt,
 * hash, etc.) are preserved. Parameters are explicitly `::text` cast.
 *
 * sentinel discipline: superseded_by is NEVER JSON null (P3 filter
 * {$not:[{superseded_by:'*'}]} → NOT(payload ? 'superseded_by') must see the
 * key as present-and-non-null).
 */
export async function softSupersede(
  db: Db,
  collectionName: string,
  opts: {
    oldMemoryId: string; // mem0 vector row id (uuid PK)
    supersededByNewId: string; // the new memory that replaces it
    invalidAtMs: number; // epoch-ms when invalidated
    createdMs: number; // epoch-ms of the new memory (for recency alignment)
  },
): Promise<void> {
  assertSafeCollectionName(collectionName);
  const invalidAtIso = new Date(opts.invalidAtMs).toISOString();
  await db.execute(
    sql`UPDATE ${sql.raw(`"${collectionName}"`)}
        SET payload = payload || jsonb_build_object(
          'superseded_by', ${opts.supersededByNewId}::text,
          'invalid_at',    ${invalidAtIso}::text,
          'created_ms',    ${String(opts.createdMs)}::text
        )
        WHERE id = ${opts.oldMemoryId}::uuid`,
  );
}

/**
 * Soft-supersede + rewrite the existing memory text (MERGE action). In addition
 * to the supersede markers, replaces payload->>'data' (mem0 stores memory text
 * under the 'data' key, NOT 'memory').
 */
export async function softSupersedeWithText(
  db: Db,
  collectionName: string,
  opts: {
    oldMemoryId: string;
    supersededByNewId: string;
    mergedText: string;
    invalidAtMs: number;
    createdMs: number;
  },
): Promise<void> {
  assertSafeCollectionName(collectionName);
  const invalidAtIso = new Date(opts.invalidAtMs).toISOString();
  await db.execute(
    sql`UPDATE ${sql.raw(`"${collectionName}"`)}
        SET payload = payload || jsonb_build_object(
          'superseded_by', ${opts.supersededByNewId}::text,
          'invalid_at',    ${invalidAtIso}::text,
          'created_ms',    ${String(opts.createdMs)}::text,
          'data',          ${opts.mergedText}::text
        )
        WHERE id = ${opts.oldMemoryId}::uuid`,
  );
}

/**
 * Physically delete a mem0 vector row (MERGE drops the new row after rewriting
 * old; RETRACT_NEW drops a duplicate new row). Idempotent: 'not found' is
 * swallowed so a half-applied batch can safely re-run.
 */
export async function hardDeleteMemory(
  db: Db,
  collectionName: string,
  memoryId: string,
): Promise<void> {
  assertSafeCollectionName(collectionName);
  try {
    await db.execute(
      sql`DELETE FROM ${sql.raw(`"${collectionName}"`)} WHERE id = ${memoryId}::uuid`,
    );
  } catch (err) {
    // Idempotent: if the row was already deleted in a prior partial run, swallow.
    // postgres-js error code 42P01 (undefined table) or a 'not found' are non-fatal.
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found|does not exist|42P01/i.test(msg)) return;
    throw err;
  }
}

/** UPDATE applied_at = now() — marks a write-ahead row as fully applied. */
export async function markApplied(db: Db, logId: string): Promise<void> {
  await db
    .update(memory_reconciliation_log)
    .set({ applied_at: new Date() })
    .where(eq(memory_reconciliation_log.id, logId));
}

/**
 * Idempotent replay cursor: load all planned rows that have NOT been applied
 * yet (applied_at IS NULL) for this user. Called at the START of every reconcile
 * job so a crash mid-apply is resumed, not lost.
 *
 * Concurrency: NOT row-locked. Serialization relies on (1) enqueue singletonKey
 * `memory.reconcile.<user>`, (2) a single prod worker with batchSize:1. If two
 * jobs still overlap (the dev double-worker topology, tracked in YUK-345), the
 * apply step is idempotent by design — softSupersede is an idempotent jsonb
 * merge, hardDelete swallows 'not found', markApplied is a no-op once set — so a
 * double-apply wastes work but never corrupts. Add FOR UPDATE SKIP LOCKED here
 * (within a load+apply transaction) only if a real multi-writer prod topology
 * appears.
 */
export async function loadUnappliedLog(db: Db, userId: string): Promise<PlannedRow[]> {
  const rows = await db
    .select()
    .from(memory_reconciliation_log)
    .where(
      sql`${memory_reconciliation_log.user_id} = ${userId}
          AND ${isNull(memory_reconciliation_log.applied_at)}`,
    )
    .orderBy(memory_reconciliation_log.planned_at);
  return rows.map((r) => ({
    id: r.id,
    user_id: r.user_id,
    new_memory_id: r.new_memory_id,
    old_memory_id: r.old_memory_id,
    action: r.action as ReconcileAction,
    reason: r.reason,
    llm_raw: r.llm_raw,
    planned_at: r.planned_at,
  }));
}

/** Build a planned row with a fresh cuid2 id (convenience for the handler). */
export function makePlannedRow(opts: Omit<PlannedRow, 'id' | 'planned_at'>): PlannedRow {
  return {
    ...opts,
    id: newId(),
    planned_at: new Date(),
  };
}
