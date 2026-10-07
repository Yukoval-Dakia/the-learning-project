import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capabilities } from '@/capabilities';
import { knowledge } from '@/db/schema';
import { registerCapabilityTools } from '@/server/ai/tools/register-capability-tools';
import { getTool } from '@/server/ai/tools/registry';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { createCopilotReplyFinalizer } from './reply-finalization';
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

  it.each(['success'] as const)(
    'binds a generated candidate to its actual tool output without a second review %s',
    async () => {
      await testDb().insert(knowledge).values({
        id: 'k_snapshot_math',
        name: '整数乘法',
        domain: 'math',
        created_at: new Date(),
        updated_at: new Date(),
      });
      const intent = { seed_mode: 'knowledge', knowledge_ids: ['k_snapshot_math'] };
      const name = 'generate_question_candidate';
      const text = JSON.stringify({
        kind: 'computation',
        difficulty: 2,
        knowledge_ids: ['k_snapshot_math'],
        structured: {
          id: 'model-placeholder',
          role: 'standalone',
          prompt_text: '计算 17×19',
          answers: ['323'],
          analysis: '17×20−17=323。',
        },
        choices_md: null,
      });
      const output = {
        text,
        subject_id: 'math',
        task_run_id: 'child-42',
        cost_usd: 0,
        cost_basis: 'estimated',
        cost_ref: 'private-price',
        finish_reason: 'end_turn',
      };
      const finalizer = createCopilotReplyFinalizer({
        rootTaskRunId: 'root-42',
        correctionContract: {
          available_prior_turn_ids: [],
          prior_turn_summaries: {},
          required_fields: ['prior_turn_id', 'changed', 'retained', 'uncertain'],
        },
        resolveArtifactReference: async () => null,
      });
      const pre = finalizer.piHooks.beforeToolCall[0];
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
          { id: observation.tool_use_id, name: `mcp__loom__${observation.name}` },
          (observation.name === name ? intent : {}) as Record<string, unknown>,
          new AbortController().signal,
        );
        finalizer.observeDomainTool({
          ...observation,
          input: observation.name === name ? intent : {},
          executed: true,
          error_reason: null,
        });
      }
      output.text = 'mutated after observation';
      intent.knowledge_ids[0] = 'mutated after observation';
      const result = await finalizer.finalizeTerminal('已准备练习。');
      const published = result.preparedReply.primaryView;
      expect(result.accepted).toBe(true);
      expect(JSON.stringify(published)).toContain('计算 17×19');
      expect(JSON.stringify(published)).not.toContain('mutated after observation');
      expect(JSON.stringify(published)).not.toContain('private-price');
      expect(result.replyText).toBe('已准备练习。');
    },
  );
});
