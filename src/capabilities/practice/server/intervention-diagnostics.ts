import { and, desc, eq, gt, inArray, isNull, lte, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { newId } from '@/core/ids';
import { JudgeOnEvent, ReviewOnQuestion } from '@/core/schema/event/known';
import {
  INTERVENTION_CONTRACT_VERSION,
  INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
  InterventionDiagnosticQuestionMetadata,
  InterventionPackage,
  type InterventionPackageT,
  InterventionSettlement,
  type InterventionSettlementT,
  InterventionSnapshot,
  type InterventionSnapshotT,
} from '@/core/schema/intervention';
import type { Db, Tx } from '@/db/client';
import { event, job_events, practice_stream_item, question } from '@/db/schema';
import { getEventById } from '@/kernel/events';
import { enrollFsrsStateIfAbsent, retireQuestionFsrsState } from '@/server/fsrs/state';
import { initialFsrsState } from './fsrs';
import { JUDGE_PENDING_ATTEMPT_ACTION } from './judge-run-dispatch';
import { JUDGE_RUN_EVENTS, JUDGE_RUN_TABLE } from './judge-run-status';
import { streamLocalDate } from './stream-date';

export const INTERVENTION_DIAGNOSTIC_CLAIM_LEASE_MS = 10 * 60 * 1000;

function diagnosticMetadata(input: {
  interventionId: string;
  version: number;
  knowledgeId: string;
  kind: 'immediate' | 'delayed' | 'transfer';
  dueAt: string;
  probeSpec: InterventionPackageT['diagnostics']['immediate']['probe_spec'];
}): Record<string, unknown> {
  return {
    intervention_diagnostic: InterventionDiagnosticQuestionMetadata.parse({
      schema_version: INTERVENTION_CONTRACT_VERSION,
      intervention_id: input.interventionId,
      intervention_version: input.version,
      diagnostic_kind: input.kind,
      knowledge_id: input.knowledgeId,
      due_at: input.dueAt,
    }),
    // The multimodal-direct judge consumes this canonical response-aware
    // contract even when the diagnostic itself carries no images.
    probe_spec: input.probeSpec,
  };
}

export function learnerFacingInterventionDiagnosticPrompt(
  packageValue: InterventionPackageT,
  kind: 'immediate' | 'delayed' | 'transfer',
): string {
  const probePrompt = packageValue.diagnostics[kind].probe_spec.prompt_md;
  if (kind !== 'immediate') return probePrompt;

  // The intervention must exist on a learner-visible surface before an outcome
  // can be attributed to it. Its immediate one-shot is that delivery surface:
  // approved material renders first, then the response-aware check. Later cards
  // stay probe-only so they measure retention/transfer instead of re-teaching.
  return [
    `# ${packageValue.material.title_md}`,
    packageValue.material.body_md,
    '---',
    '## 立即检验',
    probePrompt,
  ].join('\n\n');
}

export function questionKnowledgeIdsForJudge(input: {
  source: string | null;
  metadata: Record<string, unknown> | null;
  knowledge_ids: string[] | null;
}): string[] {
  if (input.source !== INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE) {
    return input.knowledge_ids ?? [];
  }
  const diagnostic = InterventionDiagnosticQuestionMetadata.parse(
    input.metadata?.intervention_diagnostic,
  );
  return [diagnostic.knowledge_id];
}

export async function loadLatestTrustedInterventionDiagnosticVerdict(
  db: Db,
  reviewEventId: string,
) {
  const candidates = await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'judge'),
        eq(event.subject_kind, 'event'),
        eq(event.subject_id, reviewEventId),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(50);

  for (const candidate of candidates) {
    const enveloped = await getEventById(db, candidate.id);
    if (!enveloped || enveloped.correction_status.state !== 'active') continue;
    const parsed = JudgeOnEvent.safeParse(enveloped);
    if (!parsed.success || parsed.data.payload.judge_route !== 'multimodal_direct') continue;
    const verdict = parsed.data.payload.coarse_outcome;
    if (verdict !== 'correct' && verdict !== 'partial' && verdict !== 'incorrect') continue;
    const provenance = parsed.data.payload.execution_provenance;
    if (provenance?.kind !== 'invoked' && provenance?.kind !== 'supplied_verified') continue;
    const rawPayload =
      candidate.payload && typeof candidate.payload === 'object'
        ? (candidate.payload as Record<string, unknown>)
        : {};
    return {
      event: enveloped,
      verdict,
      confidence: parsed.data.payload.cause.confidence,
      feedbackMd:
        typeof rawPayload.feedback_md === 'string' && rawPayload.feedback_md.trim()
          ? rawPayload.feedback_md
          : null,
    } as const;
  }
  return null;
}

export interface CommittedInterventionDiagnosticAttempt {
  review_event: {
    id: string;
    rating: 'again' | 'hard' | 'good';
  };
  judge: {
    route: 'multimodal_direct';
    coarse_outcome: 'correct' | 'partial' | 'incorrect';
    confidence: number;
    feedback_md: string;
    suggested_rating: 'again' | 'hard' | 'good';
    judge_event_id: string;
  };
}

/**
 * Recover the canonical one-shot result after refresh, response loss, or a
 * concurrent duplicate submission. The active trusted judge event is the
 * verdict authority; the immutable review supplies the rating and a fallback
 * feedback string for historical rows whose judge payload omitted feedback_md.
 */
export async function loadCommittedInterventionDiagnosticAttempt(
  db: Db,
  questionId: string,
): Promise<CommittedInterventionDiagnosticAttempt | null> {
  const candidates = await db
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, 'review'),
        eq(event.subject_kind, 'question'),
        eq(event.subject_id, questionId),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(50);

  for (const candidate of candidates) {
    const review = await getEventById(db, candidate.id);
    if (!review || review.correction_status.state !== 'active') continue;
    const parsedReview = ReviewOnQuestion.safeParse(review);
    if (!parsedReview.success) continue;
    const effective = await loadLatestTrustedInterventionDiagnosticVerdict(db, review.id);
    if (!effective) continue;
    const suggestedRating =
      effective.verdict === 'correct' ? 'good' : effective.verdict === 'partial' ? 'hard' : 'again';
    return {
      review_event: {
        id: review.id,
        rating: parsedReview.data.payload.fsrs_rating,
      },
      judge: {
        route: 'multimodal_direct',
        coarse_outcome: effective.verdict,
        confidence: effective.confidence,
        feedback_md:
          effective.feedbackMd ??
          parsedReview.data.payload.judge?.feedback_md ??
          (effective.verdict === 'correct'
            ? '回答正确。'
            : effective.verdict === 'partial'
              ? '回答部分正确。'
              : '回答不正确。'),
        suggested_rating: suggestedRating,
        judge_event_id: effective.event.id,
      },
    };
  }
  return null;
}

async function appendImmediateDiagnosticToLiveStream(
  tx: Tx,
  input: {
    questionId: string;
    interventionId: string;
    interventionVersion: number;
    now: Date;
  },
): Promise<void> {
  const date = streamLocalDate(input.now);
  // Serialize with lazy/nightly/recompose writers. If no stream exists yet,
  // leave it empty: the first normal composition will pick this newly-due FSRS
  // card. If today's stream already exists, append atomically so its "stream is
  // non-empty" fast path cannot strand the intervention until tomorrow.
  // Do not let a busy stream writer stall the activation worker forever.
  // A timeout aborts this transaction for the normal job retry; after acquiring
  // the shared lock, restore the transaction default for unrelated writes.
  await tx.execute(sql.raw("SET LOCAL lock_timeout = '5s'"));
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`intervention:deliver:${input.questionId}`}))`,
  );
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`stream:compose:${date}`}))`);
  await tx.execute(sql.raw("SET LOCAL lock_timeout = '0'"));
  const [existingDelivery] = await tx
    .select({ id: practice_stream_item.id, status: practice_stream_item.status })
    .from(practice_stream_item)
    .where(
      and(
        eq(practice_stream_item.item_kind, 'question'),
        eq(practice_stream_item.ref_id, input.questionId),
        isNull(practice_stream_item.session_id),
      ),
    )
    .limit(1);
  if (existingDelivery) {
    let restorePending = existingDelivery.status === 'skipped';
    if (existingDelivery.status === 'done') {
      const [attempt] = await tx
        .select({ id: event.id })
        .from(event)
        .where(
          and(
            eq(event.action, 'review'),
            eq(event.subject_kind, 'question'),
            eq(event.subject_id, input.questionId),
            sql`${event.payload} ->> 'stream_item_id' = ${existingDelivery.id}`,
          ),
        )
        .limit(1);
      restorePending = !attempt;
    }
    if (restorePending) {
      await tx
        .update(practice_stream_item)
        .set({ status: 'pending', updated_at: input.now })
        .where(eq(practice_stream_item.id, existingDelivery.id));
    }
    return;
  }

  const [current] = await tx
    .select({
      count: sql<number>`count(*)::int`,
      maxPosition: sql<number>`coalesce(max(${practice_stream_item.position}), 0)::int`,
    })
    .from(practice_stream_item)
    .where(and(eq(practice_stream_item.date, date), isNull(practice_stream_item.session_id)));
  if (!current || current.count === 0) return;

  await tx
    .insert(practice_stream_item)
    .values({
      id: newId(),
      date,
      session_id: null,
      position: current.maxPosition + 1,
      item_kind: 'question',
      ref_id: input.questionId,
      source: 'intervention',
      status: 'pending',
      reasoning: '这份针对当前薄弱点的材料已准备好；先阅读，再完成一次即时检验。',
      added_by: 'composer_live',
      signals: {
        interventionDelivery: {
          interventionId: input.interventionId,
          interventionVersion: input.interventionVersion,
          diagnosticKind: 'immediate',
        },
      },
      created_at: input.now,
      updated_at: input.now,
    })
    .onConflictDoNothing();
}

/**
 * Materialize all three reviewed package diagnostics into the existing learner
 * review surface. Each is a one-shot question-scoped FSRS card so the exact
 * authored probe—not a same-KC substitute—appears when its fixed due time arrives.
 */
export async function materializeInterventionDiagnostics(
  tx: Tx,
  input: {
    package: InterventionPackageT;
    settlement: InterventionSettlementT;
    snapshot: InterventionSnapshotT;
    now: Date;
    /**
     * Set only by the aggregate transaction that records the first immediate
     * review. It activates and re-enrolls the newly anchored follow-ups in the
     * same transaction as the settlement update.
     */
    activateAnchoredFollowups?: boolean;
  },
): Promise<void> {
  const packageValue = InterventionPackage.parse(input.package);
  const settlement = InterventionSettlement.parse(input.settlement);
  const snapshot = InterventionSnapshot.parse(input.snapshot);
  const sourceRef = `${snapshot.intervention_id}@${snapshot.intervention_version}`;
  const kinds = ['immediate', 'delayed', 'transfer'] as const;
  const followupsReady = settlement.diagnostics.immediate.status !== 'scheduled';
  const readyScheduledIds = kinds
    .filter(
      (kind) =>
        settlement.diagnostics[kind].status === 'scheduled' &&
        (kind === 'immediate' || followupsReady),
    )
    .map((kind) => settlement.diagnostics[kind].question_id);

  await tx
    .insert(question)
    .values(
      kinds.map((kind) => {
        const diagnostic = packageValue.diagnostics[kind];
        const scheduled = settlement.diagnostics[kind];
        return {
          id: scheduled.question_id,
          kind: 'short_answer',
          prompt_md: learnerFacingInterventionDiagnosticPrompt(packageValue, kind),
          reference_md: diagnostic.probe_spec.reference_md,
          judge_kind_override: 'multimodal_direct',
          knowledge_ids: [],
          difficulty: 3,
          source: INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
          source_ref: sourceRef,
          // Product-owned diagnostics have already passed package authoring,
          // independent review, deterministic validation, and the lineage proof below.
          draft_status:
            scheduled.status === 'scheduled' && (kind === 'immediate' || followupsReady)
              ? 'active'
              : 'draft',
          metadata: diagnosticMetadata({
            interventionId: snapshot.intervention_id,
            version: snapshot.intervention_version,
            knowledgeId: snapshot.conjecture.knowledge_id,
            kind,
            dueAt: scheduled.due_at,
            probeSpec: diagnostic.probe_spec,
          }),
          figures: [],
          image_refs: [],
          created_at: input.now,
          updated_at: input.now,
        };
      }),
    )
    .onConflictDoNothing();

  const ids = kinds.map((kind) => settlement.diagnostics[kind].question_id);
  // A synchronous process can die after the active→draft one-shot claim but
  // before its review transaction commits. Recovery revisits active eligible
  // interventions every two minutes, so reclaim an expired draft that has no
  // immutable review and no live durable pending-attempt evidence. A terminal
  // FAILED attempt is permanent audit evidence, not an eternal claim fence; a
  // later REQUEUED marker reopens that same run and protects it again.
  const staleClaimBefore = new Date(input.now.getTime() - INTERVENTION_DIAGNOSTIC_CLAIM_LEASE_MS);
  const terminalRun = alias(job_events, 'terminal_intervention_diagnostic_run');
  const reopenedRun = alias(job_events, 'reopened_intervention_diagnostic_run');
  await tx
    .update(question)
    .set({ draft_status: 'active', updated_at: input.now })
    .where(
      and(
        inArray(question.id, readyScheduledIds),
        eq(question.source, INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE),
        eq(question.draft_status, 'draft'),
        lte(question.updated_at, staleClaimBefore),
        notExists(
          tx
            .select({ id: event.id })
            .from(event)
            .where(
              and(
                eq(event.subject_kind, 'question'),
                eq(event.subject_id, question.id),
                eq(event.action, 'review'),
              ),
            ),
        ),
        notExists(
          tx
            .select({ id: event.id })
            .from(event)
            .where(
              and(
                eq(event.subject_kind, 'question'),
                eq(event.subject_id, question.id),
                eq(event.action, JUDGE_PENDING_ATTEMPT_ACTION),
                notExists(
                  tx
                    .select({ id: terminalRun.id })
                    .from(terminalRun)
                    .where(
                      and(
                        eq(terminalRun.business_table, JUDGE_RUN_TABLE),
                        eq(terminalRun.business_id, sql`${event.payload}->>'run_id'`),
                        eq(terminalRun.event_type, JUDGE_RUN_EVENTS.FAILED),
                        notExists(
                          tx
                            .select({ id: reopenedRun.id })
                            .from(reopenedRun)
                            .where(
                              and(
                                eq(reopenedRun.business_table, JUDGE_RUN_TABLE),
                                eq(reopenedRun.business_id, terminalRun.business_id),
                                eq(reopenedRun.event_type, JUDGE_RUN_EVENTS.REQUEUED),
                                gt(reopenedRun.id, terminalRun.id),
                              ),
                            ),
                        ),
                      ),
                    ),
                ),
              ),
            ),
        ),
      ),
    );

  // A deterministic id collision must never silently bind an intervention to
  // unrelated content. Re-read and prove exact lineage before enrolling cards.
  const rows = await tx
    .select({
      id: question.id,
      source: question.source,
      source_ref: question.source_ref,
      metadata: question.metadata,
    })
    .from(question)
    .where(inArray(question.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const kind of kinds) {
    const scheduled = settlement.diagnostics[kind];
    const row = byId.get(scheduled.question_id);
    const metadata = InterventionDiagnosticQuestionMetadata.safeParse(
      row?.metadata?.intervention_diagnostic,
    );
    if (
      !row ||
      row.source !== INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE ||
      row.source_ref !== sourceRef ||
      !metadata.success ||
      metadata.data.intervention_id !== snapshot.intervention_id ||
      metadata.data.intervention_version !== snapshot.intervention_version ||
      metadata.data.diagnostic_kind !== kind
    ) {
      throw new Error(`intervention diagnostic question id collision for ${scheduled.question_id}`);
    }

    const expectedMetadata = diagnosticMetadata({
      interventionId: snapshot.intervention_id,
      version: snapshot.intervention_version,
      knowledgeId: snapshot.conjecture.knowledge_id,
      kind,
      dueAt: scheduled.due_at,
      probeSpec: packageValue.diagnostics[kind].probe_spec,
    });
    const shouldActivateAnchoredFollowup =
      input.activateAnchoredFollowups === true &&
      kind !== 'immediate' &&
      scheduled.status === 'scheduled' &&
      followupsReady;
    if (
      metadata.data.due_at !== scheduled.due_at ||
      shouldActivateAnchoredFollowup ||
      (scheduled.status === 'scheduled' && kind !== 'immediate' && !followupsReady)
    ) {
      await tx
        .update(question)
        .set({
          metadata: expectedMetadata,
          ...(shouldActivateAnchoredFollowup
            ? { draft_status: 'active' as const }
            : scheduled.status === 'scheduled' && kind !== 'immediate' && !followupsReady
              ? { draft_status: 'draft' as const }
              : {}),
          updated_at: input.now,
        })
        .where(eq(question.id, scheduled.question_id));
    }

    const ready = kind === 'immediate' || followupsReady;
    if (scheduled.status === 'scheduled' && ready) {
      const dueAt = new Date(scheduled.due_at);
      const initial = initialFsrsState(dueAt);
      // A pre-fix installation may already have activation-anchored follow-up
      // cards. Replace only at the atomic exposure transition so the card due
      // date cannot retain that stale anchor.
      if (shouldActivateAnchoredFollowup) {
        await retireQuestionFsrsState(tx, scheduled.question_id);
      }
      await enrollFsrsStateIfAbsent(tx, {
        subject_kind: 'question',
        subject_id: scheduled.question_id,
        state: initial.state,
        due_at: dueAt,
        last_review_event_id: null,
      });
    } else if (scheduled.status === 'scheduled' && !ready) {
      // Before exposure, follow-ups are product-owned drafts with no due-card
      // projection. This also repairs activation-anchored rows from pre-fix data.
      await retireQuestionFsrsState(tx, scheduled.question_id);
    }
  }

  if (settlement.diagnostics.immediate.status === 'scheduled') {
    await appendImmediateDiagnosticToLiveStream(tx, {
      questionId: settlement.diagnostics.immediate.question_id,
      interventionId: snapshot.intervention_id,
      interventionVersion: snapshot.intervention_version,
      now: input.now,
    });
  }
}

/** Practice-owned port for retiring a completed one-shot diagnostic card. */
export async function retireInterventionDiagnosticQuestion(
  tx: Tx,
  questionId: string,
  now: Date,
): Promise<boolean> {
  const cardRetired = await retireQuestionFsrsState(tx, questionId);
  const retired = await tx
    .update(question)
    .set({
      draft_status: 'draft',
      updated_at: now,
      version: sql`${question.version} + 1`,
    })
    .where(
      and(
        eq(question.id, questionId),
        eq(question.source, INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE),
      ),
    )
    .returning({ id: question.id });
  return cardRetired || retired.length > 0;
}
