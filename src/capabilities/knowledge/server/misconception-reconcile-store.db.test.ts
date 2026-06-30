// YUK-531 (A5 S4 / ADR-0036 RT1) — misconception_reconciliation_log audit data layer tests.

import { misconception_reconciliation_log } from '@/db/schema';
import { eq, isNull } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  insertMisconceptionPlannedRows,
  makeMisconceptionPlannedRow,
  markMisconceptionReconcileApplied,
} from './misconception-reconcile-store';

// Walk the postgres-js error cause chain to the real check_violation (23514) + constraint.
function pgErrorOf(err: unknown): { code?: string; constraint_name?: string } {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i += 1) {
    const c = cur as { code?: string; constraint_name?: string; cause?: unknown };
    if (typeof c.code === 'string') return c;
    cur = c.cause;
  }
  return {};
}

function row(
  overrides: Partial<Parameters<typeof makeMisconceptionPlannedRow>[0]> = {},
): ReturnType<typeof makeMisconceptionPlannedRow> {
  return makeMisconceptionPlannedRow({
    candidate_from_kind: 'misconception',
    candidate_from_id: 'misc_a',
    candidate_to_kind: 'misconception',
    candidate_to_id: 'misc_b',
    candidate_relation_type: 'confusable_with',
    action: 'SUPERSEDE',
    superseded_edge_id: 'mce_old',
    confidence: 0.9,
    reason: 'r',
    llm_raw: { action: 'SUPERSEDE' },
    ...overrides,
  });
}

describe('misconception-reconcile-store', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('markMisconceptionReconcileApplied stamps applied_at on an existing planned row', async () => {
    const db = testDb();
    const r = row();
    await insertMisconceptionPlannedRows(db, [r]);

    const before = await db
      .select()
      .from(misconception_reconciliation_log)
      .where(eq(misconception_reconciliation_log.id, r.id))
      .limit(1);
    expect(before[0].applied_at).toBeNull();

    await markMisconceptionReconcileApplied(db, r.id);

    const after = await db
      .select()
      .from(misconception_reconciliation_log)
      .where(eq(misconception_reconciliation_log.id, r.id))
      .limit(1);
    expect(after[0].applied_at).not.toBeNull();
    const unapplied = await db
      .select()
      .from(misconception_reconciliation_log)
      .where(isNull(misconception_reconciliation_log.applied_at));
    expect(unapplied).toHaveLength(0);
  });

  it('markMisconceptionReconcileApplied throws on a non-existent logId (0 rows updated)', async () => {
    const db = testDb();
    await expect(markMisconceptionReconcileApplied(db, 'does-not-exist')).rejects.toThrow(
      /expected to stamp exactly 1 misconception_reconciliation_log row/,
    );
  });

  it('CHECK rejects SUPERSEDE + null superseded_edge_id (23514)', async () => {
    const db = testDb();
    const bad = row({ action: 'SUPERSEDE', superseded_edge_id: null });
    const err = await insertMisconceptionPlannedRows(db, [bad]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    const pg = pgErrorOf(err);
    expect(pg.code).toBe('23514');
    expect(pg.constraint_name).toBe('misconception_recon_action_superseded_ck');
  });

  it('CHECK rejects KEEP_BOTH + non-null superseded_edge_id (23514)', async () => {
    const db = testDb();
    const bad = row({ action: 'KEEP_BOTH', superseded_edge_id: 'mce_old' });
    const err = await insertMisconceptionPlannedRows(db, [bad]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    const pg = pgErrorOf(err);
    expect(pg.code).toBe('23514');
    expect(pg.constraint_name).toBe('misconception_recon_action_superseded_ck');
  });

  it('CHECK accepts both legitimate row shapes (SUPERSEDE+id, KEEP_BOTH+null)', async () => {
    const db = testDb();
    const supersede = row({ action: 'SUPERSEDE', superseded_edge_id: 'mce_old' });
    const keepBoth = row({
      candidate_from_id: 'misc_c',
      candidate_to_id: 'misc_d',
      action: 'KEEP_BOTH',
      superseded_edge_id: null,
      llm_raw: { action: 'KEEP_BOTH' },
    });
    await expect(
      insertMisconceptionPlannedRows(db, [supersede, keepBoth]),
    ).resolves.toBeUndefined();
    expect(await db.select().from(misconception_reconciliation_log)).toHaveLength(2);
  });
});
