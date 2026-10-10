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

import type { SourceGroundingVerifyResult } from '@/capabilities/practice/server/judge/source-grounding-verify';
import type { WebSourcedProvenanceT } from '@/core/schema/provenance';
import { event, knowledge, question, question_group_lifecycle } from '@/db/schema';
import { getFsrsState } from '@/server/fsrs/state';
import { publishQuestionGroupFromRow } from '@/server/questions/publisher';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runSourceVerify } from './source_verify';

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
    // YUK-1045 — §3.3「旧验证不能改变较新 admission 决定」：同一守卫也拦住
    // contract 挂起写 —— 并发成功已提交 ⇒ 本投递 stale，不得 mint suspended 首版。
    const lifecycles = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    expect(lifecycles).toHaveLength(0);
  });

  it('YUK-1045 P1 repro: a stale transient run cannot suspend a group a concurrent verify already ADMITTED', async () => {
    const db = testDb();
    await seedKnowledge('k1');
    const qid = await seedQuestion({
      knowledgeIds: ['k1'],
      draftStatus: 'active',
      metadataOverride: groundingMetadata('asset-src-race2'),
    });
    // 并发投递已终验 + 已发布 admitted（带 admitted 分支完整性所需 evidence）。
    await publishQuestionGroupFromRow(db, {
      rootId: qid,
      admission: {
        state: 'admitted',
        evidence: {
          marking_provenance: 'official',
          verification: {
            structural_check_passed: true,
            independent_verification: null,
          },
          model_slice: null,
        },
      },
      actorRef: 'test:publish',
      now: new Date(),
    });

    const runTaskFn = vi.fn(async () => ({ text: solverOutput('代词') }));
    const sourceGroundingFn = vi.fn(async () => {
      // 并发成功事件在 grounding 调用窗口内提交（与本投递探测交错）。
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

    const rows = await db.select().from(question).where(eq(question.id, qid));
    expect(rows[0].draft_status).toBe('active');
    // 守卫未修前这里被 stale suspend 改写为 suspended+withheld —— 现在必须
    // 原样保留 admitted 维度（含 generation 不回涨）。
    const [lifecycle] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, qid));
    expect(lifecycle.scoring_admission_state).toBe('admitted');
    expect(lifecycle.suspended).toBe(false);
    expect(lifecycle.scoring_admission_generation).toBe(1);
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
});
