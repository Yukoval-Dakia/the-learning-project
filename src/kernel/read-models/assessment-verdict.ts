import {
  issuedLearningKnowledgeIds,
  loadAssessmentLearningScopes,
} from './assessment-learning-scope';
// Shared resolver for "what did this attempt/evaluation finally receive".
//
// Legacy lane (judge events): candidates are pulled by subject_id OR
// caused_by_event_id. Appeals set caused_by to the appeal and subject_id to the
// attempt, so either anchor alone loses rows.
//   original: the earliest judge event, never rewritten by a re-judgment.
//   effective: the newest judge still live after chain resolution, so a supersede
//     points at the new judge.
//   newest_raw: newest by time regardless of correction, for callers comparing
//     supersede behavior.
//
// Contract lane (evaluation_group): effective is the head's evaluation; original is
// the first active activation, then the earliest applied settlement, then attempt 1.
//
// Replay only writes settlement events, so this module never depends on replay to
// produce attempt/judge rows.

import { and, asc, eq, inArray } from 'drizzle-orm';
import { ZodError } from 'zod';
import {
  evaluationMemberFromRows,
  freezeEvaluationInput,
  matchesEvaluationInput,
} from '@/core/assessment-input';
import {
  EvaluationContractError,
  projectIssuedScoringBasis,
} from '@/core/schema/assessment/evaluation';
import { GroupInputContractError } from '@/core/schema/assessment/group-input';
import type { EvaluationRecordT } from '@/core/schema/assessment/judgment';
import type { ScoringBasisT } from '@/core/schema/assessment/scoring';
import {
  type AssessmentVerdict,
  type CoarseVerdict,
  deriveCoarseVerdict,
} from '@/core/schema/assessment/settlement';
import type { CauseSchemaT } from '@/core/schema/event/blocks';
import type { Db, Tx } from '@/db/client';
import {
  assessment_issuance,
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  event,
  learning_session,
  question_revision,
} from '@/db/schema';
import {
  type EffectiveTruth,
  activeEffectiveTruth,
  compareEventRowsAsc,
  filterActiveRows,
  getEffectiveTruths,
  newerEventRow,
} from '@/kernel/events';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;
type EvaluationRow = typeof evaluation.$inferSelect;

// Per-query IN cap. Some callers assert <=104 parameters, and one attempt can have
// hundreds of judge rows, so chunk every list. 64 leaves headroom for literals.
const QUERY_ID_CHUNK = 64;

// Wire actions duplicated locally so this read model does not import the
// orchestration graph; keep them in sync with the writers.
const ASSESSMENT_ACTIVATION_ACTION = 'experimental:assessment_activation';
const ASSESSMENT_SETTLEMENT_ACTION = 'experimental:assessment_settlement';

// ============================================================================
// Legacy lane — judge-event 双轨投影
// ============================================================================

/** Judge payload fields this read model consumes. */
export interface JudgeVerdictPayload {
  coarse_outcome: string | null;
  score: number | null;
  feedback_md: string | null;
  visible_to_user: boolean | null;
  cause: CauseSchemaT | null;
  referenced_knowledge_ids: string[];
  judge_route: string | null;
  /** Appeal source stored in the payload, not an envelope field. */
  appeal_event_id: string | null;
  attribution_pending: boolean | null;
}

/** A judge row plus its chain state and normalized payload view. */
export interface JudgeVerdictProjection {
  judge_event_id: string;
  /**
   * Chain root: the row itself for an original projection, the earliest chain
   * source for an effective one. Preserved across supersede.
   */
  original_event_id: string;
  created_at: Date;
  /** Chain state of the original row. */
  correction_state: EffectiveTruth;
  verdict: JudgeVerdictPayload;
  /** Raw row for consumers that need unprojected fields. */
  row: EventRow;
}

export interface AttemptVerdict {
  attempt_event_id: string;
  /**
   * Judge embedded in the attempt payload (solve-session style). It is the only
   * receipt when no judge event exists and still represents what was written at
   * execution time.
   */
  embedded: JudgeVerdictPayload | null;
  /** Historical first judge event; null without a judge. */
  original: JudgeVerdictProjection | null;
  /** Current effective judge after chain resolution; null when all were superseded or retracted. */
  effective: JudgeVerdictProjection | null;
  /** Newest by time regardless of correction, matching the older read semantics. */
  newest_raw: JudgeVerdictProjection | null;
}

function judgePayloadFromRow(row: EventRow): JudgeVerdictPayload {
  const p = (row.payload ?? {}) as Record<string, unknown>;
  return {
    coarse_outcome: typeof p.coarse_outcome === 'string' ? p.coarse_outcome : null,
    score: typeof p.score === 'number' ? p.score : null,
    feedback_md: typeof p.feedback_md === 'string' ? p.feedback_md : null,
    visible_to_user: typeof p.visible_to_user === 'boolean' ? p.visible_to_user : null,
    cause: (p.cause as CauseSchemaT | undefined) ?? null,
    referenced_knowledge_ids: Array.isArray(p.referenced_knowledge_ids)
      ? (p.referenced_knowledge_ids as string[])
      : [],
    judge_route: typeof p.judge_route === 'string' ? p.judge_route : null,
    appeal_event_id: typeof p.appeal_event_id === 'string' ? p.appeal_event_id : null,
    attribution_pending: typeof p.attribution_pending === 'boolean' ? p.attribution_pending : null,
  };
}

/**
 * Embedded judge shape uses route/reason_md; map them onto
 * judge_route/feedback_md and leave the rest null.
 */
function judgePayloadFromEmbedded(raw: unknown): JudgeVerdictPayload {
  const p = (raw ?? {}) as Record<string, unknown>;
  return {
    coarse_outcome: typeof p.coarse_outcome === 'string' ? p.coarse_outcome : null,
    score: typeof p.score === 'number' ? p.score : null,
    feedback_md: typeof p.reason_md === 'string' ? p.reason_md : null,
    visible_to_user: typeof p.visible_to_user === 'boolean' ? p.visible_to_user : null,
    cause: (p.cause as CauseSchemaT | undefined) ?? null,
    referenced_knowledge_ids: Array.isArray(p.referenced_knowledge_ids)
      ? (p.referenced_knowledge_ids as string[])
      : [],
    judge_route:
      typeof p.judge_route === 'string'
        ? p.judge_route
        : typeof p.route === 'string'
          ? p.route
          : null,
    appeal_event_id: null,
    attribution_pending: null,
  };
}

/** Group key: subject_id wins, otherwise caused_by_event_id. */
function attemptAnchorKey(row: EventRow, attemptIds: Set<string>): string | null {
  if (row.subject_id !== null && attemptIds.has(row.subject_id)) return row.subject_id;
  if (row.caused_by_event_id !== null && attemptIds.has(row.caused_by_event_id)) {
    return row.caused_by_event_id;
  }
  return null;
}

async function rowsById(db: DbLike, ids: string[]): Promise<Map<string, EventRow>> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return new Map();
  const out = new Map<string, EventRow>();
  for (let offset = 0; offset < uniqueIds.length; offset += QUERY_ID_CHUNK) {
    const chunk = uniqueIds.slice(offset, offset + QUERY_ID_CHUNK);
    const rows = await db.select().from(event).where(inArray(event.id, chunk));
    for (const row of rows) out.set(row.id, row);
  }
  return out;
}

// Chunk candidate ids: one caller issues four event-id IN lists, and each query
// must stay under the 104-parameter cap.
async function effectiveTruthsChunked(
  db: DbLike,
  eventIds: string[],
): Promise<Map<string, EffectiveTruth>> {
  const uniqueIds = [...new Set(eventIds)];
  const out = new Map<string, EffectiveTruth>();
  for (let offset = 0; offset < uniqueIds.length; offset += QUERY_ID_CHUNK) {
    const chunk = uniqueIds.slice(offset, offset + QUERY_ID_CHUNK);
    for (const [id, truth] of await getEffectiveTruths(db, chunk)) out.set(id, truth);
  }
  return out;
}

// Pull candidates through both anchors in separate queries: a combined
// or(inArray, inArray) would put both id lists in one parameter count. Sort
// ascending before returning so an effective row reached by two chains keeps the
// earliest chain root deterministically.
async function judgeCandidatesForAttempts(db: DbLike, attemptIds: string[]): Promise<EventRow[]> {
  const uniqueIds = [...new Set(attemptIds)];
  const byId = new Map<string, EventRow>();
  for (let offset = 0; offset < uniqueIds.length; offset += QUERY_ID_CHUNK) {
    const chunk = uniqueIds.slice(offset, offset + QUERY_ID_CHUNK);
    const [bySubject, byCausedBy] = await Promise.all([
      db
        .select()
        .from(event)
        .where(
          and(
            eq(event.action, 'judge'),
            eq(event.subject_kind, 'event'),
            inArray(event.subject_id, chunk),
          ),
        ),
      db
        .select()
        .from(event)
        .where(
          and(
            eq(event.action, 'judge'),
            eq(event.subject_kind, 'event'),
            inArray(event.caused_by_event_id, chunk),
          ),
        ),
    ]);
    for (const row of bySubject) byId.set(row.id, row);
    for (const row of byCausedBy) byId.set(row.id, row);
  }
  // Ascending canonical order; see the function comment.
  return [...byId.values()].sort(compareEventRowsAsc);
}

/**
 * Resolve original/effective/newest_raw for a batch of attempts in three
 * round-trips.
 */
export async function resolveVerdictsForAttempts(
  db: DbLike,
  attemptIds: string[],
): Promise<Map<string, AttemptVerdict>> {
  const uniqueIds = [...new Set(attemptIds)];
  const out = new Map<string, AttemptVerdict>();
  for (const id of uniqueIds) {
    out.set(id, {
      attempt_event_id: id,
      embedded: null,
      original: null,
      effective: null,
      newest_raw: null,
    });
  }
  if (uniqueIds.length === 0) return out;

  // Embedded track: the attempt payload's judge when it is an object.
  const attemptRows = await rowsById(db, uniqueIds);
  for (const [id, row] of attemptRows) {
    const entry = out.get(id);
    if (!entry) continue;
    const judge = (row.payload ?? {}) as Record<string, unknown>;
    const embedded = judge.judge;
    if (embedded !== null && typeof embedded === 'object') {
      entry.embedded = judgePayloadFromEmbedded(embedded);
    }
  }

  const anchorSet = new Set(uniqueIds);
  const candidates = await judgeCandidatesForAttempts(db, uniqueIds);
  if (candidates.length === 0) return out;

  // Chain resolution: every candidate original -> effective row.
  const truthByOriginal = await effectiveTruthsChunked(
    db,
    candidates.map((row) => row.id),
  );
  const rowById = new Map(candidates.map((row) => [row.id, row]));
  const missingEffectiveIds = [...truthByOriginal.values()]
    .map((truth) => truth.effective_event_id)
    .filter((id): id is string => typeof id === 'string' && !rowById.has(id));
  for (const [id, row] of await rowsById(db, missingEffectiveIds)) {
    rowById.set(id, row);
  }

  // original = earliest candidate; newest_raw = newest; effective = newest still
  // live with a matching anchor.
  type Acc = {
    original: EventRow | null;
    newestRaw: EventRow | null;
    effective: { row: EventRow; truth: EffectiveTruth } | null;
  };
  const byAttempt = new Map<string, Acc>();
  const accFor = (key: string): Acc => {
    let acc = byAttempt.get(key);
    if (!acc) {
      acc = { original: null, newestRaw: null, effective: null };
      byAttempt.set(key, acc);
    }
    return acc;
  };

  for (const row of candidates) {
    const key = attemptAnchorKey(row, anchorSet);
    if (key === null) continue;
    const acc = accFor(key);
    // Keep the earliest row.
    if (acc.original === null || !newerEventRow(row, acc.original)) {
      acc.original = row;
    }
    if (acc.newestRaw === null || newerEventRow(row, acc.newestRaw)) {
      acc.newestRaw = row;
    }

    const truth = truthByOriginal.get(row.id) ?? activeEffectiveTruth(row.id);
    if (truth.terminal_state !== 'active' || !truth.effective_event_id) continue;
    const effectiveRow = rowById.get(truth.effective_event_id);
    if (!effectiveRow) continue;
    // Match action/subject_kind/subject_id only; rejudge's caused_by=appeal.id is
    // valid.
    if (effectiveRow.action !== row.action) continue;
    if (effectiveRow.subject_kind !== row.subject_kind) continue;
    if (effectiveRow.subject_id !== row.subject_id) continue;
    if (!acc.effective || newerEventRow(effectiveRow, acc.effective.row)) {
      acc.effective = { row: effectiveRow, truth };
    }
  }

  for (const [key, acc] of byAttempt) {
    out.set(key, {
      attempt_event_id: key,
      embedded: out.get(key)?.embedded ?? null,
      original:
        acc.original === null
          ? null
          : {
              judge_event_id: acc.original.id,
              original_event_id: acc.original.id,
              created_at: acc.original.created_at,
              correction_state:
                truthByOriginal.get(acc.original.id) ?? activeEffectiveTruth(acc.original.id),
              verdict: judgePayloadFromRow(acc.original),
              row: acc.original,
            },
      effective: acc.effective
        ? {
            judge_event_id: acc.effective.row.id,
            original_event_id: acc.effective.truth.original_event_id,
            created_at: acc.effective.row.created_at,
            correction_state: acc.effective.truth,
            verdict: judgePayloadFromRow(acc.effective.row),
            row: acc.effective.row,
          }
        : null,
      newest_raw:
        acc.newestRaw === null
          ? null
          : {
              judge_event_id: acc.newestRaw.id,
              original_event_id: acc.newestRaw.id,
              created_at: acc.newestRaw.created_at,
              correction_state:
                truthByOriginal.get(acc.newestRaw.id) ?? activeEffectiveTruth(acc.newestRaw.id),
              verdict: judgePayloadFromRow(acc.newestRaw),
              row: acc.newestRaw,
            },
    });
  }
  return out;
}

/** Single-id convenience wrapper. */
export async function resolveVerdictForAttempt(
  db: DbLike,
  attemptEventId: string,
): Promise<AttemptVerdict> {
  const map = await resolveVerdictsForAttempts(db, [attemptEventId]);
  return (
    map.get(attemptEventId) ?? {
      attempt_event_id: attemptEventId,
      embedded: null,
      original: null,
      effective: null,
      newest_raw: null,
    }
  );
}

// ============================================================================
// Contract lane — evaluation_group 双轨投影
// ============================================================================

export interface EvaluationVerdict {
  scoring_basis: ScoringBasisT | null;
  evaluation_id: string;
  /** evaluation.attempt (retry ordinal). */
  attempt: number;
  status: EvaluationRecordT['status'];
  verdict: CoarseVerdict;
  row: EvaluationRow;
}

export interface GroupVerdict {
  evaluation_group_id: string;
  /** Current effective evaluation from the head; null when head or effective is missing. */
  effective: EvaluationVerdict | null;
  /** First activated evaluation; null when never activated. */
  original: EvaluationVerdict | null;
  /** Head row, including generation; null when absent. */
  head: typeof evaluation_effective_head.$inferSelect | null;
}

/**
 * Resolve original/effective per group. Missing or unprojectable scope returns
 * unsupported/issuance_scope_unavailable rather than guessing from the full
 * revision or absent unit results.
 */
export async function resolveVerdictsForGroups(
  db: DbLike,
  groupIds: string[],
): Promise<Map<string, GroupVerdict>> {
  const uniqueIds = [...new Set(groupIds)];
  const out = new Map<string, GroupVerdict>();
  for (const id of uniqueIds) {
    out.set(id, { evaluation_group_id: id, effective: null, original: null, head: null });
  }
  if (uniqueIds.length === 0) return out;

  // Chunk every group IN list; five independent round-trips per chunk.
  const heads: (typeof evaluation_effective_head.$inferSelect)[] = [];
  const evalRows: EvaluationRow[] = [];
  const submissions: (typeof assessment_submission.$inferSelect)[] = [];
  const activationRows: EventRow[] = [];
  for (let offset = 0; offset < uniqueIds.length; offset += QUERY_ID_CHUNK) {
    const chunk = uniqueIds.slice(offset, offset + QUERY_ID_CHUNK);
    const [h, ev, sub, act] = await Promise.all([
      db
        .select()
        .from(evaluation_effective_head)
        .where(inArray(evaluation_effective_head.evaluation_group_id, chunk)),
      db.select().from(evaluation).where(inArray(evaluation.evaluation_group_id, chunk)),
      db
        .select()
        .from(assessment_submission)
        .where(inArray(assessment_submission.evaluation_group_id, chunk)),
      db
        .select()
        .from(event)
        .where(
          and(
            eq(event.action, ASSESSMENT_ACTIVATION_ACTION),
            eq(event.subject_kind, 'evaluation_group'),
            inArray(event.subject_id, chunk),
          ),
        )
        .orderBy(asc(event.created_at), asc(event.id)),
    ]);
    heads.push(...h);
    evalRows.push(...ev);
    submissions.push(...sub);
    activationRows.push(...act);
  }
  // Settlements are fetched once by action, not per chunk: the original track only
  // needs each group's earliest applied row.
  const settlementRows = await db
    .select({ id: event.id, created_at: event.created_at, payload: event.payload })
    .from(event)
    .where(eq(event.action, ASSESSMENT_SETTLEMENT_ACTION));

  // Use the submission's frozen revision and issuance, not the full revision
  // denominator.
  const revisionIds = [...new Set(submissions.map((s) => s.revision_id))];
  const revisionRows: Pick<
    typeof question_revision.$inferSelect,
    'revision_id' | 'integrity_digest' | 'structure' | 'response_spec' | 'scoring_basis'
  >[] = [];
  for (let offset = 0; offset < revisionIds.length; offset += QUERY_ID_CHUNK) {
    const chunk = revisionIds.slice(offset, offset + QUERY_ID_CHUNK);
    const rows = await db
      .select({
        revision_id: question_revision.revision_id,
        integrity_digest: question_revision.integrity_digest,
        scoring_basis: question_revision.scoring_basis,
        structure: question_revision.structure,
        response_spec: question_revision.response_spec,
      })
      .from(question_revision)
      .where(inArray(question_revision.revision_id, chunk));
    revisionRows.push(...rows);
  }
  const issuanceIds = [...new Set(submissions.map((s) => s.issuance_id))];
  const issuanceRows: (typeof assessment_issuance.$inferSelect)[] = [];
  for (let offset = 0; offset < issuanceIds.length; offset += QUERY_ID_CHUNK) {
    issuanceRows.push(
      ...(await db
        .select()
        .from(assessment_issuance)
        .where(
          inArray(
            assessment_issuance.issuance_id,
            issuanceIds.slice(offset, offset + QUERY_ID_CHUNK),
          ),
        )),
    );
  }
  const activeActivationRows = await filterActiveRows(db, activationRows);
  return projectGroupVerdicts({
    groupIds: uniqueIds,
    heads,
    evaluations: evalRows,
    submissions,
    revisions: revisionRows,
    issuances: issuanceRows,
    activeActivations: activeActivationRows,
    settlements: settlementRows,
  });
}

/** Shared synchronous projection for live reads and exported database snapshots. */
export function projectGroupVerdicts(input: {
  groupIds: string[];
  heads: (typeof evaluation_effective_head.$inferSelect)[];
  evaluations: EvaluationRow[];
  submissions: (typeof assessment_submission.$inferSelect)[];
  revisions: Pick<
    typeof question_revision.$inferSelect,
    'revision_id' | 'integrity_digest' | 'structure' | 'response_spec' | 'scoring_basis'
  >[];
  issuances: (typeof assessment_issuance.$inferSelect)[];
  activeActivations: Pick<EventRow, 'subject_id' | 'payload'>[];
  settlements: Pick<EventRow, 'id' | 'created_at' | 'payload'>[];
}): Map<string, GroupVerdict> {
  const {
    heads,
    evaluations: evalRows,
    submissions,
    revisions: revisionRows,
    issuances: issuanceRows,
    activeActivations: activeActivationRows,
    settlements: settlementRows,
  } = input;
  const uniqueIds = [...new Set(input.groupIds)];
  const out = new Map<string, GroupVerdict>(
    uniqueIds.map((id) => [
      id,
      { evaluation_group_id: id, effective: null, original: null, head: null },
    ]),
  );
  const headByGroup = new Map(heads.map((h) => [h.evaluation_group_id, h]));
  const evalById = new Map(evalRows.map((r) => [r.evaluation_id, r]));
  const evalsByGroup = new Map<string, EvaluationRow[]>();
  for (const row of evalRows) {
    const list = evalsByGroup.get(row.evaluation_group_id) ?? [];
    list.push(row);
    evalsByGroup.set(row.evaluation_group_id, list);
  }

  const revisionById = new Map(revisionRows.map((r) => [r.revision_id, r]));
  const issuanceById = new Map(issuanceRows.map((r) => [r.issuance_id, r]));
  const basisForEvaluation = (row: EvaluationRow): ScoringBasisT | undefined => {
    const groupMembers = submissions.filter(
      (sub) => sub.evaluation_group_id === row.evaluation_group_id,
    );
    const anchorRow = groupMembers.find((sub) => sub.submission_id === row.submission_id);
    const revision = anchorRow && revisionById.get(anchorRow.revision_id);
    if (!anchorRow || !revision) return undefined;
    try {
      const members = groupMembers.map((sub) => {
        const issuance = issuanceById.get(sub.issuance_id);
        if (!issuance)
          throw new GroupInputContractError('invalid_group_input', 'missing member issuance');
        return evaluationMemberFromRows(sub, issuance);
      });
      const anchor = members.find(
        (member) => member.submission.submission_id === row.submission_id,
      );
      if (!anchor) return undefined;
      const actual = freezeEvaluationInput(anchor.submission, revision, members);
      const snapshot = row.provenance?.input_snapshot;
      if (snapshot == null ? members.length !== 1 : !matchesEvaluationInput(snapshot, actual))
        return undefined;
      return projectIssuedScoringBasis(revision, actual.issued_part_ids);
    } catch (error) {
      if (
        !(error instanceof EvaluationContractError) &&
        !(error instanceof GroupInputContractError) &&
        !(error instanceof ZodError)
      )
        throw error;
      return undefined;
    }
  };

  // original = the first active activation's evaluation. A retracted activation
  // does not count as the first effective verdict.

  const firstActivationByGroup = new Map<string, string>();
  for (const row of activeActivationRows) {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    const evalId = typeof p.evaluation_id === 'string' ? p.evaluation_id : null;
    if (evalId === null) continue;
    // activeActivationRows are ascending, so the first seen is earliest.
    if (!firstActivationByGroup.has(row.subject_id)) {
      firstActivationByGroup.set(row.subject_id, evalId);
    }
  }
  // Fallback: the earliest applied settlement's evaluation. original means first,
  // not current, so replay and supersede do not matter here.
  const firstSettlementEvalByGroup = new Map<string, string>();
  const sortedSettlementRows = [...settlementRows].sort(
    (a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id),
  );
  for (const row of sortedSettlementRows) {
    const p = (row.payload ?? {}) as Record<string, unknown>;
    if (p.effect !== 'applied') continue;
    const groupId = typeof p.evaluation_group_id === 'string' ? p.evaluation_group_id : null;
    const evalId = typeof p.evaluation_id === 'string' ? p.evaluation_id : null;
    if (groupId === null || evalId === null) continue;
    if (!firstSettlementEvalByGroup.has(groupId)) {
      firstSettlementEvalByGroup.set(groupId, evalId);
    }
  }

  const project = (row: EvaluationRow): EvaluationVerdict | null => {
    const basis = basisForEvaluation(row);
    return {
      evaluation_id: row.evaluation_id,
      scoring_basis: basis ?? null,
      attempt: row.attempt,
      status: row.status,
      verdict: basis
        ? deriveCoarseVerdict({ status: row.status, aggregate: row.aggregate }, basis)
        : // Without a basis, report unsupported honestly rather than inventing a verdict.
          {
            verdict: 'unsupported' as AssessmentVerdict,
            reason: 'issuance_scope_unavailable' as const,
            points: null,
            maxPoints: null,
            normalized: null,
          },
      row,
    };
  };

  for (const groupId of uniqueIds) {
    const entry = out.get(groupId) as GroupVerdict;
    const head = headByGroup.get(groupId) ?? null;
    entry.head = head;

    if (head?.effective_evaluation_id) {
      const effectiveRow = evalById.get(head.effective_evaluation_id);
      if (effectiveRow) entry.effective = project(effectiveRow);
    }

    const originalEvalId =
      firstActivationByGroup.get(groupId) ?? firstSettlementEvalByGroup.get(groupId) ?? null;
    if (originalEvalId !== null) {
      const originalRow = evalById.get(originalEvalId);
      if (originalRow) entry.original = project(originalRow);
    }
    if (entry.original === null) {
      // Last fallback: earliest attempt in the group.
      const groupEvals = evalsByGroup.get(groupId) ?? [];
      const earliest = [...groupEvals].sort(
        (a, b) =>
          a.attempt - b.attempt ||
          a.created_at.getTime() - b.created_at.getTime() ||
          a.evaluation_id.localeCompare(b.evaluation_id),
      )[0];
      if (earliest) entry.original = project(earliest);
    }
  }
  return out;
}

/** Single-group convenience wrapper. */
export async function resolveVerdictForGroup(db: DbLike, groupId: string): Promise<GroupVerdict> {
  const map = await resolveVerdictsForGroups(db, [groupId]);
  return (
    map.get(groupId) ?? {
      evaluation_group_id: groupId,
      effective: null,
      original: null,
      head: null,
    }
  );
}

/** Native attempt anchors carry no verdict; resolve their frozen coordinates first. */
export type NativeAttemptVerdict = GroupVerdict & {
  knowledge_ids: string[];
  issuance: typeof assessment_issuance.$inferSelect;
  revision: typeof question_revision.$inferSelect;
  submission: typeof assessment_submission.$inferSelect;
  original_evaluation_id: string | null;
};

export async function resolveVerdictsForNativeAttempts(
  db: DbLike,
  rows: EventRow[],
): Promise<Map<string, NativeAttemptVerdict>> {
  const anchors = rows.filter(
    (row) => row.action === 'experimental:assessment_attempt' && row.subject_kind === 'question',
  );
  const ids = [
    ...new Set(
      anchors.flatMap((row) =>
        typeof row.payload.submission_id === 'string' ? [row.payload.submission_id] : [],
      ),
    ),
  ];
  const coordinates = [];
  for (let offset = 0; offset < ids.length; offset += QUERY_ID_CHUNK) {
    coordinates.push(
      ...(await db
        .select({
          submission: assessment_submission,
          issuance: assessment_issuance,
          revision: question_revision,
        })
        .from(assessment_submission)
        .innerJoin(
          assessment_issuance,
          eq(assessment_issuance.issuance_id, assessment_submission.issuance_id),
        )
        .innerJoin(
          question_revision,
          eq(question_revision.revision_id, assessment_submission.revision_id),
        )
        .where(
          inArray(assessment_submission.submission_id, ids.slice(offset, offset + QUERY_ID_CHUNK)),
        )),
    );
  }
  const originalIds = [
    ...new Set(
      anchors.flatMap((row) =>
        typeof row.payload.original_evaluation_id === 'string'
          ? [row.payload.original_evaluation_id]
          : [],
      ),
    ),
  ];
  const originals = new Map<string, { submission_id: string; evaluation_group_id: string }>();
  for (let offset = 0; offset < originalIds.length; offset += QUERY_ID_CHUNK) {
    const found = await db
      .select({
        evaluation_id: evaluation.evaluation_id,
        submission_id: evaluation.submission_id,
        evaluation_group_id: evaluation.evaluation_group_id,
      })
      .from(evaluation)
      .where(inArray(evaluation.evaluation_id, originalIds.slice(offset, offset + QUERY_ID_CHUNK)));
    for (const item of found) originals.set(item.evaluation_id, item);
  }
  // Queued anchors predate evaluation. Resolve the first actual candidate, never
  // the first activation (a later self-report may be the first effective record).
  const firstBySubmission = new Map<string, string>();
  for (let offset = 0; offset < ids.length; offset += QUERY_ID_CHUNK) {
    const found = await db
      .select({
        evaluation_id: evaluation.evaluation_id,
        submission_id: evaluation.submission_id,
        evaluation_group_id: evaluation.evaluation_group_id,
      })
      .from(evaluation)
      .where(inArray(evaluation.submission_id, ids.slice(offset, offset + QUERY_ID_CHUNK)))
      .orderBy(asc(evaluation.attempt), asc(evaluation.evaluation_id));
    for (const item of found) {
      originals.set(item.evaluation_id, item);
      if (!firstBySubmission.has(item.submission_id))
        firstBySubmission.set(item.submission_id, item.evaluation_id);
    }
  }
  const learningScopes = await loadAssessmentLearningScopes(db, ids);
  const coordinateById = new Map(
    coordinates.map((value) => [value.submission.submission_id, value]),
  );
  const valid = anchors.flatMap((row) => {
    const p = row.payload;
    const coordinate =
      typeof p.submission_id === 'string' ? coordinateById.get(p.submission_id) : undefined;
    if (!coordinate) return [];
    const { submission, issuance, revision } = coordinate;
    if (
      p.evaluation_group_id !== submission.evaluation_group_id ||
      p.issuance_id !== submission.issuance_id ||
      p.revision_id !== submission.revision_id ||
      issuance.revision_id !== revision.revision_id ||
      (row.subject_id !== revision.group_id && !issuance.part_ids.includes(row.subject_id))
    )
      return [];
    const originalId =
      typeof p.original_evaluation_id === 'string'
        ? p.original_evaluation_id
        : (firstBySubmission.get(submission.submission_id) ?? null);
    const original = originalId ? originals.get(originalId) : undefined;
    const originalEvaluationId =
      original?.submission_id === submission.submission_id &&
      original?.evaluation_group_id === submission.evaluation_group_id
        ? originalId
        : null;
    return [
      {
        row,
        submission,
        issuance,
        revision,
        groupId: submission.evaluation_group_id,
        originalEvaluationId,
      },
    ];
  });
  const groups = await resolveVerdictsForGroups(
    db,
    valid.map((entry) => entry.groupId),
  );
  const bufferedSessionIds = [
    ...new Set(
      anchors.flatMap((row) =>
        row.payload.paper_feedback_policy === 'judge_now_show_later' && row.session_id
          ? [row.session_id]
          : [],
      ),
    ),
  ];
  const completedSessions = new Map<string, string>();
  for (let offset = 0; offset < bufferedSessionIds.length; offset += QUERY_ID_CHUNK) {
    const sessions = await db
      .select({
        id: learning_session.id,
        status: learning_session.status,
        started_at: learning_session.started_at,
      })
      .from(learning_session)
      .where(
        inArray(learning_session.id, bufferedSessionIds.slice(offset, offset + QUERY_ID_CHUNK)),
      );
    for (const session of sessions)
      if (session.status === 'completed')
        completedSessions.set(session.id, session.started_at.toISOString());
  }
  return new Map(
    valid.map(({ row, groupId, submission, issuance, revision, originalEvaluationId }) => [
      row.id,
      {
        ...(groups.get(groupId) ?? {
          evaluation_group_id: groupId,
          original: null,
          effective: null,
          head: null,
        }),
        submission,
        issuance,
        revision,
        knowledge_ids: issuedLearningKnowledgeIds({
          scope: learningScopes.get(submission.submission_id),
          groupId: revision.group_id,
          partIds: issuance.part_ids,
        }),
        original_evaluation_id: originalEvaluationId,
        ...(row.payload.paper_feedback_policy === 'judge_now_show_later' &&
        (typeof row.payload.paper_started_at !== 'string' ||
          completedSessions.get(row.session_id ?? '') !== row.payload.paper_started_at)
          ? { original: null, effective: null }
          : {}),
      },
    ]),
  );
}

export function nativeAttemptOutcome(
  group: GroupVerdict | undefined,
): 'success' | 'failure' | 'partial' | 'pending' | 'unsupported' {
  const selected = group?.effective;
  if (!selected || selected.status === 'pending') return 'pending';
  // Self-report owns a practice rating, never an inferred score.
  if (selected.row.provenance?.source === 'self_report') return 'unsupported';
  switch (selected.verdict.verdict) {
    case 'correct':
      return 'success';
    case 'incorrect':
      return 'failure';
    case 'partial':
      return 'partial';
    default:
      return 'unsupported';
  }
}
