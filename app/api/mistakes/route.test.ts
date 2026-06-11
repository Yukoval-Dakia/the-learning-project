// POST /api/mistakes writes question + attempt event + learning_record(kind='mistake').

import { event, knowledge, learning_record, question, source_asset } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { GET, POST } from './route';

// Mock the AI background tasks so tests don't call Anthropic
vi.mock('@/capabilities/knowledge/server/propose', () => ({
  runProposeAndWrite: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/capabilities/knowledge/server/attribute', () => ({
  runAttributionAndWriteJudgeEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/capabilities/knowledge/server/tree', () => ({
  loadTreeSnapshot: vi.fn().mockResolvedValue([
    {
      id: 'k1',
      name: 'X',
      domain: 'wenyan',
      parent_id: null,
      effective_domain: 'wenyan',
      archived_at: null,
    },
  ]),
}));

// Mock next/server `after` to run synchronously in tests
const afterCallbacks: Array<() => Promise<void>> = [];
vi.mock('next/server', () => ({
  after: vi.fn((cb: () => Promise<void>) => {
    afterCallbacks.push(cb);
  }),
}));

const KNOWLEDGE_BASE = {
  domain: 'wenyan',
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

async function runAfterCallbacks() {
  const callbacks = afterCallbacks.splice(0);
  await Promise.all(callbacks.map((cb) => cb()));
}

describe('POST /api/mistakes', () => {
  beforeEach(async () => {
    afterCallbacks.length = 0;
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

  it('rejects empty knowledge_ids array', async () => {
    const res = await postMistake(validBody({ knowledge_ids: [] }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
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

  it('inserts question + attempt event on valid body, queues propose task', async () => {
    const res = await postMistake(validBody());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      question_id: string;
      mistake_id: string;
      record_id: string;
      propose_task: string;
    };
    expect(body.question_id).toBeTruthy();
    expect(body.mistake_id).toBeTruthy();
    expect(body.record_id).toBeTruthy();
    // mistake_id == attempt event id post-Step-9 (opaque to clients)
    expect(body.mistake_id).toBe(body.mistake_id);
    expect(body.propose_task).toBe('queued');

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
  });

  it('does not write any mistake row (legacy table dropped)', async () => {
    // schema.ts no longer exports `mistake` — the assertion lives implicit in
    // typecheck. Just verify the event was written without error.
    const res = await postMistake(validBody({ cause: null }));
    expect(res.status).toBe(200);
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
    expect(res.status).toBe(200);
    const body = (await res.json()) as { question_id: string; mistake_id: string };

    const { eq } = await import('drizzle-orm');
    const qs = await db.select().from(question).where(eq(question.id, body.question_id));
    const meta = qs[0].metadata as {
      prompt_image_refs: string[];
      prompt_image_ref_kind: string;
    } | null;
    expect(meta?.prompt_image_refs).toEqual(['asset_p']);
    expect(meta?.prompt_image_ref_kind).toBe('source_asset_id');

    const events = await db.select().from(event).where(eq(event.id, body.mistake_id));
    expect((events[0].payload as Record<string, unknown>).answer_image_refs).toEqual(['asset_w']);
  });

  it('queues both propose + attribution when cause is null', async () => {
    const { runProposeAndWrite } = await import('@/capabilities/knowledge/server/propose');
    const { runAttributionAndWriteJudgeEvent } = await import(
      '@/capabilities/knowledge/server/attribute'
    );
    vi.mocked(runProposeAndWrite).mockClear();
    vi.mocked(runAttributionAndWriteJudgeEvent).mockClear();

    const res = await postMistake(validBody({ cause: null }));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
  });

  it('passes the selected knowledge subject profile to KnowledgeProposeTask', async () => {
    const { runProposeAndWrite } = await import('@/capabilities/knowledge/server/propose');
    vi.mocked(runProposeAndWrite).mockClear();
    const db = testDb();
    const { eq } = await import('drizzle-orm');
    await db.update(knowledge).set({ domain: 'math' }).where(eq(knowledge.id, 'k1'));

    const res = await postMistake(validBody({ cause: null }));
    expect(res.status).toBe(200);
    await runAfterCallbacks();

    const params = vi.mocked(runProposeAndWrite).mock.calls[0]?.[0] as
      | { subjectProfile?: { id: string } }
      | undefined;
    expect(params?.subjectProfile?.id).toBe('math');
  });

  it('queues only propose when cause is provided manually', async () => {
    const { runAttributionAndWriteJudgeEvent } = await import(
      '@/capabilities/knowledge/server/attribute'
    );
    vi.mocked(runAttributionAndWriteJudgeEvent).mockClear();

    const res = await postMistake(
      validBody({ cause: { primary_category: 'memory', user_notes: null } }),
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(vi.mocked(runAttributionAndWriteJudgeEvent)).not.toHaveBeenCalled();
  });

  it('writes an experimental:user_cause event when body.cause !== null', async () => {
    const db = testDb();
    const { eq, and } = await import('drizzle-orm');
    const res = await postMistake(
      validBody({
        cause: { primary_category: 'carelessness', user_notes: '看错题号了' },
      }),
    );
    expect(res.status).toBe(200);
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
    expect(res.status).toBe(200);
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
    expect(res.status).toBe(200);
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

async function seedQuestion(id: string, prompt_md: string, created_at = new Date()): Promise<void> {
  const db = testDb();
  await db.insert(question).values({
    id,
    prompt_md,
    created_at,
    updated_at: created_at,
    ...QUESTION_BASE,
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

  it('returns failure attempts projected to legacy mistake-shape JSON', async () => {
    await seedQuestion('q1', 'P'.repeat(300));
    await seedAttempt({
      id: 'a1',
      question_id: 'q1',
      answer_md: 'W'.repeat(300),
      knowledge_ids: ['k1', 'k2'],
    });
    await seedJudge({ id: 'j1', attempt_event_id: 'a1' });

    const res = await getMistakes();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{
        id: string;
        record_id: string;
        question_id: string;
        prompt_md: string;
        wrong_answer_md: string;
        knowledge_ids: string[];
        cause: { primary_category: string; user_notes: string | null } | null;
        correction_state: { state: string; terminal_state: string };
        created_at: number;
      }>;
    };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].id).toBe('a1');
    expect(body.rows[0].record_id).toBe('lr_a1');
    expect(body.rows[0].question_id).toBe('q1');
    expect(body.rows[0].prompt_md).toHaveLength(200);
    expect(body.rows[0].wrong_answer_md).toHaveLength(200);
    expect(body.rows[0].knowledge_ids).toEqual(['k1', 'k2']);
    expect(body.rows[0].cause).toEqual({
      source: 'agent',
      primary_category: 'concept',
      secondary_categories: [],
      user_notes: null,
      confidence: 0.9,
    });
    expect(body.rows[0].correction_state.state).toBe('active');
    expect(body.rows[0].correction_state.terminal_state).toBe('active');
    expect(typeof body.rows[0].created_at).toBe('number');
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
      secondary_categories: [],
      user_notes: '记错了',
      confidence: null,
    });
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
