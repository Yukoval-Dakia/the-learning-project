// YUK-181: real owner/tool chains over multilingual, multi-subject fixtures.
// Model transports are always stubbed. These are data/contract integration
// tests, not evidence of a real model's pedagogical or tool-choice quality.
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptLearningIntent, planLearningIntent } from '@/capabilities/agency/public';
import { getLearningItemContextTool } from '@/capabilities/agency/server/tools/learning-item-context';
import { queryMemoryBriefTool } from '@/capabilities/copilot/server/tools/memory-brief';
import { getRecordContextTool } from '@/capabilities/ingestion/server/tools/get-record-context';
import { proposeRecordLinksTool } from '@/capabilities/ingestion/server/tools/proposal-tools';
import { queryRecordsTool } from '@/capabilities/ingestion/server/tools/query-records';
import { createLearningIntentKnowledgeNode } from '@/capabilities/knowledge/public';
import {
  expandKnowledgeSubgraphTool,
  queryKnowledgeTool,
} from '@/capabilities/knowledge/server/tools/knowledge-readers';
import { createLearningIntentNote } from '@/capabilities/notes/public';
import {
  getQuestionContextTool,
  getReviewDueTool,
} from '@/capabilities/practice/server/tools/question-context';
import { proposeVariantTool } from '@/capabilities/practice/tools/propose-variant';
import {
  event,
  knowledge,
  knowledge_edge,
  learning_item,
  learning_record,
  material_fsrs_state,
  memory_brief_note,
  mistake_variant,
  question,
} from '@/db/schema';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { seedAttempt, seedUserCause } from '../../../../tests/helpers/event-seed';
import { type AgentReadableSpec, assertAgentReadable } from './fixtures-assert';

const model = vi.hoisted(() => ({ runTask: vi.fn() }));
vi.mock('@/server/ai/runner', () => ({ runTask: model.runTask }));

function ctx(): ToolContext {
  return {
    db: testDb(),
    taskRunId: 'tr_fixture_phase2',
    callerActor: { kind: 'agent', ref: 'agent:copilot' },
  };
}

async function readable<I, O>(
  tool: DomainTool<I, O>,
  input: I,
  output: O,
  spec: AgentReadableSpec,
) {
  expect(tool.outputSchema.parse(output)).toEqual(output);
  await assertAgentReadable(testDb(), tool as DomainTool, input, output, spec);
}

async function seedTree(domain: string, prefix: string, names: string[]) {
  const now = new Date(Date.now() - 60_000);
  await testDb()
    .insert(knowledge)
    .values(
      names.map((name, index) => ({
        id: `${prefix}_${index}`,
        name,
        domain: index === 0 ? domain : null,
        parent_id: index === 0 ? null : `${prefix}_0`,
        created_at: now,
        updated_at: now,
      })),
    );
}

async function seedQuestion(id: string, kc: string, prompt: string) {
  const now = new Date(Date.now() - 60_000);
  await testDb()
    .insert(question)
    .values({
      id,
      kind: 'short_answer',
      prompt_md: prompt,
      reference_md: 'Explain the reasoning and check the stated conditions.',
      knowledge_ids: [kc],
      source: 'manual',
      difficulty: 3,
      created_at: now,
      updated_at: now,
    });
}

function card(due: Date) {
  return {
    due,
    stability: 2,
    difficulty: 5,
    elapsed_days: 1,
    scheduled_days: 3,
    learning_steps: 0,
    reps: 2,
    lapses: 0,
    state: 'review' as const,
    last_review: new Date(Date.now() - 86_400_000),
  };
}

beforeEach(async () => {
  await resetDb();
  model.runTask.mockReset();
  model.runTask.mockRejectedValue(new Error('unexpected model invocation in fixture'));
});

describe('YUK-181 current tool chains', () => {
  it('math due rows lead to the same question context; future and unknown counts stay distinct', async () => {
    const db = testDb();
    await seedTree('math', 'math', ['代数', '分式方程', '二次函数']);
    await seedQuestion(
      'q_fraction',
      'math_1',
      '解方程 1/(x−1)=2，并说明 x≠1 的限制；验根时不要将分母为零的值保留。',
    );
    await seedQuestion('q_parabola', 'math_2', '比较 y=(x−2)^2−3 的顶点与零点，分别说明几何意义。');
    await seedAttempt({
      id: 'att_fraction',
      question_id: 'q_fraction',
      knowledge_ids: ['math_1'],
      answer_md: 'x=1；两边同时乘分母，所以原式恒成立。',
    });
    await db.insert(material_fsrs_state).values({
      id: 'future_math',
      subject_kind: 'knowledge',
      subject_id: 'math_2',
      state: card(new Date(Date.now() + 86_400_000)),
      due_at: new Date(Date.now() + 86_400_000),
      updated_at: new Date(),
    });
    const input = { knowledgeIds: ['math_1', 'math_2'], limit: 10 };
    const due = await getReviewDueTool.execute(ctx(), input);
    expect(due.rows.map((row) => row.question_id)).toEqual(['q_fraction']);
    expect(due.queue_assertion).toMatchObject({
      cleared: false,
      actionable_due_total_count: null,
      actionable_due_returned_count: 1,
      queued_entity_count: null,
    });
    expect(due.future_projection_coverage.total_future_count).toBe(1);
    await readable(getReviewDueTool, input, due, {
      keyInsightFields: ['queue_scope', 'queue_coverage.completeness', 'rows.0.reason'],
      idRefs: [
        { path: 'rows[].question_id', table: 'question' },
        { path: 'rows[].knowledge_ids[]', table: 'knowledge' },
      ],
    });
    const selected = due.rows[0].question_id;
    const detail = await getQuestionContextTool.execute(ctx(), { questionId: selected });
    expect(detail.question?.id).toBe(selected);
    await readable(getQuestionContextTool, { questionId: selected }, detail, {
      keyInsightFields: ['question.id', 'question.prompt_md'],
      idRefs: [{ path: 'question.id', table: 'question' }],
    });
    const empty = await getReviewDueTool.execute(ctx(), { knowledgeIds: ['math_2'] });
    expect(empty.rows).toEqual([]);
    expect(empty.queue_assertion.cleared).toBeNull();
    expect(empty.queue_coverage.supports_exhaustive_zero_claim).toBe(false);
    expect(model.runTask).not.toHaveBeenCalled();
  });

  it('reading-note search → full context → bounded link proposal does not apply links before acceptance', async () => {
    const db = testDb();
    await seedTree('english', 'read', [
      'Critical reading',
      'Claim and evidence',
      'Confounding variables',
    ]);
    const content =
      '# Reading notes\n\nThe author says “correlation is not causation”.\n\n- Claim: ice cream sales predict drowning.\n- Confounder: summer temperature.\n- Counterexample: the same pattern does not establish a causal intervention.\n\n```text\nP(Y | X) ≠ P(Y | do(X))\n```\n\n我的疑问：例子是否支持作者的全部结论？保留这条不确定性。';
    const now = new Date();
    await db.insert(learning_record).values({
      id: 'rec_reading',
      kind: 'note',
      title: 'Correlation and causal claims',
      content_md: content,
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'reading',
      processing_status: 'raw',
      subject_id: 'english',
      knowledge_ids: ['read_1'],
      created_at: now,
      updated_at: now,
    });
    const query = { query: 'causation', knowledgeIds: ['read_1'] };
    const found = await queryRecordsTool.execute(ctx(), query);
    expect(found.rows.map((row) => row.record_id)).toEqual(['rec_reading']);
    await readable(queryRecordsTool, query, found, {
      keyInsightFields: ['rows.0.excerpt', 'claim_boundaries.zero_rows_scope'],
      idRefs: [
        { path: 'rows[].record_id', table: 'learning_record' },
        { path: 'rows[].knowledge_ids[]', table: 'knowledge' },
      ],
    });
    const recordId = found.rows[0].record_id;
    const context = await getRecordContextTool.execute(ctx(), { recordId });
    expect(context.record?.content_md).toBe(content);
    await readable(getRecordContextTool, { recordId }, context, {
      keyInsightFields: ['record.content_md', 'record.processing_status'],
      idRefs: [{ path: 'record.id', table: 'learning_record' }],
    });
    const input = {
      record_id: recordId,
      proposed_links: [
        {
          target_kind: 'knowledge' as const,
          target_id: 'read_2',
          relation: 'about' as const,
          confidence: 0.8,
          reasoning:
            'The note distinguishes observed correlation from a causal claim; it does not prove mastery.',
        },
      ],
    };
    const before = await db.select().from(learning_record).where(eq(learning_record.id, recordId));
    const proposed = await proposeRecordLinksTool.execute(ctx(), input);
    expect(proposed.status).toBe('proposed');
    await readable(proposeRecordLinksTool, input, proposed, {
      keyInsightFields: ['status', 'proposal_id'],
      idRefs: [
        { path: 'proposal_id', table: 'event' },
        { path: 'record_id', table: 'learning_record' },
      ],
    });
    await expect(
      readable(
        proposeRecordLinksTool,
        input,
        { ...proposed, record_id: proposed.proposal_id },
        { keyInsightFields: ['status'], idRefs: [{ path: 'record_id', table: 'learning_record' }] },
      ),
    ).rejects.toThrow('does not resolve');
    if (!proposed.proposal_id) throw new Error('fixture link proposal missing');
    const [receipt] = await db.select().from(event).where(eq(event.id, proposed.proposal_id));
    expect(receipt.payload).toMatchObject({
      ai_proposal: {
        kind: 'record_links',
        evidence_refs: [{ kind: 'record', id: recordId }],
        proposed_change: { record_id: recordId, links: input.proposed_links },
      },
    });
    const [after] = await db.select().from(learning_record).where(eq(learning_record.id, recordId));
    // Proposal creation legitimately moves the processing workflow to linked.
    // It must not apply the proposed target or rewrite the captured content.
    expect(after).toEqual({
      ...before[0],
      processing_status: 'linked',
      version: before[0].version + 1,
      updated_at: expect.any(Date),
    });
    expect(after.knowledge_ids).not.toContain('read_2');
    expect((await proposeRecordLinksTool.execute(ctx(), input)).status).toBe(
      'skipped:duplicate_pending',
    );
    expect(model.runTask).not.toHaveBeenCalled();
  });

  it('an English variant preserves attempt/cause identity, remains a proposal, and does not regenerate on replay', async () => {
    const db = testDb();
    await seedTree('english', 'eng', ['English grammar', 'Counterfactual conditionals']);
    await seedQuestion(
      'q_conditional',
      'eng_1',
      'Explain the difference: If I knew, I would tell you / If I had known, I would have told you. Include the time each refers to.',
    );
    await seedAttempt({
      id: 'att_conditional',
      question_id: 'q_conditional',
      knowledge_ids: ['eng_1'],
      answer_md: 'Both describe facts about yesterday; would always marks past tense.',
    });
    await seedUserCause({
      id: 'cause_conditional',
      attempt_event_id: 'att_conditional',
      primary_category: 'concept',
      user_notes: 'Confuses hypothetical present with an unreal past condition.',
    });
    model.runTask.mockResolvedValueOnce({
      task_run_id: 'tr_variant_stub',
      text: JSON.stringify({
        prompt_md:
          'Rewrite “I did not see the warning, so I did not stop” as a counterfactual. Explain why the condition is not factual.',
        reference_md:
          'If I had seen the warning, I would have stopped. The past perfect marks an unreal past condition.',
        difficulty: 3,
        reasoning: 'Checks the same tense/time misconception in a different situation.',
      }),
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 20 },
      cost_usd: 0,
    });
    const input = { attempt_event_id: 'att_conditional' };
    const result = await proposeVariantTool.execute(ctx(), input);
    expect(result.status).toBe('generated');
    expect(result.variant_question_ids).toEqual([]);
    expect(result.proposal_ids).toHaveLength(1);
    expect(result.mistake_variant_ids).toHaveLength(1);
    await readable(proposeVariantTool, input, result, {
      keyInsightFields: ['status', 'reasoning_summary'],
      idRefs: [
        { path: 'proposal_ids[]', table: 'event' },
        { path: 'mistake_variant_ids[]', table: 'mistake_variant' },
      ],
    });
    const [variant] = await db
      .select()
      .from(mistake_variant)
      .where(eq(mistake_variant.id, result.mistake_variant_ids[0]));
    expect(variant.parent_question_id).toBe('q_conditional');
    expect(variant.proposal_event_id).toBe(result.proposal_ids[0]);
    const [proposal] = await db.select().from(event).where(eq(event.id, result.proposal_ids[0]));
    expect(proposal.caused_by_event_id).toBe('cause_conditional');
    if (!proposal.caused_by_event_id) throw new Error('variant proposal lost its cause');
    const [cause] = await db.select().from(event).where(eq(event.id, proposal.caused_by_event_id));
    expect(cause.caused_by_event_id).toBe('att_conditional');
    expect(await db.select({ id: question.id }).from(question)).toEqual([{ id: 'q_conditional' }]);
    expect((await proposeVariantTool.execute(ctx(), input)).status).toBe(
      'skipped:already_has_variant',
    );
    expect(model.runTask).toHaveBeenCalledTimes(1);
    expect(model.runTask.mock.calls[0][0]).toBe('VariantGenTask');
    expect(model.runTask.mock.calls[0][1]).toMatchObject({
      original_question: { id: 'q_conditional', knowledge_ids: ['eng_1'] },
      attempt: {
        wrong_answer_md: 'Both describe facts about yesterday; would always marks past tense.',
      },
      cause: { primary_category: 'concept' },
      depth: 0,
    });
    await expect(
      readable(
        proposeVariantTool,
        input,
        { ...result, mistake_variant_ids: result.proposal_ids },
        {
          keyInsightFields: ['status'],
          idRefs: [{ path: 'mistake_variant_ids[]', table: 'mistake_variant' }],
        },
      ),
    ).rejects.toThrow('does not resolve');
  });

  it('memory brief exposes scoped evidence and freshness without turning missing/unknown into zero', async () => {
    const db = testDb();
    await seedTree('english', 'mem', ['English', 'Counterfactuals']);
    await seedQuestion(
      'q_memory',
      'mem_1',
      'Which counterfactual refers to an unreal past situation? Explain your evidence.',
    );
    await seedAttempt({
      id: 'att_memory',
      question_id: 'q_memory',
      knowledge_ids: ['mem_1'],
      answer_md:
        'The past perfect might refer to the earlier condition; I am not certain about would have.',
    });
    const now = new Date();
    await db.insert(memory_brief_note).values([
      {
        id: 'brief_english',
        scope_key: 'subject:english',
        subject_id: 'english',
        recent_week_md:
          'The learner confuses time reference and grammatical tense; one attempt is not a stable trait.',
        recent_months_md: 'Several short grammar notes remain unverified.',
        long_term_md: 'Insufficient evidence for a long-term preference.',
        recent_week_evidence_ids: ['att_memory'],
        recent_months_evidence_ids: [],
        long_term_evidence_ids: [],
        source_event_id: 'att_memory',
        long_term_freshness_score: null,
        refreshed_at: now,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'brief_global',
        scope_key: 'global',
        recent_week_md: 'Historical summary; verify sources.',
        refreshed_at: new Date(now.getTime() - 3 * 86_400_000),
        created_at: now,
        updated_at: now,
      },
    ]);
    const input = { scopeKey: 'subject:english', includeEvidence: true };
    const brief = await queryMemoryBriefTool.execute(ctx(), input);
    expect(brief.freshness.state).toBe('fresh');
    expect(brief.note?.long_term_freshness_score).toBeNull();
    await readable(queryMemoryBriefTool, input, brief, {
      keyInsightFields: ['note.recent_week_md', 'freshness.state'],
      idRefs: [
        { path: 'note.id', table: 'memory_brief_note' },
        { path: 'note.source_event_id', table: 'event' },
        { path: 'evidence.recent_week_ids[]', table: 'event' },
        { path: 'evidence.recent_months_ids[]', table: 'event' },
        { path: 'evidence.long_term_ids[]', table: 'event' },
      ],
    });
    if (!brief.note) throw new Error('fixture brief is missing');
    await expect(
      readable(
        queryMemoryBriefTool,
        input,
        { ...brief, note: { ...brief.note, id: 'att_memory' } },
        {
          keyInsightFields: ['freshness.state'],
          idRefs: [{ path: 'note.id', table: 'memory_brief_note' }],
        },
      ),
    ).rejects.toThrow('does not resolve');
    const stale = await queryMemoryBriefTool.execute(ctx(), { scopeKey: 'global' });
    expect(stale.freshness.state).toBe('stale');
    expect(stale.note?.id).toBe('brief_global');
    const missing = await queryMemoryBriefTool.execute(ctx(), { scopeKey: 'subject:math' });
    expect(missing).toMatchObject({ note: null, freshness: { state: 'missing', age_ms: null } });
    await readable(queryMemoryBriefTool, { scopeKey: 'subject:math' }, missing, {
      keyInsightFields: ['freshness.state'],
      idRefs: [],
    });
    expect(model.runTask).not.toHaveBeenCalled();
  });

  it('a math learning intent stays proposed until explicit acceptance, then its items are readable', async () => {
    const db = testDb();
    await seedTree('math', 'intent', ['条件概率', '样本空间', '条件概率公式']);
    const runTaskFn = vi.fn(async () => ({
      task_run_id: 'tr_intent_stub',
      text: JSON.stringify({
        hub: {
          title: '条件概率路线',
          summary_md: '先明确条件缩小后的样本空间，再使用 P(A|B)=P(A∩B)/P(B)，检查 P(B)>0。',
        },
        atomics: [
          {
            knowledge_id: 'intent_1',
            title: '限定样本空间',
            one_line_intent: '辨认有放回和无放回抽样的不同条件。',
          },
          {
            knowledge_id: 'intent_2',
            title: '使用条件概率公式',
            one_line_intent: '说明分母为零时公式为什么不可用。',
          },
        ],
      }),
      cost_usd: 0,
    }));
    const proposal = await planLearningIntent({ db, topic: '条件概率', runTaskFn });
    expect(proposal.plan_case).toBe('3c_existing_graph');
    expect(proposal.atomics.map((item) => item.knowledge_id)).toEqual(['intent_1', 'intent_2']);
    expect(await db.select().from(learning_item)).toEqual([]);
    const [receipt] = await db.select().from(event).where(eq(event.id, proposal.proposal_id));
    expect(receipt.payload).toMatchObject({ ai_proposal: { kind: 'learning_item' } });
    const accepted = await acceptLearningIntent({
      db,
      proposalId: proposal.proposal_id,
      createKnowledgeNode: createLearningIntentKnowledgeNode,
      createNote: createLearningIntentNote,
    });
    expect(accepted.atomic_learning_item_ids).toHaveLength(2);
    for (const id of [accepted.hub_learning_item_id, ...accepted.atomic_learning_item_ids]) {
      const input = { learningItemId: id };
      const context = await getLearningItemContextTool.execute(ctx(), input);
      expect(context.item?.id).toBe(id);
      if (!context.primary_artifact) throw new Error('accepted item has no artifact');
      await expect(
        readable(
          getLearningItemContextTool,
          input,
          { ...context, primary_artifact: { ...context.primary_artifact, id } },
          {
            keyInsightFields: ['item.id'],
            idRefs: [{ path: 'primary_artifact.id', table: 'artifact' }],
          },
        ),
      ).rejects.toThrow('does not resolve');
      await readable(getLearningItemContextTool, input, context, {
        keyInsightFields: ['item.id', 'item.title', 'item.status'],
        idRefs: [
          { path: 'item.id', table: 'learning_item' },
          { path: 'primary_artifact.id', table: 'artifact' },
          { path: 'knowledge_context[].knowledge_id', table: 'knowledge' },
        ],
      });
    }
    expect(runTaskFn).toHaveBeenCalledTimes(1);
    expect(model.runTask).not.toHaveBeenCalled();
  });

  it('programming prerequisites retain direction and do not absorb similarly named English nodes', async () => {
    const db = testDb();
    // Programming is corpus content for a generic graph reader, not a new
    // executable judge profile. Reading notes likewise remain record categories.
    await seedTree('programming', 'code', [
      'Programming',
      'Lexical scope',
      'Closures',
      'Async callbacks',
    ]);
    await seedTree('english', 'language', ['English', 'Scope of a claim']);
    const now = new Date();
    await db.insert(knowledge_edge).values([
      {
        id: 'edge_scope_closure',
        from_knowledge_id: 'code_1',
        to_knowledge_id: 'code_2',
        relation_type: 'prerequisite',
        weight: 0.9,
        created_by: { by: 'user' },
        reasoning:
          'A closure captures bindings from lexical scope, not a copied snapshot of every value.',
        created_at: now,
      },
      {
        id: 'edge_closure_async',
        from_knowledge_id: 'code_2',
        to_knowledge_id: 'code_3',
        relation_type: 'prerequisite',
        weight: 0.8,
        created_by: { by: 'user' },
        reasoning: 'An async callback can outlive the frame that defined its captured variables.',
        created_at: now,
      },
    ]);
    const query = { subjectId: 'programming', query: 'Closures' };
    const found = await queryKnowledgeTool.execute(ctx(), query);
    expect(found.nodes.map((node) => node.id)).toEqual(['code_2']);
    await readable(queryKnowledgeTool, query, found, {
      keyInsightFields: ['lookup_status', 'query_scope.subject_domain'],
      idRefs: [{ path: 'nodes[].id', table: 'knowledge' }],
    });
    const input = {
      centerNodeId: found.nodes[0].id,
      include: ['neighbors' as const],
      relationTypes: ['prerequisite' as const],
    };
    const graph = await expandKnowledgeSubgraphTool.execute(ctx(), input);
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(['code_1', 'code_2', 'code_3']);
    expect(graph.paths.map((path) => [path.from, path.to])).toEqual(
      expect.arrayContaining([
        ['code_1', 'code_2'],
        ['code_2', 'code_3'],
      ]),
    );
    expect(graph.paths.map((path) => [path.from, path.to])).not.toContainEqual([
      'code_2',
      'code_1',
    ]);
    await readable(expandKnowledgeSubgraphTool, input, graph, {
      keyInsightFields: ['center.id', 'nodes[].role', 'paths[].relation_type'],
      idRefs: [
        { path: 'center.id', table: 'knowledge' },
        { path: 'nodes[].id', table: 'knowledge' },
        { path: 'edges[].from', table: 'knowledge' },
        { path: 'edges[].to', table: 'knowledge' },
        { path: 'paths[].from', table: 'knowledge' },
        { path: 'paths[].to', table: 'knowledge' },
      ],
    });
    expect(model.runTask).not.toHaveBeenCalled();
  });
});
