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

async function seedKnowledge(id: string, domain = 'wenyan', opts: { archived?: boolean } = {}) {
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
    archived_at: opts.archived ? now : null,
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
  // F2: drop the extract entirely from the seeded web_sourced block (the
  // missing-extract → source_consistency fail path).
  omitExtract?: boolean;
}

async function seedQuestion(opts: SeedQuestionOpts = {}): Promise<string> {
  const db = testDb();
  const now = new Date();
  const id = opts.id ?? createId();
  const url = opts.web?.url ?? 'https://example.edu/wenyan/lunyu';
  // F2: extract is REQUIRED on web_sourced provenance. Default to an extract that
  // grounds the default prompt/reference so the baseline rows pass source_consistency;
  // tests targeting the missing-extract path pass `web: { extract: undefined }` (and a
  // matching omitExtract sentinel) explicitly.
  const defaultExtract = '「之」在「学而时习之」中作代词，指代所学的内容。';
  const includeExtract = !opts.omitExtract;
  const metadata =
    opts.metadataOverride ??
    ({
      web_sourced: {
        url,
        title: opts.web?.title ?? '论语 注疏',
        fetched_at: opts.web?.fetched_at ?? '2026-06-06T00:00:00.000Z',
        whitelist_match: opts.web?.whitelist_match ?? false,
        ...(opts.web?.extraction_hash ? { extraction_hash: opts.web.extraction_hash } : {}),
        ...(includeExtract ? { extract: opts.web?.extract ?? defaultExtract } : {}),
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
    // YUK-350 (L3, RL5) — a promoted verify carries NO failure_class.
    expect((events[0].payload as Record<string, unknown>).failure_class).toBeUndefined();
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

    // YUK-350 (L3, RL5) — a non-promote (check fail) verify carries
    // failure_class='validation_failure' (outcome stays 'failure').
    const events = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:source_verify'));
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('failure');
    expect((events[0].payload as Record<string, unknown>).failure_class).toBe('validation_failure');
  });

  // YUK-350 (L3, RL5) — NOTE: source_verify's catch-bottom (outcome='error' +
  // failure_class='system_error') cannot be exercised hermetically through the
  // runTaskFn seam: runSolveCheck (verify-framework) intentionally SWALLOWS every
  // solver error to verdict='unsupported' (conservative R2 — a solver blowup must not
  // kill a question), so a thrown runTaskFn yields a non-promote SUCCESS, not a
  // system error. The catch-bottom only fires on a deterministic-check or DB-level
  // throw, which has no test seam here. The failure_class='system_error' key is the
  // identical additive pattern verified end-to-end in quiz_verify.test.ts. The
  // reachable source_verify failure mode (a hard check fail) IS asserted above
  // (validation_failure).

  // ── YUK-479 — auto-promote one-way gate fix (demote a pre-promoted draft on FAIL) ──
  it('YUK-479 demotes a pre-promoted (active) cold-start draft back to draft when a check fails', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    // Cold-start image-upload shape: web_sourced + draft_status='active' PRE-PROMOTED before
    // source_verify runs (image-candidate-accept.ts, no inbox wall).
    const qid = await seedQuestion({ knowledgeIds: ['k1'], draftStatus: 'active' });
    // solver disagrees with the reference → solve_check fail → no promote.
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('助词') }));

    const result = await runSourceVerify({ db, questionId: qid, runTaskFn });
    expect(result.status).toBe('failed');

    // The failed-verify question is demoted OUT of the pool (the one-way gate is closed).
    const rows = await db.select().from(question).where(eq(question.id, qid));
    expect(rows[0].draft_status).toBe('draft');

    const events = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:source_verify'));
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('failure');
    expect((events[0].payload as Record<string, unknown>).demoted).toBe(true);
  });

  it('YUK-479 does NOT demote a normal draft on FAIL (demoted:false, no-op — scoped by construction)', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    // Normal sourcing.ts shape: draft_status defaults to 'draft' before verify.
    const qid = await seedQuestion({ knowledgeIds: ['k1'] });
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('助词') })); // solve_check fail

    const result = await runSourceVerify({ db, questionId: qid, runTaskFn });
    expect(result.status).toBe('failed');

    // Already 'draft' → the demote WHERE draft_status='active' guard is a no-op; unchanged.
    const rows = await db.select().from(question).where(eq(question.id, qid));
    expect(rows[0].draft_status).toBe('draft');
    const events = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:source_verify'));
    expect((events[0].payload as Record<string, unknown>).demoted).toBe(false);
  });

  it('YUK-479 leaves a pre-promoted (active) cold-start draft active when verify passes (demoted:false)', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    const qid = await seedQuestion({ knowledgeIds: ['k1'], draftStatus: 'active' });
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('代词') })); // solve_check pass

    const result = await runSourceVerify({ db, questionId: qid, runTaskFn });
    expect(result.status).toBe('verified');

    // Pass keeps it active (and now FSRS-enrolls it); the demote branch never runs.
    const rows = await db.select().from(question).where(eq(question.id, qid));
    expect(rows[0].draft_status).toBe('active');
    const fsrs = await getFsrsState(db, 'knowledge', 'k1');
    expect(fsrs).not.toBeNull();
    const events = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:source_verify'));
    expect((events[0].payload as Record<string, unknown>).demoted).toBe(false);
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

  it('fails source_consistency when source_ref is missing (incomplete provenance)', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    // valid web_sourced provenance block but NO source_ref column → incomplete (F4).
    const qid = await seedQuestion({ knowledgeIds: ['k1'], sourceRef: null });
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('代词') }));

    const result = await runSourceVerify({ db, questionId: qid, runTaskFn });
    expect(result.status).toBe('failed');
    expect(
      result.checks?.some(
        (c) =>
          c.check === 'source_consistency' && c.verdict === 'fail' && /missing/i.test(c.reason),
      ),
    ).toBe(true);
    const rows = await db.select().from(question).where(eq(question.id, qid));
    expect(rows[0].draft_status).toBe('draft');
  });

  it('fails source_consistency when a persisted extract does not ground the question (F1)', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    // The extract is about an UNRELATED topic — zero overlap with the prompt/reference,
    // so the declared source cannot have produced this question (mis-attributed URL).
    const qid = await seedQuestion({
      knowledgeIds: ['k1'],
      prompt: '「之」在「学而时习之」中作？',
      reference: '代词',
      web: { extract: '光合作用发生在叶绿体中，需要光照与二氧化碳。' },
    });
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('代词') }));

    const result = await runSourceVerify({ db, questionId: qid, runTaskFn });
    expect(result.status).toBe('failed');
    expect(
      result.checks?.some(
        (c) => c.check === 'source_consistency' && c.verdict === 'fail' && /ground/i.test(c.reason),
      ),
    ).toBe(true);
    const rows = await db.select().from(question).where(eq(question.id, qid));
    expect(rows[0].draft_status).toBe('draft');
  });

  it('passes source_consistency when the persisted extract grounds the question (F1)', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    const qid = await seedQuestion({
      knowledgeIds: ['k1'],
      prompt: '「之」在「学而时习之」中作？',
      reference: '代词',
      // extract echoes the prompt → grounded → source_consistency passes.
      web: { extract: '「之」在「学而时习之」中作代词，指代所学的内容。' },
    });
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('代词') }));

    const result = await runSourceVerify({ db, questionId: qid, runTaskFn });
    expect(result.status).toBe('verified');
    expect(
      result.checks?.some((c) => c.check === 'source_consistency' && c.verdict === 'pass'),
    ).toBe(true);
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

  it('promotes an option-less true_false question (structure check exempts true_false) (F1)', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    // 判断题 form: kind='true_false' + reference_md carrying 真/假, NO choices_md.
    const qid = await seedQuestion({
      knowledgeIds: ['k1'],
      kind: 'true_false',
      choices: null,
      prompt: '「学而时习之」中的「之」是代词。判断正误。',
      reference: '真',
      judge: 'exact',
      web: { extract: '「学而时习之」中的「之」作代词，指代所学的内容，故此判断为真。' },
    });
    // exact-kind solver AGREES → solve_check pass; structure must NOT fail on choices.
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('真') }));

    const result = await runSourceVerify({ db, questionId: qid, runTaskFn });
    expect(
      result.checks?.some((c) => c.check === 'structure_completeness' && c.verdict === 'pass'),
    ).toBe(true);
    expect(result.status).toBe('verified');
    const rows = await db.select().from(question).where(eq(question.id, qid));
    expect(rows[0].draft_status).toBe('active');
  });

  it('fails source_consistency when a web_sourced row has no extract (F2)', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    // sourced row with valid provenance but NO extract → cannot be deterministically
    // grounded → fail (a fabricated/unanchored URL must not promote to tier 2).
    const qid = await seedQuestion({ knowledgeIds: ['k1'], omitExtract: true });
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('代词') }));

    const result = await runSourceVerify({ db, questionId: qid, runTaskFn });
    expect(result.status).toBe('failed');
    expect(
      result.checks?.some(
        (c) =>
          c.check === 'source_consistency' && c.verdict === 'fail' && /extract/i.test(c.reason),
      ),
    ).toBe(true);
    const rows = await db.select().from(question).where(eq(question.id, qid));
    expect(rows[0].draft_status).toBe('draft');
  });

  it('does not promote when the knowledge point was archived after sourcing (F3)', async () => {
    const db = testDb();
    // knowledge point archived between sourcing (draft) and verify (promote).
    await seedKnowledge('k1', 'wenyan', { archived: true });
    const qid = await seedQuestion({ knowledgeIds: ['k1'] });
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('代词') }));

    const result = await runSourceVerify({ db, questionId: qid, runTaskFn });
    expect(result.status).toBe('failed');
    const rows = await db.select().from(question).where(eq(question.id, qid));
    expect(rows[0].draft_status).toBe('draft');
    // not enrolled onto the dead node.
    const fsrs = await getFsrsState(db, 'knowledge', 'k1');
    expect(fsrs).toBeNull();
    // the verify event records the archived-knowledge reason.
    const events = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:source_verify'));
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('failure');
    const payload = events[0].payload as Record<string, unknown>;
    expect(payload.knowledge_archived).toMatchObject({ archived_knowledge_ids: ['k1'] });
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
