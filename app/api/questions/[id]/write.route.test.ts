// YUK-281 (YUK-203) — PATCH (edit) + DELETE (archive) route DB integration tests.
//
// Covers: editable-field PATCH, bloodline-field rejection, optimistic-lock
// conflict, unknown knowledge_ids rejection; DELETE association-count gate
// (no confirm → 409 + counts), confirm flow → soft-archive (re-draft), pool
// exclusion after archive, composite parent→part cascade, and the edit/archive
// audit events.

import { newId } from '@/core/ids';
import { artifact, event, knowledge, material_fsrs_state, question } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { DELETE, PATCH } from './route';

const NOW = new Date('2026-06-07T00:00:00Z');

async function seedKnowledge(id: string): Promise<void> {
  await testDb()
    .insert(knowledge)
    .values({
      id,
      name: `node ${id}`,
      domain: 'wenyan',
      created_at: NOW,
      updated_at: NOW,
    });
}

async function seedQuestion(opts: {
  id?: string;
  kind?: string;
  knowledge_ids?: string[];
  draft_status?: string | null;
  parent_question_id?: string | null;
  version?: number;
}): Promise<string> {
  const id = opts.id ?? newId();
  await testDb()
    .insert(question)
    .values({
      id,
      kind: opts.kind ?? 'reading',
      prompt_md: 'original prompt',
      reference_md: 'original ref',
      choices_md: null,
      knowledge_ids: opts.knowledge_ids ?? [],
      difficulty: 3,
      source: 'manual',
      draft_status: opts.draft_status ?? 'active',
      parent_question_id: opts.parent_question_id ?? null,
      created_at: NOW,
      updated_at: NOW,
      version: opts.version ?? 0,
    });
  return id;
}

async function seedAttempt(questionId: string, outcome: 'success' | 'failure'): Promise<void> {
  await testDb()
    .insert(event)
    .values({
      id: newId(),
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: questionId,
      outcome,
      payload: { answer_md: 'a', answer_image_refs: [], referenced_knowledge_ids: [] },
      created_at: NOW,
    });
}

function mkFsrsState() {
  return {
    due: NOW.toISOString(),
    stability: 1.5,
    difficulty: 5,
    elapsed_days: 0,
    scheduled_days: 1,
    learning_steps: 0,
    reps: 1,
    lapses: 0,
    state: 'review',
    last_review: null,
  };
}

async function seedQuestionFsrs(questionId: string): Promise<void> {
  await testDb()
    .insert(material_fsrs_state)
    .values({
      id: `f_q_${questionId}`,
      subject_kind: 'question',
      subject_id: questionId,
      state: mkFsrsState() as unknown as (typeof material_fsrs_state.$inferInsert)['state'],
      due_at: NOW,
      updated_at: NOW,
    });
}

async function seedPaperRef(questionId: string): Promise<void> {
  await testDb()
    .insert(artifact)
    .values({
      id: newId(),
      type: 'tool_quiz',
      title: 'paper',
      knowledge_ids: [],
      intent_source: 'quiz_gen',
      source: 'ai_generated',
      tool_kind: 'quiz',
      tool_state: { question_ids: [questionId] } as (typeof artifact.$inferInsert)['tool_state'],
      generation_status: 'ready',
      created_at: NOW,
      updated_at: NOW,
    });
}

function mkPatchReq(id: string, body: unknown): Request {
  return new Request(`http://localhost/api/questions/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function mkDeleteReq(id: string, query = ''): Request {
  return new Request(`http://localhost/api/questions/${id}${query}`, { method: 'DELETE' });
}

async function loadRow(id: string) {
  const rows = await testDb().select().from(question).where(eq(question.id, id)).limit(1);
  return rows[0];
}

describe('PATCH /api/questions/[id]', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('edits the editable surface and bumps version', async () => {
    const k = newId();
    await seedKnowledge(k);
    const id = await seedQuestion({});

    const res = await PATCH(
      mkPatchReq(id, {
        version: 0,
        prompt_md: 'edited prompt',
        reference_md: 'edited ref',
        choices_md: ['A', 'B'],
        difficulty: 5,
        knowledge_ids: [k],
        kind: 'choice',
        draft_status: 'draft',
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: number; event_id: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBe(1);

    const row = await loadRow(id);
    expect(row?.prompt_md).toBe('edited prompt');
    expect(row?.reference_md).toBe('edited ref');
    expect(row?.choices_md).toEqual(['A', 'B']);
    expect(row?.difficulty).toBe(5);
    expect(row?.knowledge_ids).toEqual([k]);
    expect(row?.kind).toBe('choice');
    expect(row?.draft_status).toBe('draft');
    expect(row?.version).toBe(1);
  });

  it('writes an experimental:question_edit event with before/after', async () => {
    const id = await seedQuestion({});
    await PATCH(mkPatchReq(id, { version: 0, prompt_md: 'new' }), {
      params: Promise.resolve({ id }),
    });

    const evs = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'experimental:question_edit'), eq(event.subject_id, id)));
    expect(evs).toHaveLength(1);
    const payload = evs[0]?.payload as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(payload.before.prompt_md).toBe('original prompt');
    expect(payload.after.prompt_md).toBe('new');
  });

  it.each([
    ['variant_depth', 1],
    ['root_question_id', 'q_root'],
    ['parent_variant_id', 'q_pv'],
    ['parent_question_id', 'q_parent'],
    ['part_index', 2],
  ])('rejects bloodline field %s with 400', async (field, value) => {
    const id = await seedQuestion({});
    const res = await PATCH(mkPatchReq(id, { version: 0, [field]: value }), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('validation_error');
    expect(body.message).toContain(field);

    // The row is untouched.
    const row = await loadRow(id);
    expect(row?.version).toBe(0);
    expect(row?.prompt_md).toBe('original prompt');
  });

  it('409s on version mismatch (optimistic lock)', async () => {
    const id = await seedQuestion({ version: 3 });
    const res = await PATCH(mkPatchReq(id, { version: 0, prompt_md: 'x' }), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(409);
  });

  it('400s on unknown knowledge_ids', async () => {
    const id = await seedQuestion({});
    const res = await PATCH(mkPatchReq(id, { version: 0, knowledge_ids: ['k_missing'] }), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(400);
  });

  it('404s on a missing question', async () => {
    const res = await PATCH(mkPatchReq('q_nope', { version: 0, prompt_md: 'x' }), {
      params: Promise.resolve({ id: 'q_nope' }),
    });
    expect(res.status).toBe(404);
  });

  it('400s when no editable field is provided (version only)', async () => {
    const id = await seedQuestion({});
    const res = await PATCH(mkPatchReq(id, { version: 0 }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(400);
  });

  it('no-ops (no version bump, no event) when the patch matches the current row', async () => {
    const id = await seedQuestion({});
    // Resubmit the seeded values verbatim — nothing actually changed.
    const res = await PATCH(
      mkPatchReq(id, { version: 0, prompt_md: 'original prompt', reference_md: 'original ref' }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; noop: boolean; version: number };
    expect(body.ok).toBe(true);
    expect(body.noop).toBe(true);
    expect(body.version).toBe(0); // unchanged — no phantom bump

    const row = await loadRow(id);
    expect(row?.version).toBe(0);

    // No audit event was fabricated for the no-op.
    const evs = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'experimental:question_edit'), eq(event.subject_id, id)));
    expect(evs).toHaveLength(0);
  });

  it('only records genuinely-changed fields in before/after (mixed patch)', async () => {
    const id = await seedQuestion({});
    // prompt_md changes; reference_md is resubmitted unchanged.
    await PATCH(
      mkPatchReq(id, { version: 0, prompt_md: 'new prompt', reference_md: 'original ref' }),
      { params: Promise.resolve({ id }) },
    );
    const evs = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'experimental:question_edit'), eq(event.subject_id, id)));
    expect(evs).toHaveLength(1);
    const payload = evs[0]?.payload as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(payload.after).toHaveProperty('prompt_md', 'new prompt');
    // Unchanged reference_md must NOT leak into the diff.
    expect(payload.after).not.toHaveProperty('reference_md');
    expect(payload.before).not.toHaveProperty('reference_md');
  });
});

describe('DELETE /api/questions/[id]', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns association counts + 409 when confirm is absent', async () => {
    const id = await seedQuestion({});
    await seedAttempt(id, 'failure'); // counts as both attempt + mistake
    await seedAttempt(id, 'success');
    await seedQuestionFsrs(id);
    await seedPaperRef(id);

    const res = await DELETE(mkDeleteReq(id, '?version=0'), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      associations: { attempts: number; mistakes: number; fsrs_cards: number; paper_refs: number };
      has_associations: boolean;
    };
    expect(body.error).toBe('confirm_required');
    expect(body.associations.attempts).toBe(2);
    expect(body.associations.mistakes).toBe(1);
    expect(body.associations.fsrs_cards).toBe(1);
    expect(body.associations.paper_refs).toBe(1);
    expect(body.has_associations).toBe(true);

    // Nothing was archived.
    const row = await loadRow(id);
    expect(row?.draft_status).toBe('active');
  });

  it('soft-archives (re-drafts) on confirm=true', async () => {
    const id = await seedQuestion({ draft_status: 'active' });

    const res = await DELETE(mkDeleteReq(id, '?version=0&confirm=true'), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; archived: boolean; event_id: string };
    expect(body.ok).toBe(true);
    expect(body.archived).toBe(true);

    const row = await loadRow(id);
    expect(row?.draft_status).toBe('draft'); // excluded from pool/due/practice
    expect(row?.version).toBe(1);
    const meta = row?.metadata as Record<string, unknown> | null;
    expect(meta?.archived_reason).toBe('user');
    expect(meta?.archived_previous_draft_status).toBe('active');
    expect(typeof meta?.archived_at).toBe('number');
  });

  it('writes an experimental:question_archive event', async () => {
    const id = await seedQuestion({ draft_status: 'active' });
    await DELETE(mkDeleteReq(id, '?version=0&confirm=true'), {
      params: Promise.resolve({ id }),
    });
    const evs = await testDb()
      .select()
      .from(event)
      .where(and(eq(event.action, 'experimental:question_archive'), eq(event.subject_id, id)));
    expect(evs).toHaveLength(1);
    const payload = evs[0]?.payload as { archived: boolean; previous_draft_status: string };
    expect(payload.archived).toBe(true);
    expect(payload.previous_draft_status).toBe('active');
  });

  it('cascades archive to composite parts (parent → parts re-drafted)', async () => {
    const parentId = await seedQuestion({ kind: 'reading', draft_status: 'active' });
    const partA = await seedQuestion({
      kind: 'question_part',
      draft_status: 'active',
      parent_question_id: parentId,
    });
    const partB = await seedQuestion({
      kind: 'question_part',
      draft_status: 'active',
      parent_question_id: parentId,
    });
    // A part belonging to a DIFFERENT parent must NOT be touched.
    const otherParent = await seedQuestion({ draft_status: 'active' });
    const otherPart = await seedQuestion({
      kind: 'question_part',
      draft_status: 'active',
      parent_question_id: otherParent,
    });

    const res = await DELETE(mkDeleteReq(parentId, '?version=0&confirm=true'), {
      params: Promise.resolve({ id: parentId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cascaded_part_ids: string[] };
    expect(new Set(body.cascaded_part_ids)).toEqual(new Set([partA, partB]));

    expect((await loadRow(partA))?.draft_status).toBe('draft');
    expect((await loadRow(partB))?.draft_status).toBe('draft');
    // Untouched.
    expect((await loadRow(otherPart))?.draft_status).toBe('active');
  });

  it('400s when version query param is missing on a CONFIRMED delete', async () => {
    const id = await seedQuestion({});
    const res = await DELETE(mkDeleteReq(id, '?confirm=true'), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(400);
  });

  it('returns the 409 confirm gate even when version is absent (unconfirmed)', async () => {
    // The first unconfirmed DELETE must surface the association warning so the UI
    // can render the confirm dialog — it must NOT 400 on the missing version.
    const id = await seedQuestion({});
    await seedAttempt(id, 'failure');
    const res = await DELETE(mkDeleteReq(id, ''), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; has_associations: boolean };
    expect(body.error).toBe('confirm_required');
    expect(body.has_associations).toBe(true);
  });

  it('404s on a missing question with confirm', async () => {
    const res = await DELETE(mkDeleteReq('q_nope', '?version=0&confirm=true'), {
      params: Promise.resolve({ id: 'q_nope' }),
    });
    expect(res.status).toBe(404);
  });

  it('409s on version mismatch with confirm', async () => {
    const id = await seedQuestion({ version: 5 });
    const res = await DELETE(mkDeleteReq(id, '?version=0&confirm=true'), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(409);
  });
});
