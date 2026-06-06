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
import { artifact, event, knowledge, learning_item, question, source_document } from '@/db/schema';
import { TAVILY_MCP_ALLOWED_TOOLS, TAVILY_MCP_SERVER_NAME } from '@/server/ai/mcp/tavily';
import { DOMAIN_TOOL_MCP_SERVER_NAME, toMcpAllowedToolName } from '@/server/ai/tools/allowlists';
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
    domain: opts.domain ?? 'wenyan',
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

    const result = await runQuizGen({
      db: testDb(),
      trigger: 'knowledge',
      refId: 'k1',
      count: 2,
      runAgentTaskFn,
      enqueueQuizVerify,
      buildTavilyMcpServerFn,
      buildMcpServerFn,
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
    });

    // quiz_verify enqueued with the new question ids.
    expect(enqueueQuizVerify).toHaveBeenCalledTimes(1);
    expect(enqueueQuizVerify).toHaveBeenCalledWith(result.question_ids);
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

    expect(enqueueQuizVerify).toHaveBeenCalledWith(result.question_ids);
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

  // YUK-226 S2-5b F1 (PR #318 round-1) — the 找题次序 pins generation_method; the
  // worker must forward it to the agent input as requested_generation_method so the
  // requested tier (material vs closed) is actually executed, not free-chosen.
  it('threads generationMethod into the agent input as requested_generation_method', async () => {
    await seedKnowledge({ id: 'k1' });
    const runAgentTaskFn = agentMock(VALID_OUTPUT, 'tr_method');

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
    const runAgentTaskFn = agentMock(VALID_OUTPUT, 'tr_jobthread');
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
    // 2 questions per job * 2 jobs.
    expect(rows).toHaveLength(4);
    expect(enqueueQuizVerify).toHaveBeenCalledTimes(2);
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
