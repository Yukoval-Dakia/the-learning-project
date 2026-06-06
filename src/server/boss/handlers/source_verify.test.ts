// YUK-216 S2 slice 2 — source_verify (tier-2) handler DB test.
//
// docs/superpowers/plans/2026-06-05-yuk216-question-source-s2.md §3 (step 2.8).
//
// Mocks the solver (SolutionGenerateTask via runTaskFn). Asserts the Option-B gate:
//   - all checks pass → promote draft→active + FSRS enroll (enters the pool).
//   - solve_check fail (solver disagrees with reference) → stay draft.
//   - source_consistency fail (mislabeled web_sourced row that does not derive
//     tier 2) → stay draft.
//   - dedup fail (near-duplicate of an existing active pool question) → stay draft.
//   - idempotency: a second run skips (already_verified).
//   - skip paths: not_found / not_web_sourced.

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WebSourcedProvenanceT } from '@/core/schema/provenance';
import { event, knowledge, question } from '@/db/schema';
import { getFsrsState } from '@/server/fsrs/state';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runSourceVerify } from './source_verify';

// Solver output shape consumed by verify-framework.runSolveCheck (it only reads
// reference_solution.final_answer + answer_equivalents).
function solverOutput(finalAnswer: string, equivalents: string[] = []): string {
  return JSON.stringify({
    reference_solution: { final_answer: finalAnswer, answer_equivalents: equivalents },
  });
}

async function seedKnowledge(id: string, domain = 'wenyan') {
  const db = testDb();
  const now = new Date();
  await db.insert(knowledge).values({
    id,
    name: '之',
    domain,
    parent_id: null,
    merged_from: [],
    proposed_by_ai: false,
    approval_status: 'approved',
    created_at: now,
    updated_at: now,
    version: 0,
  });
}

interface SeedQuestionOpts {
  id?: string;
  knowledgeIds?: string[];
  kind?: string;
  prompt?: string;
  reference?: string;
  choices?: string[] | null;
  judge?: string | null;
  source?: string;
  draftStatus?: string | null;
  web?: Partial<WebSourcedProvenanceT>;
  sourceRefKind?: string | null;
  sourceRef?: string | null;
  metadataOverride?: Record<string, unknown>;
}

async function seedQuestion(opts: SeedQuestionOpts = {}): Promise<string> {
  const db = testDb();
  const now = new Date();
  const id = opts.id ?? createId();
  const url = opts.web?.url ?? 'https://example.edu/wenyan/lunyu';
  const metadata =
    opts.metadataOverride ??
    ({
      web_sourced: {
        url,
        title: opts.web?.title ?? '论语 注疏',
        fetched_at: opts.web?.fetched_at ?? '2026-06-06T00:00:00.000Z',
        whitelist_match: opts.web?.whitelist_match ?? false,
        ...(opts.web?.extraction_hash ? { extraction_hash: opts.web.extraction_hash } : {}),
      },
      ...(opts.sourceRefKind === null ? {} : { source_ref_kind: opts.sourceRefKind ?? 'url' }),
    } as Record<string, unknown>);

  await db.insert(question).values({
    id,
    kind: opts.kind ?? 'choice',
    prompt_md: opts.prompt ?? '「之」在「学而时习之」中作？',
    reference_md: opts.reference ?? '代词',
    rubric_json: null,
    choices_md: opts.choices === undefined ? ['代词', '助词', '动词'] : opts.choices,
    judge_kind_override: opts.judge ?? 'exact',
    knowledge_ids: opts.knowledgeIds ?? ['k1'],
    difficulty: 2,
    source: opts.source ?? 'web_sourced',
    source_ref: opts.sourceRef === undefined ? url : opts.sourceRef,
    draft_status: opts.draftStatus === undefined ? 'draft' : opts.draftStatus,
    created_by: { by: 'ai', task_kind: 'SourcingTask' },
    metadata: metadata as never,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return id;
}

describe('runSourceVerify', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('promotes draft→active + FSRS-enrolls when every tier-2 check passes', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    const qid = await seedQuestion({ knowledgeIds: ['k1'] });
    // exact-kind solver AGREES with the reference answer → solve_check pass.
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('代词') }));

    const result = await runSourceVerify({ db, questionId: qid, runTaskFn });
    expect(result.status).toBe('verified');
    expect(result.checks?.every((c) => c.verdict !== 'fail')).toBe(true);

    const rows = await db.select().from(question).where(eq(question.id, qid));
    expect(rows[0].draft_status).toBe('active');

    // FSRS enrolled at knowledge level.
    const fsrs = await getFsrsState(db, 'knowledge', 'k1');
    expect(fsrs).not.toBeNull();

    const events = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:source_verify'));
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('success');
  });

  it('keeps the draft when solve_check fails (solver disagrees with reference)', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    const qid = await seedQuestion({ knowledgeIds: ['k1'] });
    // solver says '助词' but reference is '代词' → exact mismatch → solve_check fail.
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('助词') }));

    const result = await runSourceVerify({ db, questionId: qid, runTaskFn });
    expect(result.status).toBe('failed');
    expect(result.checks?.some((c) => c.check === 'solve_check' && c.verdict === 'fail')).toBe(
      true,
    );

    const rows = await db.select().from(question).where(eq(question.id, qid));
    expect(rows[0].draft_status).toBe('draft');
    const fsrs = await getFsrsState(db, 'knowledge', 'k1');
    expect(fsrs).toBeNull();
  });

  it('fails source_consistency for a web_sourced row missing its provenance block', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    // web_sourced row whose metadata has NO web_sourced block → deriveSourceTier → 4.
    const qid = await seedQuestion({
      knowledgeIds: ['k1'],
      metadataOverride: { source_ref_kind: 'url' },
    });
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('代词') }));

    const result = await runSourceVerify({ db, questionId: qid, runTaskFn });
    expect(result.status).toBe('failed');
    expect(
      result.checks?.some((c) => c.check === 'source_consistency' && c.verdict === 'fail'),
    ).toBe(true);
    const rows = await db.select().from(question).where(eq(question.id, qid));
    expect(rows[0].draft_status).toBe('draft');
  });

  it('fails dedup when an active pool question shares a knowledge point and is near-identical', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    // existing ACTIVE pool question with the same prompt.
    await seedQuestion({
      knowledgeIds: ['k1'],
      source: 'quiz_gen',
      draftStatus: 'active',
      prompt: '「之」在「学而时习之」中作什么成分？',
      metadataOverride: {},
      sourceRef: null,
    });
    const qid = await seedQuestion({
      knowledgeIds: ['k1'],
      prompt: '「之」在「学而时习之」中作什么成分？',
    });
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('代词') }));

    const result = await runSourceVerify({ db, questionId: qid, runTaskFn });
    expect(result.checks?.some((c) => c.check === 'dedup' && c.verdict === 'fail')).toBe(true);
    expect(result.status).toBe('failed');
  });

  it('is idempotent — a second run skips as already_verified', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    const qid = await seedQuestion({ knowledgeIds: ['k1'] });
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('代词') }));

    const first = await runSourceVerify({ db, questionId: qid, runTaskFn });
    expect(first.status).toBe('verified');
    const second = await runSourceVerify({ db, questionId: qid, runTaskFn });
    expect(second.status).toBe('skipped:already_verified');
    // solver only ran on the first pass.
    expect(runTaskFn).toHaveBeenCalledTimes(1);
  });

  it('skips a non-existent question', async () => {
    const db = testDb();
    const result = await runSourceVerify({
      db,
      questionId: 'missing',
      runTaskFn: vi.fn(async () => ({ text: solverOutput('代词') })),
    });
    expect(result.status).toBe('skipped:not_found');
  });

  it('skips a non-web_sourced question', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    const qid = await seedQuestion({
      knowledgeIds: ['k1'],
      source: 'quiz_gen',
      metadataOverride: {},
      sourceRef: null,
    });
    const result = await runSourceVerify({
      db,
      questionId: qid,
      runTaskFn: vi.fn(async () => ({ text: solverOutput('代词') })),
    });
    expect(result.status).toBe('skipped:not_web_sourced');
  });
});
