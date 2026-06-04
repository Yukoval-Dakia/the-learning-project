// U5 (YUK-203) — GET /api/practice + POST /api/practice (+ [id]/answer +
// [id]/submit) route-level DB tests. Exercises the full API surface the
// L-practice-ui lane consumes: the practice list aggregation shape, the
// paper-session start, draft autosave, and per-slot submit (attempt + judge +
// FSRS + freeze). Uses the deterministic exact judge (true_false vs reference).

import { artifact, knowledge, question } from '@/db/schema';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { POST as answerPost } from './[id]/answer/route';
import { POST as submitPost } from './[id]/submit/route';
import { GET, POST } from './route';

async function seedQuestion(id: string, reference: string) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id,
    kind: 'true_false',
    prompt_md: `Prompt ${id}`,
    reference_md: reference,
    knowledge_ids: ['k1'],
    difficulty: 3,
    source: 'manual',
    variant_depth: 0,
    version: 0,
    created_at: now,
    updated_at: now,
  });
}

async function seedPaper(id: string, intentSource: string, questionIds: string[]) {
  const db = testDb();
  const now = new Date();
  await db.insert(artifact).values({
    id,
    type: 'tool_quiz',
    title: `卷 ${id}`,
    knowledge_ids: ['k1'],
    intent_source: intentSource,
    source: 'ai_generated',
    tool_kind: intentSource,
    tool_state: {
      question_ids: questionIds,
      sections: [
        {
          knowledge_focus: ['k1'],
          feedback_policy: 'immediate',
          adaptation_policy: 'none',
          assignments: questionIds.map((qid) => ({
            question_id: qid,
            primary_knowledge_id: 'k1',
            secondary_knowledge_ids: [],
            selection_reason: 'test',
            review_profile_snapshot: {},
          })),
        },
      ],
    } as never,
    generation_status: 'ready',
    verification_status: 'not_required',
    history: [],
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

async function seedKnowledge(id: string, name: string) {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name,
    created_at: now,
    updated_at: now,
  });
}

function jsonReq(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('GET /api/practice', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns papers with provenance source mapping + total_slots + null session', async () => {
    await seedQuestion('q1', 'true');
    await seedQuestion('q2', 'true');
    await seedPaper('p_coach', 'review_plan', ['q1', 'q2']);
    await seedPaper('p_custom', 'quiz_gen', ['q1']);
    await seedPaper('p_note', 'embedded_check', ['q2']);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      papers: Array<{
        artifact_id: string;
        source: string;
        total_slots: number;
        session: unknown;
      }>;
    };
    const byId = new Map(body.papers.map((p) => [p.artifact_id, p]));
    expect(byId.get('p_coach')?.source).toBe('coach');
    expect(byId.get('p_custom')?.source).toBe('custom');
    expect(byId.get('p_note')?.source).toBe('note');
    expect(byId.get('p_coach')?.total_slots).toBe(2);
    expect(byId.get('p_coach')?.session).toBeNull();
  });

  it('full flow: start session → autosave draft → submit slot → list reflects pos/right', async () => {
    await seedQuestion('q1', 'true');
    await seedPaper('p1', 'review_plan', ['q1']);

    // start
    const startRes = await POST(jsonReq('http://localhost/api/practice', { artifact_id: 'p1' }));
    expect(startRes.status).toBe(200);
    const { session_id } = (await startRes.json()) as { session_id: string };
    expect(session_id).toBeTruthy();

    // the session is linked to the paper via artifact_id
    const db = testDb();
    const sessRows = await db.execute<{ artifact_id: string | null }>(
      sql`SELECT artifact_id FROM learning_session WHERE id = ${session_id}`,
    );
    expect((sessRows as unknown as Array<{ artifact_id: string | null }>)[0]?.artifact_id).toBe(
      'p1',
    );

    // autosave a draft
    const ansRes = await answerPost(
      jsonReq('http://localhost/api/practice/p1/answer', {
        session_id,
        question_id: 'q1',
        content_md: 'true',
      }),
      { params: Promise.resolve({ id: 'p1' }) },
    );
    expect(ansRes.status).toBe(200);

    // submit the slot (correct → right)
    const subRes = await submitPost(
      jsonReq('http://localhost/api/practice/p1/submit', {
        session_id,
        question_id: 'q1',
        answer_md: 'true',
      }),
      { params: Promise.resolve({ id: 'p1' }) },
    );
    expect(subRes.status).toBe(200);
    const sub = (await subRes.json()) as {
      attempt_event_id: string;
      judge_event_id: string;
      visible_to_user: boolean;
      coarse_outcome: string;
    };
    expect(sub.coarse_outcome).toBe('correct');
    expect(sub.visible_to_user).toBe(true);
    expect(sub.attempt_event_id).toBeTruthy();
    expect(sub.judge_event_id).toBeTruthy();

    // list now reflects the linked session + pos=1 + right=1
    const listRes = await GET();
    const list = (await listRes.json()) as {
      papers: Array<{
        artifact_id: string;
        session: { id: string; status: string; pos: number; right: number; wrong: number } | null;
      }>;
    };
    const p1 = list.papers.find((p) => p.artifact_id === 'p1');
    expect(p1?.session?.id).toBe(session_id);
    expect(p1?.session?.pos).toBe(1);
    expect(p1?.session?.right).toBe(1);
    expect(p1?.session?.wrong).toBe(0);
  });

  it('knowledge[] carries human-readable names; unknown id falls back to id itself', async () => {
    await seedQuestion('q1', 'true');
    // k_named: node exists with a readable name.
    // k_missing: no row in knowledge table → fallback to id.
    await seedKnowledge('k_named', '诗词鉴赏');
    const db = testDb();
    await db.insert(artifact).values({
      id: 'p_named',
      type: 'tool_quiz',
      title: '知识名测试',
      knowledge_ids: ['k_named', 'k_missing'],
      intent_source: 'review_plan',
      source: 'ai_generated',
      tool_kind: 'review_plan',
      tool_state: {
        question_ids: ['q1'],
        sections: [
          {
            knowledge_focus: ['k_named'],
            feedback_policy: 'immediate',
            adaptation_policy: 'none',
            assignments: [
              {
                question_id: 'q1',
                primary_knowledge_id: 'k_named',
                secondary_knowledge_ids: [],
                selection_reason: 'test',
                review_profile_snapshot: {},
              },
            ],
          },
        ],
      } as never,
      generation_status: 'ready',
      verification_status: 'not_required',
      history: [],
      created_at: new Date(),
      updated_at: new Date(),
      version: 0,
    });

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      papers: Array<{
        artifact_id: string;
        knowledge_ids: string[];
        knowledge: Array<{ id: string; name: string }>;
      }>;
    };
    const paper = body.papers.find((p) => p.artifact_id === 'p_named');
    expect(paper).toBeDefined();
    // knowledge_ids unchanged (backward compat)
    expect(paper?.knowledge_ids).toEqual(['k_named', 'k_missing']);
    // knowledge[] provides resolved names
    const byId = new Map(paper?.knowledge?.map((k) => [k.id, k.name]));
    expect(byId.get('k_named')).toBe('诗词鉴赏'); // resolved from DB
    expect(byId.get('k_missing')).toBe('k_missing'); // fallback: id itself
  });

  it('submit rejects a slot not in the paper plan (400)', async () => {
    await seedQuestion('q1', 'true');
    await seedPaper('p1', 'review_plan', ['q1']);
    const startRes = await POST(jsonReq('http://localhost/api/practice', { artifact_id: 'p1' }));
    const { session_id } = (await startRes.json()) as { session_id: string };

    const subRes = await submitPost(
      jsonReq('http://localhost/api/practice/p1/submit', {
        session_id,
        question_id: 'q_not_in_plan',
        answer_md: 'x',
      }),
      { params: Promise.resolve({ id: 'p1' }) },
    );
    expect(subRes.status).toBe(400);
  });
});
