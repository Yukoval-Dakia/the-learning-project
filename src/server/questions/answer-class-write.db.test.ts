// YUK-395 (P2 A3) — answer_class ON-WRITE freshness DB test.
//
// Lives in the `db` partition (imports @/db + tests/helpers/db). Verifies:
//   (1) a fresh insert(question) at representative sites yields a NON-NULL
//       answer_class equal to deriveAnswerClass(kind/choices_md/rubric_json);
//   (2) editQuestion changing kind / choices_md RE-DERIVES answer_class (not
//       stale);
//   (3) a row genuinely lacking the structural input (no kind) stays NULL — no
//       garbage.

import { deriveAnswerClass } from '@/core/schema/answer-class';
import { question } from '@/db/schema';
import { createQuestionPart } from '@/server/questions/parts';
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { deriveAnswerClassForValues, withAnswerClass } from './answer-class-write';
import { editQuestion } from './write';

describe('withAnswerClass (on-write freshness helper)', () => {
  it('derives exact for a choice question via choices-first', () => {
    expect(withAnswerClass({ kind: 'short_answer', choices_md: ['A', 'B'] }).answer_class).toBe(
      'exact',
    );
  });

  it('derives keyword for a fill_blank with rubric keywords', () => {
    expect(
      withAnswerClass({
        kind: 'fill_blank',
        rubric_json: { criteria: [], keywords: ['甲'] },
      }).answer_class,
    ).toBe('keyword');
  });

  it('derives steps for a derivation question', () => {
    expect(withAnswerClass({ kind: 'derivation' }).answer_class).toBe('steps');
  });

  it('normalizes a dirty profile-vocab kind before deriving (single_choice → choice → exact)', () => {
    // single_choice is a profile-vocab kind that normalizes to canonical `choice`.
    expect(withAnswerClass({ kind: 'single_choice' }).answer_class).toBe('exact');
  });

  it('leaves answer_class unset when there is no kind (no structural input → NULL, never guess)', () => {
    expect(withAnswerClass({ prompt_md: 'x' }).answer_class).toBeUndefined();
    expect(deriveAnswerClassForValues({ kind: null })).toBeNull();
    expect(deriveAnswerClassForValues({ kind: '' })).toBeNull();
  });

  it('preserves an explicit caller-provided answer_class (caller wins)', () => {
    // A caller that already chose a value is not overwritten.
    expect(withAnswerClass({ kind: 'choice', answer_class: 'semantic' }).answer_class).toBe(
      'semantic',
    );
  });
});

describe('answer_class on-write at insert sites (DB)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('semantic for a short_answer with no choices/keywords (direct insert site shape)', async () => {
    const db = testDb();
    const id = createId();
    const now = new Date();
    await db.insert(question).values(
      withAnswerClass({
        id,
        kind: 'short_answer',
        prompt_md: 'explain X',
        reference_md: null,
        knowledge_ids: [],
        difficulty: 3,
        source: 'manual',
        variant_depth: 0,
        created_at: now,
        updated_at: now,
        version: 0,
      }),
    );
    const [row] = await db.select().from(question).where(eq(question.id, id));
    expect(row.answer_class).not.toBeNull();
    expect(row.answer_class).toBe(deriveAnswerClass({ kind: 'short_answer' }));
    expect(row.answer_class).toBe('semantic');
  });

  it('keyword for a fill_blank carrying rubric keywords (quiz_gen / embedded site shape)', async () => {
    const db = testDb();
    const id = createId();
    const now = new Date();
    const rubric = { criteria: [], keywords: ['答案要点'] };
    await db.insert(question).values(
      withAnswerClass({
        id,
        kind: 'fill_blank',
        prompt_md: '____ 是首都',
        reference_md: null,
        rubric_json: rubric,
        choices_md: null,
        knowledge_ids: [],
        difficulty: 2,
        source: 'quiz_gen',
        draft_status: 'draft',
        created_at: now,
        updated_at: now,
      }),
    );
    const [row] = await db.select().from(question).where(eq(question.id, id));
    expect(row.answer_class).toBe(deriveAnswerClass({ kind: 'fill_blank', rubric_json: rubric }));
    expect(row.answer_class).toBe('keyword');
  });

  it('exact for a question carrying choices (choices-first) at the parts insert site', async () => {
    // createQuestionPart is one of the 12 insert(question) owners. A part has
    // kind='question_part' (normalizes to null → falls through to semantic), so
    // we assert the part insert fills answer_class via the helper, not NULL.
    const db = testDb();
    const parentId = createId();
    const now = new Date();
    await db.insert(question).values(
      withAnswerClass({
        id: parentId,
        kind: 'short_answer',
        prompt_md: 'parent',
        knowledge_ids: [],
        difficulty: 3,
        source: 'manual',
        variant_depth: 0,
        created_at: now,
        updated_at: now,
        version: 0,
      }),
    );
    const created = await db.transaction((tx) =>
      createQuestionPart(tx, {
        parentQuestionId: parentId,
        partIndex: 0,
        promptMd: 'sub (1)',
        knowledgeIds: [],
        source: 'manual',
        now,
      }),
    );
    const [part] = await db.select().from(question).where(eq(question.id, created.questionId));
    // question_part normalizes to null → semantic (matches backfill behavior),
    // and crucially is NON-NULL: the part insert site fills answer_class on write.
    expect(part.answer_class).not.toBeNull();
    expect(part.answer_class).toBe('semantic');
  });
});

describe('editQuestion re-derives answer_class (DB)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function seedQuestion(
    id: string,
    values: { kind: string; choices_md?: string[] | null },
  ): Promise<void> {
    const db = testDb();
    const now = new Date();
    await db.insert(question).values(
      withAnswerClass({
        id,
        prompt_md: 'p',
        knowledge_ids: [],
        difficulty: 3,
        source: 'manual',
        variant_depth: 0,
        created_at: now,
        updated_at: now,
        version: 0,
        ...values,
      }),
    );
  }

  it('re-derives when an edit changes kind (derivation → choice ⇒ steps → exact)', async () => {
    const db = testDb();
    const id = createId();
    await seedQuestion(id, { kind: 'derivation' });
    const [before] = await db.select().from(question).where(eq(question.id, id));
    expect(before.answer_class).toBe('steps');

    const res = await editQuestion(db, id, before.version, { kind: 'choice' }, 'self');
    expect(res.status).toBe('updated');

    const [after] = await db.select().from(question).where(eq(question.id, id));
    expect(after.kind).toBe('choice');
    // NOT stale 'steps' — re-derived to exact (choice → exact).
    expect(after.answer_class).toBe('exact');
  });

  it('re-derives when an edit changes choices_md (choices-first ⇒ semantic → exact)', async () => {
    const db = testDb();
    const id = createId();
    await seedQuestion(id, { kind: 'short_answer' });
    const [before] = await db.select().from(question).where(eq(question.id, id));
    expect(before.answer_class).toBe('semantic');

    const res = await editQuestion(db, id, before.version, { choices_md: ['A', 'B', 'C'] }, 'self');
    expect(res.status).toBe('updated');

    const [after] = await db.select().from(question).where(eq(question.id, id));
    // choices present ⇒ choices-first exact, not stale 'semantic'.
    expect(after.answer_class).toBe('exact');
  });

  it('does NOT touch answer_class when an edit changes only an unrelated field', async () => {
    const db = testDb();
    const id = createId();
    await seedQuestion(id, { kind: 'short_answer' });
    const [before] = await db.select().from(question).where(eq(question.id, id));
    expect(before.answer_class).toBe('semantic');

    const res = await editQuestion(
      db,
      id,
      before.version,
      { prompt_md: 'a brand new prompt' },
      'self',
    );
    expect(res.status).toBe('updated');

    const [after] = await db.select().from(question).where(eq(question.id, id));
    expect(after.prompt_md).toBe('a brand new prompt');
    // answer_class unchanged (no structural field touched).
    expect(after.answer_class).toBe('semantic');
  });
});
