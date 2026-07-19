// YUK-719 (PR #917 round-1 codex P2) — pending-count truncation fidelity.
//
// loadCopilotSummary derives pending_proposals_total from
// countPendingProposalInboxByKind, whose byKind is only a LOWER BOUND once the
// scan cap (batchSize × maxBatches) is exceeded (hasMore). The wire contract is a
// bare number with no room for an "approximate" flag, so the summary must fall
// back to the exact projection count in that case rather than silently
// undercounting a large backlog.

import { event } from '@/db/schema';
import { countPendingProposalInboxByKind } from '@/server/proposals/inbox';
import { loadCopilotSummary } from '@/server/today/copilot-summary';
import { beforeEach, describe, expect, it } from 'vitest';
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

  it('sums the by-kind counts when the counter stays under its scan cap', async () => {
    const db = testDb();
    await db
      .insert(event)
      .values([
        pendingDeferRow('p1', 'dreaming', '2026-07-17T00:01:00.000Z'),
        pendingDeferRow('p2', 'self', '2026-07-17T00:02:00.000Z'),
        pendingDeferRow('p3', 'dreaming', '2026-07-17T00:03:00.000Z'),
      ]);

    const summary = await loadCopilotSummary(db);
    expect(summary.pending_proposals_total).toBe(3);
  });

  it('falls back to the exact projection count when the counter reports hasMore (cap exceeded)', async () => {
    const db = testDb();
    await db
      .insert(event)
      .values([
        pendingDeferRow('p1', 'dreaming', '2026-07-17T00:01:00.000Z'),
        pendingDeferRow('p2', 'self', '2026-07-17T00:02:00.000Z'),
        pendingDeferRow('p3', 'dreaming', '2026-07-17T00:03:00.000Z'),
      ]);

    // Under this shrunk cap the raw counter under-reports: byKind is a lower
    // bound with hasMore=true. This is the exact truncation the summary must not
    // expose as an exact total.
    const rawCount = await countPendingProposalInboxByKind(db, { batchSize: 1, maxBatches: 1 });
    const rawTotal = Object.values(rawCount.byKind).reduce((sum, n) => sum + (n ?? 0), 0);
    expect(rawCount.hasMore).toBe(true);
    expect(rawTotal).toBeLessThan(3);

    // The summary must still report the exact backlog total (3) via the
    // projection fallback, not the truncated lower bound.
    const summary = await loadCopilotSummary(db, {
      pendingCountOptions: { batchSize: 1, maxBatches: 1 },
    });
    expect(summary.pending_proposals_total).toBe(3);
  });
});
