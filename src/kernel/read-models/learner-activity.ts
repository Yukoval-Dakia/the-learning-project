// Which events count as a learner answer or as learning activity, which subject
// such an event belongs to, when the learner last did any of it, and which recent
// answers on a knowledge point were correct. Consumers read these sets instead of
// spelling their own action lists.

import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  AttemptQuestionSnapshot,
  type AttemptQuestionSnapshotT,
} from '@/core/schema/question-evidence-snapshot';
import type { Db, Tx } from '@/db/client';
import {
  evaluation,
  event,
  knowledge,
  learning_record,
  question,
  question_revision,
} from '@/db/schema';
import { getCorrectionStatuses } from '@/kernel/events';
import { allowedEventIds } from '@/kernel/events/derivation-policy';
import {
  assessmentAttemptEventId,
  submissionIdFromAttemptEventId,
} from '@/kernel/records/assessment-attempt-identity';
import {
  nativeAttemptOutcome,
  resolveVerdictsForAttempts,
  resolveVerdictsForNativeAttempts,
} from './assessment-verdict';
import { loadMergedKnowledgeClosure } from './merged-knowledge';
import { batchResolveSubjectIds } from './subject-resolution';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;
export type AnswerOutcome = 'success' | 'failure' | 'partial';

const NATIVE_ATTEMPT_ACTION = 'experimental:assessment_attempt';
const RECORD_CAPTURE_ACTION = 'experimental:record_capture';

/** The learner answered a question: legacy attempt/review rows or a native attempt anchor. */
export const LEARNER_ANSWER_ACTIONS = ['attempt', 'review', NATIVE_ATTEMPT_ACTION] as const;

/** Answers plus captured learning records. */
export const LEARNING_ACTIVITY_ACTIONS = [
  ...LEARNER_ANSWER_ACTIONS,
  RECORD_CAPTURE_ACTION,
] as const;

/** Answers without `review`: the question delete warning counts attempts only. */
export const QUESTION_ATTEMPT_ACTIONS = ['attempt', NATIVE_ATTEMPT_ACTION] as const;

/** Newest learner-made, derivation-allowed learning activity, optionally strictly before `before`. */
export async function loadLastLearnerEventAt(db: DbLike, before?: Date): Promise<Date | null> {
  // Walk newest first, stopping at the first authorized activity. An aggregate
  // max() would evaluate the recursive policy for the learner's entire history.
  let cursor: { at: Date; id: string } | undefined;
  for (;;) {
    const rows = await db
      .select({ id: event.id, at: event.created_at })
      .from(event)
      .where(
        and(
          eq(event.actor_kind, 'user'),
          inArray(event.action, [...LEARNING_ACTIVITY_ACTIONS]),
          before ? lt(event.created_at, before) : undefined,
          cursor
            ? or(
                lt(event.created_at, cursor.at),
                and(eq(event.created_at, cursor.at), lt(event.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(event.created_at), desc(event.id))
      .limit(32);
    if (!rows.length) return null;
    const allowed = await allowedEventIds(
      db,
      rows.map((row) => row.id),
    );
    const latest = rows.find((row) => allowed.has(row.id));
    if (latest) return asDate(latest.at);
    if (rows.length < 32) return null;
    const last = rows[rows.length - 1];
    cursor = { at: last.at, id: last.id };
  }
}

/**
 * Graded outcome of native attempt anchors, whose event row stores outcome null.
 * Pending, self-reported and unsupported verdicts carry no right/wrong bit and are
 * left out.
 */
export async function loadNativeAttemptOutcomes(
  db: DbLike,
  eventIds: string[],
): Promise<Map<string, AnswerOutcome>> {
  const out = new Map<string, AnswerOutcome>();
  if (eventIds.length === 0) return out;
  const rows = await db
    .select()
    .from(event)
    .where(and(inArray(event.id, eventIds), eq(event.action, NATIVE_ATTEMPT_ACTION)));
  if (rows.length === 0) return out;
  const verdicts = await resolveVerdictsForNativeAttempts(db, rows);
  for (const [eventId, verdict] of verdicts) {
    const outcome = nativeAttemptOutcome(verdict);
    if (outcome === 'success' || outcome === 'failure' || outcome === 'partial')
      out.set(eventId, outcome);
  }
  return out;
}

export interface LastKnowledgePractice {
  /** When the learner answered. */
  at: string;
  /** null when the newest answer has no usable verdict (pending, self-report, unsupported). */
  outcome: AnswerOutcome | null;
}

// Newest-first page width for the practice walk; one page usually answers the read.
const PRACTICE_PAGE = 32;
// A card read never needs the learner's whole history; once restricted or
// non-matching rows fill this many pages, report no practice instead of walking on.
const PRACTICE_MAX_PAGES = 32;

/**
 * Superset filter for native attempts: the frozen submission receipt's learning
 * scope mentions this knowledge point somewhere. The exact issued membership is
 * decided below by `issuedLearningKnowledgeIds`, never by live question tags.
 */
function nativeScopeMentions(kc: string) {
  return sql`EXISTS (
    SELECT 1 FROM ${event} receipt
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(receipt.payload->'learning_scope'->'questions') = 'array'
        THEN receipt.payload->'learning_scope'->'questions' ELSE '[]'::jsonb END
    ) q
    WHERE receipt.action = 'experimental:assessment_submission'
      AND receipt.subject_kind = 'submission'
      AND receipt.subject_id = ${event.payload}->>'submission_id'
      AND q->'knowledge_ids' @> ${kc}::jsonb
  )`;
}

function mapCoarseVerdict(value: unknown): AnswerOutcome | null {
  return value === 'correct'
    ? 'success'
    : value === 'incorrect'
      ? 'failure'
      : value === 'partial'
        ? 'partial'
        : null;
}

function mapStoredOutcome(value: unknown): AnswerOutcome | null {
  return value === 'success' || value === 'failure' || value === 'partial' ? value : null;
}

/**
 * Card outcome for one legacy answer. A judge record that currently yields no
 * effective verdict (retracted, superseded) means "no usable verdict", not the
 * first outcome the row happened to store; a pure legacy attempt with no judge
 * rows keeps its own outcome. `loadLegacyAnswerOutcomes` below remains the
 * activity-wide reader and is deliberately untouched.
 */
async function loadCardLegacyOutcome(db: DbLike, row: EventRow): Promise<AnswerOutcome | null> {
  if (isUnsupportedAttemptPayload(row.payload)) return null;
  const verdict = (await resolveVerdictsForAttempts(db, [row.id])).get(row.id);
  const effective = verdict?.effective?.verdict.coarse_outcome;
  const mapped = mapCoarseVerdict(effective);
  if (mapped) return mapped;
  if (effective === 'unsupported') return null;
  // `original` non-null means judge rows exist for this attempt; with no effective
  // verdict they were all retracted or superseded.
  if (verdict?.original) return null;
  return mapStoredOutcome(row.outcome);
}

/**
 * The newest learner answer touching the node, with its effective outcome. Only
 * derivation-allowed answers count, so restricted material never reaches a card.
 * Native attempts are attributed by the frozen learning scope and the issued
 * parts, never by mutable question tags; a denied candidate walks on instead of
 * ending the read. Legacy attempt/review rows carry `referenced_knowledge_ids`.
 * The node's merged_from closure is included, so the newer answer on either side wins.
 */
export async function loadLastKnowledgePractice(
  db: DbLike,
  knowledgeId: string,
): Promise<LastKnowledgePractice | null> {
  const historyIds = [...(await loadMergedKnowledgeClosure(db)).closure(knowledgeId)];
  const history = new Set(historyIds);
  let cursor: { at: Date; id: string } | undefined;
  for (let page = 0; ; page += 1) {
    if (page >= PRACTICE_MAX_PAGES) return null;
    const rows: EventRow[] = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.actor_kind, 'user'),
          inArray(event.action, [...LEARNER_ANSWER_ACTIONS]),
          eq(event.subject_kind, 'question'),
          or(
            and(
              eq(event.action, NATIVE_ATTEMPT_ACTION),
              nativeLearningScopeMentionsAny(historyIds),
            ),
            and(sql`${event.action} <> ${NATIVE_ATTEMPT_ACTION}`, legacyMentionsAny(historyIds)),
          ),
          cursor
            ? or(
                lt(event.created_at, cursor.at),
                and(eq(event.created_at, cursor.at), lt(event.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(event.created_at), desc(event.id))
      .limit(PRACTICE_PAGE);
    if (rows.length === 0) return null;

    const allowed = await allowedEventIds(
      db,
      rows.map((row) => row.id),
    );
    const authorized = rows.filter((row) => allowed.has(row.id));
    if (authorized.length > 0) {
      const nativeRows = authorized.filter((row) => row.action === NATIVE_ATTEMPT_ACTION);
      const nativeVerdicts =
        nativeRows.length > 0 ? await resolveVerdictsForNativeAttempts(db, nativeRows) : null;
      for (const row of authorized) {
        if (row.action === NATIVE_ATTEMPT_ACTION) {
          const verdict = nativeVerdicts?.get(row.id);
          if (!verdict?.knowledge_ids.some((id) => history.has(id))) continue;
          const outcome = nativeAttemptOutcome(verdict);
          return {
            at: row.created_at.toISOString(),
            outcome:
              outcome === 'success' || outcome === 'failure' || outcome === 'partial'
                ? outcome
                : null,
          };
        }
        return { at: row.created_at.toISOString(), outcome: await loadCardLegacyOutcome(db, row) };
      }
    }

    if (rows.length < PRACTICE_PAGE) return null;
    const last = rows[rows.length - 1];
    cursor = { at: last.created_at, id: last.id };
  }
}

export interface KnowledgeFailureStreak {
  knowledge_id: string;
  knowledge_name: string;
  /** Consecutive failed answers on this knowledge point, newest backwards. */
  count: number;
}

export interface KnowledgeFailureRun {
  /** Consecutive failed answers, newest backwards. Zero is a measured run that a success ended. */
  count: number;
}

const FAILURE_STREAK_SCAN_LIMIT = 200;

/**
 * Current failure run per knowledge point. Answers with no right/wrong bit and
 * contested answers are skipped; a success or partial ends the run. An answer
 * on a node merged into a live survivor also advances that survivor's run. Only the
 * newest FAILURE_STREAK_SCAN_LIMIT derivation-allowed answers count. A missing
 * id means the run length is 0, which the caller must not confuse with a failed scan.
 */
export async function loadKnowledgeFailureStreaks(
  db: DbLike,
  knowledgeIds: readonly string[],
): Promise<Map<string, number>> {
  const wanted = [...new Set(knowledgeIds)];
  const out = new Map(wanted.map((id) => [id, 0]));
  if (wanted.length === 0) return out;
  const runs = await loadFailureRuns(db);
  for (const id of wanted) out.set(id, runs.get(id) ?? 0);
  return out;
}

async function loadFailureRuns(db: DbLike): Promise<Map<string, number>> {
  const rows: EventRow[] = [];
  let cursor: EventRow | undefined;
  // Page candidates until the authorized window is full; restricted answers
  // cannot consume its slots. Keyset order stays stable for equal timestamps.
  for (;;) {
    const candidates: EventRow[] = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.actor_kind, 'user'),
          inArray(event.action, [...LEARNER_ANSWER_ACTIONS]),
          eq(event.subject_kind, 'question'),
          cursor
            ? or(
                lt(event.created_at, cursor.created_at),
                and(eq(event.created_at, cursor.created_at), lt(event.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(event.created_at), desc(event.id))
      .limit(FAILURE_STREAK_SCAN_LIMIT);
    if (!candidates.length) break;
    const allowed = await allowedEventIds(
      db,
      candidates.map((row) => row.id),
    );
    rows.push(...candidates.filter((row) => allowed.has(row.id)));
    if (rows.length >= FAILURE_STREAK_SCAN_LIMIT) {
      rows.length = FAILURE_STREAK_SCAN_LIMIT;
      break;
    }
    if (candidates.length < FAILURE_STREAK_SCAN_LIMIT) break;
    cursor = candidates[candidates.length - 1];
  }
  const runs = new Map<string, { count: number; ended: boolean }>();
  if (rows.length === 0) return new Map();
  const merged = await loadMergedKnowledgeClosure(db);
  const nativeVerdicts = await resolveVerdictsForNativeAttempts(db, rows);
  const legacyOutcomes = await loadLegacyAnswerOutcomes(db, rows);
  const contested = await loadContestedAttemptIds(
    db,
    rows.map((row) => row.id),
  );
  for (const row of rows) {
    if (contested.has(row.id)) continue;
    const native = row.action === NATIVE_ATTEMPT_ACTION ? nativeVerdicts.get(row.id) : undefined;
    if (row.action === NATIVE_ATTEMPT_ACTION && !native) continue;
    const outcome = native ? nativeAttemptOutcome(native) : legacyOutcomes.get(row.id);
    if (outcome !== 'success' && outcome !== 'failure' && outcome !== 'partial') continue;
    const knowledgeIds = native
      ? native.knowledge_ids
      : stringArrayField(row.payload, 'referenced_knowledge_ids');
    const targets = new Set<string>();
    for (const knowledgeId of knowledgeIds) {
      targets.add(knowledgeId);
      const winner = merged.liveWinner(knowledgeId);
      if (winner) targets.add(winner);
    }
    for (const knowledgeId of targets) {
      const run = runs.get(knowledgeId) ?? { count: 0, ended: false };
      if (run.ended) continue;
      if (outcome === 'failure') run.count += 1;
      else run.ended = true;
      runs.set(knowledgeId, run);
    }
  }
  return new Map([...runs].map(([id, run]) => [id, run.count]));
}

/**
 * Observed failure runs only. A missing id was not in the scanned window and is
 * not a measured zero. Same answers as {@link loadKnowledgeFailureStreaks}.
 */
export async function loadKnowledgeFailureRuns(
  db: DbLike,
): Promise<Map<string, KnowledgeFailureRun>> {
  const runs = await loadFailureRuns(db);
  return new Map([...runs].map(([id, count]) => [id, { count }]));
}

/**
 * The knowledge point with the longest current run of failed answers.
 * Same run as {@link loadKnowledgeFailureStreaks}.
 */
export async function loadLongestFailureStreak(db: DbLike): Promise<KnowledgeFailureStreak | null> {
  const runs = await loadFailureRuns(db);
  let best: { knowledgeId: string; count: number } | null = null;
  for (const [knowledgeId, count] of runs) {
    if (count === 0) continue;
    if (!best || count > best.count || (count === best.count && knowledgeId < best.knowledgeId))
      best = { knowledgeId, count };
  }
  if (!best) return null;
  const [node] = await db
    .select({ name: knowledge.name })
    .from(knowledge)
    .where(and(eq(knowledge.id, best.knowledgeId), isNull(knowledge.archived_at)))
    .limit(1);
  return node
    ? { knowledge_id: best.knowledgeId, knowledge_name: node.name, count: best.count }
    : null;
}

// Keep each id list under the event-query parameter cap.
const ID_CHUNK = 64;

function chunked<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let offset = 0; offset < items.length; offset += ID_CHUNK)
    out.push(items.slice(offset, offset + ID_CHUNK));
  return out;
}

/**
 * Outcome of legacy attempt/review rows. The event row keeps its first outcome
 * after a rejudge, so the effective judge wins when it says right/wrong;
 * unsupported answers are left out.
 */
async function loadLegacyAnswerOutcomes(
  db: DbLike,
  rows: EventRow[],
): Promise<Map<string, AnswerOutcome>> {
  const out = new Map<string, AnswerOutcome>();
  const legacy = rows.filter((row) => row.action !== NATIVE_ATTEMPT_ACTION);
  if (legacy.length === 0) return out;
  const ids = legacy.map((row) => row.id);
  const verdicts = await resolveVerdictsForAttempts(db, ids);
  for (const row of legacy) {
    if (isUnsupportedAttemptPayload(row.payload)) continue;
    const effective = verdicts.get(row.id)?.effective?.verdict.coarse_outcome;
    if (effective === 'unsupported') continue;
    const outcome =
      effective === 'correct'
        ? 'success'
        : effective === 'incorrect'
          ? 'failure'
          : effective === 'partial'
            ? 'partial'
            : row.outcome;
    if (outcome === 'success' || outcome === 'failure' || outcome === 'partial')
      out.set(row.id, outcome);
  }
  return out;
}

function isUnsupportedAttemptPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const value = payload as { unsupported_judge?: unknown; judge?: { coarse_outcome?: unknown } };
  return value.unsupported_judge === true || value.judge?.coarse_outcome === 'unsupported';
}

/**
 * Answers whose verdict is contested: a judge event that is no longer active or
 * carries an appeal (found through subject_id, then caused_by, like the verdict
 * resolver), or a native attempt whose evaluation carries a grading-correction
 * appeal. Any appeal ever filed counts, so a contested answer never feeds a streak.
 */
async function loadContestedAttemptIds(db: DbLike, attemptIds: string[]): Promise<Set<string>> {
  const attemptIdSet = new Set(attemptIds);
  const attemptByJudge = new Map<string, string>();
  for (const chunk of chunked(attemptIds)) {
    const judgeColumns = {
      id: event.id,
      subjectId: event.subject_id,
      causedById: event.caused_by_event_id,
    };
    const isJudge = and(eq(event.action, 'judge'), eq(event.subject_kind, 'event'));
    const [bySubject, byCause] = await Promise.all([
      db
        .select(judgeColumns)
        .from(event)
        .where(and(isJudge, inArray(event.subject_id, chunk))),
      db
        .select(judgeColumns)
        .from(event)
        .where(and(isJudge, inArray(event.caused_by_event_id, chunk))),
    ]);
    for (const judge of [...bySubject, ...byCause]) {
      const attemptId = attemptIdSet.has(judge.subjectId) ? judge.subjectId : judge.causedById;
      if (attemptId && attemptIdSet.has(attemptId)) attemptByJudge.set(judge.id, attemptId);
    }
  }

  const contested = new Set<string>();
  for (const chunk of chunked([...attemptByJudge.keys()])) {
    for (const [judgeId, status] of await getCorrectionStatuses(db, chunk)) {
      const attemptId = attemptByJudge.get(judgeId);
      if (status.state !== 'active' && attemptId) contested.add(attemptId);
    }
    const appeals = await db
      .select({ subjectId: event.subject_id })
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:appeal_request'),
          eq(event.subject_kind, 'event'),
          inArray(event.subject_id, chunk),
        ),
      );
    for (const appeal of appeals) {
      const attemptId = attemptByJudge.get(appeal.subjectId);
      if (attemptId) contested.add(attemptId);
    }
  }

  const submissionIds = attemptIds
    .map(submissionIdFromAttemptEventId)
    .filter((id): id is string => id !== null);
  const submissionByEvaluation = new Map<string, string>();
  for (const chunk of chunked(submissionIds)) {
    const evaluations = await db
      .select({ evaluationId: evaluation.evaluation_id, submissionId: evaluation.submission_id })
      .from(evaluation)
      .where(inArray(evaluation.submission_id, chunk));
    for (const row of evaluations) submissionByEvaluation.set(row.evaluationId, row.submissionId);
  }
  for (const chunk of chunked([...submissionByEvaluation.keys()])) {
    const appeals = await db
      .select({ subjectId: event.subject_id })
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:appeal_request'),
          eq(event.subject_kind, 'evaluation'),
          inArray(event.subject_id, chunk),
        ),
      );
    for (const appeal of appeals) {
      const submissionId = submissionByEvaluation.get(appeal.subjectId);
      if (submissionId) contested.add(assessmentAttemptEventId(submissionId));
    }
  }
  return contested;
}

export interface LearningEventRef {
  id: string;
  action: string;
  subject_kind: string;
  subject_id: string;
  payload: unknown;
}

/**
 * What to do with an event whose subject cannot be read from its own evidence: a
 * capture without a usable record, or a native attempt whose question has no
 * knowledge ids. `default_subject` maps it to the default profile; `omit` leaves
 * it out of the result.
 */
export type UnresolvedLearningEventSubject = 'default_subject' | 'omit';

type SubjectSource =
  | { kind: 'knowledge'; knowledgeIds: string[] }
  | { kind: 'explicit'; subjectId: string }
  | { kind: 'unresolved' };

/**
 * Resolve each event to a subject id. A capture reads its learning_record (knowledge
 * ids first, then the record's own subject_id). A native attempt reads its question's
 * knowledge ids (the answered part, else the revision's group). Every other action
 * reads payload `referenced_knowledge_ids`; an empty list resolves to the default.
 */
export async function resolveLearningEventSubjects(
  db: DbLike,
  rows: LearningEventRef[],
  unresolved: UnresolvedLearningEventSubject,
): Promise<Map<string, string>> {
  const records = await loadCaptureRecords(db, rows);
  const nativeKnowledge = await loadNativeAttemptKnowledge(db, rows);

  const explicit = new Map<string, string>();
  const resolveInput: Array<{ id: string; knowledge_ids: string[] }> = [];
  for (const row of rows) {
    const source = subjectSource(row, records, nativeKnowledge);
    if (source.kind === 'explicit') explicit.set(row.id, source.subjectId);
    else if (source.kind === 'knowledge')
      resolveInput.push({ id: row.id, knowledge_ids: source.knowledgeIds });
    else if (unresolved === 'default_subject') resolveInput.push({ id: row.id, knowledge_ids: [] });
  }
  const resolved =
    resolveInput.length > 0 ? await batchResolveSubjectIds(db, resolveInput) : new Map();
  for (const [eventId, subjectId] of explicit) resolved.set(eventId, subjectId);
  return resolved;
}

function subjectSource(
  row: LearningEventRef,
  records: Map<string, { knowledge_ids: string[]; subject_id: string | null }>,
  nativeKnowledge: Map<string, string[]>,
): SubjectSource {
  if (row.action === RECORD_CAPTURE_ACTION) {
    const rec = records.get(row.subject_id);
    if (!rec) return { kind: 'unresolved' };
    if (rec.knowledge_ids.length > 0) return { kind: 'knowledge', knowledgeIds: rec.knowledge_ids };
    return rec.subject_id
      ? { kind: 'explicit', subjectId: rec.subject_id }
      : { kind: 'unresolved' };
  }
  if (row.action === NATIVE_ATTEMPT_ACTION) {
    const knowledgeIds = nativeKnowledge.get(row.id) ?? [];
    return knowledgeIds.length > 0 ? { kind: 'knowledge', knowledgeIds } : { kind: 'unresolved' };
  }
  return {
    kind: 'knowledge',
    knowledgeIds: stringArrayField(row.payload, 'referenced_knowledge_ids'),
  };
}

async function loadCaptureRecords(
  db: DbLike,
  rows: LearningEventRef[],
): Promise<Map<string, { knowledge_ids: string[]; subject_id: string | null }>> {
  const ids = [
    ...new Set(rows.filter((row) => row.action === RECORD_CAPTURE_ACTION).map((r) => r.subject_id)),
  ];
  const out = new Map<string, { knowledge_ids: string[]; subject_id: string | null }>();
  if (ids.length === 0) return out;
  const found = await db
    .select({
      id: learning_record.id,
      knowledge_ids: learning_record.knowledge_ids,
      subject_id: learning_record.subject_id,
    })
    .from(learning_record)
    .where(inArray(learning_record.id, ids));
  for (const rec of found)
    out.set(rec.id, { knowledge_ids: rec.knowledge_ids, subject_id: rec.subject_id });
  return out;
}

/** Native attempt event id → its question's knowledge ids. */
async function loadNativeAttemptKnowledge(
  db: DbLike,
  rows: LearningEventRef[],
): Promise<Map<string, string[]>> {
  const natives = rows.filter((row) => row.action === NATIVE_ATTEMPT_ACTION);
  const out = new Map<string, string[]>();
  if (natives.length === 0) return out;

  const revisionIds = [
    ...new Set(
      natives.flatMap((row) => {
        if (answeredPartId(row)) return [];
        const revisionId = stringField(row.payload, 'revision_id');
        return revisionId ? [revisionId] : [];
      }),
    ),
  ];
  const groupByRevision = new Map<string, string>();
  if (revisionIds.length > 0) {
    const revisions = await db
      .select({ revision_id: question_revision.revision_id, group_id: question_revision.group_id })
      .from(question_revision)
      .where(inArray(question_revision.revision_id, revisionIds));
    for (const revision of revisions) groupByRevision.set(revision.revision_id, revision.group_id);
  }

  const questionByEvent = new Map<string, string>();
  for (const row of natives) {
    const revisionId = stringField(row.payload, 'revision_id');
    const questionId =
      answeredPartId(row) || (revisionId ? (groupByRevision.get(revisionId) ?? '') : '');
    if (questionId) questionByEvent.set(row.id, questionId);
  }
  const questionIds = [...new Set(questionByEvent.values())];
  if (questionIds.length === 0) return out;
  const items = await db
    .select({ id: question.id, knowledge_ids: question.knowledge_ids })
    .from(question)
    .where(inArray(question.id, questionIds));
  const knowledgeByQuestion = new Map(items.map((item) => [item.id, item.knowledge_ids ?? []]));
  for (const [eventId, questionId] of questionByEvent)
    out.set(eventId, knowledgeByQuestion.get(questionId) ?? []);
  return out;
}

function answeredPartId(row: LearningEventRef): string {
  return row.subject_kind === 'question' ? row.subject_id : '';
}

function stringField(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== 'object' || !(key in payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringArrayField(payload: unknown, key: string): string[] {
  if (!payload || typeof payload !== 'object' || !(key in payload)) return [];
  const value = (payload as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string');
}

// Newest-first pages while filling a small per-knowledge sample. Absence past
// this bound does not mean the knowledge point has no later correct answer.
const CORRECT_ATTEMPT_PAGE = 32;
const CORRECT_ATTEMPT_MAX_PAGES = 8;

export interface CorrectKnowledgeAttempt {
  attempt_event_id: string;
  question_id: string;
  knowledge_ids: string[];
  created_at: Date;
  answer_md: string | null;
  answer_image_refs: string[];
  /**
   * undefined: legacy row with no snapshot (the live question is usable only when
   * it has not changed since the attempt). null: do not fall back to the live question.
   */
  question_snapshot: AttemptQuestionSnapshotT | null | undefined;
  /** Part prompt frozen on a native revision. Legacy rows leave this null. */
  frozen_prompt_md: string | null;
}

function legacyAnswerText(row: EventRow): {
  answer_md: string | null;
  answer_image_refs: string[];
} {
  const payload = (row.payload ?? {}) as {
    answer_md?: unknown;
    user_response_md?: unknown;
    answer_image_refs?: unknown;
  };
  const answer =
    row.action === 'review'
      ? typeof payload.user_response_md === 'string'
        ? payload.user_response_md
        : null
      : typeof payload.answer_md === 'string'
        ? payload.answer_md
        : null;
  const images = Array.isArray(payload.answer_image_refs)
    ? payload.answer_image_refs.filter((id): id is string => typeof id === 'string')
    : [];
  return { answer_md: answer, answer_image_refs: images };
}

function legacyQuestionSnapshot(row: EventRow): AttemptQuestionSnapshotT | null | undefined {
  const raw = (row.payload as { question_snapshot?: unknown } | null)?.question_snapshot;
  if (raw === undefined) return undefined;
  const parsed = AttemptQuestionSnapshot.safeParse(raw);
  if (!parsed.success || parsed.data.question.question_id !== row.subject_id) return null;
  return parsed.data;
}

function nativeFrozenPrompt(
  parts: readonly { part_id: string; prompt_md: string }[] | undefined,
  questionId: string,
): string | null {
  if (!parts || parts.length === 0) return null;
  const part =
    parts.find((item) => item.part_id === questionId) ??
    (parts.length === 1 ? parts[0] : undefined);
  const text = part?.prompt_md.trim();
  return text ? text : null;
}

/** Superset filter. Issued membership is still `issuedLearningKnowledgeIds`. */
export function nativeLearningScopeMentionsAny(knowledgeIds: readonly string[]) {
  // nativeScopeMentions casts its argument as jsonb; the caller must pass a JSON array.
  return or(...knowledgeIds.map((id) => nativeScopeMentions(JSON.stringify([id]))));
}

function legacyMentionsAny(knowledgeIds: readonly string[]) {
  return or(
    ...knowledgeIds.map(
      (id) => sql`${event.payload}->'referenced_knowledge_ids' @> ${JSON.stringify([id])}::jsonb`,
    ),
  );
}

function pushCorrectAttempt(
  out: Map<string, CorrectKnowledgeAttempt[]>,
  attempt: CorrectKnowledgeAttempt,
  limit: number,
) {
  for (const knowledgeId of attempt.knowledge_ids) {
    const list = out.get(knowledgeId);
    if (!list || list.length >= limit) continue;
    if (list.some((item) => item.attempt_event_id === attempt.attempt_event_id)) continue;
    list.push(attempt);
  }
}

/**
 * Newest derivation-allowed correct answers on the requested knowledge points,
 * since `since`. Partial, pending, unsupported, and contested answers are left
 * out. Native prompts come from the frozen revision part; they are not read off
 * the live question row.
 *
 * The default read is a sample: at most `limitPerKnowledge` each, and at most
 * eight pages. A caller that treats a missing answer as "no later independent
 * success" must set `exhaustive`. That read keeps every match in the window,
 * because an older success can be the one that cleared a failure before a
 * newer page of unrelated answers.
 */
export async function loadRecentCorrectAttemptsForKnowledge(
  db: DbLike,
  input:
    | {
        knowledgeIds: readonly string[];
        since: Date;
        limitPerKnowledge: number;
        exhaustive?: false;
      }
    | {
        knowledgeIds: readonly string[];
        since: Date;
        exhaustive: true;
      },
): Promise<Map<string, CorrectKnowledgeAttempt[]>> {
  const wanted = [...new Set(input.knowledgeIds)];
  const out = new Map(wanted.map((id) => [id, [] as CorrectKnowledgeAttempt[]]));
  const exhaustive = input.exhaustive === true;
  const sampleLimit = input.exhaustive === true ? 0 : input.limitPerKnowledge;
  if (wanted.length === 0 || (!exhaustive && sampleLimit <= 0)) return out;
  const wantedSet = new Set(wanted);
  const keep = exhaustive ? Number.POSITIVE_INFINITY : sampleLimit;
  const filled = () => wanted.every((id) => (out.get(id)?.length ?? 0) >= keep);
  let cursor: { at: Date; id: string } | undefined;

  for (let page = 0; (exhaustive || page < CORRECT_ATTEMPT_MAX_PAGES) && !filled(); page += 1) {
    const legacy = legacyMentionsAny(wanted);
    const rows: EventRow[] = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.actor_kind, 'user'),
          inArray(event.action, [...LEARNER_ANSWER_ACTIONS]),
          eq(event.subject_kind, 'question'),
          gte(event.created_at, input.since),
          or(
            and(eq(event.action, NATIVE_ATTEMPT_ACTION), nativeLearningScopeMentionsAny(wanted)),
            and(inArray(event.action, ['attempt', 'review']), legacy),
          ),
          cursor
            ? or(
                lt(event.created_at, cursor.at),
                and(eq(event.created_at, cursor.at), lt(event.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(event.created_at), desc(event.id))
      .limit(CORRECT_ATTEMPT_PAGE);
    if (rows.length === 0) break;

    const allowed = await allowedEventIds(
      db,
      rows.map((row) => row.id),
    );
    const authorized = rows.filter((row) => allowed.has(row.id));
    const contested =
      authorized.length > 0
        ? await loadContestedAttemptIds(
            db,
            authorized.map((row) => row.id),
          )
        : new Set<string>();
    const nativeRows = authorized.filter((row) => row.action === NATIVE_ATTEMPT_ACTION);
    const legacyRows = authorized.filter((row) => row.action !== NATIVE_ATTEMPT_ACTION);
    const nativeVerdicts =
      nativeRows.length > 0 ? await resolveVerdictsForNativeAttempts(db, nativeRows) : null;
    const legacyOutcomes =
      legacyRows.length > 0 ? await loadLegacyAnswerOutcomes(db, legacyRows) : null;

    for (const row of authorized) {
      if (contested.has(row.id)) continue;
      if (row.action === NATIVE_ATTEMPT_ACTION) {
        const verdict = nativeVerdicts?.get(row.id);
        if (!verdict || nativeAttemptOutcome(verdict) !== 'success') continue;
        const knowledgeIds = verdict.knowledge_ids.filter((id) => wantedSet.has(id));
        if (knowledgeIds.length === 0) continue;
        const response = (row.payload as { response_md?: unknown } | null)?.response_md;
        pushCorrectAttempt(
          out,
          {
            attempt_event_id: row.id,
            question_id: row.subject_id,
            knowledge_ids: knowledgeIds,
            created_at: row.created_at,
            answer_md: typeof response === 'string' ? response : null,
            answer_image_refs: [],
            question_snapshot: null,
            frozen_prompt_md: nativeFrozenPrompt(verdict.revision.structure.parts, row.subject_id),
          },
          keep,
        );
        continue;
      }
      if (legacyOutcomes?.get(row.id) !== 'success') continue;
      const knowledgeIds = stringArrayField(row.payload, 'referenced_knowledge_ids').filter((id) =>
        wantedSet.has(id),
      );
      if (knowledgeIds.length === 0) continue;
      const answer = legacyAnswerText(row);
      pushCorrectAttempt(
        out,
        {
          attempt_event_id: row.id,
          question_id: row.subject_id,
          knowledge_ids: knowledgeIds,
          created_at: row.created_at,
          answer_md: answer.answer_md,
          answer_image_refs: answer.answer_image_refs,
          question_snapshot: legacyQuestionSnapshot(row),
          frozen_prompt_md: null,
        },
        keep,
      );
    }

    if (rows.length < CORRECT_ATTEMPT_PAGE) break;
    const last = rows[rows.length - 1];
    if (
      exhaustive &&
      cursor &&
      last.created_at.getTime() === cursor.at.getTime() &&
      last.id === cursor.id
    ) {
      throw new Error('independent success scan repeated a page');
    }
    cursor = { at: last.created_at, id: last.id };
  }
  return out;
}

const SETTLED_ANSWER_PAGE = 32;
const SETTLED_ANSWER_MAX_PAGES = 64;

export interface SettledKnowledgeAnswerCounts {
  correct: number;
  wrong: number;
  partial: number;
}

const SETTLED_COUNT_FIELD = {
  success: 'correct',
  failure: 'wrong',
  partial: 'partial',
} as const satisfies Record<AnswerOutcome, keyof SettledKnowledgeAnswerCounts>;

function emptySettledCounts(
  knowledgeIds: readonly string[],
): Map<string, SettledKnowledgeAnswerCounts> {
  return new Map(knowledgeIds.map((id) => [id, { correct: 0, wrong: 0, partial: 0 }]));
}

function addSettledCount(
  counts: Map<string, SettledKnowledgeAnswerCounts>,
  knowledgeIds: readonly string[],
  outcome: AnswerOutcome,
) {
  const field = SETTLED_COUNT_FIELD[outcome];
  for (const knowledgeId of knowledgeIds) {
    const row = counts.get(knowledgeId);
    if (!row) continue;
    row[field] += 1;
  }
}

interface MergedSettledCountScope {
  /** Every id the candidate scan must admit: each request's live closure. */
  scanIds: readonly string[];
  /** Answer knowledge id → requested plan ids that receive one count. */
  attributeTo: ReadonlyMap<string, readonly string[]>;
}

async function mergedSettledCountScope(
  db: DbLike,
  requested: readonly string[],
): Promise<MergedSettledCountScope> {
  const merged = await loadMergedKnowledgeClosure(db);
  const attributeTo = new Map<string, string[]>();
  for (const planId of requested) {
    const winner = merged.liveWinner(planId) ?? planId;
    for (const member of merged.closure(winner)) {
      const targets = attributeTo.get(member);
      if (!targets) {
        attributeTo.set(member, [planId]);
        continue;
      }
      if (!targets.includes(planId)) targets.push(planId);
    }
  }
  return { scanIds: [...attributeTo.keys()], attributeTo };
}

function planIdsForSettledAnswer(
  answerKnowledgeIds: readonly string[],
  attributeTo: ReadonlyMap<string, readonly string[]>,
): string[] {
  const planIds: string[] = [];
  const seen = new Set<string>();
  for (const knowledgeId of answerKnowledgeIds) {
    for (const planId of attributeTo.get(knowledgeId) ?? []) {
      if (seen.has(planId)) continue;
      seen.add(planId);
      planIds.push(planId);
    }
  }
  return planIds;
}

/**
 * Settled right/wrong/partial counts on the requested knowledge points in
 * `[since, until)`. Each request is resolved through its live winner, then
 * counted across that node's merged closure; totals stay keyed by the
 * requested ids. Pending, unsupported, and contested answers are left out.
 * `complete: false` means the page cap stopped the scan: a zero is then not
 * proof that the point was skipped.
 */
export async function loadSettledKnowledgeAnswerCounts(
  db: DbLike,
  input: { knowledgeIds: readonly string[]; since: Date; until: Date },
): Promise<{ complete: boolean; counts: Map<string, SettledKnowledgeAnswerCounts> }> {
  const wanted = [...new Set(input.knowledgeIds)];
  const counts = emptySettledCounts(wanted);
  if (wanted.length === 0 || input.until.getTime() <= input.since.getTime()) {
    return { complete: true, counts };
  }
  const scope = await mergedSettledCountScope(db, wanted);
  let cursor: { at: Date; id: string } | undefined;
  for (let page = 0; page < SETTLED_ANSWER_MAX_PAGES; page += 1) {
    const legacy = legacyMentionsAny(scope.scanIds);
    const rows: EventRow[] = await db
      .select()
      .from(event)
      .where(
        and(
          eq(event.actor_kind, 'user'),
          inArray(event.action, [...LEARNER_ANSWER_ACTIONS]),
          eq(event.subject_kind, 'question'),
          gte(event.created_at, input.since),
          lt(event.created_at, input.until),
          or(
            and(eq(event.action, NATIVE_ATTEMPT_ACTION), nativeLearningScopeMentionsAny(scope.scanIds)),
            and(inArray(event.action, ['attempt', 'review']), legacy),
          ),
          cursor
            ? or(
                lt(event.created_at, cursor.at),
                and(eq(event.created_at, cursor.at), lt(event.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(event.created_at), desc(event.id))
      .limit(SETTLED_ANSWER_PAGE);
    if (rows.length === 0) return { complete: true, counts };

    const allowed = await allowedEventIds(
      db,
      rows.map((row) => row.id),
    );
    const authorized = rows.filter((row) => allowed.has(row.id));
    const contested =
      authorized.length > 0
        ? await loadContestedAttemptIds(
            db,
            authorized.map((row) => row.id),
          )
        : new Set<string>();
    const nativeRows = authorized.filter((row) => row.action === NATIVE_ATTEMPT_ACTION);
    const legacyRows = authorized.filter((row) => row.action !== NATIVE_ATTEMPT_ACTION);
    const nativeVerdicts =
      nativeRows.length > 0 ? await resolveVerdictsForNativeAttempts(db, nativeRows) : null;
    const legacyOutcomes =
      legacyRows.length > 0 ? await loadLegacyAnswerOutcomes(db, legacyRows) : null;

    for (const row of authorized) {
      if (contested.has(row.id)) continue;
      if (row.action === NATIVE_ATTEMPT_ACTION) {
        const verdict = nativeVerdicts?.get(row.id);
        const outcome = nativeAttemptOutcome(verdict);
        if (outcome !== 'success' && outcome !== 'failure' && outcome !== 'partial') continue;
        addSettledCount(
          counts,
          planIdsForSettledAnswer(verdict?.knowledge_ids ?? [], scope.attributeTo),
          outcome,
        );
        continue;
      }
      const outcome = legacyOutcomes?.get(row.id);
      if (!outcome) continue;
      addSettledCount(
        counts,
        planIdsForSettledAnswer(
          stringArrayField(row.payload, 'referenced_knowledge_ids'),
          scope.attributeTo,
        ),
        outcome,
      );
    }

    if (rows.length < SETTLED_ANSWER_PAGE) return { complete: true, counts };
    const last = rows[rows.length - 1];
    if (cursor && last.created_at.getTime() === cursor.at.getTime() && last.id === cursor.id) {
      throw new Error('settled answer scan repeated a page');
    }
    cursor = { at: last.created_at, id: last.id };
  }
  return { complete: false, counts };
}

function asDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
