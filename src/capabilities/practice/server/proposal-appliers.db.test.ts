// M4-T4 (YUK-319) — practice 包 proposal applier 测试，自
// src/server/proposals/actions.test.ts 原样迁入（variant_question lifecycle +
// question_draft accept 两个 describe 段）。入口仍走 dispatch 壳的
// acceptAiProposal/dismissAiProposal/retractAiProposal —— 搬迁不改行为，
// 测试继续从公共 API 进入以覆盖「壳路由 → 包 applier」整条链。

import { event, knowledge, mistake_variant, proposal_signals, question } from '@/db/schema';
import { acceptAiProposal, dismissAiProposal, retractAiProposal } from '@/server/proposals/actions';
import { writeVariantQuestionProposal } from '@/server/proposals/producers';
import { writeAiProposal } from '@/server/proposals/writer';
import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

const KNOWLEDGE_BASE = {
  domain: 'wenyan',
  parent_id: null,
  merged_from: [] as string[],
  proposed_by_ai: false,
  approval_status: 'approved' as const,
  version: 0,
};

async function seedKnowledge(ids: string[]): Promise<void> {
  const db = testDb();
  const now = new Date();
  for (const id of ids) {
    await db.insert(knowledge).values({
      id,
      name: id,
      archived_at: null,
      created_at: now,
      updated_at: now,
      ...KNOWLEDGE_BASE,
    });
  }
}

// YUK-17 / ADR-0018 — variant_question lifecycle integration.
describe('variant_question proposal lifecycle', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function seedParentQuestion(id: string): Promise<void> {
    const db = testDb();
    const now = new Date();
    await db.insert(question).values({
      id,
      kind: 'short_answer',
      prompt_md: '原题 prompt',
      reference_md: '原题 reference',
      knowledge_ids: ['k_xuci'],
      difficulty: 3,
      source: 'manual',
      variant_depth: 0,
      root_question_id: null,
      created_at: now,
      updated_at: now,
    });
  }

  async function seedVariantQuestionProposal(): Promise<{
    proposalId: string;
    mistakeVariantId: string;
  }> {
    const db = testDb();
    const proposalId = await writeVariantQuestionProposal(db, {
      source_question_id: 'q_parent',
      source_attempt_event_id: 'e_attempt',
      prompt_md: '变式 prompt',
      reference_md: '变式 reference',
      difficulty: 3,
      knowledge_ids: ['k_xuci'],
      parent_variant_id: 'q_parent',
      root_question_id: 'q_parent',
      variant_depth: 1,
      reason_md: '针对 concept cause 的变式',
    });
    const mvId = createId();
    const now = new Date();
    await db.insert(mistake_variant).values({
      id: mvId,
      parent_question_id: 'q_parent',
      variant_question_id: null,
      proposal_event_id: proposalId,
      status: 'draft',
      failure_reasons: [],
      cause_category: 'concept',
      created_at: now,
      updated_at: now,
    });
    return { proposalId, mistakeVariantId: mvId };
  }

  it('accept materializes question + flips mistake_variant to active + enqueues variant_verify', async () => {
    await seedParentQuestion('q_parent');
    const { proposalId, mistakeVariantId } = await seedVariantQuestionProposal();
    const enqueue = vi.fn(async () => {});

    const result = await acceptAiProposal(testDb(), proposalId, { enqueueVariantVerify: enqueue });
    expect(result.kind).toBe('variant_question');
    if (result.kind !== 'variant_question') throw new Error('unexpected result kind');
    expect(result.mistake_variant_id).toBe(mistakeVariantId);

    const newQs = await testDb().select().from(question).where(eq(question.id, result.question_id));
    expect(newQs).toHaveLength(1);
    expect(newQs[0]).toMatchObject({
      source: 'mistake_variant',
      draft_status: 'active',
      variant_depth: 1,
      parent_variant_id: 'q_parent',
      root_question_id: 'q_parent',
      knowledge_ids: ['k_xuci'],
      difficulty: 3,
    });

    const mvRows = await testDb()
      .select()
      .from(mistake_variant)
      .where(eq(mistake_variant.id, mistakeVariantId));
    expect(mvRows[0]).toMatchObject({
      status: 'active',
      variant_question_id: result.question_id,
    });

    const rateRows = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)));
    expect(rateRows).toHaveLength(1);
    expect(rateRows[0].payload).toMatchObject({
      rating: 'accept',
      materialized_question_id: result.question_id,
      mistake_variant_id: mistakeVariantId,
    });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(mistakeVariantId);
  });

  // P5.6 / YUK-178 (AC-1 + AC-6) — variant_question is hard-corrective. Accepting
  // it still writes the rate event AND materializes the variant question identically
  // (side-effects unchanged, ND-SK-2), but the accept is EXCLUDED from the KPI:
  // proposal_signals.accept_count is NOT bumped (no row for the key).
  it('accept of a (corrective) variant_question writes the rate event + materializes, but does NOT bump accept_count', async () => {
    await seedParentQuestion('q_parent');
    const { proposalId } = await seedVariantQuestionProposal();
    const enqueue = vi.fn(async () => {});

    const result = await acceptAiProposal(testDb(), proposalId, { enqueueVariantVerify: enqueue });
    expect(result.kind).toBe('variant_question');
    if (result.kind !== 'variant_question') throw new Error('unexpected result kind');

    // Side-effect: the variant question IS materialized (identical to any accept).
    const newQs = await testDb().select().from(question).where(eq(question.id, result.question_id));
    expect(newQs).toHaveLength(1);

    // The rate event IS written (ND-SK-3 — corrective is still a full event).
    const rateRows = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)));
    expect(rateRows).toHaveLength(1);
    expect(rateRows[0].payload).toMatchObject({ rating: 'accept' });

    // But the KPI signal is gated: no accept_count bump (the accept-family corrective
    // gate early-returns before any proposal_signals write, §5.1).
    const signals = await testDb()
      .select()
      .from(proposal_signals)
      .where(eq(proposal_signals.kind, 'variant_question'));
    expect(signals).toHaveLength(0);
  });

  it('dismiss flips mistake_variant row to dismissed and writes rate event', async () => {
    await seedParentQuestion('q_parent');
    const { proposalId, mistakeVariantId } = await seedVariantQuestionProposal();

    const result = await dismissAiProposal(testDb(), proposalId, { user_note: 'not useful' });
    expect(result.kind).toBe('dismissed');

    const mvRows = await testDb()
      .select()
      .from(mistake_variant)
      .where(eq(mistake_variant.id, mistakeVariantId));
    expect(mvRows[0].status).toBe('dismissed');

    const rateRows = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)));
    expect(rateRows).toHaveLength(1);
    expect(rateRows[0].payload).toMatchObject({ rating: 'dismiss', user_note: 'not useful' });

    // P5.6 / YUK-178 (AC-1b) — variant_question is hard-corrective, so a dismiss is
    // EXCLUDED from the KPI: dismiss_count stays 0 (the denominator is not
    // distorted). But the row IS written and the cooldown IS persisted (re-surfacing
    // suppression is independent of KPI counting). The `rate` event above still
    // records the dismiss (ND-SK-3).
    const signals = await testDb()
      .select()
      .from(proposal_signals)
      .where(eq(proposal_signals.kind, 'variant_question'));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ dismiss_count: 0, accept_count: 0 });
    expect(signals[0].cooldown_until).toBeInstanceOf(Date);
  });

  it('retract after accept flips mistake_variant row from active to dismissed', async () => {
    await seedParentQuestion('q_parent');
    const { proposalId, mistakeVariantId } = await seedVariantQuestionProposal();

    await acceptAiProposal(testDb(), proposalId, {
      enqueueVariantVerify: async () => {},
    });

    const retracted = await retractAiProposal(testDb(), proposalId, { reason_md: 'misalignment' });
    expect(retracted.kind).toBe('retracted');

    const mvRows = await testDb()
      .select()
      .from(mistake_variant)
      .where(eq(mistake_variant.id, mistakeVariantId));
    expect(mvRows[0].status).toBe('dismissed');
  });

  it('accept idempotent: second accept returns the same materialized id without duplicating', async () => {
    await seedParentQuestion('q_parent');
    const { proposalId, mistakeVariantId } = await seedVariantQuestionProposal();
    const enqueue = vi.fn(async () => {});

    const first = await acceptAiProposal(testDb(), proposalId, { enqueueVariantVerify: enqueue });
    if (first.kind !== 'variant_question') throw new Error('unexpected');
    const second = await acceptAiProposal(testDb(), proposalId, { enqueueVariantVerify: enqueue });
    expect(second).toMatchObject({
      kind: 'variant_question',
      idempotent: true,
      question_id: first.question_id,
      mistake_variant_id: mistakeVariantId,
    });

    const questions = await testDb()
      .select()
      .from(question)
      .where(eq(question.id, first.question_id));
    expect(questions).toHaveLength(1);
    const mvRows = await testDb()
      .select()
      .from(mistake_variant)
      .where(eq(mistake_variant.id, mistakeVariantId));
    expect(mvRows[0]).toMatchObject({ status: 'active', variant_question_id: first.question_id });
  });

  it('accept fails fast when mistake_variant draft row is missing', async () => {
    await seedParentQuestion('q_parent');
    const db = testDb();
    const proposalId = await writeVariantQuestionProposal(db, {
      source_question_id: 'q_parent',
      source_attempt_event_id: 'e_attempt',
      prompt_md: '变式 prompt',
      reference_md: '变式 reference',
      difficulty: 3,
      knowledge_ids: ['k_xuci'],
      parent_variant_id: 'q_parent',
      root_question_id: 'q_parent',
      variant_depth: 1,
      reason_md: 'reason',
    });
    // No mistake_variant row inserted.
    await expect(
      acceptAiProposal(db, proposalId, { enqueueVariantVerify: async () => {} }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

// ADR-0031 / YUK-304 (lane B) — question_draft accept: promote draft→active +
// FSRS enroll-if-absent + rate event, idempotent on caused_by_event_id.
describe('question_draft accept (ADR-0031 lane B)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function seedDraftQuestion(opts: { knowledgeIds?: string[]; id?: string } = {}) {
    const db = testDb();
    const id = opts.id ?? 'q_draft_1';
    const knowledgeIds = opts.knowledgeIds ?? ['k_draft'];
    if (knowledgeIds.length > 0) await seedKnowledge(knowledgeIds);
    const now = new Date();
    await db.insert(question).values({
      id,
      kind: 'short_answer',
      prompt_md: '解释「之」的用法。',
      reference_md: '代词。',
      knowledge_ids: knowledgeIds,
      difficulty: 3,
      source: 'copilot_authored',
      draft_status: 'draft',
      created_at: now,
      updated_at: now,
    });
    return id;
  }

  async function seedQuestionDraftProposal(proposalId: string, questionId: string) {
    await writeAiProposal(testDb(), {
      id: proposalId,
      actor_ref: 'agent:copilot',
      payload: {
        kind: 'question_draft',
        target: { subject_kind: 'question', subject_id: questionId },
        reason_md: 'copilot 拟题（seed=knowledge）',
        evidence_refs: [],
        proposed_change: {
          question_id: questionId,
          kind: 'short_answer',
          difficulty: 3,
          knowledge_ids: ['k_draft'],
          seed_mode: 'knowledge',
        },
      },
    });
  }

  it('fresh accept promotes draft→active, FSRS-enrolls each knowledge id, writes the rate event', async () => {
    const db = testDb();
    const questionId = await seedDraftQuestion();
    await seedQuestionDraftProposal('qd_p1', questionId);

    const result = await acceptAiProposal(db, 'qd_p1', { user_note: 'ok' });
    expect(result.kind).toBe('question_draft');
    if (result.kind !== 'question_draft') throw new Error('unreachable');
    expect(result.question_id).toBe(questionId);
    expect(result.idempotent).toBeUndefined();

    const [row] = await db.select().from(question).where(eq(question.id, questionId));
    expect(row.draft_status).toBe('active');

    // Per-knowledge FSRS card materialized (enroll-if-absent).
    const { getFsrsState } = await import('@/server/fsrs/state');
    const state = await getFsrsState(db, 'knowledge', 'k_draft');
    expect(state).toBeTruthy();
    expect(state?.last_review_event_id).toBe(result.rate_event_id);

    // Rate event chained to the proposal.
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'qd_p1')));
    expect(rateRows).toHaveLength(1);
    expect(
      (rateRows[0].payload as { materialized_question_id?: string }).materialized_question_id,
    ).toBe(questionId);
  });

  it('does NOT reset FSRS for an already-enrolled knowledge node', async () => {
    const db = testDb();
    const questionId = await seedDraftQuestion();
    await seedQuestionDraftProposal('qd_p2', questionId);

    const { getFsrsState, upsertFsrsState } = await import('@/server/fsrs/state');
    const { initialFsrsState } = await import('@/capabilities/practice/server/fsrs');
    const preexisting = initialFsrsState(new Date('2026-01-01T00:00:00.000Z'));
    await upsertFsrsState(db, {
      subject_kind: 'knowledge',
      subject_id: 'k_draft',
      state: preexisting.state,
      due_at: preexisting.dueAt,
      last_review_event_id: 'ev_prior_review',
    });

    await acceptAiProposal(db, 'qd_p2');
    const after = await getFsrsState(db, 'knowledge', 'k_draft');
    // Untouched: the prior schedule (incl. its review anchor) survives.
    expect(after?.last_review_event_id).toBe('ev_prior_review');
  });

  it('falls back to question-level FSRS when the row has no knowledge_ids', async () => {
    const db = testDb();
    const questionId = await seedDraftQuestion({ knowledgeIds: [], id: 'q_draft_nolabel' });
    await seedQuestionDraftProposal('qd_p3', questionId);

    await acceptAiProposal(db, 'qd_p3');
    const { getFsrsState } = await import('@/server/fsrs/state');
    expect(await getFsrsState(db, 'question', questionId)).toBeTruthy();
  });

  it('double-accept is idempotent (no second rate event, no FSRS churn)', async () => {
    const db = testDb();
    const questionId = await seedDraftQuestion();
    await seedQuestionDraftProposal('qd_p4', questionId);

    const first = await acceptAiProposal(db, 'qd_p4');
    const again = await acceptAiProposal(db, 'qd_p4');
    expect(again.kind).toBe('question_draft');
    if (again.kind !== 'question_draft' || first.kind !== 'question_draft') {
      throw new Error('unreachable');
    }
    expect(again.idempotent).toBe(true);
    expect(again.rate_event_id).toBe(first.rate_event_id);

    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'qd_p4')));
    expect(rateRows).toHaveLength(1);
  });

  it('dismiss-then-accept 409s and the draft stays inert', async () => {
    const db = testDb();
    const questionId = await seedDraftQuestion();
    await seedQuestionDraftProposal('qd_p5', questionId);

    const dismissed = await dismissAiProposal(db, 'qd_p5');
    expect(dismissed.kind).toBe('dismissed');
    await expect(acceptAiProposal(db, 'qd_p5')).rejects.toMatchObject({ status: 409 });

    const [row] = await db.select().from(question).where(eq(question.id, questionId));
    // The dismissed draft stays draft (never pooled / FSRS'd).
    expect(row.draft_status).toBe('draft');
    const { getFsrsState } = await import('@/server/fsrs/state');
    expect(await getFsrsState(db, 'knowledge', 'k_draft')).toBeNull();
  });

  it('404s on a missing question row and 409s on a non-draft row', async () => {
    const db = testDb();
    await seedKnowledge(['k_draft']);
    await seedQuestionDraftProposal('qd_p6', 'q_gone');
    await expect(acceptAiProposal(db, 'qd_p6')).rejects.toMatchObject({ status: 404 });

    const questionId = await seedDraftQuestion({ id: 'q_already_active', knowledgeIds: [] });
    await testDb()
      .update(question)
      .set({ draft_status: 'active' })
      .where(eq(question.id, questionId));
    await seedQuestionDraftProposal('qd_p7', questionId);
    await expect(acceptAiProposal(db, 'qd_p7')).rejects.toMatchObject({ status: 409 });
  });
});
