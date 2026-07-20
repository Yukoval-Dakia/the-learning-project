// Q3 — search-grounded QuizGen handler DB test
// (docs/superpowers/specs/2026-06-02-quizgen-search-grounded-design.md §3 / §4).
//
// Mocks the AI (runAgentTaskFn) + the chained quiz_verify enqueue. Asserts:
//   - questions INSERT with draft_status='draft' (Option B — NOT in the pool),
//     source='quiz_gen', metadata.quiz_gen (generation_status='ready', agent
//     self copy_safety, source_refs, source_pack), source_ref = trigger pointer,
//     created_by = aiAgentRef('QuizGenTask', ...), rubric_json from the agent.
//   - the Tavily remote MCP + in-process domain-tool MCP are mounted, and the
//     allowedTools fold in TAVILY_MCP_ALLOWED_TOOLS only when a Tavily config is
//     present (env-gated graceful degradation).
//   - quiz_verify is enqueued with { question_ids } on success.

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveSourceTier } from '@/core/schema/provenance';
import {
  artifact,
  event,
  knowledge,
  learning_item,
  material_fsrs_state,
  question,
  source_document,
} from '@/db/schema';
import { TAVILY_MCP_ALLOWED_TOOLS, TAVILY_MCP_SERVER_NAME } from '@/server/ai/mcp/tavily';
import { DOMAIN_TOOL_MCP_SERVER_NAME, toMcpAllowedToolName } from '@/server/ai/tools/allowlists';
import {
  buildCoverageEvidenceDemand,
  buildSupplyTrace,
  evidenceDemandToTargetContext,
} from '@/server/question-supply/evidence-demand';
import { canonicalQuestionContentHash } from '@/server/quiz/content-fingerprint';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  QUIZ_GEN_READ_TOOLS,
  buildQuizGenHandler,
  embedMaterialInPrompt,
  runQuizGen,
  synthesizeMaterialSourceRefs,
} from './quiz_gen';

const FAKE_TAVILY_CONFIG = {
  type: 'http' as const,
  url: 'https://mcp.tavily.com/mcp/?tavilyApiKey=test',
};

// The ctx shape the handler passes to its runAgentTaskFn seam (db + mcpServers +
// allowedTools). Declared here so `mock.calls[0]` carries it (typed tuple).
type AgentCtx = {
  db: unknown;
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
};
// Typed agent-mock factory: gives mock.calls[0] the [kind, input, ctx] tuple so
// destructuring the recorded ctx typechecks (the bare vi.fn(async () => …) has
// no declared params → calls[0] is `[]`).
function agentMock(output: string, taskRunId?: string) {
  return vi.fn(async (_kind: string, _input: unknown, _ctx: AgentCtx) =>
    taskRunId === undefined ? { text: output } : { text: output, task_run_id: taskRunId },
  );
}

function twoPartyBarrier() {
  let arrivals = 0;
  let release: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrivals += 1;
    if (arrivals === 2) release?.();
    await ready;
  };
}

const SEMANTIC_REFERENCE_SOLUTION = {
  expected_signals: ['说明「之」用于主谓之间并取消句子独立性'],
  final_answer: '「之」用在主谓之间，取消句子独立性。',
  answer_equivalents: [],
};

const EXACT_REFERENCE_SOLUTION = {
  expected_signals: ['选择主谓间助词'],
  final_answer: '主谓间助词',
  answer_equivalents: [],
};

const MATERIAL_REFERENCE_SOLUTION = {
  expected_signals: ['答出汉朝建立年份'],
  final_answer: '公元前 202 年',
  answer_equivalents: ['前 202 年'],
};

const VALID_OUTPUT = JSON.stringify({
  questions: [
    {
      kind: 'short_answer',
      prompt_md: '用你自己的话解释「之」作主谓间助词的作用。',
      reference_md: '「之」用在主谓之间，取消句子独立性，使其充当更大句子的成分。',
      choices_md: null,
      judge_kind_override: 'semantic',
      rubric_json: {
        criteria: [{ name: 'correctness', weight: 1, descriptor: '说明取消独立性' }],
        required_points: ['用在主谓之间', '取消句子独立性'],
        reference_solution: SEMANTIC_REFERENCE_SOLUTION,
      },
      difficulty: 3,
      knowledge_ids: ['k1'],
      source_refs: [
        {
          url: 'https://example.edu/wenyan/zhi',
          title: '文言虚词「之」',
          snippet: '之用于主谓之间…',
          used_for: 'fact',
          extracted: true,
        },
      ],
    },
    {
      kind: 'choice',
      prompt_md: '下列句中「之」属于哪种用法？',
      reference_md: '主谓间助词',
      choices_md: ['主谓间助词', '代词', '动词'],
      judge_kind_override: 'exact',
      rubric_json: {
        criteria: [{ name: 'correctness', weight: 1, descriptor: '选对选项' }],
        reference_solution: EXACT_REFERENCE_SOLUTION,
      },
      difficulty: 2,
      knowledge_ids: ['k1'],
      source_refs: [
        {
          url: 'https://example.edu/wenyan/zhi',
          title: '文言虚词「之」',
          used_for: 'inspiration',
          extracted: false,
        },
      ],
    },
  ],
  source_pack: {
    query_plan: ['文言 之 主谓间 用法', '之 取消句子独立性 例句'],
    searched_at: '2026-06-02T10:00:00.000Z',
    tool: 'tavily',
  },
  generation_method: 'search_grounded',
  self_copy_safety: { verdict: 'original', max_overlap: 0.12, checked_by: 'agent_self' },
});

// V1 LOW — agent lies about copy_safety.checked_by, claiming 'quiz_verify' (a
// check it never ran). The gen handler must override it back to 'agent_self'.
const FORGED_CHECKED_BY_OUTPUT = JSON.stringify({
  questions: [
    {
      kind: 'short_answer',
      prompt_md: '用你自己的话解释「之」作主谓间助词的作用。',
      reference_md: '「之」用在主谓之间，取消句子独立性。',
      choices_md: null,
      judge_kind_override: 'semantic',
      rubric_json: {
        criteria: [{ name: 'correctness', weight: 1, descriptor: '说明取消独立性' }],
        required_points: ['用在主谓之间', '取消句子独立性'],
        reference_solution: SEMANTIC_REFERENCE_SOLUTION,
      },
      difficulty: 3,
      knowledge_ids: ['k1'],
      source_refs: [
        {
          url: 'https://example.edu/wenyan/zhi',
          title: '文言虚词「之」',
          used_for: 'fact',
          extracted: true,
        },
      ],
    },
  ],
  source_pack: {
    query_plan: ['文言 之 主谓间 用法'],
    searched_at: '2026-06-02T10:00:00.000Z',
    tool: 'tavily',
  },
  generation_method: 'search_grounded',
  // Forged: agent claims quiz_verify already cleared it.
  self_copy_safety: { verdict: 'original', max_overlap: 0.05, checked_by: 'quiz_verify' },
});

const ZERO_QUESTIONS_OUTPUT = JSON.stringify({
  questions: [],
  source_pack: { query_plan: [], searched_at: '2026-06-02T10:00:00.000Z', tool: 'tavily' },
  generation_method: 'closed_book',
  self_copy_safety: { verdict: 'unknown', checked_by: 'agent_self' },
});

// A closed_book run with a real question (closed_book legitimately carries empty
// source_refs). Used by the pinned-method tests so the agent's generation_method
// MATCHES the pin (F1 asserts the pin held).
const CLOSED_BOOK_OUTPUT = JSON.stringify({
  questions: [
    {
      kind: 'short_answer',
      prompt_md: '解释「之」作主谓间助词的作用。',
      reference_md: '「之」用在主谓之间，取消句子独立性。',
      choices_md: null,
      judge_kind_override: 'semantic',
      rubric_json: {
        criteria: [{ name: 'correctness', weight: 1, descriptor: '说明取消独立性' }],
        required_points: ['用在主谓之间', '取消句子独立性'],
        reference_solution: SEMANTIC_REFERENCE_SOLUTION,
      },
      difficulty: 3,
      knowledge_ids: ['k1'],
      source_refs: [],
    },
  ],
  source_pack: { query_plan: [], searched_at: '2026-06-02T10:00:00.000Z', tool: 'tavily' },
  generation_method: 'closed_book',
  self_copy_safety: { verdict: 'unknown', checked_by: 'agent_self' },
});

// YUK-224 (slice 3, tier 3) — material_grounded run: the agent self-reports a REAL
// fetched passage in `material`; the handler persists it to source_document and
// back-fills material_source_document_id onto every question's metadata.quiz_gen.
const MATERIAL_PASSAGE = '汉朝由刘邦建立于公元前 202 年，定都长安，国号「汉」。';
const MATERIAL_OUTPUT = JSON.stringify({
  questions: [
    {
      kind: 'reading',
      prompt_md: '阅读下面短文，回答：汉朝建立于哪一年？',
      reference_md: '公元前 202 年。',
      choices_md: null,
      judge_kind_override: 'semantic',
      rubric_json: {
        criteria: [{ name: 'correctness', weight: 1, descriptor: '答对建立年份' }],
        required_points: ['公元前 202 年'],
        reference_solution: MATERIAL_REFERENCE_SOLUTION,
      },
      difficulty: 2,
      knowledge_ids: ['k1'],
      source_refs: [
        {
          url: 'https://example.edu/han/founding',
          title: '汉朝的建立',
          snippet: '汉朝建立于公元前 202 年。',
          used_for: 'fact',
          extracted: true,
        },
      ],
    },
  ],
  source_pack: {
    query_plan: ['汉朝 建立 年份 原文'],
    searched_at: '2026-06-06T10:00:00.000Z',
    tool: 'tavily',
  },
  generation_method: 'material_grounded',
  self_copy_safety: { verdict: 'original', max_overlap: 0.1, checked_by: 'agent_self' },
  material: {
    body_md: MATERIAL_PASSAGE,
    url: 'https://example.edu/han/founding',
    title: '汉朝的建立',
    fetched_at: '2026-06-06T10:00:00.000Z',
  },
});

async function seedKnowledge(opts: { id: string; domain?: string | null }) {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values({
    id: opts.id,
    name: '之',
    domain: opts.domain ?? 'yuwen',
    parent_id: null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedLearningItem(opts: { id: string; knowledgeId: string }) {
  const db = testDb();
  const now = new Date();
  await db.insert(learning_item).values({
    id: opts.id,
    source: 'manual',
    source_ref: null,
    title: '之的用法',
    content: '',
    knowledge_ids: [opts.knowledgeId],
    status: 'pending',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

describe('runQuizGen', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('inserts draft questions with source=quiz_gen + metadata.quiz_gen, and enqueues quiz_verify', async () => {
    await seedKnowledge({ id: 'k1' });
    const runAgentTaskFn = agentMock(VALID_OUTPUT, 'tr_1');
    const enqueueQuizVerify = vi.fn(async () => {});
    const buildTavilyMcpServerFn = vi.fn(() => FAKE_TAVILY_CONFIG);
    const buildMcpServerFn = vi.fn(() => ({ name: 'fake-loom' }) as never);
    const supplyTrace = buildSupplyTrace(
      {
        targetId: 'target-quiz-1',
        targetFingerprint: 'fp-quiz-1',
        context: evidenceDemandToTargetContext(
          buildCoverageEvidenceDemand({
            subjectId: 'yuwen',
            knowledgeIds: ['k1'],
            statement: 'collect application evidence',
          }),
        ),
      },
      'quiz_gen',
    );

    const result = await runQuizGen({
      db: testDb(),
      trigger: 'knowledge',
      refId: 'k1',
      count: 2,
      runAgentTaskFn,
      enqueueQuizVerify,
      buildTavilyMcpServerFn,
      buildMcpServerFn,
      supplyTrace,
    });

    expect(result.status).toBe('ready');
    expect(result.question_ids).toHaveLength(2);
    expect(result.tool_quiz_artifact_id).toEqual(expect.any(String));

    const rows = await testDb().select().from(question).where(eq(question.source, 'quiz_gen'));
    expect(rows).toHaveLength(2);

    const byPrompt = new Map(rows.map((r) => [r.prompt_md, r]));
    const q1 = byPrompt.get('用你自己的话解释「之」作主谓间助词的作用。');
    expect(q1).toBeDefined();
    // Option B — generated drafts do NOT enter the pool until quiz_verify passes.
    expect(q1?.draft_status).toBe('draft');
    expect(q1?.source).toBe('quiz_gen');
    // trigger pointer (knowledge_id), NOT a web URL.
    expect(q1?.source_ref).toBe('k1');
    expect(q1?.knowledge_ids).toEqual(['k1']);
    expect(q1?.difficulty).toBe(3);
    expect(q1?.judge_kind_override).toBe('semantic');
    expect(q1?.rubric_json).toMatchObject({
      required_points: ['用在主谓之间', '取消句子独立性'],
      reference_solution: SEMANTIC_REFERENCE_SOLUTION,
    });
    expect(q1?.created_by).toMatchObject({
      by: 'ai',
      task_kind: 'QuizGenTask',
      task_run_id: 'tr_1',
    });

    // metadata.quiz_gen lands: status + agent self copy_safety + source_refs + source_pack.
    const meta = (q1?.metadata as Record<string, unknown> | null)?.quiz_gen as
      | Record<string, unknown>
      | undefined;
    expect(meta).toBeDefined();
    expect(meta?.generation_status).toBe('ready');
    expect(meta?.generation_method).toBe('search_grounded');
    expect(meta?.copy_safety).toMatchObject({ verdict: 'original', checked_by: 'agent_self' });
    expect(meta?.source_pack).toMatchObject({ tool: 'tavily' });
    expect(Array.isArray(meta?.source_refs)).toBe(true);
    expect((meta?.source_refs as unknown[]).length).toBe(1);
    const difficultyEvidence = (q1?.metadata as Record<string, unknown>).difficulty_evidence;
    expect(difficultyEvidence).toMatchObject({
      value: q1?.difficulty,
      scale: 'loom_difficulty_1_5',
      basis: 'producer_estimate',
      source_route: 'quiz_gen',
    });
    expect((q1?.metadata as Record<string, unknown>).supply_trace).toMatchObject({
      ...supplyTrace,
      difficulty_evidence: difficultyEvidence,
    });

    // YUK-203 P2 — generated quizzes become a first-class question-set artifact.
    const quizArtifacts = await testDb()
      .select()
      .from(artifact)
      .where(eq(artifact.id, result.tool_quiz_artifact_id ?? ''));
    expect(quizArtifacts).toHaveLength(1);
    const quizArtifact = quizArtifacts[0];
    expect(quizArtifact.type).toBe('tool_quiz');
    expect(quizArtifact.title).toBe('之 组卷');
    expect(quizArtifact.knowledge_ids).toEqual(['k1']);
    expect(quizArtifact.intent_source).toBe('quiz_gen');
    expect(quizArtifact.source).toBe('ai_generated');
    expect(quizArtifact.source_ref).toBe('k1');
    expect(quizArtifact.tool_kind).toBe('quiz_gen');
    expect(quizArtifact.generation_status).toBe('ready');
    expect(quizArtifact.verification_status).toBe('not_required');
    expect(quizArtifact.generated_by).toMatchObject({
      by: 'ai',
      task_kind: 'QuizGenTask',
      task_run_id: 'tr_1',
    });
    expect(quizArtifact.attrs).toMatchObject({
      trigger: 'knowledge',
      generation_method: 'search_grounded',
    });
    expect(quizArtifact.tool_state).toMatchObject({
      question_ids: result.question_ids,
      session_meta: {
        trigger: 'knowledge',
        ref_id: 'k1',
        generation_method: 'search_grounded',
      },
    });

    const quizEvents = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:quiz_gen'));
    expect(quizEvents).toHaveLength(1);
    expect(quizEvents[0].payload).toMatchObject({
      question_ids: result.question_ids,
      tool_quiz_artifact_id: result.tool_quiz_artifact_id,
      supply_trace: supplyTrace,
      difficulty_evidence: expect.arrayContaining([
        expect.objectContaining({
          evidence: expect.objectContaining({ source_route: 'quiz_gen' }),
        }),
      ]),
    });

    // quiz_verify enqueued with the new question ids.
    expect(enqueueQuizVerify).toHaveBeenCalledTimes(1);
    expect(enqueueQuizVerify).toHaveBeenCalledWith(result.question_ids, expect.any(Object));
  });

  it('merges the target KC into an exact duplicate, inserts the remaining question, and audits both', async () => {
    await seedKnowledge({ id: 'k1' });
    const output = JSON.parse(VALID_OUTPUT) as {
      questions: Array<{
        kind: string;
        prompt_md: string;
        reference_md: string;
        choices_md: string[] | null;
        rubric_json: unknown;
      }>;
    };
    const content = output.questions[0];
    const hash = canonicalQuestionContentHash({
      promptMd: content.prompt_md,
      referenceMd: content.reference_md,
      choicesMd: content.choices_md,
      rubricJson: content.rubric_json,
    });
    await testDb()
      .insert(question)
      .values({
        id: 'q-existing-quiz-exact',
        kind: content.kind,
        prompt_md: content.prompt_md,
        reference_md: content.reference_md,
        choices_md: content.choices_md,
        rubric_json: content.rubric_json as never,
        source: 'manual',
        draft_status: 'draft',
        knowledge_ids: ['k-existing'],
        canonical_content_hash: hash,
        created_at: new Date(),
        updated_at: new Date(),
      });
    const enqueueQuizVerify = vi.fn(async () => {});

    const result = await runQuizGen({
      db: testDb(),
      trigger: 'knowledge',
      refId: 'k1',
      count: 2,
      runAgentTaskFn: agentMock(VALID_OUTPUT, 'tr-quiz-merge'),
      enqueueQuizVerify,
      buildTavilyMcpServerFn: () => FAKE_TAVILY_CONFIG,
      buildMcpServerFn: () => ({ name: 'fake-loom' }) as never,
    });

    expect(result.question_ids).toHaveLength(1);
    expect(enqueueQuizVerify).toHaveBeenCalledWith(result.question_ids, expect.any(Object));
    const [existing] = await testDb()
      .select()
      .from(question)
      .where(eq(question.id, 'q-existing-quiz-exact'));
    expect(existing).toMatchObject({
      knowledge_ids: ['k-existing', 'k1'],
      draft_status: 'draft',
      version: 1,
    });
    const [mergeEvent] = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:question_edit'));
    expect(mergeEvent).toMatchObject({
      actor_ref: 'quiz_gen',
      subject_id: 'q-existing-quiz-exact',
      payload: {
        before: { knowledge_ids: ['k-existing'] },
        after: { knowledge_ids: ['k-existing', 'k1'] },
        reason: 'cross_kc_exact_duplicate',
        task_run_id: 'tr-quiz-merge',
      },
    });
    expect(
      await testDb()
        .select()
        .from(material_fsrs_state)
        .where(eq(material_fsrs_state.subject_id, 'k1')),
    ).toHaveLength(0);
    const [producerEvent] = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:quiz_gen'));
    expect(producerEvent.payload).toMatchObject({
      exact_duplicate_count: 1,
      exact_duplicate_knowledge_merge_count: 1,
      exact_duplicates: [
        {
          existing_question_id: 'q-existing-quiz-exact',
          new_question_id: expect.any(String),
          canonical_content_hash: hash,
          source_route: 'quiz_gen',
          knowledge_merge_status: 'merged',
          added_knowledge_ids: ['k1'],
          resulting_knowledge_ids: ['k-existing', 'k1'],
          preserved_draft_status: 'draft',
        },
      ],
    });
  });

  it('replaces a terminal rejected draft instead of treating it as available supply', async () => {
    await seedKnowledge({ id: 'k1' });
    await seedKnowledge({ id: 'k2' });
    const parsed = JSON.parse(CLOSED_BOOK_OUTPUT) as {
      questions: Array<{
        kind: string;
        prompt_md: string;
        reference_md: string;
        choices_md: string[] | null;
        rubric_json: unknown;
        knowledge_ids: string[];
      }>;
    };
    // The model returns another valid KC, while k1 is the current supply target. A fresh
    // replacement must persist their union without displacing k1 as the primary family anchor.
    parsed.questions[0].knowledge_ids = ['k2'];
    const replacementOutput = JSON.stringify(parsed);
    const content = parsed.questions[0];
    const hash = canonicalQuestionContentHash({
      promptMd: content.prompt_md,
      referenceMd: content.reference_md,
      choicesMd: content.choices_md,
      rubricJson: content.rubric_json,
    });
    await testDb()
      .insert(question)
      .values({
        id: 'q-terminal-quiz-draft',
        kind: content.kind,
        prompt_md: content.prompt_md,
        reference_md: content.reference_md,
        choices_md: content.choices_md,
        rubric_json: content.rubric_json as never,
        source: 'quiz_gen',
        draft_status: 'draft',
        knowledge_ids: ['k-old'],
        canonical_content_hash: hash,
        created_at: new Date(),
        updated_at: new Date(),
      });
    await testDb().insert(event).values({
      id: 'verify-terminal-quiz-draft',
      actor_kind: 'agent',
      actor_ref: 'quiz_verify',
      action: 'experimental:quiz_verify',
      subject_kind: 'question',
      subject_id: 'q-terminal-quiz-draft',
      outcome: 'failure',
      payload: {},
      created_at: new Date(),
    });
    const enqueueQuizVerify = vi.fn(async () => {});

    const result = await runQuizGen({
      db: testDb(),
      trigger: 'knowledge',
      refId: 'k1',
      count: 1,
      generationMethod: 'closed_book',
      runAgentTaskFn: agentMock(replacementOutput, 'tr-quiz-replacement'),
      enqueueQuizVerify,
      buildTavilyMcpServerFn: () => null,
      buildMcpServerFn: () => ({ name: 'fake-loom' }) as never,
    });

    expect(result.question_ids).toHaveLength(1);
    expect(enqueueQuizVerify).toHaveBeenCalledTimes(1);
    const [rejected] = await testDb()
      .select()
      .from(question)
      .where(eq(question.id, 'q-terminal-quiz-draft'));
    expect(rejected).toMatchObject({ canonical_content_hash: null, draft_status: 'draft' });
    const [replacement] = await testDb()
      .select()
      .from(question)
      .where(eq(question.id, result.question_ids?.[0] ?? ''));
    expect(replacement).toMatchObject({
      canonical_content_hash: hash,
      draft_status: 'draft',
      knowledge_ids: ['k1', 'k2'],
    });
    const [quizArtifact] = await testDb()
      .select()
      .from(artifact)
      .where(eq(artifact.id, result.tool_quiz_artifact_id ?? ''));
    expect(quizArtifact.knowledge_ids).toEqual(['k1', 'k2']);
    const releaseEvents = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:question_edit'));
    expect(releaseEvents).toHaveLength(1);
    expect(releaseEvents[0].payload).toMatchObject({
      reason: 'terminal_draft_superseded_for_reproduction',
      task_run_id: 'tr-quiz-replacement',
    });
  });

  it('keeps artifact KC tags aligned when a later item duplicates an earlier row in the same batch', async () => {
    await seedKnowledge({ id: 'k1' });
    await seedKnowledge({ id: 'k2' });
    const parsed = JSON.parse(VALID_OUTPUT) as {
      questions: Array<{
        kind: string;
        prompt_md: string;
        reference_md: string;
        choices_md: string[] | null;
        rubric_json: unknown;
        knowledge_ids: string[];
      }>;
    };
    const first = parsed.questions[0];
    parsed.questions = [
      { ...first, knowledge_ids: ['k1'] },
      { ...first, knowledge_ids: ['k2'] },
    ];

    const result = await runQuizGen({
      db: testDb(),
      trigger: 'knowledge',
      refId: 'k1',
      count: 2,
      runAgentTaskFn: agentMock(JSON.stringify(parsed), 'tr-intra-batch-duplicate'),
      enqueueQuizVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: () => null,
      buildMcpServerFn: () => ({ name: 'fake-loom' }) as never,
    });

    expect(result.question_ids).toHaveLength(1);
    const [row] = await testDb()
      .select()
      .from(question)
      .where(eq(question.id, result.question_ids?.[0] ?? ''));
    expect(row.knowledge_ids).toEqual(['k1', 'k2']);
    const [quizArtifact] = await testDb()
      .select()
      .from(artifact)
      .where(eq(artifact.id, result.tool_quiz_artifact_id ?? ''));
    expect(quizArtifact.knowledge_ids).toEqual(['k1', 'k2']);
    const [producerEvent] = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:quiz_gen'));
    expect(producerEvent.payload).toMatchObject({
      exact_duplicate_count: 1,
      exact_duplicate_knowledge_merge_count: 1,
    });
  });

  it('reconciles a concurrent canonical-hash race into one draft with both target KCs', async () => {
    await seedKnowledge({ id: 'k1' });
    await seedKnowledge({ id: 'k2' });
    const outputFor = (knowledgeId: string) => {
      const parsed = JSON.parse(CLOSED_BOOK_OUTPUT) as {
        questions: Array<{ knowledge_ids: string[] }>;
      };
      parsed.questions[0].knowledge_ids = [knowledgeId];
      return JSON.stringify(parsed);
    };
    const barrier = twoPartyBarrier();
    const enqueueQuizVerify = vi.fn(async () => {});
    const common = {
      db: testDb(),
      trigger: 'knowledge' as const,
      count: 1,
      enqueueQuizVerify,
      buildTavilyMcpServerFn: () => null,
      buildMcpServerFn: () => ({ name: 'fake-loom' }) as never,
      afterExactDuplicateLookupMiss: barrier,
    };

    const results = await Promise.all([
      runQuizGen({ ...common, refId: 'k1', runAgentTaskFn: agentMock(outputFor('k1')) }),
      runQuizGen({ ...common, refId: 'k2', runAgentTaskFn: agentMock(outputFor('k2')) }),
    ]);

    const rows = await testDb().select().from(question).where(eq(question.source, 'quiz_gen'));
    expect(rows).toHaveLength(1);
    expect([...rows[0].knowledge_ids].sort()).toEqual(['k1', 'k2']);
    expect(rows[0]).toMatchObject({ draft_status: 'draft', version: 1 });
    expect(results.map((result) => result.question_ids?.length).sort()).toEqual([0, 1]);
    expect(enqueueQuizVerify).toHaveBeenCalledTimes(1);

    const editEvents = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:question_edit'));
    expect(editEvents).toHaveLength(1);
    expect(editEvents[0].payload).toMatchObject({
      reason: 'cross_kc_exact_duplicate',
      preserved_draft_status: 'draft',
    });
    const producerEvents = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:quiz_gen'));
    expect(producerEvents).toHaveLength(2);
    expect(producerEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            exact_duplicate_count: 1,
            exact_duplicate_knowledge_merge_count: 1,
            exact_duplicates: [
              expect.objectContaining({
                existing_question_id: rows[0].id,
                knowledge_merge_status: 'merged',
                resulting_knowledge_ids: expect.arrayContaining(['k1', 'k2']),
                preserved_draft_status: 'draft',
              }),
            ],
          }),
        }),
      ]),
    );
  });

  it('does not create a ready artifact when the whole batch is exact duplicates', async () => {
    await seedKnowledge({ id: 'k1' });
    const output = JSON.parse(VALID_OUTPUT) as {
      questions: Array<{
        kind: string;
        prompt_md: string;
        reference_md: string;
        choices_md: string[] | null;
        rubric_json: unknown;
      }>;
    };
    await testDb()
      .insert(question)
      .values(
        output.questions.map((content, index) => ({
          id: `q-existing-all-dup-${index}`,
          kind: content.kind,
          prompt_md: content.prompt_md,
          reference_md: content.reference_md,
          choices_md: content.choices_md,
          rubric_json: content.rubric_json as never,
          source: 'manual',
          draft_status: 'draft',
          canonical_content_hash: canonicalQuestionContentHash({
            promptMd: content.prompt_md,
            referenceMd: content.reference_md,
            choicesMd: content.choices_md,
            rubricJson: content.rubric_json,
          }),
          created_at: new Date(),
          updated_at: new Date(),
        })),
      );
    const enqueueQuizVerify = vi.fn(async () => {});

    const result = await runQuizGen({
      db: testDb(),
      trigger: 'knowledge',
      refId: 'k1',
      count: 2,
      runAgentTaskFn: agentMock(VALID_OUTPUT),
      enqueueQuizVerify,
      buildTavilyMcpServerFn: () => FAKE_TAVILY_CONFIG,
      buildMcpServerFn: () => ({ name: 'fake-loom' }) as never,
    });

    expect(result.question_ids).toHaveLength(0);
    expect(enqueueQuizVerify).not.toHaveBeenCalled();
    // A zero-question quiz must never surface as practicable: no artifact row.
    const artifacts = await testDb()
      .select({ id: artifact.id })
      .from(artifact)
      .where(eq(artifact.tool_kind, 'quiz_gen'));
    expect(artifacts).toHaveLength(0);
    const [producerEvent] = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:quiz_gen'));
    expect(producerEvent.payload).toMatchObject({
      count: 0,
      tool_quiz_artifact_id: null,
      exact_duplicate_count: 2,
      exact_duplicate_knowledge_merge_count: 2,
    });
  });

  it('forces copy_safety.checked_by=agent_self at gen stage, ignoring an agent-forged quiz_verify claim', async () => {
    await seedKnowledge({ id: 'k1' });
    const runAgentTaskFn = agentMock(FORGED_CHECKED_BY_OUTPUT, 'tr_forge');

    await runQuizGen({
      db: testDb(),
      trigger: 'knowledge',
      refId: 'k1',
      count: 1,
      runAgentTaskFn,
      enqueueQuizVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    const rows = await testDb().select().from(question).where(eq(question.source, 'quiz_gen'));
    expect(rows).toHaveLength(1);
    const meta = (rows[0].metadata as Record<string, unknown> | null)?.quiz_gen as
      | Record<string, unknown>
      | undefined;
    const copySafety = meta?.copy_safety as Record<string, unknown> | undefined;
    // Handler-fixed: never the agent's forged 'quiz_verify'.
    expect(copySafety?.checked_by).toBe('agent_self');
    // verdict + max_overlap are still the agent's self-assessment.
    expect(copySafety?.verdict).toBe('original');
    expect(copySafety?.max_overlap).toBe(0.05);
  });

  it('material_grounded: persists the passage to source_document + back-fills material_source_document_id (tier 3)', async () => {
    await seedKnowledge({ id: 'k1' });
    const runAgentTaskFn = agentMock(MATERIAL_OUTPUT, 'tr_mat');
    const enqueueQuizVerify = vi.fn(async () => {});

    const result = await runQuizGen({
      db: testDb(),
      trigger: 'knowledge',
      refId: 'k1',
      count: 1,
      runAgentTaskFn,
      enqueueQuizVerify,
      buildTavilyMcpServerFn: vi.fn(() => FAKE_TAVILY_CONFIG),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    expect(result.status).toBe('ready');
    expect(result.question_ids).toHaveLength(1);

    // The real fetched passage is persisted as a source_document with URL provenance.
    const docs = await testDb().select().from(source_document);
    expect(docs).toHaveLength(1);
    const doc = docs[0];
    expect(doc.body_md).toBe(MATERIAL_PASSAGE);
    expect(doc.title).toBe('汉朝的建立');
    expect(doc.provenance).toMatchObject({
      source_kind: 'quiz_gen_material',
      url: 'https://example.edu/han/founding',
      fetched_at: '2026-06-06T10:00:00.000Z',
    });

    const rows = await testDb().select().from(question).where(eq(question.source, 'quiz_gen'));
    expect(rows).toHaveLength(1);
    const q = rows[0];
    const meta = (q.metadata as Record<string, unknown> | null)?.quiz_gen as
      | Record<string, unknown>
      | undefined;
    expect(meta?.generation_method).toBe('material_grounded');
    // The persisted doc id is back-filled so deriveSourceTier lands tier 3.
    expect(meta?.material_source_document_id).toBe(doc.id);

    // End-to-end shape: deriveSourceTier on the persisted row returns tier 3 (material).
    const derived = deriveSourceTier({ source: q.source, metadata: q.metadata as never });
    expect(derived).toEqual({ tier: 3, name: 'material' });

    // The artifact records the material_grounded method too.
    const quizArtifacts = await testDb()
      .select()
      .from(artifact)
      .where(eq(artifact.id, result.tool_quiz_artifact_id ?? ''));
    expect(quizArtifacts[0].attrs).toMatchObject({ generation_method: 'material_grounded' });

    expect(enqueueQuizVerify).toHaveBeenCalledWith(result.question_ids, expect.any(Object));
  });

  it('material_grounded with multiple questions shares ONE source_document id', async () => {
    await seedKnowledge({ id: 'k1' });
    const twoQuestionMaterial = JSON.parse(MATERIAL_OUTPUT) as {
      questions: unknown[];
      [k: string]: unknown;
    };
    twoQuestionMaterial.questions = [
      twoQuestionMaterial.questions[0],
      {
        ...(twoQuestionMaterial.questions[0] as Record<string, unknown>),
        prompt_md: '阅读下面短文，回答：汉朝定都何处？',
        reference_md: '长安。',
        rubric_json: {
          criteria: [{ name: 'correctness', weight: 1, descriptor: '答对都城' }],
          required_points: ['长安'],
          reference_solution: {
            expected_signals: ['答出汉朝都城'],
            final_answer: '长安',
            answer_equivalents: [],
          },
        },
      },
    ];
    const runAgentTaskFn = agentMock(JSON.stringify(twoQuestionMaterial), 'tr_mat2');

    const result = await runQuizGen({
      db: testDb(),
      trigger: 'knowledge',
      refId: 'k1',
      count: 2,
      runAgentTaskFn,
      enqueueQuizVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    expect(result.question_ids).toHaveLength(2);
    const docs = await testDb().select().from(source_document);
    // ONE passage → ONE source_document, shared across both questions.
    expect(docs).toHaveLength(1);
    const rows = await testDb().select().from(question).where(eq(question.source, 'quiz_gen'));
    const docIds = new Set(
      rows.map(
        (r) =>
          (
            (r.metadata as Record<string, unknown> | null)?.quiz_gen as
              | Record<string, unknown>
              | undefined
          )?.material_source_document_id,
      ),
    );
    expect(docIds).toEqual(new Set([docs[0].id]));
  });

  // YUK-224 F1 (PR #314 round-1) — the learner can only see the material if it is
  // rendered with the prompt; review/practice render only reads prompt_md, so the
  // handler embeds the passage into prompt_md at persist time.
  it('material_grounded: embeds the passage into prompt_md so the learner can see the material', async () => {
    await seedKnowledge({ id: 'k1' });
    const runAgentTaskFn = agentMock(MATERIAL_OUTPUT, 'tr_mat_embed');

    await runQuizGen({
      db: testDb(),
      trigger: 'knowledge',
      refId: 'k1',
      count: 1,
      runAgentTaskFn,
      enqueueQuizVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    const rows = await testDb().select().from(question).where(eq(question.source, 'quiz_gen'));
    expect(rows).toHaveLength(1);
    // The persisted prompt_md carries BOTH the original passage text and the
    // original question stem, so a prompt-only renderer is self-contained.
    expect(rows[0].prompt_md).toContain(MATERIAL_PASSAGE);
    expect(rows[0].prompt_md).toContain('汉朝建立于哪一年');
    expect(rows[0].prompt_md).toContain('阅读材料');
  });

  // YUK-224 F3 (PR #314 round-1) — synthesize a per-question source_ref (material
  // URL + passage snippet) so quiz_verify's deterministic copy-safety overlap has
  // the passage to compare against even when the agent left source_refs thin.
  it('material_grounded: synthesizes a per-question source_ref with the passage snippet', async () => {
    await seedKnowledge({ id: 'k1' });
    // Strip the agent-declared snippet so only the synthesized ref carries one.
    const noSnippet = JSON.parse(MATERIAL_OUTPUT) as {
      questions: { source_refs: { url: string; snippet?: string }[] }[];
      [k: string]: unknown;
    };
    noSnippet.questions[0].source_refs = [
      {
        url: 'https://other.example/unrelated',
        title: 'x',
        used_for: 'inspiration',
        extracted: false,
      } as never,
    ];
    const runAgentTaskFn = agentMock(JSON.stringify(noSnippet), 'tr_mat_refs');

    await runQuizGen({
      db: testDb(),
      trigger: 'knowledge',
      refId: 'k1',
      count: 1,
      runAgentTaskFn,
      enqueueQuizVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    const rows = await testDb().select().from(question).where(eq(question.source, 'quiz_gen'));
    const meta = (rows[0].metadata as Record<string, unknown> | null)?.quiz_gen as
      | { source_refs?: { url: string; snippet?: string }[] }
      | undefined;
    const materialRef = meta?.source_refs?.find(
      (r) => r.url === 'https://example.edu/han/founding',
    );
    expect(materialRef).toBeDefined();
    // The synthesized ref carries a snippet截段 of the real passage.
    expect(materialRef?.snippet).toContain('公元前 202 年');
  });

  it('mounts Tavily + domain MCP and folds Tavily tools into allowedTools when a config is present', async () => {
    await seedKnowledge({ id: 'k1' });
    const runAgentTaskFn = agentMock(VALID_OUTPUT, 'tr_2');
    const buildTavilyMcpServerFn = vi.fn(() => FAKE_TAVILY_CONFIG);
    const buildMcpServerFn = vi.fn(() => ({ name: 'fake-loom' }) as never);

    await runQuizGen({
      db: testDb(),
      trigger: 'knowledge',
      refId: 'k1',
      runAgentTaskFn,
      enqueueQuizVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn,
      buildMcpServerFn,
    });

    expect(runAgentTaskFn).toHaveBeenCalledTimes(1);
    const [taskKind, , ctx] = runAgentTaskFn.mock.calls[0];
    expect(taskKind).toBe('QuizGenTask');
    expect(ctx.mcpServers).toHaveProperty(DOMAIN_TOOL_MCP_SERVER_NAME);
    expect(ctx.mcpServers).toHaveProperty(TAVILY_MCP_SERVER_NAME);
    // domain read tools present...
    for (const name of QUIZ_GEN_READ_TOOLS) {
      expect(ctx.allowedTools).toContain(toMcpAllowedToolName(name));
    }
    // ...and the Tavily scoped tools.
    for (const tool of TAVILY_MCP_ALLOWED_TOOLS) {
      expect(ctx.allowedTools).toContain(tool);
    }
  });

  it('does NOT register Tavily (or its tools) when buildTavilyMcpServerFn returns null', async () => {
    await seedKnowledge({ id: 'k1' });
    const runAgentTaskFn = agentMock(VALID_OUTPUT, 'tr_3');

    await runQuizGen({
      db: testDb(),
      trigger: 'knowledge',
      refId: 'k1',
      runAgentTaskFn,
      enqueueQuizVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    const [, , ctx] = runAgentTaskFn.mock.calls[0];
    expect(ctx.mcpServers).toHaveProperty(DOMAIN_TOOL_MCP_SERVER_NAME);
    expect(ctx.mcpServers).not.toHaveProperty(TAVILY_MCP_SERVER_NAME);
    for (const tool of TAVILY_MCP_ALLOWED_TOOLS) {
      expect(ctx.allowedTools).not.toContain(tool);
    }
    // domain read tools are still present (Tavily-independent).
    expect(ctx.allowedTools).toContain(toMcpAllowedToolName(QUIZ_GEN_READ_TOOLS[0]));
  });

  it('resolves a learning_item trigger and writes its id as the source_ref pointer', async () => {
    await seedKnowledge({ id: 'k1' });
    await seedLearningItem({ id: 'li1', knowledgeId: 'k1' });
    const runAgentTaskFn = agentMock(VALID_OUTPUT, 'tr_li');

    const result = await runQuizGen({
      db: testDb(),
      trigger: 'learning_item',
      refId: 'li1',
      runAgentTaskFn,
      enqueueQuizVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => FAKE_TAVILY_CONFIG),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    expect(result.status).toBe('ready');
    const rows = await testDb().select().from(question).where(eq(question.source, 'quiz_gen'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.source_ref === 'li1')).toBe(true);
  });

  it('falls back to the trigger knowledge_ids when the agent hallucinates an unknown id', async () => {
    await seedKnowledge({ id: 'k1' });
    // Agent self-reports a knowledge_id that does not exist in the graph.
    const hallucinatedOutput = JSON.stringify({
      questions: [
        {
          kind: 'short_answer',
          prompt_md: '解释「之」作主谓间助词的作用。',
          reference_md: '「之」用在主谓之间，取消句子独立性。',
          choices_md: null,
          judge_kind_override: 'semantic',
          rubric_json: {
            criteria: [{ name: 'correctness', weight: 1, descriptor: '说明取消独立性' }],
            required_points: ['用在主谓之间', '取消句子独立性'],
            reference_solution: SEMANTIC_REFERENCE_SOLUTION,
          },
          difficulty: 3,
          knowledge_ids: ['ghost_knowledge_id'],
          source_refs: [
            {
              url: 'https://example.edu/wenyan/zhi',
              title: '文言虚词「之」',
              used_for: 'fact',
              extracted: true,
            },
          ],
        },
      ],
      source_pack: {
        query_plan: ['文言 之 主谓间 用法'],
        searched_at: '2026-06-02T10:00:00.000Z',
        tool: 'tavily',
      },
      generation_method: 'search_grounded',
      self_copy_safety: { verdict: 'original', max_overlap: 0.1, checked_by: 'agent_self' },
    });
    const runAgentTaskFn = agentMock(hallucinatedOutput, 'tr_ghost');

    const result = await runQuizGen({
      db: testDb(),
      trigger: 'knowledge',
      refId: 'k1',
      count: 1,
      runAgentTaskFn,
      enqueueQuizVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    expect(result.status).toBe('ready');
    const rows = await testDb().select().from(question).where(eq(question.source, 'quiz_gen'));
    expect(rows).toHaveLength(1);
    // Hallucinated id dropped; attribution falls back to the trigger's real node.
    expect(rows[0].knowledge_ids).toEqual(['k1']);
  });

  it('preserves learning_item KC order when filtering fallback ids', async () => {
    // Deliberately insert in the opposite order from the learning_item attribution. An unordered
    // SQL IN result commonly follows physical insertion order; the handler must restore semantic
    // learning_item order so [0] remains the primary KC.
    await seedKnowledge({ id: 'k1' });
    await seedKnowledge({ id: 'k2' });
    const now = new Date();
    await testDb()
      .insert(learning_item)
      .values({
        id: 'li-ordered-fallback',
        source: 'manual',
        source_ref: null,
        title: '有序 KC',
        content: '',
        knowledge_ids: ['k2', 'k1'],
        status: 'pending',
        created_at: now,
        updated_at: now,
        version: 0,
      });
    const parsed = JSON.parse(CLOSED_BOOK_OUTPUT) as {
      questions: Array<{ knowledge_ids: string[] }>;
    };
    parsed.questions[0].knowledge_ids = ['ghost'];

    const result = await runQuizGen({
      db: testDb(),
      trigger: 'learning_item',
      refId: 'li-ordered-fallback',
      count: 1,
      generationMethod: 'closed_book',
      runAgentTaskFn: agentMock(JSON.stringify(parsed), 'tr-ordered-fallback'),
      enqueueQuizVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    const [row] = await testDb()
      .select()
      .from(question)
      .where(eq(question.id, result.question_ids?.[0] ?? ''));
    expect(row.knowledge_ids).toEqual(['k2', 'k1']);
    const [quizArtifact] = await testDb()
      .select()
      .from(artifact)
      .where(eq(artifact.id, result.tool_quiz_artifact_id ?? ''));
    expect(quizArtifact.knowledge_ids).toEqual(['k2', 'k1']);
  });

  // YUK-226 S2-5b F1 (PR #318 round-1) — the 找题次序 pins generation_method; the
  // worker must forward it to the agent input as requested_generation_method so the
  // requested tier (material vs closed) is actually executed, not free-chosen.
  it('threads generationMethod into the agent input as requested_generation_method', async () => {
    await seedKnowledge({ id: 'k1' });
    // The fixture's generation_method MUST match the pin (F1 asserts the pin held).
    const runAgentTaskFn = agentMock(CLOSED_BOOK_OUTPUT, 'tr_method');

    await runQuizGen({
      db: testDb(),
      trigger: 'knowledge',
      refId: 'k1',
      count: 1,
      generationMethod: 'closed_book',
      runAgentTaskFn,
      enqueueQuizVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    const [, input] = runAgentTaskFn.mock.calls[0];
    expect((input as { requested_generation_method?: string }).requested_generation_method).toBe(
      'closed_book',
    );
  });

  it('omits requested_generation_method when no generationMethod is pinned (free-choice preserved)', async () => {
    await seedKnowledge({ id: 'k1' });
    const runAgentTaskFn = agentMock(VALID_OUTPUT, 'tr_nomethod');

    await runQuizGen({
      db: testDb(),
      trigger: 'knowledge',
      refId: 'k1',
      count: 1,
      runAgentTaskFn,
      enqueueQuizVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    const [, input] = runAgentTaskFn.mock.calls[0];
    expect(input as Record<string, unknown>).not.toHaveProperty('requested_generation_method');
  });

  // YUK-226 S2-5b F3 (PR #318 round-1) — a manual trigger carries a free-form ref_id
  // (the trigger pointer), but the explicit knowledgeId anchors attribution to the node.
  it('attributes a manual free-form trigger to the explicit knowledgeId anchor', async () => {
    await seedKnowledge({ id: 'k1' });
    const runAgentTaskFn = agentMock(VALID_OUTPUT, 'tr_anchor');

    const result = await runQuizGen({
      db: testDb(),
      trigger: 'manual',
      refId: 'free form manual ref',
      knowledgeId: 'k1',
      count: 1,
      runAgentTaskFn,
      enqueueQuizVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    expect(result.status).toBe('ready');
    const rows = await testDb().select().from(question).where(eq(question.source, 'quiz_gen'));
    expect(rows.length).toBeGreaterThan(0);
    // Attribution keyed to the anchor node, NOT the free-form ref.
    expect(rows.every((r) => r.knowledge_ids.includes('k1'))).toBe(true);
    // The trigger pointer (source_ref) stays the original free-form ref.
    expect(rows.every((r) => r.source_ref === 'free form manual ref')).toBe(true);
  });

  it('passes generation_method + knowledge_id from job data through buildQuizGenHandler', async () => {
    await seedKnowledge({ id: 'k1' });
    // material_grounded fixture so the agent's method MATCHES the pinned method (F1).
    const runAgentTaskFn = agentMock(MATERIAL_OUTPUT, 'tr_jobthread');
    const handler = buildQuizGenHandler(testDb(), {
      runAgentTaskFn,
      enqueueQuizVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: () => null,
      buildMcpServerFn: () => ({ name: 'fake-loom' }) as never,
    });

    const jobs = [
      {
        id: 'j1',
        data: {
          trigger: 'manual',
          ref_id: 'free form ref',
          count: 1,
          generation_method: 'material_grounded',
          knowledge_id: 'k1',
        },
      },
    ] as never;
    await handler(jobs);

    const [, input] = runAgentTaskFn.mock.calls[0];
    expect((input as { requested_generation_method?: string }).requested_generation_method).toBe(
      'material_grounded',
    );
    const rows = await testDb().select().from(question).where(eq(question.source, 'quiz_gen'));
    expect(rows.every((r) => r.knowledge_ids.includes('k1'))).toBe(true);
  });

  // YUK-226 S2-5b F1 (PR #318 round-4) — the pin is only a prompt hint; if the agent
  // ignores it and returns the WRONG generation_method, the run must FAIL (not silently
  // persist a mis-tiered draft). The catch writes a failure event + re-throws → pg-boss
  // retries.
  it('throws (no insert, no enqueue) when the agent ignores the pinned generation_method', async () => {
    await seedKnowledge({ id: 'k1' });
    // VALID_OUTPUT declares generation_method='search_grounded'; we pin material_grounded.
    const runAgentTaskFn = agentMock(VALID_OUTPUT, 'tr_pin_violation');
    const enqueueQuizVerify = vi.fn(async () => {});

    await expect(
      runQuizGen({
        db: testDb(),
        trigger: 'knowledge',
        refId: 'k1',
        generationMethod: 'material_grounded',
        runAgentTaskFn,
        enqueueQuizVerify,
        buildTavilyMcpServerFn: vi.fn(() => null),
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
      }),
    ).rejects.toThrow(
      /pinned generation_method='material_grounded' but agent produced 'search_grounded'/,
    );

    const rows = await testDb().select().from(question).where(eq(question.source, 'quiz_gen'));
    expect(rows).toHaveLength(0);
    expect(enqueueQuizVerify).not.toHaveBeenCalled();
    // a failure event was written by the catch block.
    const events = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:quiz_gen'));
    expect(events.some((e) => e.outcome === 'failure')).toBe(true);
  });

  it('persists when the agent honours the pinned generation_method', async () => {
    await seedKnowledge({ id: 'k1' });
    // closed_book is one of the pinnable tiers; CLOSED_BOOK_OUTPUT matches the pin.
    const runAgentTaskFn = agentMock(CLOSED_BOOK_OUTPUT, 'tr_pin_ok');

    const result = await runQuizGen({
      db: testDb(),
      trigger: 'knowledge',
      refId: 'k1',
      generationMethod: 'closed_book',
      runAgentTaskFn,
      enqueueQuizVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    expect(result.status).toBe('ready');
    const rows = await testDb().select().from(question).where(eq(question.source, 'quiz_gen'));
    expect(rows).toHaveLength(1);
  });

  // YUK-226 S2-5b F3 (PR #318 round-4) — an ARCHIVED explicit anchor must be treated as
  // missing (same guard as the other lookups). The manual fall-through then runs its own
  // unarchived best-effort lookup → attribution lands on the agent's real id, never the
  // dead anchor node.
  it('ignores an archived knowledgeId anchor and attributes to the real node instead', async () => {
    await seedKnowledge({ id: 'k1' });
    // Seed an archived anchor node.
    const now = new Date();
    await testDb().insert(knowledge).values({
      id: 'k_archived',
      name: '废弃',
      domain: 'yuwen',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      archived_at: now,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    // VALID_OUTPUT attributes to 'k1' (a live node).
    const runAgentTaskFn = agentMock(VALID_OUTPUT, 'tr_archived_anchor');

    const result = await runQuizGen({
      db: testDb(),
      trigger: 'manual',
      refId: 'free form manual ref',
      knowledgeId: 'k_archived',
      count: 1,
      runAgentTaskFn,
      enqueueQuizVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    expect(result.status).toBe('ready');
    const rows = await testDb().select().from(question).where(eq(question.source, 'quiz_gen'));
    expect(rows.length).toBeGreaterThan(0);
    // Attribution lands on the live node, NOT the archived anchor.
    expect(rows.every((r) => r.knowledge_ids.includes('k1'))).toBe(true);
    expect(rows.every((r) => !r.knowledge_ids.includes('k_archived'))).toBe(true);
  });

  // YUK-226 S2-5b F2 (PR #320 round-4) — the archived-anchor bypass form: when the
  // explicit anchor is archived AND trigger==='knowledge' with refId === the SAME archived
  // id, the knowledge-trigger fall-through used to re-resolve the dead node WITHOUT the
  // archived guard, silently mounting drafts onto it. The guard now covers the knowledge
  // branch too → the run skips (no node) rather than reviving the archived node.
  it('skips a knowledge trigger whose refId is the same archived id as the anchor', async () => {
    const now = new Date();
    await testDb().insert(knowledge).values({
      id: 'k_arch_same',
      name: '废弃',
      domain: 'yuwen',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      archived_at: now,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    const runAgentTaskFn = agentMock(VALID_OUTPUT, 'tr_arch_same');

    const result = await runQuizGen({
      db: testDb(),
      trigger: 'knowledge',
      refId: 'k_arch_same',
      knowledgeId: 'k_arch_same',
      count: 1,
      runAgentTaskFn,
      enqueueQuizVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    // The run is skipped (archived node resolves to nothing), never reaching the agent.
    expect(result.status).toBe('skipped:ref_not_found');
    expect(runAgentTaskFn).not.toHaveBeenCalled();
    const rows = await testDb().select().from(question).where(eq(question.source, 'quiz_gen'));
    expect(rows.every((r) => !r.knowledge_ids.includes('k_arch_same'))).toBe(true);
  });

  // YUK-226 S2-5b F3 (PR #320 round-4) — same pre-persist assert for the 题型 pin: an agent
  // that produced a different kind than requested must FAIL the run (not persist an
  // off-target draft). The catch writes a failure event + re-throws → pg-boss retries.
  it('throws (no insert, no enqueue) when the agent produces the wrong requested kind', async () => {
    await seedKnowledge({ id: 'k1' });
    // VALID_OUTPUT's questions are short_answer + choice; we pin 'reading' → mismatch.
    const runAgentTaskFn = agentMock(VALID_OUTPUT, 'tr_kind_violation');
    const enqueueQuizVerify = vi.fn(async () => {});

    await expect(
      runQuizGen({
        db: testDb(),
        trigger: 'knowledge',
        refId: 'k1',
        kind: 'reading',
        runAgentTaskFn,
        enqueueQuizVerify,
        buildTavilyMcpServerFn: vi.fn(() => null),
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
      }),
    ).rejects.toThrow(/pinned kind='reading' but agent produced question of kind 'short_answer'/);

    const rows = await testDb().select().from(question).where(eq(question.source, 'quiz_gen'));
    expect(rows).toHaveLength(0);
    expect(enqueueQuizVerify).not.toHaveBeenCalled();
    const events = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:quiz_gen'));
    expect(events.some((e) => e.outcome === 'failure')).toBe(true);
  });

  it('persists when the agent honours the pinned kind (computation↔calculation normalized)', async () => {
    await seedKnowledge({ id: 'k1' });
    // closed_book single short_answer question; pin matches the produced kind.
    const runAgentTaskFn = agentMock(CLOSED_BOOK_OUTPUT, 'tr_kind_ok');

    const result = await runQuizGen({
      db: testDb(),
      trigger: 'knowledge',
      refId: 'k1',
      kind: 'short_answer',
      runAgentTaskFn,
      enqueueQuizVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    expect(result.status).toBe('ready');
    const rows = await testDb().select().from(question).where(eq(question.source, 'quiz_gen'));
    expect(rows).toHaveLength(1);
  });

  // YUK-226 S2-5b (PR #320 验证轮 A3) — cross-vocabulary pin: a profile-vocabulary pin
  // ('reading_comprehension') MATCHES a canonical 'reading' output via kindsMatch. The old
  // skill-space compare (questionKindToSkillKind(q.kind) !== params.kind) would have FAILED
  // this (reading → reading_comprehension !== reading_comprehension? no — it compared
  // 'reading' to 'reading_comprehension' and threw). This proves the canonical compare.
  it('persists when a profile-vocabulary pin matches a canonical-vocabulary output (reading_comprehension ↔ reading)', async () => {
    await seedKnowledge({ id: 'k1' });
    // MATERIAL_OUTPUT's question is canonical kind 'reading'.
    const runAgentTaskFn = agentMock(MATERIAL_OUTPUT, 'tr_kind_xvocab');

    const result = await runQuizGen({
      db: testDb(),
      trigger: 'knowledge',
      refId: 'k1',
      count: 1,
      // profile/skill vocabulary on the pin; the output is canonical 'reading'.
      kind: 'reading_comprehension',
      runAgentTaskFn,
      enqueueQuizVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => FAKE_TAVILY_CONFIG),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    expect(result.status).toBe('ready');
    const rows = await testDb().select().from(question).where(eq(question.source, 'quiz_gen'));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('reading');
  });

  // YUK-226 S2-5b F4 (PR #318 round-4) — the 题型 hint the次序 selected this line for is
  // threaded into the agent input as requested_kind.
  it('threads kind into the agent input as requested_kind', async () => {
    await seedKnowledge({ id: 'k1' });
    // CLOSED_BOOK_OUTPUT is a single short_answer question, so the pinned kind MATCHES the
    // produced kind (F3 asserts the pin held — a mismatched fixture would now throw).
    const runAgentTaskFn = agentMock(CLOSED_BOOK_OUTPUT, 'tr_kind');

    await runQuizGen({
      db: testDb(),
      trigger: 'knowledge',
      refId: 'k1',
      count: 1,
      kind: 'short_answer',
      runAgentTaskFn,
      enqueueQuizVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    const [, input] = runAgentTaskFn.mock.calls[0];
    expect((input as { requested_kind?: string }).requested_kind).toBe('short_answer');
  });

  it('passes kind from job data through buildQuizGenHandler', async () => {
    await seedKnowledge({ id: 'k1' });
    const runAgentTaskFn = agentMock(CLOSED_BOOK_OUTPUT, 'tr_kind_job');
    const handler = buildQuizGenHandler(testDb(), {
      runAgentTaskFn,
      enqueueQuizVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: () => null,
      buildMcpServerFn: () => ({ name: 'fake-loom' }) as never,
    });

    const jobs = [
      { id: 'j1', data: { trigger: 'knowledge', ref_id: 'k1', count: 1, kind: 'short_answer' } },
    ] as never;
    await handler(jobs);

    const [, input] = runAgentTaskFn.mock.calls[0];
    expect((input as { requested_kind?: string }).requested_kind).toBe('short_answer');
  });

  it('skips (no insert, no enqueue) when the knowledge trigger ref does not exist', async () => {
    const runAgentTaskFn = agentMock(VALID_OUTPUT);
    const enqueueQuizVerify = vi.fn(async () => {});

    const result = await runQuizGen({
      db: testDb(),
      trigger: 'knowledge',
      refId: 'missing',
      runAgentTaskFn,
      enqueueQuizVerify,
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    expect(result.status).toBe('skipped:ref_not_found');
    expect(runAgentTaskFn).not.toHaveBeenCalled();
    expect(enqueueQuizVerify).not.toHaveBeenCalled();
    const rows = await testDb().select().from(question).where(eq(question.source, 'quiz_gen'));
    expect(rows).toHaveLength(0);
  });

  it('throws and inserts nothing + does not enqueue when the agent returns 0 questions', async () => {
    await seedKnowledge({ id: 'k1' });
    const runAgentTaskFn = agentMock(ZERO_QUESTIONS_OUTPUT);
    const enqueueQuizVerify = vi.fn(async () => {});

    await expect(
      runQuizGen({
        db: testDb(),
        trigger: 'knowledge',
        refId: 'k1',
        runAgentTaskFn,
        enqueueQuizVerify,
        buildTavilyMcpServerFn: vi.fn(() => null),
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
      }),
    ).rejects.toThrow(/parseOutput/);

    const rows = await testDb().select().from(question).where(eq(question.source, 'quiz_gen'));
    expect(rows).toHaveLength(0);
    expect(enqueueQuizVerify).not.toHaveBeenCalled();
  });
});

describe('buildQuizGenHandler', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('runs runQuizGen for each job in the batch using job data', async () => {
    await seedKnowledge({ id: 'k1' });
    await seedKnowledge({ id: 'k2' });
    const runAgentTaskFn = agentMock(VALID_OUTPUT, 'tr_b');
    const enqueueQuizVerify = vi.fn(async () => {});

    const handler = buildQuizGenHandler(testDb(), {
      runAgentTaskFn,
      enqueueQuizVerify,
      buildTavilyMcpServerFn: () => null,
      buildMcpServerFn: () => ({ name: 'fake-loom' }) as never,
    });

    const jobs = [
      { id: 'j1', data: { trigger: 'knowledge', ref_id: 'k1', count: 2 } },
      { id: 'j2', data: { trigger: 'knowledge', ref_id: 'k2' } },
    ] as never;

    await handler(jobs);

    expect(runAgentTaskFn).toHaveBeenCalledTimes(2);
    const rows = await testDb().select().from(question).where(eq(question.source, 'quiz_gen'));
    // The second job returned byte-identical content, so canonical identity keeps
    // the first batch and skips the duplicate batch without another verify enqueue.
    expect(rows).toHaveLength(2);
    expect(enqueueQuizVerify).toHaveBeenCalledTimes(1);
  });
});

// YUK-224 F1 / F3 (PR #314 round-1) — pure helpers, no DB.
describe('embedMaterialInPrompt (F1)', () => {
  it('prepends the material as a 阅读材料 blockquote before the prompt', () => {
    const out = embedMaterialInPrompt('题干？', '原文第一行\n原文第二行');
    expect(out).toBe('> **阅读材料**\n> 原文第一行\n> 原文第二行\n\n题干？');
  });
  it('returns the prompt unchanged when the material is empty/whitespace', () => {
    expect(embedMaterialInPrompt('题干？', '   ')).toBe('题干？');
  });
});

describe('synthesizeMaterialSourceRefs (F3)', () => {
  const material = { url: 'https://m.example/p', title: '原文', body_md: '甲乙丙'.repeat(300) };
  it('prepends a material ref carrying a snippet截段 of the passage', () => {
    const refs = synthesizeMaterialSourceRefs([], material);
    expect(refs).toHaveLength(1);
    expect(refs[0].url).toBe(material.url);
    expect(refs[0].snippet).toBeDefined();
    // Capped to MATERIAL_SNIPPET_MAX (500).
    expect((refs[0].snippet ?? '').length).toBeLessThanOrEqual(500);
    expect(refs[0].used_for).toBe('fact');
  });
  it('does not duplicate when the agent already declared the material URL with a snippet', () => {
    const declared = [
      {
        url: material.url,
        title: '原文',
        snippet: '甲乙丙',
        used_for: 'fact' as const,
        extracted: true,
      },
    ];
    expect(synthesizeMaterialSourceRefs(declared, material)).toBe(declared);
  });
});
