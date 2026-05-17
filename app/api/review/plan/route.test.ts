import { material_fsrs_state, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './route';

function req(qs = '') {
  return new Request(`http://localhost/api/review/plan${qs}`, { method: 'GET' });
}

describe('GET /api/review/plan', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns empty queue + null intent + window when no data', async () => {
    const res = await GET(req('?intent=skip'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      queue: unknown[];
      session_intent: string | null;
      window: { computed_at: number; limit: number };
    };
    expect(body.queue).toEqual([]);
    expect(body.session_intent).toBeNull();
    expect(body.window.limit).toBe(20);
    expect(body.window.computed_at).toBeGreaterThan(0);
  });

  it('returns queue with priority + rationale for never-reviewed failure attempts', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(question).values({
      id: 'q1',
      kind: 'short_answer',
      prompt_md: 'p',
      reference_md: null,
      source: 'manual',
      created_at: now,
      updated_at: now,
    });
    await writeEvent(db, {
      id: createId(),
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q1',
      outcome: 'failure',
      payload: { answer_md: 'w', answer_image_refs: [], referenced_knowledge_ids: [] },
      created_at: now,
    });

    const res = await GET(req('?intent=skip'));
    const body = (await res.json()) as {
      queue: Array<{ question_id: string; priority: number; rationale: string }>;
    };
    expect(body.queue).toHaveLength(1);
    expect(body.queue[0].question_id).toBe('q1');
    expect(body.queue[0].priority).toBeGreaterThanOrEqual(1);
    expect(body.queue[0].rationale).toContain('首次复习');
  });

  it('respects limit query param', async () => {
    const db = testDb();
    const now = new Date();
    for (let i = 0; i < 5; i++) {
      await db.insert(question).values({
        id: `q${i}`,
        kind: 'short_answer',
        prompt_md: `p${i}`,
        reference_md: null,
        source: 'manual',
        created_at: now,
        updated_at: now,
      });
      await writeEvent(db, {
        id: createId(),
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'attempt',
        subject_kind: 'question',
        subject_id: `q${i}`,
        outcome: 'failure',
        payload: { answer_md: 'w', answer_image_refs: [], referenced_knowledge_ids: [] },
        created_at: now,
      });
    }
    const res = await GET(req('?intent=skip&limit=2'));
    const body = (await res.json()) as { queue: unknown[]; window: { limit: number } };
    expect(body.queue).toHaveLength(2);
    expect(body.window.limit).toBe(2);
    // suppress unused
    void material_fsrs_state;
  });
});
