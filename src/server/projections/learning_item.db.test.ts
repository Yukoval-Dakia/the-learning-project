// YUK-471 Wave 2 — DB tests for the learning_item projection (testcontainer). The entity with the
// MOST EXCLUDED columns of the W2 trio.
//
// Covers (design §5 + critic B1/B5):
//   - genesis backfill: seeds event-less (pre-W2) items, is idempotent, hub-before-child topo order
//     (C3), and the backfilled genesis folds byte-equal to the live row.
//   - shell parity: gatherAndFoldLearningItem reproduces the live row over genesis →
//     complete/relearn/archive; excluded columns (ai_score etc.) never enter the diff.
//   - completion/relearn and retraction require migration, then use one structural writer.
//   - audit:projection learning_item section: CLEAN on a coherent fixture, DRIFT on an out-of-band
//     write; a row differing ONLY in an excluded column folds clean.
//
// Hermetic: resetDb() TRUNCATEs ALL_TABLES (incl. learning_item + materialized_id_index).

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LearningItemRowSnapshotT } from '@/core/schema/event/genesis';
import { event, learning_item, materialized_id_index } from '@/db/schema';
import { writeLearningItemProposal } from '@/kernel/proposals/producers';
import { retractAiProposal } from '@/server/proposals/actions';

import { auditProjection } from '../../../scripts/audit-projection';
import { migrateCanonicalProjections } from '../../../scripts/migrate-canonical-projections';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { gatherAndFoldLearningItem } from './gather';

const T0 = new Date('2026-06-01T00:00:00.000Z');

async function resetIndex(): Promise<void> {
  await testDb().delete(materialized_id_index);
}

// Insert an event-less (pre-W2) learning_item directly — the legacy imperative shape.
async function insertEventlessItem(
  id: string,
  over: Partial<typeof learning_item.$inferSelect> = {},
): Promise<void> {
  await testDb()
    .insert(learning_item)
    .values({
      id,
      source: over.source ?? 'learning_intent',
      source_ref: over.source_ref ?? null,
      title: over.title ?? `Item ${id}`,
      content: over.content ?? 'content',
      knowledge_ids: over.knowledge_ids ?? ['k_a'],
      primary_artifact_id: over.primary_artifact_id ?? null,
      parent_learning_item_id: over.parent_learning_item_id ?? null,
      status: over.status ?? 'pending',
      user_pinned: over.user_pinned ?? false,
      completed_at: over.completed_at ?? null,
      dismissed_at: over.dismissed_at ?? null,
      archived_at: over.archived_at ?? null,
      archived_reason: over.archived_reason ?? null,
      created_at: over.created_at ?? T0,
      updated_at: over.updated_at ?? T0,
      version: over.version ?? 0,
      ...(over.ai_score !== undefined ? { ai_score: over.ai_score } : {}),
    });
}

async function liveItem(id: string): Promise<LearningItemRowSnapshotT | null> {
  const rows = await testDb().select().from(learning_item).where(eq(learning_item.id, id)).limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    source: r.source,
    source_ref: r.source_ref,
    title: r.title,
    content: r.content,
    knowledge_ids: r.knowledge_ids ?? [],
    primary_artifact_id: r.primary_artifact_id,
    parent_learning_item_id: r.parent_learning_item_id,
    status: r.status,
    user_pinned: r.user_pinned,
    completed_at: r.completed_at,
    dismissed_at: r.dismissed_at,
    archived_at: r.archived_at,
    archived_reason: r.archived_reason,
    created_at: r.created_at,
    updated_at: r.updated_at,
    version: r.version,
  };
}

describe('retractAiProposal (learning_item) — HIGH-1 single-clock + fold==row', () => {
  beforeEach(async () => {
    await resetDb();
    await resetIndex();
  });

  it('retraction rejects missing migration atomically; prepared legacy item archives with fold parity', async () => {
    const db = testDb();
    // A real learning_item proposal in the inbox (so retractAiProposal's requireProposal resolves)
    // — but NOTHING materialized through the genesis-writing INSERT path.
    const proposalId = await writeLearningItemProposal(db as never, {
      topic: 'Eventless topic',
      knowledge_node: { id: 'k_x', name: 'X', domain: 'yuwen' },
      hub: { title: 'Hub', summary_md: 'overview' },
      atomics: [],
      reason_md: 'because',
      evidence_refs: [],
      created_at: T0,
    });
    // Model a legacy item; runtime mutation must not fabricate another migration path.
    await insertEventlessItem('li_eventless', {
      source_ref: proposalId,
      status: 'pending',
      updated_at: new Date(T0.getTime() + 5000),
    });
    // sanity: the item has no genesis anchor before the retract.
    const preGenesis = await db
      .select({ id: event.id })
      .from(event)
      .where(eq(event.subject_id, 'li_eventless'));
    expect(preGenesis).toHaveLength(0);

    const eventsBefore = await db.select().from(event);
    await expect(
      retractAiProposal(db, proposalId, { reason_md: 'eventless retract' }),
    ).rejects.toThrow('canonical projection migration');
    expect(await db.select().from(event)).toEqual(eventsBefore);
    expect((await liveItem('li_eventless'))?.archived_at).toBeNull();
    await migrateCanonicalProjections(db);
    await retractAiProposal(db, proposalId, { reason_md: 'eventless retract' });

    // Migration supplied the base before the canonical archive event.
    const genesisRows = await db
      .select({ action: event.action })
      .from(event)
      .where(eq(event.subject_id, 'li_eventless'));
    const actions = genesisRows.map((r) => r.action);
    expect(actions).toContain('experimental:genesis');
    expect(actions).toContain('experimental:learning_item_archive');

    const live = await liveItem('li_eventless');
    const folded = await gatherAndFoldLearningItem(db, 'li_eventless');
    expect(live?.archived_at).not.toBeNull();
    expect(live?.archived_reason).toBe('proposal_retracted');
    // The archive follows the migrated base and uses the correction clock.
    expect(folded).toEqual(live);
    expect(folded?.archived_at?.getTime()).toBe(live?.archived_at?.getTime());

    const audit = await auditProjection(db, {});
    expect(audit.drift.filter((d) => d.id === 'li_eventless')).toEqual([]);
  });
});
