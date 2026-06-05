import { physicsProfile } from '@/subjects/physics/profile';
import { wenyanProfile } from '@/subjects/wenyan/profile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tasks } from './registry';
import { getTaskSystemPrompt } from './task-prompts';

// Mock the runner's trace-write layer so the unit test can positively assert the
// ai-run trace rows are written WITHOUT a live Postgres (log.ts imports @/db/client
// type-only + @/db/schema table objects, so mocking it keeps this in the unit
// partition). The SDK boundary is mocked so no `claude` binary is spawned.
const trace = vi.hoisted(() => ({
  started: vi.fn(async () => {}),
  finished: vi.fn(async () => {}),
  cost: vi.fn(async () => {}),
  toolCall: vi.fn(async () => {}),
}));

vi.mock('@/server/ai/log', () => ({
  writeAiTaskRunStarted: trace.started,
  writeAiTaskRunFinished: trace.finished,
  writeCostLedger: trace.cost,
  writeToolCallLog: trace.toolCall,
}));

const mockSdk = vi.hoisted(() => ({ messages: [] as unknown[] }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() => {
    const iter = (async function* () {
      for (const m of mockSdk.messages) yield m;
    })();
    return iter;
  }),
  createSdkMcpServer: vi.fn(() => ({ type: 'sdk', name: '', instance: {} })),
  tool: vi.fn((name: string, description: string) => ({ name, description })),
}));

describe('ProfileCriticTask registry entry', () => {
  it('is a single-shot, no-tool, 60s text-only task (mirrors TeachingTurnTask)', () => {
    const entry = tasks.ProfileCriticTask;
    expect(entry.allowedTools).toEqual([]);
    expect(entry.needsToolCall).toBe(false);
    expect(entry.isMultimodal).toBe(false);
    expect(entry.budget.maxIterations).toBe(1);
    expect(entry.budget.timeout).toBe(60_000);
  });
});

describe('ProfileCriticTask prompt (subject-neutral pass-through, Q3)', () => {
  it('returns the SAME system prompt regardless of profile', () => {
    const a = getTaskSystemPrompt('ProfileCriticTask', wenyanProfile);
    const b = getTaskSystemPrompt('ProfileCriticTask', physicsProfile);
    expect(a).toBe(b);
    // The pass-through returns the registry-inline systemPrompt verbatim (the SoT).
    expect(a).toBe(tasks.ProfileCriticTask.systemPrompt);
  });
});

describe('ProfileCriticTask via runner (RL6 proposal-only + trace-written)', () => {
  beforeEach(() => {
    mockSdk.messages = [
      {
        type: 'result',
        subtype: 'success',
        result: '{"review_md":"ok","patches":[],"blocking":false}',
        stop_reason: 'end_turn',
        total_cost_usd: 0.0001,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
      },
    ];
    process.env.XIAOMI_API_KEY = 'sk-test-key';
    trace.started.mockClear();
    trace.finished.mockClear();
    trace.cost.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the ai-run trace rows once each and makes zero profile/file writes', async () => {
    const { runAgentTask } = await import('@/server/ai/runner');
    const { defaultSubjectProfile } = await import('@/subjects/profile');
    const serializeModule = await import('@/subjects/serialize');
    const serializeSpy = vi.spyOn(serializeModule, 'serializeProfileToTs');

    // A dummy db object — log.ts is mocked so it is never dereferenced by real pg.
    const db = {} as unknown as Parameters<typeof runAgentTask>[2]['db'];
    const result = await runAgentTask(
      'ProfileCriticTask',
      { draft: physicsProfile },
      { db, allowedTools: [], subjectProfile: defaultSubjectProfile },
    );

    // Affirmative trace-written assertion (evidence-first; the trace is NOT a
    // domain mutation): each ai-run trace fn fired once.
    expect(trace.started).toHaveBeenCalledTimes(1);
    expect(trace.cost).toHaveBeenCalledTimes(1);
    expect(trace.finished).toHaveBeenCalledTimes(1);

    // RL6 proposal-only: the Critic never serializes/writes profile.ts and never
    // mutates a domain row. (The serializer is only ever called by the --write
    // path, which the Critic does not invoke.)
    expect(serializeSpy).not.toHaveBeenCalled();

    // The review text is returned for stdout/--json emission, not persisted.
    expect(result.text).toContain('review_md');
  });
});
