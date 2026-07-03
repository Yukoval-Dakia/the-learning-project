import { eq, isNull, sql } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { memory_reconciliation_log } from '@/db/schema';
import type { MemoryClient } from './client';

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
  // YUK-557 (Q2b) — write-ahead undo snapshot. Optionality is ONLY for KEEP_BOTH
  // (no undo target) and type convenience for replay fixtures; every DESTRUCTIVE
  // row (action !== 'KEEP_BOTH') MUST carry prev_text — it is the recovery floor,
  // and for MERGE it is the ONLY source of the old row's text (enforced fail-closed
  // in insertPlannedRows before any write). Captured in the handler's write-ahead
  // phase (triggers.ts), never at apply-time (replay would read the already-
  // rewritten payload). SUPERSEDE/MERGE: old row's original text/full payload;
  // RETRACT_NEW: prev_text = new row's text, prev_metadata = null.
  prev_text?: string | null;
  prev_metadata?: Record<string, unknown> | null;
};

/**
 * Batch INSERT planned rows into memory_reconciliation_log (write-ahead).
 * applied_at left NULL — set by markApplied after the apply step succeeds.
 */
export async function insertPlannedRows(db: Db, rows: PlannedRow[]): Promise<void> {
  if (rows.length === 0) return;
  // YUK-557 (Q2b) invariant: every destructive WAL row must carry its undo
  // snapshot (spec Q2b: the write-ahead side covers all non-KEEP_BOTH actions;
  // prev_text is the recovery floor — for MERGE it is the ONLY source of the old
  // row's text). Fail-closed BEFORE insert/apply: nothing has been destroyed yet,
  // so a missing snapshot is a program bug (a synthesis path that forgot to
  // capture), never a swallowed data-loss.
  for (const r of rows) {
    if (r.action !== 'KEEP_BOTH' && r.prev_text == null) {
      throw new Error(
        `[memory_reconcile] destructive planned row without prev_text snapshot: action=${r.action} id=${r.id} user=${r.user_id}`,
      );
    }
  }
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
      // YUK-557 (Q2b) — explicit column map (NOT ...spread): the undo snapshot
      // columns MUST be listed here or they silently drop AND audit:schema fails
      // (no write path for the new columns). Undefined → NULL (pre-Q2b callers).
      prev_text: r.prev_text ?? null,
      prev_metadata: r.prev_metadata ?? null,
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
 * Rewrite a surviving memory's text in place (MERGE action). The MERGE outcome
 * keeps the OLD row alive as the canonical merged memory and drops the NEW row
 * (hardDeleteMemory) — so the survivor must stay LIVE: this writes ONLY
 * payload->>'data' (mem0 stores memory text under the 'data' key, NOT 'memory')
 * + bumps created_ms for recency. It deliberately does NOT write superseded_by /
 * invalid_at, because the P3 read path filters out rows carrying those markers
 * — marking the survivor superseded would make the merged memory vanish from
 * reads (the YUK-342 PR #405 MERGE bug this replaces).
 *
 * Known limitation (Codex PR #405 :114): this is a jsonb-only text rewrite — it
 * does NOT re-embed. The survivor's `vector` and any `text_lemmatized`-style
 * columns still reflect the OLD text, so a semantic / lexical search keyed on
 * mergedText's new wording may not rank-match the survivor. Re-embedding on
 * MERGE is deferred to P3 / a future re-embed pass.
 */
export async function rewriteMemoryText(
  db: Db,
  collectionName: string,
  opts: {
    memoryId: string;
    mergedText: string;
    createdMs: number;
  },
): Promise<void> {
  assertSafeCollectionName(collectionName);
  await db.execute(
    sql`UPDATE ${sql.raw(`"${collectionName}"`)}
        SET payload = payload || jsonb_build_object(
          'data',       ${opts.mergedText}::text,
          'created_ms', ${String(opts.createdMs)}::text
        )
        WHERE id = ${opts.memoryId}::uuid`,
  );
}

/**
 * Physically delete a mem0 vector row (MERGE drops the new row after rewriting
 * old; RETRACT_NEW drops a duplicate new row).
 *
 * YUK-557 (Q2a): now delegates to mem0's OFFICIAL delete() via client.hardDelete,
 * which writes payload.data into the SQLite memory_history tombstone (is_deleted=1)
 * BEFORE the real vector DELETE — turning the previously no-tombstone raw DELETE
 * into a recoverable delete (副保底; the primary undo source is the WAL prev_text,
 * which is in the backup boundary). Idempotent 'not found' handling lives inside
 * client.hardDelete. The design §3.2 red line never封禁 official delete() (only
 * softSupersede/rewriteMemoryText keep raw SQL, for the update() payload-clobber bug).
 */
export async function hardDeleteMemory(
  client: Pick<MemoryClient, 'hardDelete'>,
  memoryId: string,
): Promise<void> {
  await client.hardDelete(memoryId);
}

/**
 * YUK-557 (Q2b) — read-only snapshot of a mem0 vector row's current payload,
 * captured in the reconcile handler's WRITE-AHEAD phase (before any apply mutates
 * it) so the undo log holds the pre-change state. Returns { text, metadata }
 * where text = payload.data (the memory text) and metadata = the full payload.
 * Missing row (defensive: LLM-referenced id already gone) → null, so the caller
 * leaves prev_metadata NULL and relies on prev_text as the floor. NEVER call this
 * at apply-time: a crash-replay would read the already-rewritten payload and
 * poison the snapshot (spec Q2b / M1, Lens B M1).
 */
export async function capturePrevState(
  db: Db,
  collectionName: string,
  memoryId: string,
): Promise<{ text: string | null; metadata: Record<string, unknown> } | null> {
  assertSafeCollectionName(collectionName);
  const rows = (await db.execute(
    sql`SELECT payload FROM ${sql.raw(`"${collectionName}"`)} WHERE id = ${memoryId}::uuid`,
  )) as unknown as Array<{ payload: Record<string, unknown> }>;
  const payload = rows[0]?.payload;
  if (!payload) return null;
  const text = typeof payload.data === 'string' ? payload.data : null;
  return { text, metadata: payload };
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
  // Explicit 8-column projection (NOT bare .select()): this is the apply/replay
  // cursor and DELIBERATELY does not carry the undo-snapshot columns
  // (prev_text/prev_metadata) — apply never consumes them (recovery is an offline
  // runbook query against the table), and pulling them here would waste bytes on
  // every replay. YUK-557 (F7).
  const rows = await db
    .select({
      id: memory_reconciliation_log.id,
      user_id: memory_reconciliation_log.user_id,
      new_memory_id: memory_reconciliation_log.new_memory_id,
      old_memory_id: memory_reconciliation_log.old_memory_id,
      action: memory_reconciliation_log.action,
      reason: memory_reconciliation_log.reason,
      llm_raw: memory_reconciliation_log.llm_raw,
      planned_at: memory_reconciliation_log.planned_at,
    })
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
