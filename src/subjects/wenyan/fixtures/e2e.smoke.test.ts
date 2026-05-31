import type { Db } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import { type JudgeQuestionRow, judgeAnswer } from '@/server/ai/judges/question-contract';
import { resolveSubjectProfile } from '@/subjects/profile';
import { eq } from 'drizzle-orm';
/**
 * P5.8 (YUK-182) — e2e smoke for the wenyan fixture, the FIRST subject fixture
 * to gate the SEMANTIC judge route.
 *
 * Inserts the fixtures directly via testDb (bypasses HTTP seed endpoint — this
 * is an integration test, not an HTTP test), then routes representative items
 * per kind through the REAL judge stack (judgeAnswer → resolveQuestionJudgeRoute
 * → JudgeInvoker) and asserts:
 *
 *   single_choice        → exact   (structural choices short-circuit)
 *   translation          → semantic (LLM stubbed via the per-call runTaskFn arg)
 *   reading_comprehension → semantic (proves the short_answer fallback, F-2)
 *   fill_blank+keywords  → keyword
 *
 * The semantic route's LLM is STUBBED via the existing `runTaskFn` injection
 * seam on judgeAnswer() (question-contract.ts:73 → invoker.ts:124-126 →
 * runSemanticJudge) — exactly as derivation.e2e.test.ts:83 injects a runTaskFn
 * for steps. NO module-level vi.mock, NO live LLM, NO ANTHROPIC_API_KEY. A stub
 * that throws on non-semantic kinds proves no live LLM is ever reached (AC-4).
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { type WenyanFixtureItem, loadWenyanFixtures } from './index';

const ROOT_KID = 'k-wenyan-smoke-root';

async function seedWenyanFixtures(db: Db): Promise<void> {
  const now = new Date();
  await db.insert(knowledge).values({
    id: ROOT_KID,
    name: '文言文 smoke root',
    domain: 'wenyan',
    parent_id: null,
    archived_at: null,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  const fixtures = loadWenyanFixtures();
  for (const item of fixtures) {
    await db.insert(question).values({
      id: `q-smoke-${item.ref}`,
      kind: item.kind,
      prompt_md: item.prompt_md,
      reference_md: item.reference_md,
      choices_md: item.choices_md ?? null,
      // F-3: needed so semanticInput() threads required_points / keywords.
      rubric_json: item.rubric_json ?? null,
      knowledge_ids: [ROOT_KID],
      difficulty: item.difficulty,
      source: 'wenyan_fixture_smoke',
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
    metadata: row.metadata as Record<string, unknown> | null,
  };
}

// A runTaskFn that throws unless it is the semantic judge — proves no
// non-semantic route ever reaches an LLM (AC-4), mirroring derivation.e2e
// .test.ts:83's "should not call LLM" guard. Returns a SemanticJudgeOutput
// (question-contract.ts:24-34) shaped by the requested coarse_outcome.
function semanticStub(outcome: 'correct' | 'partial' | 'incorrect') {
  const score = outcome === 'correct' ? 0.9 : outcome === 'partial' ? 0.5 : 0;
  const matched = outcome === 'correct' ? ['p1', 'p2', 'p3'] : outcome === 'partial' ? ['p1'] : [];
  const missing = outcome === 'correct' ? [] : outcome === 'partial' ? ['p2', 'p3'] : ['p1', 'p2'];
  return async (kind: string) => {
    if (kind !== 'SemanticJudgeTask') {
      throw new Error(`semantic stub invoked for non-semantic task: ${kind}`);
    }
    return {
      text: JSON.stringify({
        score,
        coarse_outcome: outcome,
        confidence: 0.9,
        feedback_md:
          outcome === 'correct'
            ? '译文准确，要点齐全。'
            : outcome === 'partial'
              ? '译文大意正确，但遗漏部分要点。'
              : '译文与原意不符。',
        evidence_json: { matched_points: matched, missing_points: missing },
      }),
    };
  };
}

describe('wenyan fixture e2e smoke', () => {
  const wenyanProfile = resolveSubjectProfile('wenyan');
  let db: Db;

  beforeAll(() => {
    db = testDb();
  });

  beforeEach(async () => {
    await resetDb();
    await seedWenyanFixtures(db);
  });

  async function getRow(ref: string): Promise<typeof question.$inferSelect> {
    const [row] = await db
      .select()
      .from(question)
      .where(eq(question.id, `q-smoke-${ref}`));
    expect(row).toBeDefined();
    return row;
  }

  // AC-6: all fixtures land in question with the multimodal carriers empty.
  it('all fixtures land in the question table with figures=[] image_refs=[] structured=null', async () => {
    const rows = await db.select().from(question);
    const fixtures = loadWenyanFixtures();
    expect(rows).toHaveLength(fixtures.length);
    for (const row of rows) {
      expect(row.figures).toEqual([]);
      expect(row.image_refs).toEqual([]);
      expect(row.structured).toBeNull();
      expect(row.source).toBe('wenyan_fixture_smoke');
    }
  });

  // AC-2: single_choice → exact route (no stub; throws if any LLM is reached).
  it('answering a single_choice fixture correctly → exact route → coarse_outcome=correct', async () => {
    const row = await getRow('wenyan-choice-001');
    const { route, result } = await judgeAnswer({
      db,
      question: toJudgeRow(row),
      answer_md: '通「悦」，高兴',
      subjectProfile: wenyanProfile,
      runTaskFn: semanticStub('correct'), // would throw if reached → proves no LLM
    });
    expect(route).toBe('exact');
    expect(result.coarse_outcome).toBe('correct');
    expect(result.capability_ref.id).toBe('exact');
  });

  it('answering a single_choice fixture wrongly → exact route → coarse_outcome=incorrect', async () => {
    const row = await getRow('wenyan-choice-001');
    const { route, result } = await judgeAnswer({
      db,
      question: toJudgeRow(row),
      answer_md: '说话',
      subjectProfile: wenyanProfile,
      runTaskFn: semanticStub('correct'),
    });
    expect(route).toBe('exact');
    expect(result.coarse_outcome).toBe('incorrect');
  });

  // AC-3 (THE frontier): translation → semantic route, LLM stubbed. Correct case.
  it('answering a translation fixture (stub=correct) → semantic route → coarse_outcome=correct', async () => {
    const row = await getRow('wenyan-trans-001');
    expect(row.choices_md).toBeNull(); // not a structural choice item
    const { route, result } = await judgeAnswer({
      db,
      question: toJudgeRow(row),
      answer_md: '温习旧知识就能领悟新理解，这样就可以做老师了。',
      subjectProfile: wenyanProfile,
      runTaskFn: semanticStub('correct'),
    });
    expect(route).toBe('semantic');
    expect(result.capability_ref.id).toBe('semantic');
    expect(result.coarse_outcome).toBe('correct');
    expect(result.score).toBeGreaterThanOrEqual(0.85);
  });

  // AC-3: translation → semantic route, weak answer → partial via normalizeSemanticResult.
  it('answering a translation fixture (stub=partial) → semantic route → coarse_outcome=partial', async () => {
    const row = await getRow('wenyan-trans-002');
    const { route, result } = await judgeAnswer({
      db,
      question: toJudgeRow(row),
      answer_md: '鱼和熊掌我都想要。',
      subjectProfile: wenyanProfile,
      runTaskFn: semanticStub('partial'),
    });
    expect(route).toBe('semantic');
    expect(result.coarse_outcome).toBe('partial');
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(0.84);
  });

  // AC-3: translation → semantic route, wrong answer → incorrect.
  it('answering a translation fixture (stub=incorrect) → semantic route → coarse_outcome=incorrect', async () => {
    const row = await getRow('wenyan-trans-003');
    const { route, result } = await judgeAnswer({
      db,
      question: toJudgeRow(row),
      answer_md: '完全不相关的内容。',
      subjectProfile: wenyanProfile,
      runTaskFn: semanticStub('incorrect'),
    });
    expect(route).toBe('semantic');
    expect(result.coarse_outcome).toBe('incorrect');
    expect(result.score).toBe(0);
  });

  // AC-3: reading_comprehension → semantic via the short_answer fallback (F-2).
  // reading_comprehension is NOT in QuestionKind enum → safeParse fails →
  // 'short_answer' (:141) → semantic (:155-156). This proves the fallback path.
  it('answering a reading_comprehension fixture → semantic route (proves short_answer fallback)', async () => {
    const row = await getRow('wenyan-read-001');
    expect(row.choices_md).toBeNull();
    const { route, result } = await judgeAnswer({
      db,
      question: toJudgeRow(row),
      answer_md: '作者以莲喻君子，赞美其不与世俗同流合污、洁身自好的高洁品格。',
      subjectProfile: wenyanProfile,
      runTaskFn: semanticStub('correct'),
    });
    expect(route).toBe('semantic');
    expect(result.capability_ref.id).toBe('semantic');
    expect(result.coarse_outcome).toBe('correct');
  });

  it('a second reading_comprehension fixture also routes semantic', async () => {
    const row = await getRow('wenyan-read-002');
    const { route } = await judgeAnswer({
      db,
      question: toJudgeRow(row),
      answer_md: '这句开门见山提出中心论点，统领下文论证。',
      subjectProfile: wenyanProfile,
      runTaskFn: semanticStub('correct'),
    });
    expect(route).toBe('semantic');
  });

  // AC-5: fill_blank + keywords rubric → keyword route (the third wenyan capability).
  it('answering a fill_blank fixture with a keyword present → keyword route → correct', async () => {
    const row = await getRow('wenyan-short-001');
    const { route, result } = await judgeAnswer({
      db,
      question: toJudgeRow(row),
      answer_md: '「之」用于主谓之间，取消句子独立性。',
      subjectProfile: wenyanProfile,
      runTaskFn: semanticStub('correct'), // would throw if reached → keyword is local
    });
    expect(route).toBe('keyword');
    expect(result.capability_ref.id).toBe('keyword');
    expect(result.coarse_outcome).toBe('correct');
  });

  it('answering a fill_blank fixture without the keyword → keyword route → incorrect', async () => {
    const row = await getRow('wenyan-short-001');
    const { route, result } = await judgeAnswer({
      db,
      question: toJudgeRow(row),
      answer_md: '我不知道',
      subjectProfile: wenyanProfile,
      runTaskFn: semanticStub('correct'),
    });
    expect(route).toBe('keyword');
    expect(result.coarse_outcome).toBe('incorrect');
  });

  // Route coverage: assert every fixture resolves to its expected route per kind.
  it('every fixture routes to its expected route per kind', async () => {
    const expectedRoute = (item: WenyanFixtureItem): string => {
      if (item.kind === 'single_choice') return 'exact';
      if (item.kind === 'fill_blank') return 'keyword';
      return 'semantic'; // translation + reading_comprehension
    };
    for (const item of loadWenyanFixtures()) {
      const row = await getRow(item.ref);
      const answer = item.kind === 'single_choice' ? (item.reference_md ?? '') : '占位作答';
      const { route } = await judgeAnswer({
        db,
        question: toJudgeRow(row),
        answer_md: answer,
        subjectProfile: wenyanProfile,
        runTaskFn: semanticStub('partial'),
      });
      expect(route, `${item.ref} (${item.kind})`).toBe(expectedRoute(item));
    }
  });
});
