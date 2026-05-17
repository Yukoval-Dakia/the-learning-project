// Phase 2C — POST /api/teaching-sessions route test.

import { learning_item, learning_session } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';

// Mock the orchestrator + runner so we don't hit a real LLM
vi.mock('@/server/orchestrator/teaching', async () => {
  const actual = await vi.importActual<typeof import('@/server/orchestrator/teaching')>(
    '@/server/orchestrator/teaching',
  );
  return {
    ...actual,
    planTeachingTurn: vi.fn(async () => ({
      kind: 'explain' as const,
      text_md: '今天我们看「之」字的用法。',
      suggested_next: 'continue' as const,
    })),
  };
});

import { POST } from './route';

function postReq(body: unknown) {
  return new Request('http://localhost/api/teaching-sessions', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

async function seedLearningItem(id: string) {
  const db = testDb();
  const now = new Date();
  await db.insert(learning_item).values({
    id,
    source: 'manual',
    title: '虚词「之」',
    content: '掌握「之」的用法',
    knowledge_ids: [],
    child_learning_item_ids: [],
    status: 'pending',
    user_pinned: false,
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

describe('POST /api/teaching-sessions', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns 404 when learning_item is missing', async () => {
    const res = await POST(postReq({ learning_item_id: 'li_missing' }));
    expect(res.status).toBe(404);
  });

  it('creates a conversation session + writes initial agent message', async () => {
    await seedLearningItem('li_real');
    const res = await POST(postReq({ learning_item_id: 'li_real' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      session_id: string;
      initial_message: { role: string; text_md: string; turn_kind: string };
      suggested_next: string;
    };
    expect(body.session_id).toBeTruthy();
    expect(body.initial_message.role).toBe('agent');
    expect(body.initial_message.turn_kind).toBe('explain');
    expect(body.suggested_next).toBe('continue');

    // Session row exists with correct fields
    const sessions = await testDb()
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, body.session_id));
    expect(sessions).toHaveLength(1);
    expect(sessions[0].type).toBe('conversation');
    expect(sessions[0].status).toBe('active');
    expect(sessions[0].goal_id).toBe('li_real');
  });

  it('returns 400 on missing learning_item_id', async () => {
    const res = await POST(postReq({}));
    expect(res.status).toBe(400);
  });
});
