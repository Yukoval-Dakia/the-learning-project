import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { capabilities } from '@/capabilities';
import { registerCapabilityTools } from '@/server/ai/tools/register-capability-tools';
import { resetDb } from '../../../../tests/helpers/db';
import { buildCopilotToolResultSnapshot } from './tool-result-snapshot';

beforeAll(async () => registerCapabilityTools(capabilities));
beforeEach(async () => resetDb());

describe('result snapshots use real registered domain output contracts', () => {
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
});
