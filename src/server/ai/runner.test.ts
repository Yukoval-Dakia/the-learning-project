// Runner tests — full Claude Agent SDK path (post 2026-05-17 codex-flagged fix).
//
// Pre-fix the runner was a two-tier mix of raw @anthropic-ai/sdk (single turn)
// + Claude Agent SDK (tool-call). Codex called this out as drift from "全切
// SDK"; the runner now goes through `@anthropic-ai/claude-agent-sdk.query`
// uniformly. We mock the SDK at module boundary so unit tests don't spawn
// the `claude` binary.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { memR2 } from '../../../tests/helpers/r2';

const mockSdk = vi.hoisted(() => ({
  messages: [] as unknown[],
  capturedOptions: undefined as unknown,
  capturedPrompt: undefined as unknown,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(({ prompt, options }: { prompt: unknown; options: unknown }) => {
    mockSdk.capturedOptions = options;
    mockSdk.capturedPrompt = prompt;
    const iter = (async function* () {
      for (const m of mockSdk.messages) yield m;
    })();
    return iter;
  }),
  createSdkMcpServer: vi.fn((opts: unknown) => ({
    type: 'sdk',
    name: (opts as { name?: string }).name ?? '',
    instance: {},
  })),
  tool: vi.fn((name: string, description: string) => ({ name, description })),
}));

import { resolveSubjectProfile } from '@/subjects/profile';
import { runAgentTask, runTask, streamTask } from './runner';

function successResult(text: string, cost_usd = 0.001) {
  return {
    type: 'result',
    subtype: 'success',
    result: text,
    stop_reason: 'end_turn',
    total_cost_usd: cost_usd,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0 },
  };
}

describe('runTask (Claude Agent SDK adapter)', () => {
  beforeEach(async () => {
    await resetDb();
    mockSdk.messages = [];
    mockSdk.capturedOptions = undefined;
    mockSdk.capturedPrompt = undefined;
    process.env.XIAOMI_API_KEY = 'sk-test-key';
  });

  it('returns final text + writes cost ledger in USD', async () => {
    mockSdk.messages = [successResult('归因结果：concept', 0.001)];

    const result = await runTask(
      'AttributionTask',
      { question: '...', wrong_answer: '...' },
      { db: testDb(), r2: memR2() },
    );

    expect(result.text).toBe('归因结果：concept');
    expect(result.finishReason).toBe('end_turn');
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.cost_usd).toBe(0.001);

    const { ai_task_runs, cost_ledger } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');
    const rows = await testDb()
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_kind, 'AttributionTask'));
    expect(rows).toHaveLength(1);
    // codex P1 fix: cost_ledger.cost is USD float, NOT micro-USD ints.
    expect(rows[0].cost).toBeCloseTo(0.001, 6);
    expect(rows[0].task_run_id).toBe(result.task_run_id);

    const runRows = await testDb()
      .select()
      .from(ai_task_runs)
      .where(eq(ai_task_runs.id, result.task_run_id));
    expect(runRows).toHaveLength(1);
    expect(runRows[0]).toMatchObject({
      task_kind: 'AttributionTask',
      provider: 'xiaomi',
      model: 'mimo-v2.5-pro',
      status: 'success',
      finish_reason: 'end_turn',
    });
    expect(runRows[0].input_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(runRows[0].usage_json).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(runRows[0].cost_usd).toBeCloseTo(0.001, 6);
    expect(runRows[0].finished_at).toBeTruthy();
  });

  it('passes systemPrompt + model + env via options + tools from registry', async () => {
    mockSdk.messages = [successResult('ok')];

    await runTask('AttributionTask', { test: 'payload' }, { db: testDb(), r2: memR2() });

    const opts = mockSdk.capturedOptions as {
      model: string;
      systemPrompt: string;
      env: Record<string, string>;
      tools: string[];
    };
    expect(opts.model).toBe('mimo-v2.5-pro');
    expect(typeof opts.systemPrompt).toBe('string');
    expect(opts.env.ANTHROPIC_API_KEY).toBe('sk-test-key');
    expect(opts.env.ANTHROPIC_BASE_URL).toBe('https://api.xiaomimimo.com/anthropic');
    expect(opts.env.CLAUDE_CONFIG_DIR).toMatch(/loom-claude-/);
    // Registry's allowedTools picks up automatically when ctx doesn't override.
    expect(opts.tools).toEqual([]);
    expect(mockSdk.capturedPrompt).toBe('{"test":"payload"}');
  });

  it('uses ctx.subjectProfile to build the runtime system prompt', async () => {
    mockSdk.messages = [successResult('ok')];

    await runTask(
      'NoteGenerateTask',
      { test: 'payload' },
      { db: testDb(), r2: memR2(), subjectProfile: resolveSubjectProfile('math') },
    );

    const opts = mockSdk.capturedOptions as { systemPrompt: string };
    expect(opts.systemPrompt).toContain('你是数学学习笔记作者');
    expect(opts.systemPrompt).toContain('每一步变形依据');
    expect(opts.systemPrompt).not.toContain('古文');
  });

  it('honours registry-declared allowedTools (KnowledgeReviewTask → mcp__loom__write_proposal)', async () => {
    mockSdk.messages = [successResult('ok')];

    await runTask('KnowledgeReviewTask', { test: 'payload' }, { db: testDb(), r2: memR2() });

    const opts = mockSdk.capturedOptions as { tools: string[] };
    expect(opts.tools).toEqual(['mcp__loom__write_proposal']);
  });

  it('ctx.allowedTools overrides registry default', async () => {
    mockSdk.messages = [successResult('ok')];

    await runTask(
      'AttributionTask',
      {},
      { db: testDb(), r2: memR2(), allowedTools: ['mcp__custom__foo'] },
    );

    const opts = mockSdk.capturedOptions as { tools: string[] };
    expect(opts.tools).toEqual(['mcp__custom__foo']);
  });

  it('honours middleware.beforeRun + afterRun', async () => {
    mockSdk.messages = [successResult('echoed')];
    const beforeRun = vi.fn(async (_kind: string, input: unknown) => ({
      ...(input as Record<string, unknown>),
      injected: 'memory-context',
    }));
    const afterRun = vi.fn(async () => {});

    await runTask(
      'AttributionTask',
      { original: 'data' },
      { db: testDb(), r2: memR2(), middleware: { beforeRun, afterRun } },
    );

    expect(beforeRun).toHaveBeenCalledOnce();
    expect(afterRun).toHaveBeenCalledOnce();
    expect(JSON.stringify(mockSdk.capturedPrompt)).toContain('memory-context');
  });

  it('throws on SDK error result', async () => {
    mockSdk.messages = [{ type: 'result', subtype: 'error_during_execution' }];

    await expect(runTask('AttributionTask', {}, { db: testDb(), r2: memR2() })).rejects.toThrow(
      /error_during_execution/,
    );

    const { ai_task_runs } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');
    const runRows = await testDb()
      .select()
      .from(ai_task_runs)
      .where(eq(ai_task_runs.task_kind, 'AttributionTask'));
    expect(runRows).toHaveLength(1);
    expect(runRows[0].status).toBe('failure');
    expect(runRows[0].error_message).toContain('error_during_execution');
    expect(runRows[0].finished_at).toBeTruthy();
  });

  it('runAgentTask is an alias of runTask', async () => {
    mockSdk.messages = [successResult('agent-text', 0.002)];

    const result = await runAgentTask(
      'AttributionTask',
      { test: 'x' },
      { db: testDb(), r2: memR2() },
    );

    expect(result.text).toBe('agent-text');
    expect(result.cost_usd).toBe(0.002);
  });
});

// YUK-225 (S2 slice 4) — spike-invariant regression guards.
//
// Two protected invariants surfaced by the YUK-217 spike must never silently
// regress (independent-review blocker F1). Both are exercised through the
// captured SDK options + the populated isolated config dir, since
// buildQueryOptions / populateIsolatedSkills are module-private.
//
// Sources:
//   - .omc/research/2026-06-05-yuk217-spike-report.md §3 (接线参数) + §5 (失败模式)
//   - docs/superpowers/plans/2026-06-05-yuk216-question-source-s2.md §5.2
//     「SPIKE 修正注记」(2026-06-05)
describe('runTask — YUK-217 spike invariants (slice 4 skills wiring)', () => {
  beforeEach(async () => {
    await resetDb();
    mockSdk.messages = [];
    mockSdk.capturedOptions = undefined;
    mockSdk.capturedPrompt = undefined;
    process.env.XIAOMI_API_KEY = 'sk-test-key';
  });

  // (a) OMITTED invariant: settingSources must NEVER appear on Options.
  // spike report §5(1): passing `settingSources: []` (SDK isolation mode)
  // disables the CONFIG_DIR/skills auto-load (CLEAN-PRESEED 案 L1/L2 双 NO),
  // making the populated skills invisible. The correct form is to omit the
  // key entirely — guard that the runner never sets it on any path.
  it('never sets settingSources on Options (OMITTED invariant)', async () => {
    mockSdk.messages = [successResult('ok')];

    await runTask(
      'NoteGenerateTask',
      { test: 'payload' },
      { db: testDb(), r2: memR2(), skills: ['quiz-gen-translation'] },
    );

    const opts = mockSdk.capturedOptions as Record<string, unknown>;
    expect('settingSources' in opts).toBe(false);
  });

  // (b) Zero-impact red line: a task with no ctx.skills must EXPLICITLY DISABLE
  // skills via `skills: []`, NOT omit the key. Per sdk.d.ts:1699-1721 / 2768-2771,
  // OMITTING Options.skills makes the CLI load EVERY discovered skill — and the
  // runner has pre-populated CONFIG_DIR/skills with ALL quiz-gen skills, so omitting
  // would leak them into Attribution / NoteGenerate (a behaviour change). `[]` is the
  // SDK context filter's "enable zero skills", preserving pre-slice-4 behaviour.
  it('passes skills:[] when ctx has no skills (explicit disable = zero behaviour change)', async () => {
    mockSdk.messages = [successResult('ok')];

    await runTask('AttributionTask', { test: 'payload' }, { db: testDb(), r2: memR2() });

    const opts = mockSdk.capturedOptions as { skills?: string[] };
    expect('skills' in opts).toBe(true);
    expect(opts.skills).toEqual([]);
  });

  // Also guard the empty-array degrade path: ctx.skills=[] is still "no skills"
  // and lands as the same explicit `skills: []` disable.
  it('passes skills:[] when ctx.skills is an empty array', async () => {
    mockSdk.messages = [successResult('ok')];

    await runTask(
      'AttributionTask',
      { test: 'payload' },
      { db: testDb(), r2: memR2(), skills: [] },
    );

    const opts = mockSdk.capturedOptions as { skills?: string[] };
    expect(opts.skills).toEqual([]);
  });

  // (c) Whitelist passthrough: ctx.skills threads verbatim onto Options.skills.
  it('passes ctx.skills verbatim onto Options.skills (context filter whitelist)', async () => {
    mockSdk.messages = [successResult('ok')];

    await runTask(
      'NoteGenerateTask',
      { test: 'payload' },
      { db: testDb(), r2: memR2(), skills: ['quiz-gen-translation'] },
    );

    const opts = mockSdk.capturedOptions as { skills?: string[] };
    expect(opts.skills).toEqual(['quiz-gen-translation']);
  });

  // (d) Isolated config dir is populated: after a run, CLAUDE_CONFIG_DIR/skills/
  // contains the subject skills mirrored from src/subjects/<id>/skills/.
  // spike report §3(1): populate ALL subject skills once, whitelist keys which
  // the model sees. Verified against the real on-disk subject skill names.
  it('populates isolated CONFIG_DIR/skills with subject skills', async () => {
    const { existsSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');

    mockSdk.messages = [successResult('ok')];
    await runTask('AttributionTask', { test: 'payload' }, { db: testDb(), r2: memR2() });

    const opts = mockSdk.capturedOptions as { env: Record<string, string> };
    const skillsDir = join(opts.env.CLAUDE_CONFIG_DIR, 'skills');
    expect(existsSync(skillsDir)).toBe(true);

    const populated = readdirSync(skillsDir);
    // Subject skills are flattened by SKILL.md name (dir name) into skills/.
    expect(populated).toContain('quiz-gen-translation');
    expect(populated).toContain('quiz-gen-reading-comprehension');
    expect(populated).toContain('quiz-gen-calculation');
    // SKILL.md is mirrored into each skill dir.
    expect(existsSync(join(skillsDir, 'quiz-gen-translation', 'SKILL.md'))).toBe(true);
  });

  // populateIsolatedSkills idempotency: CLAUDE_CONFIG_DIR is a process-level
  // memoised singleton (isolatedConfigDir), so repeated runs reuse the same dir
  // without re-populating, duplicating, or throwing. spike report §3(1) +
  // §5(3): once-filled singleton keyed by the skills whitelist.
  it('reuses the same populated config dir across runs (idempotent singleton)', async () => {
    const { existsSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');

    mockSdk.messages = [successResult('ok')];
    await runTask('AttributionTask', { a: 1 }, { db: testDb(), r2: memR2() });
    const dir1 = (mockSdk.capturedOptions as { env: Record<string, string> }).env.CLAUDE_CONFIG_DIR;
    const skills1 = readdirSync(join(dir1, 'skills')).sort();

    mockSdk.messages = [successResult('ok')];
    await runTask('NoteGenerateTask', { b: 2 }, { db: testDb(), r2: memR2() });
    const dir2 = (mockSdk.capturedOptions as { env: Record<string, string> }).env.CLAUDE_CONFIG_DIR;
    const skills2 = readdirSync(join(dir2, 'skills')).sort();

    // Same singleton dir; skills subtree unchanged (no re-populate / no dupes).
    expect(dir2).toBe(dir1);
    expect(skills2).toEqual(skills1);
    expect(existsSync(join(dir2, 'skills', 'quiz-gen-translation', 'SKILL.md'))).toBe(true);
  });
});

describe('streamTask middleware + cost', () => {
  beforeEach(async () => {
    await resetDb();
    mockSdk.messages = [];
    mockSdk.capturedOptions = undefined;
    mockSdk.capturedPrompt = undefined;
    process.env.XIAOMI_API_KEY = 'sk-test-key';
  });

  it('runs beforeRun before issuing the query', async () => {
    mockSdk.messages = [successResult('streamed', 0.003)];

    const beforeRun = vi.fn(async (_kind: string, input: unknown) => ({
      ...(input as Record<string, unknown>),
      injected: 'pre-stream-memory',
    }));

    const response = streamTask(
      'AttributionTask',
      { hello: 'world' },
      { db: testDb(), r2: memR2(), middleware: { beforeRun } },
    );
    // Drain so the start() callback runs to completion.
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    expect(beforeRun).toHaveBeenCalledOnce();
    expect(JSON.stringify(mockSdk.capturedPrompt)).toContain('pre-stream-memory');
  });

  it('writes USD cost via cost_ledger (not micro-USD)', async () => {
    mockSdk.messages = [successResult('hello', 0.005)];

    const response = streamTask('AttributionTask', { input: 'x' }, { db: testDb(), r2: memR2() });
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    const { ai_task_runs, cost_ledger } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');
    const rows = await testDb()
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.task_kind, 'AttributionTask'));
    expect(rows).toHaveLength(1);
    expect(rows[0].cost).toBeCloseTo(0.005, 6);
    const taskRunId = rows[0].task_run_id;
    expect(taskRunId).toBeTruthy();
    if (!taskRunId) throw new Error('expected cost_ledger.task_run_id');

    const runRows = await testDb()
      .select()
      .from(ai_task_runs)
      .where(eq(ai_task_runs.id, taskRunId));
    expect(runRows).toHaveLength(1);
    expect(runRows[0]).toMatchObject({
      task_kind: 'AttributionTask',
      status: 'success',
      finish_reason: 'end_turn',
    });
  });
});
