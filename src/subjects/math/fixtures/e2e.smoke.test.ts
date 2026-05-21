/**
 * M0 Task 13 — e2e smoke for math fixture happy path.
 *
 * Inserts the 10 fixtures directly via testDB (bypasses HTTP seed endpoint
 * to keep this an integration test, not an HTTP test). Then runs judgeAnswer
 * for representative items in each kind and verifies coarse_outcome +
 * route + capability_ref.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import { type JudgeQuestionRow, judgeAnswer } from '@/server/ai/judges/question-contract';
import { resolveSubjectProfile } from '@/subjects/profile';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { loadMathFixtures } from './index';

const ROOT_KID = 'k-math-smoke-root';

async function seedMathFixtures(db: Db): Promise<void> {
  const now = new Date();
  await db.insert(knowledge).values({
    id: ROOT_KID,
    name: '数学 smoke root',
    domain: 'math',
    parent_id: null,
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  const fixtures = loadMathFixtures();
  for (const item of fixtures) {
    await db.insert(question).values({
      id: `q-smoke-${item.ref}`,
      kind: item.kind,
      prompt_md: item.prompt_md,
      reference_md: item.reference_md,
      choices_md: item.choices_md ?? null,
      rubric_json: item.rubric_json ?? null,
      knowledge_ids: [ROOT_KID],
      difficulty: item.difficulty,
      source: 'math_fixture_smoke',
      variant_depth: 0,
      figures: [],
      image_refs: [],
      structured: null,
      metadata: { fixture_ref: item.ref },
      created_at: now,
      updated_at: now,
      version: 0,
    });
  }
}

function toJudgeRow(row: typeof question.$inferSelect): JudgeQuestionRow {
  return {
    id: row.id,
    kind: row.kind,
    prompt_md: row.prompt_md,
    reference_md: row.reference_md,
    rubric_json: row.rubric_json,
    choices_md: row.choices_md,
    judge_kind_override: row.judge_kind_override,
    figures: row.figures,
    image_refs: row.image_refs,
    structured: row.structured,
  };
}

describe('math fixture e2e smoke', () => {
  const mathProfile = resolveSubjectProfile('math');
  let db: Db;

  beforeAll(() => {
    db = testDb();
  });

  beforeEach(async () => {
    await resetDb();
    await seedMathFixtures(db);
  });

  it('all 10 fixtures land in the question table with figures=[] image_refs=[] structured=null', async () => {
    const rows = await db.select().from(question);
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row.figures).toEqual([]);
      expect(row.image_refs).toEqual([]);
      expect(row.structured).toBeNull();
      expect(row.source).toBe('math_fixture_smoke');
    }
  });

  it('answering a single_choice fixture correctly → exact route → coarse_outcome=correct', async () => {
    const [row] = await db
      .select()
      .from(question)
      .where(eq(question.id, 'q-smoke-math-choice-001'));
    expect(row).toBeDefined();
    const { route, result } = await judgeAnswer({
      db,
      question: toJudgeRow(row),
      answer_md: '7',
      subjectProfile: mathProfile,
    });
    expect(route).toBe('exact');
    expect(result.coarse_outcome).toBe('correct');
    expect(result.capability_ref.id).toBe('exact');
    expect(result.score).toBeGreaterThanOrEqual(0.85);
  });

  it('answering a single_choice fixture wrongly → exact route → coarse_outcome=incorrect', async () => {
    const [row] = await db
      .select()
      .from(question)
      .where(eq(question.id, 'q-smoke-math-choice-001'));
    const { route, result } = await judgeAnswer({
      db,
      question: toJudgeRow(row),
      answer_md: '4',
      subjectProfile: mathProfile,
    });
    expect(route).toBe('exact');
    expect(result.coarse_outcome).toBe('incorrect');
  });

  it('answering a fill_blank fixture with keyword present → keyword route → correct', async () => {
    const [row] = await db.select().from(question).where(eq(question.id, 'q-smoke-math-fill-001'));
    const { route, result } = await judgeAnswer({
      db,
      question: toJudgeRow(row),
      answer_md: '答案是 11',
      subjectProfile: mathProfile,
    });
    expect(route).toBe('keyword');
    expect(result.coarse_outcome).toBe('correct');
    expect(result.capability_ref.id).toBe('keyword');
  });

  it('answering a fill_blank fixture without the keyword → keyword route → incorrect', async () => {
    const [row] = await db.select().from(question).where(eq(question.id, 'q-smoke-math-fill-001'));
    const { result } = await judgeAnswer({
      db,
      question: toJudgeRow(row),
      answer_md: '我不知道',
      subjectProfile: mathProfile,
    });
    expect(result.coarse_outcome).toBe('incorrect');
  });
});
