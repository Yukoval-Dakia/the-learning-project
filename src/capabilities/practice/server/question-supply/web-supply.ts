// Demand-owned web text acquisition, submission and serving reconciliation.
// External work is fenced by append-only events; a lost acquisition/send receipt
// is UNKNOWN, never permission to repeat paid work. No proposal or revision writer.
// A placement demand runs only inside its claim's delivery (PlacementWebDelivery): the claim
// identity is checked field by field, paid acquisition needs the live attempt fence, every
// paid effect is recorded on the claim, and submit binds each question to the attempt.
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import { SourcedQuestion, SourcingImageCandidate } from '@/core/schema/sourcing';
import type { Db, Tx } from '@/db/client';
import {
  event,
  placement_starter_claim,
  question,
  question_admission_verification,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { webSupplyDemandKey as key, lockWebSupplyDemand } from '@/kernel/locks/question-supply';
import { readQuestionServing } from '@/kernel/read-models/question-serving';
import { answerClassCompatible } from '@/subjects/question-kind';
import {
  dispatchSourceVerifyIntents,
  readCandidateSubmitReceipt,
  submitPlacementSupplyCandidate,
  submitQuestionTool,
} from '../tools/submit-question';
import { type EnqueueVerifyFn, dispatchPendingVerifyIntents } from '../verify-dispatch-outbox';
import { SupplyTraceV1, type SupplyTraceV1T } from './evidence-demand';
import {
  PlacementStarterAdmissionError,
  assertPlacementAttemptFence,
} from './placement-starter-attempts';
import {
  assertPlacementPaidEffectAuthority,
  authorizePlacementQuestion,
  recordPlacementPaidEffect,
} from './placement-starter-paid-authority';
import type { PlacementWebDelivery } from './placement-starter-web-delivery';
import type { SupplyDemandItem } from './plan-executor';
import type { RunWebFetchCandidatesParams, RunWebFetchCandidatesResult } from './web-candidates';

const ACTION = 'experimental:web_supply';
const Candidate = z.object({
  candidateId: z.string(),
  question: SourcedQuestion,
  extractionHash: z.string(),
  sourceId: z.null(),
  knowledgeHints: z.array(z.string()),
  stagedAssetIds: z.array(z.string()).max(0),
});
const Binding = z.object({
  questionId: z.string(),
  revisionId: z.string(),
  digest: z.string(),
  generation: z.number().int(),
  publicationEventId: z.string(),
});
const Submission = z.object({
  candidate: Candidate,
  requestId: z.string(),
  request: submitQuestionTool.inputSchema,
  candidateDigest: z.string(),
  extractDigest: z.string(),
  receipt: submitQuestionTool.outputSchema.optional(),
  binding: Binding.optional(),
});
const State = z.object({
  version: z.literal(1),
  sequence: z.number().int().nonnegative(),
  demandId: z.string(),
  fingerprint: z.string(),
  item: z.object({
    demandId: z.string(),
    knowledgeId: z.string(),
    kind: z.string(),
    difficultyBand: z.string().nullable(),
    count: z.number().int().positive(),
    placementClaimId: z.string().optional(),
    objectiveOnly: z.boolean().optional(),
    kindRequired: z.boolean().optional(),
  }),
  trace: SupplyTraceV1.optional(),
  subjectId: z.string(),
  causeId: z.string().nullable(),
  producerTaskRunId: z.string(),
  phase: z.enum(['acquiring', 'submitting', 'verifying', 'fulfilled', 'blocked']),
  reason: z.string().nullable(),
  activeRequestId: z.string().nullable(),
  submissions: z.array(Submission),
  blockedSources: z.array(SourcingImageCandidate),
  queryPlan: z.array(z.string()),
  fetchedAt: z.string().nullable(),
  costUsd: z.number().nullable(),
  serving: z.array(Binding),
  observations: z.array(
    z.object({
      questionId: z.string(),
      revisionId: z.string().nullable(),
      generation: z.number().int(),
      hold: z.string().nullable(),
      verificationIds: z.array(z.string()),
    }),
  ),
});
type WebSupplyState = z.infer<typeof State>;

async function latest(db: Db | Tx, demandId: string): Promise<WebSupplyState | null> {
  const [row] = await db
    .select({ payload: event.payload })
    .from(event)
    .where(and(eq(event.action, ACTION), eq(event.subject_id, demandId)))
    .orderBy(desc(sql`(${event.payload}->>'sequence')::integer`))
    .limit(1);
  return row ? State.parse(row.payload) : null;
}
// Only this short event transaction takes the demand lock. It never nests under
// a learning/root/queue lock and never spans network, model or submit work.
async function save(db: Db, state: WebSupplyState, expected: number | null): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockWebSupplyDemand(tx, state.demandId);
    const prior = await latest(tx, state.demandId);
    if ((prior?.sequence ?? null) !== expected) return false;
    await writeEvent(tx, {
      id: `${key(state.demandId)}_${state.sequence}`,
      action: ACTION,
      subject_kind: 'query',
      subject_id: state.demandId,
      actor_kind: 'agent',
      actor_ref: 'supply_executor',
      outcome:
        state.phase === 'blocked' ? 'failure' : state.phase === 'fulfilled' ? 'success' : 'partial',
      payload: State.parse(state),
      caused_by_event_id: state.causeId,
      task_run_id: state.producerTaskRunId,
      cost_micro_usd: null,
      created_at: new Date(),
      session_id: null,
    });
    return true;
  });
}
async function advance(db: Db, state: WebSupplyState, changes: Partial<WebSupplyState>) {
  const next = State.parse({ ...state, ...changes, sequence: state.sequence + 1 });
  if (!(await save(db, next, state.sequence)))
    throw new Error(`web supply concurrent advance: ${state.demandId}`);
  return next;
}
async function latestRequired(db: Db, demandId: string) {
  const state = await latest(db, demandId);
  if (!state) throw new Error(`web supply state missing: ${demandId}`);
  return state;
}

async function submissionBinding(db: Db, submission: z.infer<typeof Submission>) {
  const receipt = submission.receipt;
  if (!receipt?.question_id) return null;
  // The flat publisher's enrich event and the typed submit receipt were committed
  // with publication. Do not bind whichever revision happens to be current later.
  const [published] = await db
    .select({ id: event.id, payload: event.payload, digest: question_revision.integrity_digest })
    .from(event)
    .innerJoin(
      question_revision,
      sql`${question_revision.revision_id} = ${event.payload}->>'revision_id'`,
    )
    .where(
      and(
        eq(event.action, 'experimental:assessment_publish'),
        eq(event.subject_id, receipt.group_id ?? receipt.question_id),
        receipt.revision_id
          ? sql`${event.payload}->>'revision_id' = ${receipt.revision_id}`
          : inArray(event.actor_ref, [
              'sourced-draft:sourcing_web',
              'submit-question:sourcing_web:enrich',
            ]),
      ),
    )
    .orderBy(desc(question_revision.revision_ordinal), asc(event.created_at))
    .limit(1);
  if (!published) return null;
  const p = published.payload;
  return Binding.parse({
    questionId: receipt.question_id,
    revisionId: p.revision_id,
    digest: published.digest,
    generation: p.admission_generation,
    publicationEventId: published.id,
  });
}

// Entire read, including serving's own queries, shares one snapshot. A successful
// source check alone cannot count as supply; every member of a group must serve.
async function observe(db: Db, state: WebSupplyState) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction isolation level repeatable read`);
    const serving: WebSupplyState['serving'] = [];
    const observations: WebSupplyState['observations'] = [];
    for (const submission of state.submissions) {
      const binding = submission.binding;
      if (!binding) continue;
      const [row] = await tx
        .select({ q: question, lifecycle: question_group_lifecycle, revision: question_revision })
        .from(question)
        .innerJoin(question_group_lifecycle, eq(question_group_lifecycle.group_id, question.id))
        .innerJoin(
          question_revision,
          eq(question_revision.revision_id, question_group_lifecycle.current_revision_id),
        )
        .where(eq(question.id, binding.questionId))
        .limit(1);
      if (!row) {
        observations.push({
          questionId: binding.questionId,
          revisionId: null,
          generation: binding.generation,
          hold: 'submitted_group_missing',
          verificationIds: [],
        });
        continue;
      }
      const { q, lifecycle: l, revision: r } = row;
      const verifications = await tx
        .select()
        .from(question_admission_verification)
        .where(
          inArray(question_admission_verification.revision_id, [binding.revisionId, r.revision_id]),
        );
      // Admission may publish the paid resolved contract. Accept ONLY the existing
      // admission receipt binding to this submitted base, never an unrelated edit.
      const paid = z
        .object({
          family: z.literal('question_admission_run'),
          entity_id: z.string(),
          entity_revision: z.string(),
          published_contract_digest: z.string(),
        })
        .safeParse(r.published_by?.paid_receipt);
      const sameCandidate =
        r.revision_id === binding.revisionId ||
        (paid.success &&
          paid.data.entity_id === q.id &&
          paid.data.entity_revision === binding.digest &&
          paid.data.published_contract_digest === r.integrity_digest);
      const projection = (await readQuestionServing(tx, [q.id])).byId.get(q.id);
      const uses = q.metadata?.allowed_uses;
      const allowed =
        !Array.isArray(uses) ||
        uses.length === 0 ||
        (state.trace?.allowed_uses ?? ['practice']).every((use) => uses.includes(use));
      const expires = q.metadata?.expires_at ?? q.metadata?.expired_at;
      const notExpired =
        expires == null || (typeof expires === 'string' && Date.parse(expires) > Date.now());
      const sourcePassed = verifications.some(
        (v) =>
          v.policy_id === 'source_verify@1' &&
          v.outcome === 'passed' &&
          (v.revision_id === binding.revisionId
            ? v.revision_digest === binding.digest
            : v.revision_digest === r.integrity_digest) &&
          v.generation <= l.scoring_admission_generation,
      );
      const usable =
        sourcePassed &&
        sameCandidate &&
        projection?.servable === true &&
        l.availability === 'general_pool' &&
        r.availability === 'general_pool' &&
        q.knowledge_ids.includes(state.item.knowledgeId) &&
        (state.item.kind === 'any' || answerClassCompatible(q.kind, state.item.kind)) &&
        allowed &&
        notExpired &&
        q.metadata?.archived_at == null &&
        q.metadata?.dismissed_at == null &&
        q.metadata?.exposure_blocked !== true;
      observations.push({
        questionId: q.id,
        revisionId: r.revision_id,
        generation: l.scoring_admission_generation,
        hold: !sameCandidate
          ? 'revision_changed'
          : usable
            ? null
            : (projection?.hold_reason ??
              (!sourcePassed ? 'awaiting_source_verification' : 'demand_not_servable')),
        verificationIds: verifications.map((v) => v.id),
      });
      if (usable)
        serving.push({
          ...binding,
          revisionId: r.revision_id,
          digest: r.integrity_digest,
          generation: l.scoring_admission_generation,
        });
    }
    return { serving, observations };
  });
}

function placementClaimOf(state: Pick<WebSupplyState, 'item' | 'trace'>): string | undefined {
  return state.item.placementClaimId ?? state.trace?.claim_id;
}

/** The demand must be exactly the claim's: identity is read from the claim row, never rebuilt. */
async function assertPlacementDemandBinding(
  db: Db,
  delivery: PlacementWebDelivery,
  input: {
    item: { demandId: string; knowledgeId: string; placementClaimId?: string };
    trace: SupplyTraceV1T | undefined;
    subjectId: string;
  },
): Promise<void> {
  const [claim] = await db
    .select()
    .from(placement_starter_claim)
    .where(eq(placement_starter_claim.id, delivery.attempt.claimId));
  const { item, trace } = input;
  const mismatch =
    claim?.supply_route !== 'sourcing_web' ||
    (item.placementClaimId !== undefined && item.placementClaimId !== claim.id) ||
    (trace?.claim_id !== undefined && trace.claim_id !== claim.id) ||
    (item.placementClaimId === undefined && trace?.claim_id === undefined) ||
    item.demandId !== claim.demand_id ||
    item.knowledgeId !== claim.knowledge_id ||
    input.subjectId !== claim.subject_id ||
    (trace !== undefined &&
      (trace.target_id !== claim.target_id ||
        trace.semantic_goal_revision_id !== claim.semantic_goal_revision_id));
  if (mismatch) {
    throw new PlacementStarterAdmissionError(
      `placement web demand does not match claim ${delivery.attempt.claimId}`,
    );
  }
}

/**
 * Re-bind this demand's already-submitted questions to the current delivery. A question a lost
 * earlier delivery submitted is moved onto this attempt with a new epoch (its late verifier
 * writes are then stale); the question is never re-acquired or re-submitted.
 */
async function bindPlacementSubmissions(
  db: Db,
  state: WebSupplyState,
  delivery: PlacementWebDelivery,
): Promise<void> {
  const bound: string[] = [];
  for (const submission of state.submissions) {
    const receipt = submission.receipt;
    if (receipt?.status !== 'pending' || !receipt.question_id) continue;
    const questionId = receipt.question_id;
    const authority = await db.transaction(async (tx) => {
      await assertPlacementAttemptFence(tx, delivery.attempt);
      return authorizePlacementQuestion(tx, {
        attempt: delivery.attempt,
        questionId,
        canonicalHash: submission.candidate.extractionHash.slice('sha256:'.length),
        verifier: 'source_verify',
        supplyTrace: state.trace,
        allowPersistedReplay: true,
        rebindSuperseded: true,
        now: new Date(),
      });
    });
    if (authority) bound.push(questionId);
  }
  if (bound.length) await dispatchSourceVerifyIntents(db, bound);
}

/** Resume never starts acquisition or re-submits an unknown send. Startup/nightly
 * also consumes this operation, after draining the original verify outbox. A placement
 * demand only advances inside its claim delivery. */
export async function resumeWebSupply(
  db: Db,
  demandId: string,
  placement?: PlacementWebDelivery,
): Promise<WebSupplyState> {
  let state = await latestRequired(db, demandId);
  if (placementClaimOf(state) && !placement) return state;
  if (state.phase === 'blocked' || state.phase === 'fulfilled') {
    // A terminal demand is not re-driven, but a later delivery of its claim still takes over
    // the questions it already submitted (a crash may have hit after the demand settled).
    if (placement) await bindPlacementSubmissions(db, state, placement);
    return state;
  }
  if (state.phase === 'acquiring') return state;
  for (let index = 0; index < state.submissions.length; index++) {
    let submission = state.submissions[index];
    if (!submission.receipt) {
      const prior = await readCandidateSubmitReceipt(db, submission.request);
      if (prior.status === 'reused')
        return advance(db, state, { phase: 'blocked', reason: 'request_id_reused' });
      if (prior.status === 'replay') submission = { ...submission, receipt: prior.receipt };
      else if (state.activeRequestId === submission.requestId) {
        // A concurrent submit may still be running. Leave its fence intact; do not
        // manufacture a conflict or a new send when no committed receipt exists.
        return advance(db, state, { reason: 'submit_receipt_pending_or_unknown' });
      } else {
        if (state.trace?.needed_by && Date.parse(state.trace.needed_by) <= Date.now())
          return advance(db, state, { phase: 'blocked', reason: 'deadline_exhausted' });
        const claimed = await advance(db, state, {
          phase: 'submitting',
          activeRequestId: submission.requestId,
        });
        state = claimed;
        const submitCtx = {
          db,
          taskRunId: state.producerTaskRunId,
          logTaskRunId: state.producerTaskRunId,
          callerActor: { kind: 'agent', ref: 'sourcing' },
          ...(state.causeId ? { causedByEventId: state.causeId } : {}),
        } as const;
        const receipt = placement
          ? await submitPlacementSupplyCandidate(submitCtx, submission.request, placement.attempt)
          : await submitQuestionTool.execute(submitCtx, submission.request);
        submission = { ...submission, receipt };
      }
    }
    if (!submission.binding) {
      const binding = await submissionBinding(db, submission);
      if (binding) submission = { ...submission, binding };
    }
    if (
      canonicalHash(submission) === canonicalHash(state.submissions[index]) &&
      state.activeRequestId === null
    )
      continue;
    const submissions = [...state.submissions];
    submissions[index] = submission;
    state = await advance(db, state, { submissions, activeRequestId: null, phase: 'verifying' });
  }
  if (placement) await bindPlacementSubmissions(db, state, placement);
  const observed = await observe(db, state);
  const fulfilled = observed.serving.length >= state.item.count;
  const unsubmitted = state.submissions.some((s) => !s.receipt);
  const terminalFailure = observed.observations.some(
    (o) =>
      o.hold != null && !['awaiting_admission', 'awaiting_source_verification'].includes(o.hold),
  );
  const noBindings = !state.submissions.some((s) => s.binding);
  const cannotReachCount = state.submissions.filter((s) => s.binding).length < state.item.count;
  const expired = !!state.trace?.needed_by && Date.parse(state.trace.needed_by) <= Date.now();
  const phase: WebSupplyState['phase'] = fulfilled
    ? 'fulfilled'
    : !unsubmitted && (terminalFailure || noBindings || cannotReachCount || expired)
      ? 'blocked'
      : 'verifying';
  const reason = fulfilled
    ? null
    : phase === 'blocked'
      ? expired
        ? 'deadline_exhausted'
        : 'candidate_not_servable'
      : 'awaiting_verification_and_admission';
  return advance(db, state, { phase, reason, ...observed });
}

export async function runWebSupply(params: {
  db: Db;
  item: SupplyDemandItem;
  trace?: unknown;
  causeId: string | null;
  fetch: (
    params: Omit<RunWebFetchCandidatesParams, 'deps'>,
  ) => Promise<RunWebFetchCandidatesResult>;
  subjectProfile: RunWebFetchCandidatesParams['input']['subjectProfile'];
  /** Claim delivery authority; required for (and only meaningful on) a placement demand. */
  placement?: PlacementWebDelivery;
}): Promise<WebSupplyState> {
  const { db, placement } = params;
  const trace = params.trace === undefined ? undefined : SupplyTraceV1.parse(params.trace);
  const item = { ...params.item, demandId: trace?.demand_id ?? params.item.demandId };
  const placementClaimId = item.placementClaimId ?? trace?.claim_id;
  if (placementClaimId && placement) {
    await assertPlacementDemandBinding(db, placement, {
      item,
      trace,
      subjectId: params.subjectProfile.id,
    });
  }
  const intent = {
    item: { ...item, routePreference: undefined },
    trace: trace ? { ...trace, trace_id: undefined } : undefined,
    subjectId: params.subjectProfile.id,
  };
  const fingerprint = canonicalHash(intent);
  const prior = await latest(db, item.demandId);
  if (prior) {
    if (prior.fingerprint !== fingerprint)
      throw new Error(`web demand identity conflict: ${item.demandId}`);
    return resumeWebSupply(db, item.demandId, placementClaimId ? placement : undefined);
  }
  // A placement demand outside its claim's delivery has no paid authority: refuse it.
  const reason =
    placementClaimId && !placement
      ? 'placement_attempt_required'
      : trace?.needed_by && Date.parse(trace.needed_by) <= Date.now()
        ? 'deadline_exhausted'
        : trace?.max_budget_micro_usd === 0
          ? 'budget_exhausted'
          : null;
  let state = State.parse({
    version: 1,
    sequence: 0,
    demandId: item.demandId,
    fingerprint,
    item,
    trace,
    subjectId: params.subjectProfile.id,
    causeId: params.causeId,
    producerTaskRunId: `web_supply_run_${createHash('sha256').update(item.demandId).digest('hex')}`,
    phase: reason ? 'blocked' : 'acquiring',
    reason: reason ?? 'acquisition_receipt_pending',
    activeRequestId: null,
    submissions: [],
    blockedSources: [],
    queryPlan: [],
    fetchedAt: null,
    costUsd: null,
    serving: [],
    observations: [],
  });
  // Fence BEFORE the acquisition fence is written: a stale delivery must neither spend nor
  // leave an 'acquiring' state that would read as an unknown paid outcome.
  const paidAuthority =
    placementClaimId && placement
      ? { scope: 'attempt' as const, attempt: placement.attempt }
      : null;
  if (paidAuthority && !reason) {
    await placement?.heartbeat.assertHealthy();
    await assertPlacementPaidEffectAuthority(db, paidAuthority);
  }
  if (!(await save(db, state, null)))
    return resumeWebSupply(db, item.demandId, placementClaimId ? placement : undefined);
  if (reason) return state;
  const recordAcquisition = async (providerTaskRunId: string | null, costUsd: number | null) => {
    if (!paidAuthority) return;
    await recordPlacementPaidEffect(db, {
      authority: paidAuthority,
      kind: 'web_acquisition',
      invocationKey: `${paidAuthority.attempt.attemptId}:web_acquisition:${item.demandId}`,
      providerTaskRunId,
      costUsd,
    });
  };
  let fetched: RunWebFetchCandidatesResult;
  try {
    fetched = await params.fetch({
      db,
      input: {
        anchorKnowledgeId: item.knowledgeId,
        count: item.count,
        ...(item.kind !== 'any' ? { kind: item.kind } : {}),
        objectiveOnly: item.objectiveOnly,
        kindRequired: item.kindRequired,
        subjectProfile: params.subjectProfile,
      },
      ctx: {
        taskRunId: state.producerTaskRunId,
        producerTaskRunId: state.producerTaskRunId,
        ...(params.causeId ? { causedByEventId: params.causeId } : {}),
        ...(trace?.needed_by ? { deadlineAt: Date.parse(trace.needed_by) } : {}),
      },
    });
  } catch {
    // The agent may have spent before failing: its cost is unknown, never zero.
    await recordAcquisition(null, null);
    return advance(db, state, { phase: 'blocked', reason: 'acquisition_outcome_unknown' });
  }
  if (fetched.status === 'failed') {
    // Only a missing anchor or search backend fails before the paid agent call.
    if (!['anchor_not_found', 'web_search_unavailable'].includes(fetched.failureClass))
      await recordAcquisition(null, null);
    return advance(db, state, { phase: 'blocked', reason: fetched.failureClass });
  }
  await recordAcquisition(fetched.taskRunId, fetched.costUsd);
  // The actual runner id is canonical. A legacy/injected fetch without one cannot
  // produce a traceable supply commit; preserve its result and stop honestly.
  const candidates = fetched.candidates.slice(0, item.count);
  state = await advance(db, state, {
    phase: fetched.taskRunId && candidates.length ? 'verifying' : 'blocked',
    reason: !fetched.taskRunId
      ? 'producer_identity_missing'
      : !candidates.length
        ? 'text_evidence_unavailable'
        : null,
    producerTaskRunId: fetched.taskRunId ?? state.producerTaskRunId,
    submissions: candidates.map((c, index) => {
      const requestId = `${key(item.demandId)}_candidate_${index}_${c.extractionHash.slice(7, 23)}`;
      const request = submitQuestionTool.inputSchema.parse({
        request_id: requestId,
        source_route: 'sourcing_web',
        candidate: {
          candidate_id: c.candidateId,
          question: c.question,
          extraction_hash: c.extractionHash,
          source_id: null,
          knowledge_hints: c.knowledgeHints,
          staged_asset_ids: [],
          figures: null,
          image_refs: null,
          structured: null,
        },
        knowledge_ids: [
          item.knowledgeId,
          ...c.question.knowledge_ids.filter((id) => id !== item.knowledgeId),
        ],
        attribution_state: 'matched',
        subject_id: params.subjectProfile.id,
        demand_id: item.demandId,
        ...(trace ? { supply_trace: trace } : {}),
      });
      return {
        candidate: c,
        candidateDigest: canonicalHash(c),
        extractDigest: canonicalHash(c.question.extract),
        requestId,
        request,
      };
    }),
    blockedSources: fetched.imageCandidates,
    queryPlan: fetched.queryPlan,
    fetchedAt: fetched.fetchedAt,
    costUsd: fetched.costUsd,
  });
  return resumeWebSupply(db, item.demandId, placementClaimId ? placement : undefined);
}

export async function recoverWebSupplies(
  db: Db,
  options: { enqueue: EnqueueVerifyFn; limit?: number },
) {
  const rows = await db.execute<{ demand_id: string }>(sql`
    select subject_id as demand_id from (
      select distinct on (subject_id) subject_id, payload, created_at from ${event}
      where action = ${ACTION} order by subject_id, (payload->>'sequence')::integer desc
    ) latest where payload->>'phase' in ('submitting', 'verifying')
    order by created_at, subject_id limit ${options.limit ?? 50}`);
  for (const row of rows) {
    const state = await latestRequired(db, row.demand_id);
    const questionIds = state.submissions.flatMap((s) =>
      s.receipt?.question_id ? [s.receipt.question_id] : [],
    );
    if (questionIds.length)
      await dispatchPendingVerifyIntents(db, { questionIds, enqueue: options.enqueue });
    // A placement demand is driven by its claim's own delivery job (pg-boss redelivery and the
    // placement recovery sweeper), never by this unauthenticated sweep.
    if (placementClaimOf(state)) continue;
    await resumeWebSupply(db, row.demand_id);
  }
  return { scanned: rows.length };
}
