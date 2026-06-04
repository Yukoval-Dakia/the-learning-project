// Search-grounded QuizGen (T-SQ) — Q5 + Q6 handler.
//
// docs/superpowers/specs/2026-06-02-quizgen-search-grounded-design.md §1 / §3 / §5.
//
// Chained behind quiz_gen (Q3 enqueues `quiz_verify` { question_ids }, like
// ingestion → attribution_followup). For each draft question this handler:
//   1. idempotency guard — skip if a verify event already chains off the
//      question (action='experimental:quiz_verify', subject_kind='question',
//      subject_id) so pg-boss re-delivery is safe (mirrors variant_verify).
//   2. runs the single-shot CLOSED-BOOK QuizVerifyTask (§1: trusts the agent's
//      self-reported source_refs; no own Tavily loop this wave) — three checks:
//      fact/grounding vs source_refs, plagiarism/copy_safety, knowledge-hit.
//   3. computes a DETERMINISTIC normalized n-gram overlap(prompt_md, source_ref
//      snippets) and folds it into the persisted copy_safety verdict.
//   4. in a single transaction writes metadata.quiz_gen.verification (two-axis)
//      + writeEvent(action='experimental:quiz_verify', subject_kind='question').
//
// Gate = Option B (owner-confirmed §3):
//   pass (LLM overall='pass' AND copy_safety != 'too_close')
//     → promote draft_status 'draft'→'active' + Q6 FSRS enroll (materialize an
//       initial material_fsrs_state via the existing single-owner enroll path so
//       the question enters the review pool).
//   needs_review / fail / too_close
//     → leave draft_status='draft' (never reaches the pool) with
//       verification.status='needs_review'|'failed'.
//
// failure-bottom: catch → set verification.status='failed' (best-effort) → write
// a failure event → re-throw so pg-boss retries.
//
// Skeleton copied from variant_verify.ts (claim → idempotency → run → parse →
// single-txn persist → writeEvent → catch).

import { createId } from '@paralleldrive/cuid2';
import { and, eq, ne } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import {
  QuizGenMetadata,
  type QuizGenMetadataT,
  type QuizGenVerificationT,
  QuizVerificationResult,
  type QuizVerificationResultT,
} from '@/core/schema/quiz_gen';
import type { Db } from '@/db/client';
import { event, knowledge, question } from '@/db/schema';
import { type TaskTextResult, aiAgentRef, costUsdToMicroUsd } from '@/server/ai/provenance';
import { writeEvent } from '@/server/events/queries';
import { getFsrsState, upsertFsrsState } from '@/server/fsrs/state';
import { initialFsrsState } from '@/server/review/fsrs';
import { resolveSubjectProfile } from '@/subjects/profile';

export interface QuizVerifyJobData {
  question_ids: string[];
}

// Loose run seam (mirrors variant_verify): the handler only consumes
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
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return result;
}

function parseQuizVerifyOutput(text: string): QuizVerificationResultT {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseQuizVerifyOutput: no JSON object found in text');
  }
  let json: unknown;
  try {
    json = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new Error(`parseQuizVerifyOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  const parsed = QuizVerificationResult.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `parseQuizVerifyOutput: schema invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return parsed.data;
}

// §4 / §5 — deterministic normalized n-gram overlap. Word-shingle Jaccard between
// the prompt and each source snippet; we take the MAX over snippets (worst-case
// closeness). Returns 0 when there are no usable snippets (nothing to copy from →
// no deterministic signal; the LLM copy_safety verdict still applies). Tunable;
// CONSERVATIVE start. Language-agnostic: splits on whitespace + CJK characters so
// it degrades gracefully for both English and Chinese source material.
const COPY_SAFETY_NGRAM = 3;
export const COPY_SAFETY_TOO_CLOSE_THRESHOLD = 0.5;

function normalizeForOverlap(text: string): string[] {
  // Lowercase, strip punctuation to spaces, then tokenise. CJK has no spaces, so
  // we also split runs of CJK ideographs into per-character tokens to give the
  // shingler something to chew on.
  const cleaned = text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/([一-鿿])/gu, ' $1 ');
  return cleaned.split(/\s+/u).filter((t) => t.length > 0);
}

function shingles(tokens: string[], n: number): Set<string> {
  const out = new Set<string>();
  if (tokens.length < n) {
    // Too short for an n-gram — fall back to the whole token bag as a single
    // shingle so identical short strings still register as overlapping.
    if (tokens.length > 0) out.add(tokens.join(''));
    return out;
  }
  for (let i = 0; i + n <= tokens.length; i += 1) {
    out.add(tokens.slice(i, i + n).join(''));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function maxNgramOverlap(promptMd: string, snippets: string[]): number {
  const promptShingles = shingles(normalizeForOverlap(promptMd), COPY_SAFETY_NGRAM);
  if (promptShingles.size === 0) return 0;
  let max = 0;
  for (const snippet of snippets) {
    if (!snippet) continue;
    const snippetShingles = shingles(normalizeForOverlap(snippet), COPY_SAFETY_NGRAM);
    const score = jaccard(promptShingles, snippetShingles);
    if (score > max) max = score;
  }
  return max;
}

export type QuizVerifyPerQuestionStatus =
  | 'verified'
  | 'needs_review'
  | 'failed'
  | 'skipped:not_found'
  | 'skipped:not_quiz_gen'
  | 'skipped:already_verified';

export interface RunQuizVerifyParams {
  db: Db;
  questionId: string;
  runTaskFn: RunTaskFn;
}

export interface RunQuizVerifyResult {
  status: QuizVerifyPerQuestionStatus;
  overall?: QuizVerificationResultT['overall'];
  copy_safety_verdict?: QuizGenMetadataT['copy_safety']['verdict'];
}

/**
 * Verify a single quiz_gen draft question. Idempotent per (question_id) via the
 * chained verify event guard. Promotes draft→active + FSRS-enrolls on pass.
 */
export async function runQuizVerify(params: RunQuizVerifyParams): Promise<RunQuizVerifyResult> {
  const { db, questionId, runTaskFn } = params;

  const rows = await db.select().from(question).where(eq(question.id, questionId)).limit(1);
  const row = rows[0];
  if (!row) return { status: 'skipped:not_found' };
  if (row.source !== 'quiz_gen') return { status: 'skipped:not_quiz_gen' };

  // Idempotency: only a TERMINAL verify event short-circuits a re-run — i.e. the
  // QuizVerifyTask actually ran and produced a verdict (outcome success | partial |
  // failure). The catch-bottom writes a TRANSIENT-error event with outcome='error'
  // (LLM/parse/DB blew up before a verdict); that must NOT block pg-boss
  // redelivery, or a one-off error would strand the draft forever (the retry would
  // skip as `already_verified` and the draft stays failed/draft, contradicting the
  // "re-throw so pg-boss retries" design).
  const existingVerify = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:quiz_verify'),
        eq(event.subject_kind, 'question'),
        eq(event.subject_id, questionId),
        ne(event.outcome, 'error'),
      ),
    )
    .limit(1);
  if (existingVerify.length > 0) return { status: 'skipped:already_verified' };

  // The Q3 handler always writes metadata.quiz_gen on a generated draft. Parse it
  // so we can read source_refs (for the deterministic overlap) + carry it forward
  // merge-preserving. A row tagged source='quiz_gen' without parseable metadata is
  // a contract violation → throw so the failure-bottom records it (never silently
  // promote an unverifiable draft).
  const metadataRaw =
    row.metadata && typeof row.metadata === 'object'
      ? (row.metadata as Record<string, unknown>)
      : {};
  const parsedMeta = QuizGenMetadata.safeParse(metadataRaw.quiz_gen);
  if (!parsedMeta.success) {
    throw new Error(
      `runQuizVerify: question ${questionId} has source='quiz_gen' but no valid metadata.quiz_gen: ${parsedMeta.error.issues
        .map((i) => i.message)
        .join('; ')}`,
    );
  }
  const meta = parsedMeta.data;

  // Resolve subject profile from the first knowledge node (same convention as
  // quiz_gen / variant_verify).
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

  const input = {
    question: {
      id: row.id,
      prompt_md: row.prompt_md,
      reference_md: row.reference_md,
      choices_md: row.choices_md,
      kind: row.kind,
      difficulty: row.difficulty,
      knowledge_ids: row.knowledge_ids,
    },
    knowledge_context: knowledgeNode ? [knowledgeNode] : [],
    source_pack: meta.source_pack,
    source_refs: meta.source_refs,
    self_copy_safety: meta.copy_safety,
    generation_method: meta.generation_method,
  };

  let taskResult: TaskTextResult | null = null;
  try {
    const result = await runTaskFn('QuizVerifyTask', input, { db, subjectProfile });
    taskResult = result;
    const parsed = parseQuizVerifyOutput(result.text);

    // §4 / §5 — deterministic n-gram overlap over the self-reported snippets,
    // folded into the persisted copy_safety. The DETERMINISTIC computation is
    // authoritative for max_overlap; the verdict is the stricter of (LLM verdict,
    // deterministic-threshold verdict) — either one calling 'too_close' blocks
    // promotion.
    const snippets = meta.source_refs
      .map((r) => r.snippet)
      .filter((s): s is string => typeof s === 'string' && s.length > 0);
    const maxOverlap = maxNgramOverlap(row.prompt_md, snippets);
    const deterministicTooClose = maxOverlap >= COPY_SAFETY_TOO_CLOSE_THRESHOLD;
    const copySafetyVerdict: QuizGenMetadataT['copy_safety']['verdict'] =
      parsed.copy_safety.verdict === 'too_close' || deterministicTooClose
        ? 'too_close'
        : parsed.copy_safety.verdict;

    // Option B gate: promote ONLY when EVERY structured axis agrees the draft is
    // good. overall='pass' is necessary but NOT sufficient — an inconsistent LLM
    // output (overall='pass' while grounding/knowledge_hit verdict is 'fail' or
    // 'unclear') must not enter the review pool with an unsupported fact or an
    // off-topic question. Such inconsistency stays draft (needs_review). copy_safety
    // 'too_close' (LLM verdict OR deterministic overlap) also blocks promotion.
    const isTooClose = copySafetyVerdict === 'too_close';
    const checksPass =
      parsed.grounding.verdict === 'pass' && parsed.knowledge_hit.verdict === 'pass';
    const promote = parsed.overall === 'pass' && checksPass && !isTooClose;
    const verificationStatus: QuizGenVerificationT['status'] = promote
      ? 'verified'
      : parsed.overall === 'fail'
        ? 'failed'
        : 'needs_review';

    const now = new Date();
    const verifyEventId = createId();
    const verifiedBy = aiAgentRef('QuizVerifyTask', result);

    // Merge-preserving metadata: keep the agent's source_pack / source_refs /
    // generation_method; overwrite copy_safety with the quiz_verify-checked verdict
    // (checked_by='quiz_verify') and attach the two-axis verification block.
    const verification: QuizGenVerificationT = {
      status: verificationStatus,
      summary: parsed.summary_md,
      verified_by: verifiedBy,
    };
    const updatedMeta: QuizGenMetadataT = {
      ...meta,
      copy_safety: {
        verdict: copySafetyVerdict,
        max_overlap: maxOverlap,
        checked_by: 'quiz_verify',
      },
      verification,
    };
    const newMetadata = { ...metadataRaw, quiz_gen: updatedMeta };

    await db.transaction(async (tx) => {
      if (promote) {
        // Promote draft→active.
        await tx
          .update(question)
          .set({
            draft_status: 'active',
            metadata: newMetadata as never,
            updated_at: now,
          })
          .where(eq(question.id, questionId));

        // YUK-203 P3 — FSRS enroll is per knowledge point: materialize an
        // initial "new" card for each knowledge id this verified question
        // probes. The question itself remains the concrete item selected when
        // that knowledge becomes due. Unlabeled legacy questions fall back to
        // question-level FSRS so they are not silently dropped.
        const initial = initialFsrsState(now);
        const fsrsSubjectIds = Array.from(new Set(row.knowledge_ids ?? []));
        if (fsrsSubjectIds.length > 0) {
          for (const knowledgeId of fsrsSubjectIds) {
            // Codex (PR #295) — enroll-if-absent. A verified quiz binding to a
            // knowledge point that ALREADY has an FSRS projection (e.g. a
            // supplementary question for an already-studied node) must NOT reset
            // that node's state/due_at/last_review_event_id back to a fresh card —
            // that would discard the user's review history and pull a not-yet-due
            // card back into the pool. Only enroll knowledge points with no
            // existing projection; leave existing schedules untouched.
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
          // Unlabeled legacy questions enroll at question level. Same
          // enroll-if-absent guard so a re-verify can't reset an existing card.
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
        // needs_review / fail / too_close — stay draft, never reaches the pool.
        await tx
          .update(question)
          .set({
            metadata: newMetadata as never,
            updated_at: now,
          })
          .where(eq(question.id, questionId));
      }

      await writeEvent(tx, {
        id: verifyEventId,
        session_id: null,
        actor_kind: 'agent',
        actor_ref: 'quiz_verify',
        action: 'experimental:quiz_verify',
        subject_kind: 'question',
        subject_id: questionId,
        outcome: promote ? 'success' : parsed.overall === 'fail' ? 'failure' : 'partial',
        payload: {
          question_id: questionId,
          overall: parsed.overall,
          grounding: parsed.grounding,
          knowledge_hit: parsed.knowledge_hit,
          copy_safety: {
            llm_verdict: parsed.copy_safety.verdict,
            persisted_verdict: copySafetyVerdict,
            max_overlap: maxOverlap,
            deterministic_too_close: deterministicTooClose,
          },
          promoted: promote,
          verification_status: verificationStatus,
          summary_md: parsed.summary_md,
          confidence: parsed.confidence,
          verified_by: verifiedBy,
        },
        caused_by_event_id: null,
        task_run_id: result.task_run_id ?? null,
        cost_micro_usd: costUsdToMicroUsd(result.cost_usd),
        created_at: now,
      });
    });

    return {
      status: verificationStatus,
      overall: parsed.overall,
      copy_safety_verdict: copySafetyVerdict,
    };
  } catch (err) {
    // failure-bottom: best-effort mark verification.status='failed' on the row +
    // write a failure event, then re-throw so pg-boss retries. The draft stays
    // draft_status='draft' (never promoted) — the catch path NEVER promotes.
    try {
      const failedVerification: QuizGenVerificationT = {
        status: 'failed',
        summary: `quiz_verify failed: ${String((err as Error).message ?? err)}`,
        verified_by: { by: 'ai', task_kind: 'QuizVerifyTask' },
      };
      const failedMeta: QuizGenMetadataT = { ...meta, verification: failedVerification };
      await db
        .update(question)
        .set({
          metadata: { ...metadataRaw, quiz_gen: failedMeta } as never,
          updated_at: new Date(),
        })
        .where(eq(question.id, questionId));
      await writeEvent(db, {
        id: createId(),
        session_id: null,
        actor_kind: 'agent',
        actor_ref: 'quiz_verify',
        action: 'experimental:quiz_verify',
        subject_kind: 'question',
        subject_id: questionId,
        // 'error' (NOT 'failure') marks a TRANSIENT, non-terminal failure: the task
        // threw before producing a verdict. The idempotency guard treats this as
        // retriable (outcome != 'error'), so pg-boss redelivery re-runs the verify
        // instead of skipping it as already_verified. A terminal LLM verdict of
        // overall='fail' uses outcome='failure' on the success path above.
        outcome: 'error',
        payload: {
          question_id: questionId,
          error: String((err as Error).message ?? err),
        },
        caused_by_event_id: null,
        task_run_id: taskResult?.task_run_id ?? null,
        cost_micro_usd: costUsdToMicroUsd(taskResult?.cost_usd),
        created_at: new Date(),
      });
    } catch (cleanupErr) {
      console.error('[quiz_verify] catch-block cleanup failed for', questionId, cleanupErr);
    }
    throw err;
  }
}

export function buildQuizVerifyHandler(
  db: Db,
  deps: DepsOverride = {},
): (jobs: Job<QuizVerifyJobData>[]) => Promise<void> {
  const runTaskFn = deps.runTaskFn ?? defaultRunTaskFn;
  return async (jobs) => {
    for (const job of jobs) {
      const questionIds = job.data?.question_ids;
      if (!Array.isArray(questionIds) || questionIds.length === 0) {
        console.warn('[quiz_verify] job missing question_ids', job.id);
        continue;
      }
      for (const questionId of questionIds) {
        const result = await runQuizVerify({ db, questionId, runTaskFn });
        console.log(`[quiz_verify] ${questionId} -> ${result.status}`);
      }
    }
  };
}
