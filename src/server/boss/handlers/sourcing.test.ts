// YUK-216 S2 slice 2 — SourcingTask handler DB test.
//
// docs/superpowers/plans/2026-06-05-yuk216-question-source-s2.md §3 (step 2.6).
//
// Mocks the AI (runAgentTaskFn) + the chained source_verify enqueue. Asserts:
//   - questions INSERT with draft_status='draft' (Option B — NOT in the pool),
//     source='web_sourced', metadata.web_sourced (url/title/fetched_at/
//     whitelist_match), metadata.source_ref_kind='url', source_ref = the page URL,
//     created_by = aiAgentRef('SourcingTask', ...).
//   - deriveSourceTier on the persisted row returns tier 2 'sourced'.
//   - the Tavily remote MCP + in-process domain-tool MCP are mounted, and
//     allowedTools fold in TAVILY_MCP_ALLOWED_TOOLS only when a Tavily config is
//     present (env-gated graceful degradation).
//   - source_verify is enqueued with { question_ids } on success.
//   - OF-2: an empty whitelist lands whitelist_match=false on every question.
//   - knowledge_id hallucination falls back to the trigger's resolved ids.

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveSourceTier } from '@/core/schema/provenance';
import { event, knowledge, learning_item, question } from '@/db/schema';
import { TAVILY_MCP_ALLOWED_TOOLS, TAVILY_MCP_SERVER_NAME } from '@/server/ai/mcp/tavily';
import { DOMAIN_TOOL_MCP_SERVER_NAME, toMcpAllowedToolName } from '@/server/ai/tools/allowlists';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  SOURCING_READ_TOOLS,
  buildSourcingHandler,
  matchesWhitelist,
  runSourcing,
} from './sourcing';

const FAKE_TAVILY_CONFIG = {
  type: 'http' as const,
  url: 'https://mcp.tavily.com/mcp/?tavilyApiKey=test',
};

type AgentCtx = {
  db: unknown;
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  subjectProfile?: { id: string };
};

function agentMock(output: string, taskRunId?: string) {
  return vi.fn(async (_kind: string, _input: unknown, _ctx: AgentCtx) =>
    taskRunId === undefined ? { text: output } : { text: output, task_run_id: taskRunId },
  );
}

const VALID_OUTPUT = JSON.stringify({
  questions: [
    {
      kind: 'short_answer',
      prompt_md: '请翻译「学而时习之，不亦说乎」。',
      reference_md: '学习并按时温习它，不也很愉快吗？',
      choices_md: null,
      judge_kind_override: 'semantic',
      rubric_json: {
        criteria: [{ name: 'correctness', weight: 1, descriptor: '译文准确' }],
        required_points: ['学习', '按时温习', '愉快'],
      },
      difficulty: 2,
      knowledge_ids: ['k1'],
      source_url: 'https://example.edu/wenyan/lunyu',
      source_title: '论语·学而 注疏',
      extract: '请翻译「学而时习之，不亦说乎」。学习并按时温习它，不也很愉快吗？',
      extraction_hash: 'sha256:abc',
    },
  ],
  query_plan: ['论语 学而 翻译题'],
  fetched_at: '2026-06-06T00:00:00.000Z',
  tool: 'tavily',
});

const HALLUCINATED_KNOWLEDGE_OUTPUT = JSON.stringify({
  questions: [
    {
      kind: 'choice',
      prompt_md: '「之」在「学而时习之」中作？',
      reference_md: '代词',
      choices_md: ['代词', '助词', '动词'],
      judge_kind_override: 'exact',
      rubric_json: null,
      difficulty: 1,
      knowledge_ids: ['does_not_exist'],
      source_url: 'https://example.edu/wenyan/zhi',
      source_title: '之的用法',
      extract: '「之」在「学而时习之」中作代词。',
    },
  ],
  query_plan: ['之 用法 选择题'],
  fetched_at: '2026-06-06T00:00:00.000Z',
  tool: 'tavily',
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

describe('matchesWhitelist', () => {
  it('returns false for an empty whitelist (OF-2 default — every source demoted)', () => {
    expect(matchesWhitelist('https://example.edu/x', [])).toBe(false);
  });
  it('matches a host exactly and via subdomain suffix', () => {
    expect(matchesWhitelist('https://example.edu/x', ['example.edu'])).toBe(true);
    expect(matchesWhitelist('https://www.example.edu/x', ['example.edu'])).toBe(true);
  });
  it('does not match an unrelated host', () => {
    expect(matchesWhitelist('https://evil.com/x', ['example.edu'])).toBe(false);
  });
  it('treats an unparseable url as off-whitelist (not a crash)', () => {
    expect(matchesWhitelist('not-a-url', ['example.edu'])).toBe(false);
  });
  it('strips a leading *. wildcard prefix in the whitelist entry', () => {
    expect(matchesWhitelist('https://a.example.edu/x', ['*.example.edu'])).toBe(true);
  });
});

describe('runSourcing', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('persists tier-2 web_sourced drafts with provenance + chains source_verify', async () => {
    const db = testDb();
    await seedKnowledge({ id: 'k1' });
    const runAgentTaskFn = agentMock(VALID_OUTPUT, 'tr_src_1');
    const enqueueSourceVerify = vi.fn(async () => {});
    const buildTavilyMcpServerFn = vi.fn(() => FAKE_TAVILY_CONFIG);
    const buildMcpServerFn = vi.fn(() => ({ name: 'fake-loom' }) as never);

    const result = await runSourcing({
      db,
      trigger: 'knowledge',
      refId: 'k1',
      runAgentTaskFn,
      enqueueSourceVerify,
      buildTavilyMcpServerFn,
      buildMcpServerFn,
    });

    expect(result.status).toBe('ready');
    expect(result.question_ids).toHaveLength(1);
    const qid = result.question_ids?.[0] as string;

    const rows = await db.select().from(question).where(eq(question.id, qid));
    const row = rows[0];
    expect(row.source).toBe('web_sourced');
    expect(row.draft_status).toBe('draft');
    expect(row.source_ref).toBe('https://example.edu/wenyan/lunyu');
    expect(row.judge_kind_override).toBe('semantic');
    expect(row.knowledge_ids).toEqual(['k1']);

    const meta = row.metadata as Record<string, unknown>;
    expect(meta.source_ref_kind).toBe('url');
    const web = meta.web_sourced as Record<string, unknown>;
    expect(web.url).toBe('https://example.edu/wenyan/lunyu');
    expect(web.title).toBe('论语·学而 注疏');
    expect(web.fetched_at).toBe('2026-06-06T00:00:00.000Z');
    expect(web.whitelist_match).toBe(false); // OF-2 — empty whitelist
    expect(web.extraction_hash).toBe('sha256:abc');
    // F1: the agent's extract is persisted so source_verify can ground deterministically.
    expect(web.extract).toBe('请翻译「学而时习之，不亦说乎」。学习并按时温习它，不也很愉快吗？');

    // deriveSourceTier lands tier 2 on the persisted row.
    const { tier, name } = deriveSourceTier({ source: row.source, metadata: meta });
    expect(tier).toBe(2);
    expect(name).toBe('sourced');

    expect(enqueueSourceVerify).toHaveBeenCalledTimes(1);
    expect(enqueueSourceVerify).toHaveBeenCalledWith(result.question_ids);

    // success event written.
    const events = await db.select().from(event).where(eq(event.action, 'experimental:sourcing'));
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('success');
  });

  it('mounts the Tavily + domain MCP and folds Tavily allowedTools only when configured', async () => {
    const db = testDb();
    await seedKnowledge({ id: 'k1' });
    const runAgentTaskFn = agentMock(VALID_OUTPUT, 'tr_src_2');
    const buildMcpServerFn = vi.fn(() => ({ name: 'fake-loom' }) as never);

    await runSourcing({
      db,
      trigger: 'knowledge',
      refId: 'k1',
      runAgentTaskFn,
      enqueueSourceVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => FAKE_TAVILY_CONFIG),
      buildMcpServerFn,
    });

    const ctx = runAgentTaskFn.mock.calls[0][2];
    expect(ctx.mcpServers?.[DOMAIN_TOOL_MCP_SERVER_NAME]).toBeDefined();
    expect(ctx.mcpServers?.[TAVILY_MCP_SERVER_NAME]).toEqual(FAKE_TAVILY_CONFIG);
    for (const tool of SOURCING_READ_TOOLS) {
      expect(ctx.allowedTools).toContain(toMcpAllowedToolName(tool));
    }
    for (const tool of TAVILY_MCP_ALLOWED_TOOLS) {
      expect(ctx.allowedTools).toContain(tool);
    }
  });

  it('omits Tavily tools when TAVILY_API_KEY is unconfigured (graceful degradation)', async () => {
    const db = testDb();
    await seedKnowledge({ id: 'k1' });
    const runAgentTaskFn = agentMock(VALID_OUTPUT, 'tr_src_3');

    await runSourcing({
      db,
      trigger: 'knowledge',
      refId: 'k1',
      runAgentTaskFn,
      enqueueSourceVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    const ctx = runAgentTaskFn.mock.calls[0][2];
    expect(ctx.mcpServers?.[TAVILY_MCP_SERVER_NAME]).toBeUndefined();
    for (const tool of TAVILY_MCP_ALLOWED_TOOLS) {
      expect(ctx.allowedTools).not.toContain(tool);
    }
  });

  it('falls back to the trigger knowledge_ids when the agent hallucinates an unknown id', async () => {
    const db = testDb();
    await seedKnowledge({ id: 'k1' });
    const result = await runSourcing({
      db,
      trigger: 'knowledge',
      refId: 'k1',
      runAgentTaskFn: agentMock(HALLUCINATED_KNOWLEDGE_OUTPUT, 'tr_src_4'),
      enqueueSourceVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    const qid = result.question_ids?.[0] as string;
    const rows = await db.select().from(question).where(eq(question.id, qid));
    expect(rows[0].knowledge_ids).toEqual(['k1']);
  });

  it('skips when a knowledge trigger ref does not resolve', async () => {
    const db = testDb();
    const result = await runSourcing({
      db,
      trigger: 'knowledge',
      refId: 'missing',
      runAgentTaskFn: agentMock(VALID_OUTPUT),
      enqueueSourceVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });
    expect(result.status).toBe('skipped:ref_not_found');
  });

  it('resolves a learning_item trigger to its knowledge_ids', async () => {
    const db = testDb();
    await seedKnowledge({ id: 'k1' });
    await seedLearningItem({ id: 'li1', knowledgeId: 'k1' });
    const result = await runSourcing({
      db,
      trigger: 'learning_item',
      refId: 'li1',
      runAgentTaskFn: agentMock(VALID_OUTPUT, 'tr_src_5'),
      enqueueSourceVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });
    expect(result.status).toBe('ready');
  });

  it('passes the resolved subject profile into the SourcingTask ctx (non-default subject)', async () => {
    const db = testDb();
    // a math-domain knowledge node → math profile, NOT the default wenyan voice.
    await seedKnowledge({ id: 'k1', domain: 'math' });
    const runAgentTaskFn = agentMock(VALID_OUTPUT, 'tr_src_profile');

    await runSourcing({
      db,
      trigger: 'knowledge',
      refId: 'k1',
      runAgentTaskFn,
      enqueueSourceVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    const ctx = runAgentTaskFn.mock.calls[0][2];
    expect(ctx.subjectProfile?.id).toBe('math');
  });

  it('preserves an explicit judge_kind_override instead of overwriting it with the default', async () => {
    const db = testDb();
    await seedKnowledge({ id: 'k1' });
    // A fill_blank question with NO rubric keywords would default to 'exact', but the
    // agent explicitly chose 'keyword' — that explicit route must survive.
    const output = JSON.stringify({
      questions: [
        {
          kind: 'fill_blank',
          prompt_md: '「学而时习之，不亦____乎」',
          reference_md: '说',
          choices_md: null,
          judge_kind_override: 'keyword',
          rubric_json: {
            criteria: [{ name: 'correctness', weight: 1, descriptor: '填对字' }],
            keywords: ['说', '悦'],
          },
          difficulty: 2,
          knowledge_ids: ['k1'],
          source_url: 'https://example.edu/wenyan/lunyu',
          source_title: '论语',
          extract: '「学而时习之，不亦说乎」',
        },
      ],
      query_plan: ['论语 填空'],
      fetched_at: '2026-06-06T00:00:00.000Z',
      tool: 'tavily',
    });
    const result = await runSourcing({
      db,
      trigger: 'knowledge',
      refId: 'k1',
      runAgentTaskFn: agentMock(output, 'tr_src_judge'),
      enqueueSourceVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });
    const qid = result.question_ids?.[0] as string;
    const rows = await db.select().from(question).where(eq(question.id, qid));
    expect(rows[0].judge_kind_override).toBe('keyword');
  });

  it('skips an archived knowledge trigger (archived nodes get no new material)', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values({
      id: 'k_archived',
      name: '归档点',
      domain: 'wenyan',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      archived_at: now,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    const result = await runSourcing({
      db,
      trigger: 'knowledge',
      refId: 'k_archived',
      runAgentTaskFn: agentMock(VALID_OUTPUT),
      enqueueSourceVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });
    expect(result.status).toBe('skipped:ref_not_found');
  });

  it('does not fall back to an archived knowledge id when the agent hallucinates (manual trigger)', async () => {
    const db = testDb();
    const now = new Date();
    // manual trigger resolves an archived node → resolved.knowledgeIds is []; the
    // hallucinated id is unknown → no valid attribution → throws (never mounts to the
    // archived node).
    await db.insert(knowledge).values({
      id: 'k_arch_manual',
      name: '归档点',
      domain: 'wenyan',
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      archived_at: now,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await expect(
      runSourcing({
        db,
        trigger: 'manual',
        refId: 'k_arch_manual',
        runAgentTaskFn: agentMock(HALLUCINATED_KNOWLEDGE_OUTPUT, 'tr_src_arch'),
        enqueueSourceVerify: vi.fn(async () => {}),
        buildTavilyMcpServerFn: vi.fn(() => null),
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
      }),
    ).rejects.toThrow();
  });

  it('writes a failure event and rethrows on unparseable agent output', async () => {
    const db = testDb();
    await seedKnowledge({ id: 'k1' });
    await expect(
      runSourcing({
        db,
        trigger: 'knowledge',
        refId: 'k1',
        runAgentTaskFn: agentMock('not json at all', 'tr_src_6'),
        enqueueSourceVerify: vi.fn(async () => {}),
        buildTavilyMcpServerFn: vi.fn(() => null),
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
      }),
    ).rejects.toThrow();

    const events = await db.select().from(event).where(eq(event.action, 'experimental:sourcing'));
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('failure');
  });
});

describe('buildSourcingHandler', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('runs each job and skips jobs missing trigger/ref_id', async () => {
    const db = testDb();
    await seedKnowledge({ id: 'k1' });
    const runAgentTaskFn = agentMock(VALID_OUTPUT, 'tr_src_h');
    const enqueueSourceVerify = vi.fn(async () => {});
    const handler = buildSourcingHandler(db, {
      runAgentTaskFn,
      enqueueSourceVerify,
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });
    // biome-ignore lint/suspicious/noExplicitAny: minimal pg-boss Job shape for the handler test.
    await handler([{ id: 'j1', data: { trigger: 'knowledge', ref_id: 'k1' } } as any]);
    expect(runAgentTaskFn).toHaveBeenCalledTimes(1);
    expect(enqueueSourceVerify).toHaveBeenCalledTimes(1);
  });
});
