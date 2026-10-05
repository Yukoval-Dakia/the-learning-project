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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LearningItemAcceptResult } from '@/capabilities/agency/public';
import { planLearningIntent } from '@/capabilities/agency/public';
import {
  acceptCompletionProposal,
  acceptRelearnProposal,
} from '@/capabilities/agency/server/proposal-appliers';
import { newId } from '@/core/ids';
import type { LearningItemRowSnapshotT } from '@/core/schema/event/genesis';
import { event, knowledge, learning_item, materialized_id_index } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import type { ProposalInboxRow } from '@/kernel/proposals/inbox';
import { writeLearningItemProposal } from '@/kernel/proposals/producers';
import { acceptAiProposal, retractAiProposal } from '@/server/proposals/actions';

import { auditProjection } from '../../../scripts/audit-projection';
import { backfillLearningItemGenesis } from '../../../scripts/backfill-genesis-events';
import { migrateCanonicalProjections } from '../../../scripts/migrate-canonical-projections';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { assertProposalLifecycleResult } from '../../../tests/helpers/proposal-lifecycle';
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

// A completion ProposalInboxRow stub — no cooldown_key so recordProposalDecisionSignal is a no-op
// (keeps the test focused on the learning_item seam, not the signal pipeline).
function completionInboxRow(learningItemId: string): ProposalInboxRow {
  return {
    kind: 'completion',
    payload: {
      proposed_change: { learning_item_id: learningItemId },
    },
  } as unknown as ProposalInboxRow;
}

function relearnInboxRow(learningItemId: string): ProposalInboxRow {
  return {
    kind: 'relearn',
    payload: {
      proposed_change: { learning_item_id: learningItemId },
    },
  } as unknown as ProposalInboxRow;
}

describe('backfillLearningItemGenesis — scoped to truly event-less items', () => {
  beforeEach(async () => {
    await resetDb();
    await resetIndex();
  });

  it('seeds event-less items and is idempotent (re-run seeds 0)', async () => {
    const db = testDb();
    await insertEventlessItem('li_hub');
    const first = await backfillLearningItemGenesis(db, T0);
    expect(first.seeded).toBe(1);
    const second = await backfillLearningItemGenesis(db, T0);
    expect(second.seeded).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('seeds child + hub even when the child is inserted first (C3 hub-before-child topo order)', async () => {
    const db = testDb();
    // Insert child FIRST so input order does NOT already satisfy hub-before-child — the backfill's
    // stable sort (parentless rows first) must reorder so the hub is processed before its child.
    // (No FK enforces this here, but the parent-first sequence is the C3 convention; the observable
    // correctness is that BOTH seed cleanly and each folds byte-equal to its live row.)
    await insertEventlessItem('li_child', { parent_learning_item_id: 'li_hub' });
    await insertEventlessItem('li_hub', { parent_learning_item_id: null });
    const counts = await backfillLearningItemGenesis(db, T0);
    expect(counts.seeded).toBe(2);
    const genesisRows = await db
      .select({ subject_id: event.subject_id })
      .from(event)
      .where(eq(event.action, 'experimental:genesis'));
    const ids = genesisRows.map((r) => r.subject_id);
    expect(ids).toContain('li_hub');
    expect(ids).toContain('li_child');
    // each folds byte-equal to its live row (the parent-first seed order produced coherent bases).
    expect(await gatherAndFoldLearningItem(db, 'li_hub')).toEqual(await liveItem('li_hub'));
    expect(await gatherAndFoldLearningItem(db, 'li_child')).toEqual(await liveItem('li_child'));
    expect((await liveItem('li_child'))?.parent_learning_item_id).toBe('li_hub');
  });

  it('the backfilled genesis folds byte-equal to the live row (excluded cols ignored)', async () => {
    const db = testDb();
    await insertEventlessItem('li_1', {
      title: 'Master integrals',
      content: 'deep dive',
      status: 'in_progress',
      user_pinned: true,
      version: 2,
      ai_score: 0.7, // EXCLUDED — must not break the byte-equal fold
    });
    await backfillLearningItemGenesis(db, T0);
    const folded = await gatherAndFoldLearningItem(db, 'li_1');
    expect(folded).toEqual(await liveItem('li_1'));
  });
});

describe('gatherAndFoldLearningItem — shell parity over the event chain', () => {
  beforeEach(async () => {
    await resetDb();
    await resetIndex();
  });

  it('reproduces genesis → complete → relearn (status + completed_at + version chain)', async () => {
    const db = testDb();
    await insertEventlessItem('li_1', { status: 'pending', version: 0 });
    await backfillLearningItemGenesis(db, T0);
    const [g] = await db
      .select({ created_at: event.created_at })
      .from(event)
      .where(eq(event.action, 'experimental:genesis'))
      .limit(1);
    const base = (g?.created_at ?? new Date()).getTime();
    await writeEvent(db, {
      id: newId(),
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:learning_item_complete',
      subject_kind: 'learning_item',
      subject_id: 'li_1',
      outcome: 'success',
      payload: {},
      created_at: new Date(base + 1000),
    });
    let folded = await gatherAndFoldLearningItem(db, 'li_1');
    expect(folded?.status).toBe('done');
    expect(folded?.completed_at?.getTime()).toBe(base + 1000);
    expect(folded?.version).toBe(1);

    await writeEvent(db, {
      id: newId(),
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:learning_item_relearn',
      subject_kind: 'learning_item',
      subject_id: 'li_1',
      outcome: 'success',
      payload: {},
      created_at: new Date(base + 2000),
    });
    folded = await gatherAndFoldLearningItem(db, 'li_1');
    expect(folded?.status).toBe('in_progress');
    expect(folded?.completed_at).toBeNull();
    expect(folded?.version).toBe(2);
  });

  it('reproduces an archive (archived_at + reason, NO version bump)', async () => {
    const db = testDb();
    await insertEventlessItem('li_1', { status: 'pending', version: 4 });
    await backfillLearningItemGenesis(db, T0);
    const [g] = await db
      .select({ created_at: event.created_at })
      .from(event)
      .where(eq(event.action, 'experimental:genesis'))
      .limit(1);
    const base = (g?.created_at ?? new Date()).getTime();
    await writeEvent(db, {
      id: newId(),
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:learning_item_archive',
      subject_kind: 'learning_item',
      subject_id: 'li_1',
      outcome: 'success',
      payload: { reason: 'proposal_retracted' },
      created_at: new Date(base + 3000),
    });
    const folded = await gatherAndFoldLearningItem(db, 'li_1');
    expect(folded?.archived_at?.getTime()).toBe(base + 3000);
    expect(folded?.archived_reason).toBe('proposal_retracted');
    expect(folded?.version).toBe(4); // NO bump
  });
});

describe('canonical mutation after legacy migration', () => {
  beforeEach(async () => {
    await resetDb();
    await resetIndex();
  });

  it('completion rejects unprepared state, then migrated state transitions with one canonical clock', async () => {
    const db = testDb();

    await insertEventlessItem('li_pw2_off', { status: 'pending', version: 0 });
    // sanity: NO event sources the item before the accept.
    const pre = await db
      .select({ id: event.id })
      .from(event)
      .where(eq(event.subject_id, 'li_pw2_off'));
    expect(pre).toHaveLength(0);

    const before = await liveItem('li_pw2_off');
    await expect(
      acceptCompletionProposal(db as never, newId(), completionInboxRow('li_pw2_off'), {}),
    ).rejects.toThrow('canonical projection migration');
    expect(await liveItem('li_pw2_off')).toEqual(before);
    expect(await db.select().from(event)).toEqual([]);
    // Genesis can be newer than the business row; the action must sort after it.
    await migrateCanonicalProjections(db);
    await acceptCompletionProposal(db as never, newId(), completionInboxRow('li_pw2_off'), {});

    // Formal migration provided the base; the action really transitioned the row.
    const actions = (
      await db
        .select({ action: event.action })
        .from(event)
        .where(eq(event.subject_id, 'li_pw2_off'))
    ).map((r) => r.action);
    expect(actions).toContain('experimental:genesis');
    expect(actions).toContain('experimental:learning_item_complete');
    const live = await liveItem('li_pw2_off');
    expect(live?.status).toBe('done');
    expect(live?.completed_at).not.toBeNull();
    expect(live?.version).toBe(1);
    // fold(genesis + complete) reproduces the transitioned live row EXACTLY.
    expect(await gatherAndFoldLearningItem(db, 'li_pw2_off')).toEqual(live);
    // a subsequent backfill is a no-op (already anchored) — so the fold can never drift later.
    const bf = await backfillLearningItemGenesis(db, T0);
    expect(bf.seeded).toBe(0);
    const audit = await auditProjection(db, {});
    expect(audit.drift.filter((d) => d.id === 'li_pw2_off')).toEqual([]);
  });

  it('migrated done item relearns, clears completion and preserves replay parity', async () => {
    const db = testDb();

    await insertEventlessItem('li_pw2_relearn', {
      status: 'done',
      completed_at: new Date(T0.getTime() + 1000),
      version: 3,
    });
    const pre = await db
      .select({ id: event.id })
      .from(event)
      .where(eq(event.subject_id, 'li_pw2_relearn'));
    expect(pre).toHaveLength(0);

    await migrateCanonicalProjections(db);
    await acceptRelearnProposal(db as never, newId(), relearnInboxRow('li_pw2_relearn'), {});

    const actions = (
      await db
        .select({ action: event.action })
        .from(event)
        .where(eq(event.subject_id, 'li_pw2_relearn'))
    ).map((r) => r.action);
    expect(actions).toContain('experimental:genesis');
    expect(actions).toContain('experimental:learning_item_relearn');
    const live = await liveItem('li_pw2_relearn');
    expect(live?.status).toBe('in_progress');
    expect(live?.completed_at).toBeNull();
    expect(live?.version).toBe(4);
    expect(await gatherAndFoldLearningItem(db, 'li_pw2_relearn')).toEqual(live);
    const audit = await auditProjection(db, {});
    expect(audit.drift.filter((d) => d.id === 'li_pw2_relearn')).toEqual([]);
  });
});

describe('retractAiProposal (learning_item) — HIGH-1 single-clock + fold==row', () => {
  beforeEach(async () => {
    await resetDb();
    await resetIndex();
  });

  it('archives the materialized hub+atomic; archived_at==the archive event created_at; fold==row', async () => {
    const db = testDb();
    await db.insert(knowledge).values([
      {
        id: 'k_hub',
        name: 'Hub',
        domain: 'yuwen',
        parent_id: null,
        merged_from: [],
        proposed_by_ai: false,
        approval_status: 'approved',
        created_at: T0,
        updated_at: T0,
        version: 0,
      },
      {
        id: 'k_a',
        name: 'A',
        domain: 'yuwen',
        parent_id: 'k_hub',
        merged_from: [],
        proposed_by_ai: false,
        approval_status: 'approved',
        created_at: T0,
        updated_at: T0,
        version: 0,
      },
    ]);
    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        hub: { title: 'Hub overview', summary_md: 'overview' },
        atomics: [{ knowledge_id: 'k_a', title: 'A', one_line_intent: 'learn A' }],
        longs: [],
      }),
    }));
    const proposal = await planLearningIntent({ db, topic: 'Hub', runTaskFn });
    const proposalId = proposal.proposal_id;
    const accepted = await acceptAiProposal(db, proposalId);
    assertProposalLifecycleResult<LearningItemAcceptResult>(accepted, 'learning_item');
    const itemIds = [accepted.hub_learning_item_id, ...accepted.atomic_learning_item_ids];
    // every materialized item is active (not archived) + already event-sourced (genesis at INSERT).
    for (const id of itemIds) {
      const r = await liveItem(id);
      expect(r?.archived_at).toBeNull();
    }

    // Retraction writes the correction and per-item archive events, then projects.
    await retractAiProposal(db, proposalId, { reason_md: 'changed my mind' });

    for (const id of itemIds) {
      const live = await liveItem(id);
      const folded = await gatherAndFoldLearningItem(db, id);
      expect(live?.archived_at).not.toBeNull();
      expect(live?.archived_reason).toBe('proposal_retracted');
      // HIGH-1 single-clock: the imperative archive UPDATE stamps the SAME time the archive event
      // carries (the reducer derives archived_at/updated_at from the event created_at). A second
      // `new Date()` would drift by a cross-ms delta → fold != row.
      expect(folded).toEqual(live);
      expect(folded?.archived_at?.getTime()).toBe(live?.archived_at?.getTime());
      expect(folded?.updated_at.getTime()).toBe(live?.updated_at.getTime());
    }

    // the auditor sees zero learning_item drift on the retracted items.
    const audit = await auditProjection(db, {});
    expect(audit.drift.filter((d) => d.subject_kind === 'learning_item')).toEqual([]);
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

describe('auditProjection — learning_item section', () => {
  beforeEach(async () => {
    await resetDb();
    await resetIndex();
  });

  it('reports CLEAN for a coherent backfilled item', async () => {
    const db = testDb();
    await insertEventlessItem('li_1', { title: 'Clean' });
    await backfillLearningItemGenesis(db, T0);
    const result = await auditProjection(db, {});
    expect(result.checkedLearningItems).toBe(1);
    expect(result.drift).toEqual([]);
  });

  it('CLEAN even when only an EXCLUDED column (ai_score) differs from the seed', async () => {
    const db = testDb();
    await insertEventlessItem('li_1', { ai_score: null });
    await backfillLearningItemGenesis(db, T0);
    // out-of-band write to an EXCLUDED column only — the fold (from genesis) does not own ai_score,
    // so it must NOT register as drift.
    await db.update(learning_item).set({ ai_score: 0.42 }).where(eq(learning_item.id, 'li_1'));
    const result = await auditProjection(db, {});
    expect(result.drift.filter((d) => d.id === 'li_1')).toEqual([]);
  });

  it('flags DRIFT when a structural column is mutated out-of-band', async () => {
    const db = testDb();
    await insertEventlessItem('li_1', { title: 'Original' });
    await backfillLearningItemGenesis(db, T0);
    await db.update(learning_item).set({ title: 'Tampered' }).where(eq(learning_item.id, 'li_1'));
    const result = await auditProjection(db, {});
    const drifted = result.drift.find((d) => d.id === 'li_1' && d.subject_kind === 'learning_item');
    expect(drifted).toBeDefined();
    expect(drifted?.diffs.join(';')).toContain('title');
  });
});
