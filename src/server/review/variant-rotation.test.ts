// YUK-282 / ADR-0030 — variant-rotation probe selection (by-kind routing).
//
// Tests the deterministic selection core `pickProbeForKnowledge` directly against
// a real Postgres (DB config): recall = original-question repeat, application =
// root_question_id family rotation, plus every fallback / dedup / boundary path
// from ADR-0030 §2/§3 and plan §3.

import { event, question } from '@/db/schema';
import { pickProbeForKnowledge, rotationClassForKind } from '@/server/review/variant-rotation';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';

const BASE = {
  reference_md: null as string | null,
  difficulty: 3,
  source: 'manual' as const,
  version: 0,
};

// Monotonic clock so created_at ordering is deterministic per insert.
let clock = 0;
function nextDate(): Date {
  clock += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, clock));
}

async function seedQuestion(
  id: string,
  overrides: Partial<{
    kind: string;
    knowledge_ids: string[];
    root_question_id: string | null;
    variant_depth: number;
    draft_status: string | null;
    created_at: Date;
    source: string;
    metadata: Record<string, unknown> | null;
  }> = {},
) {
  const db = testDb();
  const created = overrides.created_at ?? nextDate();
  await db.insert(question).values({
    id,
    prompt_md: `P ${id}`,
    kind: overrides.kind ?? 'short_answer',
    knowledge_ids: overrides.knowledge_ids ?? ['k1'],
    variant_depth: overrides.variant_depth ?? 0,
    root_question_id: overrides.root_question_id ?? null,
    draft_status: overrides.draft_status ?? null,
    metadata: (overrides.metadata ?? null) as never,
    created_at: created,
    updated_at: created,
    ...BASE,
    source: overrides.source ?? BASE.source,
  });
}

// Seed a review event whose subject_id is the question presented last; returns
// the event id to hand to pickProbeForKnowledge as lastReviewEventId.
async function seedReviewEvent(questionId: string): Promise<string> {
  const db = testDb();
  const id = `evt_review_${questionId}_${clock}`;
  await db.insert(event).values({
    id,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'review',
    subject_kind: 'question',
    subject_id: questionId,
    outcome: 'success',
    payload: { fsrs_rating: 'good' },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: nextDate(),
  });
  return id;
}

function pick(input: {
  knowledgeId: string;
  lastReviewEventId: string | null;
  usedQuestionIds?: Set<string>;
}) {
  return pickProbeForKnowledge(testDb(), {
    knowledgeId: input.knowledgeId,
    lastReviewEventId: input.lastReviewEventId,
    usedQuestionIds: input.usedQuestionIds ?? new Set<string>(),
  });
}

describe('rotationClassForKind', () => {
  it('routes recall vs application per ADR-0030 §1', () => {
    expect(rotationClassForKind('fill_blank')).toBe('recall');
    expect(rotationClassForKind('translation')).toBe('recall');
    expect(rotationClassForKind('short_answer')).toBe('application');
    expect(rotationClassForKind('reading')).toBe('application');
    expect(rotationClassForKind('choice')).toBe('application');
  });

  it('defaults un-adjudicated kinds to application (conservative)', () => {
    expect(rotationClassForKind('essay')).toBe('application');
    expect(rotationClassForKind('computation')).toBe('application');
    expect(rotationClassForKind('derivation')).toBe('application');
    expect(rotationClassForKind('true_false')).toBe('application');
  });
});

describe('pickProbeForKnowledge', () => {
  beforeEach(async () => {
    clock = 0;
    await resetDb();
  });

  // §3.1 — recall: re-present the SAME question (no rotation).
  it('recall: repeats the original question (fill_blank)', async () => {
    await seedQuestion('q_recall', { kind: 'fill_blank', knowledge_ids: ['k_r'] });
    await seedQuestion('q_other', { kind: 'fill_blank', knowledge_ids: ['k_r'] });
    const evt = await seedReviewEvent('q_recall');

    const chosen = await pick({ knowledgeId: 'k_r', lastReviewEventId: evt });
    expect(chosen?.question_id).toBe('q_recall');
  });

  it('recall: repeats the original question (translation)', async () => {
    await seedQuestion('q_tr', { kind: 'translation', knowledge_ids: ['k_tr'] });
    const evt = await seedReviewEvent('q_tr');

    const chosen = await pick({ knowledgeId: 'k_tr', lastReviewEventId: evt });
    expect(chosen?.question_id).toBe('q_tr');
  });

  // §3.2 — recall fallback: last question demoted to draft → K's first non-draft.
  it('recall: falls back to first non-draft for K when last question is now draft', async () => {
    await seedQuestion('q_recall_draft', {
      kind: 'fill_blank',
      knowledge_ids: ['k_rd'],
      draft_status: 'draft',
    });
    await seedQuestion('q_recall_active', { kind: 'fill_blank', knowledge_ids: ['k_rd'] });
    const evt = await seedReviewEvent('q_recall_draft');

    const chosen = await pick({ knowledgeId: 'k_rd', lastReviewEventId: evt });
    expect(chosen?.question_id).toBe('q_recall_active');
  });

  it('recall: falls back when last question no longer tags K', async () => {
    // last question tags only k_gone, knowledge under review is k_here.
    await seedQuestion('q_unlabel', { kind: 'fill_blank', knowledge_ids: ['k_gone'] });
    await seedQuestion('q_here', { kind: 'fill_blank', knowledge_ids: ['k_here'] });
    const evt = await seedReviewEvent('q_unlabel');

    const chosen = await pick({ knowledgeId: 'k_here', lastReviewEventId: evt });
    expect(chosen?.question_id).toBe('q_here');
  });

  // §3.3 — application family rotation, production shape: root(d0)+V1(d1)+V2(d1).
  it('application: rotates the variant family in (variant_depth, created_at) order', async () => {
    await seedQuestion('q_root', {
      kind: 'short_answer',
      knowledge_ids: ['k_app'],
      variant_depth: 0,
    });
    await seedQuestion('q_v1', {
      kind: 'short_answer',
      knowledge_ids: ['k_app'],
      variant_depth: 1,
      root_question_id: 'q_root',
    });
    await seedQuestion('q_v2', {
      kind: 'short_answer',
      knowledge_ids: ['k_app'],
      variant_depth: 1,
      root_question_id: 'q_root',
    });

    // Guard the production invariant: the two variants share depth (1); ordering
    // between them therefore falls to created_at — V1 seeded before V2.
    const variants = await testDb()
      .select({ id: question.id, variant_depth: question.variant_depth })
      .from(question);
    const depthById = new Map(variants.map((r) => [r.id, r.variant_depth]));
    expect(depthById.get('q_v1')).toBe(depthById.get('q_v2'));
    expect(depthById.get('q_v1')).toBe(1);

    // last=root → next is V1.
    const evtRoot = await seedReviewEvent('q_root');
    expect((await pick({ knowledgeId: 'k_app', lastReviewEventId: evtRoot }))?.question_id).toBe(
      'q_v1',
    );

    // last=V1 → next is V2.
    const evtV1 = await seedReviewEvent('q_v1');
    expect((await pick({ knowledgeId: 'k_app', lastReviewEventId: evtV1 }))?.question_id).toBe(
      'q_v2',
    );

    // last=V2 → wraps back to root.
    const evtV2 = await seedReviewEvent('q_v2');
    expect((await pick({ knowledgeId: 'k_app', lastReviewEventId: evtV2 }))?.question_id).toBe(
      'q_root',
    );
  });

  // §3.3 optional — forward-compat guard: a directly-inserted depth-2 row (which
  // variant_gen can NOT produce; depth>=1 is capped at variant_gen.ts:161) keeps
  // the (variant_depth ASC, …) ring stable across mixed depths. NOT representative
  // of production data — purely a regression guard for a future depth-cap relax.
  it('application: rotation order stays stable across mixed depths (forward-compat)', async () => {
    await seedQuestion('f_root', {
      kind: 'short_answer',
      knowledge_ids: ['k_fc'],
      variant_depth: 0,
    });
    await seedQuestion('f_d1', {
      kind: 'short_answer',
      knowledge_ids: ['k_fc'],
      variant_depth: 1,
      root_question_id: 'f_root',
    });
    await seedQuestion('f_d2', {
      kind: 'short_answer',
      knowledge_ids: ['k_fc'],
      variant_depth: 2,
      root_question_id: 'f_root',
    });

    // Ordered ring = [f_root(0), f_d1(1), f_d2(2)]. last=f_d1 → f_d2; last=f_d2 → wrap root.
    const evtD1 = await seedReviewEvent('f_d1');
    expect((await pick({ knowledgeId: 'k_fc', lastReviewEventId: evtD1 }))?.question_id).toBe(
      'f_d2',
    );
    const evtD2 = await seedReviewEvent('f_d2');
    expect((await pick({ knowledgeId: 'k_fc', lastReviewEventId: evtD2 }))?.question_id).toBe(
      'f_root',
    );
  });

  // §3.4 — application family of one degrades to original-repeat.
  it('application: family of one (no variants) repeats the original question', async () => {
    await seedQuestion('q_solo', {
      kind: 'short_answer',
      knowledge_ids: ['k_solo'],
      variant_depth: 0,
    });
    const evt = await seedReviewEvent('q_solo');

    const chosen = await pick({ knowledgeId: 'k_solo', lastReviewEventId: evt });
    expect(chosen?.question_id).toBe('q_solo');
  });

  // §3.5 — Q_last not in family (hard-deleted) → take the ordered序首.
  it('application: when last question was deleted, takes the family series head', async () => {
    await seedQuestion('q_del_root', {
      kind: 'short_answer',
      knowledge_ids: ['k_del'],
      variant_depth: 0,
    });
    await seedQuestion('q_del_v1', {
      kind: 'short_answer',
      knowledge_ids: ['k_del'],
      variant_depth: 1,
      root_question_id: 'q_del_root',
    });
    // review event points at a now-deleted question id; readQuestion → null →
    // application default first probe → K's first non-draft (created_at ASC) = root.
    const db = testDb();
    await db.insert(event).values({
      id: 'evt_del',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'review',
      subject_kind: 'question',
      subject_id: 'q_deleted_gone',
      outcome: 'success',
      payload: { fsrs_rating: 'good' },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: nextDate(),
    });

    const chosen = await pick({ knowledgeId: 'k_del', lastReviewEventId: 'evt_del' });
    expect(chosen?.question_id).toBe('q_del_root');
  });

  // §3.6 — family cross-knowledge boundary: K filter applied before rotation.
  it('application: family is filtered to the due knowledge before rotation', async () => {
    // root tags only k1; variant tags both k1 and k2. When k2 is due, the family
    // pool must contain only the variant (root is excluded — it does not tag k2).
    await seedQuestion('q_xk_root', {
      kind: 'short_answer',
      knowledge_ids: ['k1'],
      variant_depth: 0,
    });
    await seedQuestion('q_xk_v', {
      kind: 'short_answer',
      knowledge_ids: ['k1', 'k2'],
      variant_depth: 1,
      root_question_id: 'q_xk_root',
    });
    // last reviewed for k2 was the variant; family∩k2 = {variant} → wraps to itself.
    const evt = await seedReviewEvent('q_xk_v');

    const chosen = await pick({ knowledgeId: 'k2', lastReviewEventId: evt });
    expect(chosen?.question_id).toBe('q_xk_v');
  });

  // §3.7 — used dedup: a multi-tagged question taken by K_A is skipped by K_B.
  it('application: skips a question already used this page (cross-knowledge dedup)', async () => {
    await seedQuestion('q_dedup_root', {
      kind: 'short_answer',
      knowledge_ids: ['kb'],
      variant_depth: 0,
    });
    await seedQuestion('q_dedup_v1', {
      kind: 'short_answer',
      knowledge_ids: ['kb'],
      variant_depth: 1,
      root_question_id: 'q_dedup_root',
    });
    const used = new Set<string>(['q_dedup_v1']); // already chosen by another knowledge
    // last=root, but v1 is used → family minus used = {root} → idx(root)=0, len 1 → wraps to root.
    const evtRoot = await seedReviewEvent('q_dedup_root');

    const chosen = await pick({
      knowledgeId: 'kb',
      lastReviewEventId: evtRoot,
      usedQuestionIds: used,
    });
    expect(chosen?.question_id).toBe('q_dedup_root');
  });

  // §3.8 — determinism: identical input → identical output across runs.
  it('is deterministic: same input yields same output', async () => {
    await seedQuestion('q_det_root', {
      kind: 'short_answer',
      knowledge_ids: ['k_det'],
      variant_depth: 0,
    });
    await seedQuestion('q_det_v1', {
      kind: 'short_answer',
      knowledge_ids: ['k_det'],
      variant_depth: 1,
      root_question_id: 'q_det_root',
    });
    const evt = await seedReviewEvent('q_det_root');

    const a = await pick({ knowledgeId: 'k_det', lastReviewEventId: evt });
    const b = await pick({ knowledgeId: 'k_det', lastReviewEventId: evt });
    expect(a?.question_id).toBe(b?.question_id);
    expect(a?.question_id).toBe('q_det_v1');
  });

  // §3.9 — un-adjudicated kind (essay) defaults to application rotation.
  it('un-adjudicated kind (essay) routes through application family rotation', async () => {
    await seedQuestion('q_essay_root', {
      kind: 'essay',
      knowledge_ids: ['k_essay'],
      variant_depth: 0,
    });
    await seedQuestion('q_essay_v1', {
      kind: 'essay',
      knowledge_ids: ['k_essay'],
      variant_depth: 1,
      root_question_id: 'q_essay_root',
    });
    const evt = await seedReviewEvent('q_essay_root');

    const chosen = await pick({ knowledgeId: 'k_essay', lastReviewEventId: evt });
    expect(chosen?.question_id).toBe('q_essay_v1');
  });

  // Never-reviewed (no last event) → application default first probe = K's first
  // non-draft (created_at ASC), preserving source/metadata projection.
  it('never-reviewed knowledge picks the first non-draft question with source/metadata', async () => {
    await seedQuestion('q_first', {
      kind: 'short_answer',
      knowledge_ids: ['k_new'],
      source: 'vision_paper',
      metadata: { ingestion_session_id: 'sess_1' },
    });
    await seedQuestion('q_second', { kind: 'short_answer', knowledge_ids: ['k_new'] });

    const chosen = await pick({ knowledgeId: 'k_new', lastReviewEventId: null });
    expect(chosen?.question_id).toBe('q_first');
    expect(chosen?.source).toBe('vision_paper');
    expect(chosen?.metadata).toEqual({ ingestion_session_id: 'sess_1' });
  });

  it('returns null when the knowledge point has no non-draft question', async () => {
    await seedQuestion('q_only_draft', {
      kind: 'short_answer',
      knowledge_ids: ['k_empty'],
      draft_status: 'draft',
    });
    const chosen = await pick({ knowledgeId: 'k_empty', lastReviewEventId: null });
    expect(chosen).toBeNull();
  });
});
