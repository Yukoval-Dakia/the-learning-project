// YUK-548 (worklist #5, slice 2) — B3-gate NO-GO leg tests for the 5 W2/W3 projection entities
// (goal / mistake_variant / learning_item / artifact / question_block), proving the registry-driven
// generalization of runB3Gate has real TEETH per entity, not just "the tool runs" (Lens A M7 — the
// "reproduce CLEAN" smoke is explicitly NOT a substitute for a capture leg).
//
// Three NO-GO legs per index-having entity (goal / mistake_variant / learning_item / artifact):
//   DRIFT    — an out-of-band structural mutation on a genesis-anchored row → the pre-rebuild audit
//              compares fold(genesis) vs the tampered live row → DRIFT.
//   GHOST    — an event-only row (genesis + anchor, live row dropped out-of-band) → the rebuild's
//              broader id universe (event subjects + index anchors) RESURRECTs it → survival.created.
//   DELETION — an index-anchored row whose base event was dropped → the scoped backfill SKIPs it (the
//              index leg still counts it "event-sourced") but it folds to NULL → the rebuild DELETEs
//              it → survival.deleted.
// Plus: an M5 over-inclusion SCOPING NO-GO (learning_item) and the P0-2 CLEAN reproduction SMOKE.
//
// question_block has NO materialized_id_index anchor leg (design §5.3), so the DELETION vector
// (index-anchored-but-baseless) is STRUCTURALLY impossible — a documented N/A leg, grounded by a
// test showing the backfill re-anchors a baseless block instead.
//
// Hermetic: resetDb() in beforeEach.

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@/core/ids';
import { artifact, event, goal, learning_item, mistake_variant, question_block } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import type { ProjectionKind } from '@/server/projections/entity-registry';
import { runB3Gate } from '../../../scripts/b3-gate';
import {
  backfillArtifactGenesis,
  backfillGoalGenesis,
  backfillLearningItemGenesis,
  backfillMistakeVariantGenesis,
  backfillQuestionBlockGenesis,
} from '../../../scripts/backfill-genesis-events';
import { resetDb, testDb } from '../../../tests/helpers/db';

const T0 = new Date('2026-06-01T00:00:00.000Z'); // pre-existing rows + genesis backfill in the test
const TGEN = new Date('2026-06-02T00:00:00.000Z'); // the gate's internal backfill time (AFTER T0)

async function insertGoal(id: string): Promise<void> {
  await testDb()
    .insert(goal)
    .values({
      id,
      title: `Goal ${id}`,
      subject_id: null,
      scope_knowledge_ids: ['k_a'],
      sequence_hint: 0,
      status: 'active',
      source: 'manual',
      source_ref: null,
      created_at: T0,
      updated_at: T0,
      version: 0,
    });
}

async function insertMistakeVariant(id: string): Promise<void> {
  await testDb().insert(mistake_variant).values({
    id,
    parent_question_id: 'q_parent',
    variant_question_id: null,
    proposal_event_id: null,
    status: 'draft',
    failure_reasons: [],
    cause_category: 'concept_confusion',
    created_at: T0,
    updated_at: T0,
  });
}

async function insertLearningItem(id: string, status = 'pending'): Promise<void> {
  await testDb()
    .insert(learning_item)
    .values({
      id,
      source: 'learning_intent',
      source_ref: null,
      title: `Item ${id}`,
      content: 'content',
      knowledge_ids: ['k_a'],
      primary_artifact_id: null,
      parent_learning_item_id: null,
      status,
      user_pinned: false,
      completed_at: null,
      dismissed_at: null,
      archived_at: null,
      archived_reason: null,
      created_at: T0,
      updated_at: T0,
      version: 0,
    });
}

async function insertArtifact(id: string): Promise<void> {
  await testDb()
    .insert(artifact)
    .values({
      id,
      type: 'note',
      title: `Artifact ${id}`,
      parent_artifact_id: null,
      knowledge_ids: [],
      intent_source: 'manual',
      source: 'manual',
      source_ref: null,
      body_blocks: null,
      attrs: {},
      tool_kind: null,
      tool_state: null,
      generation_status: 'ready',
      verification_status: 'not_required',
      verification_summary: null,
      generated_by: null,
      verified_by: null,
      history: [],
      archived_at: null,
      created_at: T0,
      updated_at: T0,
      version: 0,
    });
}

async function insertQuestionBlock(id: string): Promise<void> {
  await testDb()
    .insert(question_block)
    .values({
      id,
      ingestion_session_id: 'sess_1',
      source_document_id: null,
      source_asset_ids: [],
      page_spans: [],
      extracted_prompt_md: 'legacy prompt md',
      structured: { id, role: 'standalone', prompt_text: 'original' },
      figures: [],
      layout_quality: 'structured',
      reference_md: null,
      wrong_answer_md: null,
      image_refs: [],
      crop_refs: [],
      visual_complexity: 'low',
      extraction_confidence: 1,
      status: 'draft',
      knowledge_hint: null,
      merged_from_block_ids: [],
      imported_question_id: null,
      imported_attempt_event_id: null,
      created_at: T0,
      updated_at: T0,
      version: 0,
    });
}

// Delete the genesis event for `id` (leaving the index anchor + live row) — makes an index-anchored
// row fold to NULL without the backfill re-anchoring it (the DELETION leg).
async function dropGenesisEvent(kind: ProjectionKind, id: string): Promise<void> {
  await testDb()
    .delete(event)
    .where(
      and(
        eq(event.subject_kind, kind),
        eq(event.subject_id, id),
        eq(event.action, 'experimental:genesis'),
      ),
    );
}

interface EntityFixture {
  kind: ProjectionKind;
  insert: (id: string) => Promise<void>;
  backfill: (
    db: ReturnType<typeof testDb>,
    now: Date,
  ) => Promise<{ seeded: number; skipped: number }>;
  // out-of-band UPDATE of a SNAPSHOT (fold-truth) column → divergence from fold(genesis). Returns the
  // drizzle builder result (RowList), not void — awaited by the caller.
  tamper: (id: string) => Promise<unknown>;
  // drop the live row (leaving the genesis event + anchor) → the GHOST/resurrection setup.
  dropLiveRow: (id: string) => Promise<unknown>;
}

const INDEX_ENTITY_FIXTURES: EntityFixture[] = [
  {
    kind: 'goal',
    insert: insertGoal,
    backfill: (db, now) => backfillGoalGenesis(db, now),
    tamper: (id) => testDb().update(goal).set({ title: 'TAMPERED' }).where(eq(goal.id, id)),
    dropLiveRow: (id) => testDb().delete(goal).where(eq(goal.id, id)),
  },
  {
    kind: 'mistake_variant',
    insert: insertMistakeVariant,
    backfill: (db, now) => backfillMistakeVariantGenesis(db, now),
    tamper: (id) =>
      testDb()
        .update(mistake_variant)
        .set({ cause_category: 'careless_error' })
        .where(eq(mistake_variant.id, id)),
    dropLiveRow: (id) => testDb().delete(mistake_variant).where(eq(mistake_variant.id, id)),
  },
  {
    kind: 'learning_item',
    insert: (id) => insertLearningItem(id),
    backfill: (db, now) => backfillLearningItemGenesis(db, now),
    tamper: (id) =>
      testDb().update(learning_item).set({ title: 'TAMPERED' }).where(eq(learning_item.id, id)),
    dropLiveRow: (id) => testDb().delete(learning_item).where(eq(learning_item.id, id)),
  },
  {
    kind: 'artifact',
    insert: insertArtifact,
    backfill: (db, now) => backfillArtifactGenesis(db, now),
    tamper: (id) => testDb().update(artifact).set({ title: 'TAMPERED' }).where(eq(artifact.id, id)),
    dropLiveRow: (id) => testDb().delete(artifact).where(eq(artifact.id, id)),
  },
];

describe.each(INDEX_ENTITY_FIXTURES)('runB3Gate NO-GO legs (registry-driven) — $kind', (fx) => {
  beforeEach(async () => {
    await resetDb();
  });

  it('DRIFT: an out-of-band structural mutation on a genesis-anchored row is caught as audit DRIFT', async () => {
    const db = testDb();
    await fx.insert('x_drift');
    await fx.backfill(db, T0); // anchors the ORIGINAL value
    await fx.tamper('x_drift'); // live now diverges from fold(genesis)

    const report = await runB3Gate(db, [fx.kind], {}, TGEN);

    // The gate's own backfill SKIPs the already-anchored row → the audit folds the ORIGINAL genesis
    // and compares it to the tampered live row → DRIFT (a post-rebuild audit would miss this).
    expect(report.go).toBe(false);
    expect(report.audit.clean).toBe(false);
    expect(report.audit.driftCount).toBe(1); // exactly the one tampered row (hermetic fixture — K14 determinism)
    expect(report.audit.topologyReject).toBeNull();
  });

  it('GHOST: an event-only row (live row dropped) is RESURRECTED by the rebuild — survival.created', async () => {
    const db = testDb();
    await fx.insert('x_ghost');
    await fx.backfill(db, T0); // genesis event (+ index anchor) written
    await fx.dropLiveRow('x_ghost'); // drop the live row out-of-band; the events remain

    const report = await runB3Gate(db, [fx.kind], {}, TGEN);

    expect(report.go).toBe(false);
    expect(report.survival.ok).toBe(false);
    expect(report.survival.created[fx.kind]).toContain('x_ghost');
    // the LIVE-only value audit never sees the event-only row — the rowset creation check is the
    // only leg that catches the flip resurrecting it.
    expect(report.audit.clean).toBe(true);
  });

  it('DELETION: an index-anchored row whose base event was dropped folds to null → rebuild DELETEs it — survival.deleted', async () => {
    const db = testDb();
    await fx.insert('x_del');
    await fx.backfill(db, T0); // genesis event + index anchor
    // Drop the genesis EVENT but keep the index anchor + live row: the row still counts as
    // "event-sourced" (index leg) so the gate's backfill SKIPs it, but it now folds to NULL (no
    // base) → the rebuild DELETEs it.
    await dropGenesisEvent(fx.kind, 'x_del');

    const report = await runB3Gate(db, [fx.kind], {}, TGEN);

    expect(report.go).toBe(false);
    expect(report.survival.ok).toBe(false);
    expect(report.survival.deleted[fx.kind]).toContain('x_del');
  });
});

describe('runB3Gate NO-GO legs (registry-driven) — question_block', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('DRIFT: an out-of-band structural mutation on a genesis-anchored block is caught as audit DRIFT', async () => {
    const db = testDb();
    await insertQuestionBlock('qb_drift');
    await backfillQuestionBlockGenesis(db, T0);
    await db
      .update(question_block)
      .set({ reference_md: 'TAMPERED' })
      .where(eq(question_block.id, 'qb_drift'));

    const report = await runB3Gate(db, ['question_block'], {}, TGEN);

    expect(report.go).toBe(false);
    expect(report.audit.clean).toBe(false);
    expect(report.audit.driftCount).toBe(1); // exactly the one tampered row (hermetic fixture — K14 determinism)
  });

  it('GHOST: an event-only block (live row dropped) is RESURRECTED by the rebuild — survival.created', async () => {
    const db = testDb();
    await insertQuestionBlock('qb_ghost');
    await backfillQuestionBlockGenesis(db, T0); // genesis event (NO index — design §5.3)
    await db.delete(question_block).where(eq(question_block.id, 'qb_ghost'));

    const report = await runB3Gate(db, ['question_block'], {}, TGEN);

    expect(report.go).toBe(false);
    expect(report.survival.ok).toBe(false);
    // question_block's eventSubjectIds is event-subject-only (no index leg), but the genesis event's
    // subject_id still puts the block in the rebuild universe → resurrected.
    expect(report.survival.created.question_block).toContain('qb_ghost');
    expect(report.audit.clean).toBe(true);
  });

  it('DELETION leg is structurally N/A: with no index anchor, a baseless block is re-anchored by the backfill (never folds null)', async () => {
    const db = testDb();
    await insertQuestionBlock('qb_nodel');
    await backfillQuestionBlockGenesis(db, T0);
    // Drop the genesis event. UNLIKE the index-having entities, question_block has NO index anchor leg
    // (design §5.3), so questionBlocksWithGenesisAnchor now returns FALSE for it...
    await dropGenesisEvent('question_block', 'qb_nodel');

    const report = await runB3Gate(db, ['question_block'], {}, TGEN);

    // ...so the gate's SCOPED backfill RE-ANCHORS it (writes a fresh genesis from the current live
    // row) → it folds to its live row, NOT null → NOT deleted → GO. The index-anchored-but-baseless
    // DELETION vector that the four index-having entities expose simply cannot exist for qb — a
    // grounded N/A, not a "reproduce CLEAN" stand-in (Lens A M7).
    expect(report.survival.deleted).toEqual({});
    expect(report.go).toBe(true);
  });
});

describe('runB3Gate — M5 over-inclusion scoping NO-GO (learning_item)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('a genesis-anchored row with an UNAPPLIED mutation event surfaces as DRIFT (backfill must not re-genesis-mask an event-sourced row)', async () => {
    const db = testDb();
    await insertLearningItem('li_scope', 'pending');
    await backfillLearningItemGenesis(db, T0); // genesis seeds status=pending (li is now event-sourced)
    // The backfill's genesis carries writeEvent's DEFAULT created_at (wall-clock now), so the mutation
    // event must be stamped AFTER the actual genesis time to sort after it (mirrors the existing
    // learning_item.db.test.ts pattern — the `now` arg only sets ingest_at, not created_at).
    const [g] = await db
      .select({ created_at: event.created_at })
      .from(event)
      .where(and(eq(event.subject_id, 'li_scope'), eq(event.action, 'experimental:genesis')))
      .limit(1);
    // Explicit precondition (review CR5): a missing genesis is a broken fixture — fail LOUD here,
    // never silently fall back to wall-clock (which would mask a backfill regression).
    if (!g)
      throw new Error(
        'precondition failed: backfillLearningItemGenesis wrote no genesis for li_scope',
      );
    const genesisMs = g.created_at.getTime();
    // A REAL mutation event: complete → fold transitions pending → done. The live row STAYS 'pending'
    // (as if the imperative writer never applied it) → fold(genesis + complete) = 'done' ≠ live.
    await writeEvent(db, {
      id: newId(),
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:learning_item_complete',
      subject_kind: 'learning_item',
      subject_id: 'li_scope',
      outcome: 'success',
      payload: {},
      created_at: new Date(genesisMs + 1000),
    });

    const report = await runB3Gate(db, ['learning_item'], {}, TGEN);

    // The SCOPED backfill recognizes li_scope as event-sourced (it has a genesis) and SKIPs it — it
    // does NOT stamp a current-state ('pending') genesis that would sort LAST in the fold and MASK the
    // complete event. So the unapplied mutation surfaces as DRIFT → NO-GO. If the anchor scoping
    // over-included (re-genesis-masking event-sourced rows), the fold would collapse to 'pending' →
    // false CLEAN → false GO (the exact M5 failure mode).
    expect(report.go).toBe(false);
    expect(report.audit.clean).toBe(false);
    expect(report.audit.driftCount).toBe(1); // exactly the one tampered row (hermetic fixture — K14 determinism)
  });
});

describe('runB3Gate — P0-2 CLEAN reproduction SMOKE (not a capture leg)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('a coherent backfilled artifact world → GO', async () => {
    const db = testDb();
    await insertArtifact('art_ok');
    const report = await runB3Gate(db, ['artifact'], {}, TGEN);
    expect(report.go).toBe(true);
    expect(report.audit.clean).toBe(true);
    expect(report.survival.ok).toBe(true);
  });

  it('a coherent backfilled question_block world → GO', async () => {
    const db = testDb();
    await insertQuestionBlock('qb_ok');
    const report = await runB3Gate(db, ['question_block'], {}, TGEN);
    expect(report.go).toBe(true);
    expect(report.audit.clean).toBe(true);
    expect(report.survival.ok).toBe(true);
  });
});
