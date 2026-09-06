import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilities } from '@/capabilities';
import { registerCapabilityTools } from '@/server/ai/tools/register-capability-tools';
import { getTool } from '@/server/ai/tools/registry';
import { resetDb } from '../../../../tests/helpers/db';
import { createCopilotReplyFinalizer, primaryViewLearningContent } from './reply-finalization';
import { REALISTIC_EVIDENCE_TRACE } from './reply-finalization.actual-fixture';
import { buildCopilotToolResultSnapshot } from './tool-result-snapshot';

beforeAll(async () => registerCapabilityTools(capabilities));
beforeEach(async () => resetDb());

describe('result snapshots use real registered domain output contracts', () => {
  it.each(REALISTIC_EVIDENCE_TRACE.map((observation, index) => ({ ...observation, index })))(
    'preserves actual-shaped $name evidence $index without inventing unknown values',
    ({ name, output }) => {
      const snapshot = buildCopilotToolResultSnapshot(name, output);
      expect(snapshot.state).toBe('available');
      if (snapshot.state !== 'available') throw new Error(`unavailable ${name}`);
      const canonical = getTool(name)?.outputSchema.parse(output) as Record<string, unknown>;
      const value = snapshot.value as Record<string, unknown>;
      for (const field of [
        'coverage',
        'query_scope',
        'claim_boundaries',
        'claim_support',
        'queue_assertion',
        'queue_coverage',
        'timeline_coverage',
        'entity_status_coverage',
      ]) {
        if (field in canonical) expect(value[field]).toEqual(canonical[field]);
      }
      expect(Object.keys(value).length).toBeGreaterThan(1);
      expect(snapshot.byte_length).toBeLessThanOrEqual(32_000);
    },
  );

  it('strips Mem0 passthrough and opaque attribution without deleting the actual record', () => {
    const memory = buildCopilotToolResultSnapshot('search_memory_facts', {
      facts: [
        {
          id: 'f-42',
          memory: '用户正在复习函数定义域',
          score: 0,
          metadata: { secret: 'private' },
          provider_trace: 'private',
        },
      ],
      count: 1,
    });
    expect(memory).toMatchObject({
      state: 'available',
      value: { facts: [{ id: 'f-42', memory: '用户正在复习函数定义域', score: 0 }], count: 1 },
    });
    expect(JSON.stringify(memory)).not.toContain('provider_trace');
    const record = {
      id: 'r-42',
      kind: 'note',
      title: null,
      content_md: '参数分类讨论与边界反例。'.repeat(30),
      source: 'user',
      capture_mode: 'text',
      activity_kind: 'learning',
      origin_event_id: null,
      processing_status: 'done',
      knowledge_ids: [],
      created_at: '2026-09-07T00:00:00Z',
    };
    const snapshot = buildCopilotToolResultSnapshot('get_record_context', {
      record,
      attribution: {
        chosen_source: 'judge',
        judge: { internal_prompt: 'private' },
        user_cause: null,
      },
    });
    expect(snapshot).toMatchObject({
      state: 'available',
      value: { record, attribution: { chosen_source: 'judge' } },
      completeness: 'projected',
    });
    expect(JSON.stringify(snapshot)).not.toContain('internal_prompt');
  });

  it('binds generated text to the actual call and the existing learning gate, rejecting blocked content', async () => {
    const name = 'generate_question_candidate';
    const text = '求函数 f(x)=1/(x-a) 的定义域，并分类讨论参数 a。';
    const output = {
      text,
      task_run_id: 'child-42',
      cost_usd: 0,
      cost_basis: 'estimated',
      cost_ref: 'private-price',
      finish_reason: 'end_turn',
    };
    const validate = vi.fn(
      async (
        reply: string,
        _context: string,
        _task: string,
        view?: Parameters<typeof primaryViewLearningContent>[0],
      ) => ({ replyText: reply, passed: !primaryViewLearningContent(view) }),
    );
    const finalizer = createCopilotReplyFinalizer({
      rootTaskRunId: 'root-42',
      userContextText: '帮我练习定义域',
      correctionContract: {
        available_prior_turn_ids: [],
        prior_turn_summaries: {},
        required_fields: ['prior_turn_id', 'changed', 'retained', 'uncertain'],
      },
      validateLearningContent: validate,
      resolveArtifactReference: async () => null,
    });
    const pre = finalizer.hooks.PreToolUse?.[0].hooks[0] as HookCallback;
    const nomination = { source: 'tool_result', ref: { kind: name, id: 'read-42' } };
    for (const observation of [
      { name, effect: 'read' as const, tool_use_id: 'read-42', output },
      {
        name: 'present_primary_view',
        effect: 'control' as const,
        tool_use_id: 'present-42',
        output: nomination,
      },
    ]) {
      await pre(
        {
          hook_event_name: 'PreToolUse',
          session_id: 'sdk-42',
          transcript_path: '/tmp/transcript',
          cwd: '/tmp',
          tool_name: `mcp__loom__${observation.name}`,
          tool_use_id: observation.tool_use_id,
          tool_input: {},
        },
        observation.tool_use_id,
        { signal: new AbortController().signal },
      );
      finalizer.observeDomainTool({
        ...observation,
        input: {},
        executed: true,
        error_reason: null,
      });
    }
    output.text = 'mutated after observation';
    const result = await finalizer.finalizeTerminal('已准备练习。');
    const published = validate.mock.calls[0][3];
    expect(primaryViewLearningContent(published)).toBe(text);
    expect(JSON.stringify(published)).not.toContain('private-price');
    expect(result.preparedReply.primaryView).toBeUndefined();
    expect(result.receipt.learning_content).toBe('blocked');
  });
});
