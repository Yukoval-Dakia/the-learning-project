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

import { buildProducerDifficultyEvidence } from '@/core/schema/difficulty-evidence';
import type { WebSourcedProvenanceT } from '@/core/schema/provenance';
import { event, knowledge, question } from '@/db/schema';
import type { SourceGroundingVerifyResult } from '@/server/ai/judges/source-grounding-verify';
import { getFsrsState } from '@/server/fsrs/state';
import {
  buildCoverageEvidenceDemand,
  buildSupplyTrace,
  evidenceDemandToTargetContext,
  withSupplyTraceDifficultyEvidence,
} from '@/server/question-supply/evidence-demand';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { semanticJudgeOutput } from '../../../../tests/helpers/solve-check-fixtures';
import { type SourceGroundingParams, runSourceVerify } from './source_verify';

// Solver output shape consumed by verify-framework.runSolveCheck (it only reads
// reference_solution.final_answer + answer_equivalents).
// R1 (YUK-554 review) — a shared richer twin lives in tests/helpers/solve-check-fixtures.ts
// (used by verify-framework.test.ts + quiz_verify.test.ts); this local minimal copy stays by
// review裁决 (source_verify is comment-only this round). Keep the consumed shape in lockstep.
function solverOutput(finalAnswer: string, equivalents: string[] = []): string {
  return JSON.stringify({
    reference_solution: { final_answer: finalAnswer, answer_equivalents: equivalents },
  });
}

function confidentlyWrongSolver(finalAnswer: string) {
  return vi.fn(async (kind: string) => ({
    text:
      kind === 'SemanticJudgeTask'
        ? semanticJudgeOutput('incorrect', 0.95)
        : solverOutput(finalAnswer),
  }));
}

// YUK-230 — a full metadata block that (a) passes deterministic source_consistency
// (web_sourced + grounding extract + matching url) AND (b) marks the row as a
// single_source_grounding image_candidate row (asset id + flag) so the source-grounding
// gate fires. metadataOverride replaces metadata wholesale, so return the complete shape.
function groundingMetadata(
  sourceAssetId: string,
  url = 'https://example.edu/wenyan/lunyu',
): Record<string, unknown> {
  return {
    web_sourced: {
      url,
      title: '论语 注疏',
      fetched_at: '2026-06-06T00:00:00.000Z',
      whitelist_match: false,
      extract: '「之」在「学而时习之」中作代词，指代所学的内容。',
    },
    source_ref_kind: 'url',
    single_source_grounding: true,
    image_candidate_source_asset_id: sourceAssetId,
  };
}

// YUK-230 — a stubbed SourceGroundingVerifyResult. 'transient' models the runner's
// image-fetch / VLM / parse error bucket, which the gate fails-closed (demote) + re-throws
// as a retriable verify error rather than a confident「题面不在图里」content fail.
function groundingResult(
  status: 'grounded' | 'not_grounded' | 'transient',
): SourceGroundingVerifyResult {
  if (status === 'transient') {
    return { status: 'transient_error', message: 'grounding VLM call failed: upstream 503' };
  }
  return {
    status,
    confidence: 0.8,
    observed_md: '图片中可见「学而时习之」一句',
    reason_md:
      status === 'grounded' ? '题面核心内容出现在来源图片中' : '题面内容与来源图片无关（疑似幻觉）',
  };
}

async function seedKnowledge(id: string, domain = 'yuwen', opts: { archived?: boolean } = {}) {
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
  supplyTrace?: unknown;
  difficultyEvidence?: unknown;
  imageRefs?: string[];
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
      ...(opts.supplyTrace ? { supply_trace: opts.supplyTrace } : {}),
      ...(opts.difficultyEvidence ? { difficulty_evidence: opts.difficultyEvidence } : {}),
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
    image_refs: opts.imageRefs ?? [],
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
    const difficultyEvidence = buildProducerDifficultyEvidence(2, 'sourcing_web');
    const supplyTrace = withSupplyTraceDifficultyEvidence(
      buildSupplyTrace(
        {
          targetId: 'target-source-verify',
          targetFingerprint: 'fp-source-verify',
          context: evidenceDemandToTargetContext(
            buildCoverageEvidenceDemand({
              subjectId: 'yuwen',
              knowledgeIds: ['k1'],
              statement: 'verify source evidence',
            }),
          ),
        },
        'sourcing_web',
      ),
      difficultyEvidence,
    );
    const qid = await seedQuestion({ knowledgeIds: ['k1'], supplyTrace, difficultyEvidence });
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
    expect(events[0].payload).toMatchObject({
      supply_trace: supplyTrace,
      difficulty_evidence: difficultyEvidence,
    });
  });

  it('rejects a stale verdict when KC attribution changes mid-verify, then retries current version', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    await seedKnowledge('k2');
    const qid = await seedQuestion({ id: 'q_source_verify_version_race', knowledgeIds: ['k1'] });
    let mutated = false;
    const staleRun = vi.fn(async () => {
      if (!mutated) {
        mutated = true;
        await db
          .update(question)
          .set({ knowledge_ids: ['k1', 'k2'], version: 1 })
          .where(eq(question.id, qid));
      }
      return { text: solverOutput('代词') };
    });

    await expect(runSourceVerify({ db, questionId: qid, runTaskFn: staleRun })).rejects.toThrow(
      'changed during verification',
    );

    const [afterStale] = await db.select().from(question).where(eq(question.id, qid));
    expect(afterStale).toMatchObject({
      draft_status: 'draft',
      knowledge_ids: ['k1', 'k2'],
      version: 1,
    });
    const staleEvents = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:source_verify'));
    expect(staleEvents.map((candidate) => candidate.outcome)).toEqual(['error']);
    expect(await getFsrsState(db, 'knowledge', 'k1')).toBeNull();
    expect(await getFsrsState(db, 'knowledge', 'k2')).toBeNull();

    const retry = await runSourceVerify({
      db,
      questionId: qid,
      runTaskFn: vi.fn(async () => ({ text: solverOutput('代词') })),
    });
    expect(retry.status).toBe('verified');
    expect(await getFsrsState(db, 'knowledge', 'k1')).not.toBeNull();
    expect(await getFsrsState(db, 'knowledge', 'k2')).not.toBeNull();
    const outcomes = (
      await db.select().from(event).where(eq(event.action, 'experimental:source_verify'))
    ).map((candidate) => candidate.outcome);
    expect(outcomes.sort()).toEqual(['error', 'success']);
  });

  it('attaches every prompt image to the independent solver before promoting an image question', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    const qid = await seedQuestion({ knowledgeIds: ['k1'], imageRefs: ['asset-diagram'] });
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('代词') }));
    const imageFetchFn = vi.fn(async () => [{ data: 'base64-image', mediaType: 'image/png' }]);

    const result = await runSourceVerify({
      db,
      questionId: qid,
      runTaskFn,
      imageFetchFn,
    });

    expect(result.status).toBe('verified');
    expect(imageFetchFn).toHaveBeenCalledWith(['asset-diagram'], db);
    expect(runTaskFn).toHaveBeenCalledWith(
      'SolutionGenerateVisionTask',
      expect.objectContaining({
        text: expect.stringContaining('"prompt_image_refs":["asset-diagram"]'),
        images: [{ data: 'base64-image', mediaType: 'image/png' }],
      }),
      expect.any(Object),
    );
    expect((await db.select().from(question).where(eq(question.id, qid)))[0].draft_status).toBe(
      'active',
    );
  });

  it('holds an image question for review when a referenced asset cannot be loaded', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    const qid = await seedQuestion({ knowledgeIds: ['k1'], imageRefs: ['missing-asset'] });
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('代词') }));

    const result = await runSourceVerify({
      db,
      questionId: qid,
      runTaskFn,
      imageFetchFn: async () => [],
    });

    expect(result.status).toBe('failed');
    expect(runTaskFn).not.toHaveBeenCalled();
    expect((await db.select().from(question).where(eq(question.id, qid)))[0].draft_status).toBe(
      'draft',
    );
    const [verifyEvent] = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:source_verify'));
    expect(verifyEvent.payload).toMatchObject({
      overall: 'needs_review',
      summary_md: 'tier-2 source verify needs review: prompt image content was unavailable',
    });
  });

  it('holds an image question when vision solving fails after image fetch succeeds', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    const qid = await seedQuestion({ knowledgeIds: ['k1'], imageRefs: ['asset-diagram'] });

    const result = await runSourceVerify({
      db,
      questionId: qid,
      runTaskFn: async () => {
        throw new Error('vision model rejected image');
      },
      imageFetchFn: async () => [{ data: 'base64-image', mediaType: 'image/png' }],
    });

    expect(result.status).toBe('failed');
    expect((await db.select().from(question).where(eq(question.id, qid)))[0].draft_status).toBe(
      'draft',
    );
    const [verifyEvent] = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:source_verify'));
    expect(verifyEvent.payload).toMatchObject({
      overall: 'needs_review',
      summary_md: 'tier-2 source verify needs review: prompt image content was unavailable',
    });
  });

  // YUK-698 review — a JSONB `null` supply_trace (valid, distinct from absent) must NOT
  // throw before the failure-bottom try. Previously parseSupplyTrace(null) threw here, so
  // the draft was stranded with no error event and pg-boss retried identically forever. The
  // trace is now dropped best-effort (safeParse) and verify proceeds normally.
  it('drops a null metadata.supply_trace best-effort instead of throwing', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    const qid = await seedQuestion({
      knowledgeIds: ['k1'],
      metadataOverride: {
        web_sourced: {
          url: 'https://example.edu/wenyan/lunyu',
          title: '论语 注疏',
          fetched_at: '2026-06-06T00:00:00.000Z',
          whitelist_match: false,
          extract: '「之」在「学而时习之」中作代词，指代所学的内容。',
        },
        source_ref_kind: 'url',
        supply_trace: null,
      },
    });
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('代词') }));

    const result = await runSourceVerify({ db, questionId: qid, runTaskFn });
    expect(result.status).toBe('verified');
    const events = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:source_verify'));
    expect(events).toHaveLength(1);
    // The unparseable trace is simply absent from the event payload (not a crash).
    expect((events[0].payload as Record<string, unknown>).supply_trace).toBeUndefined();
  });

  it('promotes an exact text mismatch when SemanticJudge establishes equivalence', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    const qid = await seedQuestion({ knowledgeIds: ['k1'] });
    const runTaskFn = vi.fn(async (kind: string) => ({
      text:
        kind === 'SemanticJudgeTask'
          ? semanticJudgeOutput('correct', 0.95)
          : solverOutput('它指代所学习的内容'),
    }));

    const result = await runSourceVerify({ db, questionId: qid, runTaskFn });

    expect(result.status).toBe('verified');
    expect(result.checks).toContainEqual(
      expect.objectContaining({ check: 'solve_check', verdict: 'pass' }),
    );
    expect((await db.select().from(question).where(eq(question.id, qid)))[0].draft_status).toBe(
      'active',
    );
  });

  it('holds an unresolved exact mismatch for review when SemanticJudge is unavailable', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    const qid = await seedQuestion({ knowledgeIds: ['k1'] });
    const runTaskFn = vi.fn(async (kind: string) => ({
      text: kind === 'SemanticJudgeTask' ? 'not-json' : solverOutput('助词'),
    }));

    const result = await runSourceVerify({ db, questionId: qid, runTaskFn });

    expect(result.status).toBe('failed');
    expect(result.checks).toContainEqual(
      expect.objectContaining({ check: 'solve_check', verdict: 'unsupported' }),
    );
    expect((await db.select().from(question).where(eq(question.id, qid)))[0].draft_status).toBe(
      'draft',
    );
    const [verifyEvent] = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:source_verify'));
    expect(verifyEvent.payload).toMatchObject({
      promoted: false,
      overall: 'needs_review',
      summary_md: 'tier-2 source verify needs review: exact answer mismatch remained unresolved',
    });
  });

  it('keeps the draft when solve_check fails (solver disagrees with reference)', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    const qid = await seedQuestion({ knowledgeIds: ['k1'] });
    // normalize cannot match 助词 vs 代词; SemanticJudge confirms the disagreement.
    const runTaskFn = confidentlyWrongSolver('助词');

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
    // solver disagrees and SemanticJudge confirms → solve_check fail → no promote.
    const runTaskFn = confidentlyWrongSolver('助词');

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
    const runTaskFn = confidentlyWrongSolver('助词'); // semantic-confirmed solve_check fail

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

  // ── YUK-230 — source-grounding gate (single_source_grounding image_candidate rows) ──
  it('YUK-230 runs the source-grounding re-check and promotes when the source image confirms the 题面', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    const qid = await seedQuestion({
      knowledgeIds: ['k1'],
      draftStatus: 'active', // image_candidate accept pre-promotes structurally-sound drafts
      metadataOverride: groundingMetadata('asset-src-1'),
    });
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('代词') })); // solve_check pass
    const sourceGroundingFn = vi.fn(async (_p: SourceGroundingParams) =>
      groundingResult('grounded'),
    );

    const result = await runSourceVerify({ db, questionId: qid, runTaskFn, sourceGroundingFn });
    expect(result.status).toBe('verified');
    // the paid re-check ran exactly once, on the row's source_asset image.
    expect(sourceGroundingFn).toHaveBeenCalledTimes(1);
    expect(sourceGroundingFn.mock.calls[0][0]).toMatchObject({
      sourceAssetId: 'asset-src-1',
      prompt_md: '「之」在「学而时习之」中作？',
    });

    const rows = await db.select().from(question).where(eq(question.id, qid));
    expect(rows[0].draft_status).toBe('active'); // grounded → enters the pool

    const [ev] = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:source_verify'));
    expect(ev.outcome).toBe('success');
    const okPayload = ev.payload as Record<string, unknown>;
    expect(okPayload.overall).toBe('pass');
    expect(okPayload.source_grounding).toMatchObject({
      grounded: true,
      source_asset_id: 'asset-src-1',
      triggered_by: 'image_candidate_accept',
    });
    // thread 3 — the grounding verdict is a first-class check (drives the unified overall).
    expect(okPayload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: 'source_grounding', verdict: 'pass' }),
      ]),
    );
  });

  it('YUK-230 demotes a pre-promoted single-source draft back to draft when the 题面 is NOT in the image (VLM hallucination)', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    const qid = await seedQuestion({
      knowledgeIds: ['k1'],
      draftStatus: 'active',
      metadataOverride: groundingMetadata('asset-src-2'),
    });
    // solve_check PASSES (the fabricated 题面+答案 are internally self-consistent) — only the
    // dedicated grounding re-check, reading the actual image, catches that the 题面 is not in
    // it. This is the threat model the earlier answer-judge wiring could not cover.
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('代词') }));
    const sourceGroundingFn = vi.fn(async () => groundingResult('not_grounded'));

    const result = await runSourceVerify({ db, questionId: qid, runTaskFn, sourceGroundingFn });
    expect(result.status).toBe('failed');

    // 复核失败 = 打回 draft（不入练习池）— the pre-promoted active row is demoted.
    const rows = await db.select().from(question).where(eq(question.id, qid));
    expect(rows[0].draft_status).toBe('draft');
    // FSRS never enrolled (promote branch never ran).
    const fsrs = await getFsrsState(db, 'knowledge', 'k1');
    expect(fsrs).toBeNull();

    const [ev] = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:source_verify'));
    expect(ev.outcome).toBe('failure');
    const failPayload = ev.payload as Record<string, unknown>;
    expect(failPayload.demoted).toBe(true);
    expect(failPayload.source_grounding).toMatchObject({
      grounded: false,
      source_asset_id: 'asset-src-2',
      triggered_by: 'image_candidate_accept',
    });
    // thread 3 — grounding fail is a failing check, so the unified overall is 'fail' (not
    // 'needs_review') and the summary names source_grounding, matching the outcome.
    expect(failPayload.overall).toBe('fail');
    expect(failPayload.failure_class).toBe('validation_failure');
    expect(failPayload.summary_md).toContain('source_grounding');
    expect(failPayload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: 'source_grounding', verdict: 'fail' }),
      ]),
    );
  });

  it('YUK-230 FAIL-CLOSED: a BARE throw from the grounding fn is treated as transient (demote + throw)', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    const qid = await seedQuestion({
      knowledgeIds: ['k1'],
      draftStatus: 'active',
      metadataOverride: groundingMetadata('asset-src-bare'),
    });
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('代词') }));
    // thread 1 — a bug/regression that makes the grounding fn THROW (instead of returning a
    // discriminated result) must NOT bypass fail-closed. The handler wraps the call and folds
    // a bare throw into the same transient path (demote → throw).
    const sourceGroundingFn = vi.fn(async () => {
      throw new Error('unexpected grounding fn crash');
    });

    await expect(
      runSourceVerify({ db, questionId: qid, runTaskFn, sourceGroundingFn }),
    ).rejects.toThrow('source grounding failed (transient)');

    const rows = await db.select().from(question).where(eq(question.id, qid));
    expect(rows[0].draft_status).toBe('draft'); // fail-closed demote fired despite the bare throw
    const [ev] = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:source_verify'));
    expect(ev.outcome).toBe('error');
  });

  it('YUK-230 overlapping delivery: a transient run does NOT yank a row a concurrent run already verified+promoted', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    const qid = await seedQuestion({
      knowledgeIds: ['k1'],
      draftStatus: 'active',
      metadataOverride: groundingMetadata('asset-src-race'),
    });
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('代词') }));
    // thread 2 — simulate the race window: WHILE this (stale) run is inside the grounding call,
    // a CONCURRENT run terminally verifies + promotes the question (writes a source_verify
    // outcome='success' event). This run then gets a transient error. The fail-closed demote
    // MUST skip (NOT EXISTS success guard) so the concurrent run's active row is not pulled.
    const sourceGroundingFn = vi.fn(async () => {
      await db.insert(event).values({
        id: createId(),
        session_id: null,
        actor_kind: 'agent',
        actor_ref: 'source_verify',
        action: 'experimental:source_verify',
        subject_kind: 'question',
        subject_id: qid,
        outcome: 'success',
        payload: { question_id: qid, promoted: true },
        caused_by_event_id: null,
        created_at: new Date(),
      });
      return groundingResult('transient');
    });

    await expect(
      runSourceVerify({ db, questionId: qid, runTaskFn, sourceGroundingFn }),
    ).rejects.toThrow('source grounding failed (transient)');

    // The row stays 'active' — the concurrent success event blocked the demote.
    const rows = await db.select().from(question).where(eq(question.id, qid));
    expect(rows[0].draft_status).toBe('active');
  });

  it('YUK-230 version race: a transient run does NOT demote a row EDITED (version bumped) during the VLM call', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    const qid = await seedQuestion({
      knowledgeIds: ['k1'],
      draftStatus: 'active',
      metadataOverride: groundingMetadata('asset-src-ver'),
    });
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('代词') }));
    // thread 2 round-2 — simulate an EDIT during the grounding call: the question's version is
    // bumped past the version this run read at the top. This run's transient error must NOT
    // demote the newer row (the demote is pinned to version = the run's read version), so the
    // edited row stays 'active' and this stale delivery just throws (re-run against the fresh
    // version).
    const sourceGroundingFn = vi.fn(async () => {
      await db.update(question).set({ version: 1 }).where(eq(question.id, qid));
      return groundingResult('transient');
    });

    await expect(
      runSourceVerify({ db, questionId: qid, runTaskFn, sourceGroundingFn }),
    ).rejects.toThrow('source grounding failed (transient)');

    // The version-bumped row is untouched by the stale run's demote.
    const rows = await db.select().from(question).where(eq(question.id, qid));
    expect(rows[0].draft_status).toBe('active');
    expect(rows[0].version).toBe(1);
  });

  it('YUK-230 FAIL-CLOSED: a transient grounding error demotes the single-source row to draft AND throws (retriable)', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    const qid = await seedQuestion({
      knowledgeIds: ['k1'],
      draftStatus: 'active',
      metadataOverride: groundingMetadata('asset-src-3'),
    });
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('代词') }));
    const sourceGroundingFn = vi.fn(async () => groundingResult('transient'));

    // A transient image-fetch/VLM/parse failure is NOT a content verdict. Thread 1 fix:
    // FAIL-CLOSED — demote the pre-promoted active row to draft FIRST (so it leaves the pool
    // during the retry window, not selectable), then throw so the catch-bottom writes a
    // retriable outcome='error' event and pg-boss re-runs. NEVER conflated with 题面-not-in-image.
    await expect(
      runSourceVerify({ db, questionId: qid, runTaskFn, sourceGroundingFn }),
    ).rejects.toThrow('source grounding failed (transient)');

    // FAIL-CLOSED: the row is demoted out of the pool (was 'active') before the throw.
    const rows = await db.select().from(question).where(eq(question.id, qid));
    expect(rows[0].draft_status).toBe('draft');

    // The error event is retriable (outcome='error'); the idempotency guard re-runs it, and a
    // later 'grounded' re-check re-promotes the row to 'active'.
    const [ev] = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:source_verify'));
    expect(ev.outcome).toBe('error');
  });

  it('YUK-230 does NOT run the grounding re-check for a normal (non single_source_grounding) web_sourced question', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    const qid = await seedQuestion({ knowledgeIds: ['k1'] }); // default metadata → no marker
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('代词') }));
    const sourceGroundingFn = vi.fn(async () => groundingResult('grounded'));

    const result = await runSourceVerify({ db, questionId: qid, runTaskFn, sourceGroundingFn });
    expect(result.status).toBe('verified');
    expect(sourceGroundingFn).not.toHaveBeenCalled();

    const [ev] = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:source_verify'));
    expect((ev.payload as Record<string, unknown>).source_grounding).toBeUndefined();
  });

  it('YUK-230 fails closed when a single_source_grounding row is missing image_candidate_source_asset_id (fix-forward #1063)', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    // single_source_grounding=true but NO image_candidate_source_asset_id — the previous
    // gate silently skipped grounding and promoted; defense-in-depth now fails closed.
    const { image_candidate_source_asset_id: _drop, ...noAssetMetadata } =
      groundingMetadata('unused');
    const qid = await seedQuestion({
      knowledgeIds: ['k1'],
      draftStatus: 'active',
      metadataOverride: noAssetMetadata,
    });
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('代词') }));
    const sourceGroundingFn = vi.fn(async () => groundingResult('grounded'));

    const result = await runSourceVerify({ db, questionId: qid, runTaskFn, sourceGroundingFn });
    expect(result.status).toBe('failed');
    // The paid re-check is NOT spent — there is no image to verify against.
    expect(sourceGroundingFn).not.toHaveBeenCalled();
    // Fail-closed: the pre-promoted row is demoted out of the pool.
    const rows = await db.select().from(question).where(eq(question.id, qid));
    expect(rows[0].draft_status).toBe('draft');

    const [ev] = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:source_verify'));
    expect(ev.outcome).toBe('failure');
    const payload = ev.payload as Record<string, unknown>;
    expect(payload.overall).toBe('fail');
    expect(payload.source_grounding).toMatchObject({ grounded: false });
    expect(payload.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: 'source_grounding', verdict: 'fail' }),
      ]),
    );
  });

  it('YUK-230 skips the paid grounding re-check when a deterministic check already fails (no wasted VLM spend)', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    // Missing source_ref → source_consistency fails regardless of grounding; the row is not
    // otherwise-promotable, so the grounding gate short-circuits.
    const qid = await seedQuestion({
      knowledgeIds: ['k1'],
      draftStatus: 'active',
      sourceRef: null,
      metadataOverride: groundingMetadata('asset-src-5'),
    });
    const runTaskFn = vi.fn(async () => ({ text: solverOutput('代词') }));
    const sourceGroundingFn = vi.fn(async () => groundingResult('grounded'));

    const result = await runSourceVerify({ db, questionId: qid, runTaskFn, sourceGroundingFn });
    expect(result.status).toBe('failed');
    expect(sourceGroundingFn).not.toHaveBeenCalled();
    const rows = await db.select().from(question).where(eq(question.id, qid));
    expect(rows[0].draft_status).toBe('draft'); // demoted by the source_consistency fail
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
    await seedKnowledge('k1', 'yuwen', { archived: true });
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
