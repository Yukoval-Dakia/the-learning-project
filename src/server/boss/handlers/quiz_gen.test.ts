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

import { knowledge, learning_item, question } from '@/db/schema';
import { TAVILY_MCP_ALLOWED_TOOLS, TAVILY_MCP_SERVER_NAME } from '@/server/ai/mcp/tavily';
import { DOMAIN_TOOL_MCP_SERVER_NAME, toMcpAllowedToolName } from '@/server/ai/tools/allowlists';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { QUIZ_GEN_READ_TOOLS, buildQuizGenHandler, runQuizGen } from './quiz_gen';

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
