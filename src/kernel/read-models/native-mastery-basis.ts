// Native contribution closure for read-only progress. Numeric mastery remains canonical.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ThetaSnapshot } from '@/core/schema/event/state-snapshot';
import type { Tx } from '@/db/client';
import { evaluation, event, materialized_id_index, source_document } from '@/db/schema';
import { filterActiveRows } from '@/kernel/events/active-rows';
import { allowedEventIds } from '@/kernel/events/derivation-policy';
import { LearningScope } from './assessment-learning-scope';
import { liveAppliedSettlements, loadSettlementEvents } from './assessment-settlements';
import { nativeAttemptOutcome, resolveVerdictsForNativeAttempts } from './assessment-verdict';
import { LEARNER_ANSWER_ACTIONS } from './learner-activity';
import { type MasteryProjection, getMasteryProjection } from './mastery-projection';
import {
  type PurposeSource,
  allowedQuestionIds,
  readSourceUsageEpochs,
  sourceAllowsDerivation,
} from './usage-policy';

const Plan = z.object({
  kind: z.literal('plan'),
  groupId: z.string().min(1),
  submissionId: z.string().min(1),
  evaluationId: z.string().min(1),
  occurrenceAt: z.iso.datetime(),
  evaluatedAt: z.iso.datetime(),
  provenance: z.object({
    source: z.enum(['automatic', 'manual', 'self_report']),
    assisted: z.boolean(),
  }),
  verdict: z.object({ verdict: z.string(), normalized: z.number().nullable() }),
  scopeKcIds: z.array(z.string()),
  ratingSource: z.enum(['verdict', 'user', 'none']),
  fsrsSubjects: z.array(z.object({ kind: z.enum(['question', 'knowledge']), id: z.string() })),
  kcObservations: z.array(z.unknown()),
  calibration: z.object({ questionId: z.string() }).nullable(),
  theta: z.discriminatedUnion('applied', [
    z.object({ applied: z.literal(false), abstainReason: z.string() }),
    z.object({
      applied: z.literal(true),
      outcome: z.union([z.literal(0), z.literal(1)]),
      knowledgeIds: z.array(z.string()),
      anchorQuestionId: z.string(),
      kcEvidence: z
        .array(
          z.object({
            kc_id: z.string(),
            outcome: z.union([z.literal(0), z.literal(1)]),
            weight: z.number().gt(0).lte(1),
          }),
        )
        .optional(),
    }),
  ]),
});
const ScopeReceipt = z.object({ learning_scope: LearningScope });
const LegacyScope = z.array(z.string().min(1));
const Assistance = z.object({ assistance: z.object({ status: z.literal('independent') }) });
const Snapshot = z.object({
  attempt_event_id: z.string(),
  theta_snapshots: z.array(ThetaSnapshot),
});

export interface NativeMasteryOccurrence {
  groupId: string;
  anchorId: string;
  occurredAt: string;
  correct: boolean;
  adverse: boolean;
}
export interface NativeMasteryBasis {
  knowledgeId: string;
  displayAllowed: boolean;
  nativeCountsAvailable: boolean;
  projection: MasteryProjection | null;
  reasons: string[];
  pendingCount: number;
  occurrences: NativeMasteryOccurrence[];
}

/** Current explicit document purpose; standalone authored sources use the canonical lineage gate. */
export async function progressSourceAllowed(tx: Tx, source: PurposeSource): Promise<boolean> {
  if (!(await sourceAllowsDerivation(tx, source))) return false;
  const docIds = Object.keys(await readSourceUsageEpochs(tx, source));
  if (!docIds.length) return true;
  const docs = await tx
    .select({ provenance: source_document.provenance })
    .from(source_document)
    .where(inArray(source_document.id, docIds));
  const policy = z.object({ usage_policy: z.object({ derivation_policy: z.literal('allow') }) });
  return (
    docs.length === docIds.length && docs.every((doc) => policy.safeParse(doc.provenance).success)
  );
}

/** Caller must own one read-only repeatable-read snapshot for scope and all facts. */
export async function readNativeMasteryBasis(tx: Tx, ids: string[], asOf: Date) {
  const mode = await tx.execute<{ isolation: string; readonly: string }>(sql`SELECT
    current_setting('transaction_isolation') AS isolation,
    current_setting('transaction_read_only') AS readonly`);
  if (mode[0]?.isolation !== 'repeatable read' || mode[0]?.readonly !== 'on')
    throw new Error('native mastery basis requires a read-only repeatable-read snapshot');
  const result = new Map<string, NativeMasteryBasis>(
    ids.map((id) => [
      id,
      {
        knowledgeId: id,
        displayAllowed: true,
        nativeCountsAvailable: false,
        projection: null,
        reasons: [],
        pendingCount: 0,
        occurrences: [],
      },
    ]),
  );
  if (!ids.length) return result;
  const block = (scope: string[], reason: string, withhold = false) => {
    for (const id of scope) {
      const fact = result.get(id);
      if (!fact) continue;
      if (!fact.reasons.includes(reason)) fact.reasons.push(reason);
      if (withhold) {
        fact.displayAllowed = false;
        fact.projection = null;
      }
    }
  };
  const births = await tx
    .select({
      id: materialized_id_index.materialized_id,
      anchor: materialized_id_index.anchor_event_id,
    })
    .from(materialized_id_index)
    .where(
      and(
        eq(materialized_id_index.subject_kind, 'knowledge'),
        inArray(materialized_id_index.materialized_id, ids),
      ),
    );
  const birthById = new Map(births.map((b) => [b.id, b.anchor]));
  for (const id of ids) {
    const anchor = birthById.get(id);
    if (!anchor || !(await progressSourceAllowed(tx, { kind: 'event', id: anchor })))
      block([id], 'purpose_unavailable', true);
  }
  // Origin and unresolved obligations require the complete history, including withdrawn rows.
  const rows = await tx
    .select()
    .from(event)
    .where(
      inArray(event.action, [
        ...LEARNER_ANSWER_ACTIONS,
        'experimental:assessment_submission',
        'experimental:assessment_settlement',
        'experimental:state_snapshot',
        'experimental:appeal_request',
        'experimental:assessment_appeal_resolution',
      ]),
    )
    .orderBy(event.dispatch_seq);
  const answers = rows.filter((row) =>
    LEARNER_ANSWER_ACTIONS.includes(row.action as (typeof LEARNER_ANSWER_ACTIONS)[number]),
  );
  const native = answers.filter((row) => row.action === 'experimental:assessment_attempt');
  const submissionReceipts = rows.filter(
    (row) => row.action === 'experimental:assessment_submission',
  );
  if (new Set(submissionReceipts.map((row) => row.subject_id)).size !== submissionReceipts.length)
    block(ids, 'unresolved_scope', true);
  const receipts = new Map(
    rows
      .filter((row) => row.action === 'experimental:assessment_submission')
      .map((row) => [row.subject_id, row]),
  );
  const scopeBySubmission = new Map<string, string[]>();
  for (const [id, row] of receipts) {
    const scope = ScopeReceipt.safeParse(row.payload);
    if (!scope.success) {
      block(ids, 'unresolved_scope', true);
      continue;
    }
    scopeBySubmission.set(
      id,
      scope.data.learning_scope.questions.flatMap((q) => q.knowledge_ids),
    );
  }
  const pendingByKc = new Map<string, Set<string>>();
  const pending = (scope: string[], group: string) => {
    block(scope, 'pending_assessment');
    for (const id of scope) {
      const groups = pendingByKc.get(id) ?? new Set<string>();
      groups.add(group);
      pendingByKc.set(id, groups);
      const fact = result.get(id);
      if (fact) fact.pendingCount = groups.size;
    }
  };
  const capturedIds = new Set(native.map((row) => row.payload.submission_id));
  for (const [id, scope] of scopeBySubmission) {
    if (!capturedIds.has(id))
      pending(scope, String(receipts.get(id)?.payload.evaluation_group_id ?? id));
  }
  const scopeOf = (row: typeof event.$inferSelect) => {
    if (row.action === 'experimental:assessment_attempt') {
      const submission = row.payload.submission_id;
      return typeof submission === 'string' ? (scopeBySubmission.get(submission) ?? ids) : ids;
    }
    // Current question tags cannot disassociate an immutable historical contribution.
    const scope = LegacyScope.safeParse(row.payload.referenced_knowledge_ids);
    if (scope.success) return scope.data;
    block(ids, 'unresolved_scope', true);
    return ids;
  };
  const relevantAnswers = answers.filter((row) => scopeOf(row).some((id) => result.has(id)));
  const allowed = await allowedEventIds(
    tx,
    relevantAnswers.map((row) => row.id),
  );
  const questionIds = [...new Set(relevantAnswers.map((row) => row.subject_id))];
  const allowedQuestions = await allowedQuestionIds(tx, questionIds);
  for (const row of relevantAnswers) {
    const scope = scopeOf(row);
    if (!allowed.has(row.id) || !allowedQuestions.has(row.subject_id)) {
      block(scope, 'purpose_unavailable', true);
      continue;
    }
    if (
      !(await progressSourceAllowed(tx, { kind: 'event', id: row.id })) ||
      !(await progressSourceAllowed(tx, { kind: 'question', id: row.subject_id }))
    )
      block(scope, 'purpose_unavailable', true);
    if (row.action !== 'experimental:assessment_attempt') block(scope, 'legacy_history');
  }
  const activeIds = new Set((await filterActiveRows(tx, answers)).map((row) => row.id));
  // Validate stored inputs before the canonical readers consume their typed projections.
  const settlementRows = rows.filter((row) => row.action === 'experimental:assessment_settlement');
  const plans = new Map<string, z.infer<typeof Plan>>();
  let unreadable = false;
  for (const row of settlementRows) {
    if (row.payload.replay_inputs === null || row.payload.replay_inputs === undefined) continue;
    const parsed = Plan.safeParse(row.payload.replay_inputs);
    if (
      !parsed.success ||
      parsed.data.groupId !== row.payload.evaluation_group_id ||
      parsed.data.evaluationId !== row.payload.evaluation_id ||
      parsed.data.submissionId !== row.payload.submission_id
    ) {
      unreadable = true;
      block(ids, 'unreadable_settlement');
      continue;
    }
    plans.set(row.id, parsed.data);
  }
  // A malformed replay input cannot be handed to a typed canonical projection.
  if (unreadable) return result;
  const projection = await getMasteryProjection(tx, ids);
  for (const [id, fact] of result)
    if (fact.displayAllowed) fact.projection = projection.get(id) ?? null;
  const ledger = await loadSettlementEvents(tx);
  const live = liveAppliedSettlements(ledger);
  const verdicts = await resolveVerdictsForNativeAttempts(
    tx,
    native.filter((row) => scopeBySubmission.has(String(row.payload.submission_id))),
  );
  const membersByGroup = new Map<string, Array<NonNullable<ReturnType<typeof verdicts.get>>>>();
  for (const member of verdicts.values())
    membersByGroup.set(member.evaluation_group_id, [
      ...(membersByGroup.get(member.evaluation_group_id) ?? []),
      member,
    ]);
  const groupIds = [...membersByGroup.keys()];
  const candidates = groupIds.length
    ? await tx
        .select({
          groupId: evaluation.evaluation_group_id,
          id: evaluation.evaluation_id,
          attempt: evaluation.attempt,
        })
        .from(evaluation)
        .where(inArray(evaluation.evaluation_group_id, groupIds))
    : [];
  const groupScopes = new Map<string, string[]>();
  const contributing = new Map<string, Array<{ outcome: number; receiptId: string }>>();
  const seenGroups = new Set<string>();
  for (const row of relevantAnswers.filter(
    (row) => row.action === 'experimental:assessment_attempt',
  )) {
    const v = verdicts.get(row.id);
    const members = v ? (membersByGroup.get(v.evaluation_group_id) ?? [v]) : [];
    const scope = v?.knowledge_ids.length
      ? [...new Set(members.flatMap((m) => m.knowledge_ids))]
      : scopeOf(row);
    if (!v?.knowledge_ids.length) {
      block(scope, 'unresolved_scope');
      continue;
    }
    groupScopes.set(v.evaluation_group_id, scope);
    if (seenGroups.has(v.evaluation_group_id)) continue;
    seenGroups.add(v.evaluation_group_id);
    const outcome = nativeAttemptOutcome(v);
    const settlements = live.filter((s) => s.groupId === v.evaluation_group_id && !s.fsrsOnly);
    const matching = settlements.filter((s) => s.evaluationId === v.effective?.evaluation_id);
    if (
      outcome === 'pending' ||
      !v.head ||
      v.effective?.status !== 'completed' ||
      candidates.some(
        (c) => c.groupId === v.evaluation_group_id && c.attempt > (v.effective?.attempt ?? 0),
      )
    ) {
      pending(scope, v.evaluation_group_id);
      continue;
    }
    if (outcome === 'unsupported') block(scope, 'unsettled_assessment');
    if (
      [...verdicts].some(
        ([anchorId, member]) =>
          member.evaluation_group_id === v.evaluation_group_id && !activeIds.has(anchorId),
      )
    ) {
      if (settlements.some((s) => s.inputs.theta.applied)) block(scope, 'unreconciled_history');
      continue;
    }
    const terminalId = settlementRows
      .filter(
        (r) =>
          r.payload.evaluation_group_id === v.evaluation_group_id &&
          r.payload.evaluation_id === v.effective?.evaluation_id,
      )
      .at(-1)?.id;
    const terminal = ledger.filter((s) => s.id === terminalId).at(-1);
    if (
      !terminal ||
      !['applied', 'ineligible', 'withdrawn'].includes(terminal.effect ?? '') ||
      settlements.some((s) => s.evaluationId !== v.effective?.evaluation_id)
    ) {
      block(scope, 'unsettled_assessment');
      continue;
    }
    const independent = members.every(
      (m) => Assistance.safeParse(receipts.get(m.submission.submission_id)?.payload).success,
    );
    const occurredAt = new Date(
      Math.max(...members.map((m) => m.submission.submitted_at.getTime())),
    );
    if (occurredAt > asOf || v.head.updated_at > asOf) block(scope, 'future_evidence');
    for (const id of scope) {
      const fact = result.get(id);
      if (!fact) continue;
      const applied = matching.filter(
        (s) =>
          plans.get(s.id)?.theta.applied &&
          s.inputs.theta.applied &&
          s.inputs.theta.knowledgeIds.includes(id),
      );
      if (applied.length > 1) block([id], 'duplicate_contribution');
      let fullCorrect = false;
      let down = false;
      for (const s of applied) {
        const plan = plans.get(s.id);
        if (!plan?.theta.applied) continue;
        if (
          plan.occurrenceAt !== occurredAt.toISOString() ||
          !members.some((m) => m.submission.submission_id === plan.submissionId)
        )
          block([id], 'unreadable_settlement');
        const evidence = plan.theta.kcEvidence?.find((e) => e.kc_id === id);
        if (plan.theta.kcEvidence && !evidence) {
          block([id], 'unreadable_settlement');
          continue;
        }
        const direction = evidence?.outcome ?? plan.theta.outcome;
        const contributions = contributing.get(id) ?? [];
        contributions.push({ outcome: direction, receiptId: s.id });
        contributing.set(id, contributions);
        down ||= direction === 0;
        fullCorrect =
          outcome === 'success' &&
          direction === 1 &&
          (evidence?.weight ?? 1) === 1 &&
          independent &&
          plan.provenance.source === 'automatic' &&
          plan.provenance.assisted === false;
        if (!allowedQuestions.has(plan.theta.anchorQuestionId))
          block([id], 'purpose_unavailable', true);
      }
      fact.occurrences.push({
        groupId: v.evaluation_group_id,
        anchorId: v.revision.group_id,
        occurredAt: occurredAt.toISOString(),
        correct: fullCorrect,
        adverse: down || outcome === 'failure' || outcome === 'partial',
      });
    }
  }
  for (const row of rows.filter((row) => row.action === 'experimental:appeal_request')) {
    const groupId = row.payload.evaluation_group_id;
    if (typeof groupId !== 'string') {
      block(ids, 'unresolved_appeal');
      continue;
    }
    const scope = groupScopes.get(groupId);
    if (!scope) continue;
    const resolved = rows.some(
      (r) =>
        r.action === 'experimental:assessment_appeal_resolution' &&
        r.caused_by_event_id === row.id &&
        r.payload.disposition === 'effective',
    );
    if (!resolved) block(scope, 'unresolved_appeal');
  }
  const snapshots = rows.filter((row) => row.action === 'experimental:state_snapshot');
  for (const [id, fact] of result) {
    const history: Array<{ before: z.infer<typeof ThetaSnapshot>['before']; receiptId: string }> =
      [];
    for (const row of snapshots) {
      const parsed = Snapshot.safeParse(row.payload);
      if (!parsed.success) {
        block([id], 'unreadable_snapshot');
        continue;
      }
      for (const entry of parsed.data.theta_snapshots.filter(
        (s) => s.kc_id === id && (s.subject_kind ?? 'knowledge') === 'knowledge',
      )) {
        history.push({ before: entry.before, receiptId: parsed.data.attempt_event_id });
        if (!plans.get(parsed.data.attempt_event_id)?.scopeKcIds.includes(id))
          block([id], 'unknown_origin');
      }
    }
    const contributions = contributing.get(id) ?? [];
    if (!history.length || history[0].before !== null) block([id], 'unknown_origin');
    if (fact.projection && !relevantAnswers.some((row) => scopeOf(row).includes(id)))
      block([id], 'unknown_origin', true);
    if (contributions.some((c) => !history.some((h) => h.receiptId === c.receiptId)))
      block([id], 'missing_snapshot');
    const p = fact.projection;
    if (p?.provenance !== 'observed' || p.evidence_count <= 0) {
      fact.projection = null;
      block([id], 'no_observed_mastery');
      continue;
    }
    if (
      p.success_count !== contributions.filter((c) => c.outcome === 1).length ||
      p.fail_count !== contributions.filter((c) => c.outcome === 0).length ||
      p.evidence_count !== contributions.length
    )
      block([id], 'contribution_count_mismatch');
    if (p.beta_basis !== 'answered') block([id], 'unclosed_beta');
    if (
      ![p.mastery, p.mastery_lo, p.mastery_hi, p.beta, p.theta_precision].every(Number.isFinite) ||
      p.mastery_lo < 0 ||
      p.mastery_lo > p.mastery ||
      p.mastery > p.mastery_hi ||
      p.mastery_hi > 1 ||
      p.theta_precision <= 0
    ) {
      block([id], 'invalid_mastery');
      fact.projection = null;
    }
    fact.nativeCountsAvailable =
      fact.displayAllowed &&
      fact.reasons.every((reason) =>
        ['pending_assessment', 'unresolved_appeal', 'future_evidence'].includes(reason),
      );
    if (!fact.displayAllowed) fact.occurrences = [];
  }
  return result;
}
