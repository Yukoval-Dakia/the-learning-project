// POST /api/mistakes writes question + attempt event + learning_record(kind='mistake').

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAttemptQuestionSnapshot } from '@/capabilities/practice/public';
import { commitFormalAttempt } from '@/capabilities/practice/server/assessment/attempt';
import { QUESTION_EDIT_ACTION } from '@/core/schema/event/experimental';
import {
  assessment_submission,
  evaluation,
  event,
  knowledge,
  learning_record,
  misconception,
  question,
  source_asset,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { issueSoloFixture } from '../../../../tests/fixtures/assessment-solo';
import { nativeAppealFixture } from '../../../../tests/fixtures/native-appeal';
import { handwritingFixture } from '../../../../tests/fixtures/native-solo-http';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { readMistakes } from '../public';
import { CreateMistakeResponseSchema, MistakeListResponseSchema } from './contracts';
import { GET, POST } from './mistakes';

// Lane D (YUK-482): the failure→propose-new-KC coupling was removed from POST
// /api/mistakes. The producer commits attempt/user-cause facts only; the
// practice-owned durable subscription derives failure learning after commit.

const KNOWLEDGE_BASE = {
  domain: 'yuwen',
  parent_id: null,
  merged_from: [] as string[],
  proposed_by_ai: false,
  approval_status: 'approved' as const,
  version: 0,
};

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    prompt_md: '"之"在主谓间的用法?',
    reference_md: '取消句子独立性',
    wrong_answer_md: '助词',
    knowledge_ids: ['k1'],
    cause: { primary_category: 'concept', user_notes: '没记牢' },
    difficulty: 3,
    question_kind: 'short_answer',
    ...overrides,
  };
}

async function postMistake(body: unknown) {
  return POST(
    new Request('http://localhost/api/mistakes', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  );
}

describe('POST /api/mistakes', () => {
  beforeEach(async () => {
    await resetDb();
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values({
      id: 'k1',
      name: 'X',
      archived_at: null,
      created_at: now,
      updated_at: now,
      ...KNOWLEDGE_BASE,
    });
  });

  it('returns 400 when prompt_md is empty', async () => {
    const res = await postMistake(validBody({ prompt_md: '' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  // P3 (YUK-489) — /api/mistakes stays ids-required (schema enforces ≥1). It carries no subject
  // signal for the unified tagKnowledge to auto-attribute against, so an empty array is rejected at
  // the schema boundary (auto-tagging a manual mistake is a follow-up needing a subject signal).
  it('rejects empty knowledge_ids array (min 1 enforced)', async () => {
    const res = await postMistake(validBody({ knowledge_ids: [] }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('validation_error');
    expect(body.message).toMatch(/at least one knowledge_id/);
  });

  it('returns 400 when knowledge_ids contains non-existent id', async () => {
    const res = await postMistake(validBody({ knowledge_ids: ['k1', 'k_missing'] }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('validation_error');
    expect(body.message).toMatch(/k_missing/);
  });

  it('returns 400 when knowledge_ids contains an archived id', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values({
      id: 'k_archived',
      name: 'Archived',
      ...KNOWLEDGE_BASE,
      archived_at: now,
      created_at: now,
      updated_at: now,
    });
    const res = await postMistake(validBody({ knowledge_ids: ['k_archived'] }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/k_archived/);
  });

  it('inserts question + attempt event + record on valid body (no propose event)', async () => {
    const res = await postMistake(validBody());
    expect(res.status).toBe(201);
    const body = CreateMistakeResponseSchema.parse(await res.json());
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(body.question_id).toBeTruthy();
    expect(body.mistake_id).toBeTruthy();
    expect(body.record_id).toBeTruthy();
    expect(res.headers.get('Location')).toBe(`/api/events/${body.mistake_id}`);
    // Lane D (YUK-482): the response no longer carries a `propose_task` field —
    // recording a mistake records + attributes (错因/mastery) but never proposes a KC.
    expect('propose_task' in body).toBe(false);

    const db = testDb();
    const { eq, and } = await import('drizzle-orm');
    const events = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'attempt'), eq(event.subject_id, body.question_id)));
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('failure');
    expect(events[0].id).toBe(body.mistake_id);

    const records = await db
      .select()
      .from(learning_record)
      .where(and(eq(learning_record.attempt_event_id, body.mistake_id)));
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe(body.record_id);
    expect(records[0].kind).toBe('mistake');
    expect(records[0].question_id).toBe(body.question_id);
    expect(records[0].origin_event_id).toBe(body.mistake_id);

    // Lane D (YUK-482): a wrong attempt must NOT create/propose a KC. No
    // action='propose' knowledge event is written by this endpoint.
    const proposeEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge')));
    expect(proposeEvents).toHaveLength(0);
  });

  it('does not write any mistake row (legacy table dropped)', async () => {
    // schema.ts no longer exports `mistake` — the assertion lives implicit in
    // typecheck. Just verify the event was written without error.
    const res = await postMistake(validBody({ cause: null }));
    expect(res.status).toBe(201);
  });

  it('rejects unknown prompt_image_refs asset id', async () => {
    const res = await postMistake(validBody({ prompt_image_refs: ['asset_missing'] }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/unknown prompt_image_refs/);
  });

  it('rejects unknown wrong_answer_image_refs even when prompt_image_refs is empty', async () => {
    const res = await postMistake(validBody({ wrong_answer_image_refs: ['asset_missing'] }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/unknown wrong_answer_image_refs/);
  });

  it('persists asset id refs in question.metadata + attempt event payload', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(source_asset).values([
      {
        id: 'asset_p',
        kind: 'image',
        storage_key: 'bk_p',
        mime_type: 'image/png',
        byte_size: 1,
        sha256: 'abc',
        created_at: now,
      },
      {
        id: 'asset_w',
        kind: 'image',
        storage_key: 'bk_w',
        mime_type: 'image/png',
        byte_size: 1,
        sha256: 'def',
        created_at: now,
      },
    ]);

    const res = await postMistake(
      validBody({ prompt_image_refs: ['asset_p'], wrong_answer_image_refs: ['asset_w'] }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { question_id: string; mistake_id: string };

    const { eq } = await import('drizzle-orm');
    const qs = await db.select().from(question).where(eq(question.id, body.question_id));
    const meta = qs[0].metadata as {
      prompt_image_refs: string[];
      prompt_image_ref_kind: string;
    } | null;
    expect(meta?.prompt_image_refs).toEqual(['asset_p']);
    expect(meta?.prompt_image_ref_kind).toBe('source_asset_id');
    expect(qs[0].image_refs).toEqual(['asset_p']);

    const events = await db.select().from(event).where(eq(event.id, body.mistake_id));
    expect((events[0].payload as Record<string, unknown>).answer_image_refs).toEqual(['asset_w']);
    expect(events[0].payload).toMatchObject({
      question_snapshot: {
        schema_version: 1,
        question: {
          question_id: body.question_id,
          prompt_md: qs[0].prompt_md,
          reference_md: qs[0].reference_md,
          image_refs: ['asset_p'],
        },
        parent_question: null,
      },
    });
    const list = await (await getMistakes(`question_id=${body.question_id}`)).json();
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0].wrong_answer_image_refs).toEqual(['asset_w']);
    expect(list.rows[0].prompt_materials).toEqual([]);
  });

  it('reads the frozen historical question after the mutable question is edited', async () => {
    const prompt = '原题：解释主谓之间的「之」，并分析上下文。'.repeat(20);
    const reference = '原答案：取消句子独立性，结合上下文说明。'.repeat(20);
    const response = await postMistake(validBody({ prompt_md: prompt, reference_md: reference }));
    expect(response.status).toBe(201);
    const created = CreateMistakeResponseSchema.parse(await response.json());
    await testDb()
      .update(question)
      .set({
        prompt_md: '修改后的另一道题',
        reference_md: '修改后的答案',
        updated_at: new Date(Date.now() + 1000),
      })
      .where(eq(question.id, created.question_id));
    const responseBody = await (await getMistakes(`question_id=${created.question_id}`)).json();
    expect(responseBody.rows).toHaveLength(1);
    expect(responseBody.rows[0].prompt_md).toBe(prompt.slice(0, 200));
    expect(responseBody.rows[0].reference_md).toBe(reference.slice(0, 200));
    expect(responseBody.rows[0].prompt_materials).toEqual([]);
    expect((await readMistakes(testDb(), { question_id: created.question_id })).rows).toEqual(
      responseBody.rows,
    );
    expect(responseBody.rows[0].cause).toMatchObject({ source: 'user', user_notes: '没记牢' });
  });

  // Lane D (YUK-482): a failed attempt with no user-supplied cause remains a
  // durable-subscription eligible PERFORMANCE-axis fact, but must NOT propose a KC.
  it('records the failure + attribution-eligible, but writes no propose event (cause null)', async () => {
    const res = await postMistake(validBody({ cause: null }));
    expect(res.status).toBe(201);

    const db = testDb();
    const { eq, and } = await import('drizzle-orm');
    // The attempt event is recorded (PERFORMANCE-axis signal survives).
    const attempts = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'attempt'), eq(event.outcome, 'failure')));
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    // No KC was proposed off the failure (CONTENT-axis decoupled).
    const proposeEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge')));
    expect(proposeEvents).toHaveLength(0);
  });

  // Lane D (YUK-482): even when a different-subject KC is selected, a wrong
  // attempt produces no propose event (previously this fed KnowledgeProposeTask
  // with the selected knowledge's subject profile).
  it('writes no propose event regardless of the selected knowledge subject', async () => {
    const db = testDb();
    const { eq, and } = await import('drizzle-orm');
    await db.update(knowledge).set({ domain: 'math' }).where(eq(knowledge.id, 'k1'));

    const res = await postMistake(validBody({ cause: null }));
    expect(res.status).toBe(201);

    const proposeEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge')));
    expect(proposeEvents).toHaveLength(0);
  });

  it('commits manual cause with its attempt so the subscription can skip model work', async () => {
    const res = await postMistake(
      validBody({ cause: { primary_category: 'memory', user_notes: null } }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { mistake_id: string };

    const db = testDb();
    const { eq, and } = await import('drizzle-orm');
    const attempts = await db.select().from(event).where(eq(event.id, body.mistake_id));
    expect(attempts).toHaveLength(1);
    expect(attempts[0].action).toBe('attempt');
    expect(attempts[0].outcome).toBe('failure');

    const userCauseRows = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:user_cause'),
          eq(event.caused_by_event_id, body.mistake_id),
        ),
      );
    expect(userCauseRows).toHaveLength(1);
    expect(userCauseRows[0].subject_id).toBe(body.mistake_id);

    const proposeEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'propose'), eq(event.subject_kind, 'knowledge')));
    expect(proposeEvents).toHaveLength(0);
  });

  it('writes an experimental:user_cause event when body.cause !== null', async () => {
    const db = testDb();
    const { eq, and } = await import('drizzle-orm');
    const res = await postMistake(
      validBody({
        cause: { primary_category: 'carelessness', user_notes: '看错题号了' },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { mistake_id: string };

    const userCauseRows = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:user_cause'),
          eq(event.caused_by_event_id, body.mistake_id),
        ),
      );
    expect(userCauseRows).toHaveLength(1);
    expect(userCauseRows[0].actor_kind).toBe('user');
    expect(userCauseRows[0].subject_kind).toBe('event');
    expect(userCauseRows[0].subject_id).toBe(body.mistake_id);
    expect(userCauseRows[0].payload).toEqual({
      primary_category: 'carelessness',
      user_notes: '看错题号了',
    });
  });

  it('rejects a manual cause outside the selected knowledge subject profile', async () => {
    const db = testDb();
    const { eq } = await import('drizzle-orm');
    await db.update(knowledge).set({ domain: 'math' }).where(eq(knowledge.id, 'k1'));

    const res = await postMistake(
      validBody({
        cause: { primary_category: 'grammar', user_notes: null },
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('validation_error');
    expect(body.message).toContain('grammar');
    expect(body.message).toContain('math');
  });

  it('accepts a manual math-specific cause from the selected knowledge subject profile', async () => {
    const db = testDb();
    const { eq, and } = await import('drizzle-orm');
    await db.update(knowledge).set({ domain: 'math' }).where(eq(knowledge.id, 'k1'));

    const res = await postMistake(
      validBody({
        cause: { primary_category: 'unit_error', user_notes: '单位换算错' },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { mistake_id: string };

    const userCauseRows = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:user_cause'),
          eq(event.caused_by_event_id, body.mistake_id),
        ),
      );
    expect(userCauseRows[0].payload).toEqual({
      primary_category: 'unit_error',
      user_notes: '单位换算错',
    });
  });

  it('does NOT write a user_cause event when body.cause is null', async () => {
    const db = testDb();
    const { eq } = await import('drizzle-orm');
    const res = await postMistake(validBody({ cause: null }));
    expect(res.status).toBe(201);
    const userCauseRows = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:user_cause'));
    expect(userCauseRows).toHaveLength(0);
  });
});

// ============================================================================
// Phase 1c.1 Step 6.G — GET /api/mistakes (event-stream projection).
// Unchanged from Step 6.
// ============================================================================

const QUESTION_BASE = {
  kind: 'short_answer',
  reference_md: null,
  knowledge_ids: ['k1'],
  difficulty: 3,
  source: 'manual' as const,
  variant_depth: 0,
  version: 0,
};

async function seedQuestion(
  id: string,
  prompt_md: string,
  created_at = new Date(),
  reference_md: string | null = null,
): Promise<void> {
  const db = testDb();
  await db.insert(question).values({
    id,
    prompt_md,
    created_at,
    updated_at: created_at,
    ...QUESTION_BASE,
    reference_md,
  });
}

async function seedAttempt(opts: {
  id: string;
  question_id: string;
  outcome?: 'failure' | 'success' | 'partial';
  answer_md?: string;
  knowledge_ids?: string[];
  created_at?: Date;
}): Promise<void> {
  const db = testDb();
  const createdAt = opts.created_at ?? new Date();
  await db.insert(event).values({
    id: opts.id,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: opts.question_id,
    outcome: opts.outcome ?? 'failure',
    payload: {
      answer_md: opts.answer_md ?? 'wrong',
      answer_image_refs: [],
      referenced_knowledge_ids: opts.knowledge_ids ?? ['k1'],
    },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: createdAt,
  });
  if ((opts.outcome ?? 'failure') === 'failure') {
    await db.insert(learning_record).values({
      id: `lr_${opts.id}`,
      kind: 'mistake',
      title: null,
      content_md: opts.answer_md ?? 'wrong',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'attempt',
      processing_status: 'raw',
      origin_event_id: opts.id,
      subject_id: null,
      knowledge_ids: opts.knowledge_ids ?? ['k1'],
      question_id: opts.question_id,
      attempt_event_id: opts.id,
      learning_item_id: null,
      artifact_id: null,
      source_document_id: null,
      asset_refs: [],
      payload: { wrong_answer_md: opts.answer_md ?? 'wrong' },
      created_at: createdAt,
      updated_at: createdAt,
      archived_at: null,
      version: 0,
    });
  }
}

async function seedJudge(opts: {
  id: string;
  attempt_event_id: string;
  primary_category?: string;
  secondary_categories?: string[];
  confidence?: number;
  caused_by_event_id?: string | null;
  created_at?: Date;
}): Promise<void> {
  const db = testDb();
  await db.insert(event).values({
    id: opts.id,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'attribution',
    action: 'judge',
    subject_kind: 'event',
    subject_id: opts.attempt_event_id,
    outcome: 'success',
    payload: {
      cause: {
        primary_category: opts.primary_category ?? 'concept',
        secondary_categories: opts.secondary_categories ?? [],
        analysis_md: 'analysis',
        confidence: opts.confidence ?? 0.9,
      },
      referenced_knowledge_ids: ['k1'],
    },
    caused_by_event_id:
      'caused_by_event_id' in opts ? opts.caused_by_event_id : opts.attempt_event_id,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: opts.created_at ?? new Date(),
  });
}

async function seedUserCause(opts: {
  id: string;
  attempt_event_id: string;
  primary_category?: string;
  user_notes?: string | null;
}): Promise<void> {
  const db = testDb();
  await db.insert(event).values({
    id: opts.id,
    session_id: null,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'experimental:user_cause',
    subject_kind: 'event',
    subject_id: opts.attempt_event_id,
    outcome: null,
    payload: {
      primary_category: opts.primary_category ?? 'carelessness',
      user_notes: opts.user_notes ?? null,
    },
    caused_by_event_id: opts.attempt_event_id,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: new Date(),
  });
}

async function seedCorrection(opts: {
  id: string;
  target_event_id: string;
  correction_kind: 'supersede' | 'retract' | 'mark_wrong' | 'restore';
  replacement_event_id?: string;
  created_at?: Date;
}): Promise<void> {
  const db = testDb();
  await writeEvent(db, {
    id: opts.id,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'correct',
    subject_kind: 'event',
    subject_id: opts.target_event_id,
    outcome: 'success',
    payload: {
      correction_kind: opts.correction_kind,
      replacement_event_id: opts.replacement_event_id,
      reason_md: 'manual correction',
      affected_refs: [{ kind: 'question', id: 'q1' }],
    },
    created_at: opts.created_at ?? new Date(),
  });
}

async function getMistakes(qs = ''): Promise<Response> {
  return GET(new Request(`http://localhost/api/mistakes${qs ? `?${qs}` : ''}`, { method: 'GET' }));
}

describe('GET /api/mistakes', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('keeps frozen parent context and a null reference when both live questions change', async () => {
    const db = testDb();
    await seedQuestion('parent', '冻结共享题干：阅读材料，并区分句子中各虚词的语法功能。');
    await seedQuestion('part', '子题：解释「之」。', new Date(), null);
    await db.update(question).set({ parent_question_id: 'parent' }).where(eq(question.id, 'part'));
    const snapshot = await loadAttemptQuestionSnapshot(db, 'part');
    await seedAttempt({
      id: 'a_part',
      question_id: 'part',
      answer_md: '原答：代词\n未结合主谓关系。',
    });
    await db
      .update(event)
      .set({
        payload: {
          answer_md: '原答：代词\n未结合主谓关系。',
          answer_image_refs: ['original_answer_image'],
          referenced_knowledge_ids: ['k1'],
          question_snapshot: snapshot,
        },
      })
      .where(eq(event.id, 'a_part'));
    await db.update(question).set({
      prompt_md: '当前新题面',
      reference_md: '当前新答案',
      updated_at: new Date(Date.now() + 1000),
    });
    const result = MistakeListResponseSchema.parse(await (await getMistakes()).json());
    expect(result.rows[0]).toMatchObject({
      id: 'a_part',
      prompt_md: `${snapshot.parent_question?.prompt_md}\n\n${snapshot.question.prompt_md}`,
      reference_md: null,
      wrong_answer_md: '原答：代词\n未结合主谓关系。',
      wrong_answer_image_refs: ['original_answer_image'],
    });
  });

  it.each(['null', 'corrupt', 'unsupported', 'wrong_subject', 'missing_parent'])(
    'retains %s snapshot records without substituting live text',
    async (kind) => {
      const db = testDb();
      await seedQuestion('q1', '当前题面不属于这份可验证的历史证据', new Date(), '当前答案');
      const snapshot = await loadAttemptQuestionSnapshot(db, 'q1');
      const snapshotByKind: Record<string, unknown> = {
        null: null,
        corrupt: { schema_version: 1, question: { prompt_md: '不完整快照' } },
        unsupported: { ...snapshot, schema_version: 2 },
        wrong_subject: {
          ...snapshot,
          question: { ...snapshot.question, question_id: 'other_question' },
        },
        missing_parent: {
          ...snapshot,
          question: { ...snapshot.question, parent_question_id: 'missing' },
        },
      };
      await seedAttempt({ id: 'a1', question_id: 'q1' });
      await seedUserCause({ id: 'cause_a1', attempt_event_id: 'a1', user_notes: '原始人工归因' });
      await db
        .update(event)
        .set({
          payload: {
            answer_md: '历史原答',
            answer_image_refs: ['answer_page_1', 'answer_page_2'],
            referenced_knowledge_ids: ['k1'],
            question_snapshot: snapshotByKind[kind],
          },
        })
        .where(eq(event.id, 'a1'));
      const result = MistakeListResponseSchema.parse(await (await getMistakes()).json());
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        id: 'a1',
        record_id: 'lr_a1',
        prompt_md: '',
        reference_md: null,
        wrong_answer_md: '历史原答',
        wrong_answer_image_refs: ['answer_page_1', 'answer_page_2'],
        cause: { source: 'user', user_notes: '原始人工归因' },
        correction_state: { terminal_state: 'active' },
      });
    },
  );

  it.each(['timestamp', 'edit_event', 'parent_timestamp', 'parent_edit_event'])(
    'retains legacy records after %s evidence of a later edit',
    async (kind) => {
      const db = testDb();
      const created = new Date('2026-10-01T00:00:00Z');
      const attempted = new Date('2026-10-02T00:00:00Z');
      await seedQuestion('parent', '共享旧题干', created);
      await seedQuestion('q1', '子题当前题面', created, '子题当前答案');
      await db.update(question).set({ parent_question_id: 'parent' }).where(eq(question.id, 'q1'));
      await seedAttempt({ id: 'legacy', question_id: 'q1', created_at: attempted });
      const target = kind.startsWith('parent_') ? 'parent' : 'q1';
      if (kind.endsWith('timestamp')) {
        await db.update(question).set({ updated_at: attempted }).where(eq(question.id, target));
      } else {
        // An edit event proves mutation even if a legacy writer retained the old updated_at.
        await db.insert(event).values({
          id: 'edit',
          action: QUESTION_EDIT_ACTION,
          actor_kind: 'user',
          actor_ref: 'self',
          subject_kind: 'question',
          subject_id: target,
          payload: { previous: { prompt_md: '旧题' }, next: { prompt_md: '新题' } },
          created_at: attempted,
        });
      }
      const result = MistakeListResponseSchema.parse(await (await getMistakes()).json());
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        id: 'legacy',
        prompt_md: '',
        prompt_materials: [],
        reference_md: null,
        wrong_answer_md: 'wrong',
      });
    },
  );

  it('uses legacy child and parent text when edits predate the attempt', async () => {
    const db = testDb();
    const created = new Date('2026-10-01T00:00:00Z');
    const edited = new Date('2026-10-02T00:00:00Z');
    await seedQuestion('parent', '作答时已存在的共享题干', created);
    await seedQuestion('part', '作答时已存在的子题', created, '作答时答案');
    await db
      .update(question)
      .set({ parent_question_id: 'parent', updated_at: edited })
      .where(eq(question.id, 'part'));
    await db.insert(event).values({
      id: 'old_edit',
      action: QUESTION_EDIT_ACTION,
      actor_kind: 'user',
      actor_ref: 'self',
      subject_kind: 'question',
      subject_id: 'part',
      payload: {},
      created_at: edited,
    });
    await seedAttempt({
      id: 'legacy',
      question_id: 'part',
      created_at: new Date('2026-10-03T00:00:00Z'),
    });
    const result = await readMistakes(db, { question_id: 'part', limit: '1' });
    expect(result.rows[0]).toMatchObject({
      prompt_md: '作答时已存在的共享题干\n\n作答时已存在的子题',
      reference_md: '作答时答案',
      wrong_answer_image_refs: [],
    });
    expect(result.data).toEqual(result.rows);
    expect(result.page).toEqual({ limit: 1, next_cursor: null });
  });

  it.each(['missing_question', 'missing_parent', 'created_after_attempt'])(
    'keeps a legacy record with %s visible with unavailable text',
    async (kind) => {
      const db = testDb();
      const attempted = new Date('2026-10-02T00:00:00Z');
      if (kind !== 'missing_question') {
        await seedQuestion(
          'q1',
          '不可证明的现值',
          kind === 'created_after_attempt'
            ? new Date('2026-10-03T00:00:00Z')
            : new Date('2026-10-01T00:00:00Z'),
          '不可证明的答案',
        );
        if (kind === 'missing_parent')
          await db
            .update(question)
            .set({ parent_question_id: 'absent_parent' })
            .where(eq(question.id, 'q1'));
      }
      await seedAttempt({ id: 'legacy', question_id: 'q1', created_at: attempted });
      const result = await readMistakes(db);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        id: 'legacy',
        prompt_md: '',
        reference_md: null,
        wrong_answer_md: 'wrong',
      });
    },
  );

  it('keeps a real native failure visible without rebuilding its question from mutable rows', async () => {
    const db = testDb();
    try {
      // Deterministic rules only; the fixture's model executor must never be called.
      const native = await nativeAppealFixture(db, { model: false });
      expect(native.execute).not.toHaveBeenCalled();
      await db.insert(learning_record).values({
        id: 'lr_native',
        kind: 'mistake',
        content_md: '原生原答',
        source: 'manual',
        capture_mode: 'text',
        activity_kind: 'attempt',
        processing_status: 'raw',
        origin_event_id: native.attemptId,
        question_id: native.questionId,
        attempt_event_id: native.attemptId,
        created_at: new Date(),
        updated_at: new Date(),
      });
      const result = MistakeListResponseSchema.parse(await (await getMistakes()).json());
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        id: native.attemptId,
        question_id: native.questionId,
        prompt_md: '顺流18 km/h、逆流12 km/h。列方程求静水船速，并解释相加消元。',
        reference_md: null,
        wrong_answer_md: expect.stringContaining('错误'),
      });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('reads frozen native group image evidence through GET and readMistakes without writes', async () => {
    const db = testDb();
    try {
      const native = await nativeAppealFixture(db);
      const issued = await issueSoloFixture(db, native.questionId, true);
      const image = await handwritingFixture(db);
      const request = { ...issued.assessment('v=15 km/h'), group_evidence: [image] };
      const committed = await commitFormalAttempt(db, 'solo_submit', native.questionId, request);
      await db.insert(learning_record).values({
        id: 'lr_native_image',
        kind: 'mistake',
        content_md: '原件',
        source: 'manual',
        capture_mode: 'text',
        activity_kind: 'attempt',
        processing_status: 'raw',
        origin_event_id: committed.attempt_id,
        question_id: native.questionId,
        attempt_event_id: committed.attempt_id,
        created_at: new Date(),
        updated_at: new Date(),
      });
      await db
        .update(question)
        .set({ prompt_md: '现在已编辑', reference_md: '现在的私有答案' })
        .where(eq(question.id, native.questionId));
      const before = await db.select().from(event);
      const submissionsBefore = await db.select().from(assessment_submission);
      const evaluationsBefore = await db.select().from(evaluation);
      const calls = native.execute.mock.calls.length;
      const result = MistakeListResponseSchema.parse(await (await getMistakes()).json());
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        prompt_md: '顺流18 km/h、逆流12 km/h。列方程求静水船速，并解释相加消元。',
        reference_md: null,
        wrong_answer_image_refs: [image.evidence.asset.asset_id],
        wrong_answer_md: expect.stringContaining('v=15 km/h'),
      });
      expect((await readMistakes(db)).rows).toEqual(result.rows);
      expect(await db.select().from(event)).toEqual(before);
      expect(await db.select().from(assessment_submission)).toEqual(submissionsBefore);
      expect(await db.select().from(evaluation)).toEqual(evaluationsBefore);
      expect(native.execute).toHaveBeenCalledTimes(calls);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('returns failure attempts projected to legacy mistake-shape JSON', async () => {
    await seedQuestion('q1', 'P'.repeat(300), new Date(), 'R'.repeat(300));
    await seedAttempt({
      id: 'a1',
      question_id: 'q1',
      answer_md: 'W'.repeat(300),
      knowledge_ids: ['k1', 'k2'],
    });
    await seedJudge({ id: 'j1', attempt_event_id: 'a1' });

    const res = await getMistakes();
    expect(res.status).toBe(200);
    const body = MistakeListResponseSchema.parse(await res.json());
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(body.data).toEqual(body.rows);
    expect(body.page).toEqual({ limit: 50, next_cursor: null });
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].id).toBe('a1');
    expect(body.rows[0].record_id).toBe('lr_a1');
    expect(body.rows[0].question_id).toBe('q1');
    expect(body.rows[0].prompt_md).toHaveLength(200);
    expect(body.rows[0].reference_md).toBe('R'.repeat(200));
    expect(body.rows[0].wrong_answer_md).toHaveLength(200);
    expect(body.rows[0].knowledge_ids).toEqual(['k1', 'k2']);
    expect(body.rows[0].cause).toEqual({
      source: 'agent',
      primary_category: 'concept',
      primary_label: null,
      secondary_categories: [],
      secondary_labels: {},
      user_notes: null,
      confidence: 0.9,
    });
    expect(body.rows[0].correction_state.state).toBe('active');
    expect(body.rows[0].correction_state.terminal_state).toBe('active');
    expect(typeof body.rows[0].created_at).toBe('number');
  });

  it('filters failure attempts by the derived subject query', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values({
      id: 'k_math',
      name: '函数',
      ...KNOWLEDGE_BASE,
      domain: 'math',
      parent_id: null,
      archived_at: null,
      created_at: now,
      updated_at: now,
    });
    await seedQuestion('q_yuwen', '语文题');
    await seedQuestion('q_math', '数学题');
    await db
      .update(question)
      .set({ knowledge_ids: ['k_math'] })
      .where(eq(question.id, 'q_math'));
    await seedAttempt({ id: 'a_yuwen', question_id: 'q_yuwen', knowledge_ids: ['k1'] });
    await seedAttempt({ id: 'a_math', question_id: 'q_math', knowledge_ids: ['k_math'] });

    const res = await getMistakes('subject=math');
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    expect(body.rows.map((row) => row.id)).toEqual(['a_math']);
  });

  it('preserves a missing reference answer as null', async () => {
    await seedQuestion('q1', 'p1');
    await seedAttempt({ id: 'a1', question_id: 'q1' });

    const res = await getMistakes();
    const body = MistakeListResponseSchema.parse(await res.json());

    expect(body.rows[0].reference_md).toBeNull();
  });

  it('excludes attempts that have been retracted', async () => {
    await seedQuestion('q1', 'p1');
    await seedAttempt({ id: 'a1', question_id: 'q1' });
    await seedCorrection({
      id: 'correct_a1',
      target_event_id: 'a1',
      correction_kind: 'retract',
    });

    const res = await getMistakes();
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    expect(body.rows).toEqual([]);
  });

  it('follows superseded judge replacements when projecting cause', async () => {
    await seedQuestion('q1', 'p1');
    await seedAttempt({ id: 'a1', question_id: 'q1' });
    await seedJudge({
      id: 'j_old',
      attempt_event_id: 'a1',
      primary_category: 'concept',
      created_at: new Date('2026-05-20T00:00:00Z'),
    });
    await seedJudge({
      id: 'j_replacement',
      attempt_event_id: 'a1',
      primary_category: 'memory',
      caused_by_event_id: null,
      created_at: new Date('2026-05-19T00:00:00Z'),
    });
    await seedCorrection({
      id: 'correct_j_old',
      target_event_id: 'j_old',
      correction_kind: 'supersede',
      replacement_event_id: 'j_replacement',
      created_at: new Date('2026-05-21T00:00:00Z'),
    });

    const res = await getMistakes();
    const body = (await res.json()) as {
      rows: Array<{ cause: { primary_category: string } | null }>;
    };
    expect(body.rows[0].cause?.primary_category).toBe('memory');
  });

  it('surfaces agent judge secondary_categories + confidence on the wire', async () => {
    await seedQuestion('q1', 'p1');
    await seedAttempt({ id: 'a1', question_id: 'q1' });
    await seedJudge({
      id: 'j1',
      attempt_event_id: 'a1',
      primary_category: 'concept',
      secondary_categories: ['memory', 'careless_mistake'],
      confidence: 0.72,
    });

    const res = await getMistakes();
    const body = (await res.json()) as {
      rows: Array<{
        cause: {
          source: string;
          primary_category: string;
          secondary_categories: string[];
          confidence: number | null;
        };
      }>;
    };
    expect(body.rows[0].cause.secondary_categories).toEqual(['memory', 'careless_mistake']);
    expect(body.rows[0].cause.confidence).toBe(0.72);
  });

  it('user_cause overrides agent judge in the GET projection', async () => {
    await seedQuestion('q1', 'p1');
    await seedAttempt({ id: 'a1', question_id: 'q1' });
    await seedJudge({ id: 'j1', attempt_event_id: 'a1' });
    await seedUserCause({
      id: 'uc1',
      attempt_event_id: 'a1',
      primary_category: 'memory',
      user_notes: '记错了',
    });

    const res = await getMistakes();
    const body = (await res.json()) as {
      rows: Array<{
        cause: {
          source: string;
          primary_category: string;
          secondary_categories: string[];
          user_notes: string | null;
          confidence: number | null;
        } | null;
      }>;
    };
    expect(body.rows[0].cause).toEqual({
      source: 'user',
      primary_category: 'memory',
      primary_label: null,
      secondary_categories: [],
      secondary_labels: {},
      user_notes: '记错了',
      confidence: null,
    });
  });

  // YUK-1018 — misc_ primary id 的显示回填：active misconception title 进
  // primary_label，原始 id 保留在 primary_category。
  it('misc_ primary_category carries primary_label resolved from the misconception title', async () => {
    const now = new Date();
    await testDb()
      .insert(misconception)
      .values({
        id: 'misc_mistakes_01',
        title: '把「之」当普通助词',
        reasoning: null,
        weight: 1,
        status: 'active',
        source: 'soft',
        seen: 2,
        evidence: [],
        created_by: { by: 'system' },
        proposed_by_ai: true,
        created_at: now,
        updated_at: now,
        archived_at: null,
      });
    await seedQuestion('q1', 'p1');
    await seedAttempt({ id: 'a1', question_id: 'q1' });
    await seedJudge({
      id: 'j1',
      attempt_event_id: 'a1',
      primary_category: 'misc_mistakes_01',
    });

    const res = await getMistakes();
    const body = (await res.json()) as {
      rows: Array<{
        cause: { primary_category: string; primary_label: string | null } | null;
      }>;
    };
    expect(body.rows[0].cause?.primary_category).toBe('misc_mistakes_01');
    expect(body.rows[0].cause?.primary_label).toBe('把「之」当普通助词');
  });

  it('an unresolvable misc_ primary_category falls back to null primary_label', async () => {
    await seedQuestion('q1', 'p1');
    await seedAttempt({ id: 'a1', question_id: 'q1' });
    await seedJudge({
      id: 'j1',
      attempt_event_id: 'a1',
      primary_category: 'misc_no_such_node',
    });

    const res = await getMistakes();
    const body = (await res.json()) as {
      rows: Array<{
        cause: { primary_category: string; primary_label: string | null } | null;
      }>;
    };
    expect(body.rows[0].cause?.primary_category).toBe('misc_no_such_node');
    expect(body.rows[0].cause?.primary_label).toBeNull();
  });

  // YUK-1020 — secondary_categories 里 misc_ id 的显示回填：与 primary 同一批
  // 查询；secondary_categories 保留裸 id，secondary_labels 只含可解析的 misc id。
  it('misc_ secondary_categories carry secondary_labels resolved from misconception titles', async () => {
    const now = new Date();
    const misconceptionRow = {
      reasoning: null,
      weight: 1,
      source: 'soft',
      seen: 2,
      evidence: [],
      created_by: { by: 'system' as const },
      proposed_by_ai: true,
      created_at: now,
      updated_at: now,
    };
    await testDb()
      .insert(misconception)
      .values([
        {
          ...misconceptionRow,
          id: 'misc_sec_m01',
          title: '虚词误判',
          status: 'active',
          archived_at: null,
        },
        {
          ...misconceptionRow,
          id: 'misc_sec_m02',
          title: '已归档误区',
          status: 'active',
          archived_at: now,
        },
      ]);
    await seedQuestion('q1', 'p1');
    await seedAttempt({ id: 'a1', question_id: 'q1' });
    await seedJudge({
      id: 'j1',
      attempt_event_id: 'a1',
      primary_category: 'concept',
      secondary_categories: ['misc_sec_m01', 'grammar', 'misc_sec_m02', 'misc_gone_99'],
    });

    const res = await getMistakes();
    const body = (await res.json()) as {
      rows: Array<{
        cause: {
          secondary_categories: string[];
          secondary_labels: Record<string, string>;
        } | null;
      }>;
    };
    // 裸 id 顺序保留；vocab / archived / unknown 缺席 label map。
    expect(body.rows[0].cause?.secondary_categories).toEqual([
      'misc_sec_m01',
      'grammar',
      'misc_sec_m02',
      'misc_gone_99',
    ]);
    expect(body.rows[0].cause?.secondary_labels).toEqual({ misc_sec_m01: '虚词误判' });
  });

  it('filters by question_id', async () => {
    await seedQuestion('q1', 'p1');
    await seedQuestion('q2', 'p2');
    await seedAttempt({ id: 'a1', question_id: 'q1' });
    await seedAttempt({ id: 'a2', question_id: 'q2' });

    const res = await getMistakes('question_id=q1');
    const body = (await res.json()) as { rows: Array<{ question_id: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].question_id).toBe('q1');
  });

  it('filters by since', async () => {
    await seedQuestion('q_old', 'p_old');
    await seedQuestion('q_new', 'p_new');
    await seedAttempt({
      id: 'a_old',
      question_id: 'q_old',
      created_at: new Date('2026-05-09T00:00:00Z'),
    });
    await seedAttempt({
      id: 'a_new',
      question_id: 'q_new',
      created_at: new Date('2026-05-11T00:00:00Z'),
    });

    const res = await getMistakes('since=2026-05-10T00:00:00Z');
    const body = (await res.json()) as { rows: Array<{ question_id: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].question_id).toBe('q_new');
  });

  it('honours limit (default 50, max 200)', async () => {
    const t0 = new Date('2026-05-01T00:00:00Z');
    for (let i = 0; i < 5; i++) {
      await seedQuestion(`q${i}`, `p${i}`, new Date(t0.getTime() + i * 1000));
      await seedAttempt({
        id: `a${i}`,
        question_id: `q${i}`,
        created_at: new Date(t0.getTime() + i * 1000),
      });
    }
    const res = await getMistakes('limit=2');
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(2);
  });

  it('cursor pagination is stable for equal record timestamps', async () => {
    const createdAt = new Date('2026-05-01T00:00:00Z');
    for (const id of ['a', 'b', 'c']) {
      await seedQuestion(`q_${id}`, `p_${id}`, createdAt);
      await seedAttempt({ id, question_id: `q_${id}`, created_at: createdAt });
    }

    const first = (await (await getMistakes('limit=2')).json()) as {
      data: Array<{ id: string }>;
      page: { next_cursor: string | null };
    };
    expect(first.data.map((row) => row.id)).toEqual(['c', 'b']);

    const second = (await (
      await getMistakes(`limit=2&cursor=${encodeURIComponent(first.page.next_cursor ?? '')}`)
    ).json()) as typeof first;
    expect(second.data.map((row) => row.id)).toEqual(['a']);
    expect(second.page.next_cursor).toBeNull();
  });

  it('400s on an invalid cursor', async () => {
    expect((await getMistakes('cursor=not-a-cursor')).status).toBe(400);
  });

  it.each([
    ['0', 1],
    ['1', 1],
    ['200', 200],
    ['999999', 200],
    [undefined, 50],
  ])(
    'shares limit normalization for %s across HTTP and the public read operation',
    async (rawLimit, expectedLimit) => {
      const query = rawLimit === undefined ? {} : { limit: rawLimit };
      const domain = await readMistakes(testDb(), query);
      const http = MistakeListResponseSchema.parse(
        await (await getMistakes(rawLimit === undefined ? '' : `limit=${rawLimit}`)).json(),
      );
      expect(domain).toEqual(http);
      expect(domain.page.limit).toBe(expectedLimit);
    },
  );

  it('keeps old same-question records visible beyond the failure reader recency window', async () => {
    const createdAt = new Date('2026-05-01T00:00:00Z');
    await seedQuestion('q1', '历史题面', createdAt, '历史答案');
    for (let index = 0; index < 101; index++) {
      await seedAttempt({
        id: `a_${String(index).padStart(3, '0')}`,
        question_id: 'q1',
        created_at: createdAt,
      });
    }
    const cursor = Buffer.from(
      JSON.stringify({ created_at: createdAt.toISOString(), id: 'lr_a_001' }),
    ).toString('base64url');
    const page = MistakeListResponseSchema.parse(
      await (await getMistakes(`limit=1&cursor=${cursor}`)).json(),
    );
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      id: 'a_000',
      prompt_md: '历史题面',
      reference_md: '历史答案',
    });
    expect(page.next_cursor).toBeNull();
  });

  it('does not use identity supplementation to bypass the attempt since filter', async () => {
    const older = new Date('2026-05-01T00:00:00Z');
    const newer = new Date('2026-05-03T00:00:00Z');
    await seedQuestion('q1', '历史题面', older);
    await seedAttempt({ id: 'old', question_id: 'q1', created_at: older });
    await testDb()
      .update(learning_record)
      .set({ created_at: newer })
      .where(eq(learning_record.id, 'lr_old'));
    const page = await readMistakes(testDb(), { since: '2026-05-02T00:00:00Z' });
    expect(page.rows).toEqual([]);
  });

  it('does not add review failures through identity supplementation', async () => {
    await seedQuestion('q1', '历史题面');
    await seedAttempt({ id: 'review_only', question_id: 'q1' });
    await testDb().update(event).set({ action: 'review' }).where(eq(event.id, 'review_only'));
    expect((await readMistakes(testDb())).rows).toEqual([]);
  });

  it('400s on invalid since', async () => {
    const res = await getMistakes('since=not-a-date');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('400s on non-numeric limit', async () => {
    const res = await getMistakes('limit=banana');
    expect(res.status).toBe(400);
  });

  it('returns empty rows when no failures match', async () => {
    const res = await getMistakes();
    const body = (await res.json()) as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });

  it('excludes non-failure attempts', async () => {
    await seedQuestion('q1', 'p1');
    await seedQuestion('q2', 'p2');
    await seedAttempt({ id: 'a1', question_id: 'q1', outcome: 'failure' });
    await seedAttempt({ id: 'a2', question_id: 'q2', outcome: 'success' });

    const res = await getMistakes();
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    expect(body.rows.map((r) => r.id)).toEqual(['a1']);
  });

  // Codex P1-B test retired in Step 9 — the legacy `mistake` table was DROPped,
  // so user-supplied causes are no longer recoverable via the GET projection.
  // Phase 1c.2 will introduce an `experimental:user_cause` event path; the
  // round-trip test moves there at that point.
});
