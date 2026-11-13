// Difficulty populations for learner mastery and explicit bank priors.
// Answer membership is historical; only the fallback pool uses current serving eligibility.

import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { notDraftPredicate, questionSuspendedPredicate } from '@/db/predicates';
import {
  difficulty_calibration_evidence,
  event,
  item_calibration,
  question,
  question_group_lifecycle,
} from '@/db/schema';
import { filterActiveRows } from '@/kernel/events/active-rows';
import { allowedEventIds } from '@/kernel/events/derivation-policy';
import { readAutomaticallyServableQuestionIds } from '@/kernel/records/assessment-issuance';
import { loadAssessmentLearningScopes } from './assessment-learning-scope';
import {
  type CalibrationSettlement,
  liveCalibrationSettlements,
  loadSettlementEvents,
} from './assessment-settlements';
import {
  nativeAttemptOutcome,
  resolveVerdictsForAttempts,
  resolveVerdictsForNativeAttempts,
} from './assessment-verdict';
import { LEARNER_ANSWER_ACTIONS } from './learner-activity';
import { loadMergedKnowledgeClosure } from './merged-knowledge';
import { allowedQuestionIds } from './usage-policy';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;
export type KcBetaBasis =
  | 'answered'
  | 'answered_partial'
  | 'eligible_pool_fallback'
  | 'unavailable';
interface KcBetaSelection {
  beta: number;
  basis: KcBetaBasis;
}

function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let offset = 0; offset < values.length; offset += 256)
    out.push(values.slice(offset, offset + 256));
  return out;
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

async function allowedIds(db: DbLike, ids: string[]): Promise<Set<string>> {
  const result = new Set<string>();
  for (const part of chunks(ids)) for (const id of await allowedEventIds(db, part)) result.add(id);
  return result;
}

async function activeAnswers(db: DbLike): Promise<EventRow[]> {
  // No time/window/total-page bound: absence must establish no valid answer ever.
  const rows = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.actor_kind, 'user'),
        eq(event.subject_kind, 'question'),
        inArray(event.action, [...LEARNER_ANSWER_ACTIONS]),
      ),
    );
  const active: EventRow[] = [];
  for (const part of chunks(rows)) active.push(...(await filterActiveRows(db, part)));
  const allowed = await allowedIds(
    db,
    active.map((row) => row.id),
  );
  return active.filter((row) => allowed.has(row.id));
}

async function hardBetas(db: DbLike, ids: readonly string[]): Promise<Map<string, number>> {
  const values = new Map<string, number>();
  for (const part of chunks([...new Set(ids)])) {
    const rows = await db
      .select({
        id: item_calibration.question_id,
        beta: sql<
          number | null
        >`COALESCE(${item_calibration.b_post}, ${item_calibration.b_anchor}, ${item_calibration.b})`,
      })
      .from(item_calibration)
      .where(and(inArray(item_calibration.question_id, part), eq(item_calibration.track, 'hard')));
    for (const row of rows)
      if (row.beta !== null && Number.isFinite(row.beta)) values.set(row.id, row.beta);
  }
  return values;
}

/** Pool PRIOR only. Native rows must pass the canonical automatic-serving gate. */
export async function getRepresentativeKcBeta(
  db: DbLike,
  knowledgeIds: readonly string[],
): Promise<Map<string, number>> {
  const ids = [...new Set(knowledgeIds.filter((id) => id.length > 0))];
  if (!ids.length) return new Map();
  const rows = await db
    .select({
      id: question.id,
      kcs: question.knowledge_ids,
      native: question_group_lifecycle.group_id,
    })
    .from(question)
    .leftJoin(
      question_group_lifecycle,
      eq(
        question_group_lifecycle.group_id,
        sql`COALESCE(${question.parent_question_id}, ${question.id})`,
      ),
    )
    .where(
      and(
        notDraftPredicate(question.draft_status),
        questionSuspendedPredicate(question),
        or(...ids.map((id) => sql`${question.knowledge_ids} @> ${JSON.stringify([id])}::jsonb`)),
      ),
    );
  const eligible = new Set<string>();
  for (const part of chunks(rows.filter((row) => row.native !== null).map((row) => row.id))) {
    for (const id of await readAutomaticallyServableQuestionIds(db, part)) eligible.add(id);
  }
  for (const part of chunks(rows.filter((row) => row.native === null).map((row) => row.id))) {
    for (const id of await allowedQuestionIds(db, part)) eligible.add(id);
  }
  const betas = await hardBetas(db, [...eligible]);
  const values = new Map(ids.map((id) => [id, [] as number[]]));
  for (const row of rows) {
    const beta = betas.get(row.id);
    if (beta === undefined) continue;
    for (const kc of new Set(row.kcs)) values.get(kc)?.push(beta);
  }
  return new Map([...values].flatMap(([id, bs]) => (bs.length ? [[id, median(bs)]] : [])));
}

function receiptAnchor(
  member: CalibrationSettlement,
  evidence: Map<string, string>,
): string | null {
  if (
    member.inputs.groupId !== member.groupId ||
    member.inputs.evaluationId !== member.evaluationId
  )
    return null;
  if (typeof member.inputs.theta.applied !== 'boolean') return null;
  const anchors: unknown[] = [];
  if (evidence.has(member.id)) anchors.push(evidence.get(member.id));
  if (member.inputs.theta.applied) anchors.push(member.inputs.theta.anchorQuestionId);
  if (member.inputs.calibration != null) anchors.push(member.inputs.calibration.questionId);
  if (!anchors.length || anchors.some((id) => typeof id !== 'string' || !id.trim())) return null;
  const first = anchors[0];
  return new Set(anchors).size === 1 && typeof first === 'string' ? first : null;
}

/** Complete valid answer history, frozen KC membership and the writer's live calibration identities. */
export async function readAnswerFirstKcBeta(
  db: DbLike,
  knowledgeIds: readonly string[],
): Promise<Map<string, KcBetaSelection>> {
  const ids = [...new Set(knowledgeIds)];
  if (!ids.length) return new Map();
  const closure = await loadMergedKnowledgeClosure(db);
  const targets = new Map<string, string[]>();
  for (const id of ids)
    for (const historical of closure.closure(id))
      targets.set(historical, [...(targets.get(historical) ?? []), id]);
  const sets = new Map(
    ids.map((id) => [id, { questions: new Set<string>(), answered: false, unresolved: false }]),
  );
  const add = (kcs: string[], anchor: string | null) => {
    for (const kc of new Set(kcs.flatMap((id) => targets.get(id) ?? []))) {
      const entry = sets.get(kc);
      if (!entry) continue;
      entry.answered = true;
      if (anchor === null) entry.unresolved = true;
      else entry.questions.add(anchor);
    }
  };
  let incompleteAttribution = false;
  const answers = await activeAnswers(db);
  const legacy = answers.filter((row) => row.action !== 'experimental:assessment_attempt');
  const verdicts = await resolveVerdictsForAttempts(
    db,
    legacy.map((row) => row.id),
  );
  const judgesAllowed = await allowedIds(
    db,
    [...verdicts.values()].flatMap((v) => (v.effective ? [v.effective.judge_event_id] : [])),
  );
  for (const row of legacy) {
    const verdict = verdicts.get(row.id);
    if (verdict?.original && !verdict.effective) continue;
    if (verdict?.effective && !judgesAllowed.has(verdict.effective.judge_event_id)) continue;
    const effective = verdict?.effective?.verdict.coarse_outcome;
    const unsupported =
      row.payload.unsupported_judge === true ||
      (row.payload.judge as { coarse_outcome?: unknown } | undefined)?.coarse_outcome ===
        'unsupported';
    if (effective === 'unsupported' || (!verdict?.effective && unsupported)) continue;
    const outcome = effective ?? row.outcome;
    if (!['correct', 'incorrect', 'success', 'failure', 'partial'].includes(outcome ?? ''))
      continue;
    const kcs = row.payload.referenced_knowledge_ids;
    if (!Array.isArray(kcs) || kcs.some((id) => typeof id !== 'string')) {
      incompleteAttribution = true;
      continue;
    }
    add(kcs as string[], row.subject_id);
  }
  const native = answers.filter((row) => row.action === 'experimental:assessment_attempt');
  if (native.length) {
    const resolved = await resolveVerdictsForNativeAttempts(db, native);
    const scopes = await loadAssessmentLearningScopes(
      db,
      [...resolved.values()].map((v) => v.submission.submission_id),
    );
    const supporting = await db
      .select()
      .from(event)
      .where(
        inArray(event.action, [
          'experimental:assessment_submission',
          'experimental:assessment_activation',
        ]),
      );
    const supportingAllowed = await allowedIds(
      db,
      supporting.map((row) => row.id),
    );
    // Invalidators must reach the shared liveness fold even when their source cannot be derived.
    const ledger = await loadSettlementEvents(db);
    const unreadableEvaluations = new Set(
      ledger
        .filter(
          (row) => (row.effect === 'applied' || row.effect === 'ineligible') && row.inputs === null,
        )
        .map((row) => row.evaluationId),
    );
    const live = liveCalibrationSettlements(ledger);
    const ledgerAllowed = await allowedIds(
      db,
      live.map((member) => member.id),
    );
    const evidence = new Map<string, string>();
    for (const part of chunks(live.map((member) => member.id))) {
      for (const row of await db
        .select()
        .from(difficulty_calibration_evidence)
        .where(inArray(difficulty_calibration_evidence.attempt_event_id, part)))
        evidence.set(row.attempt_event_id, row.question_id);
    }
    const byEvaluation = new Map<string, CalibrationSettlement[]>();
    for (const member of live)
      byEvaluation.set(member.evaluationId, [
        ...(byEvaluation.get(member.evaluationId) ?? []),
        member,
      ]);
    for (const row of native) {
      const verdict = resolved.get(row.id);
      if (!verdict) {
        incompleteAttribution = true;
        continue;
      }
      const outcome = nativeAttemptOutcome(verdict);
      if (verdict.effective?.verdict.reason === 'issuance_scope_unavailable') {
        incompleteAttribution = true;
        continue;
      }
      if (outcome === 'pending' || outcome === 'unsupported') continue;
      const receipts = supporting.filter(
        (e) =>
          e.action === 'experimental:assessment_submission' &&
          e.subject_id === verdict.submission.submission_id,
      );
      if (receipts.length && receipts.every((e) => !supportingAllowed.has(e.id))) continue;
      if (receipts.length !== 1 || !scopes.has(verdict.submission.submission_id)) {
        incompleteAttribution = true;
        continue;
      }
      const effectiveId = verdict.effective?.evaluation_id;
      if (!effectiveId) {
        incompleteAttribution = true;
        continue;
      }
      const activations = supporting.filter(
        (e) =>
          e.action === 'experimental:assessment_activation' &&
          e.payload.evaluation_id === effectiveId,
      );
      if (activations.length && activations.every((e) => !supportingAllowed.has(e.id))) continue;
      const members = byEvaluation.get(effectiveId) ?? [];
      const member = members.length === 1 ? members[0] : undefined;
      const anchor =
        member &&
        !unreadableEvaluations.has(effectiveId) &&
        member.groupId === verdict.evaluation_group_id &&
        ledgerAllowed.has(member.id)
          ? receiptAnchor(member, evidence)
          : null;
      add(verdict.knowledge_ids, anchor);
    }
  }
  const betas = await hardBetas(
    db,
    [...sets.values()].flatMap((entry) => [...entry.questions]),
  );
  const fallbackIds = [...sets]
    .filter(([, entry]) => !entry.answered && !incompleteAttribution)
    .map(([id]) => id);
  const pool = await getRepresentativeKcBeta(db, fallbackIds);
  return new Map(
    [...sets].map(([id, entry]) => {
      const values = [...entry.questions].flatMap((q) => {
        const beta = betas.get(q);
        return beta === undefined ? [] : [beta];
      });
      const poolBeta = pool.get(id);
      const selection: KcBetaSelection = values.length
        ? {
            beta: median(values),
            basis:
              incompleteAttribution || entry.unresolved || values.length !== entry.questions.size
                ? 'answered_partial'
                : 'answered',
          }
        : !entry.answered && !incompleteAttribution && poolBeta !== undefined
          ? { beta: poolBeta, basis: 'eligible_pool_fallback' }
          : { beta: 0, basis: 'unavailable' };
      return [id, selection];
    }),
  );
}
