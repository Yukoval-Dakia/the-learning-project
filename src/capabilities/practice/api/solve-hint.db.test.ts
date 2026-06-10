import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { question } from '@/db/schema';
import { Tutor } from '@/server/session';
import { resetDb, testDb } from '../../../../tests/helpers/db';

vi.mock('@/server/ai/runner', () => ({
  runTask: vi.fn(async () => ({
    text: JSON.stringify({
      kind: 'explain',
      text_md: '想想分子能否因式分解？',
      suggested_next: 'continue',
    }),
    task_run_id: 'tr',
    finishReason: 'stop',
    usage: { inputTokens: 0, outputTokens: 0 },
  })),
}));

const db = testDb();

describe('POST /api/questions/[id]/solve/[sid]/hint', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns a hint for an active session', async () => {
    const { POST } = await import('./solve-hint');
    const id = createId();
    const now = new Date();
    await db.insert(question).values({
      id,
      kind: 'derivation',
      prompt_md: '化简 (a^2 - b^2)/(a - b)',
      reference_md: '完整解：a+b。',
      rubric_json: {
        criteria: [],
        reference_solution: {
          expected_signals: ['s'],
          final_answer: 'a + b',
          answer_equivalents: [],
        },
      } as never,
      knowledge_ids: [],
      difficulty: 3,
      source: 'manual',
      created_at: now,
      updated_at: now,
      version: 0,
    });
    const { sessionId } = await Tutor.startTutorSession(db, { questionId: id });

    const res = await POST(
      new Request('http://t/x', { method: 'POST', body: JSON.stringify({ hint_index: 0 }) }),
      { id, sid: sessionId },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text_md: string };
    expect(body.text_md).toContain('因式分解');
  });
});
