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

// YUK-227 S3 Slice C — a run that found ONLY an image-type source (0 text questions,
// 1 image_candidate). The handler must propose it, NOT INSERT a question, NOT call VLM.
const IMAGE_ONLY_OUTPUT = JSON.stringify({
  questions: [],
  image_candidates: [
    {
      source_url: 'https://example.edu/wenyan/scan.png',
      source_title: '论语·学而 扫描卷',
      summary_md: 'tavily_extract 返回空文本；搜索结果显示该页含题目图片，判定为图片型源。',
    },
  ],
  query_plan: ['论语 学而 扫描卷'],
  fetched_at: '2026-06-06T00:00:00.000Z',
  tool: 'tavily',
});

// A mixed run: 1 text question (INSERTed) + 1 image_candidate (proposed).
const MIXED_OUTPUT = JSON.stringify({
  questions: [
    {
      kind: 'short_answer',
      prompt_md: '请翻译「学而时习之，不亦说乎」。',
      reference_md: '学习并按时温习它，不也很愉快吗？',
      choices_md: null,
      judge_kind_override: 'semantic',
      rubric_json: null,
      difficulty: 2,
      knowledge_ids: ['k1'],
      source_url: 'https://example.edu/wenyan/lunyu',
      source_title: '论语·学而 注疏',
      extract: '请翻译「学而时习之，不亦说乎」。',
    },
  ],
  image_candidates: [
    {
      source_url: 'https://example.edu/wenyan/scan.png',
      source_title: '论语·学而 扫描卷',
      summary_md: '该页题干在图片里，tavily_extract 抽不出文本。',
    },
  ],
  query_plan: ['论语 学而'],
  fetched_at: '2026-06-06T00:00:00.000Z',
  tool: 'tavily',
});

// YUK-227 S3 Slice C (FIX-R2-9) — a run that VIOLATES the 二选一 prompt contract: the
// SAME source_url is reported in BOTH a text question AND an image_candidate. The handler
// must INSERT the text question and SKIP the duplicate image_candidate (text wins).
const DUAL_REPORT_OUTPUT = JSON.stringify({
  questions: [
    {
      kind: 'short_answer',
      prompt_md: '请翻译「学而时习之」。',
      reference_md: '学习并按时温习它。',
      choices_md: null,
      judge_kind_override: 'semantic',
      rubric_json: null,
      difficulty: 2,
      knowledge_ids: ['k1'],
      source_url: 'https://example.edu/wenyan/dual',
      source_title: '论语·学而',
      extract: '请翻译「学而时习之」。学习并按时温习它。',
    },
  ],
  image_candidates: [
    {
      source_url: 'https://example.edu/wenyan/dual',
      source_title: '论语·学而',
      summary_md: '同一个源被错误地又报成了图片型源。',
    },
  ],
  query_plan: ['论语 学而'],
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

  // YUK-226 S2-5b F2 (PR #318 round-4) — a manual trigger with a free-form ref_id still
  // attributes produced questions to the explicit knowledge anchor forwarded by the
  // 找题次序 (knowledge_id payload). resolveTrigger consumes it preferentially.
  it('attributes a manual free-form trigger to the explicit knowledgeId anchor', async () => {
    const db = testDb();
    await seedKnowledge({ id: 'k1' });
    const runAgentTaskFn = agentMock(VALID_OUTPUT, 'tr_src_anchor');

    const result = await runSourcing({
      db,
      trigger: 'manual',
      refId: 'free form manual ref',
      knowledgeId: 'k1',
      runAgentTaskFn,
      enqueueSourceVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    expect(result.status).toBe('ready');
    const qid = result.question_ids?.[0] as string;
    const rows = await db.select().from(question).where(eq(question.id, qid));
    // Attribution keyed to the anchor node, NOT the free-form ref.
    expect(rows[0].knowledge_ids).toEqual(['k1']);
    // The trigger pointer (source_ref) is the fetched URL; the anchor only drives
    // knowledge attribution, and the knowledge_context the agent saw came from k1.
    const ctx = runAgentTaskFn.mock.calls[0][1] as {
      knowledge_context?: Array<{ id: string }>;
    };
    expect(ctx.knowledge_context?.[0]?.id).toBe('k1');
  });

  it('ignores an archived knowledgeId anchor and falls through to the trigger resolution', async () => {
    const db = testDb();
    await seedKnowledge({ id: 'k1' });
    const now = new Date();
    await db.insert(knowledge).values({
      id: 'k_archived_anchor',
      name: '废弃锚',
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
    // A knowledge trigger on a LIVE node (k1) with an ARCHIVED anchor → anchor ignored,
    // per-trigger resolution (k1) wins, VALID_OUTPUT attributes to k1.
    const result = await runSourcing({
      db,
      trigger: 'knowledge',
      refId: 'k1',
      knowledgeId: 'k_archived_anchor',
      runAgentTaskFn: agentMock(VALID_OUTPUT, 'tr_src_arch_anchor'),
      enqueueSourceVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    expect(result.status).toBe('ready');
    const qid = result.question_ids?.[0] as string;
    const rows = await db.select().from(question).where(eq(question.id, qid));
    expect(rows[0].knowledge_ids).toEqual(['k1']);
  });

  // YUK-226 S2-5b F4 (PR #318 round-4) — the 题型 hint the次序 selected this line for is
  // forwarded into the SourcingTask input's existing `kinds?` field (as a one-element list).
  it('threads kind into the SourcingTask input as kinds', async () => {
    const db = testDb();
    await seedKnowledge({ id: 'k1' });
    // VALID_OUTPUT's question is short_answer, so the pinned kind MATCHES the produced
    // kind (F4 asserts the pin held — a mismatched fixture would now throw the whole job).
    const runAgentTaskFn = agentMock(VALID_OUTPUT, 'tr_src_kind');

    await runSourcing({
      db,
      trigger: 'knowledge',
      refId: 'k1',
      kind: 'short_answer',
      runAgentTaskFn,
      enqueueSourceVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    const input = runAgentTaskFn.mock.calls[0][1] as { kinds?: string[] };
    expect(input.kinds).toEqual(['short_answer']);
  });

  it('omits kinds when no kind hint is passed', async () => {
    const db = testDb();
    await seedKnowledge({ id: 'k1' });
    const runAgentTaskFn = agentMock(VALID_OUTPUT, 'tr_src_nokind');

    await runSourcing({
      db,
      trigger: 'knowledge',
      refId: 'k1',
      runAgentTaskFn,
      enqueueSourceVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    const input = runAgentTaskFn.mock.calls[0][1] as Record<string, unknown>;
    expect(input).not.toHaveProperty('kinds');
  });

  // YUK-226 S2-5b F4 (PR #320 round-4) — same loud-fail semantics as quiz_gen F3: when the
  // 找题次序 pinned a kind and the agent returned a DIFFERENT kind, fail the whole job (no
  // ingest) rather than accept an off-target sourced draft. The catch writes a failure
  // event + re-throws → pg-boss retries.
  it('throws (no insert) when the sourced question kind differs from the requested kind', async () => {
    const db = testDb();
    await seedKnowledge({ id: 'k1' });
    // VALID_OUTPUT's question is short_answer; we pin 'reading' → mismatch.
    const runAgentTaskFn = agentMock(VALID_OUTPUT, 'tr_src_kind_violation');
    const enqueueSourceVerify = vi.fn(async () => {});

    await expect(
      runSourcing({
        db,
        trigger: 'knowledge',
        refId: 'k1',
        kind: 'reading',
        runAgentTaskFn,
        enqueueSourceVerify,
        buildTavilyMcpServerFn: vi.fn(() => null),
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
      }),
    ).rejects.toThrow(/pinned kind='reading' but agent produced question of kind 'short_answer'/);

    const rows = await db.select().from(question).where(eq(question.source, 'web_sourced'));
    expect(rows).toHaveLength(0);
    expect(enqueueSourceVerify).not.toHaveBeenCalled();
    const events = await db.select().from(event).where(eq(event.action, 'experimental:sourcing'));
    expect(events.some((e) => e.outcome === 'failure')).toBe(true);
  });

  it('ingests when the sourced question kind matches the requested kind', async () => {
    const db = testDb();
    await seedKnowledge({ id: 'k1' });
    const runAgentTaskFn = agentMock(VALID_OUTPUT, 'tr_src_kind_ok');

    const result = await runSourcing({
      db,
      trigger: 'knowledge',
      refId: 'k1',
      kind: 'short_answer',
      runAgentTaskFn,
      enqueueSourceVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });

    expect(result.status).toBe('ready');
    const rows = await db.select().from(question).where(eq(question.source, 'web_sourced'));
    expect(rows).toHaveLength(1);
  });

  it('passes knowledge_id + kind from job data through buildSourcingHandler', async () => {
    const db = testDb();
    await seedKnowledge({ id: 'k1' });
    const runAgentTaskFn = agentMock(VALID_OUTPUT, 'tr_src_jobthread');
    const handler = buildSourcingHandler(db, {
      runAgentTaskFn,
      enqueueSourceVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: () => null,
      buildMcpServerFn: () => ({ name: 'fake-loom' }) as never,
    });

    const jobData = {
      trigger: 'manual',
      ref_id: 'free form ref',
      knowledge_id: 'k1',
      kind: 'short_answer',
    };
    // biome-ignore lint/suspicious/noExplicitAny: minimal pg-boss Job shape for the handler test.
    await handler([{ id: 'j1', data: jobData } as any]);

    const input = runAgentTaskFn.mock.calls[0][1] as {
      kinds?: string[];
      knowledge_context?: Array<{ id: string }>;
    };
    expect(input.kinds).toEqual(['short_answer']);
    const rows = await db.select().from(question).where(eq(question.source, 'web_sourced'));
    expect(rows.every((r) => r.knowledge_ids.includes('k1'))).toBe(true);
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

  // YUK-227 S3 Slice C — an image-only run writes an image_candidate PROPOSAL and does
  // NOT INSERT any question. The handler never imports/loads VLM, so "no VLM call" is
  // structural; here we assert the observable side effects: proposal written via the
  // seam, ZERO question rows, NO source_verify enqueue, success event records the
  // proposal id.
  it('proposes image-type sources (writeAiProposal) WITHOUT inserting a question or VLM', async () => {
    const db = testDb();
    await seedKnowledge({ id: 'k1' });
    const writeImageCandidateProposalFn = vi.fn(
      async (_db: unknown, _input: unknown) => 'proposal_evt_1',
    );
    const enqueueSourceVerify = vi.fn(async () => {});

    const result = await runSourcing({
      db,
      trigger: 'knowledge',
      refId: 'k1',
      runAgentTaskFn: agentMock(IMAGE_ONLY_OUTPUT, 'tr_src_img'),
      enqueueSourceVerify,
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
      writeImageCandidateProposalFn,
    });

    expect(result.status).toBe('ready');
    // No text question INSERTed.
    expect(result.question_ids).toEqual([]);
    const rows = await db.select().from(question).where(eq(question.source, 'web_sourced'));
    expect(rows).toHaveLength(0);
    // The image candidate was proposed (NOT auto-extracted) via the proposal writer seam.
    expect(writeImageCandidateProposalFn).toHaveBeenCalledTimes(1);
    const proposalInput = writeImageCandidateProposalFn.mock.calls[0][1] as {
      payload: {
        kind: string;
        proposed_change: { source_url: string; source_title: string; summary_md: string };
      };
    };
    expect(proposalInput.payload.kind).toBe('image_candidate');
    expect(proposalInput.payload.proposed_change.source_url).toBe(
      'https://example.edu/wenyan/scan.png',
    );
    // FIX-3 — the run's resolved knowledge node is carried into the proposal so accept can
    // attribute the materialized question.
    expect(
      (proposalInput.payload.proposed_change as { knowledge_ids?: string[] }).knowledge_ids,
    ).toEqual(['k1']);
    expect(result.image_candidate_proposal_ids).toEqual(['proposal_evt_1']);
    // FIX-8 — an image-only run has 0 text drafts, so source_verify is NOT enqueued at all
    // (no empty source_verify([]) job). Image drafts get their own verify at accept time.
    expect(enqueueSourceVerify).not.toHaveBeenCalled();
    // Success event records the proposal id for audit.
    const events = await db.select().from(event).where(eq(event.action, 'experimental:sourcing'));
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('success');
    const payload = events[0].payload as { image_candidate_proposal_ids?: string[] };
    expect(payload.image_candidate_proposal_ids).toEqual(['proposal_evt_1']);
  });

  // The default writer (writeAiProposal) lands a real experimental:proposal event that
  // the proposal inbox can derive — proving the propose path is wired end-to-end (no seam).
  it('writes a real image_candidate proposal event via the default writeAiProposal path', async () => {
    const db = testDb();
    await seedKnowledge({ id: 'k1' });

    const result = await runSourcing({
      db,
      trigger: 'knowledge',
      refId: 'k1',
      runAgentTaskFn: agentMock(IMAGE_ONLY_OUTPUT, 'tr_src_img_real'),
      enqueueSourceVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
      // no writeImageCandidateProposalFn override → default writeAiProposal
    });

    const proposalId = result.image_candidate_proposal_ids?.[0] as string;
    expect(proposalId).toBeDefined();
    const proposalEvents = await db.select().from(event).where(eq(event.id, proposalId));
    expect(proposalEvents).toHaveLength(1);
    expect(proposalEvents[0].action).toBe('experimental:proposal');
    const aiProposal = (proposalEvents[0].payload as { ai_proposal?: { kind?: string } })
      .ai_proposal;
    expect(aiProposal?.kind).toBe('image_candidate');
  });

  // A mixed run: text question INSERTed AND image_candidate proposed — both paths
  // co-exist, text path is unchanged.
  it('handles a mixed run: text question INSERTed + image_candidate proposed', async () => {
    const db = testDb();
    await seedKnowledge({ id: 'k1' });
    const writeImageCandidateProposalFn = vi.fn(
      async (_db: unknown, _input: unknown) => 'proposal_evt_mixed',
    );
    const enqueueSourceVerify = vi.fn(async () => {});

    const result = await runSourcing({
      db,
      trigger: 'knowledge',
      refId: 'k1',
      runAgentTaskFn: agentMock(MIXED_OUTPUT, 'tr_src_mixed'),
      enqueueSourceVerify,
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
      writeImageCandidateProposalFn,
    });

    expect(result.question_ids).toHaveLength(1);
    expect(result.image_candidate_proposal_ids).toEqual(['proposal_evt_mixed']);
    const rows = await db.select().from(question).where(eq(question.source, 'web_sourced'));
    expect(rows).toHaveLength(1);
    expect(rows[0].source_ref).toBe('https://example.edu/wenyan/lunyu');
    expect(writeImageCandidateProposalFn).toHaveBeenCalledTimes(1);
    // The text draft still chains source_verify (only the text question id).
    expect(enqueueSourceVerify).toHaveBeenCalledWith(result.question_ids);
  });

  // YUK-227 S3 Slice C (FIX-6) — a re-run that re-reports the SAME image URL must not
  // stack a second pending image_candidate proposal in the inbox. The first run (real
  // writeAiProposal) lands a live pending proposal; the second run (same URL) skips it.
  it('does not re-propose an image_candidate whose URL already has a live pending proposal', async () => {
    const db = testDb();
    await seedKnowledge({ id: 'k1' });

    // Run 1 — real writer so a live pending image_candidate proposal exists.
    const first = await runSourcing({
      db,
      trigger: 'knowledge',
      refId: 'k1',
      runAgentTaskFn: agentMock(IMAGE_ONLY_OUTPUT, 'tr_src_dedup_1'),
      enqueueSourceVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
    });
    expect(first.image_candidate_proposal_ids).toHaveLength(1);

    // Run 2 — same image URL. The live-pending dedup skips the write (seam not called).
    const writeImageCandidateProposalFn = vi.fn(
      async (_db: unknown, _input: unknown) => 'should_not_be_written',
    );
    const second = await runSourcing({
      db,
      trigger: 'knowledge',
      refId: 'k1',
      runAgentTaskFn: agentMock(IMAGE_ONLY_OUTPUT, 'tr_src_dedup_2'),
      enqueueSourceVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
      writeImageCandidateProposalFn,
    });

    expect(writeImageCandidateProposalFn).not.toHaveBeenCalled();
    expect(second.image_candidate_proposal_ids).toEqual([]);
    // Still exactly ONE pending image_candidate proposal in the inbox (not two).
    const proposalEvents = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:proposal'));
    const imageProposals = proposalEvents.filter(
      (e) =>
        (e.payload as { ai_proposal?: { kind?: string } }).ai_proposal?.kind === 'image_candidate',
    );
    expect(imageProposals).toHaveLength(1);
  });

  // YUK-227 S3 Slice C (FIX-8) — an image-only run whose every proposal write FAILS must
  // throw (failure event + re-throw), NOT swallow the errors and report伪 success.
  it('throws on an image-only run when all image_candidate proposal writes fail', async () => {
    const db = testDb();
    await seedKnowledge({ id: 'k1' });
    const writeImageCandidateProposalFn = vi.fn(async () => {
      throw new Error('proposal writer boom');
    });
    const enqueueSourceVerify = vi.fn(async () => {});

    await expect(
      runSourcing({
        db,
        trigger: 'knowledge',
        refId: 'k1',
        runAgentTaskFn: agentMock(IMAGE_ONLY_OUTPUT, 'tr_src_allfail'),
        enqueueSourceVerify,
        buildTavilyMcpServerFn: vi.fn(() => null),
        buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
        writeImageCandidateProposalFn,
      }),
    ).rejects.toThrow(/all 1 image_candidate proposal write\(s\) failed/);

    // The catch wrote a failure event; no success event for this run.
    const events = await db.select().from(event).where(eq(event.action, 'experimental:sourcing'));
    expect(events.some((e) => e.outcome === 'failure')).toBe(true);
    expect(events.some((e) => e.outcome === 'success')).toBe(false);
    // No empty source_verify enqueued.
    expect(enqueueSourceVerify).not.toHaveBeenCalled();
  });

  // A mixed run (≥1 text draft) where the image proposal write fails stays best-effort:
  // the committed text drafts are useful output, so the run still succeeds.
  it('does NOT throw on a mixed run when the image_candidate proposal write fails (text drafts committed)', async () => {
    const db = testDb();
    await seedKnowledge({ id: 'k1' });
    const writeImageCandidateProposalFn = vi.fn(async () => {
      throw new Error('proposal writer boom');
    });

    const result = await runSourcing({
      db,
      trigger: 'knowledge',
      refId: 'k1',
      runAgentTaskFn: agentMock(MIXED_OUTPUT, 'tr_src_mixed_fail'),
      enqueueSourceVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
      writeImageCandidateProposalFn,
    });

    expect(result.status).toBe('ready');
    expect(result.question_ids).toHaveLength(1);
    expect(result.image_candidate_proposal_ids).toEqual([]);
    const events = await db.select().from(event).where(eq(event.action, 'experimental:sourcing'));
    expect(events.some((e) => e.outcome === 'success')).toBe(true);
  });

  // FIX-R2-9 — the agent violated the 二选一 contract and reported the SAME source_url in
  // BOTH questions and image_candidates. The text question is INSERTed; the duplicate
  // image_candidate is SKIPPED (text wins), so accept can't re-extract + duplicate it.
  it('skips an image_candidate whose source_url was also reported as a text question (FIX-R2-9)', async () => {
    const db = testDb();
    await seedKnowledge({ id: 'k1' });
    const writeImageCandidateProposalFn = vi.fn(
      async (_db: unknown, _input: unknown) => 'should_not_be_written',
    );

    const result = await runSourcing({
      db,
      trigger: 'knowledge',
      refId: 'k1',
      runAgentTaskFn: agentMock(DUAL_REPORT_OUTPUT, 'tr_src_dual'),
      enqueueSourceVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
      writeImageCandidateProposalFn,
    });

    // 1 text question INSERTed, 0 image_candidate proposals (the dup was skipped).
    expect(result.question_ids).toHaveLength(1);
    expect(result.image_candidate_proposal_ids).toEqual([]);
    expect(writeImageCandidateProposalFn).not.toHaveBeenCalled();
    const rows = await db.select().from(question).where(eq(question.source, 'web_sourced'));
    expect(rows).toHaveLength(1);
  });

  // FIX-R2-5 — a kind-constrained run stamps requested_kind on the image_candidate
  // proposed_change so accept can materialize the question as that kind. (The text path
  // already enforces kindsMatch per question; this carries the same constraint to the
  // image path which has no per-question kind until accept's VLM.)
  it('stamps requested_kind on the image_candidate proposal when the run is kind-pinned (FIX-R2-5)', async () => {
    const db = testDb();
    await seedKnowledge({ id: 'k1' });
    const writeImageCandidateProposalFn = vi.fn(
      async (_db: unknown, _input: unknown) => 'proposal_evt_kind',
    );

    await runSourcing({
      db,
      trigger: 'knowledge',
      refId: 'k1',
      // The pinned kind is short_answer, matching IMAGE_ONLY_OUTPUT's (0) questions — an
      // image-only run has no text questions to kind-check, so the pin only flows to the
      // proposal here.
      kind: 'short_answer',
      runAgentTaskFn: agentMock(IMAGE_ONLY_OUTPUT, 'tr_src_img_kind'),
      enqueueSourceVerify: vi.fn(async () => {}),
      buildTavilyMcpServerFn: vi.fn(() => null),
      buildMcpServerFn: vi.fn(() => ({ name: 'fake-loom' }) as never),
      writeImageCandidateProposalFn,
    });

    expect(writeImageCandidateProposalFn).toHaveBeenCalledTimes(1);
    const proposalInput = writeImageCandidateProposalFn.mock.calls[0][1] as {
      payload: { proposed_change: { requested_kind?: string } };
    };
    expect(proposalInput.payload.proposed_change.requested_kind).toBe('short_answer');
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
