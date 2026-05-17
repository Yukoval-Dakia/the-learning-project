import { knowledge } from '@/db/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';

// Mock the orchestrator so we don't hit real LLM in route tests.
vi.mock('@/server/orchestrator/learning_intent', async () => {
  const actual = await vi.importActual<typeof import('@/server/orchestrator/learning_intent')>(
    '@/server/orchestrator/learning_intent',
  );
  return {
    ...actual,
    planLearningIntent: vi.fn(async ({ topic }: { topic: string }) => {
      if (topic === '不存在') {
        throw new actual.LearningIntentError(
          'topic_not_found',
          `没有找到匹配「${topic}」的知识点。`,
        );
      }
      if (topic === '无子节点') {
        throw new actual.LearningIntentError('topic_no_children', `「${topic}」没有子节点。`);
      }
      return {
        proposal_id: 'prop_test',
        topic,
        knowledge_node: { id: 'k1', name: topic, domain: 'wenyan' },
        hub: { title: `${topic} hub`, summary_md: '...' },
        atomics: [{ knowledge_id: 'k_a', title: 'a', one_line_intent: 'i' }],
      };
    }),
  };
});

import { POST } from './route';

function postReq(body: unknown) {
  return new Request('http://localhost/api/learning-intents', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/learning-intents', () => {
  beforeEach(async () => {
    await resetDb();
    // Seed minimal knowledge so the mocked path doesn't matter
    await testDb().insert(knowledge).values({
      id: 'k_seed',
      name: 'seed',
      domain: null,
      parent_id: null,
      merged_from: [],
      proposed_by_ai: false,
      approval_status: 'approved',
      created_at: new Date(),
      updated_at: new Date(),
      version: 0,
    });
  });

  it('returns proposal for valid topic', async () => {
    const res = await POST(postReq({ topic: '虚词' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { proposal_id: string; atomics: unknown[] };
    expect(body.proposal_id).toBe('prop_test');
    expect(body.atomics).toHaveLength(1);
  });

  it('returns 422 when topic_not_found', async () => {
    const res = await POST(postReq({ topic: '不存在' }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('topic_not_found');
  });

  it('returns 422 when topic_no_children', async () => {
    const res = await POST(postReq({ topic: '无子节点' }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('topic_no_children');
  });

  it('returns 400 on missing topic', async () => {
    const res = await POST(postReq({}));
    expect(res.status).toBe(400);
  });

  it('returns 400 on overlong topic', async () => {
    const res = await POST(postReq({ topic: 'x'.repeat(200) }));
    expect(res.status).toBe(400);
  });
});
