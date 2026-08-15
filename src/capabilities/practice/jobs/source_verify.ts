// YUK-216 S2 slice 2 (题源扩展 Strategy D) — tier-2 source_verify handler.
//
// docs/superpowers/specs/2026-06-05-question-source-expansion-design.md §4
// docs/superpowers/plans/2026-06-05-yuk216-question-source-s2.md §3 (step 2.7/2.8).
//
// Chained behind sourcing (the sourcing handler sends `source_verify`
// { question_ids } after writing draft questions, mirroring quiz_gen → quiz_verify).
// For each draft web_sourced question this handler runs the TIER-2 check set defined
// in verify-framework.ts (CHECK_SETS_BY_TIER[2] = structure_completeness +
// source_consistency + solve_check + dedup) and gates Option B:
//   pass (every check passes)   → promote draft_status 'draft'→'active' + FSRS enroll
//                                  (the question enters the review pool).
//   fail                        → leave draft_status='draft' (never reaches the pool).
//
// Skeleton copied from quiz_verify.ts (claim → idempotency → run → persist →
// writeEvent → catch). The checks here are mostly DETERMINISTIC (structure / source
// consistency / dedup); only solve_check spends an LLM call (reusing
// SolutionGenerateTask as an independent solver via verify-framework's runSolveCheck).
// This片 keeps the verify handler thin per plan §2.4 — kind_conformance (skill-driven)
// arrives in slice 4.
//
// R4 (YUK-554 review) — tier2 vetoes EVERY solve_check fail (including normalize) BY DESIGN,
// unlike tier3/4's per-axis split in quiz_verify.ts: tier2 references are anchored on real web
// extracts, tier3/4's are same-model self-authored. See the solveCheckBlocks docblock in
// verify-framework.ts for the full asymmetry rationale before "unifying" the two.

import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import { readDifficultyEvidenceFromMetadata } from '@/core/schema/difficulty-evidence';
import { deriveSourceTier } from '@/core/schema/provenance';
import { WebSourcedProvenance } from '@/core/schema/provenance';
import { toUnifiedVerifyResult } from '@/core/schema/verify-contract';
import type { Db } from '@/db/client';
import { notDraftPredicate } from '@/db/predicates';
import { event, knowledge, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { acquireLearningStateWriteLock } from '@/server/advisory-locks';
import {
  type RunSourceGroundingVerifyParams,
  type SourceGroundingVerifyResult,
  runSourceGroundingVerify,
} from '@/server/ai/judges/source-grounding-verify';
import { type TaskTextResult, type TaskTextRunFn, aiAgentRef } from '@/server/ai/provenance';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import { getFsrsState, upsertFsrsState } from '@/server/fsrs/state';
import { type SubjectProfile, resolveSubjectProfile } from '@/subjects/profile';
import { initialFsrsState } from '../server/fsrs';
import { SupplyTraceV1 } from '../server/question-supply/evidence-demand';
import { lockPlacementSupplyScopes } from '../server/question-supply/placement-supply-lock';
import {
  type SolveCheckImageFetchFn,
  type SolveCheckQuestion,
  type SolveCheckResult,
  type VerifyCheck,
  checksForTier,
  runSolveCheck,
} from '../server/quiz/verify-framework';
import { maxNgramOverlap } from './quiz_verify';

export interface SourceVerifyJobData {
  question_ids: string[];
}

// Loose run seam (mirrors quiz_verify): the handler + solve-check only consume
// { text, task_run_id?, cost_usd? }. DB tests inject a vi.fn() returning a JSON
// string; production resolves runTask lazily.
export type RunTaskFn = TaskTextRunFn;

type DepsOverride = {
  runTaskFn?: RunTaskFn;
};

// Dedup threshold: a sourced question whose prompt n-gram overlap with an existing
// ACTIVE pool question (sharing a knowledge point) is at/above this is treated as a
// near-duplicate. Reuses quiz_verify's deterministic maxNgramOverlap (word-shingle
// Jaccard, CJK-aware). CONSERVATIVE start, tunable.
export const DEDUP_OVERLAP_THRESHOLD = 0.7;

export interface CheckOutcome {
  check: VerifyCheck;
  // pass = the check is satisfied; fail = a hard problem; unsupported = no signal
  // (normally non-blocking; an unresolved exact mismatch is held in tier 2).
  verdict: 'pass' | 'fail' | 'unsupported';
  reason: string;
}

export type SourceVerifyPerQuestionStatus =
  | 'verified'
  | 'failed'
  | 'skipped:not_found'
  | 'skipped:not_web_sourced'
  | 'skipped:already_verified';

export interface RunSourceVerifyParams {
  db: Db;
  questionId: string;
  runTaskFn: RunTaskFn;
  imageFetchFn?: SolveCheckImageFetchFn;
  // YUK-230 — source-grounding re-check seam (single_source_grounding rows only). DB tests
  // inject a stub to drive grounded / not_grounded / transient without real R2 / VLM spend;
  // production defaults to runSourceGroundingVerify (→ SourceGroundingVerifyTask).
  sourceGroundingFn?: SourceGroundingFn;
}

export interface RunSourceVerifyResult {
  status: SourceVerifyPerQuestionStatus;
  checks?: CheckOutcome[];
}

// ---------- deterministic checks ----------

type QuestionRow = typeof question.$inferSelect;

// structure_completeness — the row carries the fields its kind requires. Only
// `choice` requires ≥2 options; every kind needs a non-empty prompt + reference
// answer. true_false is INTENTIONALLY exempt: the repo's existing 判断题 form is
// kind='true_false' + reference_md carrying 真/假 with NO choices_md (practice/paper
// fixtures share this shape, and judge routing dispatches true_false straight to
// exact). Forcing ≥2 choices onto sourced true_false rows would strand every
// option-less 判断题 in draft forever (F1).
function checkStructureCompleteness(row: QuestionRow): CheckOutcome {
  const problems: string[] = [];
  if (!row.prompt_md || row.prompt_md.trim().length === 0) problems.push('empty prompt_md');
  if (!row.reference_md || row.reference_md.trim().length === 0) {
    problems.push('empty reference_md');
  }
  if (row.kind === 'choice' && (row.choices_md ?? []).length < 2) {
    problems.push('choice question has <2 choices');
  }
  return problems.length === 0
    ? { check: 'structure_completeness', verdict: 'pass', reason: 'all required fields present' }
    : { check: 'structure_completeness', verdict: 'fail', reason: problems.join('; ') };
}

// Minimum deterministic overlap between a sourced question's prompt+reference and the
// extract the agent reported lifting from the declared source page. BELOW this, the
// stored content does not support the declared provenance (mis-extraction or a
// fabricated/guessed URL) and source_consistency fails. This is the INVERSE direction
// of quiz_verify's copy_safety (which fails on HIGH overlap to catch plagiarism):
// here a sourced question SHOULD closely echo its real source. Reuses the same
// deterministic word-shingle overlap (maxNgramOverlap, CJK-aware). CONSERVATIVE start
// — the gate only fires when an extract is present AND clearly fails to ground the
// question, so genuine restructuring (paraphrase) is not punished. Tunable.
export const SOURCE_GROUNDING_MIN_OVERLAP = 0.15;

// source_consistency — the row's declared source matches its persisted provenance:
// deriveSourceTier lands tier 2, the web_sourced block parses, source_ref is present
// and equals the provenance URL, AND (when the agent persisted an extract) the
// prompt+reference deterministically overlap that extract. A web_sourced row that
// does NOT derive tier 2, omits source_ref, or whose stored content does not ground
// the declared source page is rejected. The overlap is DETERMINISTIC over the
// PERSISTED extract — verify never refetches the network (mirrors the quiz_gen
// source_pack snippet → quiz_verify maxNgramOverlap precedent; spec §4).
function checkSourceConsistency(row: QuestionRow): CheckOutcome {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  // F2: extract is the deterministic grounding anchor. A web_sourced row without a
  // non-empty extract cannot derive tier 2 (WebSourcedProvenance now requires it), so
  // the generic tier check below already rejects it — but check it FIRST so the audit
  // reason names extract precisely rather than the opaque "missing or malformed".
  const rawWebSourced = (metadata.web_sourced ?? {}) as Record<string, unknown>;
  const rawExtract = rawWebSourced.extract;
  if (typeof rawExtract !== 'string' || rawExtract.trim().length === 0) {
    return {
      check: 'source_consistency',
      verdict: 'fail',
      reason:
        'web_sourced row has no extract; the declared source cannot be deterministically grounded (fabricated/unanchored URL risk)',
    };
  }
  const { tier } = deriveSourceTier({ source: row.source, metadata });
  if (tier !== 2) {
    return {
      check: 'source_consistency',
      verdict: 'fail',
      reason: `web_sourced row does not derive tier 2 (got tier ${tier}); provenance is missing or malformed`,
    };
  }
  const parsed = WebSourcedProvenance.safeParse(metadata.web_sourced);
  if (!parsed.success) {
    return {
      check: 'source_consistency',
      verdict: 'fail',
      reason: `metadata.web_sourced failed provenance parse: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }
  // A web_sourced question with no source_ref has incomplete provenance — the column
  // is supposed to carry the fetched URL (合约三). Missing → fail (CR), not pass.
  if (!row.source_ref) {
    return {
      check: 'source_consistency',
      verdict: 'fail',
      reason: 'source_ref is missing for web_sourced question',
    };
  }
  if (row.source_ref !== parsed.data.url) {
    return {
      check: 'source_consistency',
      verdict: 'fail',
      reason: `source_ref (${row.source_ref}) disagrees with provenance url (${parsed.data.url})`,
    };
  }
  // Deterministic content grounding (F2). extract is guaranteed non-empty here (the
  // top-of-function guard + the required WebSourcedProvenance.extract contract). The
  // question's prompt+reference must overlap it — a mis-extracted or fabricated source
  // carries an extract that does not echo the question → fail.
  const extract = parsed.data.extract;
  const questionText = `${row.prompt_md}\n${row.reference_md}`;
  const overlap = maxNgramOverlap(questionText, [extract]);
  if (overlap < SOURCE_GROUNDING_MIN_OVERLAP) {
    return {
      check: 'source_consistency',
      verdict: 'fail',
      reason: `question content does not ground its declared source (overlap ${overlap.toFixed(2)} < ${SOURCE_GROUNDING_MIN_OVERLAP}); extract may be mis-attributed or fabricated`,
    };
  }
  return {
    check: 'source_consistency',
    verdict: 'pass',
    reason: `tier 2 sourced provenance consistent + content grounded (url ${parsed.data.url}, overlap ${overlap.toFixed(2)})`,
  };
}

// dedup — not a near-duplicate of an existing ACTIVE pool question sharing one of
// this question's knowledge points. Deterministic n-gram overlap (reused from
// quiz_verify). No candidates / no knowledge ids → no signal → pass.
async function checkDedup(db: Db, row: QuestionRow): Promise<CheckOutcome> {
  const knowledgeIds = row.knowledge_ids ?? [];
  if (knowledgeIds.length === 0) {
    return { check: 'dedup', verdict: 'pass', reason: 'no knowledge_ids — dedup not applicable' };
  }
  // Pull existing ACTIVE pool questions that share ANY knowledge point. Mirrors
  // due-list's `knowledge_ids @> [id]::jsonb` containment precedent (due-list.ts:215),
  // OR'd per id for ANY-overlap. Exclude the row itself + drafts. LIMIT keeps the
  // comparison bounded.
  const overlapClauses = knowledgeIds.map(
    (kid) => sql`${question.knowledge_ids} @> ${JSON.stringify([kid])}::jsonb`,
  );
  const candidates = await db
    .select({ id: question.id, prompt_md: question.prompt_md })
    .from(question)
    .where(
      and(
        ne(question.id, row.id),
        // Pool-visibility (红线-4, NULL≡active; legacy active rows carry NULL — a bare
        // ne() would drop them). Shared notDraftPredicate (@/db/predicates).
        notDraftPredicate(question.draft_status),
        or(...overlapClauses),
      ),
    )
    .limit(50);
  if (candidates.length === 0) {
    return { check: 'dedup', verdict: 'pass', reason: 'no existing pool question to compare' };
  }
  let maxOverlap = 0;
  let nearestId = '';
  for (const c of candidates) {
    const overlap = maxNgramOverlap(row.prompt_md, [c.prompt_md]);
    if (overlap > maxOverlap) {
      maxOverlap = overlap;
      nearestId = c.id;
    }
  }
  if (maxOverlap >= DEDUP_OVERLAP_THRESHOLD) {
    return {
      check: 'dedup',
      verdict: 'fail',
      reason: `near-duplicate of pool question ${nearestId} (overlap ${maxOverlap.toFixed(2)} >= ${DEDUP_OVERLAP_THRESHOLD})`,
    };
  }
  return {
    check: 'dedup',
    verdict: 'pass',
    reason: `max overlap ${maxOverlap.toFixed(2)} below dedup threshold`,
  };
}

function solveCheckToOutcome(result: SolveCheckResult): CheckOutcome {
  // verify-framework's solve-check is conservative: 'unsupported' carries no signal.
  // Map its verdict onto the verify outcome — only a confident 'fail' blocks promotion.
  return {
    check: 'solve_check',
    verdict:
      result.verdict === 'fail' ? 'fail' : result.verdict === 'pass' ? 'pass' : 'unsupported',
    reason: result.reason,
  };
}

// ---------- YUK-230 source-grounding gate (single_source_grounding rows) ----------
//
// image_candidate accept (src/capabilities/ingestion/server/image-candidate-accept.ts)
// materializes a web_sourced draft whose deterministic `source_consistency` n-gram check
// is GROUNDING-AGAINST-SELF: the stored `extract` is the SAME single VLM call's own
// output, so the overlap passes (near-)trivially. Those rows carry
// metadata.single_source_grounding=true + the source image's asset id
// (metadata.image_candidate_source_asset_id). For them source_verify runs ONE paid
// vision re-check — re-read the source image + ask「题面是否真在图里」 — via the dedicated
// SourceGroundingVerifyTask (runSourceGroundingVerify). This is a GROUNDING-presence
// check, NOT answer judging: the earlier draft fed reference_md as a "student answer" to
// the multimodal_direct answer judge, which could not catch a VLM that hallucinated a
// self-consistent 题面 + 答案 unrelated to the image (PR #1063 review, thread 2).
//
// Owner 2026-07-23 决策清单② — accept = 授权自动复核一次; 复核失败 = 打回 draft（不入池）.
//
// Semantics matrix (runSourceGroundingVerify → SourceGroundingVerifyResult.status):
//   'not_grounded'    → 题面 not in the source image → grounding FAIL → demote to draft
//   'grounded'        → grounding PASS
//   'transient_error' → image fetch / LLM call / output parse failed — NOT a content
//     verdict. FAIL-CLOSED: demote the (pre-promoted active) single-source row to draft
//     FIRST, then throw so the catch-bottom writes a retriable outcome='error' event and
//     pg-boss re-runs (既有 verify 错误惯例); a later 'grounded' re-check re-promotes it.
//     Without the fail-closed demote the row would stay pool-selectable during the retry
//     window, bypassing this gate (PR #1063 review, thread 1). It is NEVER conflated with
//     「题面不在图里」. The demote is scoped to THIS single-source row only.
//
// The runner's runTask writes its own ai_task_runs + cost_ledger row (real spend,
// auditable); the verify event records the verdict + triggered_by='image_candidate_accept'
// (the accept-authorization extension).

// Fix-forward #1063 (PRRT…TotCQ) — derive the seam's params from the runner's own
// param interface (minus the runner-internal injectable seams) instead of re-declaring
// the core fields. runSourceGroundingVerify (whose extra params are optional) stays
// assignable to SourceGroundingFn.
export type SourceGroundingParams = Omit<
  RunSourceGroundingVerifyParams,
  'runTaskFn' | 'imageFetchFn'
>;
export type SourceGroundingFn = (
  params: SourceGroundingParams,
) => Promise<SourceGroundingVerifyResult>;

/**
 * Verify a single sourced draft question against the tier-2 check set. Idempotent
 * per (question_id) via the chained verify event guard. Promotes draft→active +
 * FSRS-enrolls when there is no hard fail or unresolved anchored exact mismatch.
 */
export async function runSourceVerify(
  params: RunSourceVerifyParams,
): Promise<RunSourceVerifyResult> {
  const { db, questionId, runTaskFn } = params;

  const rows = await db.select().from(question).where(eq(question.id, questionId)).limit(1);
  const row = rows[0];
  if (!row) return { status: 'skipped:not_found' };
  if (row.source !== 'web_sourced') return { status: 'skipped:not_web_sourced' };
  const metadataRaw =
    row.metadata && typeof row.metadata === 'object'
      ? (row.metadata as Record<string, unknown>)
      : {};
  // supply_trace is best-effort provenance carried onto the verify event, not a
  // promotion input. A JSONB `null` (valid, distinct from absent) or a malformed
  // value must NOT throw here — this runs BEFORE the failure-bottom try, so a throw
  // would strand the draft with no error event and retry identically forever. Mirror
  // readDifficultyEvidenceFromMetadata: safeParse and drop on any failure.
  const supplyTraceResult = SupplyTraceV1.safeParse(metadataRaw.supply_trace);
  const supplyTrace = supplyTraceResult.success ? supplyTraceResult.data : undefined;
  const difficultyEvidence = readDifficultyEvidenceFromMetadata(metadataRaw);

  // Idempotency: only a TERMINAL verify event short-circuits a re-run (outcome !=
  // 'error'). The catch-bottom writes a TRANSIENT-error event with outcome='error'
  // so a one-off LLM/DB blowup doesn't strand the draft (mirrors quiz_verify).
  const existingVerify = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:source_verify'),
        eq(event.subject_kind, 'question'),
        eq(event.subject_id, questionId),
        ne(event.outcome, 'error'),
      ),
    )
    .limit(1);
  if (existingVerify.length > 0) return { status: 'skipped:already_verified' };

  // Resolve subject profile from the first knowledge node (same convention as
  // quiz_gen / quiz_verify).
  const firstKnowledgeId = row.knowledge_ids[0];
  const knowledgeRows = firstKnowledgeId
    ? await db
        .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
        .from(knowledge)
        .where(eq(knowledge.id, firstKnowledgeId))
        .limit(1)
    : [];
  const knowledgeNode = knowledgeRows[0] ?? null;
  const subjectProfile = resolveSubjectProfile(knowledgeNode?.domain ?? null);

  // F3 (PR #313) — knowledge survival re-check BEFORE promotion. A draft can sit
  // between sourcing and verify long enough for its knowledge point to be archived;
  // promoting it anyway enrolls FSRS cards onto a dead node (the same archived guard
  // sourcing.ts:resolveTrigger applies at INGEST time must also gate at PROMOTE time).
  // We re-query the row's knowledge_ids against live (archived_at IS NULL) nodes; if
  // ANY referenced knowledge point is archived (or no longer exists), the draft does
  // not promote and is not enrolled. The gate folds into the promote decision below
  // and is recorded on the verify event (knowledge_archived reason) rather than the
  // tier-2 checks[] array, which is typed to the formal VerifyCheck set.
  const referencedKnowledgeIds = Array.from(new Set(row.knowledge_ids ?? []));
  const liveKnowledgeRows = referencedKnowledgeIds.length
    ? await db
        .select({ id: knowledge.id })
        .from(knowledge)
        .where(and(inArray(knowledge.id, referencedKnowledgeIds), isNull(knowledge.archived_at)))
    : [];
  const liveKnowledgeIds = new Set(liveKnowledgeRows.map((r) => r.id));
  const archivedKnowledgeIds = referencedKnowledgeIds.filter((id) => !liveKnowledgeIds.has(id));
  const knowledgeAlive = archivedKnowledgeIds.length === 0;

  try {
    // Run the tier-2 check set (CHECK_SETS_BY_TIER[2]). structure_completeness +
    // source_consistency + dedup are deterministic; solve_check spends the LLM call.
    const tierChecks = checksForTier(2);
    const checks: CheckOutcome[] = [];
    let unresolvedAnchoredExactMismatch = false;
    let imageInputUnavailable = false;

    if (tierChecks.includes('structure_completeness')) {
      checks.push(checkStructureCompleteness(row));
    }
    if (tierChecks.includes('source_consistency')) {
      checks.push(checkSourceConsistency(row));
    }
    if (tierChecks.includes('dedup')) {
      checks.push(await checkDedup(db, row));
    }
    if (tierChecks.includes('solve_check')) {
      const solveQuestion: SolveCheckQuestion = {
        id: row.id,
        kind: row.kind,
        prompt_md: row.prompt_md,
        reference_md: row.reference_md,
        choices_md: row.choices_md,
        judge_kind_override: row.judge_kind_override,
        rubric_json: row.rubric_json,
        knowledge_ids: row.knowledge_ids,
        metadata: (row.metadata ?? null) as Record<string, unknown> | null,
        image_refs: row.image_refs,
        figures: row.figures,
      };
      const solveResult = await runSolveCheck(solveQuestion, {
        runTaskFn,
        profile: { id: subjectProfile.id, full: subjectProfile },
        db,
        imageFetchFn: params.imageFetchFn,
      });
      unresolvedAnchoredExactMismatch =
        solveResult.verdict === 'unsupported' && solveResult.normalized_exact_mismatch === true;
      imageInputUnavailable = solveResult.image_input_unavailable === true;
      checks.push(solveCheckToOutcome(solveResult));
    }

    // `otherwisePromotable` is the tier-2 promote decision BEFORE the source-grounding gate:
    // knowledge survived, no unresolved exact mismatch, image input available, no failing
    // check. It is the SINGLE source for both the grounding-gate trigger below AND the final
    // `promote` (which just ANDs in the grounding verdict) — PR #1063 review thread 3 (was
    // two copy-pasted condition lists).
    const otherwisePromotable =
      knowledgeAlive &&
      !unresolvedAnchoredExactMismatch &&
      !imageInputUnavailable &&
      !checks.some((c) => c.verdict === 'fail');

    // ---- YUK-230 source-grounding gate (single_source_grounding rows only) ----
    // Runs ONLY when the row is otherwise promotable: a deterministic/solve fail already
    // keeps it draft, so spending the paid vision re-check on a doomed draft is wasted. For
    // a single-source row this is the FINAL, real grounding gate — its source_consistency
    // n-gram is grounding-against-self (extract === the same VLM call's output). See the
    // SourceGroundingParams docblock for the full semantics matrix.
    const singleSourceGrounding = metadataRaw.single_source_grounding === true;
    const groundingSourceAssetId =
      typeof metadataRaw.image_candidate_source_asset_id === 'string'
        ? metadataRaw.image_candidate_source_asset_id
        : null;
    let multimodalGroundingFailed = false;
    let groundingRan = false;
    let groundingSummary: string | undefined;
    let groundingConfidence: number | undefined;
    // Defense-in-depth (fix-forward #1063 PRRT…TotCO): a row that CLAIMS
    // single_source_grounding but carries NO image_candidate_source_asset_id cannot be
    // grounded — the previous `&& groundingSourceAssetId` gate silently SKIPPED such a row
    // and let it promote. Fail CLOSED instead: mark a source_grounding fail (→ overall=fail
    // → the pre-promoted row is demoted out of the pool) and log for diagnosis. Runs only
    // when otherwise-promotable (a row already failing another check needs no extra fail).
    if (singleSourceGrounding && otherwisePromotable && !groundingSourceAssetId) {
      console.warn(
        `[source_verify] ${questionId} is single_source_grounding but has no image_candidate_source_asset_id; failing grounding closed`,
      );
      groundingRan = true;
      multimodalGroundingFailed = true;
      groundingSummary =
        'single_source_grounding row is missing image_candidate_source_asset_id; grounding could not be verified';
      checks.push({ check: 'source_grounding', verdict: 'fail', reason: groundingSummary });
    }
    if (singleSourceGrounding && groundingSourceAssetId && otherwisePromotable) {
      const groundingFn = params.sourceGroundingFn ?? runSourceGroundingVerify;
      let outcome: SourceGroundingVerifyResult;
      try {
        outcome = await groundingFn({
          db,
          prompt_md: row.prompt_md,
          reference_md: row.reference_md,
          sourceAssetId: groundingSourceAssetId,
          subjectProfile,
        });
      } catch (err) {
        // PR #1063 review thread 1 — a BARE throw from the grounding fn (a bug, or a future
        // change that stops returning the discriminated result) must NOT bypass fail-closed.
        // Fold it into the SAME transient_error branch (demote → throw) as a returned
        // transient_error, so an unexpected throw can never silently leave a pre-promoted row
        // in the pool.
        outcome = {
          status: 'transient_error',
          message: err instanceof Error ? err.message : String(err),
        };
      }
      if (outcome.status === 'transient_error') {
        // TRANSIENT image-fetch / VLM / parse failure (or a bare throw, above) — NOT a content
        // verdict. FAIL-CLOSED (thread 1): the row was pre-promoted 'active', and throwing to
        // retry would otherwise leave it pool-selectable during the retry window, bypassing
        // this gate. Demote it to 'draft' FIRST — a bare UPDATE scoped to THIS single-source
        // row, committed independently of the throwing verify tx so it survives the throw —
        // then throw so the catch-bottom writes the retriable outcome='error' event and
        // pg-boss re-runs; a later 'grounded' re-check re-promotes it. Scope is limited to this
        // single_source_grounding row: no other verify error semantics change.
        //
        // OVERLAPPING-DELIVERY GUARD (thread 2, codex): pg-boss can have TWO deliveries of the
        // same question in flight (this run passed the top idempotency check before a
        // concurrent run committed). If that concurrent run has SINCE terminally verified +
        // promoted this question (a source_verify outcome='success' event now exists), it owns
        // the row's 'active' state — this stale run must NOT yank it back out. The NOT EXISTS
        // subquery makes the check atomic with the demote (no check-then-act TOCTOU): the
        // UPDATE demotes ONLY when no success verify event exists.
        //
        // VERSION GUARD (thread 2 round-2, codex): mirror the normal promote/demote branch's
        // `current.version !== row.version` staleness check. This run's grounding verdict was
        // computed against `row.version`; if the question was EDITED (version bumped) during the
        // VLM call, this delivery is stale and must NOT act on the newer row — pin the demote to
        // `version = row.version` so a bumped row is untouched (this run then throws and is
        // re-run against the fresh version). Without it, a stale delivery could yank a freshly
        // re-verified newer version out of the pool.
        await db
          .update(question)
          .set({ draft_status: 'draft', updated_at: new Date() })
          .where(
            and(
              eq(question.id, questionId),
              eq(question.draft_status, 'active'),
              eq(question.version, row.version),
              sql`NOT EXISTS (SELECT 1 FROM ${event} WHERE ${event.action} = 'experimental:source_verify' AND ${event.subject_kind} = 'question' AND ${event.subject_id} = ${questionId} AND ${event.outcome} = 'success')`,
            ),
          );
        throw new Error(
          `source_verify source grounding failed (transient) for ${questionId}: ${outcome.message}`,
        );
      }
      groundingRan = true;
      groundingConfidence = outcome.confidence;
      groundingSummary = outcome.reason_md;
      multimodalGroundingFailed = outcome.status === 'not_grounded';
      // PR #1063 review thread 3 — push the grounding verdict as a real check so
      // toUnifiedVerifyResult's roll-up sees a failing check and yields overall='fail'
      // (previously grounding fail lived only in `promote` + the summary, so a not_grounded
      // row projected overall='needs_review' while its summary said "failed" — a mismatch).
      checks.push({
        check: 'source_grounding',
        verdict: multimodalGroundingFailed ? 'fail' : 'pass',
        reason: outcome.reason_md,
      });
    }

    // Option B gate: ordinary unsupported remains non-blocking (R2), but when an
    // exact solver/reference mismatch survives because SemanticJudge was unavailable
    // or still disagreed below threshold, a web-sourced answer is not safe to auto-
    // promote. Keep it draft for review without relabelling the mismatch as a fail.
    // YUK-230 — a single-source grounding FAIL (题面 not confirmed in the source image)
    // also blocks promotion → the !promote demote path returns the pre-promoted cold-start
    // draft to draft_status='draft' (not into the pool).
    const promote = otherwisePromotable && !multimodalGroundingFailed;

    // solve_check owns its AI run inside runSolveCheck, so this handler holds no
    // single TaskTextResult; the verify event carries the per-check verdicts as its
    // audit trail instead of a task_run_id.
    const now = new Date();
    const verifyEventId = createId();
    const verifiedBy = aiAgentRef('SourceVerify', { text: '' });

    // YUK-350 (B5 increment C) — project the tier-2 per-check array onto the unified
    // verify contract shape. PROVABLY-EQUIVALENT: `promote` is passed IN (already decided
    // above as `knowledgeAlive && no failing check`); the helper only PROJECTS it and
    // ROLLS the per-check array up into an `overall` source-verify previously LACKED
    // (any failing check ⇒ fail, else promote ⇒ pass / not-promoted-without-fail ⇒
    // needs_review). The promote predicate is unchanged. The summary names the failing
    // check (or the knowledge-archived gate), giving draft-review.ts a驳回理由 it never
    // had for tier-2 drafts before. SUPERSET: the existing payload keys below are kept.
    // YUK-230 (thread 3) — grounding fail is now a failing check in `checks[]`, so the generic
    // `failingCheck` branch names it (`source_grounding — <reason_md>`); no separate grounding
    // summary branch is needed, and toUnifiedVerifyResult's roll-up sees the failing check.
    const failingCheck = checks.find((c) => c.verdict === 'fail');
    const sourceSummaryMd = promote
      ? 'tier-2 source verify passed'
      : failingCheck
        ? `tier-2 source verify failed: ${failingCheck.check} — ${failingCheck.reason}`
        : unresolvedAnchoredExactMismatch
          ? 'tier-2 source verify needs review: exact answer mismatch remained unresolved'
          : imageInputUnavailable
            ? 'tier-2 source verify needs review: prompt image content was unavailable'
            : !knowledgeAlive
              ? 'referenced knowledge point archived after sourcing; not promoted'
              : 'tier-2 source verify did not promote';
    const unified = toUnifiedVerifyResult({
      source: 'source',
      promote,
      summary_md: sourceSummaryMd,
      // tier-2 checks are deterministic (or conservative solve-check); the handler has no
      // calibrated scalar confidence, so report a flat 1 on a verdict and let the axes /
      // overall carry the signal (mirrors the pre-existing absence of a confidence field).
      confidence: 1,
      checks: checks.map((c) => ({ check: c.check, verdict: c.verdict, reason: c.reason })),
    });

    let wasDemoted = false;
    await db.transaction(async (tx) => {
      // YUK-497 — global learning-state write lock FIRST (shared tx-entry order with every
      // material_fsrs_state / mastery_state writer and the cascade revert).
      await acquireLearningStateWriteLock(tx);
      // G→row lock order (YUK-452 review, codex P2): acquire the placement supply scope lock BEFORE
      // the question row lock, matching placement paid admission (advisory lock → plain SELECT) and
      // proposal-appliers. The prior order (row lock first, supply lock only inside the promote
      // branch) let a concurrent /placement/start observe this draft as still-cold while this tx
      // waited on the advisory lock, then promote after paid work was enqueued — a double-supply
      // race. Locking row.knowledge_ids (pre-tx snapshot) is safe: on attribution drift the version
      // guard below throws and pg-boss reruns against the fresh scope.
      await lockPlacementSupplyScopes(tx, row.knowledge_ids ?? []);
      // The checks above ran against `row.version`. Cross-KC reconciliation bumps that version
      // under the same row lock; a mismatch makes this verdict stale, so abort before writing a
      // terminal event/promotion. The catch records a retriable outcome='error' and pg-boss reruns
      // against the current KC set. If this lock wins first, the later reconciler observes active
      // lifecycle and enrolls its added KC atomically.
      const [current] = await tx
        .select({ version: question.version, knowledgeIds: question.knowledge_ids })
        .from(question)
        .where(eq(question.id, questionId))
        .limit(1)
        .for('update');
      if (!current || current.version !== row.version) {
        throw new Error(
          `source_verify question ${questionId} changed during verification (expected version ${row.version}, got ${current?.version ?? 'missing'})`,
        );
      }
      if (promote) {
        // Supply scope already locked at the top of this tx (G→row order above).
        await tx
          .update(question)
          .set({ draft_status: 'active', updated_at: now })
          .where(eq(question.id, questionId));

        // FSRS enroll-if-absent per knowledge point (identical convention to
        // quiz_verify): materialize an initial card only for knowledge points with no
        // existing projection; never reset an existing schedule.
        const initial = initialFsrsState(now);
        const fsrsSubjectIds = Array.from(new Set(current.knowledgeIds ?? []));
        if (fsrsSubjectIds.length > 0) {
          for (const knowledgeId of fsrsSubjectIds) {
            const existing = await getFsrsState(tx, 'knowledge', knowledgeId);
            if (existing) continue;
            await upsertFsrsState(tx, {
              subject_kind: 'knowledge',
              subject_id: knowledgeId,
              state: initial.state,
              due_at: initial.dueAt,
              last_review_event_id: verifyEventId,
            });
          }
        } else {
          const existing = await getFsrsState(tx, 'question', questionId);
          if (!existing) {
            await upsertFsrsState(tx, {
              subject_kind: 'question',
              subject_id: questionId,
              state: initial.state,
              due_at: initial.dueAt,
              last_review_event_id: verifyEventId,
            });
          }
        }
      } else {
        // ---- YUK-479 — auto-promote one-way gate fix: demote a pre-promoted draft on FAIL. ----
        // The cold-start image-upload path (image-candidate-accept.ts) PRE-PROMOTES a
        // structurally-sound draft to draft_status='active' (no inbox wall, YUK-478) BEFORE this
        // source_verify runs, relying on source_verify as the deeper grounding gate. Until now
        // source_verify had only a PROMOTE branch, so a FAIL left such a question 'active' →
        // unverified content stayed placement-selectable (the "one-way gate"). Demote it back to
        // 'draft' so a failed-verify cold-start question leaves the pool.
        //
        // SCOPED-BY-CONSTRUCTION (no marker column needed): the ONLY question that can be 'active'
        // when source_verify reaches this !promote branch is a cold-start pre-promote (the same
        // image_candidate-accept path that also carries single_source_grounding — so a YUK-230
        // grounding FAIL is one of the reasons a pre-promoted draft lands here). A normal
        // web_sourced draft (sourcing.ts) is 'draft' here → the WHERE draft_status='active' guard
        // makes the demote a no-op; an already-verified question is short-circuited by the
        // idempotency guard above (terminal verify event) and never reaches this branch;
        // verify-and-promote.ts gates draft_status='draft' before dispatching runSourceVerify. So
        // this UPDATE fires ONLY for the cold-start pre-promote case — a global no-op everywhere
        // else. No FSRS to clean: the pre-promote does not enroll FSRS (only the promote branch
        // above does, and it didn't run). draft_status='draft' is non-destructive pool-exclusion —
        // it stops FUTURE selection; any existing history is untouched. A later re-enqueue is
        // short-circuited by the failure verify event (idempotency), so the question stays out of
        // the pool until a human (verify-and-promote owner override) intervenes.
        const demotedRows = await tx
          .update(question)
          .set({ draft_status: 'draft', updated_at: now })
          .where(and(eq(question.id, questionId), eq(question.draft_status, 'active')))
          .returning({ id: question.id });
        wasDemoted = demotedRows.length > 0;
      }

      await writeEvent(tx, {
        id: verifyEventId,
        session_id: null,
        actor_kind: 'agent',
        actor_ref: 'source_verify',
        action: 'experimental:source_verify',
        subject_kind: 'question',
        subject_id: questionId,
        outcome: promote ? 'success' : 'failure',
        payload: {
          question_id: questionId,
          tier: 2,
          promoted: promote,
          // YUK-479 — true when this FAIL demoted a cold-start pre-promoted draft
          // (draft_status active→draft); false on a normal draft FAIL (no-op) and on promote.
          demoted: wasDemoted,
          // YUK-350 (B5 increment C) — unified verify contract shape (axes + overall +
          // failure_class? + summary_md + confidence). SUPERSET: the tier-2-specific keys
          // below (checks / knowledge_archived) stay unchanged. `unified.failure_class`
          // (validation_failure when !promote) reproduces the prior inline value
          // byte-identically; axes/overall/summary_md/confidence are additive — overall
          // fills the field source-verify previously lacked, giving draft-review.ts a
          // first-class verdict instead of inferring from outcome.
          ...unified,
          checks: checks.map((c) => ({ check: c.check, verdict: c.verdict, reason: c.reason })),
          // F3: record the knowledge-survival gate alongside the tier-2 checks. When a
          // referenced knowledge point was archived after sourcing, the draft is not
          // promoted/enrolled and this names the dead node(s) for the audit trail.
          ...(knowledgeAlive
            ? {}
            : {
                knowledge_archived: {
                  reason:
                    'referenced knowledge point archived after sourcing; not promoted/enrolled',
                  archived_knowledge_ids: archivedKnowledgeIds,
                },
              }),
          // YUK-230 — the source-grounding re-check verdict (single_source_grounding rows
          // only; absent otherwise). triggered_by records the accept-authorization extension
          // (owner 2026-07-23 决策清单②). The real VLM cost is on the runner's own ai_task_runs
          // + cost_ledger row (SourceGroundingVerifyTask); this is the audit trail on the
          // verify event (mirrored by the source_grounding entry in checks[]).
          ...(groundingRan
            ? {
                source_grounding: {
                  grounded: !multimodalGroundingFailed,
                  ...(groundingConfidence !== undefined ? { confidence: groundingConfidence } : {}),
                  ...(groundingSummary ? { summary_md: groundingSummary } : {}),
                  source_asset_id: groundingSourceAssetId,
                  triggered_by: 'image_candidate_accept',
                },
              }
            : {}),
          verified_by: verifiedBy,
          ...(difficultyEvidence ? { difficulty_evidence: difficultyEvidence } : {}),
          ...(supplyTrace ? { supply_trace: supplyTrace } : {}),
        },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
        created_at: now,
      });
    });

    return { status: promote ? 'verified' : 'failed', checks };
  } catch (err) {
    // failure-bottom: write a TRANSIENT-error event so pg-boss redelivery re-runs the
    // verify (idempotency guard treats outcome='error' as retriable). The draft stays
    // draft_status='draft' — the catch path NEVER promotes (mirrors quiz_verify).
    // YUK-350 (RL1) — error-safe: promotion happens only inside the try (post-LLM
    // gate), so reaching this catch guarantees the question was never promoted. The
    // unified system_error projection now ALSO gives tier-2 a symmetric result-layer
    // overall='error' (previously the handler emitted only failure_class); the
    // outcome='error' event is filtered out by every downstream consumer, so this is
    // purely additive. outcome + idempotency guard unchanged.
    try {
      await writeEvent(db, {
        id: createId(),
        session_id: null,
        actor_kind: 'agent',
        actor_ref: 'source_verify',
        action: 'experimental:source_verify',
        subject_kind: 'question',
        subject_id: questionId,
        outcome: 'error',
        payload: {
          question_id: questionId,
          // YUK-350 (B5 increment C) — unified verify contract shape via the system_error
          // projection: { axes:[], overall:'error', failure_class:'system_error',
          // summary_md, confidence:0 }. failure_class is byte-identical to the prior
          // inline; overall/axes/summary_md/confidence are additive.
          ...toUnifiedVerifyResult({
            source: 'system_error',
            summary_md: `source_verify failed: ${String((err as Error).message ?? err)}`,
            error: String((err as Error).message ?? err),
          }),
          error: String((err as Error).message ?? err),
          ...(difficultyEvidence ? { difficulty_evidence: difficultyEvidence } : {}),
          ...(supplyTrace ? { supply_trace: supplyTrace } : {}),
        },
        caused_by_event_id: null,
        // solve_check owns its own AI run inside runSolveCheck; this handler holds no
        // single TaskTextResult, so the transient-error event carries no run id/cost.
        task_run_id: null,
        cost_micro_usd: null,
        created_at: new Date(),
      });
    } catch (cleanupErr) {
      console.error('[source_verify] catch-block cleanup failed for', questionId, cleanupErr);
    }
    throw err;
  }
}

export function buildSourceVerifyHandler(
  db: Db,
  deps: DepsOverride = {},
): (jobs: Job<SourceVerifyJobData>[]) => Promise<void> {
  const runTaskFn = deps.runTaskFn ?? makeRunTaskFn(db);
  return async (jobs) => {
    for (const job of jobs) {
      const questionIds = job.data?.question_ids;
      if (!Array.isArray(questionIds) || questionIds.length === 0) {
        console.warn('[source_verify] job missing question_ids', job.id);
        continue;
      }
      for (const questionId of questionIds) {
        const result = await runSourceVerify({ db, questionId, runTaskFn });
        console.log(`[source_verify] ${questionId} -> ${result.status}`);
      }
    }
  };
}
