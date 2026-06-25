// YUK-471 Wave 2 — DB tests for the mistake_variant projection (testcontainer). The HARDEST W2
// entity: cause_category is FOLD-BLIND (carried by the base event only, critic A4).
//
// Covers (design §5 + critic A4 + B5):
//   - genesis backfill: seeds an event-less (pre-W2) variant, SKIPS a runtime-created (create-event)
//     variant, and is idempotent; cause_category is snapshotted into the genesis.
//   - shell parity: gatherAndFoldMistakeVariant reproduces the live row for create→accept→verify
//     (pass/fail)→dismiss/retract; cause_category SURVIVES the fold (the headline).
//   - per-entity flag: OFF (imperative INSERT/UPDATE) vs ON (projection write-through) yield
//     IDENTICAL rows for creation + accept.
//   - audit:projection mistake_variant section: CLEAN on a coherent fixture, DRIFT on an
//     out-of-band write (incl. a cause_category tamper).
//   - assertMistakeVariantParity catches a deliberate drift.
//
// Hermetic: resetDb() in beforeEach truncates `mistake_variant` (in ALL_TABLES) but NOT
// materialized_id_index (no FK → not CASCADE-reached), so we truncate the index explicitly.

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { newId } from '@/core/ids';
import type { MistakeVariantRowSnapshotT } from '@/core/schema/event/genesis';
import { event, materialized_id_index, mistake_variant } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { auditProjection } from '../../../scripts/audit-projection';
import { backfillMistakeVariantGenesis } from '../../../scripts/backfill-genesis-events';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { gatherAndFoldMistakeVariant } from './gather';
import { projectMistakeVariant } from './mistake_variant';
import { assertMistakeVariantParity, mistakeVariantLiveRowToSnapshot } from './parity';

const T0 = new Date('2026-06-01T00:00:00.000Z');
const FLAG = 'PROJECTION_IS_WRITER_MISTAKE_VARIANT';

async function resetIndex(): Promise<void> {
  await testDb().delete(materialized_id_index);
}

// Insert an event-less (pre-W2) mistake_variant directly — the legacy imperative shape.
async function insertEventlessMv(
  id: string,
  over: Partial<typeof mistake_variant.$inferSelect> = {},
): Promise<void> {
  await testDb()
    .insert(mistake_variant)
    .values({
      id,
      parent_question_id: over.parent_question_id ?? 'q_parent',
      variant_question_id: over.variant_question_id ?? null,
      proposal_event_id: over.proposal_event_id ?? null,
      status: over.status ?? 'draft',
      failure_reasons: over.failure_reasons ?? [],
      cause_category: over.cause_category ?? 'concept_confusion',
      created_at: over.created_at ?? T0,
      updated_at: over.updated_at ?? T0,
    });
}

// Write a runtime create BASE event (experimental:mistake_variant_create) + index anchor, the
// fold's runtime base (critic A4). payload.row carries the fold-blind cause_category.
async function writeCreateBase(opts: {
  mvId: string;
  proposalId: string;
  parentQuestionId?: string;
  causeCategory?: string | null;
  created_at: Date;
}): Promise<void> {
  const createEventId = newId();
  const baseRow: MistakeVariantRowSnapshotT = {
    id: opts.mvId,
    parent_question_id: opts.parentQuestionId ?? 'q_parent',
    variant_question_id: null,
    proposal_event_id: opts.proposalId,
    status: 'draft',
    failure_reasons: [],
    cause_category: opts.causeCategory ?? 'concept_confusion',
    created_at: opts.created_at,
    updated_at: opts.created_at,
  };
  await writeEvent(testDb(), {
    id: createEventId,
    actor_kind: 'agent',
    actor_ref: 'variant_gen',
    action: 'experimental:mistake_variant_create',
    subject_kind: 'mistake_variant',
    subject_id: opts.mvId,
    outcome: 'success',
    payload: { row: baseRow },
    caused_by_event_id: opts.proposalId,
    created_at: opts.created_at,
  });
  await testDb()
    .insert(materialized_id_index)
    .values({
      materialized_id: opts.mvId,
      anchor_event_id: createEventId,
      subject_kind: 'mistake_variant',
    })
    .onConflictDoNothing({ target: materialized_id_index.materialized_id });
}

async function writeRate(opts: {
  proposalId: string;
  rating: 'accept' | 'dismiss';
  materializedQuestionId?: string;
  mvId?: string;
  created_at: Date;
}): Promise<void> {
  await writeEvent(testDb(), {
    id: newId(),
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: opts.proposalId,
    outcome: 'success',
    payload: {
      rating: opts.rating,
      ...(opts.materializedQuestionId
        ? { materialized_question_id: opts.materializedQuestionId, mistake_variant_id: opts.mvId }
        : {}),
    },
    caused_by_event_id: opts.proposalId,
    created_at: opts.created_at,
  });
}

async function writeVerify(opts: {
  proposalId: string;
  variantQuestionId: string;
  verdict: 'pass' | 'fail';
  failureReasons?: string[];
  created_at: Date;
}): Promise<void> {
  await writeEvent(testDb(), {
    id: newId(),
    actor_kind: 'agent',
    actor_ref: 'variant_verify',
    action: 'experimental:variant_verify',
    subject_kind: 'question',
    subject_id: opts.variantQuestionId,
    outcome: opts.verdict === 'pass' ? 'success' : 'partial',
    payload: { verdict: opts.verdict, failure_reasons: opts.failureReasons ?? [] },
    caused_by_event_id: opts.proposalId,
    created_at: opts.created_at,
  });
}

async function writeRetract(opts: { proposalId: string; created_at: Date }): Promise<void> {
  await writeEvent(testDb(), {
    id: newId(),
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'correct',
    subject_kind: 'event',
    subject_id: opts.proposalId,
    outcome: 'success',
    // CorrectEvent (known.ts) requires affected_refs.min(1); the reducer only reads correction_kind.
    payload: {
      correction_kind: 'retract',
      reason_md: 'retracted',
      affected_refs: [{ kind: 'open_inquiry', id: opts.proposalId }],
    },
    caused_by_event_id: opts.proposalId,
    created_at: opts.created_at,
  });
}

async function liveMv(id: string): Promise<MistakeVariantRowSnapshotT | null> {
  const rows = await testDb()
    .select()
    .from(mistake_variant)
    .where(eq(mistake_variant.id, id))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return mistakeVariantLiveRowToSnapshot(r);
}

describe('backfillMistakeVariantGenesis — scoped to truly event-less variants', () => {
  beforeEach(async () => {
    await resetDb();
    await resetIndex();
  });

  it('anchors an event-less variant but SKIPS a runtime create-event variant; cause_category in genesis', async () => {
    const db = testDb();
    await insertEventlessMv('mv_legacy', { cause_category: 'careless_slip' }); // event-less → anchored
    // runtime-created variant: has an experimental:mistake_variant_create event → SKIPPED.
    await insertEventlessMv('mv_created', { proposal_event_id: 'prop_1' });
    await writeCreateBase({ mvId: 'mv_created', proposalId: 'prop_1', created_at: T0 });

    const counts = await backfillMistakeVariantGenesis(db, T0);
    expect(counts.seeded).toBe(1); // only the event-less legacy variant
    expect(counts.skipped).toBe(1); // the create-event variant is already event-sourced

    const genesisRows = await db
      .select({ subject_id: event.subject_id, payload: event.payload })
      .from(event)
      .where(eq(event.action, 'experimental:genesis'));
    const seeded = genesisRows.find((r) => r.subject_id === 'mv_legacy');
    expect(seeded).toBeDefined();
    expect(genesisRows.map((r) => r.subject_id)).not.toContain('mv_created');
    // cause_category MUST be in the genesis snapshot (fold-blindness compensation).
    const seededRow = (seeded?.payload as { row?: { cause_category?: string } } | null)?.row;
    expect(seededRow?.cause_category).toBe('careless_slip');
  });

  it('is idempotent: a second backfill seeds 0', async () => {
    const db = testDb();
    await insertEventlessMv('mv_legacy');
    const first = await backfillMistakeVariantGenesis(db, T0);
    expect(first.seeded).toBe(1);
    const second = await backfillMistakeVariantGenesis(db, T0);
    expect(second.seeded).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('the backfilled genesis folds byte-equal to the live row', async () => {
    const db = testDb();
    await insertEventlessMv('mv_legacy', {
      parent_question_id: 'q_p',
      variant_question_id: 'q_v',
      proposal_event_id: 'prop_x',
      status: 'broken',
      failure_reasons: ['off-target'],
      cause_category: 'method_gap',
    });
    await backfillMistakeVariantGenesis(db, T0);
    const folded = await gatherAndFoldMistakeVariant(db, 'mv_legacy');
    expect(folded).toEqual(await liveMv('mv_legacy'));
    expect(folded?.cause_category).toBe('method_gap');
  });
});

describe('gatherAndFoldMistakeVariant — shell parity over the event chain', () => {
  beforeEach(async () => {
    await resetDb();
    await resetIndex();
  });

  it('cause_category SURVIVES the create→accept→verify(pass) fold (headline, fold-blindness fix)', async () => {
    const db = testDb();
    await writeCreateBase({
      mvId: 'mv_1',
      proposalId: 'prop_1',
      causeCategory: 'concept_confusion',
      created_at: T0,
    });
    await writeRate({
      proposalId: 'prop_1',
      rating: 'accept',
      materializedQuestionId: 'q_variant',
      mvId: 'mv_1',
      created_at: new Date(T0.getTime() + 1000),
    });
    await writeVerify({
      proposalId: 'prop_1',
      variantQuestionId: 'q_variant',
      verdict: 'pass',
      created_at: new Date(T0.getTime() + 2000),
    });
    const folded = await gatherAndFoldMistakeVariant(db, 'mv_1');
    expect(folded?.cause_category).toBe('concept_confusion'); // NEVER carried by accept/verify
    expect(folded?.status).toBe('active');
    expect(folded?.variant_question_id).toBe('q_variant');
  });

  it('verify FAIL folds to broken + failure_reasons', async () => {
    const db = testDb();
    await writeCreateBase({ mvId: 'mv_1', proposalId: 'prop_1', created_at: T0 });
    await writeRate({
      proposalId: 'prop_1',
      rating: 'accept',
      materializedQuestionId: 'q_variant',
      mvId: 'mv_1',
      created_at: new Date(T0.getTime() + 1000),
    });
    await writeVerify({
      proposalId: 'prop_1',
      variantQuestionId: 'q_variant',
      verdict: 'fail',
      failureReasons: ['drifted'],
      created_at: new Date(T0.getTime() + 2000),
    });
    const folded = await gatherAndFoldMistakeVariant(db, 'mv_1');
    expect(folded?.status).toBe('broken');
    expect(folded?.failure_reasons).toEqual(['drifted']);
  });

  it('dismiss folds to dismissed', async () => {
    const db = testDb();
    await writeCreateBase({ mvId: 'mv_1', proposalId: 'prop_1', created_at: T0 });
    await writeRate({
      proposalId: 'prop_1',
      rating: 'dismiss',
      created_at: new Date(T0.getTime() + 1000),
    });
    const folded = await gatherAndFoldMistakeVariant(db, 'mv_1');
    expect(folded?.status).toBe('dismissed');
  });

  it('retract folds to dismissed', async () => {
    const db = testDb();
    await writeCreateBase({ mvId: 'mv_1', proposalId: 'prop_1', created_at: T0 });
    await writeRate({
      proposalId: 'prop_1',
      rating: 'accept',
      materializedQuestionId: 'q_variant',
      mvId: 'mv_1',
      created_at: new Date(T0.getTime() + 1000),
    });
    await writeRetract({ proposalId: 'prop_1', created_at: new Date(T0.getTime() + 2000) });
    const folded = await gatherAndFoldMistakeVariant(db, 'mv_1');
    expect(folded?.status).toBe('dismissed');
    expect(folded?.variant_question_id).toBe('q_variant'); // preserved
  });
});

describe('projectMistakeVariant write-through — per-entity flag ON', () => {
  beforeEach(async () => {
    await resetDb();
    await resetIndex();
    process.env[FLAG] = '1';
  });
  afterEach(() => {
    delete process.env[FLAG];
  });

  it('write-through (ON) produces the SAME row the fold derives, after a create→accept chain', async () => {
    const db = testDb();
    await writeCreateBase({
      mvId: 'mv_on',
      proposalId: 'prop_on',
      causeCategory: 'method_gap',
      created_at: T0,
    });
    // projection writes the draft row
    await projectMistakeVariant(db, 'mv_on');
    expect((await liveMv('mv_on'))?.status).toBe('draft');
    expect((await liveMv('mv_on'))?.cause_category).toBe('method_gap');

    // accept rate → re-project → active + variant_question_id
    await writeRate({
      proposalId: 'prop_on',
      rating: 'accept',
      materializedQuestionId: 'q_v',
      mvId: 'mv_on',
      created_at: new Date(T0.getTime() + 1000),
    });
    await projectMistakeVariant(db, 'mv_on');
    const onRow = await liveMv('mv_on');
    expect(onRow?.status).toBe('active');
    expect(onRow?.variant_question_id).toBe('q_v');
    expect(onRow?.cause_category).toBe('method_gap'); // survived
    // write-through row == fold
    expect(onRow).toEqual(await gatherAndFoldMistakeVariant(db, 'mv_on'));
  });
});

describe('assertMistakeVariantParity — catches a deliberate drift', () => {
  beforeEach(async () => {
    await resetDb();
    await resetIndex();
  });

  it('PASSES when the live row equals the fold; THROWS on a tampered live row', async () => {
    const db = testDb();
    await writeCreateBase({ mvId: 'mv_1', proposalId: 'prop_1', created_at: T0 });
    await projectMistakeVariant(db, 'mv_1'); // write the coherent draft row
    const live = await liveMv('mv_1');
    // coherent → passes (no throw)
    await expect(assertMistakeVariantParity(db, 'mv_1', live)).resolves.toBeUndefined();
    // deliberate drift: claim the live row says cause_category='WRONG' (the fold derives the base's)
    const tampered = { ...(live as MistakeVariantRowSnapshotT), cause_category: 'WRONG' };
    await expect(assertMistakeVariantParity(db, 'mv_1', tampered)).rejects.toThrow(
      /projection-parity/,
    );
  });
});

describe('auditProjection — mistake_variant section', () => {
  beforeEach(async () => {
    await resetDb();
    await resetIndex();
  });

  it('reports CLEAN for a coherent backfilled variant', async () => {
    const db = testDb();
    await insertEventlessMv('mv_1', { cause_category: 'concept_confusion' });
    await backfillMistakeVariantGenesis(db, T0);
    const result = await auditProjection(db, {});
    expect(result.checkedMistakeVariants).toBe(1);
    expect(result.drift).toEqual([]);
  });

  it('flags DRIFT when cause_category is mutated out-of-band (bypassing the projection)', async () => {
    const db = testDb();
    await insertEventlessMv('mv_1', { cause_category: 'concept_confusion' });
    await backfillMistakeVariantGenesis(db, T0);
    // out-of-band raw UPDATE that does NOT write any event → fold (from genesis) != live row.
    await db
      .update(mistake_variant)
      .set({ cause_category: 'tampered_cause' })
      .where(eq(mistake_variant.id, 'mv_1'));
    const result = await auditProjection(db, {});
    const drifted = result.drift.find(
      (d) => d.id === 'mv_1' && d.subject_kind === 'mistake_variant',
    );
    expect(drifted).toBeDefined();
    expect(drifted?.diffs.join(';')).toContain('cause_category');
  });
});
