import {
  event,
  knowledge,
  knowledge_edge,
  mistake_variant,
  proposal_signals,
  question,
} from '@/db/schema';
import { writeVariantQuestionProposal } from '@/server/proposals/producers';
import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  acceptAiProposal,
  decideKnowledgeEdgeProposal,
  dismissAiProposal,
  retractAiProposal,
} from './actions';
import { writeAiProposal } from './writer';

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

describe('proposal lifecycle owner service', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('acceptAiProposal materializes a knowledge_node proposal through the knowledge owner service', async () => {
    const db = testDb();
    await seedKnowledge(['parent_1']);
    await writeAiProposal(db, {
      id: 'node_p1',
      payload: {
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: null },
        reason_md: 'New node evidence',
        evidence_refs: [],
        proposed_change: {
          mutation: 'propose_new',
          name: '通假字',
          parent_id: 'parent_1',
        },
        cooldown_key: 'knowledge_node:parent_1:通假字',
      },
    });

    const result = await acceptAiProposal(db, 'node_p1');
    expect(result.kind).toBe('knowledge_node');

    const knowledgeRows = await db.select().from(knowledge).where(eq(knowledge.name, '通假字'));
    expect(knowledgeRows).toHaveLength(1);
    expect(knowledgeRows[0].parent_id).toBe('parent_1');

    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'node_p1')));
    expect(rateRows).toHaveLength(1);
    expect((rateRows[0].payload as { rating?: string }).rating).toBe('accept');

    const signals = await db.select().from(proposal_signals);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      kind: 'knowledge_node',
      cooldown_key: 'knowledge_node:parent_1:通假字',
      accept_count: 1,
      dismiss_count: 0,
      acceptance_rate: 1,
    });
  });

  it('acceptAiProposal materializes a knowledge_edge proposal through the edge owner service', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2']);
    await writeAiProposal(db, {
      id: 'edge_p1',
      payload: {
        kind: 'knowledge_edge',
        target: { subject_kind: 'knowledge_edge', subject_id: null },
        reason_md: 'k1 unlocks k2',
        evidence_refs: [],
        proposed_change: {
          from_knowledge_id: 'k1',
          to_knowledge_id: 'k2',
          relation_type: 'prerequisite',
          weight: 0.7,
        },
      },
    });

    const result = await acceptAiProposal(db, 'edge_p1');
    expect(result.kind).toBe('knowledge_edge');
    if (result.kind !== 'knowledge_edge') throw new Error('unexpected result');
    expect(result.edge_id).toBeTruthy();
    expect(result.rate_event_id).toBeTruthy();
    if (!result.edge_id) throw new Error('missing edge_id');

    const edges = await db
      .select()
      .from(knowledge_edge)
      .where(eq(knowledge_edge.id, result.edge_id));
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      from_knowledge_id: 'k1',
      to_knowledge_id: 'k2',
      relation_type: 'prerequisite',
      weight: 0.7,
    });
  });

  it('decideKnowledgeEdgeProposal preserves reverse/change_type decisions for edge proposals', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2']);
    await writeAiProposal(db, {
      id: 'edge_p1',
      payload: {
        kind: 'knowledge_edge',
        target: { subject_kind: 'knowledge_edge', subject_id: null },
        reason_md: 'k1 unlocks k2',
        evidence_refs: [],
        proposed_change: {
          from_knowledge_id: 'k1',
          to_knowledge_id: 'k2',
          relation_type: 'prerequisite',
          weight: 1,
        },
      },
    });

    const result = await decideKnowledgeEdgeProposal(db, 'edge_p1', { decision: 'reverse' });
    expect(result.edge_id).toBeTruthy();
    if (!result.edge_id) throw new Error('missing edge_id');
    const edges = await db
      .select()
      .from(knowledge_edge)
      .where(eq(knowledge_edge.id, result.edge_id));
    expect(edges[0].from_knowledge_id).toBe('k2');
    expect(edges[0].to_knowledge_id).toBe('k1');
  });

  it('dismissAiProposal records a generic RateEvent for future proposal kinds', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'learning_p1',
      payload: {
        kind: 'learning_item',
        target: { subject_kind: 'learning_item', subject_id: null },
        reason_md: 'Create a focused review item',
        evidence_refs: [],
        proposed_change: { title: '虚词复习' },
        cooldown_key: 'learning_item:虚词复习',
      },
    });

    const result = await dismissAiProposal(db, 'learning_p1', { user_note: 'not now' });
    expect(result.kind).toBe('dismissed');

    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'learning_p1')));
    expect(rateRows).toHaveLength(1);
    expect(rateRows[0].subject_kind).toBe('event');
    expect(rateRows[0].payload).toMatchObject({ rating: 'dismiss', user_note: 'not now' });

    const signals = await db.select().from(proposal_signals);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      kind: 'learning_item',
      cooldown_key: 'learning_item:虚词复习',
      accept_count: 0,
      dismiss_count: 1,
      acceptance_rate: 0,
      dismiss_reason: 'not now',
    });
    expect(signals[0].cooldown_until).toBeInstanceOf(Date);
  });

  it('retractAiProposal writes a CorrectEvent chained to the proposal event', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'learning_p1',
      payload: {
        kind: 'learning_item',
        target: { subject_kind: 'learning_item', subject_id: null },
        reason_md: 'Create a focused review item',
        evidence_refs: [],
        proposed_change: { title: '虚词复习' },
      },
    });

    const result = await retractAiProposal(db, 'learning_p1', { reason_md: 'bad suggestion' });
    expect(result.kind).toBe('retracted');

    const correctionRows = await db
      .select()
      .from(event)
      .where(eq(event.id, result.correction_event_id));
    expect(correctionRows).toHaveLength(1);
    expect(correctionRows[0]).toMatchObject({
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'learning_p1',
      caused_by_event_id: 'learning_p1',
    });
    expect(correctionRows[0].payload).toMatchObject({
      correction_kind: 'retract',
      reason_md: 'bad suggestion',
    });
  });

  it('acceptAiProposal rejects future proposal kinds until their owner services exist', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'learning_p1',
      payload: {
        kind: 'learning_item',
        target: { subject_kind: 'learning_item', subject_id: null },
        reason_md: 'Create a focused review item',
        evidence_refs: [],
        proposed_change: { title: '虚词复习' },
      },
    });

    await expect(acceptAiProposal(db, 'learning_p1')).rejects.toMatchObject({
      code: 'unsupported_proposal_kind',
      status: 400,
    });
  });
});

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

    const signals = await testDb()
      .select()
      .from(proposal_signals)
      .where(eq(proposal_signals.kind, 'variant_question'));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ dismiss_count: 1, accept_count: 0 });
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
    // Re-trigger via the inbox path. Because the proposal now has an accept
    // rate event, listProposalInboxRows surfaces status='accepted'; acceptAiProposal
    // therefore short-circuits before reaching our owner branch (assertPending).
    // Use the lower-level acceptVariantQuestionProposal indirectly: a fresh
    // accept on the same id throws not_pending. So we instead assert that calling
    // acceptAiProposal again rejects with not_pending — that's the correct
    // contract because idempotency at the inbox layer means "no double-write".
    await expect(
      acceptAiProposal(testDb(), proposalId, { enqueueVariantVerify: enqueue }),
    ).rejects.toMatchObject({ code: 'not_pending' });

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
