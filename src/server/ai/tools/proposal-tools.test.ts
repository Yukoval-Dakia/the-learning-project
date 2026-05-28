import {
  artifact,
  event,
  knowledge,
  knowledge_edge,
  learning_item,
  learning_record,
  mistake_variant,
  question,
} from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import * as attributeModule from '@/server/knowledge/attribute';
import { listProposalInboxRows } from '@/server/proposals/inbox';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { __resetBootstrapForTests, registerCoreTools } from './bootstrap';
import {
  attributeMistakeTool,
  proposeKnowledgeEdgeTool,
  proposeKnowledgeMutationTool,
  proposeLearningItemCompletionTool,
  proposeLearningItemRelearnTool,
  proposeRecordLinksTool,
  proposeRecordPromotionTool,
  proposeVariantTool,
} from './proposal-tools';
import { __resetRegistryForTests, getTool, listTools } from './registry';
import type { ToolContext } from './types';

const mockRunner = vi.hoisted(() => ({
  runTask: vi.fn(),
}));

vi.mock('@/server/ai/runner', () => ({
  runTask: mockRunner.runTask,
}));

const BASE = new Date('2026-05-28T00:00:00.000Z');

function ctx(): ToolContext {
  return {
    db: testDb(),
    taskRunId: 'tr_wave3_tool',
    callerActor: { kind: 'agent', ref: 'agent:maintenance' },
  };
}

async function seedKnowledgeGraph(): Promise<void> {
  const db = testDb();
  await db.insert(knowledge).values([
    {
      id: 'k_wenyan',
      name: '文言文',
      domain: 'wenyan',
      created_at: BASE,
      updated_at: BASE,
    },
    {
      id: 'k_zhi',
      name: '之的用法',
      domain: null,
      parent_id: 'k_wenyan',
      created_at: BASE,
      updated_at: BASE,
    },
    {
      id: 'k_er',
      name: '而的用法',
      domain: null,
      parent_id: 'k_wenyan',
      created_at: BASE,
      updated_at: BASE,
    },
    {
      id: 'k_math',
      name: '数学',
      domain: 'math',
      created_at: BASE,
      updated_at: BASE,
    },
  ]);
}

async function seedQuestionAndFailure(opts: { withJudge?: boolean } = {}): Promise<void> {
  const db = testDb();
  await db.insert(question).values({
    id: 'q_zhi',
    kind: 'short_answer',
    prompt_md: '解释「之」在句中的作用',
    reference_md: '结构助词。',
    knowledge_ids: ['k_zhi'],
    source: 'manual',
    difficulty: 3,
    created_at: BASE,
    updated_at: BASE,
  });
  await writeEvent(db, {
    id: 'att_failure',
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'q_zhi',
    outcome: 'failure',
    payload: {
      answer_md: '代词',
      answer_image_refs: [],
      referenced_knowledge_ids: ['k_zhi'],
    },
    created_at: new Date(BASE.getTime() + 1_000),
  });
  if (opts.withJudge) {
    await writeEvent(db, {
      id: 'judge_failure',
      actor_kind: 'agent',
      actor_ref: 'attribution',
      action: 'judge',
      subject_kind: 'event',
      subject_id: 'att_failure',
      outcome: 'success',
      payload: {
        cause: {
          primary_category: 'concept',
          secondary_categories: ['method'],
          analysis_md: '混淆助词和代词。',
          confidence: 0.86,
        },
        referenced_knowledge_ids: ['k_zhi'],
      },
      caused_by_event_id: 'att_failure',
      created_at: new Date(BASE.getTime() + 2_000),
    });
  }
}

async function seedLearningItem(id: string, status: string, completedAt: Date | null = null) {
  await testDb()
    .insert(learning_item)
    .values({
      id,
      source: 'manual',
      title: id,
      content: 'content',
      knowledge_ids: ['k_zhi'],
      status,
      completed_at: completedAt,
      created_at: BASE,
      updated_at: BASE,
    });
}

async function seedRecordTargets(): Promise<void> {
  const db = testDb();
  await db.insert(artifact).values({
    id: 'art_note',
    type: 'note_long',
    title: '之的笔记',
    knowledge_ids: ['k_zhi'],
    intent_source: 'manual',
    source: 'manual',
    generation_status: 'ready',
    created_at: BASE,
    updated_at: BASE,
  });
  await seedLearningItem('li_active', 'in_progress');
  await db.insert(learning_record).values({
    id: 'rec_open',
    kind: 'open_question',
    title: '之到底是什么',
    content_md: '总是把之误判成代词。',
    source: 'manual',
    capture_mode: 'text',
    activity_kind: 'ask',
    processing_status: 'raw',
    origin_event_id: null,
    subject_id: 'wenyan',
    knowledge_ids: [],
    question_id: null,
    attempt_event_id: null,
    learning_item_id: null,
    artifact_id: null,
    source_document_id: null,
    asset_refs: [],
    payload: {},
    created_at: BASE,
    updated_at: BASE,
  });
}

describe('Wave 3 proposal/action DomainTools', () => {
  beforeEach(async () => {
    await resetDb();
    __resetRegistryForTests();
    __resetBootstrapForTests();
    mockRunner.runTask.mockReset();
  });

  it('registerCoreTools exposes Wave 3 proposal and write tools', () => {
    registerCoreTools();

    expect(getTool('propose_knowledge_edge')).toBe(proposeKnowledgeEdgeTool);
    expect(getTool('attribute_mistake')).toBe(attributeMistakeTool);
    expect(
      listTools({ effect: 'propose' })
        .map((tool) => tool.name)
        .sort(),
    ).toEqual([
      'propose_knowledge_edge',
      'propose_knowledge_mutation',
      'propose_learning_item_completion',
      'propose_learning_item_relearn',
      'propose_record_links',
      'propose_record_promotion',
      'propose_variant',
    ]);
    expect(listTools({ effect: 'write' }).map((tool) => tool.name)).toEqual(['attribute_mistake']);
  });

  it('propose_knowledge_edge validates graph guardrails and writes an edge proposal', async () => {
    const db = testDb();
    await seedKnowledgeGraph();

    const proposed = await proposeKnowledgeEdgeTool.execute(ctx(), {
      from_knowledge_id: 'k_zhi',
      to_knowledge_id: 'k_er',
      relation_type: 'contrasts_with',
      weight: 0.7,
      reasoning: '同一类虚词经常混淆。',
      evidence_event_ids: ['att_failure'],
    });
    expect(proposed.status).toBe('proposed');

    const row = (
      await db
        .select()
        .from(event)
        .where(eq(event.id, proposed.proposal_id as string))
    )[0];
    expect(row).toMatchObject({
      action: 'propose',
      subject_kind: 'knowledge_edge',
      actor_kind: 'agent',
    });
    expect(row.payload).toMatchObject({
      from_knowledge_id: 'k_zhi',
      to_knowledge_id: 'k_er',
      relation_type: 'contrasts_with',
    });

    const pendingDup = await proposeKnowledgeEdgeTool.execute(ctx(), {
      from_knowledge_id: 'k_zhi',
      to_knowledge_id: 'k_er',
      relation_type: 'contrasts_with',
      weight: 0.7,
      reasoning: 'duplicate',
    });
    expect(pendingDup.status).toBe('skipped:duplicate_pending');

    const reversePendingDup = await proposeKnowledgeEdgeTool.execute(ctx(), {
      from_knowledge_id: 'k_er',
      to_knowledge_id: 'k_zhi',
      relation_type: 'contrasts_with',
      weight: 0.7,
      reasoning: 'same symmetric edge in reverse',
    });
    expect(reversePendingDup.status).toBe('skipped:duplicate_pending');

    await db.insert(knowledge_edge).values({
      id: 'edge_live',
      from_knowledge_id: 'k_er',
      to_knowledge_id: 'k_zhi',
      relation_type: 'prerequisite',
      weight: 1,
      created_by: 'user' as never,
      created_at: BASE,
    });
    const liveDup = await proposeKnowledgeEdgeTool.execute(ctx(), {
      from_knowledge_id: 'k_er',
      to_knowledge_id: 'k_zhi',
      relation_type: 'prerequisite',
      weight: 1,
      reasoning: 'already real',
    });
    expect(liveDup.status).toBe('skipped:duplicate_live_edge');

    await db.insert(knowledge_edge).values({
      id: 'edge_live_symmetric',
      from_knowledge_id: 'k_er',
      to_knowledge_id: 'k_zhi',
      relation_type: 'related_to',
      weight: 1,
      created_by: 'user' as never,
      created_at: BASE,
    });
    const liveReverseDup = await proposeKnowledgeEdgeTool.execute(ctx(), {
      from_knowledge_id: 'k_zhi',
      to_knowledge_id: 'k_er',
      relation_type: 'related_to',
      weight: 1,
      reasoning: 'same symmetric edge already exists in reverse',
    });
    expect(liveReverseDup.status).toBe('skipped:duplicate_live_edge');

    const parentOnly = await proposeKnowledgeEdgeTool.execute(ctx(), {
      from_knowledge_id: 'k_zhi',
      to_knowledge_id: 'k_wenyan',
      relation_type: 'related_to',
      weight: 1,
      reasoning: 'this repeats the tree',
    });
    expect(parentOnly.status).toBe('skipped:parent_semantic_duplicate');

    const crossSubject = await proposeKnowledgeEdgeTool.execute(ctx(), {
      from_knowledge_id: 'k_zhi',
      to_knowledge_id: 'k_math',
      relation_type: 'related_to',
      weight: 1,
      reasoning: 'bad boundary',
    });
    expect(crossSubject.status).toBe('skipped:cross_subject');
  });

  it('propose_knowledge_mutation writes proposal-only knowledge mutation events', async () => {
    await seedKnowledgeGraph();

    const out = await proposeKnowledgeMutationTool.execute(ctx(), {
      mutation: 'propose_new',
      payload: { name: '判断句', parent_id: 'k_wenyan' },
      reasoning: '错题显示需要补一个判断句节点。',
      evidence_event_ids: ['att_failure'],
    });

    expect(out.status).toBe('proposed');
    const rows = await listProposalInboxRows(testDb(), { status: 'pending' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: out.proposal_id,
      kind: 'knowledge_node',
      payload: {
        proposed_change: { name: '判断句', parent_id: 'k_wenyan' },
        evidence_refs: [{ kind: 'event', id: 'att_failure' }],
      },
    });
    const eventRow = (
      await testDb()
        .select()
        .from(event)
        .where(eq(event.id, out.proposal_id as string))
    )[0];
    expect(eventRow).toMatchObject({
      actor_ref: 'agent:maintenance',
      caused_by_event_id: null,
    });
  });

  it('propose_knowledge_mutation rejects merge proposals missing expected_versions entries', async () => {
    await seedKnowledgeGraph();

    const out = await proposeKnowledgeMutationTool.execute(ctx(), {
      mutation: 'merge',
      payload: {
        from_ids: ['k_zhi', 'k_er'],
        into_id: 'k_wenyan',
        expected_versions: { k_zhi: 0 },
      },
      reasoning: 'Merge two redundant child nodes.',
    });

    expect(out).toMatchObject({
      status: 'skipped:invalid_payload',
      reason: expect.stringContaining('expected_versions'),
    });
    await expect(listProposalInboxRows(testDb(), { status: 'pending' })).resolves.toHaveLength(0);
  });

  it('attribute_mistake delegates to AttributionTask and skips existing/non-failure attempts', async () => {
    const db = testDb();
    await seedKnowledgeGraph();
    await seedQuestionAndFailure();
    mockRunner.runTask.mockResolvedValueOnce({
      task_run_id: 'tr_attr_model',
      text: JSON.stringify({
        primary_category: 'concept',
        secondary_categories: ['method'],
        analysis_md: '把结构助词误判成代词。',
        confidence: 0.91,
      }),
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 20 },
      cost_usd: 0,
    });

    const written = await attributeMistakeTool.execute(ctx(), { attempt_event_id: 'att_failure' });
    expect(written.status).toBe('written');
    expect(written.cause?.primary_category).toBe('concept');
    const [taskKind, taskInput, taskCtx] = mockRunner.runTask.mock.calls[0];
    expect(taskKind).toBe('AttributionTask');
    expect(taskInput).toMatchObject({ wrong_answer_md: '代词' });
    expect(taskCtx).toHaveProperty('db');

    const skipped = await attributeMistakeTool.execute(ctx(), { attempt_event_id: 'att_failure' });
    expect(skipped.status).toBe('skipped:existing_judge');
    expect(mockRunner.runTask).toHaveBeenCalledTimes(1);

    await writeEvent(db, {
      id: 'att_success',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q_zhi',
      outcome: 'success',
      payload: {
        answer_md: '结构助词',
        answer_image_refs: [],
        referenced_knowledge_ids: ['k_zhi'],
      },
      created_at: new Date(BASE.getTime() + 3_000),
    });
    const nonFailure = await attributeMistakeTool.execute(ctx(), {
      attempt_event_id: 'att_success',
    });
    expect(nonFailure.status).toBe('skipped:not_failure_attempt');
  });

  it('attribute_mistake reports existing_judge when the owner path loses an attribution race', async () => {
    const db = testDb();
    await seedKnowledgeGraph();
    await seedQuestionAndFailure();
    const spy = vi
      .spyOn(attributeModule, 'runAttributionAndWriteJudgeEvent')
      .mockImplementationOnce(async ({ db: innerDb, attemptEventId }) => {
        await writeEvent(innerDb, {
          id: 'judge_race_winner',
          actor_kind: 'agent',
          actor_ref: 'attribution',
          action: 'judge',
          subject_kind: 'event',
          subject_id: attemptEventId,
          outcome: 'success',
          payload: {
            cause: {
              primary_category: 'concept',
              secondary_categories: [],
              analysis_md: '另一条 attribution 调用先写入。',
              confidence: 0.8,
            },
            referenced_knowledge_ids: ['k_zhi'],
          },
          caused_by_event_id: attemptEventId,
          created_at: new Date(BASE.getTime() + 4_000),
        });
      });

    const raced = await attributeMistakeTool.execute(ctx(), { attempt_event_id: 'att_failure' });

    expect(raced).toMatchObject({
      status: 'skipped:existing_judge',
      judge_event_id: 'judge_race_winner',
    });
    expect(mockRunner.runTask).not.toHaveBeenCalled();
    spy.mockRestore();
    const judges = await db.select().from(event).where(eq(event.action, 'judge'));
    expect(judges).toHaveLength(1);
  });

  it('propose_variant reuses runVariantGen rules and creates a variant proposal ledger row', async () => {
    const db = testDb();
    await seedKnowledgeGraph();
    await seedQuestionAndFailure({ withJudge: true });
    mockRunner.runTask.mockResolvedValueOnce({
      task_run_id: 'tr_variant_model',
      text: JSON.stringify({
        prompt_md: '解释「之」在新句中的用法。',
        reference_md: '结构助词。',
        difficulty: 3,
        reasoning: '同一错因变式。',
      }),
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 20 },
      cost_usd: 0,
    });

    const generated = await proposeVariantTool.execute(ctx(), { attempt_event_id: 'att_failure' });
    expect(generated.status).toBe('generated');
    expect(generated.proposal_ids).toHaveLength(1);
    expect(generated.mistake_variant_ids).toHaveLength(1);

    const variants = await db.select().from(mistake_variant);
    expect(variants).toHaveLength(1);
    expect(variants[0]).toMatchObject({
      parent_question_id: 'q_zhi',
      proposal_event_id: generated.proposal_ids[0],
      status: 'draft',
      cause_category: 'concept',
    });

    const second = await proposeVariantTool.execute(ctx(), { attempt_event_id: 'att_failure' });
    expect(second.status).toBe('skipped:already_has_variant');
  });

  it('LearningItem tools write completion/relearn proposals without changing item status', async () => {
    const db = testDb();
    await seedKnowledgeGraph();
    await seedLearningItem('li_active', 'in_progress');
    await seedLearningItem('li_done', 'done', new Date(BASE.getTime() - 3 * 86_400_000));

    const completion = await proposeLearningItemCompletionTool.execute(ctx(), {
      learning_item_id: 'li_active',
      triggering_signals: ['check_all_passed'],
      evidence_event_ids: ['ev_check'],
      reasoning: 'All embedded checks passed.',
    });
    expect(completion.status).toBe('proposed');
    const active = (
      await db
        .select({ status: learning_item.status })
        .from(learning_item)
        .where(eq(learning_item.id, 'li_active'))
    )[0];
    expect(active.status).toBe('in_progress');

    const duplicate = await proposeLearningItemCompletionTool.execute(ctx(), {
      learning_item_id: 'li_active',
      triggering_signals: ['check_all_passed'],
      reasoning: 'repeat',
    });
    expect(duplicate.status).toBe('skipped:duplicate_pending');

    const relearn = await proposeLearningItemRelearnTool.execute(ctx(), {
      learning_item_id: 'li_done',
      current_mastery: 0.35,
      peak_mastery: 0.9,
      reasoning: 'Mastery dropped after completion.',
    });
    expect(relearn.status).toBe('proposed');

    const invalid = await proposeLearningItemRelearnTool.execute(ctx(), {
      learning_item_id: 'li_active',
      current_mastery: 0.5,
      reasoning: 'not done yet',
    });
    expect(invalid.status).toBe('skipped:invalid_state');
  });

  it('record tools validate targets and write proposal drafts only', async () => {
    const db = testDb();
    await seedKnowledgeGraph();
    await seedQuestionAndFailure({ withJudge: true });
    await seedRecordTargets();

    const links = await proposeRecordLinksTool.execute(ctx(), {
      record_id: 'rec_open',
      proposed_links: [
        {
          target_kind: 'knowledge',
          target_id: 'k_zhi',
          relation: 'about',
          confidence: 0.8,
          reasoning: 'Record asks about this node.',
        },
        {
          target_kind: 'question',
          target_id: 'q_zhi',
          relation: 'follow_up',
          confidence: 0.7,
          reasoning: 'The failed question is a good follow-up.',
        },
        {
          target_kind: 'learning_item',
          target_id: 'li_active',
          relation: 'evidence_for',
          confidence: 0.6,
          reasoning: 'It supports the active learning item.',
        },
        {
          target_kind: 'artifact',
          target_id: 'art_note',
          relation: 'source_for',
          confidence: 0.5,
          reasoning: 'It can improve the note.',
        },
      ],
      evidence_event_ids: ['att_failure'],
    });
    expect(links.status).toBe('proposed');

    const recAfterLinks = (
      await db
        .select({ status: learning_record.processing_status })
        .from(learning_record)
        .where(eq(learning_record.id, 'rec_open'))
    )[0];
    expect(recAfterLinks.status).toBe('linked');

    const promotion = await proposeRecordPromotionTool.execute(ctx(), {
      record_id: 'rec_open',
      target: 'learning_item',
      reasoning: 'Turn this open question into an item.',
      draft: { title: '复盘之的用法' },
    });
    expect(promotion.status).toBe('proposed');

    const rows = await listProposalInboxRows(db, { status: 'pending' });
    expect(rows.map((row) => row.kind).sort()).toEqual(['record_links', 'record_promotion']);
    expect(
      rows.find((row) => row.kind === 'record_promotion')?.payload.proposed_change,
    ).toMatchObject({
      record_id: 'rec_open',
      target: 'learning_item',
    });

    const badTarget = await proposeRecordLinksTool.execute(ctx(), {
      record_id: 'rec_open',
      proposed_links: [
        {
          target_kind: 'artifact',
          target_id: 'missing_artifact',
          relation: 'source_for',
          confidence: 0.5,
          reasoning: 'missing',
        },
      ],
    });
    expect(badTarget.status).toBe('skipped:unknown_target');
  });
});
