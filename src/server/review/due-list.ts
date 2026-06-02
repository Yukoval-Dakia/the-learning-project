// Phase 1c.1 Step 9.B — `/api/review/due` handler over `material_fsrs_state`.
//
// Extracted out of app/api/review/due/route.ts so it can be deps-injectable and
// unit/DB-tested: Next App Router route modules may ONLY export route handlers
// (GET/POST/...) + recognized config (runtime/dynamic/...), so an injectable
// helper or a `Deps` interface cannot live in route.ts (Next's generated
// .next/types route validator rejects any extra export — see YUK-67 / YUK-167).
//
// Pre-Step-9 the route SELECTed mistake rows where fsrs_state.due <= now() OR
// fsrs_state IS NULL. Post-Step-9 the legacy mistake table is gone; the FSRS
// projection lives in `material_fsrs_state` (one row per (kind, id) — Step 9.A).
// A never-reviewed question has NO `material_fsrs_state` row — those surface via
// the failure-attempt event stream.
//
// Wire contract preserved: { rows: [{ id, question_id, prompt_md, reference_md,
// knowledge_ids, cause, fsrs_state, created_at }] }.

import { type ActivityRefT, questionRef } from '@/core/schema/activity';
import type { CauseCategoryT } from '@/core/schema/event/blocks';
import { type Db, db } from '@/db/client';
import { material_fsrs_state, question } from '@/db/schema';
import { effectiveCauseCategoryForFailureAttempt } from '@/server/events/cause-policy';
import { type FailureAttempt, getFailureAttempts } from '@/server/events/queries';
// YUK-167 / ADR-0025 — North-Star W10 review soft-bias. Active goals supply a
// SOFT, goal-relevant re-rank of the overdue review items. ND-5: this is order-
// only — never touches the FSRS due path, the returned set, counts, or due_at.
import { type ActiveGoal, listActiveGoals } from '@/server/goals/queries';
import { errorResponse } from '@/server/http/errors';
// T-CS / YUK-168 — cross-subject scheduling v1 (ADR-0014 §5, line 242). The due
// pool is round-robin balanced across the learning-subjects that have due items
// so one busy subject can't dominate the page. batchResolveSubjectIds walks
// knowledge_ids → parent chain → domain → SubjectProfile (default fallback for
// orphan ids, YUK-56), memoised across the pool to avoid an N+1 on the
// parent-chain walk. Extracted to `@/server/knowledge/subject-resolution` (P5.2)
// so the brief-refresh layer shares the SAME canonical bridge.
import { batchResolveSubjectIds } from '@/server/knowledge/subject-resolution';
import type { EffectiveTruth } from '@/server/review/effective-truth';
import { and, eq, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';

// YUK-167 / ADR-0025 — swappable active-goals reader so DB tests inject goal
// fixtures (mirrors coach_daily.ts / dreaming_nightly.ts CoachRunDeps pattern).
type ListActiveGoalsFn = (db: Db) => Promise<ActiveGoal[]>;

export interface ReviewDueDeps {
  // Defaults to listActiveGoals. The goals only ADD a soft re-rank of the
  // overdue items already selected by the FSRS due-ordering + limit — they
  // never change which items are returned (ND-5).
  listActiveGoalsFn?: ListActiveGoalsFn;
}

function pickLatestFailureByQuestion(failures: FailureAttempt[]): Map<
  string,
  {
    id: string;
    cause: CauseCategoryT | null;
    created_at: Date;
    correction_state: EffectiveTruth;
  }
> {
  const out = new Map<
    string,
    {
      id: string;
      cause: CauseCategoryT | null;
      created_at: Date;
      correction_state: EffectiveTruth;
    }
  >();
  for (const failure of failures) {
    const existing = out.get(failure.question_id);
    if (existing && existing.created_at > failure.created_at) continue;
    out.set(failure.question_id, {
      id: failure.attempt_event_id,
      cause: effectiveCauseCategoryForFailureAttempt(failure),
      created_at: failure.created_at,
      correction_state: failure.correction_state,
    });
  }
  return out;
}

async function loadLatestFailureQuestionIds(candidateLimit: number): Promise<string[]> {
  const rows = (await db.execute(sql<{ question_id: string }>`
    SELECT subject_id AS question_id
    FROM (
      SELECT
        subject_id,
        created_at,
        id,
        row_number() OVER (PARTITION BY subject_id ORDER BY created_at DESC, id DESC) AS rn
      FROM event
      WHERE action = 'attempt'
        AND subject_kind = 'question'
        AND outcome = 'failure'
    ) ranked
    WHERE rn = 1
    ORDER BY created_at DESC, id DESC
    LIMIT ${candidateLimit}
  `)) as unknown as Array<{ question_id: string }>;
  return rows.map((row) => row.question_id);
}

async function getFailureAttemptsPerQuestion(
  questionIds: string[],
  perQuestionLimit: number,
): Promise<FailureAttempt[]> {
  if (questionIds.length === 0 || perQuestionLimit <= 0) return [];
  // YUK-76 codex round-3 P1 — push per-question cap into SQL via the new
  // `perQuestionLimit` opt so each question gets its own bounded slice. The
  // previous `limit: qids*cap*3` was a global active-rows cap and let one
  // hot question saturate the window, dropping quiet questions from the
  // never-reviewed slice entirely.
  return await getFailureAttempts(db, { questionIds, perQuestionLimit });
}

// T-CS / YUK-168 — deterministic round-robin SELECTION across subjects.
//
// `rows` is already ordered most-due-first (due_at asc for the overdue segment,
// or attempt order for the never-reviewed segment). We partition it by subject
// id (preserving that within-subject order — STABLE), then cycle through the
// subjects in a deterministic, stable order — the order in which each subject is
// FIRST encountered in `rows` — taking the next most-due item from each in turn
// until `limit` items are chosen or the pool is exhausted.
//
// SET PRESERVATION + DEGENERATION: with a SINGLE subject there is exactly one
// bucket, so the round-robin emits that bucket in its original order — byte-
// identical to `rows.slice(0, limit)`. This is the safety property that keeps
// the current single-subject-heavy usage unchanged (and keeps the
// never-reviewed-first contract intact when applied per-segment).
function roundRobinBySubject<T extends { id: string }>(
  rows: T[],
  subjectIdByRow: Map<string, string>,
  limit: number,
): T[] {
  if (rows.length <= 1 || limit <= 0) return rows.slice(0, Math.max(limit, 0));
  // Stable bucketing: subject order = first-seen order in `rows`; within-subject
  // order = `rows` order (most-due first). Single subject → one bucket → no-op.
  const buckets: T[][] = [];
  const bucketIndexBySubject = new Map<string, number>();
  for (const row of rows) {
    const subjectId = subjectIdByRow.get(row.id) ?? '';
    let idx = bucketIndexBySubject.get(subjectId);
    if (idx === undefined) {
      idx = buckets.length;
      bucketIndexBySubject.set(subjectId, idx);
      buckets.push([]);
    }
    buckets[idx].push(row);
  }
  if (buckets.length === 1) return rows.slice(0, limit);
  const cursors = new Array<number>(buckets.length).fill(0);
  const out: T[] = [];
  const cap = Math.min(limit, rows.length);
  while (out.length < cap) {
    let advanced = false;
    for (let b = 0; b < buckets.length && out.length < cap; b += 1) {
      const cursor = cursors[b];
      if (cursor < buckets[b].length) {
        out.push(buckets[b][cursor]);
        cursors[b] = cursor + 1;
        advanced = true;
      }
    }
    if (!advanced) break; // all buckets exhausted (defensive; cap bounds the loop)
  }
  return out;
}

export async function handleReviewDue(req: Request, deps: ReviewDueDeps = {}): Promise<Response> {
  try {
    const listGoals = deps.listActiveGoalsFn ?? listActiveGoals;
    const url = new URL(req.url);
    const limitRaw = url.searchParams.get('limit');
    const limitParsed = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
    const limit = Math.min(Math.max(Number.isNaN(limitParsed) ? 20 : limitParsed, 1), 200);
    const now = new Date();

    // Two slices, unioned:
    //   1. Questions with material_fsrs_state where due_at <= now() — overdue
    //      from prior reviews.
    //   2. Questions with NO material_fsrs_state row but at least one failure
    //      attempt — never-reviewed cards still owed a first pass.
    //
    // We keep them ordered: null-state cards first (legacy contract), then
    // due-earliest first.
    //
    // T-CS / YUK-168: fetch a WIDER overdue candidate window than `limit` (same
    // bounded window the never-reviewed slice uses) so the round-robin selection
    // below can balance across subjects. With a plain `.limit(limit)` the SQL
    // would pre-pick the `limit` most-due rows GLOBALLY — which can all be one
    // subject — leaving round-robin nothing to balance. Every fetched row is
    // still `due_at <= now`, so this widens the CANDIDATE window only, never the
    // due-pool definition; the returned set is still capped at `limit`
    // (round-robin selects exactly min(limit, pool) of these due rows). For a
    // single subject this is a no-op: round-robin returns the `limit` most-due,
    // identical to the old `.limit(limit)` slice.
    // Gate-B defensive invariant (QuizGen Option B): an UNVERIFIED quiz draft
    // (`draft_status='draft'`) must NEVER enter the review pool. quiz_verify only
    // promotes draft→active + builds material_fsrs_state on pass, so a draft has
    // neither an fsrs_state row nor an attempt — both slices already miss it
    // implicitly. This predicate makes that an EXPLICIT, query-level invariant so
    // a stray draft (e.g. a future write path that mis-attaches an attempt event)
    // can still never surface. Only 'draft' is excluded: NULL (embedded /
    // auto-enroll / legacy) and 'active' (variant / dreaming / promoted quiz) both
    // stay in the pool. NULL handling is explicit (`draft_status != 'draft'` alone
    // would drop NULL rows under SQL three-valued logic).
    const notDraftQuiz = or(isNull(question.draft_status), ne(question.draft_status, 'draft'));

    const candidateWindow = Math.min(Math.max(limit * 4, 100), 400);
    const [dueRows, latestFailureQuestionIds] = await Promise.all([
      db
        .select({
          question_id: material_fsrs_state.subject_id,
          state: material_fsrs_state.state,
          due_at: material_fsrs_state.due_at,
          prompt_md: question.prompt_md,
          reference_md: question.reference_md,
          knowledge_ids: question.knowledge_ids,
          created_at: question.created_at,
        })
        .from(material_fsrs_state)
        .innerJoin(question, eq(question.id, material_fsrs_state.subject_id))
        .where(
          and(
            eq(material_fsrs_state.subject_kind, 'question'),
            lte(material_fsrs_state.due_at, now),
            notDraftQuiz,
          ),
        )
        .orderBy(material_fsrs_state.due_at, question.created_at)
        .limit(candidateWindow),
      loadLatestFailureQuestionIds(candidateWindow),
    ]);

    // Build the "never reviewed" slice by finding failure attempts whose
    // question has no FSRS state row yet. Use the existing event-stream read
    // path (getFailureAttempts) and filter out already-projected ids.
    const projectedQids = new Set(dueRows.map((r) => r.question_id));
    const candidateQuestionIds = latestFailureQuestionIds.filter(
      (questionId) => !projectedQids.has(questionId),
    );
    const [newAttempts, dueAttempts] = await Promise.all([
      getFailureAttemptsPerQuestion(candidateQuestionIds, 4),
      getFailureAttemptsPerQuestion(
        dueRows.map((row) => row.question_id),
        4,
      ),
    ]);
    const newQuestionIds: string[] = [];
    for (const a of newAttempts) {
      if (!projectedQids.has(a.question_id) && !newQuestionIds.includes(a.question_id)) {
        newQuestionIds.push(a.question_id);
      }
    }
    const newRows: Array<{
      question_id: string;
      prompt_md: string;
      reference_md: string | null;
      knowledge_ids: string[];
      created_at: Date;
    }> = [];
    if (newQuestionIds.length > 0) {
      // Check NO material_fsrs_state row exists for these question ids
      const existing = await db
        .select({ subject_id: material_fsrs_state.subject_id })
        .from(material_fsrs_state)
        .where(
          and(
            eq(material_fsrs_state.subject_kind, 'question'),
            inArray(material_fsrs_state.subject_id, newQuestionIds),
          ),
        );
      const reviewed = new Set(existing.map((r) => r.subject_id));
      const trulyNew = newQuestionIds.filter((id) => !reviewed.has(id));
      if (trulyNew.length > 0) {
        const qRows = await db
          .select({
            id: question.id,
            prompt_md: question.prompt_md,
            reference_md: question.reference_md,
            knowledge_ids: question.knowledge_ids,
            created_at: question.created_at,
          })
          .from(question)
          // Gate-B invariant: never surface an unverified quiz draft, even if it
          // somehow carries a failure attempt (see `notDraftQuiz` above).
          .where(and(inArray(question.id, trulyNew), notDraftQuiz));
        const qById = new Map(qRows.map((q) => [q.id, q]));
        // Preserve attempt order (newest-first from getFailureAttempts).
        for (const qid of trulyNew) {
          const q = qById.get(qid);
          if (q) {
            newRows.push({
              question_id: qid,
              prompt_md: q.prompt_md,
              reference_md: q.reference_md,
              knowledge_ids: q.knowledge_ids ?? [],
              created_at: q.created_at,
            });
          }
        }
      }
    }
    const latestFailureByQid = pickLatestFailureByQuestion([...newAttempts, ...dueAttempts]);

    type OutRow = {
      id: string;
      activity_ref: ActivityRefT;
      question_id: string;
      prompt_md: string;
      reference_md: string | null;
      knowledge_ids: string[];
      cause: unknown;
      fsrs_state: unknown;
      created_at: Date;
      last_failure_event: { id: string; correction_state: EffectiveTruth } | null;
    };

    // Null-state (never reviewed) rows come first, then the already-due slice.
    const combined: OutRow[] = [
      ...newRows.map((n) => {
        const latestFailure = latestFailureByQid.get(n.question_id) ?? null;
        return {
          id: n.question_id,
          activity_ref: questionRef(n.question_id),
          question_id: n.question_id,
          prompt_md: n.prompt_md.slice(0, 1000),
          reference_md: n.reference_md ? n.reference_md.slice(0, 1000) : null,
          knowledge_ids: n.knowledge_ids,
          cause: latestFailure?.cause ?? null,
          fsrs_state: null,
          created_at: n.created_at,
          last_failure_event: latestFailure
            ? { id: latestFailure.id, correction_state: latestFailure.correction_state }
            : null,
        };
      }),
      ...dueRows.map((r) => {
        const latestFailure = latestFailureByQid.get(r.question_id) ?? null;
        return {
          id: r.question_id,
          activity_ref: questionRef(r.question_id),
          question_id: r.question_id,
          prompt_md: r.prompt_md.slice(0, 1000),
          reference_md: r.reference_md ? r.reference_md.slice(0, 1000) : null,
          knowledge_ids: (r.knowledge_ids as string[]) ?? [],
          cause: latestFailure?.cause ?? null,
          fsrs_state: r.state ?? null,
          created_at: r.created_at,
          last_failure_event: latestFailure
            ? { id: latestFailure.id, correction_state: latestFailure.correction_state }
            : null,
        };
      }),
    ];

    // T-CS / YUK-168 — cross-subject scheduling v1 (ADR-0014 §5).
    //
    // Choose the returned page FIRST, before any goal soft-bias. Instead of a
    // plain global-due `combined.slice(0, limit)` (which lets one busy subject
    // dominate the page), we ROUND-ROBIN the selection across the learning-
    // subjects that have due items: cycle the subjects taking the next most-due
    // item from each in turn until `limit` is reached or the pool is exhausted.
    //
    // We round-robin WITHIN each segment and keep the never-reviewed segment
    // ahead of the overdue segment, preserving the legacy null-state-first
    // contract that rerankOverdueByGoals relies on (overdue items remain a
    // contiguous tail). The never-reviewed block still wins the budget first,
    // exactly as `combined.slice` did today.
    //
    // ND-5 命门: round-robin only changes the ORDER + which subjects share the
    // budget — every returned row is still a member of the same due pool, never
    // a non-due item, and the soft goal re-rank below runs on this ALREADY-
    // SELECTED page (never the pre-limit pool) so it can only reorder, never
    // expand or shrink the set.
    //
    // SINGLE-SUBJECT DEGENERATION: when only one subject has due items, each
    // segment has a single round-robin bucket → emitted in its original order →
    // byte-identical to the old `combined.slice(0, limit)`. This keeps the
    // current single-subject-heavy usage (and every single-subject test) green.
    const subjectIdByRow = await batchResolveSubjectIds(
      db,
      combined.map((r) => ({ id: r.id, knowledge_ids: r.knowledge_ids })),
    );
    const newSegment = combined.slice(0, newRows.length);
    const overdueSegment = combined.slice(newRows.length);
    const selectedNew = roundRobinBySubject(newSegment, subjectIdByRow, limit);
    const selectedOverdue = roundRobinBySubject(
      overdueSegment,
      subjectIdByRow,
      limit - selectedNew.length,
    );
    const page = [...selectedNew, ...selectedOverdue];

    // SOFT, goal-relevant re-rank of the OVERDUE segment of the returned page.
    // Overdue items are exactly those carrying a non-null fsrs_state (the
    // material_fsrs_state-backed dueRows); never-reviewed items (fsrs_state ===
    // null) always precede them in `combined`, so the overdue items form a
    // contiguous tail of `page`. We stable-partition ONLY that segment so
    // goal-relevant overdue items come first, preserving the original relative
    // order within each group. Items outside the overdue segment are untouched.
    const reordered = await rerankOverdueByGoals(page, listGoals);

    return Response.json({ rows: reordered });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * YUK-167 / ADR-0025 — North-Star W10 review soft-bias.
 *
 * Stable-partition the OVERDUE items of the already-selected page so that
 * goal-relevant ones (whose knowledge_ids intersect the union of active goals'
 * scope_knowledge_ids) come first, preserving original relative order within
 * the goal-relevant group and within the non-relevant group.
 *
 * ND-5 (命门): this changes ONLY the ORDER. The returned set of ids, the count,
 * every due_at, and fsrs_state are identical to the no-goals output. The work
 * happens AFTER the due-ordering + limit have chosen the returned set.
 *
 * OFF-safe: with no active goals (or no scope intersection), the input `page`
 * is returned with its order unchanged (byte-identical to today).
 */
async function rerankOverdueByGoals<T extends { fsrs_state: unknown; knowledge_ids: string[] }>(
  page: T[],
  listGoals: ListActiveGoalsFn,
): Promise<T[]> {
  const activeGoals = await listGoals(db);
  if (activeGoals.length === 0) return page;

  const goalScope = new Set<string>();
  for (const g of activeGoals) {
    for (const kid of g.scope_knowledge_ids ?? []) goalScope.add(kid);
  }
  if (goalScope.size === 0) return page;

  // Locate the contiguous overdue tail segment (fsrs_state !== null). Items
  // before it (never-reviewed, null fsrs_state) keep their positions exactly.
  const firstOverdue = page.findIndex((row) => row.fsrs_state !== null);
  if (firstOverdue === -1) return page; // no overdue items in the page

  const head = page.slice(0, firstOverdue);
  const overdue = page.slice(firstOverdue);

  const isGoalRelevant = (row: T): boolean => row.knowledge_ids.some((kid) => goalScope.has(kid));

  // Stable partition: relevant first, then the rest, each preserving original
  // relative order. Same multiset → same set/count/due_at, only order changes.
  const relevant: T[] = [];
  const others: T[] = [];
  for (const row of overdue) {
    if (isGoalRelevant(row)) relevant.push(row);
    else others.push(row);
  }
  if (relevant.length === 0 || others.length === 0) return page; // nothing to reorder

  return [...head, ...relevant, ...others];
}
