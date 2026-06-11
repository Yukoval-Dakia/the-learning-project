import { writeKnowledgeProposeEvent } from '@/capabilities/knowledge/server/proposals';
import { deriveSourceTier } from '@/core/schema/provenance';
import {
  ai_task_runs,
  artifact,
  completion_evidence,
  cost_ledger,
  event,
  knowledge,
  knowledge_edge,
  learning_item,
  learning_record,
  mistake_variant,
  proposal_signals,
  question,
  question_block,
  source_asset,
} from '@/db/schema';
import { planLearningIntent } from '@/server/orchestrator/learning_intent';
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
import type { ImageCandidateAcceptDeps } from './image-candidate-accept';
import { writeAiProposal } from './writer';

const KNOWLEDGE_BASE = {
  domain: 'wenyan',
  parent_id: null,
  merged_from: [] as string[],
  proposed_by_ai: false,
  approval_status: 'approved' as const,
  version: 0,
};

function paragraphBlock(id: string, text: string) {
  return {
    type: 'paragraph',
    attrs: { id },
    content: [{ type: 'text', text }],
  };
}

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

  it('acceptAiProposal applies a note_update patch proposal and writes a rate event', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(artifact).values({
      id: 'artifact_note',
      type: 'note_atomic',
      title: '之的用法',
      parent_artifact_id: null,
      knowledge_ids: [],
      intent_source: 'learning_intent',
      source: 'ai_generated',
      source_ref: null,
      body_blocks: {
        type: 'doc',
        content: [paragraphBlock('b1', '原文')],
      } as never,
      attrs: {} as never,
      tool_kind: null,
      tool_state: null,
      generation_status: 'ready',
      verification_status: 'verified',
      verification_summary: null,
      generated_by: { by: 'ai', task_kind: 'NoteGenerateTask' } as never,
      verified_by: null,
      history: [],
      archived_at: null,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await writeAiProposal(db, {
      id: 'note_update_p1',
      payload: {
        kind: 'note_update',
        target: { subject_kind: 'artifact', subject_id: 'artifact_note' },
        reason_md: 'Living Note patch',
        evidence_refs: [{ kind: 'artifact', id: 'artifact_note' }],
        proposed_change: {
          artifact_id: 'artifact_note',
          source: 'note_refine',
          patch: {
            ops: [{ kind: 'append_block', block: paragraphBlock('b2', '新增') }],
          },
          summary: { ops_count: 1, new_blocks: 1 },
        },
      },
    });

    const result = await acceptAiProposal(db, 'note_update_p1');

    expect(result).toMatchObject({ kind: 'note_update', artifact_id: 'artifact_note' });
    const [updated] = await db.select().from(artifact).where(eq(artifact.id, 'artifact_note'));
    expect(updated.version).toBe(1);
    expect(
      (
        updated.body_blocks as {
          content: Array<{ attrs?: { id?: string } }>;
        }
      ).content.some((node) => node.attrs?.id === 'b2'),
    ).toBe(true);
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'note_update_p1')));
    expect(rateRows).toHaveLength(1);
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

  it('decideKnowledgeEdgeProposal treats generic rate events as idempotent decisions', async () => {
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
    await db.insert(event).values({
      id: 'rate_edge_p1',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: 'edge_p1',
      outcome: 'success',
      payload: { rating: 'accept' },
      caused_by_event_id: 'edge_p1',
      created_at: new Date(),
    });
    await db.insert(event).values({
      id: 'gen_edge_p1',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'generate',
      subject_kind: 'knowledge_edge',
      subject_id: 'edge_existing',
      outcome: 'success',
      payload: { propose_event_id: 'edge_p1' },
      caused_by_event_id: 'edge_p1',
      created_at: new Date(),
    });

    const result = await decideKnowledgeEdgeProposal(db, 'edge_p1', { decision: 'accept' });

    expect(result).toMatchObject({
      rate_event_id: 'rate_edge_p1',
      generate_event_id: 'gen_edge_p1',
      edge_id: 'edge_existing',
      idempotent: true,
    });
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'edge_p1')));
    expect(rateRows).toHaveLength(1);
  });

  // P5.4 / YUK-143 (RB-8) — codex re-review FIX 3 (bypass). A folded
  // `rubric_rejected` edge proposal (carrying `rubric_verdict: { ok:false }` and
  // no chained rate) was decidable by id via decideKnowledgeEdgeProposal: the
  // code slipped past the existing-rate idempotency guard and wrote the rate +
  // knowledge_edge anyway, bypassing the rubric. The folded bucket must be
  // truly non-executable.
  it('decideKnowledgeEdgeProposal rejects a rubric_rejected proposal by id and inserts NOTHING', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2']);
    // Write the propose event the way the Layer-1 fold does: a normal
    // knowledge_edge propose event with a `rubric_verdict: { ok:false }` marker
    // alongside `ai_proposal`, and NO chained rate.
    await writeAiProposal(db, {
      id: 'edge_rejected',
      payload: {
        kind: 'knowledge_edge',
        target: { subject_kind: 'knowledge_edge', subject_id: null },
        reason_md: '二者相关', // generic — the kind of reason the rubric folds
        evidence_refs: [],
        proposed_change: {
          from_knowledge_id: 'k1',
          to_knowledge_id: 'k2',
          relation_type: 'related_to',
          weight: 1,
        },
      },
      event_override: {
        action: 'propose',
        subject_kind: 'knowledge_edge',
        payload: {
          from_knowledge_id: 'k1',
          to_knowledge_id: 'k2',
          relation_type: 'related_to',
          weight: 1,
          reasoning: '二者相关',
          rubric_verdict: { ok: false, gate: 'reasoning_generic', reason: 'generic reasoning' },
        },
      },
    });

    await expect(
      decideKnowledgeEdgeProposal(db, 'edge_rejected', { decision: 'accept' }),
    ).rejects.toMatchObject({ code: 'not_pending', status: 409 });

    // The bypass is closed: NO knowledge_edge row, NO rate event written.
    const edges = await db
      .select()
      .from(knowledge_edge)
      .where(eq(knowledge_edge.from_knowledge_id, 'k1'));
    expect(edges).toHaveLength(0);
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'edge_rejected')));
    expect(rateRows).toHaveLength(0);

    // reverse / change_type are blocked the same way (no executable decision).
    await expect(
      decideKnowledgeEdgeProposal(db, 'edge_rejected', { decision: 'reverse' }),
    ).rejects.toMatchObject({ code: 'not_pending', status: 409 });
  });

  it('decideKnowledgeEdgeProposal still accepts a genuinely pending edge proposal', async () => {
    const db = testDb();
    await seedKnowledge(['k1', 'k2']);
    await writeAiProposal(db, {
      id: 'edge_pending',
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

    const result = await decideKnowledgeEdgeProposal(db, 'edge_pending', { decision: 'accept' });
    expect(result.edge_id).toBeTruthy();
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
    });
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

  it('dismiss retry backfills a missing signal after the rate event already exists', async () => {
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
    await db.insert(event).values({
      id: createId(),
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'rate',
      subject_kind: 'event',
      subject_id: 'learning_p1',
      outcome: 'success',
      payload: { rating: 'dismiss', user_note: 'first try' },
      caused_by_event_id: 'learning_p1',
      created_at: new Date(),
    });

    const result = await dismissAiProposal(db, 'learning_p1');
    expect(result).toMatchObject({ kind: 'dismissed', idempotent: true });

    const signals = await db.select().from(proposal_signals);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      kind: 'learning_item',
      cooldown_key: 'learning_item:虚词复习',
      dismiss_count: 1,
      accept_count: 0,
    });
  });

  it('acceptAiProposal materializes a knowledge_mutation proposal through the knowledge owner service', async () => {
    const db = testDb();
    await seedKnowledge(['k_parent', 'k_child', 'k_new_parent']);
    const proposalId = await writeKnowledgeProposeEvent(db, {
      payload: {
        mutation: 'reparent',
        node_id: 'k_child',
        new_parent_id: 'k_new_parent',
        expected_version: 0,
      },
      reasoning: 'Move under the more precise parent.',
    });

    const result = await acceptAiProposal(db, proposalId);

    expect(result.kind).toBe('knowledge_mutation');
    const child = (
      await db.select().from(knowledge).where(eq(knowledge.id, 'k_child')).limit(1)
    )[0];
    expect(child.parent_id).toBe('k_new_parent');
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)));
    expect(rateRows).toHaveLength(1);
    expect(rateRows[0].payload).toMatchObject({ rating: 'accept' });
  });

  it('acceptAiProposal completes a LearningItem proposal with ai_propose evidence', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(learning_item).values({
      id: 'li_complete',
      source: 'manual',
      title: '完成候选',
      content: 'content',
      knowledge_ids: [],
      status: 'in_progress',
      created_at: now,
      updated_at: now,
    });
    await writeAiProposal(db, {
      id: 'completion_p1',
      payload: {
        kind: 'completion',
        target: { subject_kind: 'learning_item', subject_id: 'li_complete' },
        reason_md: 'item appears mastered',
        evidence_refs: [],
        proposed_change: {
          learning_item_id: 'li_complete',
          triggering_signals: ['check_all_passed'],
          evidence_json: { check_event_id: 'ev_check' },
        },
        cooldown_key: 'completion:li_complete',
      },
    });

    const result = await acceptAiProposal(db, 'completion_p1');

    expect(result).toMatchObject({ kind: 'completion', learning_item_id: 'li_complete' });
    const item = (
      await db.select().from(learning_item).where(eq(learning_item.id, 'li_complete')).limit(1)
    )[0];
    expect(item.status).toBe('done');
    expect(item.completed_at).toBeInstanceOf(Date);
    expect(item.version).toBe(1);
    const evidenceRows = await db
      .select()
      .from(completion_evidence)
      .where(eq(completion_evidence.learning_item_id, 'li_complete'));
    expect(evidenceRows).toHaveLength(1);
    expect(evidenceRows[0].path).toBe('ai_propose');
    expect(evidenceRows[0].evidence_json).toMatchObject({
      proposal_id: 'completion_p1',
      triggering_signals: ['check_all_passed'],
      check_event_id: 'ev_check',
    });

    const signals = await db.select().from(proposal_signals);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      kind: 'completion',
      cooldown_key: 'completion:li_complete',
      accept_count: 1,
      dismiss_count: 0,
    });
  });

  it('acceptAiProposal moves a relearn proposal back to in_progress', async () => {
    const db = testDb();
    const completedAt = new Date('2026-05-20T00:00:00.000Z');
    await db.insert(learning_item).values({
      id: 'li_relearn',
      source: 'manual',
      title: '复学候选',
      content: 'content',
      knowledge_ids: [],
      status: 'done',
      completed_at: completedAt,
      created_at: completedAt,
      updated_at: completedAt,
    });
    await writeAiProposal(db, {
      id: 'relearn_p1',
      payload: {
        kind: 'relearn',
        target: { subject_kind: 'learning_item', subject_id: 'li_relearn' },
        reason_md: 'mastery decayed',
        evidence_refs: [],
        proposed_change: {
          learning_item_id: 'li_relearn',
          current_mastery: 0.3,
          peak_mastery: 0.9,
          days_since_done: 8,
        },
        cooldown_key: 'relearn:li_relearn',
      },
    });

    const result = await acceptAiProposal(db, 'relearn_p1');

    expect(result).toMatchObject({ kind: 'relearn', learning_item_id: 'li_relearn' });
    const item = (
      await db.select().from(learning_item).where(eq(learning_item.id, 'li_relearn')).limit(1)
    )[0];
    expect(item.status).toBe('in_progress');
    expect(item.completed_at).toBeNull();
    expect(item.version).toBe(1);
  });

  it('acceptAiProposal applies record_links by linking scalar record refs and metadata', async () => {
    const db = testDb();
    const now = new Date();
    await seedKnowledge(['k1']);
    await db.insert(question).values({
      id: 'q1',
      kind: 'short_answer',
      prompt_md: 'prompt',
      reference_md: 'ref',
      knowledge_ids: ['k1'],
      source: 'manual',
      difficulty: 3,
      created_at: now,
      updated_at: now,
    });
    await db.insert(learning_item).values({
      id: 'li1',
      source: 'manual',
      title: 'item',
      content: 'content',
      knowledge_ids: ['k1'],
      status: 'pending',
      created_at: now,
      updated_at: now,
    });
    await db.insert(artifact).values({
      id: 'art1',
      type: 'note_long',
      title: 'note',
      knowledge_ids: ['k1'],
      intent_source: 'declared',
      source: 'manual',
      generation_status: 'ready',
      created_at: now,
      updated_at: now,
    });
    await db.insert(learning_record).values({
      id: 'rec1',
      kind: 'open_question',
      title: 'record',
      content_md: 'content',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'ask',
      processing_status: 'raw',
      knowledge_ids: [],
      payload: {},
      created_at: now,
      updated_at: now,
    });
    await writeAiProposal(db, {
      id: 'record_links_p1',
      payload: {
        kind: 'record_links',
        target: { subject_kind: 'record', subject_id: 'rec1' },
        reason_md: 'link record',
        evidence_refs: [{ kind: 'record', id: 'rec1' }],
        proposed_change: {
          record_id: 'rec1',
          links: [
            { target_kind: 'knowledge', target_id: 'k1', relation: 'about', confidence: 0.8 },
            { target_kind: 'question', target_id: 'q1', relation: 'follow_up', confidence: 0.7 },
            {
              target_kind: 'learning_item',
              target_id: 'li1',
              relation: 'evidence_for',
              confidence: 0.7,
            },
            { target_kind: 'artifact', target_id: 'art1', relation: 'source_for', confidence: 0.7 },
          ],
        },
        cooldown_key: 'record_links:rec1:k1',
      },
    });

    const result = await acceptAiProposal(db, 'record_links_p1');

    expect(result).toMatchObject({ kind: 'record_links', record_id: 'rec1' });
    const record = (
      await db.select().from(learning_record).where(eq(learning_record.id, 'rec1')).limit(1)
    )[0];
    expect(record.processing_status).toBe('actioned');
    expect(record.knowledge_ids).toEqual(['k1']);
    expect(record.question_id).toBe('q1');
    expect(record.learning_item_id).toBe('li1');
    expect(record.artifact_id).toBe('art1');
    expect(record.payload).toMatchObject({
      accepted_record_links: expect.arrayContaining([
        expect.objectContaining({ target_kind: 'knowledge', target_id: 'k1' }),
      ]),
    });
  });

  it('acceptAiProposal materializes record_promotion into a LearningItem draft', async () => {
    const db = testDb();
    const now = new Date();
    await seedKnowledge(['k1']);
    await db.insert(learning_record).values({
      id: 'rec_promote',
      kind: 'open_question',
      title: 'record title',
      content_md: 'record content',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'ask',
      processing_status: 'raw',
      knowledge_ids: ['k1'],
      payload: {},
      created_at: now,
      updated_at: now,
    });
    await writeAiProposal(db, {
      id: 'record_promotion_p1',
      payload: {
        kind: 'record_promotion',
        target: { subject_kind: 'record', subject_id: 'rec_promote' },
        reason_md: 'turn into item',
        evidence_refs: [{ kind: 'record', id: 'rec_promote' }],
        proposed_change: {
          record_id: 'rec_promote',
          target: 'learning_item',
          draft: { title: 'AI 学习项', content: 'AI 内容', knowledge_ids: ['k1'] },
        },
        cooldown_key: 'record_promotion:rec_promote:learning_item',
      },
    });

    const result = await acceptAiProposal(db, 'record_promotion_p1');

    expect(result).toMatchObject({ kind: 'record_promotion', record_id: 'rec_promote' });
    if (result.kind !== 'record_promotion') throw new Error('expected record_promotion result');
    const item = (
      await db
        .select()
        .from(learning_item)
        .where(eq(learning_item.id, result.materialized_id))
        .limit(1)
    )[0];
    expect(item).toMatchObject({
      source: 'ai_dream',
      source_ref: 'record_promotion_p1',
      title: 'AI 学习项',
      content: 'AI 内容',
      knowledge_ids: ['k1'],
      status: 'pending',
    });
    const record = (
      await db.select().from(learning_record).where(eq(learning_record.id, 'rec_promote')).limit(1)
    )[0];
    expect(record.learning_item_id).toBe(result.materialized_id);
    expect(record.processing_status).toBe('actioned');
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
});

// YUK-19 — learning_item lifecycle integration.
//
// learning_item proposals are produced by planLearningIntent (the
// "我想学 X" flow). Acceptance materializes 1 hub + N atomic learning_items
// plus paired note artifact stubs through the existing acceptLearningIntent
// owner service. Retract after accept tombstones the materialized rows so
// the L3 correction outweighs any downstream evidence.
describe('learning_item proposal lifecycle', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function seedLearningItemProposal(opts: { withLong?: boolean } = {}): Promise<{
    proposalId: string;
  }> {
    const db = testDb();
    // Seed wenyan topic graph: hub `k_hub_xc` 虚词 + two children for atomic outline.
    await db.insert(knowledge).values([
      {
        id: 'k_hub_xc',
        name: '虚词',
        domain: 'wenyan',
        parent_id: null,
        merged_from: [],
        proposed_by_ai: false,
        approval_status: 'approved',
        created_at: new Date(),
        updated_at: new Date(),
        version: 0,
      },
      {
        id: 'k_zhi_xc',
        name: '之',
        domain: 'wenyan',
        parent_id: 'k_hub_xc',
        merged_from: [],
        proposed_by_ai: false,
        approval_status: 'approved',
        created_at: new Date(),
        updated_at: new Date(),
        version: 0,
      },
      {
        id: 'k_qi_xc',
        name: '其',
        domain: 'wenyan',
        parent_id: 'k_hub_xc',
        merged_from: [],
        proposed_by_ai: false,
        approval_status: 'approved',
        created_at: new Date(),
        updated_at: new Date(),
        version: 0,
      },
    ]);

    const runTaskFn = vi.fn(async () => ({
      text: JSON.stringify({
        hub: { title: '虚词总览', summary_md: '虚词概览。' },
        atomics: [
          { knowledge_id: 'k_zhi_xc', title: '之', one_line_intent: '区分「之」用法' },
          { knowledge_id: 'k_qi_xc', title: '其', one_line_intent: '区分「其」用法' },
        ],
        longs: opts.withLong
          ? [
              {
                knowledge_ids: ['k_zhi_xc', 'k_qi_xc'],
                title: '之其综合',
                one_line_intent: '能在同一段文言翻译里区分「之」「其」。',
              },
            ]
          : [],
      }),
    }));
    const proposal = await planLearningIntent({ db, topic: '虚词', runTaskFn });
    return { proposalId: proposal.proposal_id };
  }

  it('accept materializes 1 hub + N atomic learning_items via acceptLearningIntent and records a single rate event', async () => {
    const { proposalId } = await seedLearningItemProposal();
    const result = await acceptAiProposal(testDb(), proposalId);
    expect(result.kind).toBe('learning_item');
    if (result.kind !== 'learning_item') throw new Error('unexpected result kind');
    expect(result.hub_learning_item_id).toBeTruthy();
    expect(result.atomic_learning_item_ids).toHaveLength(2);
    expect(result.long_learning_item_ids).toEqual([]);
    expect(result.hub_artifact_id).toBeTruthy();
    expect(result.atomic_artifact_ids).toHaveLength(2);
    expect(result.long_artifact_ids).toEqual([]);

    const lis = await testDb()
      .select()
      .from(learning_item)
      .where(eq(learning_item.source_ref, proposalId));
    expect(lis).toHaveLength(3);
    const hub = lis.find((row) => row.id === result.hub_learning_item_id);
    expect(hub?.parent_learning_item_id).toBeNull();
    expect(hub?.source).toBe('learning_intent');
    expect(hub?.archived_at).toBeNull();
    const atomics = lis.filter((row) => row.id !== result.hub_learning_item_id);
    for (const atomic of atomics) {
      expect(atomic.parent_learning_item_id).toBe(result.hub_learning_item_id);
      expect(atomic.archived_at).toBeNull();
    }

    // acceptLearningIntent owns rate-event writing inside its own transaction;
    // acceptAiProposal must NOT write a second rate event.
    const rateRows = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)));
    expect(rateRows).toHaveLength(1);
    expect(rateRows[0].payload).toMatchObject({ rating: 'accept' });

    // Signal still records (cooldown / acceptance-rate stay in sync with other kinds).
    const signals = await testDb()
      .select()
      .from(proposal_signals)
      .where(eq(proposal_signals.kind, 'learning_item'));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ accept_count: 1, dismiss_count: 0 });
  });

  it('accept returns long note materialization ids for learning_item proposals', async () => {
    const { proposalId } = await seedLearningItemProposal({ withLong: true });
    const result = await acceptAiProposal(testDb(), proposalId);
    expect(result.kind).toBe('learning_item');
    if (result.kind !== 'learning_item') throw new Error('unexpected result kind');

    expect(result.atomic_artifact_ids).toHaveLength(2);
    expect(result.long_learning_item_ids).toHaveLength(1);
    expect(result.long_artifact_ids).toHaveLength(1);

    const second = await acceptAiProposal(testDb(), proposalId);
    expect(second).toMatchObject({
      kind: 'learning_item',
      idempotent: true,
      long_learning_item_ids: result.long_learning_item_ids,
      long_artifact_ids: result.long_artifact_ids,
    });
  });

  it('dismiss writes a generic rate event without materializing learning_items', async () => {
    const { proposalId } = await seedLearningItemProposal();
    const result = await dismissAiProposal(testDb(), proposalId, { user_note: 'changed mind' });
    expect(result.kind).toBe('dismissed');

    const lis = await testDb()
      .select()
      .from(learning_item)
      .where(eq(learning_item.source_ref, proposalId));
    expect(lis).toHaveLength(0);

    const rateRows = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, proposalId)));
    expect(rateRows).toHaveLength(1);
    expect(rateRows[0].payload).toMatchObject({ rating: 'dismiss', user_note: 'changed mind' });

    const signals = await testDb()
      .select()
      .from(proposal_signals)
      .where(eq(proposal_signals.kind, 'learning_item'));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ dismiss_count: 1, accept_count: 0 });
  });

  it('retract before accept writes only the correction event; nothing to tombstone', async () => {
    const { proposalId } = await seedLearningItemProposal();
    const result = await retractAiProposal(testDb(), proposalId, { reason_md: 'noise' });
    expect(result.kind).toBe('retracted');

    const lis = await testDb()
      .select()
      .from(learning_item)
      .where(eq(learning_item.source_ref, proposalId));
    expect(lis).toHaveLength(0);
  });

  it('retract after accept tombstones hub + atomic + long learning_items and all proposal-sourced artifacts', async () => {
    const { proposalId } = await seedLearningItemProposal({ withLong: true });
    const accepted = await acceptAiProposal(testDb(), proposalId);
    if (accepted.kind !== 'learning_item') throw new Error('expected learning_item accept');
    const sourceAtomicArtifactId = accepted.atomic_artifact_ids[0];
    if (!sourceAtomicArtifactId) throw new Error('expected atomic artifact id');
    const quizArtifactId = 'quiz_retract_1';
    const now = new Date();
    await testDb()
      .insert(artifact)
      .values({
        id: quizArtifactId,
        type: 'tool_quiz',
        title: '之的用法 自检',
        parent_artifact_id: null,
        knowledge_ids: ['k_zhi_xc'],
        intent_source: 'embedded_check',
        source: 'ai_generated',
        source_ref: proposalId,
        body_blocks: null,
        attrs: {
          embedded_for_artifact_id: sourceAtomicArtifactId,
          check_block_id: 's_check',
        } as never,
        tool_kind: 'embedded_check',
        tool_state: {
          question_ids: [],
          session_meta: {
            source_artifact_id: sourceAtomicArtifactId,
            check_block_id: 's_check',
          },
        } as never,
        generation_status: 'ready',
        verification_status: 'not_required',
        generated_by: null,
        history: [],
        created_at: now,
        updated_at: now,
        version: 0,
      });

    const retracted = await retractAiProposal(testDb(), proposalId, { reason_md: 'rewrite' });
    expect(retracted.kind).toBe('retracted');

    const liRows = await testDb()
      .select()
      .from(learning_item)
      .where(eq(learning_item.source_ref, proposalId));
    expect(liRows).toHaveLength(4);
    for (const li of liRows) {
      expect(li.archived_at).not.toBeNull();
      expect(li.archived_reason).toBe('proposal_retracted');
    }

    const artifactIds = [
      accepted.hub_artifact_id,
      ...accepted.atomic_artifact_ids,
      ...accepted.long_artifact_ids,
      quizArtifactId,
    ];
    const artifactRows = await testDb()
      .select()
      .from(artifact)
      .where(eq(artifact.source_ref, proposalId));
    expect(new Set(artifactRows.map((row) => row.id))).toEqual(new Set(artifactIds));
    for (const art of artifactRows) {
      expect(art.archived_at).not.toBeNull();
    }
  });

  it('accept idempotent: second accept returns the existing materialization after the first writes a rate event', async () => {
    const { proposalId } = await seedLearningItemProposal();
    const first = await acceptAiProposal(testDb(), proposalId);
    if (first.kind !== 'learning_item') throw new Error('expected learning_item');

    const second = await acceptAiProposal(testDb(), proposalId);
    expect(second).toMatchObject({
      kind: 'learning_item',
      idempotent: true,
      hub_learning_item_id: first.hub_learning_item_id,
      atomic_learning_item_ids: first.atomic_learning_item_ids,
      long_learning_item_ids: first.long_learning_item_ids,
      hub_artifact_id: first.hub_artifact_id,
      atomic_artifact_ids: first.atomic_artifact_ids,
      long_artifact_ids: first.long_artifact_ids,
    });

    // Hub + atomics still exist exactly once.
    const liRows = await testDb()
      .select()
      .from(learning_item)
      .where(eq(learning_item.source_ref, proposalId));
    expect(liRows).toHaveLength(3);
  });

  it('retract already-archived rows is idempotent — second retract leaves rows alone', async () => {
    const { proposalId } = await seedLearningItemProposal();
    await acceptAiProposal(testDb(), proposalId);
    await retractAiProposal(testDb(), proposalId, { reason_md: 'first' });

    const firstSnapshot = await testDb()
      .select()
      .from(learning_item)
      .where(eq(learning_item.source_ref, proposalId));
    const firstArchivedAt = firstSnapshot[0].archived_at;
    const firstVersion = firstSnapshot[0].version;

    await retractAiProposal(testDb(), proposalId, { reason_md: 'second' });

    const secondSnapshot = await testDb()
      .select()
      .from(learning_item)
      .where(eq(learning_item.source_ref, proposalId));
    // archived_at + version should not change because we only tombstone rows
    // that are not already archived.
    expect(secondSnapshot[0].archived_at).toEqual(firstArchivedAt);
    expect(secondSnapshot[0].version).toBe(firstVersion);
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

// YUK-15 — record→proposal evidence loop on accept/retract.
describe('YUK-15 record evidence flip on accept / retract', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function seedRecord(id: string): Promise<void> {
    const now = new Date();
    await testDb().insert(learning_record).values({
      id,
      kind: 'open_question',
      title: null,
      content_md: 'why?',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'ask',
      processing_status: 'raw',
      origin_event_id: null,
      subject_id: null,
      knowledge_ids: [],
      question_id: null,
      attempt_event_id: null,
      learning_item_id: null,
      artifact_id: null,
      source_document_id: null,
      asset_refs: [],
      payload: {},
      created_at: now,
      updated_at: now,
      archived_at: null,
      version: 0,
    });
  }

  async function getRecordStatus(id: string): Promise<string | null> {
    const rows = await testDb()
      .select({ status: learning_record.processing_status })
      .from(learning_record)
      .where(eq(learning_record.id, id));
    return rows[0]?.status ?? null;
  }

  it('writeAiProposal → raw=linked, acceptAiProposal → linked=actioned, retract → linked', async () => {
    const db = testDb();
    await seedKnowledge(['parent_1']);
    await seedRecord('rec_1');

    await writeAiProposal(db, {
      id: 'node_p1',
      payload: {
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: null },
        reason_md: 'cited via record',
        evidence_refs: [{ kind: 'record', id: 'rec_1' }],
        proposed_change: {
          mutation: 'propose_new',
          name: '新节点',
          parent_id: 'parent_1',
        },
      },
    });
    // After write: raw → linked
    expect(await getRecordStatus('rec_1')).toBe('linked');

    await acceptAiProposal(db, 'node_p1');
    // After accept: linked → actioned
    expect(await getRecordStatus('rec_1')).toBe('actioned');

    await retractAiProposal(db, 'node_p1');
    // After retract: actioned → linked
    expect(await getRecordStatus('rec_1')).toBe('linked');
  });

  it('no-op when proposal has no record evidence', async () => {
    const db = testDb();
    await seedKnowledge(['parent_2']);
    await seedRecord('rec_unrelated');

    await writeAiProposal(db, {
      id: 'node_p2',
      payload: {
        kind: 'knowledge_node',
        target: { subject_kind: 'knowledge', subject_id: null },
        reason_md: 'no record refs',
        evidence_refs: [{ kind: 'event', id: 'evt_x' }],
        proposed_change: {
          mutation: 'propose_new',
          name: '另一节点',
          parent_id: 'parent_2',
        },
      },
    });
    await acceptAiProposal(db, 'node_p2');
    // Unrelated record stays raw.
    expect(await getRecordStatus('rec_unrelated')).toBe('raw');
  });
});

// YUK-202 / BlockAssembly path-B (design 2026-06-02 §4) — accept a block_merge
// proposal end-to-end: it reuses the YUK-195 `mergeQuestions` primitive (the
// merge runs ONLY here, on user accept — §5 no auto-merge), writes the accept
// rate event, is idempotent on a second accept, and goes stale (no rate event)
// when a block left draft before accept.
describe('block_merge proposal lifecycle', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // Mirror the YUK-195 fixture: a draft question_block with a structured tree in
  // a given ingestion session (mergeQuestions requires draft + same-session +
  // structured).
  async function seedDraftBlock(opts: {
    sessionId: string;
    nodeId: string;
    promptText: string;
    status?: string;
  }): Promise<string> {
    const db = testDb();
    const blockId = createId();
    const now = new Date();
    await db.insert(question_block).values({
      id: blockId,
      ingestion_session_id: opts.sessionId,
      source_document_id: null,
      source_asset_ids: [],
      page_spans: [],
      structured: { id: opts.nodeId, role: 'standalone', prompt_text: opts.promptText },
      figures: [],
      layout_quality: 'structured',
      image_refs: [],
      crop_refs: [],
      visual_complexity: 'low',
      extraction_confidence: 1,
      status: opts.status ?? 'draft',
      knowledge_hint: null,
      merged_from_block_ids: [],
      imported_question_id: null,
      imported_attempt_event_id: null,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    return blockId;
  }

  async function readBlock(blockId: string) {
    return (
      await testDb().select().from(question_block).where(eq(question_block.id, blockId)).limit(1)
    )[0];
  }

  async function seedBlockMergeProposal(opts: {
    proposalId: string;
    sessionId: string;
    primaryBlockId: string;
    mergeBlockIds: string[];
  }): Promise<void> {
    await writeAiProposal(testDb(), {
      id: opts.proposalId,
      payload: {
        kind: 'block_merge',
        target: { subject_kind: 'question_block', subject_id: opts.primaryBlockId },
        reason_md: '连续编号，承接前题',
        evidence_refs: [],
        proposed_change: {
          primary_block_id: opts.primaryBlockId,
          merge_block_ids: opts.mergeBlockIds,
          ingestion_session_id: opts.sessionId,
          continuity_signal: 'numbering',
        },
        cooldown_key: `block_merge:${opts.sessionId}:${opts.primaryBlockId}:${opts.mergeBlockIds.join(',')}`,
      },
    });
  }

  it('accept runs mergeQuestions, absorbs merge blocks, and writes an accept rate event', async () => {
    const db = testDb();
    const sessionId = createId();
    const primary = await seedDraftBlock({ sessionId, nodeId: 'p', promptText: 'primary' });
    const m1 = await seedDraftBlock({ sessionId, nodeId: 'm1', promptText: 'merge1' });
    const m2 = await seedDraftBlock({ sessionId, nodeId: 'm2', promptText: 'merge2' });
    await seedBlockMergeProposal({
      proposalId: 'block_merge_p1',
      sessionId,
      primaryBlockId: primary,
      mergeBlockIds: [m1, m2],
    });

    const result = await acceptAiProposal(db, 'block_merge_p1');

    expect(result.kind).toBe('block_merge');
    if (result.kind !== 'block_merge') throw new Error('expected block_merge result');
    expect(result).toMatchObject({
      kind: 'block_merge',
      primary_block_id: primary,
      merged_count: 2,
    });
    expect(result.rate_event_id).toBeTruthy();
    expect(result.stale).toBeUndefined();

    // (a) mergeQuestions ran: primary absorbed the merge blocks (stem + grown
    // sub_questions, in caller order) and the merge blocks flipped to 'ignored'.
    const primaryBlock = await readBlock(primary);
    expect(primaryBlock.structured?.role).toBe('stem');
    expect(primaryBlock.structured?.sub_questions?.map((s) => s.id)).toEqual(['p', 'm1', 'm2']);
    expect(primaryBlock.merged_from_block_ids).toEqual([m1, m2]);
    expect((await readBlock(m1)).status).toBe('ignored');
    expect((await readBlock(m2)).status).toBe('ignored');

    // (b) exactly one accept rate event chained to the proposal.
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'block_merge_p1')));
    expect(rateRows).toHaveLength(1);
    expect(rateRows[0].id).toBe(result.rate_event_id);
    expect(rateRows[0].payload).toMatchObject({
      rating: 'accept',
      primary_block_id: primary,
      merged_block_ids: [m1, m2],
    });
  });

  it('reports the EFFECTIVE merged set when the payload has duplicate or primary ids', async () => {
    // A hallucinating producer can emit merge_block_ids with a duplicate or the
    // primary id (the schema does not refine for uniqueness/exclude-primary).
    // mergeQuestions dedups + strips the primary before merging; merged_count and
    // the rate event's merged_block_ids must match what was ACTUALLY merged
    // (= the block's merged_from_block_ids), not the raw payload.
    const db = testDb();
    const sessionId = createId();
    const primary = await seedDraftBlock({ sessionId, nodeId: 'p', promptText: 'primary' });
    const m1 = await seedDraftBlock({ sessionId, nodeId: 'm1', promptText: 'merge1' });
    await seedBlockMergeProposal({
      proposalId: 'block_merge_dup',
      sessionId,
      primaryBlockId: primary,
      mergeBlockIds: [m1, m1, primary], // duplicate + the primary itself
    });

    const result = await acceptAiProposal(db, 'block_merge_dup');
    if (result.kind !== 'block_merge') throw new Error('expected block_merge result');
    // effective set = [m1]; NOT 3.
    expect(result.merged_count).toBe(1);
    expect(result.stale).toBeUndefined();

    const primaryBlock = await readBlock(primary);
    expect(primaryBlock.merged_from_block_ids).toEqual([m1]);
    expect((await readBlock(m1)).status).toBe('ignored');

    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'block_merge_dup')));
    expect(rateRows).toHaveLength(1);
    expect(rateRows[0].payload).toMatchObject({ merged_block_ids: [m1] });
  });

  it('a second accept is idempotent: no double-merge, no second rate event', async () => {
    const db = testDb();
    const sessionId = createId();
    const primary = await seedDraftBlock({ sessionId, nodeId: 'p', promptText: 'primary' });
    const m1 = await seedDraftBlock({ sessionId, nodeId: 'm1', promptText: 'merge1' });
    await seedBlockMergeProposal({
      proposalId: 'block_merge_idem',
      sessionId,
      primaryBlockId: primary,
      mergeBlockIds: [m1],
    });

    const first = await acceptAiProposal(db, 'block_merge_idem');
    expect(first.kind).toBe('block_merge');
    if (first.kind !== 'block_merge') throw new Error('expected block_merge result');
    expect(first.merged_count).toBe(1);

    const second = await acceptAiProposal(db, 'block_merge_idem');
    expect(second).toMatchObject({
      kind: 'block_merge',
      idempotent: true,
      primary_block_id: primary,
      rate_event_id: first.rate_event_id,
    });

    // No double-merge: merged_from_block_ids stays single, version is the single
    // merge's bump (not two), and only one rate event exists.
    const primaryBlock = await readBlock(primary);
    expect(primaryBlock.merged_from_block_ids).toEqual([m1]);
    expect(primaryBlock.version).toBe(1);

    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'block_merge_idem')));
    expect(rateRows).toHaveLength(1);

    // Acceptance signal stays consistent across the idempotent re-accept.
    const signals = await db
      .select()
      .from(proposal_signals)
      .where(eq(proposal_signals.kind, 'block_merge'));
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ accept_count: 1, dismiss_count: 0 });
  });

  it('returns stale with no rate event when a merge block is no longer draft', async () => {
    const db = testDb();
    const sessionId = createId();
    const primary = await seedDraftBlock({ sessionId, nodeId: 'p', promptText: 'primary' });
    // Pre-merge the merge block out of draft (e.g. already imported) so
    // mergeQuestions soft-rejects with skipped:not_draft.
    const m1 = await seedDraftBlock({
      sessionId,
      nodeId: 'm1',
      promptText: 'merge1',
      status: 'imported',
    });
    await seedBlockMergeProposal({
      proposalId: 'block_merge_stale',
      sessionId,
      primaryBlockId: primary,
      mergeBlockIds: [m1],
    });

    const result = await acceptAiProposal(db, 'block_merge_stale');

    expect(result).toMatchObject({
      kind: 'block_merge',
      primary_block_id: primary,
      stale: true,
      skip_reason: 'skipped:not_draft',
    });
    if (result.kind !== 'block_merge') throw new Error('expected block_merge result');
    expect(result.rate_event_id).toBeUndefined();

    // No mutation: primary stays its own standalone, merge block untouched.
    const primaryBlock = await readBlock(primary);
    expect(primaryBlock.structured?.role).toBe('standalone');
    expect(primaryBlock.merged_from_block_ids).toEqual([]);
    expect(primaryBlock.version).toBe(0);
    expect((await readBlock(m1)).status).toBe('imported');

    // No rate event written for a stale proposal.
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'block_merge_stale')));
    expect(rateRows).toHaveLength(0);
  });
});

// YUK-227 S3 Slice C (ADR-0002) — image_candidate accept = the SINGLE VLM 抽图 trigger.
describe('image_candidate accept (YUK-227 S3 Slice C)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // A VisionExtractTask output (parseVisionOutput shape) — one block.
  const VLM_OUTPUT = JSON.stringify({
    blocks: [
      {
        extracted_prompt_md: '请翻译「学而时习之，不亦说乎」。',
        reference_md: '学习并按时温习它，不也很愉快吗？',
        wrong_answer_md: null,
        page_index: 0,
        bbox: { x: 0.1, y: 0.1, width: 0.8, height: 0.4 },
        role: 'prompt',
        visual_complexity: 'low',
        extraction_confidence: 0.9,
        knowledge_hint: null,
      },
    ],
  });

  async function seedImageCandidateProposal(
    id: string,
    overrides: { source_url?: string; knowledge_ids?: string[] } = {},
  ): Promise<void> {
    const db = testDb();
    const sourceUrl = overrides.source_url ?? 'https://example.edu/wenyan/scan.png';
    await writeAiProposal(db, {
      id,
      actor_ref: 'sourcing',
      outcome: 'partial',
      payload: {
        kind: 'image_candidate',
        target: { subject_kind: 'source_asset', subject_id: null },
        reason_md: '该页题干在图片里，tavily_extract 抽不出文本。',
        evidence_refs: [],
        proposed_change: {
          source_url: sourceUrl,
          source_title: '论语·学而 扫描卷',
          summary_md: '图片型源：题干为扫描图片。',
          // FIX-3 — the sourcing-resolved knowledge node carried for accept attribution.
          ...(overrides.knowledge_ids ? { knowledge_ids: overrides.knowledge_ids } : {}),
        },
        cooldown_key: `image_candidate:${sourceUrl}`,
      },
    });
  }

  function imageCandidateDeps(
    overrides: {
      runTaskFn?: ReturnType<typeof vi.fn>;
      enqueueSourceVerify?: ReturnType<typeof vi.fn>;
      writeCostLedgerFn?: ReturnType<typeof vi.fn>;
      fetchImageBytesFn?: ReturnType<typeof vi.fn>;
      r2?: { put: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
    } = {},
  ) {
    const runTaskFn =
      overrides.runTaskFn ??
      vi.fn(async (_k: string, _i: unknown, _c: unknown) => ({ text: VLM_OUTPUT }));
    const enqueueSourceVerify = overrides.enqueueSourceVerify ?? vi.fn(async () => {});
    const r2 = overrides.r2 ?? { put: vi.fn(async () => {}), get: vi.fn(async () => null) };
    const fetchImageBytesFn =
      overrides.fetchImageBytesFn ??
      vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3, 4]), mimeType: 'image/png' }));
    // vitest 4 widened `vi.fn()` to `Mock<Procedure | Constructable>` (it now also
    // carries a `new` signature), so a bare mock no longer narrows to the plain
    // function shapes on ImageCandidateAcceptDeps. Cast each seam mock to its
    // interface field type when wiring `deps` — the mocks are structurally valid
    // callables, so this only pins the static type; runtime behavior is unchanged.
    // (The returned top-level mocks stay `Mock` so tests can still assert on them.)
    const deps: ImageCandidateAcceptDeps = {
      runTaskFn: runTaskFn as unknown as ImageCandidateAcceptDeps['runTaskFn'],
      enqueueSourceVerify:
        enqueueSourceVerify as unknown as ImageCandidateAcceptDeps['enqueueSourceVerify'],
      r2: r2 as never,
      fetchImageBytesFn:
        fetchImageBytesFn as unknown as ImageCandidateAcceptDeps['fetchImageBytesFn'],
      ...(overrides.writeCostLedgerFn
        ? {
            writeCostLedgerFn:
              overrides.writeCostLedgerFn as unknown as ImageCandidateAcceptDeps['writeCostLedgerFn'],
          }
        : {}),
    };
    return {
      runTaskFn,
      enqueueSourceVerify,
      r2,
      fetchImageBytesFn,
      deps,
    };
  }

  it('accept downloads the image, persists a source_asset, runs VLM, and materializes a tier-2 SourcedQuestion', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_1');
    const { deps, runTaskFn, enqueueSourceVerify, r2 } = imageCandidateDeps();

    const result = await acceptAiProposal(db, 'img_cand_1', { imageCandidateDeps: deps });

    expect(result.kind).toBe('image_candidate');
    if (result.kind !== 'image_candidate') throw new Error('unreachable');

    // source_asset persisted (the image was downloaded + put to R2).
    expect(r2.put).toHaveBeenCalledTimes(1);
    const assets = await db
      .select()
      .from(source_asset)
      .where(eq(source_asset.id, result.source_asset_id));
    expect(assets).toHaveLength(1);
    expect(assets[0].kind).toBe('image');
    expect(assets[0].mime_type).toBe('image/png');

    // EXACTLY one VLM call (per-accept upper bound = 1 image).
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    expect(runTaskFn.mock.calls[0][0]).toBe('VisionExtractTask');

    // A tier-2 web_sourced draft question was created from the VLM block.
    const questions = await db.select().from(question).where(eq(question.id, result.question_id));
    expect(questions).toHaveLength(1);
    const q = questions[0];
    expect(q.source).toBe('web_sourced');
    expect(q.draft_status).toBe('draft');
    expect(q.prompt_md).toBe('请翻译「学而时习之，不亦说乎」。');
    expect(q.source_ref).toBe('https://example.edu/wenyan/scan.png');
    const meta = q.metadata as Record<string, unknown>;
    expect(meta.source_ref_kind).toBe('url');
    expect(meta.image_candidate_source_asset_id).toBe(result.source_asset_id);
    const { tier } = deriveSourceTier({ source: q.source, metadata: meta });
    expect(tier).toBe(2);

    // source_verify enqueued for the new draft.
    expect(enqueueSourceVerify).toHaveBeenCalledWith([result.question_id]);

    // accept rate event chained to the proposal.
    const rateRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'img_cand_1')));
    expect(rateRows).toHaveLength(1);
    expect((rateRows[0].payload as { rating?: string }).rating).toBe('accept');
  });

  it('correlates the sourcing_image_extract row with the real VisionExtractTask run (zero-valued, no double-count)', async () => {
    // FIX-R2-2: the correlation row must串联 the REAL VisionExtractTask run via
    // task_run_id AND carry the real provider/model, but its cost/tokens are ZERO by
    // design — the VisionExtractTask run already wrote a real cost_ledger row, so a
    // non-zero correlation row would double-count the one extraction in SUM(cost). This
    // test uses a production-shaped seam (returns task_run_id like the real runTask)
    // against a seeded ai_task_runs row and asserts: task_run_id串联 + real provider/model
    // + zero cost/tokens.
    const db = testDb();
    await seedImageCandidateProposal('img_cand_runid');
    await db.insert(ai_task_runs).values({
      id: 'vlm_run_real_1',
      task_kind: 'VisionExtractTask',
      provider: 'xiaomi',
      model: 'mimo-vl-prod',
      input_hash: 'hash_fix4',
      status: 'succeeded',
      started_at: new Date(),
      usage_json: { inputTokens: 1234, outputTokens: 567 },
      cost_usd: 0.0123,
    });
    const runTaskFn = vi.fn(async () => ({ text: VLM_OUTPUT, task_run_id: 'vlm_run_real_1' }));
    const { deps } = imageCandidateDeps({ runTaskFn });

    await acceptAiProposal(db, 'img_cand_runid', { imageCandidateDeps: deps });

    const rows = await db
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_run_id, 'vlm_run_real_1'));
    const row = rows.find((r) => r.task_kind === 'sourcing_image_extract');
    expect(row).toBeDefined();
    // task_run_id串联s the real VisionExtractTask run (recover real花费 via JOIN).
    expect(row?.task_run_id).toBe('vlm_run_real_1');
    // provider/model are the real run's (self-describing correlation row).
    expect(row?.provider).toBe('xiaomi');
    expect(row?.model).toBe('mimo-vl-prod');
    // FIX-R2-2 — cost/tokens are ZERO so the correlation row never double-counts the
    // extraction the VisionExtractTask row already recorded.
    expect(row?.cost).toBe(0);
    expect(row?.tokens_in).toBe(0);
    expect(row?.tokens_out).toBe(0);
  });

  it('writes exactly one sourcing_image_extract cost_ledger row per accept (cost 留痕)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_cost');
    const { deps } = imageCandidateDeps();

    await acceptAiProposal(db, 'img_cand_cost', { imageCandidateDeps: deps });

    const ledger = await db
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_kind, 'sourcing_image_extract'));
    expect(ledger).toHaveLength(1);
  });

  it('cost gate: per accept = exactly one VLM call, no batch/auto path (re-accept does NOT re-spend)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_idem');
    const { deps, runTaskFn } = imageCandidateDeps();

    const first = await acceptAiProposal(db, 'img_cand_idem', { imageCandidateDeps: deps });
    // Second accept is idempotent: no second VLM call, no second question, no second ledger row.
    const second = await acceptAiProposal(db, 'img_cand_idem', { imageCandidateDeps: deps });

    expect(runTaskFn).toHaveBeenCalledTimes(1); // still ONE — re-accept did not re-spend.
    if (second.kind !== 'image_candidate') throw new Error('unreachable');
    expect(second.idempotent).toBe(true);
    if (first.kind === 'image_candidate') {
      expect(second.question_id).toBe(first.question_id);
    }

    const questions = await db.select().from(question).where(eq(question.source, 'web_sourced'));
    expect(questions).toHaveLength(1);
    const ledger = await db
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_kind, 'sourcing_image_extract'));
    expect(ledger).toHaveLength(1);
  });

  // FIX-3 — the materialized question is attributed to the sourcing-resolved knowledge
  // node carried on the proposal (text-path parity); an empty/absent set → empty attribution.
  it('attributes the materialized question to the proposal knowledge_ids (FIX-3)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_kids', { knowledge_ids: ['k1', 'k2'] });
    const { deps } = imageCandidateDeps();

    const result = await acceptAiProposal(db, 'img_cand_kids', { imageCandidateDeps: deps });
    if (result.kind !== 'image_candidate') throw new Error('unreachable');
    const rows = await db.select().from(question).where(eq(question.id, result.question_id));
    expect(rows[0].knowledge_ids).toEqual(['k1', 'k2']);
  });

  it('attributes empty knowledge_ids when the proposal carries none (FIX-3 default)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_nokids');
    const { deps } = imageCandidateDeps();

    const result = await acceptAiProposal(db, 'img_cand_nokids', { imageCandidateDeps: deps });
    if (result.kind !== 'image_candidate') throw new Error('unreachable');
    const rows = await db.select().from(question).where(eq(question.id, result.question_id));
    expect(rows[0].knowledge_ids).toEqual([]);
  });

  // FIX-2 — a non-image Content-Type must be rejected BEFORE the paid VLM flow. We exercise
  // the real defaultFetchImageBytes by stubbing global fetch to return an HTML page.
  it('rejects a non-image Content-Type before spending the VLM (FIX-2)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_html');
    // No fetchImageBytesFn override → the REAL defaultFetchImageBytes runs.
    const runTaskFn = vi.fn(async () => ({ text: VLM_OUTPUT }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>not an image</html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    try {
      await expect(
        acceptAiProposal(db, 'img_cand_html', {
          imageCandidateDeps: { runTaskFn, r2: { put: vi.fn(), get: vi.fn() } as never },
        }),
      ).rejects.toMatchObject({ code: 'unsupported_media_type' });
      // The VLM was never called — no money burned on HTML bytes.
      expect(runTaskFn).not.toHaveBeenCalled();
      // FIX-R2-8 — assert ALL of "No question / ledger / rate" the comment claims.
      const questions = await db.select().from(question).where(eq(question.source, 'web_sourced'));
      expect(questions).toHaveLength(0);
      // No sourcing_image_extract cost_ledger row (the paid flow never started).
      const ledger = await db
        .select()
        .from(cost_ledger)
        .where(eq(cost_ledger.task_kind, 'sourcing_image_extract'));
      expect(ledger).toHaveLength(0);
      // No accept rate event chained to the proposal (the proposal stays pending).
      const acceptRates = await db
        .select()
        .from(event)
        .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'img_cand_html')));
      expect(acceptRates).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // FIX-7 — a private/loopback host is rejected before any network call (the AI-written URL
  // is untrusted). We assert via the real defaultFetchImageBytes path.
  it('rejects a private/loopback source_url before fetching (FIX-7 SSRF guard)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_ssrf', {
      source_url: 'http://169.254.169.254/latest/meta-data/',
    });
    const runTaskFn = vi.fn(async () => ({ text: VLM_OUTPUT }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(
        acceptAiProposal(db, 'img_cand_ssrf', {
          imageCandidateDeps: { runTaskFn, r2: { put: vi.fn(), get: vi.fn() } as never },
        }),
      ).rejects.toMatchObject({ code: 'validation_error' });
      // Never even reached fetch.
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(runTaskFn).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // FIX-7 — an oversized body is rejected (Content-Length pre-check) before the paid flow.
  it('rejects an oversized image via Content-Length before the VLM (FIX-7 size cap)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_big');
    const runTaskFn = vi.fn(async () => ({ text: VLM_OUTPUT }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'content-length': String(20 * 1024 * 1024), // 20 MB > 10 MB cap
        },
      }),
    );
    try {
      await expect(
        acceptAiProposal(db, 'img_cand_big', {
          imageCandidateDeps: { runTaskFn, r2: { put: vi.fn(), get: vi.fn() } as never },
        }),
      ).rejects.toMatchObject({ code: 'payload_too_large' });
      expect(runTaskFn).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // FIX-5 — a concurrent second accept while the first is in flight is rejected with 409
  // (accept in progress) and does NOT spend a second VLM call. We model concurrency by
  // making the first accept's VLM hang until we have fired the second accept.
  it('blocks a concurrent second accept (409 in progress), no double VLM spend (FIX-5)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_concurrent');

    let releaseFirstVlm: () => void = () => {};
    const firstVlmGate = new Promise<void>((resolve) => {
      releaseFirstVlm = resolve;
    });
    let secondHasStarted: () => void = () => {};
    const secondStartedGate = new Promise<void>((resolve) => {
      secondHasStarted = resolve;
    });

    const firstRunTaskFn = vi.fn(async () => {
      // Signal that the first accept is now mid-VLM, then wait for the test to let it finish.
      secondHasStarted();
      await firstVlmGate;
      return { text: VLM_OUTPUT };
    });
    const secondRunTaskFn = vi.fn(async () => ({ text: VLM_OUTPUT }));

    const { deps: firstDeps } = imageCandidateDeps({ runTaskFn: firstRunTaskFn });
    const { deps: secondDeps } = imageCandidateDeps({ runTaskFn: secondRunTaskFn });

    const firstPromise = acceptAiProposal(db, 'img_cand_concurrent', {
      imageCandidateDeps: firstDeps,
    });
    // Wait until the first accept has claimed + entered the VLM, then fire the second.
    await secondStartedGate;
    const secondResult = await acceptAiProposal(db, 'img_cand_concurrent', {
      imageCandidateDeps: secondDeps,
    }).then(
      (r) => ({ ok: true as const, r }),
      (e) => ({ ok: false as const, e }),
    );
    releaseFirstVlm();
    await firstPromise;

    // The second accept saw the live claim and was rejected; it never spent a VLM call.
    expect(secondResult.ok).toBe(false);
    if (!secondResult.ok) {
      expect((secondResult.e as { code?: string }).code).toBe('conflict');
    }
    expect(secondRunTaskFn).not.toHaveBeenCalled();
    expect(firstRunTaskFn).toHaveBeenCalledTimes(1);
    // Exactly one question + one ledger row.
    const questions = await db.select().from(question).where(eq(question.source, 'web_sourced'));
    expect(questions).toHaveLength(1);
    const ledger = await db
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_kind, 'sourcing_image_extract'));
    expect(ledger).toHaveLength(1);
  });

  // FIX-5 — after a failed accept (VLM throws), the claim is cleared so a retry can run
  // (it is NOT permanently wedged "in progress").
  it('allows a retry after a failed accept (claim cleared on failure) (FIX-5)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_retry');

    const failingRunTaskFn = vi.fn(async () => {
      throw new Error('VLM boom');
    });
    const { deps: failDeps } = imageCandidateDeps({ runTaskFn: failingRunTaskFn });
    await expect(
      acceptAiProposal(db, 'img_cand_retry', { imageCandidateDeps: failDeps }),
    ).rejects.toThrow(/VLM boom/);

    // No question was created by the failed attempt.
    let questions = await db.select().from(question).where(eq(question.source, 'web_sourced'));
    expect(questions).toHaveLength(0);

    // Retry with a working VLM — the claim was cleared, so this is NOT a 409.
    const { deps: okDeps, runTaskFn } = imageCandidateDeps();
    const result = await acceptAiProposal(db, 'img_cand_retry', { imageCandidateDeps: okDeps });
    expect(result.kind).toBe('image_candidate');
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    questions = await db.select().from(question).where(eq(question.source, 'web_sourced'));
    expect(questions).toHaveLength(1);
  });

  // FIX-R2-1 — a redirect to a private host must be rejected by re-running the SSRF guard
  // on the redirect target; the VLM is never reached. We exercise the real
  // defaultFetchImageBytes with a manual-redirect fetch stub.
  it('rejects a redirect to a private host before the VLM (FIX-R2-1 redirect SSRF)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_redirect', {
      source_url: 'https://example.edu/wenyan/redirect.png',
    });
    const runTaskFn = vi.fn(async () => ({ text: VLM_OUTPUT }));
    // First hop = a legal 302 → Location pointing at the cloud metadata endpoint.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      }),
    );
    try {
      await expect(
        acceptAiProposal(db, 'img_cand_redirect', {
          imageCandidateDeps: { runTaskFn, r2: { put: vi.fn(), get: vi.fn() } as never },
        }),
      ).rejects.toMatchObject({ code: 'validation_error' });
      // The first hop fetched, but the redirect target was rejected before a second fetch.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      // The VLM never ran — no money burned via the redirect bypass.
      expect(runTaskFn).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // FIX-R2-7 — a normal domain that happens to start with fc/fd/fe (fdic.gov,
  // fcdn.example.com) must NOT be mis-flagged as an IPv6 private host. fdic.gov passes the
  // guard and reaches fetch; an actual IPv6 unique-local literal [fd00::1] is still
  // rejected before any network call.
  it('does not mis-reject fc/fd-prefixed domains; still rejects IPv6 literals (FIX-R2-7)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_fdic', {
      source_url: 'https://fdic.gov/exam/q.png',
    });
    const runTaskFn = vi.fn(async () => ({ text: VLM_OUTPUT }));
    // A tiny valid image response so the accept proceeds past fetch (we only need to prove
    // the guard let fdic.gov through — fetch WAS called).
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    try {
      // Build deps WITHOUT fetchImageBytesFn so the REAL defaultFetchImageBytes (and its
      // SSRF guard) runs against the fetch stub.
      const result = await acceptAiProposal(db, 'img_cand_fdic', {
        imageCandidateDeps: {
          runTaskFn,
          enqueueSourceVerify: vi.fn(async () => {}),
          r2: { put: vi.fn(async () => {}), get: vi.fn(async () => null) } as never,
        },
      });
      expect(result.kind).toBe('image_candidate');
      // fdic.gov passed the SSRF guard → fetch was actually called.
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }

    // An IPv6 unique-local literal is still rejected before any network call.
    await seedImageCandidateProposal('img_cand_ipv6', {
      source_url: 'http://[fd00::1]/x.png',
    });
    const ipv6RunTaskFn = vi.fn(async () => ({ text: VLM_OUTPUT }));
    const ipv6FetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await expect(
        acceptAiProposal(db, 'img_cand_ipv6', {
          imageCandidateDeps: {
            runTaskFn: ipv6RunTaskFn,
            r2: { put: vi.fn(), get: vi.fn() } as never,
          },
        }),
      ).rejects.toMatchObject({ code: 'validation_error' });
      expect(ipv6FetchSpy).not.toHaveBeenCalled();
      expect(ipv6RunTaskFn).not.toHaveBeenCalled();
    } finally {
      ipv6FetchSpy.mockRestore();
    }
  });

  // FIX-R2-4 — an image/* MIME outside the supported set (svg/gif/bmp) is rejected with a
  // 422, NOT silently re-tagged as image/png; the paid VLM flow never starts.
  it('rejects an unsupported image MIME (svg) before the VLM (FIX-R2-4)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_svg');
    const runTaskFn = vi.fn(async () => ({ text: VLM_OUTPUT }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<svg></svg>', {
        status: 200,
        headers: { 'content-type': 'image/svg+xml' },
      }),
    );
    try {
      await expect(
        acceptAiProposal(db, 'img_cand_svg', {
          imageCandidateDeps: { runTaskFn, r2: { put: vi.fn(), get: vi.fn() } as never },
        }),
      ).rejects.toMatchObject({ code: 'unsupported_media_type' });
      expect(runTaskFn).not.toHaveBeenCalled();
      const questions = await db.select().from(question).where(eq(question.source, 'web_sourced'));
      expect(questions).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // FIX-R2-3 — the user dismisses the proposal WHILE the accept's VLM is in flight. The
  // terminal tx re-checks the rate event under the lock and aborts with 409, writing NO
  // question and NO accept rate (the dismiss veto is preserved).
  it('aborts (409) when the proposal is dismissed during accept; no question written (FIX-R2-3)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_veto');

    let releaseVlm: () => void = () => {};
    const vlmGate = new Promise<void>((resolve) => {
      releaseVlm = resolve;
    });
    let vlmStarted: () => void = () => {};
    const vlmStartedGate = new Promise<void>((resolve) => {
      vlmStarted = resolve;
    });
    const runTaskFn = vi.fn(async () => {
      vlmStarted();
      await vlmGate;
      return { text: VLM_OUTPUT };
    });
    const { deps } = imageCandidateDeps({ runTaskFn });

    const acceptPromise = acceptAiProposal(db, 'img_cand_veto', { imageCandidateDeps: deps }).then(
      (r) => ({ ok: true as const, r }),
      (e) => ({ ok: false as const, e }),
    );
    // Wait until the accept is mid-VLM, then dismiss the proposal (the user's veto lands a
    // non-accept terminal rate event).
    await vlmStartedGate;
    await dismissAiProposal(db, 'img_cand_veto');
    releaseVlm();
    const outcome = await acceptPromise;

    // The accept aborted with 409 — the veto was NOT overwritten.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect((outcome.e as { code?: string }).code).toBe('conflict');
    }
    // No web_sourced question was written.
    const questions = await db.select().from(question).where(eq(question.source, 'web_sourced'));
    expect(questions).toHaveLength(0);
    // The only rate event chained to the proposal is the dismiss (no accept rate).
    const rates = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'rate'), eq(event.caused_by_event_id, 'img_cand_veto')));
    expect(rates).toHaveLength(1);
    expect((rates[0].payload as { rating?: string }).rating).toBe('dismiss');
  });

  // FIX-R2-5 — a kind-constrained proposal (requested_kind on the proposed_change)
  // materializes a question of that kind, normalized through the question-kind vocabulary.
  it('materializes the requested_kind (choice) when the proposal carries one (FIX-R2-5)', async () => {
    const db = testDb();
    await writeAiProposal(db, {
      id: 'img_cand_choice',
      actor_ref: 'sourcing',
      outcome: 'partial',
      payload: {
        kind: 'image_candidate',
        target: { subject_kind: 'source_asset', subject_id: null },
        reason_md: '图片型源',
        evidence_refs: [],
        proposed_change: {
          source_url: 'https://example.edu/wenyan/choice.png',
          source_title: '选择题扫描卷',
          summary_md: '图片型选择题源。',
          // single_choice is a profile/skill key → normalizes to canonical 'choice'.
          requested_kind: 'single_choice',
        },
        cooldown_key: 'image_candidate:https://example.edu/wenyan/choice.png',
      },
    });
    const { deps } = imageCandidateDeps();

    const result = await acceptAiProposal(db, 'img_cand_choice', { imageCandidateDeps: deps });
    if (result.kind !== 'image_candidate') throw new Error('unreachable');
    const rows = await db.select().from(question).where(eq(question.id, result.question_id));
    expect(rows[0].kind).toBe('choice');
  });

  // FIX-R2-6 — the stored extract is the RAW VLM output (the full block-serialized text),
  // NOT the final promptMd, so source_verify's overlap is not an identity. The question
  // metadata carries single_source_grounding=true to mark the limitation.
  it('stores the raw VLM output as the extract (not promptMd) + marks single_source_grounding (FIX-R2-6)', async () => {
    const db = testDb();
    await seedImageCandidateProposal('img_cand_extract');
    const { deps } = imageCandidateDeps();

    const result = await acceptAiProposal(db, 'img_cand_extract', { imageCandidateDeps: deps });
    if (result.kind !== 'image_candidate') throw new Error('unreachable');
    const rows = await db.select().from(question).where(eq(question.id, result.question_id));
    const meta = rows[0].metadata as {
      web_sourced?: { extract?: string };
      single_source_grounding?: boolean;
    };
    const extract = meta.web_sourced?.extract ?? '';
    const promptMd = rows[0].prompt_md;
    // The extract is the raw VLM JSON (contains the block structure), not just the prompt.
    expect(extract).not.toBe(promptMd);
    expect(extract).toBe(VLM_OUTPUT);
    expect(extract).toContain('extracted_prompt_md');
    expect(meta.single_source_grounding).toBe(true);
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
