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

import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import { initialFsrsState } from '@/capabilities/practice/server/fsrs';
import { deriveSourceTier } from '@/core/schema/provenance';
import { WebSourcedProvenance } from '@/core/schema/provenance';
import type { Db } from '@/db/client';
import { event, knowledge, question } from '@/db/schema';
import { type TaskTextResult, aiAgentRef } from '@/server/ai/provenance';
import { writeEvent } from '@/server/events/queries';
import { getFsrsState, upsertFsrsState } from '@/server/fsrs/state';
import {
  type SolveCheckQuestion,
  type SolveCheckResult,
  type VerifyCheck,
  checksForTier,
  runSolveCheck,
} from '@/server/quiz/verify-framework';
import { resolveSubjectProfile } from '@/subjects/profile';
import { type VerifyFailureClass, maxNgramOverlap } from './quiz_verify';

export interface SourceVerifyJobData {
  question_ids: string[];
}

// Loose run seam (mirrors quiz_verify): the handler + solve-check only consume
// { text, task_run_id?, cost_usd? }. DB tests inject a vi.fn() returning a JSON
// string; production resolves runTask lazily.
export type RunTaskFn = (kind: string, input: unknown, ctx: unknown) => Promise<TaskTextResult>;

type DepsOverride = {
  runTaskFn?: RunTaskFn;
};

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<TaskTextResult> {
  const { runTask } = await import('@/server/ai/runner');
  return runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
}

// Dedup threshold: a sourced question whose prompt n-gram overlap with an existing
// ACTIVE pool question (sharing a knowledge point) is at/above this is treated as a
// near-duplicate. Reuses quiz_verify's deterministic maxNgramOverlap (word-shingle
// Jaccard, CJK-aware). CONSERVATIVE start, tunable.
export const DEDUP_OVERLAP_THRESHOLD = 0.7;

export interface CheckOutcome {
  check: VerifyCheck;
  // pass = the check is satisfied; fail = a hard problem; unsupported = no signal
  // (treated as non-blocking — conservative, mirrors solve-check semantics).
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
        // draft_status IS NULL OR <> 'draft' — legacy active rows carry NULL
        // draft_status (due-list.ts:216 precedent); a bare ne() would drop them.
        or(isNull(question.draft_status), ne(question.draft_status, 'draft')),
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

/**
 * Verify a single sourced draft question against the tier-2 check set. Idempotent
 * per (question_id) via the chained verify event guard. Promotes draft→active +
 * FSRS-enrolls when every check passes (no check is 'fail').
 */
export async function runSourceVerify(
  params: RunSourceVerifyParams,
): Promise<RunSourceVerifyResult> {
  const { db, questionId, runTaskFn } = params;

  const rows = await db.select().from(question).where(eq(question.id, questionId)).limit(1);
  const row = rows[0];
  if (!row) return { status: 'skipped:not_found' };
  if (row.source !== 'web_sourced') return { status: 'skipped:not_web_sourced' };

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
      };
      const solveResult = await runSolveCheck(solveQuestion, {
        runTaskFn,
        profile: { id: subjectProfile.id, full: subjectProfile },
        db,
      });
      checks.push(solveCheckToOutcome(solveResult));
    }

    // Option B gate: promote ONLY when no check is 'fail' AND every referenced
    // knowledge point is still alive (F3). 'unsupported' (no signal) is non-blocking —
    // conservative, so a question the solver couldn't independently solve is not killed
    // (R2). A hard structural / consistency / dedup / solve fail — or an archived
    // knowledge point — keeps the draft out of the pool.
    const promote = knowledgeAlive && !checks.some((c) => c.verdict === 'fail');

    // solve_check owns its AI run inside runSolveCheck, so this handler holds no
    // single TaskTextResult; the verify event carries the per-check verdicts as its
    // audit trail instead of a task_run_id.
    const now = new Date();
    const verifyEventId = createId();
    const verifiedBy = aiAgentRef('SourceVerify', { text: '' });

    await db.transaction(async (tx) => {
      if (promote) {
        await tx
          .update(question)
          .set({ draft_status: 'active', updated_at: now })
          .where(eq(question.id, questionId));

        // FSRS enroll-if-absent per knowledge point (identical convention to
        // quiz_verify): materialize an initial card only for knowledge points with no
        // existing projection; never reset an existing schedule.
        const initial = initialFsrsState(now);
        const fsrsSubjectIds = Array.from(new Set(row.knowledge_ids ?? []));
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
          // YUK-350 (L3, RL5) — additive: a tier-2 verify that did NOT promote is a
          // validation failure (a hard check failed or a knowledge point was archived),
          // distinct from the catch-bottom 'system_error'. Key absent on promote=true.
          ...(promote ? {} : { failure_class: 'validation_failure' satisfies VerifyFailureClass }),
          verified_by: verifiedBy,
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
    // gate), so reaching this catch guarantees the question was never promoted. This
    // handler has no `overall` field (tier-2 verdict is the per-check array), so there
    // is no symmetric result-layer 'error' value to assign — outcome='error' alone
    // carries the system-error class on the event.
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
          // YUK-350 (L3, RL5) — event-layer system-error class. Additive key on the
          // error path only; outcome + idempotency guard unchanged.
          failure_class: 'system_error' satisfies VerifyFailureClass,
          error: String((err as Error).message ?? err),
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
  const runTaskFn = deps.runTaskFn ?? defaultRunTaskFn;
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
