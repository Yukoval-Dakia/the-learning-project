import { db } from '@/db/client';
import { question } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../../../tests/helpers/db';
import { runAnswerClassBackfill } from './answer_class_backfill';

type QFields = Partial<typeof question.$inferInsert> & { id: string; kind: string };
async function seed(f: QFields) {
  await db.insert(question).values({
    prompt_md: 'P',
    source: 'authentic',
    created_at: new Date(),
    updated_at: new Date(),
    ...f,
    // explicit draft_status (NULL≡active) — keeps test inserts aligned with the
    // audit:draft-status guideline even though test files escape the scan.
    draft_status: f.draft_status ?? null,
  });
}

describe('answer_class_backfill', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('classifies NULL answer_class rows by structure', async () => {
    await seed({ id: 'q-choice', kind: 'choice', choices_md: ['A', 'B'] });
    await seed({ id: 'q-deriv', kind: 'derivation' });
    await seed({ id: 'q-prose', kind: 'short_answer' });
    await seed({
      id: 'q-comp-kw',
      kind: 'computation',
      rubric_json: { criteria: [], keywords: ['x'] },
    });
    const n = await runAnswerClassBackfill(db, 50);
    expect(n).toBe(4);
    const rows = Object.fromEntries(
      (await db.select().from(question)).map((r) => [r.id, r.answer_class]),
    );
    expect(rows['q-choice']).toBe('exact');
    expect(rows['q-deriv']).toBe('steps');
    expect(rows['q-prose']).toBe('semantic');
    expect(rows['q-comp-kw']).toBe('keyword');
  });

  it('normalizes dirty profile-vocab kind for derivation (without rewriting kind)', async () => {
    // 'single_choice' is profile vocab (not canonical); choices-first → exact
    await seed({ id: 'q-sc', kind: 'single_choice', choices_md: ['甲', '乙'] });
    // 'calculation' (profile) → normalize → computation; with keywords → keyword
    await seed({
      id: 'q-calc',
      kind: 'calculation',
      rubric_json: { criteria: [], keywords: ['速度'] },
    });
    await runAnswerClassBackfill(db, 50);
    const [sc] = await db.select().from(question).where(eq(question.id, 'q-sc'));
    const [calc] = await db.select().from(question).where(eq(question.id, 'q-calc'));
    expect(sc.answer_class).toBe('exact');
    expect(calc.answer_class).toBe('keyword');
    // kind column itself is NOT rewritten — that cleanup is Step 3 PR B
    expect(sc.kind).toBe('single_choice');
    expect(calc.kind).toBe('calculation');
  });

  it('is idempotent — second run classifies nothing', async () => {
    await seed({ id: 'q1', kind: 'choice', choices_md: ['A'] });
    await runAnswerClassBackfill(db, 50);
    const n2 = await runAnswerClassBackfill(db, 50);
    expect(n2).toBe(0);
  });

  it('does not overwrite an already-set answer_class (isNull filter)', async () => {
    await seed({ id: 'q1', kind: 'choice', choices_md: ['A'], answer_class: 'semantic' });
    const n = await runAnswerClassBackfill(db, 50);
    expect(n).toBe(0);
    const [row] = await db.select().from(question).where(eq(question.id, 'q1'));
    expect(row.answer_class).toBe('semantic');
  });
});
