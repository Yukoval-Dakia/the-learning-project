// Production entry for gap tickets. A server-written ticket event, the preparer job and the
// dispatcher-compatible dispatch ledger are one transaction; the event id becomes the
// submission's causal anchor. Admission reads that anchor as supply lineage; it never treats
// `submit_question:*` as a pipeline publisher because the preparer may have read learner
// mistakes into the question. The ticket also carries the filing session and its caused-by
// edge, so the purpose closure can reach the session's source document; the demand's free
// text itself is caller-written and is not filtered here (YUK-1938).
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { writeEvent } from '@/kernel/events';
import { lockSupplyTargetFingerprint } from '@/kernel/locks/question-supply';
import { EvidenceDemandV1, type EvidenceDemandV1T } from '@/kernel/supply-contracts';
import { getStartedBoss } from '@/server/boss/client';
import { SUPPLY_DISPATCH_COOLDOWN_DAYS, recentlyDispatchedFingerprints } from './dispatcher';
import {
  PREPARER_TICKET_SEND,
  type PreparerDispatchBoss,
  drainQuestionPreparerDispatch,
  writePreparerDispatchIntent,
} from './preparer-dispatch';
import type { QuestionSupplyTarget } from './target-discovery';

export const QUESTION_PREPARER_TICKET_ACTION = 'experimental:question_preparer_ticket';
/** Server-only actor; admission's lineage union admits exactly this writer. */
export const QUESTION_PREPARER_TICKET_ACTOR = 'practice:question_preparer';

export type QuestionPreparerEnqueueResult =
  | { status: 'dispatched'; event_id: string; job_id: string; ledger_event_id: string }
  | { status: 'skipped'; fingerprint: string; stop_condition: string };

export interface QuestionPreparerTicketScope {
  /** Learner session that filed the demand: purpose closure reaches its bound document. */
  sessionId?: string | null;
  /** `fbgap|<request_id>` filing event: the ticket's causal parent. */
  filingEventId?: string | null;
  /**
   * Actor recorded on the dispatcher-compatible `experimental:question_supply` ledger event.
   * Defaults to the bank-gap writer; manual filings pass their own so the ledger does not
   * attribute an operator ticket to the learner tool. The cooldown query does not filter on
   * this actor (action + payload.status + fingerprint only), so attribution stays free.
   */
  ledgerActorRef?: string;
}

/**
 * File one durable gap ticket under the same 7-day fingerprint cooldown as the old
 * dispatcher (same query, same days). The cooldown check, ticket event, dispatch intent
 * (complete ticket + stable delivery id) and the dispatcher-compatible ledger share one
 * transaction, so two same-gap filings cannot both open a paid run and a lost send cannot
 * block a new ticket: the journal drain owns the bound id until the engine accepts it.
 * The caller owns request-level idempotency.
 */
export async function enqueueQuestionPreparerTicket(
  db: Db,
  ticket: EvidenceDemandV1T,
  target: QuestionSupplyTarget,
  scope: QuestionPreparerTicketScope = {},
  now = new Date(),
  boss?: PreparerDispatchBoss,
): Promise<QuestionPreparerEnqueueResult> {
  const parsed = EvidenceDemandV1.parse(ticket);
  const eventId = newId();
  const resolvedBoss = boss ?? ((await getStartedBoss()) as PreparerDispatchBoss);
  const result = await db.transaction(async (tx) => {
    // Same-fingerprint serialization: the old dispatcher only throttled after the fact; the
    // transaction makes the check-then-enqueue atomic without a new ledger.
    await lockSupplyTargetFingerprint(tx, target.fingerprint);
    const recent = await recentlyDispatchedFingerprints(
      tx,
      [target.fingerprint],
      SUPPLY_DISPATCH_COOLDOWN_DAYS,
    );
    if (recent.has(target.fingerprint)) {
      return {
        status: 'skipped',
        fingerprint: target.fingerprint,
        stop_condition: `cooldown: same fingerprint dispatched within last ${SUPPLY_DISPATCH_COOLDOWN_DAYS}d; skipping re-dispatch to avoid unbounded job-spam`,
      } satisfies QuestionPreparerEnqueueResult;
    }
    await writeEvent(tx, {
      id: eventId,
      actor_kind: 'system',
      actor_ref: QUESTION_PREPARER_TICKET_ACTOR,
      action: QUESTION_PREPARER_TICKET_ACTION,
      subject_kind: 'query',
      subject_id: parsed.demand_id,
      // The ticket text itself is caller-written free text; binding the filing session and
      // its caused-by edge keeps the purpose closure able to reach the source document.
      session_id: scope.sessionId ?? null,
      caused_by_event_id: scope.filingEventId ?? null,
      payload: {
        demand_id: parsed.demand_id,
        subject_id: parsed.subject_id,
        knowledge_ids: parsed.claim.knowledge_ids,
        task_kinds: parsed.task.kinds,
      },
      created_at: now,
    });
    // Bind the stable delivery identity while the fingerprint lock is held: the complete
    // ticket rides in the intent, so a later drain resend never rebuilds it from the
    // summary above. The engine is not called inside this transaction.
    const jobId = await writePreparerDispatchIntent(tx, {
      kind: 'ticket',
      data: { ticket: parsed, ticket_event_id: eventId },
      send: PREPARER_TICKET_SEND,
    });
    // The old criterion reads `experimental:question_supply` with payload.status
    // 'dispatched' and a top-level fingerprint; write that same record for the next filing.
    const ledgerEventId = newId();
    await writeEvent(tx, {
      id: ledgerEventId,
      actor_kind: 'agent',
      actor_ref: scope.ledgerActorRef ?? 'file_bank_gap',
      action: 'experimental:question_supply',
      subject_kind: 'query',
      subject_id: target.id,
      outcome: 'success',
      payload: {
        target_id: target.id,
        fingerprint: target.fingerprint,
        gap_kind: target.gapKind,
        subject_id: target.subjectId,
        knowledge_ids: target.knowledgeIds,
        kind: target.kind,
        difficulty_band: target.difficultyBand,
        desired_count: target.desiredCount,
        min_source_tier: target.minSourceTier,
        priority: target.priority,
        route_plan: ['question_preparer'],
        chosen_route: 'question_preparer',
        status: 'dispatched',
        job_id: jobId,
        stop_condition: `enqueued question_preparer_run (job ${jobId}, ticket ${eventId}); satisfied when ${target.desiredCount} usable question(s) meet the ticket's inventory goal`,
        reason: target.reason,
        constraints: target.constraints,
      },
      created_at: now,
    });
    return {
      status: 'dispatched',
      event_id: eventId,
      job_id: jobId,
      ledger_event_id: ledgerEventId,
    } satisfies QuestionPreparerEnqueueResult;
  });
  // The obligation is committed; deliver under the bound id and let the journal drain
  // own any retry. A throw here leaves the intent pending for the next drain pass.
  if (result.status === 'dispatched') {
    await drainQuestionPreparerDispatch(db, resolvedBoss, { jobId: result.job_id });
  }
  return result;
}
