import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildCopilotToolResultSnapshot } from '@/capabilities/copilot/server/tool-result-snapshot';
import { getQuestionContextTool } from '@/capabilities/practice/scheduling/tools/question-context';
import { QUESTION_OR_ANSWER_MAY_BE_FAULTY_ACTION } from '@/core/schema/event';
import { INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE } from '@/core/schema/intervention';
import {
  artifact,
  completion_evidence,
  knowledge,
  knowledge_edge,
  learning_item,
  learning_record,
  material_fsrs_state,
  memory_brief_note,
  question,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import type { ToolContext } from '@/kernel/tools/types';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { __resetRegistryForTests, registerTool } from './registry';

const BASE = new Date(Date.now() - 60_000);

function ctx(): ToolContext {
  return {
    db: testDb(),
    taskRunId: 'tr_td2',
    callerActor: { kind: 'agent', ref: 'agent:copilot' },
  };
}

function fsrsState(due: Date) {
  return {
    due: due.toISOString(),
    stability: 2,
    difficulty: 5,
    elapsed_days: 1,
    scheduled_days: 3,
    learning_steps: 0,
    reps: 2,
    lapses: 0,
    state: 'review',
    last_review: BASE.toISOString(),
  };
}

async function seedGraph() {
  const db = testDb();
  await db.insert(knowledge).values([
    {
      id: 'k_root',
      name: '文言虚词',
      domain: 'yuwen',
      created_at: BASE,
      updated_at: BASE,
    },
    {
      id: 'k_zhi',
      name: '之的用法',
      domain: null,
      parent_id: 'k_root',
      created_at: BASE,
      updated_at: BASE,
    },
    {
      id: 'k_er',
      name: '而的用法',
      domain: null,
      parent_id: 'k_root',
      created_at: BASE,
      updated_at: BASE,
    },
  ]);
  await db.insert(knowledge_edge).values({
    id: 'edge_zhi_er',
    from_knowledge_id: 'k_zhi',
    to_knowledge_id: 'k_er',
    relation_type: 'contrasts_with',
    weight: 0.8,
    created_by: 'user' as never,
    reasoning: '二者常在断句和翻译里混淆',
    created_at: BASE,
  });
}

async function seedQuestionsAndEvents() {
  const db = testDb();
  await db.insert(question).values([
    {
      id: 'q_new',
      kind: 'short_answer',
      prompt_md: '解释「之」在句中的作用',
      reference_md: '结构助词，取消句子独立性。',
      source: 'manual',
      knowledge_ids: ['k_zhi'],
      created_at: BASE,
      updated_at: BASE,
    },
    {
      id: 'q_due',
      kind: 'short_answer',
      prompt_md: '比较「之」与「而」的用法',
      reference_md: '前者多作助词，后者多表承接或转折。',
      source: 'manual',
      knowledge_ids: ['k_zhi', 'k_er'],
      created_at: new Date(BASE.getTime() + 1_000),
      updated_at: BASE,
    },
  ]);
  await writeEvent(db, {
    id: 'att_new',
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'q_new',
    outcome: 'failure',
    payload: {
      answer_md: '把之理解成代词',
      answer_image_refs: [],
      referenced_knowledge_ids: ['k_zhi'],
    },
    created_at: new Date(BASE.getTime() + 2_000),
  });
  await writeEvent(db, {
    id: 'judge_new',
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'AttributionTask',
    action: 'judge',
    subject_kind: 'event',
    subject_id: 'att_new',
    outcome: 'success',
    caused_by_event_id: 'att_new',
    payload: {
      cause: {
        primary_category: 'concept',
        secondary_categories: ['method'],
        analysis_md: '混淆助词与代词',
        confidence: 0.9,
      },
      referenced_knowledge_ids: ['k_zhi'],
    },
    created_at: new Date(BASE.getTime() + 3_000),
  });
  await writeEvent(db, {
    id: 'review_due',
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'review',
    subject_kind: 'question',
    subject_id: 'q_due',
    outcome: 'success',
    payload: {
      fsrs_rating: 'good',
      fsrs_state_after: fsrsState(new Date(BASE.getTime() - 86_400_000)),
      user_response_md: null,
      referenced_knowledge_ids: ['k_zhi', 'k_er'],
    },
    created_at: new Date(BASE.getTime() + 4_000),
  });
  await db.insert(material_fsrs_state).values({
    id: 'fsrs_due',
    subject_kind: 'knowledge',
    subject_id: 'k_er',
    state: fsrsState(new Date(BASE.getTime() - 86_400_000)) as never,
    due_at: new Date(BASE.getTime() - 86_400_000),
    last_review_event_id: 'review_due',
    updated_at: BASE,
  });
}

async function seedLearningObjects() {
  const db = testDb();
  await db.insert(artifact).values({
    id: 'art_note',
    type: 'note',
    title: '之的用法笔记',
    knowledge_ids: ['k_zhi'],
    intent_source: 'learning_intent',
    source: 'agent',
    source_ref: 'seed',
    generation_status: 'ready',
    body_blocks: {
      type: 'doc',
      content: [
        {
          type: 'semanticBlock',
          attrs: { id: 'b1', semantic_kind: 'concept', title: '核心概念' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: '之可作结构助词。' }] }],
        },
      ],
    } as never,
    created_at: BASE,
    updated_at: BASE,
  });
  await db.insert(learning_item).values([
    {
      id: 'li_parent',
      source: 'manual',
      title: '文言虚词总览',
      content: '总览',
      status: 'in_progress',
      knowledge_ids: ['k_root'],
      created_at: BASE,
      updated_at: BASE,
    },
    {
      id: 'li_zhi',
      source: 'manual',
      title: '学习之的用法',
      content: '先看例句，再做题。',
      status: 'in_progress',
      knowledge_ids: ['k_zhi'],
      primary_artifact_id: 'art_note',
      parent_learning_item_id: 'li_parent',
      created_at: new Date(BASE.getTime() + 1_000),
      updated_at: BASE,
    },
  ]);
  await db.insert(completion_evidence).values({
    id: 'ev_complete',
    learning_item_id: 'li_zhi',
    path: 'primary_artifact.ready',
    evidence_json: { summary: 'note ready' },
    decided_at: new Date(BASE.getTime() + 2_000),
  });
  await db.insert(learning_record).values({
    id: 'rec_mistake',
    kind: 'mistake',
    title: '之的误判',
    content_md: '我把结构助词误判成代词。',
    source: 'manual',
    capture_mode: 'text',
    activity_kind: 'attempt',
    processing_status: 'linked',
    origin_event_id: 'att_new',
    subject_id: 'yuwen',
    knowledge_ids: ['k_zhi'],
    question_id: 'q_new',
    attempt_event_id: 'att_new',
    learning_item_id: 'li_zhi',
    artifact_id: 'art_note',
    created_at: new Date(BASE.getTime() + 3_000),
    updated_at: BASE,
  });
}

async function seedMemoryBrief() {
  await testDb()
    .insert(memory_brief_note)
    .values({
      id: 'mb_global',
      scope_key: 'global',
      subject_id: null,
      recent_week_md: '本周常错虚词「之」。',
      recent_months_md: '近月重点是文言翻译。',
      long_term_md: '适合先辨析再刷题。',
      recent_week_evidence_ids: ['rec_mistake'],
      recent_months_evidence_ids: ['att_new'],
      long_term_evidence_ids: ['k_zhi'],
      source_event_id: 'evt_item',
      latest_evidence_at: BASE,
      evidence_count: 3,
      refreshed_at: new Date(BASE.getTime() + 5_000),
      created_at: BASE,
      updated_at: BASE,
    });
}

async function seedAll() {
  await seedGraph();
  await seedQuestionsAndEvents();
  await seedLearningObjects();
  await seedMemoryBrief();
}

describe('Foundation D M2 read tools', () => {
  beforeEach(async () => {
    await resetDb();
    __resetRegistryForTests();
  });

  it('hides intervention diagnostic prompts and answers from generic Copilot context reads', async () => {
    await seedAll();
    await testDb()
      .update(question)
      .set({ source: INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE })
      .where(eq(question.id, 'q_new'));

    const questionContext = await getQuestionContextTool.execute(ctx(), {
      questionId: 'q_new',
      include: ['attempts', 'records', 'knowledge_context', 'assets', 'structure'],
    });

    expect(questionContext.question).toBeNull();
    expect(questionContext.availability).toBe('redacted_intervention_diagnostic');
    expect(questionContext.lifecycle.observation_status).toBe('not_observed');
    expect(questionContext.lifecycle).toMatchObject({
      attempt_counts: { success: 0, partial: 0, failure: 0 },
      review_count: 0,
      due_at: null,
      linked_record_ids: [],
    });
    expect(questionContext.records).toBeUndefined();
    expect(JSON.stringify(questionContext)).not.toContain('reference');
    expect(getQuestionContextTool.summarize({ questionId: 'q_new' }, questionContext)).toContain(
      'redacted',
    );

    const missing = await getQuestionContextTool.execute(ctx(), {
      questionId: 'q_does_not_exist',
    });
    expect(missing.availability).toBe('not_found');
    expect(missing.question).toBeNull();
    expect(missing.lifecycle.observation_status).toBe('not_observed');
    expect(getQuestionContextTool.summarize({ questionId: 'q_does_not_exist' }, missing)).toContain(
      'missing',
    );
  });

  // @invariant security: one question read returns the linked knowledge card's due and the latest faulty inference, and the learner snapshot omits that inference
  // @fails-if lifecycle.due_at stays null while a knowledge card is due, or the learner snapshot still contains the faulty event
  it('reads a knowledge-card due and keeps a faulty inference off the learner snapshot', async () => {
    await seedAll();
    const due = new Date(BASE.getTime() - 86_400_000);
    await writeEvent(testDb(), {
      id: 'evt_question_or_answer_may_be_faulty_self_q_due',
      session_id: null,
      actor_kind: 'system',
      actor_ref: 'assessment_settlement',
      action: QUESTION_OR_ANSWER_MAY_BE_FAULTY_ACTION,
      subject_kind: 'question',
      subject_id: 'q_due',
      outcome: null,
      payload: {
        inference: true,
        learner_id: 'self',
        question_id: 'q_due',
        kc_ids: ['k_er'],
        attempt_ids: {
          incorrect: ['att_fault_a', 'att_fault_b'],
          correct: ['att_fault_c', 'att_fault_d'],
        },
        window: {
          ms: 14 * 86_400_000,
          from: new Date(due.getTime() - 14 * 86_400_000).toISOString(),
          until: due.toISOString(),
        },
      },
      created_at: new Date(BASE.getTime() + 5_000),
    });

    const found = await getQuestionContextTool.execute(ctx(), { questionId: 'q_due' });
    expect(found.lifecycle.due_at).toBe(due.toISOString());
    expect(found.reading.fsrs).toMatchObject({
      card: 'knowledge',
      due_at: { known: true, value: due.toISOString() },
    });
    expect(found.reading.knowledge.map((row) => row.name.value)).toEqual(['之的用法', '而的用法']);
    expect(found.reading.issuance.value).toMatchObject({
      servable: false,
      blocked_by: 'missing_lifecycle',
    });
    expect(found.reading.difficulty.item.value?.basis).toBe('difficulty_proxy');
    expect(found.reading.difficulty.family.known).toBe(true);
    expect(found.reading.faulty.value).toMatchObject({
      event_id: 'evt_question_or_answer_may_be_faulty_self_q_due',
      inference: true,
      attempt_ids: { incorrect: ['att_fault_a', 'att_fault_b'] },
    });

    const scored = await getQuestionContextTool.execute(ctx(), { questionId: 'q_new' });
    expect(scored.reading.recent_scoring.value).toMatchObject({
      event_id: 'att_new',
      outcome: 'failure',
      cause: { primary: 'concept' },
    });

    registerTool(getQuestionContextTool);
    const snapshot = buildCopilotToolResultSnapshot('get_question_context', found);
    expect(snapshot.state).toBe('available');
    expect(JSON.stringify(snapshot)).not.toContain('question_or_answer_may_be_faulty');
    expect(JSON.stringify(snapshot)).not.toContain('att_fault_a');
  });
});
