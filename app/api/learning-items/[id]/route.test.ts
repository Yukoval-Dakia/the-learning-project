import {
  artifact,
  completion_evidence,
  event,
  knowledge,
  learning_item,
  question,
} from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { DELETE, GET, PATCH } from './route';

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

function baseItem(id: string, over: Partial<typeof learning_item.$inferInsert> = {}) {
  const now = new Date();
  return {
    id,
    source: 'manual' as const,
    title: 'Test item',
    content: '',
    knowledge_ids: [] as string[],
    status: 'pending',
    created_at: now,
    updated_at: now,
    version: 0,
    ...over,
  };
}

function patchReq(id: string, body: unknown) {
  return new Request(`http://localhost/api/learning-items/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getReq(id: string) {
  return new Request(`http://localhost/api/learning-items/${id}`, { method: 'GET' });
}

function deleteReq(id: string, version?: number) {
  const url =
    version !== undefined
      ? `http://localhost/api/learning-items/${id}?version=${version}`
      : `http://localhost/api/learning-items/${id}`;
  return new Request(url, { method: 'DELETE' });
}

describe('PATCH /api/learning-items/[id]', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('updates content — version increments, no completion_evidence created', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1'));

    const res = await PATCH(patchReq('li1', { version: 0, content: 'updated' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; version: number };
    expect(body.content).toBe('updated');
    expect(body.version).toBe(1);

    const evidenceRows = await db
      .select()
      .from(completion_evidence)
      .where(eq(completion_evidence.learning_item_id, 'li1'));
    expect(evidenceRows).toHaveLength(0);
  });

  it('updates title', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1'));

    const res = await PATCH(patchReq('li1', { version: 0, title: 'New title' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { title: string };
    expect(body.title).toBe('New title');
  });

  it('transition pending → in_progress — completed_at remains null, no evidence', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1', { status: 'pending' }));

    const res = await PATCH(patchReq('li1', { version: 0, status: 'in_progress' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; completed_at: unknown };
    expect(body.status).toBe('in_progress');
    expect(body.completed_at).toBeNull();

    const evidenceRows = await db
      .select()
      .from(completion_evidence)
      .where(eq(completion_evidence.learning_item_id, 'li1'));
    expect(evidenceRows).toHaveLength(0);
  });

  it('transition in_progress → pending — no evidence, completed_at null', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1', { status: 'in_progress', version: 1 }));

    const res = await PATCH(patchReq('li1', { version: 1, status: 'pending' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; completed_at: unknown };
    expect(body.status).toBe('pending');
    expect(body.completed_at).toBeNull();
  });

  it('transition pending → done: sets completed_at, creates completion_evidence with path=self_declare', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1', { status: 'pending' }));

    const res = await PATCH(patchReq('li1', { version: 0, status: 'done' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; completed_at: unknown };
    expect(body.status).toBe('done');
    expect(body.completed_at).not.toBeNull();

    const evidenceRows = await db
      .select()
      .from(completion_evidence)
      .where(eq(completion_evidence.learning_item_id, 'li1'));
    expect(evidenceRows).toHaveLength(1);
    expect(evidenceRows[0].path).toBe('self_declare');
    const evidenceJson = evidenceRows[0].evidence_json as Record<string, unknown>;
    expect(typeof evidenceJson.declared_at).toBe('number');
  });

  it('transition pending → done with user_notes — evidence_json contains user_notes', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1', { status: 'pending' }));

    const res = await PATCH(patchReq('li1', { version: 0, status: 'done', user_notes: '学完了' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(200);

    const evidenceRows = await db
      .select()
      .from(completion_evidence)
      .where(eq(completion_evidence.learning_item_id, 'li1'));
    expect(evidenceRows).toHaveLength(1);
    const evidenceJson = evidenceRows[0].evidence_json as Record<string, unknown>;
    expect(evidenceJson.user_notes).toBe('学完了');
  });

  it('transition done → in_progress: clears completed_at, no new evidence', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(learning_item).values(baseItem('li1', { status: 'done', completed_at: now }));

    const res = await PATCH(patchReq('li1', { version: 0, status: 'in_progress' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; completed_at: unknown };
    expect(body.status).toBe('in_progress');
    expect(body.completed_at).toBeNull();

    const evidenceRows = await db
      .select()
      .from(completion_evidence)
      .where(eq(completion_evidence.learning_item_id, 'li1'));
    expect(evidenceRows).toHaveLength(0);
  });

  it('400 on invalid_transition done → pending', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1', { status: 'done' }));

    const res = await PATCH(patchReq('li1', { version: 0, status: 'pending' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_transition');
  });

  it('200 when status="archived" — sets archived_at and persists the status', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1', { status: 'pending' }));

    const res = await PATCH(patchReq('li1', { version: 0, status: 'archived' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(learning_item).where(eq(learning_item.id, 'li1'));
    expect(row.status).toBe('archived');
    expect(row.archived_at).not.toBeNull();
  });

  it('200 when archived → pending — clears archived_at (revive flow)', async () => {
    const db = testDb();
    const now = new Date();
    await db
      .insert(learning_item)
      .values(baseItem('li1', { status: 'archived', archived_at: now }));

    const res = await PATCH(patchReq('li1', { version: 0, status: 'pending' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(learning_item).where(eq(learning_item.id, 'li1'));
    expect(row.status).toBe('pending');
    expect(row.archived_at).toBeNull();
  });

  it('200 when done → resting — schema-supported transition', async () => {
    const db = testDb();
    await db
      .insert(learning_item)
      .values(baseItem('li1', { status: 'done', completed_at: new Date() }));

    const res = await PATCH(patchReq('li1', { version: 0, status: 'resting' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(learning_item).where(eq(learning_item.id, 'li1'));
    expect(row.status).toBe('resting');
  });

  it('400 on user_notes without transitioning to done', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1', { status: 'pending' }));

    const res = await PATCH(
      patchReq('li1', { version: 0, status: 'in_progress', user_notes: 'some note' }),
      { params: Promise.resolve({ id: 'li1' }) },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('validation_error');
    expect(body.message).toMatch(/user_notes/);
  });

  it('400 on unknown knowledge_ids', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1'));

    const res = await PATCH(patchReq('li1', { version: 0, knowledge_ids: ['k_missing'] }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/k_missing/);
  });

  it('400 on missing version field', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1'));

    const res = await PATCH(patchReq('li1', { content: 'x' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(400);
  });

  it('404 when item not found', async () => {
    const res = await PATCH(patchReq('li_missing', { version: 0, content: 'x' }), {
      params: Promise.resolve({ id: 'li_missing' }),
    });
    expect(res.status).toBe(404);
  });

  it('archived items are still PATCHable — required for the revive flow', async () => {
    const db = testDb();
    const now = new Date();
    await db
      .insert(learning_item)
      .values(baseItem('li1', { status: 'archived', archived_at: now }));

    const res = await PATCH(patchReq('li1', { version: 0, content: 'x' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(200);
  });

  it('409 on version mismatch — no completion_evidence created', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1', { version: 5 }));

    const res = await PATCH(patchReq('li1', { version: 2, content: 'x' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('conflict');

    const evidenceRows = await db
      .select()
      .from(completion_evidence)
      .where(eq(completion_evidence.learning_item_id, 'li1'));
    expect(evidenceRows).toHaveLength(0);
  });

  it('409 on done transition version mismatch — no evidence created', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1', { status: 'pending', version: 5 }));

    const res = await PATCH(patchReq('li1', { version: 2, status: 'done' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(409);

    const evidenceRows = await db
      .select()
      .from(completion_evidence)
      .where(eq(completion_evidence.learning_item_id, 'li1'));
    expect(evidenceRows).toHaveLength(0);
  });
});

describe('DELETE /api/learning-items/[id]', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('soft-archives item — sets archived_at, returns ok:true', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1'));

    const res = await DELETE(deleteReq('li1', 0), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const rows = await db.select().from(learning_item).where(eq(learning_item.id, 'li1'));
    expect(rows[0].archived_at).not.toBeNull();
    expect(rows[0].archived_reason).toBe('user');
    // status NOT touched
    expect(rows[0].status).toBe('pending');
  });

  it('404 when item not found', async () => {
    const res = await DELETE(deleteReq('li_missing', 0), {
      params: Promise.resolve({ id: 'li_missing' }),
    });
    expect(res.status).toBe(404);
  });

  it('404 when item already archived', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(learning_item).values(baseItem('li1', { archived_at: now }));

    const res = await DELETE(deleteReq('li1', 0), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(404);
  });

  it('409 on version mismatch', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1', { version: 5 }));

    const res = await DELETE(deleteReq('li1', 2), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('conflict');
  });

  it('400 when ?version is missing', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1'));

    const res = await DELETE(deleteReq('li1'), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('400 when ?version is non-numeric', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1'));

    const res = await DELETE(
      new Request('http://localhost/api/learning-items/li1?version=abc', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'li1' }) },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });
});

describe('GET /api/learning-items/[id]', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns 404 for unknown id', async () => {
    const res = await GET(getReq('does_not_exist'), {
      params: Promise.resolve({ id: 'does_not_exist' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns item with parent=null and children=[] when standalone', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1'));

    const res = await GET(getReq('li1'), { params: Promise.resolve({ id: 'li1' }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      parent: unknown;
      children: unknown[];
      parent_learning_item_id: string | null;
      subject_profile: { id: string; displayName: string };
    };
    expect(body.id).toBe('li1');
    expect(body.parent).toBeNull();
    expect(body.children).toEqual([]);
    expect(body.parent_learning_item_id).toBeNull();
    expect(body.subject_profile.id).toBe('wenyan');
    expect(body.subject_profile.displayName).toBe('文言文');
  });

  it('returns a slim subject profile resolved from the first knowledge id', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(knowledge).values({
      id: 'k_math',
      ...BASE_KNOWLEDGE,
      domain: 'math',
      created_at: now,
      updated_at: now,
    });
    await db.insert(learning_item).values(baseItem('li1', { knowledge_ids: ['k_math'] }));

    const res = await GET(getReq('li1'), { params: Promise.resolve({ id: 'li1' }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subject_profile: {
        id: string;
        displayName: string;
        renderConfig: {
          font_family: string;
          notation: string | null;
          code_highlight: string | null;
        };
      };
    };
    expect(body.subject_profile).toEqual({
      id: 'math',
      displayName: '数学',
      renderConfig: {
        font_family: 'system',
        notation: 'katex',
        code_highlight: null,
      },
    });
  });

  it('returns parent breadcrumb when item has a parent', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('hub', { title: 'The Hub' }));
    await db.insert(learning_item).values(
      baseItem('child', {
        title: 'Atomic',
        parent_learning_item_id: 'hub',
      }),
    );

    const res = await GET(getReq('child'), { params: Promise.resolve({ id: 'child' }) });
    const body = (await res.json()) as {
      parent: { id: string; title: string; status: string } | null;
    };
    expect(body.parent?.id).toBe('hub');
    expect(body.parent?.title).toBe('The Hub');
  });

  it('returns children list when item is a hub', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('hub'));
    await db
      .insert(learning_item)
      .values(baseItem('c1', { title: 'A', parent_learning_item_id: 'hub' }));
    await db
      .insert(learning_item)
      .values(baseItem('c2', { title: 'B', parent_learning_item_id: 'hub' }));

    const res = await GET(getReq('hub'), { params: Promise.resolve({ id: 'hub' }) });
    const body = (await res.json()) as {
      children: Array<{ id: string; subject_profile?: unknown }>;
    };
    expect(body.children.map((c) => c.id).sort()).toEqual(['c1', 'c2']);
    expect(body.children.some((c) => 'subject_profile' in c)).toBe(false);
  });

  it('returns primary artifact verification fields', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(artifact).values({
      id: 'a1',
      type: 'note_atomic',
      title: '之的用法',
      knowledge_id: null,
      parent_artifact_id: null,
      child_artifact_ids: [],
      intent_source: 'learning_intent',
      source: 'ai_generated',
      source_ref: null,
      outline_json: null,
      sections: null,
      tool_kind: null,
      tool_state: null,
      generation_status: 'ready',
      verification_status: 'needs_review',
      verification_summary: {
        verdict: 'needs_review',
        summary_md: '例子部分需要人工复核。',
        issues: [
          {
            section_id: null,
            severity: 'warn',
            category: 'factuality',
            message: '缺少文本证据。',
          },
        ],
        confidence: 0.58,
      } as never,
      generated_by: { by: 'ai', task_kind: 'NoteGenerateTask' } as never,
      verified_by: { by: 'ai', task_kind: 'NoteVerifyTask' } as never,
      history: [],
      archived_at: null,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await db
      .insert(learning_item)
      .values(baseItem('li1', { primary_artifact_id: 'a1', status: 'in_progress' }));

    const res = await GET(getReq('li1'), { params: Promise.resolve({ id: 'li1' }) });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      primary_artifact: {
        verification_status: string;
        verification_summary: {
          verdict: string;
          issues: Array<{ category: string; message: string }>;
        };
        verified_by: { task_kind: string };
      } | null;
    };
    expect(body.primary_artifact?.verification_status).toBe('needs_review');
    expect(body.primary_artifact?.verification_summary).toMatchObject({
      verdict: 'needs_review',
      issues: [{ category: 'factuality', message: '缺少文本证据。' }],
    });
    expect(body.primary_artifact?.verified_by).toMatchObject({ task_kind: 'NoteVerifyTask' });
  });

  it('returns embedded check questions when status is ready', async () => {
    const db = testDb();
    const now = new Date();
    // Insert two question rows with source='embedded'
    await db.insert(question).values({
      id: 'q1',
      kind: 'mcq',
      prompt_md: 'What does 之 mean?',
      reference_md: 'SECRET ANSWER — must not appear in response',
      choices_md: ['A', 'B', 'C', 'D'],
      knowledge_ids: [],
      source: 'embedded',
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await db.insert(question).values({
      id: 'q2',
      kind: 'short_answer',
      prompt_md: 'Translate: 学而时习之',
      reference_md: 'ANOTHER SECRET',
      choices_md: null,
      knowledge_ids: [],
      source: 'embedded',
      created_at: now,
      updated_at: now,
      version: 0,
    });
    // Insert artifact with embedded_check_status='ready' and a check section
    await db.insert(artifact).values({
      id: 'a_ec',
      type: 'note_atomic',
      title: '之的用法',
      knowledge_id: null,
      parent_artifact_id: null,
      child_artifact_ids: [],
      intent_source: 'learning_intent',
      source: 'ai_generated',
      source_ref: null,
      outline_json: null,
      sections: [
        {
          id: 's1',
          kind: 'check',
          body_md: '',
          source_tier: 'llm_only',
          user_verified: false,
          embedded_check: { question_ids: ['q1', 'q2'] },
          version: 0,
        },
      ] as never,
      tool_kind: null,
      tool_state: null,
      generation_status: 'ready',
      verification_status: 'not_required',
      verification_summary: null,
      generated_by: null,
      verified_by: null,
      embedded_check_status: 'ready',
      history: [],
      archived_at: null,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await db
      .insert(learning_item)
      .values(baseItem('li_ec', { primary_artifact_id: 'a_ec', status: 'in_progress' }));

    const res = await GET(getReq('li_ec'), { params: Promise.resolve({ id: 'li_ec' }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      primary_artifact: {
        embedded_check_status: string;
        embedded_questions: Array<{
          id: string;
          kind: string;
          prompt_md: string;
          choices_md: string[] | null;
          reference_md?: string;
        }>;
      } | null;
    };
    expect(body.primary_artifact?.embedded_check_status).toBe('ready');
    expect(body.primary_artifact?.embedded_questions).toHaveLength(2);
    // Order must match question_ids declared in the check section (['q1', 'q2']).
    expect(body.primary_artifact?.embedded_questions[0].id).toBe('q1');
    expect(body.primary_artifact?.embedded_questions[1].id).toBe('q2');
    expect(body.primary_artifact?.embedded_questions[0]).toMatchObject({
      id: 'q1',
      kind: 'mcq',
      prompt_md: 'What does 之 mean?',
      choices_md: ['A', 'B', 'C', 'D'],
    });
    // SECURITY: reference_md must not be exposed
    for (const q of body.primary_artifact?.embedded_questions ?? []) {
      expect(q.reference_md).toBeUndefined();
    }
  });

  it('omits embedded questions when status is pending', async () => {
    const db = testDb();
    const now = new Date();
    await db.insert(artifact).values({
      id: 'a_pending',
      type: 'note_atomic',
      title: '之的用法 pending',
      knowledge_id: null,
      parent_artifact_id: null,
      child_artifact_ids: [],
      intent_source: 'learning_intent',
      source: 'ai_generated',
      source_ref: null,
      outline_json: null,
      sections: null,
      tool_kind: null,
      tool_state: null,
      generation_status: 'ready',
      verification_status: 'not_required',
      verification_summary: null,
      generated_by: null,
      verified_by: null,
      embedded_check_status: 'pending',
      history: [],
      archived_at: null,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await db
      .insert(learning_item)
      .values(
        baseItem('li_pending_ec', { primary_artifact_id: 'a_pending', status: 'in_progress' }),
      );

    const res = await GET(getReq('li_pending_ec'), {
      params: Promise.resolve({ id: 'li_pending_ec' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      primary_artifact: {
        embedded_check_status: string;
        embedded_questions?: unknown[];
      } | null;
    };
    expect(body.primary_artifact?.embedded_check_status).toBe('pending');
    expect(body.primary_artifact?.embedded_questions).toEqual([]);
  });

  // YUK-19 — the detail page reuses CorrectionStateRenderer to show retract
  // state for proposals that materialized this learning_item. The GET response
  // surfaces source / source_ref / source_event (with correction_state from
  // effective-truth), mirroring the list response shape.
  it('returns source, source_ref, and source_event with correction_state for learning_intent items', async () => {
    const db = testDb();
    const now = new Date();
    const proposalId = 'prop_intent_1';
    await db.insert(event).values({
      id: proposalId,
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'learning_intent',
      action: 'experimental:propose_learning_intent',
      subject_kind: 'artifact',
      subject_id: 'art_synth',
      outcome: 'partial',
      payload: { topic: '虚词' },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: now,
    });
    await db.insert(learning_item).values(
      baseItem('li_intent', {
        source: 'learning_intent',
        source_ref: proposalId,
      }),
    );

    const res = await GET(getReq('li_intent'), { params: Promise.resolve({ id: 'li_intent' }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      source: string;
      source_ref: string | null;
      source_event: { id: string; correction_state: { state: string } | null } | null;
    };
    expect(body.source).toBe('learning_intent');
    expect(body.source_ref).toBe(proposalId);
    expect(body.source_event?.id).toBe(proposalId);
    expect(body.source_event?.correction_state?.state).toBe('active');
  });

  it('returns source_event with retracted correction_state after the proposal is retracted', async () => {
    const db = testDb();
    const now = new Date();
    const proposalId = 'prop_intent_2';
    await db.insert(event).values({
      id: proposalId,
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'learning_intent',
      action: 'experimental:propose_learning_intent',
      subject_kind: 'artifact',
      subject_id: 'art_synth_2',
      outcome: 'partial',
      payload: { topic: '虚词' },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: now,
    });
    await db.insert(event).values({
      id: 'correct_evt_1',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: proposalId,
      outcome: 'success',
      payload: {
        correction_kind: 'retract',
        reason_md: 'wrong path',
        affected_refs: [{ kind: 'open_inquiry', id: proposalId }],
      },
      caused_by_event_id: proposalId,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: new Date(now.getTime() + 1000),
    });
    await db.insert(learning_item).values(
      baseItem('li_intent_r', {
        source: 'learning_intent',
        source_ref: proposalId,
      }),
    );

    const res = await GET(getReq('li_intent_r'), {
      params: Promise.resolve({ id: 'li_intent_r' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      source_event: { id: string; correction_state: { state: string } | null } | null;
    };
    expect(body.source_event?.correction_state?.state).toBe('retracted');
  });

  it('returns source_event null for source=manual items', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li_manual'));

    const res = await GET(getReq('li_manual'), { params: Promise.resolve({ id: 'li_manual' }) });
    const body = (await res.json()) as {
      source: string;
      source_event: { id: string } | null;
    };
    expect(body.source).toBe('manual');
    expect(body.source_event).toBeNull();
  });
});

describe('PATCH /api/learning-items/[id] — parent_learning_item_id', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('sets parent_learning_item_id when target exists', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('hub'));
    await db.insert(learning_item).values(baseItem('child'));

    const res = await PATCH(patchReq('child', { version: 0, parent_learning_item_id: 'hub' }), {
      params: Promise.resolve({ id: 'child' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { parent_learning_item_id: string | null };
    expect(body.parent_learning_item_id).toBe('hub');

    const rows = await db
      .select({ pid: learning_item.parent_learning_item_id })
      .from(learning_item)
      .where(eq(learning_item.id, 'child'));
    expect(rows[0].pid).toBe('hub');
  });

  it('clears parent when parent_learning_item_id=null', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('hub'));
    await db.insert(learning_item).values(baseItem('child', { parent_learning_item_id: 'hub' }));

    const res = await PATCH(patchReq('child', { version: 0, parent_learning_item_id: null }), {
      params: Promise.resolve({ id: 'child' }),
    });
    expect(res.status).toBe(200);
    const rows = await db
      .select({ pid: learning_item.parent_learning_item_id })
      .from(learning_item)
      .where(eq(learning_item.id, 'child'));
    expect(rows[0].pid).toBeNull();
  });

  it('rejects self-cycle (parent === id)', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1'));

    const res = await PATCH(patchReq('li1', { version: 0, parent_learning_item_id: 'li1' }), {
      params: Promise.resolve({ id: 'li1' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('validation_error');
    expect(body.message).toContain('cannot reference self');
  });

  it('rejects descendant-cycle (assigning a descendant as parent would create a loop)', async () => {
    const db = testDb();
    // top → mid → bot
    await db.insert(learning_item).values(baseItem('top'));
    await db.insert(learning_item).values(baseItem('mid', { parent_learning_item_id: 'top' }));
    await db.insert(learning_item).values(baseItem('bot', { parent_learning_item_id: 'mid' }));

    // Try to make top.parent = bot. Walking up from bot: bot → mid → top — top found.
    const res = await PATCH(patchReq('top', { version: 0, parent_learning_item_id: 'bot' }), {
      params: Promise.resolve({ id: 'top' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('validation_error');
    expect(body.message).toContain('cycle');
  });

  it('rejects unknown parent_learning_item_id', async () => {
    const db = testDb();
    await db.insert(learning_item).values(baseItem('li1'));

    const res = await PATCH(
      patchReq('li1', { version: 0, parent_learning_item_id: 'does_not_exist' }),
      { params: Promise.resolve({ id: 'li1' }) },
    );
    expect(res.status).toBe(400);
  });
});
