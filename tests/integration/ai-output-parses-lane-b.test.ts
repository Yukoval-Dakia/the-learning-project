// Phase 1c.1 Step 7 — integration: AI outputs parse through Lane B Event schema.
//
// AI-generated event rows are roundtripped through parseEvent (Lane B contract
// gate) to catch drift between (a) what AI prompts produce and (b) what
// Lane B's Zod schemas accept:
//
//   1. AttributionTask output → runAttributionAndWriteJudgeEvent writes a
//      JudgeOnEvent row; the row roundtrips through parseEvent.
//   2. KnowledgeReviewTask's write_proposal tool dispatcher (runWriteProposal,
//      same code path the Claude Agent SDK MCP server hands off to) writes a
//      ProposeKnowledgeEdge row; the row roundtrips through parseEvent.
//
// Post-2026-05-17 migration: streamReviewTask no longer accepts a mock model
// — the agent runtime is the Claude CLI subprocess. We call the dispatcher
// runWriteProposal directly to assert DB shape.

import { parseEvent } from '@/core/schema/event';
import { event, knowledge, question } from '@/db/schema';
import { runAttributionAndWriteJudgeEvent } from '@/server/knowledge/attribute';
import { runWriteProposal } from '@/server/knowledge/review';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../helpers/db';

describe('AI outputs roundtrip through Lane B Event schema', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('AttributionTask LLM output → JudgeOnEvent row parses through parseEvent', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(question).values({
      id: 'q_attr',
      kind: 'short_answer',
      prompt_md: '"之"在主谓之间的用法?',
      reference_md: '取消句子独立性',
      knowledge_ids: ['k_xuci'],
      difficulty: 3,
      source: 'test',
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await db.insert(event).values({
      id: 'attempt_attr',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q_attr',
      outcome: 'failure',
      payload: {
        answer_md: '助词',
        answer_image_refs: [],
        referenced_knowledge_ids: ['k_xuci'],
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: now,
    });

    // Canned LLM output — what the prompt asks for after Step 7.A
    const canned =
      '{"primary_category":"concept","secondary_categories":["memory"],"analysis_md":"用户把「之」在主谓间的用法当作了助词","confidence":0.82}';
    const fakeRunTask = async () => ({ text: canned });

    await runAttributionAndWriteJudgeEvent({
      db,
      attemptEventId: 'attempt_attr',
      input: {
        prompt_md: '"之"在主谓之间的用法?',
        reference_md: '取消句子独立性',
        wrong_answer_md: '助词',
        knowledge_context: [{ id: 'k_xuci', name: '虚词', effective_domain: 'wenyan' }],
      },
      runTaskFn: fakeRunTask,
      referencedKnowledgeIds: ['k_xuci'],
    });

    const judgeRows = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'judge'), eq(event.caused_by_event_id, 'attempt_attr')));
    expect(judgeRows).toHaveLength(1);
    const j = judgeRows[0];

    // Roundtrip the judge row through parseEvent — Lane B contract gate.
    const parsed = parseEvent({
      actor_kind: j.actor_kind,
      actor_ref: j.actor_ref,
      action: j.action,
      subject_kind: j.subject_kind,
      subject_id: j.subject_id,
      outcome: j.outcome,
      payload: j.payload,
      caused_by_event_id: j.caused_by_event_id ?? undefined,
    }) as { action: string; payload: { cause: { analysis_md: string; confidence: number } } };
    expect(parsed.action).toBe('judge');
    expect(parsed.payload.cause.analysis_md).toContain('主谓间');
    expect(parsed.payload.cause.confidence).toBe(0.82);
  });

  it('KnowledgeReviewTask propose_knowledge_edge tool-call → event row parses through parseEvent', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values([
      {
        id: 'k_lane_b_from',
        name: '虚词',
        domain: 'wenyan',
        parent_id: null,
        merged_from: [],
        proposed_by_ai: false,
        approval_status: 'approved',
        created_at: now,
        updated_at: now,
        version: 0,
      },
      {
        id: 'k_lane_b_to',
        name: '助词',
        domain: 'wenyan',
        parent_id: null,
        merged_from: [],
        proposed_by_ai: false,
        approval_status: 'approved',
        created_at: now,
        updated_at: now,
        version: 0,
      },
    ]);

    await runWriteProposal(db, {
      payload: {
        mutation: 'propose_knowledge_edge',
        from_knowledge_id: 'k_lane_b_from',
        to_knowledge_id: 'k_lane_b_to',
        relation_type: 'related_to',
      },
      reasoning: '虚词与助词在用户错答中频繁混淆 — related_to 反映概念上的关联',
    });

    const edgeEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge_edge')));
    expect(edgeEvents).toHaveLength(1);
    const e = edgeEvents[0];

    const parsed = parseEvent({
      actor_kind: e.actor_kind,
      actor_ref: e.actor_ref,
      action: e.action,
      subject_kind: e.subject_kind,
      subject_id: e.subject_id,
      outcome: e.outcome,
      payload: e.payload,
      caused_by_event_id: e.caused_by_event_id ?? undefined,
    }) as {
      action: string;
      subject_kind?: string;
      payload: { from_knowledge_id: string; to_knowledge_id: string; relation_type: string };
    };
    expect(parsed.action).toBe('propose');
    expect(parsed.subject_kind).toBe('knowledge_edge');
    expect(parsed.payload.from_knowledge_id).toBe('k_lane_b_from');
    expect(parsed.payload.to_knowledge_id).toBe('k_lane_b_to');
    expect(parsed.payload.relation_type).toBe('related_to');
  });

  it('propose_knowledge_edge with experimental:* relation_type also parses', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values([
      {
        id: 'k_exp_a',
        name: 'A',
        domain: 'wenyan',
        parent_id: null,
        merged_from: [],
        proposed_by_ai: false,
        approval_status: 'approved',
        created_at: now,
        updated_at: now,
        version: 0,
      },
      {
        id: 'k_exp_b',
        name: 'B',
        domain: 'wenyan',
        parent_id: null,
        merged_from: [],
        proposed_by_ai: false,
        approval_status: 'approved',
        created_at: now,
        updated_at: now,
        version: 0,
      },
    ]);

    await runWriteProposal(db, {
      payload: {
        mutation: 'propose_knowledge_edge',
        from_knowledge_id: 'k_exp_a',
        to_knowledge_id: 'k_exp_b',
        relation_type: 'experimental:complementary',
      },
      reasoning: '尝试性新关系',
    });

    const edgeEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge_edge')));
    expect(edgeEvents).toHaveLength(1);
    const e = edgeEvents[0];
    const parsed = parseEvent({
      actor_kind: e.actor_kind,
      actor_ref: e.actor_ref,
      action: e.action,
      subject_kind: e.subject_kind,
      subject_id: e.subject_id,
      outcome: e.outcome,
      payload: e.payload,
      caused_by_event_id: e.caused_by_event_id ?? undefined,
    }) as { payload: { relation_type: string } };
    expect(parsed.payload.relation_type).toBe('experimental:complementary');
  });
});
