// ADR-0034 §3 / YUK-344 — edge_reconciliation_log audit data layer tests.

import { edge_reconciliation_log } from '@/db/schema';
import { eq, isNull } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  insertEdgePlannedRows,
  makeEdgePlannedRow,
  markEdgeReconcileApplied,
} from './edge-reconcile-store';

// The `postgres` driver wraps a failed query in an Error whose top-level message is
// a generic "Failed query: ..." string; the actual PG diagnostic (SQLSTATE + the
// violated constraint name) lives on the chained `cause` (a PostgresError). Walk the
// cause chain to assert on the real check_violation (23514) + constraint name.
function pgErrorOf(err: unknown): { code?: string; constraint_name?: string } {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i += 1) {
    const c = cur as { code?: string; constraint_name?: string; cause?: unknown };
    if (typeof c.code === 'string') return c;
    cur = c.cause;
  }
  return {};
}

describe('edge-reconcile-store', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('markEdgeReconcileApplied stamps applied_at on an existing planned row', async () => {
    const db = testDb();
    const row = makeEdgePlannedRow({
      candidate_from_knowledge_id: 'kA',
      candidate_to_knowledge_id: 'kB',
      candidate_relation_type: 'contrasts_with',
      action: 'SUPERSEDE',
      superseded_edge_id: 'e_old',
      confidence: 0.9,
      reason: 'r',
      llm_raw: { action: 'SUPERSEDE' },
    });
    await insertEdgePlannedRows(db, [row]);

    // Planned (not yet applied).
    const before = await db
      .select()
      .from(edge_reconciliation_log)
      .where(eq(edge_reconciliation_log.id, row.id))
      .limit(1);
    expect(before[0].applied_at).toBeNull();

    await markEdgeReconcileApplied(db, row.id);

    const after = await db
      .select()
      .from(edge_reconciliation_log)
      .where(eq(edge_reconciliation_log.id, row.id))
      .limit(1);
    expect(after[0].applied_at).not.toBeNull();
    const unapplied = await db
      .select()
      .from(edge_reconciliation_log)
      .where(isNull(edge_reconciliation_log.applied_at));
    expect(unapplied).toHaveLength(0);
  });

  // CodeRabbit Finding 2 — a bad/missing logId must FAIL LOUD (throw) so the
  // enclosing single applyEdgeSupersede transaction rolls back, rather than
  // silently no-op'ing and committing a planned-but-never-applied log row.
  it('markEdgeReconcileApplied throws on a non-existent logId (0 rows updated)', async () => {
    const db = testDb();
    await expect(markEdgeReconcileApplied(db, 'does-not-exist')).rejects.toThrow(
      /expected to stamp exactly 1 edge_reconciliation_log row/,
    );
  });

  // CodeRabbit Major finding — the action ↔ superseded_edge_id consistency invariant
  // must be enforced at the DB layer (CHECK edge_recon_action_superseded_ck), not only
  // in the application builder. A SUPERSEDE row with a NULL superseded_edge_id is a
  // contradiction the DB must reject (PG check_violation, SQLSTATE 23514).
  it('CHECK edge_recon_action_superseded_ck rejects SUPERSEDE + null superseded_edge_id', async () => {
    const db = testDb();
    // Build a structurally contradictory row directly (the application builder in
    // edge-reconcile.ts can never produce this, which is exactly why the DB guard
    // is load-bearing). makeEdgePlannedRow faithfully passes the fields through.
    const bad = makeEdgePlannedRow({
      candidate_from_knowledge_id: 'kA',
      candidate_to_knowledge_id: 'kB',
      candidate_relation_type: 'contrasts_with',
      action: 'SUPERSEDE',
      superseded_edge_id: null,
      confidence: 0.9,
      reason: 'contradictory',
      llm_raw: null,
    });
    const err = await insertEdgePlannedRows(db, [bad]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    const pg = pgErrorOf(err);
    expect(pg.code).toBe('23514'); // PG check_violation
    expect(pg.constraint_name).toBe('edge_recon_action_superseded_ck');
  });

  // The mirror contradiction: a KEEP_BOTH row that names a superseded edge must also
  // be rejected — KEEP_BOTH archives nothing, so superseded_edge_id MUST be null.
  it('CHECK edge_recon_action_superseded_ck rejects KEEP_BOTH + non-null superseded_edge_id', async () => {
    const db = testDb();
    const bad = makeEdgePlannedRow({
      candidate_from_knowledge_id: 'kA',
      candidate_to_knowledge_id: 'kB',
      candidate_relation_type: 'contrasts_with',
      action: 'KEEP_BOTH',
      superseded_edge_id: 'e_old',
      confidence: 0.9,
      reason: 'contradictory',
      llm_raw: null,
    });
    const err = await insertEdgePlannedRows(db, [bad]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    const pg = pgErrorOf(err);
    expect(pg.code).toBe('23514'); // PG check_violation
    expect(pg.constraint_name).toBe('edge_recon_action_superseded_ck');
  });

  // Both legitimate shapes (per the real write paths) must INSERT cleanly — the CHECK
  // never rejects a legitimate write: SUPERSEDE always carries a non-null
  // superseded_edge_id (applyEdgeSupersede), KEEP_BOTH always null.
  it('CHECK accepts both legitimate row shapes (SUPERSEDE+id, KEEP_BOTH+null)', async () => {
    const db = testDb();
    const supersede = makeEdgePlannedRow({
      candidate_from_knowledge_id: 'kA',
      candidate_to_knowledge_id: 'kB',
      candidate_relation_type: 'contrasts_with',
      action: 'SUPERSEDE',
      superseded_edge_id: 'e_old',
      confidence: 0.9,
      reason: 'ok',
      llm_raw: { action: 'SUPERSEDE' },
    });
    const keepBoth = makeEdgePlannedRow({
      candidate_from_knowledge_id: 'kC',
      candidate_to_knowledge_id: 'kD',
      candidate_relation_type: 'related_to',
      action: 'KEEP_BOTH',
      superseded_edge_id: null,
      confidence: 0.9,
      reason: 'ok',
      llm_raw: { action: 'KEEP_BOTH' },
    });
    await expect(insertEdgePlannedRows(db, [supersede, keepBoth])).resolves.toBeUndefined();
    const rows = await db.select().from(edge_reconciliation_log);
    expect(rows).toHaveLength(2);
  });
});
