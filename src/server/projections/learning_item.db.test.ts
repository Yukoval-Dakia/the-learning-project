// YUK-471 Wave 2 — DB tests for the learning_item projection (testcontainer). The entity with the
// MOST EXCLUDED columns of the W2 trio.
//
// Covers (design §5 + critic B1/B5):
//   - genesis backfill: seeds event-less (pre-W2) items, is idempotent, hub-before-child topo order
//     (C3), and the backfilled genesis folds byte-equal to the live row.
//   - shell parity: gatherAndFoldLearningItem reproduces the live row over genesis →
//     complete/relearn/archive; excluded columns (ai_score etc.) never enter the diff.
//   - per-entity flag: OFF (imperative UPDATE) vs ON (projection write-through) yield IDENTICAL rows
//     for the completion accept.
//   - retract (actions.ts learning_item block, flag OFF): HIGH-1 single-clock — the archived row's
//     archived_at/updated_at == the archive event's created_at; genesis-if-missing makes fold==row.
//   - audit:projection learning_item section: CLEAN on a coherent fixture, DRIFT on an out-of-band
//     write; a row differing ONLY in an excluded column folds clean.
//
// Hermetic: resetDb() TRUNCATEs ALL_TABLES (incl. learning_item + materialized_id_index).

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { acceptCompletionProposal } from '@/capabilities/agency/server/proposal-appliers';
import { newId } from '@/core/ids';
import type { LearningItemRowSnapshotT } from '@/core/schema/event/genesis';
import { event, knowledge, learning_item, materialized_id_index } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { planLearningIntent } from '@/server/orchestrator/learning_intent';
import { acceptAiProposal, retractAiProposal } from '@/server/proposals/actions';
import type { ProposalInboxRow } from '@/server/proposals/inbox';
import { writeLearningItemProposal } from '@/server/proposals/producers';
import { auditProjection } from '../../../scripts/audit-projection';
import { backfillLearningItemGenesis } from '../../../scripts/backfill-genesis-events';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { gatherAndFoldLearningItem } from './gather';

const T0 = new Date('2026-06-01T00:00:00.000Z');
const FLAG = 'PROJECTION_IS_WRITER_LEARNING_ITEM';

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
    delete process.env[FLAG];
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

describe('per-entity flag — completion accept OFF vs ON yield identical rows', () => {
  beforeEach(async () => {
    await resetDb();
    await resetIndex();
  });
  afterEach(() => {
    delete process.env[FLAG];
  });

  it('completion: OFF (imperative UPDATE) and ON (projection write-through) produce the same row', async () => {
    const db = testDb();

    // OFF run — backfill an event-sourced item, then accept a completion proposal (flag OFF). Same
    // title on both runs so the normalized cross-run comparison only differs by the per-run id.
    delete process.env[FLAG];
    await insertEventlessItem('li_off', { title: 'Same', status: 'pending', version: 0 });
    await backfillLearningItemGenesis(db, T0);
    const proposalOff = newId();
    await acceptCompletionProposal(db as never, proposalOff, completionInboxRow('li_off'), {});
    const offRow = await liveItem('li_off');
    expect(offRow?.status).toBe('done');
    expect(await gatherAndFoldLearningItem(db, 'li_off')).toEqual(offRow);

    // ON run (separate item).
    process.env[FLAG] = '1';
    await insertEventlessItem('li_on', { title: 'Same', status: 'pending', version: 0 });
    await backfillLearningItemGenesis(db, T0);
    const proposalOn = newId();
    await acceptCompletionProposal(db as never, proposalOn, completionInboxRow('li_on'), {});
    const onRow = await liveItem('li_on');
    expect(onRow?.status).toBe('done');
    expect(await gatherAndFoldLearningItem(db, 'li_on')).toEqual(onRow);
    expect(onRow?.version).toBe(1);

    // structural equality of the two rows except the per-run id + timestamps.
    const norm = (r: LearningItemRowSnapshotT | null) =>
      r && { ...r, id: 'X', created_at: 0, updated_at: 0, completed_at: 0 };
    expect(norm(onRow)).toEqual(norm(offRow));
  });
});

describe('retractAiProposal (learning_item, flag OFF) — HIGH-1 single-clock + fold==row', () => {
  beforeEach(async () => {
    await resetDb();
    await resetIndex();
    delete process.env[FLAG]; // OFF — imperative archive UPDATE writes the rows
  });
  afterEach(() => {
    delete process.env[FLAG];
  });

  it('archives the materialized hub+atomic; archived_at==the archive event created_at; fold==row', async () => {
    const db = testDb();
    await db.insert(knowledge).values([
      {
        id: 'k_hub',
        name: 'Hub',
        domain: 'wenyan',
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
        domain: 'wenyan',
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
    if (accepted.kind !== 'learning_item') throw new Error('unexpected kind');
    const itemIds = [accepted.hub_learning_item_id, ...accepted.atomic_learning_item_ids];
    // every materialized item is active (not archived) + already event-sourced (genesis at INSERT).
    for (const id of itemIds) {
      const r = await liveItem(id);
      expect(r?.archived_at).toBeNull();
    }

    // Retract (flag OFF → writes the `correct` event + per-id archive events + the imperative UPDATE).
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

  it('GENESIS-IF-MISSING: retracting an eventless (un-backfilled) item writes the genesis base + archive; fold==row (review #2)', async () => {
    const db = testDb();
    // A real learning_item proposal in the inbox (so retractAiProposal's requireProposal resolves)
    // — but NOTHING materialized through the genesis-writing INSERT path.
    const proposalId = await writeLearningItemProposal(db as never, {
      topic: 'Eventless topic',
      knowledge_node: { id: 'k_x', name: 'X', domain: 'wenyan' },
      hub: { title: 'Hub', summary_md: 'overview' },
      atomics: [],
      reason_md: 'because',
      evidence_refs: [],
      created_at: T0,
    });
    // Directly INSERT an EVENTLESS item with source_ref=proposalId — NO genesis event, so
    // hasLearningItemGenesisAnchor is FALSE and the retract MUST exercise the genesis-if-missing
    // branch (the lane's only novel double-clock path, otherwise never executed by the e2e test).
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

    await retractAiProposal(db, proposalId, { reason_md: 'eventless retract' });

    // the genesis base was written this tx (so the archive event has a base to fold from).
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
    // The clamp (review #1) guarantees genesis sorts strictly before the archive regardless of the
    // cuid2 id coin-flip, so the archive ALWAYS hits the seeded row → fold.archived_at == live.
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
