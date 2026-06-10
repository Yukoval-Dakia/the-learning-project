// U5 (YUK-203) — GET /api/practice + POST /api/practice (+ [id]/answer +
// [id]/submit) route-level DB tests. Exercises the full API surface the
// L-practice-ui lane consumes: the practice list aggregation shape, the
// paper-session start, draft autosave, and per-slot submit (attempt + judge +
// FSRS + freeze). Uses the deterministic exact judge (true_false vs reference).

import { newId } from '@/core/ids';
import { artifact, event, knowledge, question } from '@/db/schema';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST as answerPost } from './paper-answer-route';
import { POST as submitPost } from './paper-submit-route';
import { GET, POST } from './papers-list';

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

  it('fix #1: buffered submit response structurally omits coarse_outcome/score (§4.9)', async () => {
    await seedQuestion('q1', 'true');
    // Seed a paper with judge_now_show_later policy so feedback is buffered.
    const db = testDb();
    const now = new Date();
    await db.insert(artifact).values({
      id: 'p_buffered',
      type: 'tool_quiz',
      title: '缓冲卷',
      knowledge_ids: ['k1'],
      intent_source: 'review_plan',
      source: 'ai_generated',
      tool_kind: 'review_plan',
      tool_state: {
        question_ids: ['q1'],
        sections: [
          {
            knowledge_focus: ['k1'],
            feedback_policy: 'judge_now_show_later',
            adaptation_policy: 'none',
            assignments: [
              {
                question_id: 'q1',
                primary_knowledge_id: 'k1',
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
      created_at: now,
      updated_at: now,
      version: 0,
    });

    const startRes = await POST(
      jsonReq('http://localhost/api/practice', { artifact_id: 'p_buffered' }),
    );
    const { session_id } = (await startRes.json()) as { session_id: string };

    const subRes = await submitPost(
      jsonReq('http://localhost/api/practice/p_buffered/submit', {
        session_id,
        question_id: 'q1',
        answer_md: 'true',
      }),
      { params: Promise.resolve({ id: 'p_buffered' }) },
    );
    expect(subRes.status).toBe(200);
    const body = (await subRes.json()) as Record<string, unknown>;
    expect(body.visible_to_user).toBe(false);
    expect(body.feedback_buffered).toBe(true);
    // Server gate: coarse_outcome and score must be structurally absent.
    expect('coarse_outcome' in body).toBe(false);
    expect('score' in body).toBe(false);
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

  it('fix #2 (round-4): rejudge event supersedes original verdict in practice list right/wrong', async () => {
    await seedQuestion('q1', 'true');
    await seedPaper('p1', 'review_plan', ['q1']);

    // Start session and submit (correct answer → right=1).
    const startRes = await POST(jsonReq('http://localhost/api/practice', { artifact_id: 'p1' }));
    const { session_id } = (await startRes.json()) as { session_id: string };

    const subRes = await submitPost(
      jsonReq('http://localhost/api/practice/p1/submit', {
        session_id,
        question_id: 'q1',
        answer_md: 'true',
      }),
      { params: Promise.resolve({ id: 'p1' }) },
    );
    const sub = (await subRes.json()) as { attempt_event_id: string };

    // Sanity: list shows right=1 before rejudge.
    const beforeList = (await (await GET()).json()) as {
      papers: Array<{ artifact_id: string; session: { right: number; wrong: number } | null }>;
    };
    expect(beforeList.papers.find((p) => p.artifact_id === 'p1')?.session?.right).toBe(1);

    // Insert a superseding judge event with coarse_outcome='incorrect' to simulate
    // the rejudge (D6: rejudge = new event, never rewrites old; read layer takes newest).
    const db = testDb();
    await db.insert(event).values({
      id: newId(),
      session_id,
      actor_kind: 'agent',
      actor_ref: 'rejudge',
      action: 'judge',
      subject_kind: 'event',
      subject_id: sub.attempt_event_id,
      outcome: 'success',
      payload: { coarse_outcome: 'incorrect', referenced_knowledge_ids: [] },
      caused_by_event_id: sub.attempt_event_id,
      created_at: new Date(),
    });

    // After rejudge: list must reflect the newest judge event → wrong=1, right=0.
    const afterList = (await (await GET()).json()) as {
      papers: Array<{ artifact_id: string; session: { right: number; wrong: number } | null }>;
    };
    const p = afterList.papers.find((p) => p.artifact_id === 'p1');
    expect(p?.session?.right).toBe(0);
    expect(p?.session?.wrong).toBe(1);
  });

  it('fix #2 (round-2): flat quiz (no sections) can be submitted via route', async () => {
    await seedQuestion('q1', 'true');
    const db = testDb();
    const now = new Date();
    // Flat paper: question_ids only, no sections array.
    await db.insert(artifact).values({
      id: 'p_flat',
      type: 'tool_quiz',
      title: 'flat quiz',
      knowledge_ids: [],
      intent_source: 'quiz_gen',
      source: 'ai_generated',
      tool_kind: 'quiz_gen',
      tool_state: { question_ids: ['q1'] } as never,
      generation_status: 'ready',
      verification_status: 'not_required',
      history: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });

    const startRes = await POST(
      jsonReq('http://localhost/api/practice', { artifact_id: 'p_flat' }),
    );
    expect(startRes.status).toBe(200);
    const { session_id } = (await startRes.json()) as { session_id: string };

    const subRes = await submitPost(
      jsonReq('http://localhost/api/practice/p_flat/submit', {
        session_id,
        question_id: 'q1',
        answer_md: 'true',
      }),
      { params: Promise.resolve({ id: 'p_flat' }) },
    );
    expect(subRes.status).toBe(200);
    const body = (await subRes.json()) as { coarse_outcome: string; visible_to_user: boolean };
    expect(body.coarse_outcome).toBe('correct');
    expect(body.visible_to_user).toBe(true);
  });

  // ── round-4 fix #3: POST /api/practice validates artifact before starting ──

  it('round-4 fix #3: POST rejects non-existent artifact with 404', async () => {
    const res = await POST(jsonReq('http://localhost/api/practice', { artifact_id: 'ghost' }));
    expect(res.status).toBe(404);
  });

  it('round-4 fix #3: POST rejects artifact with wrong type (not tool_quiz) with 400', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(artifact).values({
      id: 'note_art',
      type: 'note',
      title: 'a note',
      knowledge_ids: [],
      intent_source: 'manual',
      source: 'manual',
      tool_kind: null,
      tool_state: {} as never,
      generation_status: 'ready',
      verification_status: 'not_required',
      history: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });
    const res = await POST(jsonReq('http://localhost/api/practice', { artifact_id: 'note_art' }));
    expect(res.status).toBe(400);
  });

  it('round-4 fix #3: POST rejects tool_quiz with generation_status=failed with 400', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(artifact).values({
      id: 'failed_paper',
      type: 'tool_quiz',
      title: 'failed paper',
      knowledge_ids: [],
      intent_source: 'review_plan',
      source: 'ai_generated',
      tool_kind: 'review_plan',
      tool_state: { question_ids: [] } as never,
      generation_status: 'failed',
      verification_status: 'not_required',
      history: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });
    const res = await POST(
      jsonReq('http://localhost/api/practice', { artifact_id: 'failed_paper' }),
    );
    expect(res.status).toBe(400);
  });

  it('round-4 fix #3: POST rejects tool_quiz with non-paper intent_source with 400', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(artifact).values({
      id: 'import_art',
      type: 'tool_quiz',
      title: 'import artifact',
      knowledge_ids: [],
      intent_source: 'import',
      source: 'manual',
      tool_kind: 'import',
      tool_state: { question_ids: [] } as never,
      generation_status: 'ready',
      verification_status: 'not_required',
      history: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });
    const res = await POST(jsonReq('http://localhost/api/practice', { artifact_id: 'import_art' }));
    expect(res.status).toBe(400);
  });

  // ── round-6 fix #3 (CR 3359820518): concurrent POST reuses existing session ──

  it('round-6 fix #3: second POST returns the same session_id (idempotent session start)', async () => {
    // Two concurrent tab opens both POST with the same artifact_id. The second
    // must return the id of the already-started session, not create a new one.
    await seedQuestion('q1', 'true');
    await seedPaper('p_idem', 'review_plan', ['q1']);

    const first = await POST(jsonReq('http://localhost/api/practice', { artifact_id: 'p_idem' }));
    expect(first.status).toBe(200);
    const { session_id: sid1 } = (await first.json()) as { session_id: string };
    expect(sid1).toBeTruthy();

    // Second POST — must get same session_id.
    const second = await POST(jsonReq('http://localhost/api/practice', { artifact_id: 'p_idem' }));
    expect(second.status).toBe(200);
    const { session_id: sid2 } = (await second.json()) as { session_id: string };
    expect(sid2).toBe(sid1);

    // Only one session row in the DB for this artifact.
    const db = testDb();
    const rows = await db.execute<{ id: string }>(
      sql`SELECT id FROM learning_session WHERE artifact_id = 'p_idem' AND type = 'review'`,
    );
    expect(rows as unknown as Array<{ id: string }>).toHaveLength(1);
  });

  // ── round-6 fix #2 (CR 3359820526): buffered slots excluded from right/wrong ──

  it('round-6 fix #2: right/wrong excludes buffered slots for in-progress session; includes after completed', async () => {
    // A paper with judge_now_show_later feedback: submitted slots carry
    // visible_to_user:false. The practice list must show right=0/wrong=0 while
    // the session is in-progress; after completed it shows the real counts.
    await seedQuestion('q1', 'true');
    const db = testDb();
    const now = new Date();
    await db.insert(artifact).values({
      id: 'p_buffered_r6',
      type: 'tool_quiz',
      title: '缓冲卷 r6',
      knowledge_ids: ['k1'],
      intent_source: 'review_plan',
      source: 'ai_generated',
      tool_kind: 'review_plan',
      tool_state: {
        question_ids: ['q1'],
        sections: [
          {
            knowledge_focus: ['k1'],
            feedback_policy: 'judge_now_show_later',
            adaptation_policy: 'none',
            assignments: [
              {
                question_id: 'q1',
                primary_knowledge_id: 'k1',
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
      created_at: now,
      updated_at: now,
      version: 0,
    });

    const startRes = await POST(
      jsonReq('http://localhost/api/practice', { artifact_id: 'p_buffered_r6' }),
    );
    const { session_id } = (await startRes.json()) as { session_id: string };

    // Submit (judge_now_show_later → visible_to_user:false on the judge event).
    const subRes = await submitPost(
      jsonReq('http://localhost/api/practice/p_buffered_r6/submit', {
        session_id,
        question_id: 'q1',
        answer_md: 'true',
      }),
      { params: Promise.resolve({ id: 'p_buffered_r6' }) },
    );
    expect(subRes.status).toBe(200);
    const sub = (await subRes.json()) as { visible_to_user: boolean };
    expect(sub.visible_to_user).toBe(false);

    // Practice list while in-progress: right=0, wrong=0 (buffered slot excluded).
    const listInProgress = (await (await GET()).json()) as {
      papers: Array<{
        artifact_id: string;
        session: { right: number; wrong: number; pos: number } | null;
      }>;
    };
    const pInProgress = listInProgress.papers.find((p) => p.artifact_id === 'p_buffered_r6');
    expect(pInProgress?.session?.pos).toBe(1); // pos still counts answered slots
    expect(pInProgress?.session?.right).toBe(0); // buffered — not shown
    expect(pInProgress?.session?.wrong).toBe(0); // buffered — not shown

    // Mark session completed (reveals buffered feedback).
    await db.execute(
      sql`UPDATE learning_session SET status = 'completed' WHERE id = ${session_id}`,
    );

    // Practice list after completed: right=1 (correct answer 'true' vs reference 'true').
    const listCompleted = (await (await GET()).json()) as {
      papers: Array<{ artifact_id: string; session: { right: number; wrong: number } | null }>;
    };
    const pCompleted = listCompleted.papers.find((p) => p.artifact_id === 'p_buffered_r6');
    expect(pCompleted?.session?.right).toBe(1);
    expect(pCompleted?.session?.wrong).toBe(0);
  });
});
