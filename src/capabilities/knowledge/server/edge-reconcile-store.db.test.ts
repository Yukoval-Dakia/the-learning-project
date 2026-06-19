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
});
