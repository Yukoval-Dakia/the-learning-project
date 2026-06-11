import { writeKnowledgeProposeEvent } from '@/capabilities/knowledge/server/proposals';
import {
  artifact,
  completion_evidence,
  event,
  knowledge,
  knowledge_edge,
  learning_item,
  learning_record,
  proposal_signals,
  question,
} from '@/db/schema';
import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
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
