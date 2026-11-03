// Which events count as a learner answer or as learning activity, which subject
// such an event belongs to, and when the learner last did any of it. Consumers
// read these sets instead of spelling their own action lists.

import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
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
import { eventAllowsDerivationSql } from '@/kernel/events/derivation-policy';
import {
  nativeAttemptOutcome,
  resolveVerdictsForAttempts,
  resolveVerdictsForNativeAttempts,
} from './assessment-verdict';
import { batchResolveSubjectIds } from './subject-resolution';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;
type AnswerOutcome = 'success' | 'failure' | 'partial';

const NATIVE_ATTEMPT_ACTION = 'experimental:assessment_attempt';
const RECORD_CAPTURE_ACTION = 'experimental:record_capture';
/** Native attempt anchor id: `evt_assessment_<submission_id>`. */
const ASSESSMENT_ATTEMPT_ID_PREFIX = 'evt_assessment_';

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
  const [row] = await db
    .select({ at: sql<string | null>`max(${event.created_at})` })
    .from(event)
    .where(
      and(
        eq(event.actor_kind, 'user'),
        inArray(event.action, [...LEARNING_ACTIVITY_ACTIONS]),
        eventAllowsDerivationSql(),
        before ? lt(event.created_at, before) : undefined,
      ),
    );
  return asDate(row?.at);
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

export interface KnowledgeFailureStreak {
  knowledge_id: string;
  knowledge_name: string;
  /** Consecutive failed answers on this knowledge point, newest backwards. */
  count: number;
}

const FAILURE_STREAK_SCAN_LIMIT = 200;

/**
 * The knowledge point with the longest current run of failed answers. Answers with
 * no right/wrong bit (pending, self-reported, unsupported) and contested answers
 * (judge corrected, or an appeal filed) are skipped; a success or partial ends the
 * run. Only the newest FAILURE_STREAK_SCAN_LIMIT answers are read.
 */
export async function loadLongestFailureStreak(db: DbLike): Promise<KnowledgeFailureStreak | null> {
  const rows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.actor_kind, 'user'),
        inArray(event.action, [...LEARNER_ANSWER_ACTIONS]),
        eq(event.subject_kind, 'question'),
        eventAllowsDerivationSql(),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(FAILURE_STREAK_SCAN_LIMIT);
  if (rows.length === 0) return null;
  const nativeVerdicts = await resolveVerdictsForNativeAttempts(db, rows);
  const legacyOutcomes = await loadLegacyAnswerOutcomes(db, rows);
  const contested = await loadContestedAttemptIds(
    db,
    rows.map((row) => row.id),
  );

  const runs = new Map<string, { count: number; ended: boolean }>();
  for (const row of rows) {
    if (contested.has(row.id)) continue;
    const native = row.action === NATIVE_ATTEMPT_ACTION ? nativeVerdicts.get(row.id) : undefined;
    if (row.action === NATIVE_ATTEMPT_ACTION && !native) continue;
    const outcome = native ? nativeAttemptOutcome(native) : legacyOutcomes.get(row.id);
    if (outcome !== 'success' && outcome !== 'failure' && outcome !== 'partial') continue;
    const knowledgeIds = native
      ? native.knowledge_ids
      : stringArrayField(row.payload, 'referenced_knowledge_ids');
    for (const knowledgeId of new Set(knowledgeIds)) {
      const run = runs.get(knowledgeId) ?? { count: 0, ended: false };
      if (run.ended) continue;
      if (outcome === 'failure') run.count += 1;
      else run.ended = true;
      runs.set(knowledgeId, run);
    }
  }

  let best: { knowledgeId: string; count: number } | null = null;
  for (const [knowledgeId, run] of runs) {
    if (run.count === 0) continue;
    if (
      !best ||
      run.count > best.count ||
      (run.count === best.count && knowledgeId < best.knowledgeId)
    )
      best = { knowledgeId, count: run.count };
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
    .filter((id) => id.startsWith(ASSESSMENT_ATTEMPT_ID_PREFIX))
    .map((id) => id.slice(ASSESSMENT_ATTEMPT_ID_PREFIX.length));
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
      if (submissionId) contested.add(`${ASSESSMENT_ATTEMPT_ID_PREFIX}${submissionId}`);
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

function asDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
