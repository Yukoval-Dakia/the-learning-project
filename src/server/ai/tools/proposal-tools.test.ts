import * as attributeModule from '@/capabilities/knowledge/server/attribute';
import { runWriteProposal } from '@/capabilities/knowledge/server/review';
import {
  artifact,
  event,
  knowledge,
  knowledge_edge,
  learning_item,
  learning_record,
  mistake_variant,
  question,
  tool_call_log,
} from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { getProposalInboxRow, listProposalInboxRows } from '@/server/proposals/inbox';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { __resetBootstrapForTests, registerCoreTools } from './bootstrap';
import { buildMcpServerFromRegistry } from './mcp-bridge';
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

// PR #219 review fix — exercise the rubric-reject logging via the REAL bridge.
// Mock the Agent SDK so `tool()` captures the handler instead of spawning Claude
// (same pattern as mcp-bridge.integration.test.ts).
const mockSdk = vi.hoisted(() => ({
  toolDefs: [] as Array<{ name: string; handler: (args: unknown) => Promise<unknown> }>,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn((opts: unknown) => ({ type: 'sdk', instance: opts })),
  tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: unknown) => {
    const def = { name, handler } as (typeof mockSdk.toolDefs)[number];
    mockSdk.toolDefs.push(def);
    return def;
  }),
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

// P5.4 / YUK-143 — a recent, judge-backed failure attempt that references BOTH
// k_zhi and k_er, i.e. the "same answer confuses two usages" §4.3 confusion
// evidence the contrasts_with predicate requires. createdAt must be within the
// 30-day rubric window of the current clock.
async function seedConfusionEvidence(attemptId: string, createdAt: Date): Promise<void> {
  const db = testDb();
  const questionId = `q_${attemptId}`;
  await db.insert(question).values({
    id: questionId,
    kind: 'short_answer',
    prompt_md: '辨析「之」与「而」在句中的用法',
    reference_md: '「之」结构助词；「而」连词。',
    knowledge_ids: ['k_zhi', 'k_er'],
    source: 'manual',
    difficulty: 3,
    created_at: BASE,
    updated_at: BASE,
  });
  await writeEvent(db, {
    id: attemptId,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: questionId,
    outcome: 'failure',
    payload: {
      answer_md: '都当代词用',
      answer_image_refs: [],
      referenced_knowledge_ids: ['k_zhi', 'k_er'],
    },
    created_at: createdAt,
  });
  await writeEvent(db, {
    id: `judge_${attemptId}`,
    actor_kind: 'agent',
    actor_ref: 'attribution',
    action: 'judge',
    subject_kind: 'event',
    subject_id: attemptId,
    outcome: 'success',
    payload: {
      cause: {
        primary_category: 'concept',
        secondary_categories: [],
        analysis_md: '用户把「之」「而」两个虚词的用法相互混淆。',
        confidence: 0.9,
      },
      referenced_knowledge_ids: ['k_zhi', 'k_er'],
    },
    caused_by_event_id: attemptId,
    created_at: new Date(createdAt.getTime() + 500),
  });
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
      // ADR-0032 D8 — unified author_question front door (effect='propose').
      'author_question',
      'propose_knowledge_edge',
      'propose_knowledge_mutation',
      'propose_learning_item_archive',
      'propose_learning_item_completion',
      'propose_learning_item_defer',
      'propose_learning_item_relearn',
      'propose_record_links',
      'propose_record_promotion',
      'propose_variant',
    ]);
    expect(
      listTools({ effect: 'write' })
        .map((tool) => tool.name)
        .sort(),
    ).toEqual([
      'add_option',
      'attribute_mistake',
      // ADR-0033 D6 (YUK-306 lane D) — interactive artifact create (copilot-
      // written HTML → versioned type='interactive' artifact).
      'author_artifact',
      // YUK-195 — question structure-edit write tools (draft layer).
      'merge_questions',
      'reassign_figure',
      'set_question_type',
      'split_stem',
      // ADR-0033 D6 (YUK-306 lane D) — interactive artifact iterate (full-html
      // replace, version bump + history append).
      'update_artifact',
      'update_prompt',
      // ADR-0031 / RP-2 (YUK-304 lane B) — copilot 组卷 write (draft-allowed,
      // opposite precondition from write_review_plan).
      'write_quiz',
      // YUK-203 U4 — ReviewPlanTask's single mutation (paper tool_quiz artifact).
      'write_review_plan',
    ]);
  });

  it('propose_knowledge_edge validates graph guardrails and writes an edge proposal', async () => {
    const db = testDb();
    await seedKnowledgeGraph();
    // P5.4 / YUK-143 — the rubric (isAgent: true) now requires strong,
    // judge-backed confusion evidence for a contrasts_with edge. Seed two recent
    // judge-backed failures that reference BOTH endpoints so the first proposal
    // passes the §4.2 strong floor + the §4.3 confusion predicate.
    // PR #219 review fix — recency is measured against Date.now() + the 30d
    // window, so these MUST be Date.now()-relative (not fixed BASE, which would
    // expire past the window and turn CI red after ~30 days). 1–2 days inside.
    await seedConfusionEvidence('conf_1', new Date(Date.now() - 1 * 86_400_000));
    await seedConfusionEvidence('conf_2', new Date(Date.now() - 2 * 86_400_000));

    const proposed = await proposeKnowledgeEdgeTool.execute(ctx(), {
      from_knowledge_id: 'k_zhi',
      to_knowledge_id: 'k_er',
      relation_type: 'contrasts_with',
      weight: 0.7,
      reasoning: 'attempt conf_1 与 conf_2 的 judge cause 均指向用户把「之」「而」用法混淆。',
      evidence_event_ids: ['conf_1', 'conf_2'],
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

  // ADR-0032 D4-E1 (YUK-203) — propose_knowledge_edge op:'archive' branch.
  it('propose_knowledge_edge op=archive proposes soft-deleting a live edge (no evidence floor)', async () => {
    const db = testDb();
    await seedKnowledgeGraph();
    await db.insert(knowledge_edge).values({
      id: 'edge_to_archive',
      from_knowledge_id: 'k_zhi',
      to_knowledge_id: 'k_er',
      relation_type: 'related_to',
      weight: 1,
      created_by: 'user' as never,
      created_at: BASE,
    });

    // Archive carries NO evidence_event_ids — it must NOT be folded for
    // evidence_missing (that is a create-only rubric gate).
    const archived = await proposeKnowledgeEdgeTool.execute(ctx(), {
      op: 'archive',
      edge_id: 'edge_to_archive',
      reasoning: '这条 related_to 边其实只是树父子关系的重复，建议归档。',
    });
    expect(archived.status).toBe('proposed');
    expect(archived.proposal_id).toBeTruthy();

    const row = (
      await db
        .select()
        .from(event)
        .where(eq(event.id, archived.proposal_id as string))
    )[0];
    expect(row).toMatchObject({ action: 'propose', subject_kind: 'knowledge_edge' });
    expect(row.payload).toMatchObject({
      edge_op: 'archive',
      archive_edge_id: 'edge_to_archive',
      from_knowledge_id: 'k_zhi',
      to_knowledge_id: 'k_er',
      relation_type: 'related_to',
    });

    // A second archive of the SAME edge dedups (pending cooldown).
    const dup = await proposeKnowledgeEdgeTool.execute(ctx(), {
      op: 'archive',
      edge_id: 'edge_to_archive',
      reasoning: '再次归档同一条边。',
    });
    expect(dup.status).toBe('skipped:duplicate_pending');
  });

  it('propose_knowledge_edge op=archive skips unknown or already-archived edges', async () => {
    const db = testDb();
    await seedKnowledgeGraph();

    const unknown = await proposeKnowledgeEdgeTool.execute(ctx(), {
      op: 'archive',
      edge_id: 'edge_does_not_exist',
      reasoning: '归档一条不存在的边。',
    });
    expect(unknown.status).toBe('skipped:edge_not_found');

    await db.insert(knowledge_edge).values({
      id: 'edge_already_archived',
      from_knowledge_id: 'k_zhi',
      to_knowledge_id: 'k_er',
      relation_type: 'related_to',
      weight: 1,
      created_by: 'user' as never,
      created_at: BASE,
      archived_at: BASE,
    });
    const alreadyArchived = await proposeKnowledgeEdgeTool.execute(ctx(), {
      op: 'archive',
      edge_id: 'edge_already_archived',
      reasoning: '归档一条已归档的边。',
    });
    expect(alreadyArchived.status).toBe('skipped:edge_not_found');
  });

  it('propose_knowledge_edge op=archive without edge_id is rejected', async () => {
    await seedKnowledgeGraph();
    const missing = await proposeKnowledgeEdgeTool.execute(ctx(), {
      op: 'archive',
      reasoning: '缺少 edge_id 的归档请求。',
    });
    expect(missing.status).toBe('skipped:edge_not_found');
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

// P5.4 / YUK-143 — proposal quality rubric enforcement (Layer 1).
describe('P5.4 rubric enforcement — propose_knowledge_edge', () => {
  beforeEach(async () => {
    await resetDb();
    __resetRegistryForTests();
    __resetBootstrapForTests();
    mockRunner.runTask.mockReset();
    mockSdk.toolDefs = [];
  });

  it('rejects an evidence-free agent edge and folds it as a rubric_rejected propose event (RB-6)', async () => {
    const db = testDb();
    await seedKnowledgeGraph();

    const rejected = await proposeKnowledgeEdgeTool.execute(ctx(), {
      from_knowledge_id: 'k_zhi',
      to_knowledge_id: 'k_er',
      relation_type: 'related_to',
      weight: 1,
      reasoning: 'attempt e_x 显示用户在 k_zhi 上失败。',
    });
    expect(rejected.status).toBe('skipped:rubric_rejected');
    expect(rejected.gate).toBe('evidence_missing');
    expect(rejected.proposal_id).toBeTruthy();

    // RB-6 — the propose event is folded (still written) with the marker.
    const row = (
      await db
        .select()
        .from(event)
        .where(eq(event.id, rejected.proposal_id as string))
    )[0];
    expect(row.action).toBe('propose');
    expect(row.subject_kind).toBe('knowledge_edge');
    expect(
      (row.payload as { rubric_verdict?: { ok?: boolean; gate?: string } }).rubric_verdict,
    ).toMatchObject({ ok: false, gate: 'evidence_missing' });

    // PR #219 review fix — tool_call_log is the mcp-bridge wrapper's concern, NOT
    // execute()'s. Calling execute() directly (here) writes NO tool_call_log row;
    // the bridge-driven path is asserted separately below ("logs exactly ONE
    // tool_call_log row …"). This avoids the pre-fix double-count where execute()
    // wrote an explicit log AND the bridge logged the same call.
    const logs = await db
      .select()
      .from(tool_call_log)
      .where(eq(tool_call_log.tool_name, 'propose_knowledge_edge'));
    expect(logs).toHaveLength(0);

    // RB-7 — the folded proposal derives a terminal 'rubric_rejected' status,
    // NOT 'pending'.
    const inboxRow = await getProposalInboxRow(db, rejected.proposal_id as string);
    expect(inboxRow?.status).toBe('rubric_rejected');
    const pending = await listProposalInboxRows(db, { status: 'pending' });
    expect(pending).toHaveLength(0);
  });

  it('via mcp-bridge: a rubric-rejected propose call logs exactly ONE tool_call_log row with the verdict in output_json (not error_reason)', async () => {
    const db = testDb();
    await seedKnowledgeGraph();

    // Drive the tool through the REAL bridge so we exercise the same logging
    // path Copilot/Dreaming/Coach use. The Agent SDK is mocked (see top of file)
    // so `tool()` captures the handler; we invoke it directly.
    buildMcpServerFromRegistry({
      ctx: ctx(),
      serverName: 'loom_v2',
      toolNames: ['propose_knowledge_edge'],
    });
    const def = mockSdk.toolDefs.find((d) => d.name === 'propose_knowledge_edge');
    if (!def) throw new Error('propose_knowledge_edge not wired into the mocked SDK');

    const result = (await def.handler({
      from_knowledge_id: 'k_zhi',
      to_knowledge_id: 'k_er',
      relation_type: 'related_to',
      weight: 1,
      reasoning: 'attempt e_x 显示用户在 k_zhi 上失败。',
    })) as { content: Array<{ type: 'text'; text: string }> };
    const parsed = JSON.parse(result.content[0].text) as {
      output?: { status?: string; gate?: string };
    };
    expect(parsed.output?.status).toBe('skipped:rubric_rejected');

    // Exactly ONE tool_call_log row for this DomainTool call (no double-count).
    const logs = await db
      .select()
      .from(tool_call_log)
      .where(eq(tool_call_log.tool_name, 'propose_knowledge_edge'));
    expect(logs).toHaveLength(1);
    expect(logs[0].effect).toBe('propose');
    // A soft rubric reject is NOT a hard failure: error_reason stays null and the
    // verdict is preserved in output_json (traceability without mis-flagging).
    expect(logs[0].error_reason).toBeNull();
    expect(logs[0].output_json).toMatchObject({
      status: 'skipped:rubric_rejected',
      gate: 'evidence_missing',
    });
  });

  it('RB-7 (load-bearing): a rubric-rejected proposal on K does NOT block a later valid proposal on K', async () => {
    const db = testDb();
    await seedKnowledgeGraph();

    // 1) Rubric-rejected (evidence-free) edge on key K = (k_zhi -> k_er, related_to).
    const rejected = await proposeKnowledgeEdgeTool.execute(ctx(), {
      from_knowledge_id: 'k_zhi',
      to_knowledge_id: 'k_er',
      relation_type: 'related_to',
      weight: 1,
      reasoning: 'attempt e_x 显示用户在 k_zhi 上失败。',
    });
    expect(rejected.status).toBe('skipped:rubric_rejected');

    // The folded proposal must NOT count as live-pending for the same key.
    expect(
      await getProposalInboxRow(db, rejected.proposal_id as string).then((r) => r?.status),
    ).toBe('rubric_rejected');

    // 2) A valid (strong, judge-backed, endpoint-referencing) proposal on the
    //    SAME key K must be accepted as 'proposed', not skipped:duplicate_pending.
    // PR #219 review fix — Date.now()-relative within the 30d window (see above).
    await seedConfusionEvidence('rb7_1', new Date(Date.now() - 1 * 86_400_000));
    await seedConfusionEvidence('rb7_2', new Date(Date.now() - 2 * 86_400_000));
    const valid = await proposeKnowledgeEdgeTool.execute(ctx(), {
      from_knowledge_id: 'k_zhi',
      to_knowledge_id: 'k_er',
      relation_type: 'related_to',
      weight: 1,
      reasoning: 'attempt rb7_1 与 rb7_2 的 judge cause 指向用户在 k_zhi/k_er 反复失败。',
      evidence_event_ids: ['rb7_1', 'rb7_2'],
    });
    expect(valid.status).toBe('proposed');
    expect(valid.status).not.toBe('skipped:duplicate_pending');
  });

  it('both write paths call the validator: legacy MCP runWriteProposal also rejects an evidence-free agent edge', async () => {
    const db = testDb();
    await seedKnowledgeGraph();

    const result = await runWriteProposal(db, {
      payload: {
        mutation: 'propose_knowledge_edge',
        from_knowledge_id: 'k_zhi',
        to_knowledge_id: 'k_er',
        relation_type: 'related_to',
      },
      reasoning: 'attempt e_x 显示用户在 k_zhi 上失败。',
    });
    expect(result.kind).toBe('rubric_rejected');
    if (result.kind !== 'rubric_rejected') throw new Error(`unexpected kind ${result.kind}`);
    expect(result.gate).toBe('evidence_missing');

    // Folded, not live-pending.
    const inboxRow = await getProposalInboxRow(db, result.event_id);
    expect(inboxRow?.status).toBe('rubric_rejected');
  });

  it('user-edited proposal (isAgent:false) is structural-only — same evidence-free edge passes', async () => {
    const db = testDb();
    await seedKnowledgeGraph();

    const userCtx: ToolContext = {
      db,
      taskRunId: 'tr_user',
      callerActor: { kind: 'user', ref: 'user:self' },
    };
    const proposed = await proposeKnowledgeEdgeTool.execute(userCtx, {
      from_knowledge_id: 'k_zhi',
      to_knowledge_id: 'k_er',
      relation_type: 'related_to',
      weight: 1,
      reasoning: '二者相关', // generic — but user path skips reasoning + evidence gates
    });
    expect(proposed.status).toBe('proposed');
  });
});

// P5.6 / YUK-178 — explicit model labeling via the optional suggestion_kind arg
// (AC-3, SK-5) + the rubric round-trip (AC-10, §12 PIN 10). There is NO
// soft-fail/result_count coercion (that mechanism is dropped, §2) — the only way
// a propose-tool proposal becomes corrective is the model setting the arg.
describe('P5.6 suggestion_kind on propose tools (YUK-178)', () => {
  beforeEach(async () => {
    await resetDb();
    __resetRegistryForTests();
    __resetBootstrapForTests();
    mockRunner.runTask.mockReset();
    mockSdk.toolDefs = [];
  });

  function aiProposalKind(payload: unknown): string | undefined {
    return (payload as { ai_proposal?: { suggestion_kind?: string } }).ai_proposal?.suggestion_kind;
  }

  it("propose_knowledge_edge with suggestion_kind:'corrective' writes a corrective payload AND survives the rubric round-trip (AC-3 / AC-10)", async () => {
    const db = testDb();
    await seedKnowledgeGraph();
    // A strong, judge-backed confusion edge so the rubric PASSES; the marker must
    // survive parseAiProposalPayload → validateProposalQuality (§12 PIN 10).
    await seedConfusionEvidence('sk_1', new Date(Date.now() - 1 * 86_400_000));
    await seedConfusionEvidence('sk_2', new Date(Date.now() - 2 * 86_400_000));

    const corrective = await proposeKnowledgeEdgeTool.execute(ctx(), {
      from_knowledge_id: 'k_zhi',
      to_knowledge_id: 'k_er',
      relation_type: 'contrasts_with',
      weight: 0.7,
      reasoning: 'attempt sk_1 与 sk_2 的 judge cause 均指向用户把「之」「而」用法混淆。',
      evidence_event_ids: ['sk_1', 'sk_2'],
      suggestion_kind: 'corrective',
    });
    // The proposal is written (the rubric did NOT strip the marker), and it is
    // corrective on the persisted ai_proposal payload.
    expect(corrective.status).toBe('proposed');
    const row = (
      await db
        .select()
        .from(event)
        .where(eq(event.id, corrective.proposal_id as string))
    )[0];
    expect(aiProposalKind(row.payload)).toBe('corrective');
  });

  it('propose_knowledge_edge WITHOUT the arg defaults to proactive (AC-3)', async () => {
    const db = testDb();
    await seedKnowledgeGraph();
    await seedConfusionEvidence('sk_3', new Date(Date.now() - 1 * 86_400_000));
    await seedConfusionEvidence('sk_4', new Date(Date.now() - 2 * 86_400_000));

    const proactive = await proposeKnowledgeEdgeTool.execute(ctx(), {
      from_knowledge_id: 'k_zhi',
      to_knowledge_id: 'k_er',
      relation_type: 'contrasts_with',
      weight: 0.7,
      reasoning: 'attempt sk_3 与 sk_4 的 judge cause 指向用户混淆「之」「而」。',
      evidence_event_ids: ['sk_3', 'sk_4'],
      // suggestion_kind omitted → execute() threads `?? 'proactive'`.
    });
    expect(proactive.status).toBe('proposed');
    const row = (
      await db
        .select()
        .from(event)
        .where(eq(event.id, proactive.proposal_id as string))
    )[0];
    expect(aiProposalKind(row.payload)).toBe('proactive');
  });

  it('propose_knowledge_mutation threads the model-labeled suggestion_kind (AC-3)', async () => {
    const db = testDb();
    await seedKnowledgeGraph();

    const corrective = await proposeKnowledgeMutationTool.execute(ctx(), {
      mutation: 'propose_new',
      payload: { name: '判断句', parent_id: 'k_wenyan' },
      reasoning: '错题显示需要补一个判断句节点。',
      evidence_event_ids: ['att_failure'],
      suggestion_kind: 'corrective',
    });
    expect(corrective.status).toBe('proposed');
    const correctiveRow = await getProposalInboxRow(db, corrective.proposal_id as string);
    expect(correctiveRow?.payload.suggestion_kind).toBe('corrective');

    const proactive = await proposeKnowledgeMutationTool.execute(ctx(), {
      mutation: 'propose_new',
      payload: { name: '被动句', parent_id: 'k_wenyan' },
      reasoning: '另补一个被动句节点。',
      evidence_event_ids: ['att_failure'],
      // omitted → proactive
    });
    expect(proactive.status).toBe('proposed');
    const proactiveRow = await getProposalInboxRow(db, proactive.proposal_id as string);
    expect(proactiveRow?.payload.suggestion_kind).toBe('proactive');
  });

  it('propose_record_links / propose_record_promotion thread the model-labeled suggestion_kind (AC-3)', async () => {
    const db = testDb();
    await seedKnowledgeGraph();
    await seedRecordTargets();

    const links = await proposeRecordLinksTool.execute(ctx(), {
      record_id: 'rec_open',
      proposed_links: [
        {
          target_kind: 'knowledge',
          target_id: 'k_zhi',
          relation: 'about',
          confidence: 0.8,
          reasoning: '这条记录在讨论「之」的用法。',
        },
      ],
      suggestion_kind: 'corrective',
    });
    expect(links.status).toBe('proposed');
    const linksRow = await getProposalInboxRow(db, links.proposal_id as string);
    expect(linksRow?.payload.suggestion_kind).toBe('corrective');

    const promotion = await proposeRecordPromotionTool.execute(ctx(), {
      record_id: 'rec_open',
      target: 'learning_item',
      reasoning: '把这条开放问题升级成一个学习项。',
      // omitted → proactive
    });
    expect(promotion.status).toBe('proposed');
    const promotionRow = await getProposalInboxRow(db, promotion.proposal_id as string);
    expect(promotionRow?.payload.suggestion_kind).toBe('proactive');
  });
});
