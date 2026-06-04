// Phase 2A — Review Orchestrator.
//
// One-shot planning entry for "今天应该复习什么，为什么？" (spec:
// docs/superpowers/specs/2026-05-09-learning-orchestrator-long-term-design.md
// §"Phase 2A: Review Orchestrator").
//
// Architecture: rules-first, LLM-second per the spec's "先规则，后 LLM"
// directive. Priority + rationale are 100% deterministic; the LLM only writes
// the optional session-level intent sentence shown at the top of /review.
//
// Output is read-only (no events written). Submit / fsrs update / mastery
// projection all happen via the existing /api/review/submit path; this module
// is purely the planner.

import { type ActivityRefT, questionRef } from '@/core/schema/activity';
import { getCauseLabel, getCausePriority } from '@/core/schema/business';
import type { Db } from '@/db/client';
import { knowledge, material_fsrs_state, question } from '@/db/schema';
import { effectiveCauseCategoryForFailureAttempt } from '@/server/events/cause-policy';
import { type FailureAttempt, getFailureAttempts } from '@/server/events/queries';
import type { EffectiveTruth } from '@/server/review/effective-truth';
import {
  type SlimSubjectProfile,
  type SubjectProfile,
  resolveSubjectProfile,
  toSlimSubjectProfile,
} from '@/subjects/profile';
import { and, eq, inArray, lte, or, sql } from 'drizzle-orm';

import type { CauseCategoryT, FsrsStateSchemaT } from '@/core/schema/event/blocks';

// ---------- Public types ----------

export interface PlanQueueItem {
  activity_ref: ActivityRefT;
  question_id: string;
  prompt_md: string;
  reference_md: string | null;
  knowledge_ids: string[];
  /** ts-fsrs Card state JSON, or null if never reviewed. */
  fsrs_state: FsrsStateSchemaT | null;
  /** primary cause from the most recent chained judge / user_cause, or null. */
  cause: CauseCategoryT | null;
  /** Higher = study sooner. Clamped 1-5. */
  priority: 1 | 2 | 3 | 4 | 5;
  /** Single-line, deterministic explanation of the priority + lateness signal. */
  rationale: string;
  /** Last failure attempt time (sec). Null if no failure on record. */
  last_failure_at: number | null;
  /** Last failure attempt event plus effective correction state. */
  last_failure_event: { id: string; correction_state: EffectiveTruth } | null;
  /** Slim subject rendering/profile metadata resolved from knowledge_ids[0]. */
  subject_profile: SlimSubjectProfile;
}

export interface ReviewPlan {
  queue: PlanQueueItem[];
  /** LLM-generated 1-sentence framing for the session. Null if no LLM call ran
   *  (no runTaskFn provided, LLM failure, or empty queue). */
  session_intent: string | null;
  window: {
    /** Unix seconds when this plan was computed. */
    computed_at: number;
    /** Cap on returned rows. */
    limit: number;
  };
}

export type RunTaskFn = (kind: string, input: unknown, ctx: unknown) => Promise<{ text: string }>;

export interface PlanReviewSessionParams {
  db: Db;
  /** Max queue items returned. Clamped 1-200; default 20. */
  limit?: number;
  /** If supplied, the planner calls ReviewIntentTask after queue assembly to
   *  produce session_intent. If null/undefined OR the call throws, intent is
   *  left null and the queue still returns cleanly. */
  runTaskFn?: RunTaskFn;
}

// ---------- Priority model ----------
//
// Score = base(cause) + days_overdue_bonus + lapses_bonus, clamped 1-5.
// Tunables here, not in the prompt — this is rule-based by design.

const DAY_MS = 86_400_000;

function daysOverdue(dueAt: Date | null, now: Date): number {
  if (!dueAt) return 0;
  const delta = now.getTime() - dueAt.getTime();
  return delta > 0 ? Math.floor(delta / DAY_MS) : 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function computePriority(input: {
  cause: CauseCategoryT | null;
  days_overdue: number;
  lapses: number;
  subjectProfile?: SubjectProfile | null;
}): 1 | 2 | 3 | 4 | 5 {
  const base = getCausePriority(input.cause, input.subjectProfile);
  // ≥7d overdue = +1; ≥3d lapses ≥ 3 = +1. Capped at 5.
  const overdueBonus = input.days_overdue >= 7 ? 1 : 0;
  const lapseBonus = input.lapses >= 3 ? 1 : 0;
  return clamp(base + overdueBonus + lapseBonus, 1, 5) as 1 | 2 | 3 | 4 | 5;
}

function buildRationale(input: {
  cause: CauseCategoryT | null;
  days_overdue: number;
  lapses: number;
  never_reviewed: boolean;
  subjectProfile?: SubjectProfile | null;
}): string {
  const parts: string[] = [];
  if (input.never_reviewed) {
    parts.push('首次复习');
  } else if (input.days_overdue >= 1) {
    parts.push(`逾期 ${input.days_overdue}d`);
  } else {
    parts.push('到期');
  }
  if (input.cause) {
    parts.push(`${getCauseLabel(input.cause, input.subjectProfile)} 错因`);
  }
  if (input.lapses >= 2) {
    parts.push(`${input.lapses} 次 lapse`);
  }
  return parts.join(' · ');
}

type QueueItemWithoutSubject = Omit<PlanQueueItem, 'subject_profile'>;

const FALLBACK_SUBJECT_PROFILE = toSlimSubjectProfile(resolveSubjectProfile(null));

async function resolveEffectiveDomainsForKnowledgeIds(
  db: Db,
  knowledgeIds: string[],
): Promise<Map<string, string | null>> {
  const uniqueIds = [...new Set(knowledgeIds.filter((id) => id.length > 0))];
  const out = new Map<string, string | null>();
  if (uniqueIds.length === 0) return out;

  const unresolved = new Set(uniqueIds);
  const cursorByOriginal = new Map(uniqueIds.map((id) => [id, id]));

  for (let depth = 0; depth < 32 && unresolved.size > 0; depth += 1) {
    const cursorIds = [...new Set([...unresolved].map((id) => cursorByOriginal.get(id) ?? id))];
    if (cursorIds.length === 0) break;

    const rows = await db
      .select({ id: knowledge.id, domain: knowledge.domain, parent_id: knowledge.parent_id })
      .from(knowledge)
      .where(inArray(knowledge.id, cursorIds));
    const rowById = new Map(rows.map((row) => [row.id, row]));

    for (const originalId of [...unresolved]) {
      const cursorId = cursorByOriginal.get(originalId) ?? originalId;
      const row = rowById.get(cursorId);
      if (!row) {
        out.set(originalId, null);
        unresolved.delete(originalId);
        continue;
      }
      if (row.domain !== null) {
        out.set(originalId, row.domain);
        unresolved.delete(originalId);
        continue;
      }
      if (row.parent_id === null) {
        out.set(originalId, null);
        unresolved.delete(originalId);
        continue;
      }
      cursorByOriginal.set(originalId, row.parent_id);
    }
  }

  for (const unresolvedId of unresolved) {
    out.set(unresolvedId, null);
  }
  return out;
}

async function resolveSubjectProfilesForQueueItems(
  db: Db,
  items: QueueItemWithoutSubject[],
): Promise<Map<string, SlimSubjectProfile>> {
  const firstKnowledgeIds = items
    .map((item) => item.knowledge_ids[0])
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const domainByKnowledgeId = await resolveEffectiveDomainsForKnowledgeIds(db, firstKnowledgeIds);
  return new Map(
    [...new Set(firstKnowledgeIds)].map((knowledgeId) => [
      knowledgeId,
      toSlimSubjectProfile(resolveSubjectProfile(domainByKnowledgeId.get(knowledgeId) ?? null)),
    ]),
  );
}

function subjectProfileForKnowledgeIds(
  knowledgeIds: string[],
  subjectByKnowledgeId: Map<string, SlimSubjectProfile>,
): SlimSubjectProfile {
  const firstKnowledgeId = knowledgeIds[0];
  if (!firstKnowledgeId) return FALLBACK_SUBJECT_PROFILE;
  return subjectByKnowledgeId.get(firstKnowledgeId) ?? FALLBACK_SUBJECT_PROFILE;
}

function fullSubjectProfileForKnowledgeIds(
  knowledgeIds: string[],
  domainByKnowledgeId: Map<string, string | null>,
): SubjectProfile {
  const firstKnowledgeId = knowledgeIds[0];
  if (!firstKnowledgeId) return resolveSubjectProfile(null);
  return resolveSubjectProfile(domainByKnowledgeId.get(firstKnowledgeId) ?? null);
}

// ---------- Cause lookup (latest failure per question) ----------

function pickLatestCausePerQuestion(failures: FailureAttempt[]): Map<
  string,
  {
    cause: CauseCategoryT | null;
    created_at: Date;
    attempt_event_id: string;
    correction_state: EffectiveTruth;
  }
> {
  const out = new Map<
    string,
    {
      cause: CauseCategoryT | null;
      created_at: Date;
      attempt_event_id: string;
      correction_state: EffectiveTruth;
    }
  >();
  for (const f of failures) {
    const existing = out.get(f.question_id);
    if (existing && existing.created_at > f.created_at) continue;
    out.set(f.question_id, {
      cause: effectiveCauseCategoryForFailureAttempt(f),
      created_at: f.created_at,
      attempt_event_id: f.attempt_event_id,
      correction_state: f.correction_state,
    });
  }
  return out;
}

// ---------- Main entry ----------

export async function planReviewSession(params: PlanReviewSessionParams): Promise<ReviewPlan> {
  const limit = clamp(params.limit ?? 20, 1, 200);
  const now = new Date();

  // CodeRabbit (PR #295) — object-shape declaration uses `interface` per repo
  // TS convention; same fields, no semantic change.
  interface DueRow {
    question_id: string;
    state: unknown;
    due_at: Date;
    prompt_md: string;
    reference_md: string | null;
    knowledge_ids: string[];
  }

  // Slice 1: knowledge FSRS states where due_at <= now (overdue or due now
  // from prior reviews). The scheduler chooses one concrete question probe per
  // due knowledge point. Question-level rows remain as legacy fallback for
  // unlabeled questions.
  const dueRows: DueRow[] = [];
  const usedDueQuestionIds = new Set<string>();
  // CodeRabbit (PR #295) — bounded pagination instead of a pre-dedup
  // `.limit(limit)`. When several due knowledge points map to the same small
  // set of questions, a single page truncated at `limit` would scan only the
  // first N knowledge points and silently drop later due ones whose questions
  // were already consumed. We page through due knowledge states (ordered most-
  // due first) and pick one unused question probe each, stopping once we have
  // `limit` unique dueRows or a page comes back empty. A MAX_PAGES guard caps
  // the loop so a pathological dataset can never run away.
  const pageSize = Math.max(limit * 3, 50);
  const MAX_KNOWLEDGE_PAGES = 10;
  for (let page = 0; page < MAX_KNOWLEDGE_PAGES && dueRows.length < limit; page += 1) {
    const dueKnowledgeStates = await params.db
      .select({
        knowledge_id: material_fsrs_state.subject_id,
        state: material_fsrs_state.state,
        due_at: material_fsrs_state.due_at,
      })
      .from(material_fsrs_state)
      .where(
        and(
          eq(material_fsrs_state.subject_kind, 'knowledge'),
          lte(material_fsrs_state.due_at, now),
        ),
      )
      .orderBy(material_fsrs_state.due_at, material_fsrs_state.subject_id)
      .limit(pageSize)
      .offset(page * pageSize);
    if (dueKnowledgeStates.length === 0) break;

    for (const due of dueKnowledgeStates) {
      if (dueRows.length >= limit) break;
      const qRows = await params.db
        .select({
          id: question.id,
          prompt_md: question.prompt_md,
          reference_md: question.reference_md,
          knowledge_ids: question.knowledge_ids,
        })
        .from(question)
        .where(
          and(
            sql`${question.knowledge_ids} @> ${JSON.stringify([due.knowledge_id])}::jsonb`,
            sql`(${question.draft_status} IS NULL OR ${question.draft_status} <> 'draft')`,
          ),
        )
        .orderBy(question.created_at, question.id)
        .limit(10);
      const selected = qRows.find((row) => !usedDueQuestionIds.has(row.id));
      if (!selected) continue;
      usedDueQuestionIds.add(selected.id);
      dueRows.push({
        question_id: selected.id,
        state: due.state,
        due_at: due.due_at,
        prompt_md: selected.prompt_md,
        reference_md: selected.reference_md,
        knowledge_ids: selected.knowledge_ids ?? [],
      });
    }
    if (dueKnowledgeStates.length < pageSize) break;
  }

  const legacyQuestionRows = await params.db
    .select({
      question_id: material_fsrs_state.subject_id,
      state: material_fsrs_state.state,
      due_at: material_fsrs_state.due_at,
      prompt_md: question.prompt_md,
      reference_md: question.reference_md,
      knowledge_ids: question.knowledge_ids,
    })
    .from(material_fsrs_state)
    .innerJoin(question, eq(question.id, material_fsrs_state.subject_id))
    .where(
      and(eq(material_fsrs_state.subject_kind, 'question'), lte(material_fsrs_state.due_at, now)),
    )
    .orderBy(material_fsrs_state.due_at, question.created_at)
    .limit(limit);
  for (const due of legacyQuestionRows) {
    if (usedDueQuestionIds.has(due.question_id)) continue;
    usedDueQuestionIds.add(due.question_id);
    dueRows.push(due);
  }
  dueRows.sort((a, b) => {
    const dueDelta = a.due_at.getTime() - b.due_at.getTime();
    if (dueDelta !== 0) return dueDelta;
    return a.question_id.localeCompare(b.question_id);
  });

  // Slice 2: failure attempts whose question has no fsrs_state row yet
  // (never reviewed, first-pass owed).
  const recentFailures = await getFailureAttempts(params.db, { limit: limit * 2 });
  // CodeRabbit (PR #295) — scope the question-level FSRS lookup to the
  // recentFailures' question_id set instead of `eq(subject_kind,'question')`
  // alone, which read every question-level row in the table. We only need to
  // know whether THESE candidate questions are already projected, so an
  // inArray over the failure question ids keeps the read bounded as the table
  // grows.
  const failureQuestionIds = Array.from(new Set(recentFailures.map((f) => f.question_id)));
  const failureKnowledgeIds = Array.from(
    new Set(recentFailures.flatMap((failure) => failure.referenced_knowledge_ids)),
  );
  const fsrsConditions = [
    failureQuestionIds.length > 0
      ? and(
          eq(material_fsrs_state.subject_kind, 'question'),
          inArray(material_fsrs_state.subject_id, failureQuestionIds),
        )
      : undefined,
    failureKnowledgeIds.length > 0
      ? and(
          eq(material_fsrs_state.subject_kind, 'knowledge'),
          inArray(material_fsrs_state.subject_id, failureKnowledgeIds),
        )
      : undefined,
  ];
  const fsrsRows =
    failureQuestionIds.length > 0 || failureKnowledgeIds.length > 0
      ? await params.db
          .select({
            subject_kind: material_fsrs_state.subject_kind,
            subject_id: material_fsrs_state.subject_id,
          })
          .from(material_fsrs_state)
          .where(or(...fsrsConditions))
      : [];
  const projectedKnowledgeIds = new Set(
    fsrsRows.filter((row) => row.subject_kind === 'knowledge').map((row) => row.subject_id),
  );
  const projectedQuestionIds = new Set(
    fsrsRows.filter((row) => row.subject_kind === 'question').map((row) => row.subject_id),
  );
  const projectedQids = new Set(dueRows.map((r) => r.question_id));
  const candidateNewQids: string[] = [];
  for (const f of recentFailures) {
    const knowledgeReviewed = f.referenced_knowledge_ids.some((id) =>
      projectedKnowledgeIds.has(id),
    );
    if (
      !knowledgeReviewed &&
      !projectedQuestionIds.has(f.question_id) &&
      !projectedQids.has(f.question_id) &&
      !candidateNewQids.includes(f.question_id)
    ) {
      candidateNewQids.push(f.question_id);
    }
  }

  let newRows: Array<{
    question_id: string;
    prompt_md: string;
    reference_md: string | null;
    knowledge_ids: string[];
  }> = [];
  if (candidateNewQids.length > 0) {
    const trulyNew = candidateNewQids;
    if (trulyNew.length > 0) {
      const qRows = await params.db
        .select({
          id: question.id,
          prompt_md: question.prompt_md,
          reference_md: question.reference_md,
          knowledge_ids: question.knowledge_ids,
        })
        .from(question)
        .where(inArray(question.id, trulyNew));
      const qById = new Map(qRows.map((q) => [q.id, q]));
      newRows = trulyNew
        .map((qid) => qById.get(qid))
        .filter((q): q is NonNullable<typeof q> => q !== undefined)
        .map((q) => ({
          question_id: q.id,
          prompt_md: q.prompt_md,
          reference_md: q.reference_md,
          knowledge_ids: q.knowledge_ids ?? [],
        }));
    }
  }

  // Cause lookup — one batched pull for all candidate qids.
  const allCandidateQids = [...projectedQids, ...newRows.map((n) => n.question_id)];
  let causeByQid = new Map<
    string,
    {
      cause: CauseCategoryT | null;
      created_at: Date;
      attempt_event_id: string;
      correction_state: EffectiveTruth;
    }
  >();
  if (allCandidateQids.length > 0) {
    const candidatesFailures = await getFailureAttempts(params.db, {
      questionIds: allCandidateQids,
      limit: 500,
    });
    causeByQid = pickLatestCausePerQuestion(candidatesFailures);
  }
  const firstKnowledgeIdsForCause = [...newRows, ...dueRows]
    .map((row) => row.knowledge_ids?.[0])
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const domainByKnowledgeIdForCause = await resolveEffectiveDomainsForKnowledgeIds(
    params.db,
    firstKnowledgeIdsForCause,
  );

  // Project to PlanQueueItem with priority + rationale. Never-reviewed first
  // (preserve current /due ordering contract), then due slice ordered by due_at.
  const items: QueueItemWithoutSubject[] = [];
  for (const n of newRows) {
    const cause = causeByQid.get(n.question_id)?.cause ?? null;
    const latestFailure = causeByQid.get(n.question_id) ?? null;
    const lastFailureAt = latestFailure?.created_at ?? null;
    const subjectProfile = fullSubjectProfileForKnowledgeIds(
      n.knowledge_ids,
      domainByKnowledgeIdForCause,
    );
    items.push({
      activity_ref: questionRef(n.question_id),
      question_id: n.question_id,
      prompt_md: n.prompt_md.slice(0, 1000),
      reference_md: n.reference_md ? n.reference_md.slice(0, 1000) : null,
      knowledge_ids: n.knowledge_ids,
      fsrs_state: null,
      cause,
      priority: computePriority({ cause, days_overdue: 0, lapses: 0, subjectProfile }),
      rationale: buildRationale({
        cause,
        days_overdue: 0,
        lapses: 0,
        never_reviewed: true,
        subjectProfile,
      }),
      last_failure_at: lastFailureAt ? Math.floor(lastFailureAt.getTime() / 1000) : null,
      last_failure_event: latestFailure
        ? {
            id: latestFailure.attempt_event_id,
            correction_state: latestFailure.correction_state,
          }
        : null,
    });
  }
  for (const r of dueRows) {
    const state = r.state as FsrsStateSchemaT | null;
    const cause = causeByQid.get(r.question_id)?.cause ?? null;
    const latestFailure = causeByQid.get(r.question_id) ?? null;
    const lastFailureAt = latestFailure?.created_at ?? null;
    const overdue = daysOverdue(r.due_at, now);
    const lapses = state?.lapses ?? 0;
    const knowledgeIds = (r.knowledge_ids as string[]) ?? [];
    const subjectProfile = fullSubjectProfileForKnowledgeIds(
      knowledgeIds,
      domainByKnowledgeIdForCause,
    );
    items.push({
      activity_ref: questionRef(r.question_id),
      question_id: r.question_id,
      prompt_md: r.prompt_md.slice(0, 1000),
      reference_md: r.reference_md ? r.reference_md.slice(0, 1000) : null,
      knowledge_ids: knowledgeIds,
      fsrs_state: state,
      cause,
      priority: computePriority({ cause, days_overdue: overdue, lapses, subjectProfile }),
      rationale: buildRationale({
        cause,
        days_overdue: overdue,
        lapses,
        never_reviewed: false,
        subjectProfile,
      }),
      last_failure_at: lastFailureAt ? Math.floor(lastFailureAt.getTime() / 1000) : null,
      last_failure_event: latestFailure
        ? {
            id: latestFailure.attempt_event_id,
            correction_state: latestFailure.correction_state,
          }
        : null,
    });
  }
  const queueWithoutSubject = items.slice(0, limit);
  const subjectByKnowledgeId = await resolveSubjectProfilesForQueueItems(
    params.db,
    queueWithoutSubject,
  );
  const queue: PlanQueueItem[] = queueWithoutSubject.map((item) => ({
    ...item,
    subject_profile: subjectProfileForKnowledgeIds(item.knowledge_ids, subjectByKnowledgeId),
  }));

  // Optional LLM session_intent — best-effort, never blocks queue return.
  let session_intent: string | null = null;
  if (params.runTaskFn && queue.length > 0) {
    session_intent = await buildSessionIntent(queue, params.runTaskFn);
  }

  return {
    queue,
    session_intent,
    window: { computed_at: Math.floor(now.getTime() / 1000), limit },
  };
}

// ---------- LLM session_intent ----------

interface IntentInput {
  total: number;
  by_priority: Record<1 | 2 | 3 | 4 | 5, number>;
  by_cause: Record<string, number>;
  top_knowledge_ids: string[];
  has_never_reviewed: number;
  has_overdue_7d: number;
}

function summarizeQueueForIntent(queue: PlanQueueItem[]): IntentInput {
  const byPriority: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const byCause = new Map<string, number>();
  const knowledgeCounts = new Map<string, number>();
  let neverReviewed = 0;
  let overdue7d = 0;

  for (const item of queue) {
    byPriority[item.priority] += 1;
    if (item.cause) byCause.set(item.cause, (byCause.get(item.cause) ?? 0) + 1);
    for (const k of item.knowledge_ids) {
      knowledgeCounts.set(k, (knowledgeCounts.get(k) ?? 0) + 1);
    }
    if (item.fsrs_state === null) neverReviewed += 1;
    if (item.rationale.includes('逾期 7') || /逾期 \d{2,}d/.test(item.rationale)) overdue7d += 1;
  }

  const topKnowledge = [...knowledgeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id]) => id);

  return {
    total: queue.length,
    by_priority: byPriority,
    by_cause: Object.fromEntries(byCause.entries()),
    top_knowledge_ids: topKnowledge,
    has_never_reviewed: neverReviewed,
    has_overdue_7d: overdue7d,
  };
}

async function buildSessionIntent(
  queue: PlanQueueItem[],
  runTaskFn: RunTaskFn,
): Promise<string | null> {
  try {
    const summary = summarizeQueueForIntent(queue);
    const result = await runTaskFn('ReviewIntentTask', summary, {});
    const trimmed = result.text.trim();
    // Soft cap to 80 chars; UI is a single-line ribbon.
    return trimmed.length > 0 ? trimmed.slice(0, 80) : null;
  } catch (err) {
    console.warn(
      '[review-orchestrator] buildSessionIntent failed (queue returned without it)',
      err,
    );
    return null;
  }
}
