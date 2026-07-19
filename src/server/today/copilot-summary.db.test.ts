// YUK-719 (PR #917 codex) — pending-count truncation fidelity.
//
// loadCopilotSummary derives pending_proposals_total from
// countPendingProposalInboxByKind, whose byKind is only a LOWER BOUND once the
// scan cap (batchSize × maxBatches) is exceeded (hasMore). Rather than fall back
// to the full unbounded projection — whose rate/correction/signal joins land on
// the /today hot path exactly when the backlog is largest — the summary reports
// the capped sum as an explicit lower bound and console.warn's once. The cap is
// physically unreachable in this product (nightly writers cap proposal creation
// at single digits), so this branch only ever manifests in tests that shrink it.

import { event } from '@/db/schema';
import { countPendingProposalInboxByKind } from '@/server/proposals/inbox';
import { loadCopilotSummary } from '@/server/today/copilot-summary';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';

function pendingDeferRow(
  id: string,
  actorRef: string,
  createdAt: string,
): typeof event.$inferInsert {
  return {
    id,
    actor_kind: 'agent',
    actor_ref: actorRef,
    action: 'experimental:proposal',
    subject_kind: 'learning_item',
    subject_id: `item_${id}`,
    outcome: 'partial',
    payload: {
      ai_proposal: {
        kind: 'defer',
        target: { subject_kind: 'learning_item', subject_id: `item_${id}` },
        reason_md: `observe ${id}`,
        evidence_refs: [],
        proposed_change: {
          learning_item_id: `item_${id}`,
          defer_until: '2026-07-18T00:00:00.000Z',
          reason: 'low energy',
        },
      },
    },
    created_at: new Date(createdAt),
  };
}

describe('loadCopilotSummary pending_proposals_total', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('sums the by-kind counts (exact, no warn) when the counter stays under its scan cap', async () => {
    const db = testDb();
    await db
      .insert(event)
      .values([
        pendingDeferRow('p1', 'dreaming', '2026-07-17T00:01:00.000Z'),
        pendingDeferRow('p2', 'self', '2026-07-17T00:02:00.000Z'),
        pendingDeferRow('p3', 'dreaming', '2026-07-17T00:03:00.000Z'),
      ]);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const summary = await loadCopilotSummary(db);
      expect(summary.pending_proposals_total).toBe(3);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('reports the capped lower bound and warns once when the counter reports hasMore (cap exceeded)', async () => {
    const db = testDb();
    await db
      .insert(event)
      .values([
        pendingDeferRow('p1', 'dreaming', '2026-07-17T00:01:00.000Z'),
        pendingDeferRow('p2', 'self', '2026-07-17T00:02:00.000Z'),
        pendingDeferRow('p3', 'dreaming', '2026-07-17T00:03:00.000Z'),
      ]);

    // Under this shrunk cap the counter under-reports: byKind is a lower bound
    // with hasMore=true. The summary must surface this bound as-is (never the full
    // unbounded projection), so it stays cheap precisely at the worst moment.
    const rawCount = await countPendingProposalInboxByKind(db, { batchSize: 1, maxBatches: 1 });
    const rawTotal = Object.values(rawCount.byKind).reduce((sum, n) => sum + (n ?? 0), 0);
    expect(rawCount.hasMore).toBe(true);
    expect(rawTotal).toBeLessThan(3);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const summary = await loadCopilotSummary(db, {
        pendingCountOptions: { batchSize: 1, maxBatches: 1 },
      });
      // The lower bound, not the exact backlog size (3).
      expect(summary.pending_proposals_total).toBe(rawTotal);
      expect(summary.pending_proposals_total).toBeLessThan(3);
      // Warned once, with the byKind + cap context for observability.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('lower bound'),
        expect.objectContaining({ lowerBound: rawTotal, byKind: rawCount.byKind }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
