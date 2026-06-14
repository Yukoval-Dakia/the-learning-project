import { knowledge, material_fsrs_state, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { createId } from '@paralleldrive/cuid2';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { GET } from './plan';

function req(qs = '') {
  return new Request(`http://localhost/api/review/plan${qs}`, { method: 'GET' });
}

const BASE_KNOWLEDGE = {
  name: 'test',
  domain: null,
  parent_id: null,
  merged_from: [] as string[],
  proposed_by_ai: false,
  approval_status: 'approved' as const,
  version: 0,
  archived_at: null,
};

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
      queue: Array<{
        question_id: string;
        activity_ref: { kind: string; id: string };
        priority: number;
        rationale: string;
        last_failure_event: { id: string; correction_state: { state: string } } | null;
        subject_profile: { id: string; displayName: string };
      }>;
    };
    expect(body.queue).toHaveLength(1);
    expect(body.queue[0].question_id).toBe('q1');
    expect(body.queue[0].activity_ref).toEqual({ kind: 'question', id: 'q1' });
    expect(body.queue[0].activity_ref.id).toBe(body.queue[0].question_id);
    expect(body.queue[0].priority).toBeGreaterThanOrEqual(1);
    expect(body.queue[0].rationale).toContain('首次复习');
    expect(body.queue[0].last_failure_event).toEqual({
      id: expect.any(String),
      correction_state: expect.objectContaining({ state: 'active' }),
    });
    // No referenced knowledge → no domain → neutral default subject
    // (general, post wenyan-deprotagonist — was wenyan).
    expect(body.queue[0].subject_profile.id).toBe('general');
    expect(body.queue[0].subject_profile.displayName).toBe('通用');
  });

  it('returns queue item subject profile from the first knowledge id effective domain', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values([
      {
        id: 'k_math_root',
        ...BASE_KNOWLEDGE,
        domain: 'math',
        created_at: now,
        updated_at: now,
      },
      {
        id: 'k_math_child',
        ...BASE_KNOWLEDGE,
        parent_id: 'k_math_root',
        created_at: now,
        updated_at: now,
      },
    ]);
    await db.insert(question).values({
      id: 'q_math',
      kind: 'short_answer',
      prompt_md: 'p',
      reference_md: null,
      source: 'manual',
      knowledge_ids: ['k_math_child'],
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
      subject_id: 'q_math',
      outcome: 'failure',
      payload: {
        answer_md: 'w',
        answer_image_refs: [],
        referenced_knowledge_ids: ['k_math_child'],
      },
      created_at: now,
    });

    const res = await GET(req('?intent=skip'));
    const body = (await res.json()) as {
      queue: Array<{
        subject_profile: {
          id: string;
          displayName: string;
          renderConfig: {
            font_family: string;
            notation: string | null;
            code_highlight: string | null;
          };
        };
      }>;
    };
    expect(body.queue[0].subject_profile).toEqual({
      id: 'math',
      displayName: '数学',
      renderConfig: {
        font_family: 'system',
        notation: 'katex',
        code_highlight: null,
      },
    });
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
