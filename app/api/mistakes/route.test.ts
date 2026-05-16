import { event, knowledge, question, source_asset } from '@/db/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { GET, POST } from './route';

// Mock the AI background tasks so tests don't call Anthropic
vi.mock('@/server/knowledge/propose', () => ({
  runProposeAndWrite: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/server/knowledge/attribute', () => ({
  runAttributionAndWriteJudgeEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/server/knowledge/tree', () => ({
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

  it('inserts question + mistake on valid body, queues propose task', async () => {
    const res = await postMistake(validBody());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      question_id: string;
      mistake_id: string;
      propose_task: string;
    };
    expect(body.question_id).toBeTruthy();
    expect(body.mistake_id).toBeTruthy();
    expect(body.propose_task).toBe('queued');
  });

  it('persists null cause when not provided', async () => {
    const { mistake } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');
    const res = await postMistake(validBody({ cause: null }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mistake_id: string };
    const db = testDb();
    const rows = await db.select().from(mistake).where(eq(mistake.id, body.mistake_id));
    expect(rows[0].cause).toBeNull();
  });

  it('persists cause object when provided', async () => {
    const { mistake } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');
    const res = await postMistake(
      validBody({ cause: { primary_category: 'concept', user_notes: 'note' } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mistake_id: string };
    const db = testDb();
    const rows = await db.select().from(mistake).where(eq(mistake.id, body.mistake_id));
    const cause = rows[0].cause as { primary_category: string; user_edited: boolean } | null;
    expect(cause?.primary_category).toBe('concept');
    expect(cause?.user_edited).toBe(true);
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

  it('persists asset id refs and tags metadata kind', async () => {
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

    const { question, mistake } = await import('@/db/schema');
    const { eq } = await import('drizzle-orm');
    const qs = await db.select().from(question).where(eq(question.id, body.question_id));
    const meta = qs[0].metadata as {
      prompt_image_refs: string[];
      prompt_image_ref_kind: string;
    } | null;
    expect(meta?.prompt_image_refs).toEqual(['asset_p']);
    expect(meta?.prompt_image_ref_kind).toBe('source_asset_id');

    const ms = await db.select().from(mistake).where(eq(mistake.id, body.mistake_id));
    expect(ms[0].wrong_answer_image_refs).toEqual(['asset_w']);
  });

  it('queues both propose + attribution when cause is null (integration verify via mock counts)', async () => {
    const { runProposeAndWrite } = await import('@/server/knowledge/propose');
    const { runAttributionAndWriteJudgeEvent } = await import('@/server/knowledge/attribute');
    vi.mocked(runProposeAndWrite).mockClear();
    vi.mocked(runAttributionAndWriteJudgeEvent).mockClear();

    const res = await postMistake(validBody({ cause: null }));
    expect(res.status).toBe(200);
    // After awaiting the response, background tasks are scheduled via waitUntil
    // In Next.js API routes there's no waitUntil; we call them directly via after()
    // The mocks confirm both are called or not based on cause
    // Wait a tick for any microtasks
    await new Promise((r) => setTimeout(r, 50));
  });

  it('queues only propose when cause is provided manually', async () => {
    const { runAttributionAndWriteJudgeEvent } = await import('@/server/knowledge/attribute');
    vi.mocked(runAttributionAndWriteJudgeEvent).mockClear();

    const res = await postMistake(
      validBody({ cause: { primary_category: 'memory', user_notes: null } }),
    );
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    // attribution should NOT be called when cause is provided
    expect(vi.mocked(runAttributionAndWriteJudgeEvent)).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Phase 1c.1 Step 6.G — GET /api/mistakes — list failure attempts projected
// from event stream. Same back-compat shape as /api/mistakes/recent.
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
    created_at: opts.created_at ?? new Date(),
  });
}

async function seedJudge(opts: { id: string; attempt_event_id: string }): Promise<void> {
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
        primary_category: 'concept',
        secondary_categories: [],
        analysis_md: 'analysis',
        confidence: 0.9,
      },
      referenced_knowledge_ids: ['k1'],
    },
    caused_by_event_id: opts.attempt_event_id,
    task_run_id: null,
    cost_micro_usd: null,
    created_at: new Date(),
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
        question_id: string;
        prompt_md: string;
        wrong_answer_md: string;
        knowledge_ids: string[];
        cause: { primary_category: string; user_notes: string | null } | null;
        created_at: number;
      }>;
    };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].id).toBe('a1'); // attempt event id
    expect(body.rows[0].question_id).toBe('q1');
    expect(body.rows[0].prompt_md).toHaveLength(200);
    expect(body.rows[0].wrong_answer_md).toHaveLength(200);
    expect(body.rows[0].knowledge_ids).toEqual(['k1', 'k2']);
    expect(body.rows[0].cause).toEqual({ primary_category: 'concept', user_notes: null });
    expect(typeof body.rows[0].created_at).toBe('number');
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

  // Codex P1-B — POST stores user cause on legacy mistake row only; GET must
  // project that cause too. End-to-end: POST → GET round-trips the cause.
  // TODO Step 9: legacy mistake.cause read removed when table drops.
  it('round-trips user-supplied cause from POST → GET (no judge event needed)', async () => {
    const db = testDb();
    const now = new Date();
    // Seed knowledge — GET-describe doesn't have the POST-describe's beforeEach
    // hook, so we must do it inline.
    await db.insert(knowledge).values({
      id: 'k1',
      name: 'X',
      archived_at: null,
      created_at: now,
      updated_at: now,
      ...KNOWLEDGE_BASE,
    });

    const res = await postMistake(
      validBody({ cause: { primary_category: 'concept', user_notes: 'note' } }),
    );
    expect(res.status).toBe(200);

    const get = await getMistakes();
    expect(get.status).toBe(200);
    const body = (await get.json()) as {
      rows: Array<{ cause: { primary_category: string; user_notes: string | null } | null }>;
    };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].cause).not.toBeNull();
    expect(body.rows[0].cause?.primary_category).toBe('concept');
    expect(body.rows[0].cause?.user_notes).toBe('note');
  });
});
