import type { Db } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import { type JudgeQuestionRow, judgeAnswer } from '@/server/ai/judges/question-contract';
import { resolveSubjectProfile } from '@/subjects/profile';
import { eq } from 'drizzle-orm';
/**
 * P0 — e2e smoke for physics fixture happy path.
 *
 * Inserts the 10 fixtures directly via testDb. P0 explicitly does NOT add
 * app/api/_/seed/physics/route.ts — that would break acid test 1 since
 * `app/api` is a framework path.
 *
 * P1 judges single_choice fixtures via exact and routes calculation fixtures
 * to unit_dimension@1. The P1 capability is a skeleton, so calculation answers
 * return unsupported until P2 implements deterministic + fallback judging.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { loadPhysicsFixtures } from './index';

const ROOT_KID = 'k-physics-smoke-root';

async function seedPhysicsFixtures(db: Db): Promise<void> {
  const now = new Date();
  await db.insert(knowledge).values({
    id: ROOT_KID,
    name: '物理 smoke root',
    domain: 'physics',
    parent_id: null,
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  const fixtures = loadPhysicsFixtures();
  for (const item of fixtures) {
    await db.insert(question).values({
      id: `q-smoke-${item.ref}`,
      kind: item.kind,
      prompt_md: item.prompt_md,
      reference_md: item.reference_md,
      choices_md: item.choices_md ?? null,
      rubric_json: null,
      knowledge_ids: [ROOT_KID],
      difficulty: item.difficulty,
      source: 'physics_fixture_smoke',
      variant_depth: 0,
      figures: [],
      image_refs: [],
      structured: null,
      metadata: { fixture_ref: item.ref, knowledge_hint: item.knowledge_hint },
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

describe('physics fixture e2e smoke', () => {
  const physicsProfile = resolveSubjectProfile('physics');
  let db: Db;

  beforeAll(() => {
    db = testDb();
  });

  beforeEach(async () => {
    await resetDb();
    await seedPhysicsFixtures(db);
  });

  it('all 10 fixtures land in the question table with figures=[] image_refs=[] structured=null', async () => {
    const rows = await db.select().from(question);
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row.figures).toEqual([]);
      expect(row.image_refs).toEqual([]);
      expect(row.structured).toBeNull();
      expect(row.source).toBe('physics_fixture_smoke');
    }
  });

  it('answering physics-dim-001 correctly → exact route → coarse_outcome=correct', async () => {
    const [row] = await db
      .select()
      .from(question)
      .where(eq(question.id, 'q-smoke-physics-dim-001'));
    expect(row).toBeDefined();
    const { route, result } = await judgeAnswer({
      db,
      question: toJudgeRow(row),
      answer_md: '力',
      subjectProfile: physicsProfile,
    });
    expect(route).toBe('exact');
    expect(result.coarse_outcome).toBe('correct');
    expect(result.capability_ref.id).toBe('exact');
  });

  it('answering physics-dim-001 wrongly → exact route → coarse_outcome=incorrect', async () => {
    const [row] = await db
      .select()
      .from(question)
      .where(eq(question.id, 'q-smoke-physics-dim-001'));
    const { route, result } = await judgeAnswer({
      db,
      question: toJudgeRow(row),
      answer_md: '速度',
      subjectProfile: physicsProfile,
    });
    expect(route).toBe('exact');
    expect(result.coarse_outcome).toBe('incorrect');
  });

  it('answering physics-dim-002 correctly → exact route → coarse_outcome=correct', async () => {
    const [row] = await db
      .select()
      .from(question)
      .where(eq(question.id, 'q-smoke-physics-dim-002'));
    const { route, result } = await judgeAnswer({
      db,
      question: toJudgeRow(row),
      answer_md: '$L \\cdot T^{-1}$',
      subjectProfile: physicsProfile,
    });
    expect(route).toBe('exact');
    expect(result.coarse_outcome).toBe('correct');
  });

  it('calculation fixtures are inserted', async () => {
    const rows = await db.select().from(question).where(eq(question.kind, 'calculation'));
    expect(rows.length).toBeGreaterThanOrEqual(7);
  });

  it('answering physics-unit-001 → unit_dimension route → unsupported skeleton', async () => {
    const [row] = await db
      .select()
      .from(question)
      .where(eq(question.id, 'q-smoke-physics-unit-001'));
    expect(row).toBeDefined();
    const { route, result } = await judgeAnswer({
      db,
      question: toJudgeRow(row),
      answer_md: '30 km/h',
      subjectProfile: physicsProfile,
    });
    expect(route).toBe('unit_dimension');
    expect(result.coarse_outcome).toBe('unsupported');
    expect(result.capability_ref.id).toBe('unit_dimension');
  });
});
