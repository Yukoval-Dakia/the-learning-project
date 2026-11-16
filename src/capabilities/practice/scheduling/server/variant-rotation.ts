// By-kind selection routing for variant rotation.
// recall (fill_blank/translation) repeats the same question so the FSRS signal measures a
// stable item; application (short_answer/reading/choice) rotates within the
// root_question_id family so repeated reviews exercise the skill. Pure and deterministic;
// only mutates the caller-owned usedQuestionIds set.

import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { mfiScore } from '@/core/selection-signals';
import { difficultyToLogitB } from '@/core/theta';
import type { Db, Tx } from '@/db/client';
import { isPoolVisible, notDraftPredicate, questionSuspendedPredicate } from '@/db/predicates';
import { event, question } from '@/db/schema';
import { effectiveThetaForKcBatch, getMasteryStates } from '@/kernel/read-models/mastery-state';
import { readHardCalibrationBs } from '@/kernel/read-models/question-difficulty';
import { assessmentAttemptEventId } from '@/kernel/records/assessment-attempt-identity';
import { readAutomaticallyServableQuestionIds } from '@/kernel/records/assessment-issuance';

// A ring of one never moves. Fewer than two family members the learner has not
// seen inside this window cannot rotate, so the probe leaves the family.
const MIN_FRESH_FAMILY_MEMBERS = 2;
const RECENT_SIGHT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

// Seeing a question means the learner answered it. Promote/verify events also
// use subject_kind=question and must not burn the window.
const LEARNER_SIGHT_ACTIONS = ['attempt', 'review', 'experimental:assessment_attempt'] as const;

// by-kind routing class.
export type RotationClass = 'recall' | 'application';

// routing table (owner 2026-06-07 拍板, 评论 a7db1f40).
// recall: fill_blank / translation — repeat the same question.
// application: short_answer / reading / choice — rotate the variant family.
// Unadjudicated kinds (essay / computation / derivation / true_false) fall through
// to the CONSERVATIVE application default: they are all open/solve-type where
// "memorise the answer" is harmful. A family with fewer than two members the
// learner has not seen recently cannot rotate, so the probe moves to another
// servable question on the same knowledge point (see chooseApplicationProbe).
// question.kind is a free-form label, so this is now a lookup over the
// KNOWN label ids (the nine below), not an exhaustive enum map. A label outside
// the table → undefined: the signal collectors (softmax/placement/stream-store)
// fail CLOSED into the recall lock (never sampled as a normal application item),
// while selectProbeFromPrefetch treats it as the application default — identical
// to the pre- runtime path where a dirty value's map lookup returned
// undefined → `=== 'recall'` false → application.
const ROTATION_CLASS_BY_KIND: Record<string, RotationClass> = {
  fill_blank: 'recall',
  translation: 'recall',
  short_answer: 'application',
  reading: 'application',
  choice: 'application',
  // Conservative default for kinds owner did not name (§决定·1). If a
  // future label is genuinely a recall type, it MUST be classified here — the
  // fail-closed default is recall-lock (undefined), not application.
  essay: 'application',
  computation: 'application',
  derivation: 'application',
  true_false: 'application',
};

/**
 * Rotation class for a persisted kind label; `undefined` when the label is
 * missing or not a KNOWN kind id — signal collectors treat that as the
 * fail-closed recall lock , exactly like the retired enum
 * membership check; the probe selector falls through to application (the
 * pre-existing dirty-value path).
 */
export function rotationClassForKind(kind: string | null | undefined): RotationClass | undefined {
  if (kind == null || !Object.hasOwn(ROTATION_CLASS_BY_KIND, kind)) return undefined;
  return ROTATION_CLASS_BY_KIND[kind];
}

// Projection returned to due-list — identical field set to the pre-
// `pickQuestionForKnowledge` return (question_id, prompt_md, reference_md,
// knowledge_ids, created_at, source, metadata). `source`/`metadata` are kept so
// downstream tier derivation is unchanged.
export type SelectedProbe = {
  question_id: string;
  prompt_md: string;
  reference_md: string | null;
  knowledge_ids: string[];
  created_at: Date;
  source: string;
  metadata: Record<string, unknown> | null;
};

// Internal row shape read from `question` for routing/rotation. `draft_status` is
// carried so the recall branch can re-check the last question is still non-draft
// without a second round-trip. Read via the drizzle query builder (NOT raw
// execute) so `created_at` comes back as a Date — raw `db.execute` returns
// timestamps as strings, which would break the JS rotation sort.
type QuestionRow = {
  id: string;
  prompt_md: string;
  reference_md: string | null;
  knowledge_ids: string[];
  created_at: Date;
  source: string;
  metadata: Record<string, unknown> | null;
  kind: string;
  variant_depth: number;
  root_question_id: string | null;
  draft_status: string | null;
  difficulty: number;
};

// Shared column projection — keeps the three reads (single, family, K-fallback)
// in sync.
const QUESTION_PROJECTION = {
  id: question.id,
  prompt_md: question.prompt_md,
  reference_md: question.reference_md,
  knowledge_ids: question.knowledge_ids,
  created_at: question.created_at,
  source: question.source,
  metadata: question.metadata,
  kind: question.kind,
  variant_depth: question.variant_depth,
  root_question_id: question.root_question_id,
  draft_status: question.draft_status,
  difficulty: question.difficulty,
} as const;

function knowledgeContains(knowledgeId: string) {
  return sql`${question.knowledge_ids} @> ${JSON.stringify([knowledgeId])}::jsonb`;
}

function toProbe(row: QuestionRow): SelectedProbe {
  return {
    question_id: row.id,
    prompt_md: row.prompt_md,
    reference_md: row.reference_md,
    knowledge_ids: row.knowledge_ids ?? [],
    created_at: row.created_at,
    source: row.source,
    metadata: row.metadata,
  };
}

// Deterministic rotation order : variant_depth ASC, created_at ASC,
// id ASC. Stable ring; same input → same order.
function sortFamily(rows: QuestionRow[]): QuestionRow[] {
  return [...rows].sort((a, b) => {
    if (a.variant_depth !== b.variant_depth) return a.variant_depth - b.variant_depth;
    const created = a.created_at.getTime() - b.created_at.getTime();
    if (created !== 0) return created;
    return a.id.localeCompare(b.id);
  });
}

// bulk-prefetched inputs for a whole page of due knowledge points, so the
// per-KC probe selection runs as pure in-memory computation instead of 2-3 serial
// round-trips per KC (the /api/review/due N+1). Three batch reads back these maps.
export interface ProbeSelectionPrefetch {
  // last_review_event_id → the question id presented at that review (event.subject_id).
  lastQuestionIdByEventId: Map<string, string>;
  // last-reviewed question rows (routing + lineage cols), keyed by id. NO draft filter —
  // mirrors the single readQuestion, which reads any row regardless of draft_status.
  questionRowById: Map<string, QuestionRow>;
  // per due-KC: its pool-visible (non-draft) questions, sorted (created_at ASC, id ASC) —
  // the exact firstForKnowledge ordering. Family reads filter this same bucket in memory.
  kcQuestions: Map<string, QuestionRow[]>;
  // question ids the learner answered or reviewed inside the recent-sight window.
  recentlySeenQuestionIds: ReadonlySet<string>;
  // Effective θ̂ of each due knowledge point. Absent at score time → cold start 0.
  thetaHatByKnowledgeId: ReadonlyMap<string, number>;
  // Hard calibration b, else the difficulty proxy. Absent → that question ranks last.
  difficultyBByQuestionId: ReadonlyMap<string, number>;
}

/**
 * prefetch every DB input {@link selectProbeFromPrefetch} needs for a batch of due
 * knowledge points. The per-KC walk stays in memory:
 * 1. last-review event → presented question id (one `inArray` over event ids, plus the
 *    attempt row when that event is a settlement rather than a question-scoped review);
 * 2. the last-reviewed question rows (one `inArray` over those question ids, no draft filter);
 * 3. every non-draft question containing ANY of the due KCs (one containment scan), bucketed
 * per KC in (created_at, id) order;
 * 4. recent answer/review sights, effective θ̂, and item difficulty for the widened pool.
 *
 * Bucket (3) is the superset for BOTH fallback paths: a family member must be tagged the due
 * KC (readFamily's `knowledgeContains(K)`), so it always appears in that KC's bucket — the
 * family read becomes an in-memory filter of the bucket by `root_question_id`/`id`.
 */
export async function prefetchProbeSelection(
  dbHandle: Db | Tx,
  inputs: Array<{ knowledgeId: string; lastReviewEventId: string | null }>,
  now: Date = new Date(),
): Promise<ProbeSelectionPrefetch> {
  const eventIds = Array.from(
    new Set(inputs.map((i) => i.lastReviewEventId).filter((id): id is string => id !== null)),
  );
  const lastQuestionIdByEventId = new Map<string, string>();
  if (eventIds.length > 0) {
    await resolvePresentedQuestionIds(dbHandle, eventIds, lastQuestionIdByEventId);
  }

  const lastQuestionIds = Array.from(new Set(lastQuestionIdByEventId.values()));
  const questionRowById = new Map<string, QuestionRow>();
  if (lastQuestionIds.length > 0) {
    const rows = (await dbHandle
      .select(QUESTION_PROJECTION)
      .from(question)
      // 契约准入门：recall 回放也要过 suspended/withdrawn 门 ——
      // 挂起的上一题不返 recall，回落到 K 内首个可用题（P1：此前无门，
      // 挂起题仍被 recall 路径直送）。
      .where(
        and(inArray(question.id, lastQuestionIds), questionSuspendedPredicate(question)),
      )) as QuestionRow[];
    const admittedIds = await readAutomaticallyServableQuestionIds(
      dbHandle,
      rows.map((row) => row.id),
    );
    for (const r of rows) if (admittedIds.has(r.id)) questionRowById.set(r.id, r);
  }

  const knowledgeIds = Array.from(new Set(inputs.map((i) => i.knowledgeId)));
  const kcQuestions = new Map<string, QuestionRow[]>();
  if (knowledgeIds.length > 0) {
    // OR-of-containments over the due KC set, PARENTHESISED so it composes with the
    // non-draft predicate as `notDraft AND (c1 OR c2 …)` (drizzle's `and` would otherwise
    // fold the bare OR chain at the wrong precedence).
    const containment = sql`(${sql.join(
      knowledgeIds.map((kc) => knowledgeContains(kc)),
      sql` OR `,
    )})`;
    const rows = (await dbHandle
      .select(QUESTION_PROJECTION)
      .from(question)
      .where(
        and(
          notDraftPredicate(question.draft_status),
          containment,
          // 契约准入门：suspended/withdrawn 组不进变式轮换池。
          questionSuspendedPredicate(question),
        ),
      )
      .orderBy(question.created_at, question.id)) as QuestionRow[];
    const admittedIds = await readAutomaticallyServableQuestionIds(
      dbHandle,
      rows.map((row) => row.id),
    );
    const dueKcSet = new Set(knowledgeIds);
    for (const r of rows) {
      if (!admittedIds.has(r.id)) continue;
      for (const kc of r.knowledge_ids ?? []) {
        if (!dueKcSet.has(kc)) continue;
        const bucket = kcQuestions.get(kc);
        if (bucket) bucket.push(r);
        else kcQuestions.set(kc, [r]);
      }
    }
  }

  const bucketRows = Array.from(kcQuestions.values()).flat();
  const bucketQuestionIds = Array.from(new Set(bucketRows.map((row) => row.id)));
  const [recentlySeenQuestionIds, difficultyBByQuestionId, thetaHatByKnowledgeId] =
    await Promise.all([
      readRecentlySeenQuestionIds(dbHandle, bucketQuestionIds, now),
      readDifficultyBByQuestionId(dbHandle, bucketRows),
      readThetaHatByKnowledgeId(dbHandle, knowledgeIds),
    ]);

  return {
    lastQuestionIdByEventId,
    questionRowById,
    kcQuestions,
    recentlySeenQuestionIds,
    thetaHatByKnowledgeId,
    difficultyBByQuestionId,
  };
}

function payloadText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// Settlement rows store the evaluation group as subject_id. The question the learner
// saw is the attempt anchored by payload.submission_id. A question-scoped review or
// attempt already carries that question as subject_id.
async function resolvePresentedQuestionIds(
  dbHandle: Db | Tx,
  eventIds: string[],
  into: Map<string, string>,
): Promise<void> {
  const rows = await dbHandle
    .select({
      id: event.id,
      subject_kind: event.subject_kind,
      subject_id: event.subject_id,
      submission_id: sql<string | null>`${event.payload}->>'submission_id'`,
      anchor_question_id: sql<
        string | null
      >`${event.payload}->'theta_decision'->>'anchorQuestionId'`,
    })
    .from(event)
    .where(inArray(event.id, eventIds));

  const pending: Array<{
    eventId: string;
    submissionId: string;
    anchorQuestionId: string | null;
  }> = [];
  for (const row of rows) {
    if (row.subject_kind === 'question') {
      into.set(row.id, row.subject_id);
      continue;
    }
    const submissionId = payloadText(row.submission_id);
    const anchorQuestionId = payloadText(row.anchor_question_id);
    if (submissionId) pending.push({ eventId: row.id, submissionId, anchorQuestionId });
    else if (anchorQuestionId) into.set(row.id, anchorQuestionId);
  }
  if (pending.length === 0) return;

  const attemptIds = Array.from(
    new Set(pending.map((row) => assessmentAttemptEventId(row.submissionId))),
  );
  const attempts = await dbHandle
    .select({
      id: event.id,
      subject_kind: event.subject_kind,
      subject_id: event.subject_id,
    })
    .from(event)
    .where(inArray(event.id, attemptIds));
  const questionByAttemptId = new Map(
    attempts
      .filter((row) => row.subject_kind === 'question')
      .map((row) => [row.id, row.subject_id] as const),
  );
  for (const row of pending) {
    const questionId = questionByAttemptId.get(assessmentAttemptEventId(row.submissionId));
    if (questionId) into.set(row.eventId, questionId);
    else if (row.anchorQuestionId) into.set(row.eventId, row.anchorQuestionId);
  }
}

async function readRecentlySeenQuestionIds(
  dbHandle: Db | Tx,
  questionIds: string[],
  now: Date,
): Promise<Set<string>> {
  const seen = new Set<string>();
  if (questionIds.length === 0) return seen;
  const since = new Date(now.getTime() - RECENT_SIGHT_WINDOW_MS);
  const rows = await dbHandle
    .select({ subject_id: event.subject_id })
    .from(event)
    .where(
      and(
        eq(event.subject_kind, 'question'),
        inArray(event.subject_id, questionIds),
        inArray(event.action, [...LEARNER_SIGHT_ACTIONS]),
        gte(event.created_at, since),
      ),
    )
    .groupBy(event.subject_id);
  for (const row of rows) seen.add(row.subject_id);
  return seen;
}

async function readDifficultyBByQuestionId(
  dbHandle: Db | Tx,
  rows: QuestionRow[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (rows.length === 0) return out;
  const hard = await readHardCalibrationBs(
    dbHandle,
    Array.from(new Set(rows.map((row) => row.id))),
  );
  for (const row of rows) {
    const calibrated = hard.get(row.id);
    const b = calibrated ?? difficultyToLogitB(row.difficulty);
    if (typeof b === 'number' && Number.isFinite(b)) out.set(row.id, b);
  }
  return out;
}

async function readThetaHatByKnowledgeId(
  dbHandle: Db | Tx,
  knowledgeIds: string[],
): Promise<Map<string, number>> {
  if (knowledgeIds.length === 0) return new Map();
  const mastery = await getMasteryStates(dbHandle, knowledgeIds, 'knowledge');
  return effectiveThetaForKcBatch(
    dbHandle,
    knowledgeIds.map((knowledgeId) => ({
      knowledgeId,
      thetaKc: mastery.get(knowledgeId)?.theta_hat ?? 0,
    })),
  );
}

// K 下首个未用 non-draft 题, created_at ASC, id ASC — the shared fallback序 used by
// both branches (matches the pre- fallback ordering exactly).
// Pure over the prefetched (created_at, id)-sorted bucket: `.find(unused)` returns the first
// AVAILABLE question directly, so a knowledge point whose leading questions are all already
// used this page still surfaces one past that prefix (the CodeRabbit F1 invariant — the
// bucket is the FULL list, never a `.limit(N)` page).
function firstForKnowledgePure(
  kcQuestions: Map<string, QuestionRow[]>,
  knowledgeId: string,
  usedQuestionIds: Set<string>,
): SelectedProbe | null {
  const rows = kcQuestions.get(knowledgeId) ?? [];
  const chosen = rows.find((row) => !usedQuestionIds.has(row.id));
  if (!chosen) return null;
  usedQuestionIds.add(chosen.id);
  return toProbe(chosen);
}

// The variant family of `familyRoot` still tagged K and non-draft, filtered in memory from
// the due-KC bucket. Family = { q ∈ bucket(K) : root_question_id = familyRoot OR id = familyRoot }.
// bucket(K) already enforces "non-draft AND tagged K", so this matches the readFamily SQL set.
function readFamilyPure(
  kcQuestions: Map<string, QuestionRow[]>,
  familyRoot: string,
  knowledgeId: string,
): QuestionRow[] {
  const rows = kcQuestions.get(knowledgeId) ?? [];
  return rows.filter((row) => row.root_question_id === familyRoot || row.id === familyRoot);
}

/**
 * Pick the deterministic probe question for a due knowledge point, PURE over a
 * {@link ProbeSelectionPrefetch}.
 *
 * Routing key = the kind of the question presented at the knowledge point's LAST review.
 * NULL last review → application default (first probe).
 *
 * - recall: re-present the last question (FSRS measures THIS recall item). If it was deleted /
 * demoted to draft / unlabelled K / already used → fall back to K's first non-draft question.
 * - application: rotate within the last question's root_question_id family, taking the next
 * member after the last (wrapping the ring). When fewer than two family members are unseen
 * in the recent window, pick another servable question on this knowledge point by mfiScore.
 * No such question → the family ring, including a one-member repeat.
 *
 * Mutates `usedQuestionIds` (adds the chosen id) so a question surfaces at most once per due
 * page (cross-knowledge dedup). Callers thread ONE shared set through the page in order — the
 * used-set is the only state, so a sequential loop over prefetched inputs is order-identical
 * to the old sequential DB loop.
 */
export function selectProbeFromPrefetch(
  prefetch: ProbeSelectionPrefetch,
  input: {
    knowledgeId: string;
    lastReviewEventId: string | null;
    usedQuestionIds: Set<string>;
  },
): SelectedProbe | null {
  const { knowledgeId, lastReviewEventId, usedQuestionIds } = input;
  const { kcQuestions } = prefetch;

  const lastQuestionId = lastReviewEventId
    ? (prefetch.lastQuestionIdByEventId.get(lastReviewEventId) ?? null)
    : null;
  // No prior review for this knowledge point → application default first probe
  // (族里 created_at 最早根题; firstForKnowledge IS that ordering).
  if (!lastQuestionId) {
    return firstForKnowledgePure(kcQuestions, knowledgeId, usedQuestionIds);
  }

  const lastQuestion = prefetch.questionRowById.get(lastQuestionId) ?? null;
  // Last question row vanished (hard-deleted) → no kind to route on → application
  // default first probe (most conservative; matches the recall fallback 序).
  if (!lastQuestion) {
    return firstForKnowledgePure(kcQuestions, knowledgeId, usedQuestionIds);
  }

  // Unknown/unclassifiable labels → undefined → the application branch below
  // (family rotation) — identical to the pre- dirty-value runtime path
  // (the enum map lookup returned undefined → `=== 'recall'` false).
  const cls = rotationClassForKind(lastQuestion.kind);

  if (cls === 'recall') {
    // Original-question repeat: re-present the same question iff it is still
    // non-draft, still tagged K, and not already used this page.
    const stillTagsK = (lastQuestion.knowledge_ids ?? []).includes(knowledgeId);
    if (isPoolVisible(lastQuestion) && stillTagsK && !usedQuestionIds.has(lastQuestion.id)) {
      usedQuestionIds.add(lastQuestion.id);
      return toProbe(lastQuestion);
    }
    // Deleted / demoted to draft / unlabelled K / already used → fallback.
    return firstForKnowledgePure(kcQuestions, knowledgeId, usedQuestionIds);
  }

  // application — variant-family rotation, widened when the family cannot move.
  const familyRoot = lastQuestion.root_question_id ?? lastQuestion.id;
  const familyAll = readFamilyPure(kcQuestions, familyRoot, knowledgeId);
  const familyUnused = familyAll.filter((row) => !usedQuestionIds.has(row.id));
  if (familyUnused.length === 0) {
    // Family minus used is empty → fall back to K's first 未用 non-draft 题.
    return firstForKnowledgePure(kcQuestions, knowledgeId, usedQuestionIds);
  }

  const chosen = chooseApplicationProbe(
    familyUnused,
    familyAll,
    kcQuestions.get(knowledgeId) ?? [],
    lastQuestion.id,
    usedQuestionIds,
    prefetch,
    knowledgeId,
  );
  usedQuestionIds.add(chosen.id);
  return toProbe(chosen);
}

function chooseApplicationProbe(
  familyUnused: QuestionRow[],
  familyAll: QuestionRow[],
  kcRows: QuestionRow[],
  lastQuestionId: string,
  usedQuestionIds: Set<string>,
  prefetch: ProbeSelectionPrefetch,
  knowledgeId: string,
): QuestionRow {
  const freshCount = familyAll.filter(
    (row) => !prefetch.recentlySeenQuestionIds.has(row.id),
  ).length;
  const widened =
    freshCount >= MIN_FRESH_FAMILY_MEMBERS
      ? []
      : widenCandidates(familyAll, kcRows, usedQuestionIds, prefetch.recentlySeenQuestionIds);
  if (widened.length > 0) return takeHighestMfi(widened, knowledgeId, prefetch);
  return takeFamilyRing(sortFamily(familyUnused), lastQuestionId);
}

function widenCandidates(
  familyAll: QuestionRow[],
  kcRows: QuestionRow[],
  usedQuestionIds: Set<string>,
  recentlySeen: ReadonlySet<string>,
): QuestionRow[] {
  const familyIds = new Set(familyAll.map((row) => row.id));
  return kcRows.filter(
    (row) =>
      !familyIds.has(row.id) &&
      !usedQuestionIds.has(row.id) &&
      !recentlySeen.has(row.id) &&
      // A recall item would lock the next review onto itself.
      rotationClassForKind(row.kind) !== 'recall',
  );
}

// Q_last 之后的下一个, 环绕. Q_last not in the ring (deleted / unlabelled K /
// already used) → take the 序首.
function takeFamilyRing(ordered: QuestionRow[], lastQuestionId: string): QuestionRow {
  const idx = ordered.findIndex((row) => row.id === lastQuestionId);
  const chosen = idx >= 0 ? ordered[(idx + 1) % ordered.length] : ordered[0];
  if (!chosen) throw new Error('application family ring is empty');
  return chosen;
}

// Ties keep sortFamily order, so equal information still moves once the winner
// becomes the last question and drops out of the widened pool.
function takeHighestMfi(
  candidates: QuestionRow[],
  knowledgeId: string,
  prefetch: ProbeSelectionPrefetch,
): QuestionRow {
  const ordered = sortFamily(candidates);
  let best = ordered[0];
  if (!best) throw new Error('widened probe pool is empty');
  let bestScore = mfiFor(best, knowledgeId, prefetch);
  for (const row of ordered.slice(1)) {
    const score = mfiFor(row, knowledgeId, prefetch);
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return best;
}

function mfiFor(row: QuestionRow, knowledgeId: string, prefetch: ProbeSelectionPrefetch): number {
  const theta = prefetch.thetaHatByKnowledgeId.get(knowledgeId) ?? 0;
  const b = prefetch.difficultyBByQuestionId.get(row.id);
  if (b === undefined || !Number.isFinite(b) || !Number.isFinite(theta)) {
    return Number.NEGATIVE_INFINITY;
  }
  return mfiScore(theta, b);
}

/**
 * Single-KC entry point — prefetch this one KC's inputs, then run the pure selection
 * core. Preserved for direct callers/tests; the batch `/api/review/due` path calls
 * {@link prefetchProbeSelection} ONCE for the whole page and loops {@link selectProbeFromPrefetch}.
 */
export async function pickProbeForKnowledge(
  dbHandle: Db,
  input: {
    knowledgeId: string;
    lastReviewEventId: string | null;
    usedQuestionIds: Set<string>;
  },
): Promise<SelectedProbe | null> {
  const prefetch = await prefetchProbeSelection(dbHandle, [
    { knowledgeId: input.knowledgeId, lastReviewEventId: input.lastReviewEventId },
  ]);
  return selectProbeFromPrefetch(prefetch, input);
}
