// YUK-390 kind Step 3 residual (PR B) — persisted-kind canonicalization backfill
// db test. Seeds the recon §6 dirty-kind census (single_choice / multiple_choice /
// calculation / word_problem / reading_comprehension / proof) and locks:
//   - dirty profile-vocab kinds are rewritten to canonical QuestionKind;
//   - idempotent (second run is a no-op);
//   - fail-closed on neither-vocab values (recorded, never rewritten);
//   - already-canonical rows (incl. both-vocab translation/short_answer) untouched.
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { question } from '@/db/schema';
import { resetDb } from '../../../../tests/helpers/db';
import { runKindCleanupBackfill } from './kind_cleanup_backfill';

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

describe('kind_cleanup_backfill', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('normalizes persisted profile-vocab kinds to canonical (recon §6 census)', async () => {
    await seed({ id: 'q-sc', kind: 'single_choice', choices_md: ['甲', '乙'] });
    await seed({ id: 'q-mc', kind: 'multiple_choice', choices_md: ['甲', '乙'] });
    await seed({ id: 'q-calc', kind: 'calculation' });
    await seed({ id: 'q-wp', kind: 'word_problem' });
    await seed({ id: 'q-rc', kind: 'reading_comprehension' });
    await seed({ id: 'q-proof', kind: 'proof' });
    const res = await runKindCleanupBackfill(db, 50);
    expect(res.cleaned).toBe(6);
    expect(res.unknown).toBe(0);
    const rows = Object.fromEntries((await db.select().from(question)).map((r) => [r.id, r.kind]));
    expect(rows['q-sc']).toBe('choice');
    expect(rows['q-mc']).toBe('choice');
    expect(rows['q-calc']).toBe('computation');
    expect(rows['q-wp']).toBe('computation');
    expect(rows['q-rc']).toBe('reading');
    expect(rows['q-proof']).toBe('derivation');
  });

  it('is idempotent — a second run cleans nothing', async () => {
    await seed({ id: 'q-sc', kind: 'single_choice', choices_md: ['甲', '乙'] });
    await runKindCleanupBackfill(db, 50);
    const res2 = await runKindCleanupBackfill(db, 50);
    expect(res2.cleaned).toBe(0);
    expect(res2.unknown).toBe(0);
  });

  it('fail-closed: a neither-vocab kind is skipped and counted, never rewritten', async () => {
    await seed({ id: 'q-unknown', kind: 'nonsense_kind' });
    const res = await runKindCleanupBackfill(db, 50);
    expect(res.cleaned).toBe(0);
    expect(res.unknown).toBe(1);
    const [row] = await db.select().from(question).where(eq(question.id, 'q-unknown'));
    expect(row.kind).toBe('nonsense_kind');
  });

  it('leaves already-canonical rows untouched (incl. both-vocab translation)', async () => {
    await seed({ id: 'q-choice', kind: 'choice', choices_md: ['A'] });
    await seed({ id: 'q-trans', kind: 'translation' });
    await seed({
      id: 'q-fill',
      kind: 'fill_blank',
      rubric_json: { criteria: [], keywords: ['x'] },
    });
    const res = await runKindCleanupBackfill(db, 50);
    expect(res.cleaned).toBe(0);
    expect(res.unknown).toBe(0);
  });
});
