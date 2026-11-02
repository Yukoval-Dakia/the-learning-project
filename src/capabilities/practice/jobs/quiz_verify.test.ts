// Q5 + Q6 — search-grounded QuizGen verify handler DB test
// (docs/archive/superpowers/specs/2026-06-02-quizgen-search-grounded-design.md §3 / §5).
//
// Mocks the AI (runTaskFn). Asserts the Option-B gate:
//   - verify pass → draft_status 'draft'→'active' + material_fsrs_state row built
//     (Q6 FSRS enroll, question enters the pool) + metadata.quiz_gen.verification
//     status='verified' + copy_safety checked_by='quiz_verify'.
//   - LLM overall='fail' → stays draft + verification.status='failed'.
//   - copy_safety 'too_close' (LLM or deterministic overlap) → stays draft +
//     verification.status='needs_review' + NO FSRS enroll.
//   - idempotency — a second run skips (no duplicate verify event, no re-promote).

import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { QuizGenMetadataT } from '@/core/schema/quiz_gen';
import { event, knowledge, material_fsrs_state, question } from '@/db/schema';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runQuizVerify } from './quiz_verify';

function verifyOutput(opts: {
  overall: 'pass' | 'needs_review' | 'fail';
  copySafety?: 'original' | 'too_close' | 'unknown';
  groundingVerdict?: 'pass' | 'fail' | 'unclear';
  knowledgeHitVerdict?: 'pass' | 'fail' | 'unclear';
  // YUK-224 F2 — tier-3 material relevance verdict. Omitted from the JSON when
  // undefined (older / non-material verifier outputs don't emit it).
  materialGroundingVerdict?: 'pass' | 'fail' | 'unclear';
}): string {
  return JSON.stringify({
    grounding: { verdict: opts.groundingVerdict ?? 'pass', note: 'grounded in source' },
    copy_safety: { verdict: opts.copySafety ?? 'original', max_overlap: 0.1 },
    knowledge_hit: { verdict: opts.knowledgeHitVerdict ?? 'pass', note: 'tests k1' },
    ...(opts.materialGroundingVerdict
      ? { material_grounding: { verdict: opts.materialGroundingVerdict, note: 'probes material' } }
      : {}),
    overall: opts.overall,
    summary_md: `复核结论：${opts.overall}`,
    confidence: 0.8,
  });
}

function taskMock(
  defaultText: string,
  overrides: Partial<Record<string, string>> = {},
  taskRunId = 'tr_v',
) {
  return vi.fn(async (kind: string, _input: unknown, _ctx: unknown) => ({
    text: overrides[kind] ?? defaultText,
    task_run_id: taskRunId,
  }));
}

// Back-compat single-output wrapper (pre-review call sites keep their minimal shape).
function runTaskMock(output: string, taskRunId = 'tr_v') {
  return taskMock(output, {}, taskRunId);
}

async function seedKnowledge(id: string) {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: '之',
    domain: 'yuwen',
    parent_id: null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

const BASE_META: QuizGenMetadataT = {
  source_pack: {
    query_plan: ['文言 之 主谓间 用法'],
    searched_at: '2026-06-02T10:00:00.000Z',
    tool: 'tavily',
  },
  source_refs: [
    {
      url: 'https://example.edu/wenyan/zhi',
      title: '文言虚词「之」',
      snippet: '之用于主谓之间，取消句子独立性。',
      used_for: 'fact',
      extracted: true,
    },
  ],
  generation_method: 'search_grounded',
  copy_safety: { verdict: 'original', max_overlap: 0.12, checked_by: 'agent_self' },
  generation_status: 'ready',
};

async function seedDraftQuestion(opts: {
  id: string;
  knowledgeId: string;
  /** YUK-1037 — multi-binding override; defaults to [knowledgeId]. */
  knowledgeIds?: string[];
  promptMd?: string;
  meta?: QuizGenMetadataT;
  source?: string;
  // YUK-538 / YUK-554 — override to seed an EXACT-kind question (fill_blank / choice) so a
  // solve-check normalize-mismatch fail can be built. Default stays the semantic short_answer.
  kind?: string;
  referenceMd?: string;
  choicesMd?: string[] | null;
  judge?: string | null;
  rubricJson?: unknown;
  supplyTrace?: unknown;
  difficultyEvidence?: unknown;
}) {
  const db = testDb();
  const now = new Date();
  await db.insert(question).values({
    id: opts.id,
    kind: opts.kind ?? 'short_answer',
    prompt_md: opts.promptMd ?? '用你自己的话解释「之」作主谓间助词的作用。',
    reference_md: opts.referenceMd ?? '「之」用在主谓之间，取消句子独立性。',
    rubric_json: (opts.rubricJson ?? {
      required_points: ['用在主谓之间', '取消句子独立性'],
    }) as never,
    choices_md: opts.choicesMd === undefined ? null : opts.choicesMd,
    judge_kind_override: opts.judge === undefined ? 'semantic' : opts.judge,
    knowledge_ids: opts.knowledgeIds ?? [opts.knowledgeId],
    difficulty: 3,
    source: opts.source ?? 'quiz_gen',
    source_ref: opts.knowledgeId,
    draft_status: 'draft',
    created_by: { by: 'ai', task_kind: 'QuizGenTask', task_run_id: 'tr_gen' } as never,
    metadata: {
      quiz_gen: opts.meta ?? BASE_META,
      ...(opts.supplyTrace ? { supply_trace: opts.supplyTrace } : {}),
      ...(opts.difficultyEvidence ? { difficulty_evidence: opts.difficultyEvidence } : {}),
    } as never,
    created_at: now,
    updated_at: now,
  });
}

async function fsrsRowCount(subjectKind: string, subjectId: string): Promise<number> {
  const rows = await testDb()
    .select({ id: material_fsrs_state.id })
    .from(material_fsrs_state)
    .where(
      and(
        eq(material_fsrs_state.subject_kind, subjectKind),
        eq(material_fsrs_state.subject_id, subjectId),
      ),
    );
  return rows.length;
}

describe('runQuizVerify', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('rejects a stale verdict when KC attribution changes mid-verify, then retries current version', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    await seedKnowledge('k2');
    await seedDraftQuestion({ id: 'q_verify_version_race', knowledgeId: 'k1' });
    let mutated = false;
    const staleRun = vi.fn(async (kind: string) => {
      if (kind === 'QuizVerifyTask' && !mutated) {
        mutated = true;
        await db
          .update(question)
          .set({ knowledge_ids: ['k1', 'k2'], version: 1 })
          .where(eq(question.id, 'q_verify_version_race'));
      }
      return { text: verifyOutput({ overall: 'pass' }), task_run_id: 'tr-stale-verify' };
    });

    await expect(
      runQuizVerify({ db, questionId: 'q_verify_version_race', runTaskFn: staleRun }),
    ).rejects.toThrow('changed during verification');

    const [afterStale] = await db
      .select()
      .from(question)
      .where(eq(question.id, 'q_verify_version_race'));
    expect(afterStale).toMatchObject({
      draft_status: 'draft',
      knowledge_ids: ['k1', 'k2'],
      version: 1,
    });
    const staleEvents = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:quiz_verify'));
    expect(staleEvents.map((candidate) => candidate.outcome)).toEqual(['error']);
    expect(await fsrsRowCount('knowledge', 'k1')).toBe(0);
    expect(await fsrsRowCount('knowledge', 'k2')).toBe(0);

    const retry = await runQuizVerify({
      db,
      questionId: 'q_verify_version_race',
      runTaskFn: runTaskMock(verifyOutput({ overall: 'pass' }), 'tr-current-verify'),
    });
    expect(retry.status).toBe('verified');
    expect(await fsrsRowCount('knowledge', 'k1')).toBe(1);
    expect(await fsrsRowCount('knowledge', 'k2')).toBe(1);
    const outcomes = (
      await db.select().from(event).where(eq(event.action, 'experimental:quiz_verify'))
    ).map((candidate) => candidate.outcome);
    expect(outcomes.sort()).toEqual(['error', 'success']);
  });
});
