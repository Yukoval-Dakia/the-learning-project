// Phase 1c.1 Step 6.H — integration back-compat test for the rewritten
// `/api/mistakes/*` routes.
//
// Asserts the wire JSON shape that legacy clients see matches the pre-Step-6
// `mistake`-table-backed shape. Field names + types must be stable; only the
// underlying storage changed.

import { event, knowledge, learning_record, question } from '@/db/schema';
import { beforeEach, describe, expect, it } from 'vitest';

import { GET as GET_RECENT } from '@/../app/api/mistakes/recent/route';
import { GET as GET_LIST } from '@/../app/api/mistakes/route';

import { resetDb, testDb } from '../helpers/db';

const FIXTURE_TIME = new Date('2026-05-15T12:00:00Z');

async function insertMistakeRecord(opts: {
  attemptEventId: string;
  questionId: string;
  answer_md: string;
  knowledge_ids?: string[];
  created_at?: Date;
}) {
  const db = testDb();
  const createdAt = opts.created_at ?? FIXTURE_TIME;
  await db.insert(learning_record).values({
    id: `lr_${opts.attemptEventId}`,
    kind: 'mistake',
    title: null,
    content_md: opts.answer_md,
    source: 'manual',
    capture_mode: 'text',
    activity_kind: 'attempt',
    processing_status: 'raw',
    origin_event_id: opts.attemptEventId,
    subject_id: null,
    knowledge_ids: opts.knowledge_ids ?? ['k1'],
    question_id: opts.questionId,
    attempt_event_id: opts.attemptEventId,
    learning_item_id: null,
    artifact_id: null,
    source_document_id: null,
    asset_refs: [],
    payload: { wrong_answer_md: opts.answer_md },
    created_at: createdAt,
    updated_at: createdAt,
    archived_at: null,
    version: 0,
  });
}

async function seedFixture() {
  const db = testDb();
  await db.insert(knowledge).values({
    id: 'k1',
    name: '概念',
    domain: 'wenyan',
    parent_id: null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    created_at: FIXTURE_TIME,
    updated_at: FIXTURE_TIME,
    version: 0,
  });
  await db.insert(question).values({
    id: 'q1',
    kind: 'short_answer',
    prompt_md: '解释 之 的用法',
    reference_md: '取消句子独立性',
    knowledge_ids: ['k1'],
    difficulty: 3,
    source: 'manual',
    variant_depth: 0,
    created_at: FIXTURE_TIME,
    updated_at: FIXTURE_TIME,
    version: 0,
  });
  await db.insert(event).values({
    id: 'evt_attempt_1',
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'q1',
    outcome: 'failure',
    payload: {
      answer_md: '错答内容',
      answer_image_refs: [],
      referenced_knowledge_ids: ['k1'],
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: FIXTURE_TIME,
  });
  await db.insert(event).values({
    id: 'evt_judge_1',
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'attribution',
    action: 'judge',
    subject_kind: 'event',
    subject_id: 'evt_attempt_1',
    outcome: 'success',
    payload: {
      cause: {
        primary_category: 'concept',
        secondary_categories: [],
        analysis_md: 'concept confusion',
        confidence: 0.9,
      },
      referenced_knowledge_ids: ['k1'],
    },
    caused_by_event_id: 'evt_attempt_1',
    task_run_id: null,
    cost_micro_usd: null,
    created_at: new Date(FIXTURE_TIME.getTime() + 60_000),
  });
  await insertMistakeRecord({
    attemptEventId: 'evt_attempt_1',
    questionId: 'q1',
    answer_md: '错答内容',
  });
}

// The exact wire-shape we promise external clients. ANY field rename / type
// change here is a breaking contract change.
type MistakeShape = {
  id: string;
  question_id: string;
  prompt_md: string;
  wrong_answer_md: string;
  knowledge_ids: string[];
  cause: { primary_category: string; user_notes: string | null } | null;
  created_at: number;
};

function assertMistakeShape(row: unknown): asserts row is MistakeShape {
  if (typeof row !== 'object' || row === null) throw new Error('row is not an object');
  const r = row as Record<string, unknown>;
  if (typeof r.id !== 'string') throw new Error(`id is not a string: ${typeof r.id}`);
  if (typeof r.question_id !== 'string')
    throw new Error(`question_id is not a string: ${typeof r.question_id}`);
  if (typeof r.prompt_md !== 'string') throw new Error('prompt_md is not a string');
  if (typeof r.wrong_answer_md !== 'string') throw new Error('wrong_answer_md is not a string');
  if (!Array.isArray(r.knowledge_ids)) throw new Error('knowledge_ids is not an array');
  if (typeof r.created_at !== 'number') throw new Error('created_at must be number (unix seconds)');
  if (r.cause !== null) {
    if (typeof r.cause !== 'object' || r.cause === null)
      throw new Error('cause must be null or object');
    const c = r.cause as Record<string, unknown>;
    if (typeof c.primary_category !== 'string')
      throw new Error('cause.primary_category must be string');
    if (!('user_notes' in c)) throw new Error('cause must have user_notes key (legacy shape)');
    if (c.user_notes !== null && typeof c.user_notes !== 'string')
      throw new Error('cause.user_notes must be string | null');
  }
}

describe('integration: /api/mistakes/* wire-shape back-compat', () => {
  beforeEach(async () => {
    await resetDb();
    await seedFixture();
  });

  it('GET /api/mistakes/recent returns the legacy mistake-shape JSON', async () => {
    const res = await GET_RECENT(new Request('http://localhost/api/mistakes/recent'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(1);
    for (const row of body.rows) assertMistakeShape(row);
    const r = body.rows[0] as MistakeShape;
    expect(r.cause?.primary_category).toBe('concept');
    expect(r.cause?.user_notes).toBeNull(); // Lane B dropped → preserved as null
  });

  it('GET /api/mistakes returns the legacy mistake-shape JSON', async () => {
    const res = await GET_LIST(new Request('http://localhost/api/mistakes'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(1);
    for (const row of body.rows) assertMistakeShape(row);
    const r = body.rows[0] as MistakeShape;
    expect(r.question_id).toBe('q1');
    expect(r.cause?.user_notes).toBeNull();
  });

  it('two routes return identical row payloads for the same underlying events', async () => {
    const recentRes = await GET_RECENT(new Request('http://localhost/api/mistakes/recent'));
    const listRes = await GET_LIST(new Request('http://localhost/api/mistakes'));
    const recentBody = (await recentRes.json()) as { rows: MistakeShape[] };
    const listBody = (await listRes.json()) as { rows: MistakeShape[] };
    expect(recentBody.rows).toEqual(listBody.rows);
  });

  it('cause is null when no judge chained to attempt', async () => {
    // Insert a second attempt without chained judge
    const db = testDb();
    await db.insert(event).values({
      id: 'evt_attempt_2',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q1',
      outcome: 'failure',
      payload: {
        answer_md: 'second wrong answer',
        answer_image_refs: [],
        referenced_knowledge_ids: ['k1'],
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(FIXTURE_TIME.getTime() + 120_000),
    });
    await insertMistakeRecord({
      attemptEventId: 'evt_attempt_2',
      questionId: 'q1',
      answer_md: 'second wrong answer',
      created_at: new Date(FIXTURE_TIME.getTime() + 120_000),
    });

    const res = await GET_LIST(new Request('http://localhost/api/mistakes'));
    const body = (await res.json()) as { rows: MistakeShape[] };
    expect(body.rows).toHaveLength(2);
    // Newest first (no judge), then the seeded attempt (with judge)
    expect(body.rows[0].id).toBe('evt_attempt_2');
    expect(body.rows[0].cause).toBeNull();
    expect(body.rows[1].id).toBe('evt_attempt_1');
    expect(body.rows[1].cause).not.toBeNull();
  });
});
