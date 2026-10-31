// Owns diagnostic-question materialization: lineage, draft gates, one-shot
// publication, and placement on today's stream. Practice still owns FSRS
// enrollment and judge-run activity; those leaves are installed for archive
// recovery and used inside the decisions below. The operation is not forwarded.

import { and, eq, exists, inArray, isNotNull, isNull, lte, notExists, or, sql } from 'drizzle-orm';
import { newId } from '@/core/ids';
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
import type { Tx } from '@/db/client';
import {
  assessment_issuance,
  assessment_submission,
  evaluation_effective_head,
  event,
  practice_stream_item,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { publishQuestionGroupFromRow } from '@/kernel/records/assessment-publication';
import { lockInterventionDiagnosticStream } from '@/kernel/records/intervention-diagnostic-lock';

export interface MaterializeInterventionDiagnosticsInput {
  package: InterventionPackageT;
  settlement: InterventionSettlementT;
  snapshot: InterventionSnapshotT;
  now: Date;
  /**
   * Set only by the aggregate transaction that records the first immediate review:
   * activates and re-enrolls the anchored follow-ups in the same settlement update.
   */
  activateAnchoredFollowups?: boolean;
}

export interface DiagnosticMaterializeEffects {
  claimLeaseMs: number;
  pendingAttemptAction: string;
  streamLocalDate(now: Date): string;
  readJudgeQuestionActivity(
    tx: Tx,
    questionIds: string[],
  ): Promise<ReadonlyMap<string, { readonly length: number }>>;
  retireQuestionFsrsState(tx: Tx, questionId: string): Promise<boolean>;
  enrollQuestionFsrsIfAbsent(tx: Tx, questionId: string, dueAt: Date): Promise<void>;
}

let boundEffects: DiagnosticMaterializeEffects | undefined;

export function installDiagnosticMaterializeEffects(effects: DiagnosticMaterializeEffects): void {
  boundEffects = effects;
}

export async function materializeInterventionDiagnostics(
  tx: Tx,
  input: MaterializeInterventionDiagnosticsInput,
): Promise<void> {
  const effects = boundEffects;
  if (!effects) {
    throw new Error(
      'intervention diagnostic materializer is not installed; call installInterventionDiagnosticMaterializer before intervention_prepare_recovery',
    );
  }
  await applyDiagnosticMaterialization(tx, input, effects);
}

export async function applyDiagnosticMaterialization(
  tx: Tx,
  input: MaterializeInterventionDiagnosticsInput,
  effects: DiagnosticMaterializeEffects,
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

  for (const kind of kinds) {
    const diagnostic = packageValue.diagnostics[kind];
    const scheduled = settlement.diagnostics[kind];
    await tx
      .insert(question)
      .values({
        id: scheduled.question_id,
        kind: 'short_answer',
        prompt_md: learnerFacingInterventionDiagnosticPrompt(packageValue, kind),
        reference_md: diagnostic.probe_spec.reference_md,
        judge_kind_override: 'multimodal_direct',
        knowledge_ids: [],
        difficulty: 3,
        source: INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
        source_ref: sourceRef,
        // Product-owned diagnostics already passed package authoring, independent
        // review, deterministic validation, and the lineage proof below.
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
      })
      .onConflictDoNothing();
  }

  const ids = kinds.map((kind) => settlement.diagnostics[kind].question_id);
  // An accepted original or any permanent durable run keeps the one-shot claim closed.
  const staleClaimBefore = new Date(input.now.getTime() - effects.claimLeaseMs);
  const activity = await effects.readJudgeQuestionActivity(tx, readyScheduledIds);
  const reopenableIds = readyScheduledIds.filter((id) => !activity.get(id)?.length);
  if (reopenableIds.length)
    await tx
      .update(question)
      .set({ draft_status: 'active', updated_at: input.now })
      .where(
        and(
          inArray(question.id, reopenableIds),
          eq(question.source, INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE),
          eq(question.draft_status, 'draft'),
          lte(question.updated_at, staleClaimBefore),
          sql`NOT ${acceptedDiagnosticOriginal(tx)}`,
          notExists(
            tx
              .select({ id: event.id })
              .from(event)
              .where(
                and(
                  eq(event.subject_kind, 'question'),
                  eq(event.subject_id, question.id),
                  committedDiagnosticAttempt(tx),
                ),
              ),
          ),
        ),
      );

  // A deterministic id collision must not bind an intervention to unrelated content;
  // re-read and prove exact lineage before enrolling cards.
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
  let immediateAdmitted = false;
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
          ...(shouldActivateAnchoredFollowup ? { updated_at: input.now } : {}),
        })
        .where(eq(question.id, scheduled.question_id));
    }

    let [lifecycle] = await tx
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, scheduled.question_id));
    if (!lifecycle?.current_revision_id) {
      await publishQuestionGroupFromRow(tx, {
        rootId: scheduled.question_id,
        admission: { state: 'withheld', reason: 'no_admitted_executor' },
        claimPolicy: 'one_time',
        availability: 'general_pool',
        actorRef: 'intervention:diagnostic-publication',
        now: input.now,
      });
      [lifecycle] = await tx
        .select()
        .from(question_group_lifecycle)
        .where(eq(question_group_lifecycle.group_id, scheduled.question_id));
    }
    const admitted =
      lifecycle?.scoring_admission_state === 'admitted' &&
      !lifecycle.suspended &&
      !lifecycle.withdrawn;
    if (kind === 'immediate') immediateAdmitted = admitted;
    if (!admitted) {
      if (scheduled.status === 'scheduled') {
        await tx
          .update(question)
          .set({ draft_status: 'draft', updated_at: input.now })
          .where(and(eq(question.id, scheduled.question_id), eq(question.draft_status, 'active')));
        await effects.retireQuestionFsrsState(tx, scheduled.question_id);
        await tx
          .update(practice_stream_item)
          .set({ status: 'skipped', updated_at: input.now })
          .where(
            and(
              eq(practice_stream_item.ref_id, scheduled.question_id),
              eq(practice_stream_item.item_kind, 'question'),
              eq(practice_stream_item.status, 'pending'),
              notExists(
                tx
                  .select({ id: assessment_issuance.issuance_id })
                  .from(assessment_issuance)
                  .innerJoin(
                    question_revision,
                    eq(question_revision.revision_id, assessment_issuance.revision_id),
                  )
                  .where(eq(question_revision.group_id, scheduled.question_id)),
              ),
            ),
          );
      }
      continue;
    }
    const ready = kind === 'immediate' || followupsReady;
    if (scheduled.status === 'scheduled' && ready) {
      // Admission can arrive after authoring: release only an unissued card here;
      // issued cards retain the submission/recovery lease above.
      await tx
        .update(question)
        .set({ draft_status: 'active', updated_at: input.now })
        .where(
          and(
            eq(question.id, scheduled.question_id),
            eq(question.draft_status, 'draft'),
            sql`NOT ${acceptedDiagnosticOriginal(tx)}`,
            notExists(
              tx
                .select({ id: assessment_issuance.issuance_id })
                .from(assessment_issuance)
                .innerJoin(
                  question_revision,
                  eq(question_revision.revision_id, assessment_issuance.revision_id),
                )
                .where(eq(question_revision.group_id, scheduled.question_id)),
            ),
            notExists(
              tx
                .select({ id: event.id })
                .from(event)
                .where(
                  and(
                    eq(event.subject_kind, 'question'),
                    eq(event.subject_id, scheduled.question_id),
                    or(
                      committedDiagnosticAttempt(tx),
                      eq(event.action, effects.pendingAttemptAction),
                    ),
                  ),
                ),
            ),
          ),
        );
      const dueAt = new Date(scheduled.due_at);
      // Pre-fix installations may have activation-anchored follow-up cards. Replace
      // only at the exposure transition so their due date cannot retain that anchor.
      if (shouldActivateAnchoredFollowup) {
        await effects.retireQuestionFsrsState(tx, scheduled.question_id);
      }
      await effects.enrollQuestionFsrsIfAbsent(tx, scheduled.question_id, dueAt);
    } else if (scheduled.status === 'scheduled' && !ready) {
      // Before exposure, follow-ups are product-owned drafts with no due-card
      // projection; this also repairs activation-anchored rows from pre-fix data.
      await effects.retireQuestionFsrsState(tx, scheduled.question_id);
    }
  }

  if (settlement.diagnostics.immediate.status === 'scheduled' && immediateAdmitted) {
    await appendImmediateDiagnosticToLiveStream(
      tx,
      {
        questionId: settlement.diagnostics.immediate.question_id,
        interventionId: snapshot.intervention_id,
        interventionVersion: snapshot.intervention_version,
        now: input.now,
      },
      effects,
    );
  }
}

function acceptedDiagnosticOriginal(tx: Tx) {
  return exists(
    tx
      .select({ id: assessment_submission.submission_id })
      .from(assessment_submission)
      .innerJoin(
        question_revision,
        eq(question_revision.revision_id, assessment_submission.revision_id),
      )
      .where(eq(question_revision.group_id, question.id)),
  );
}

/** Recovery treats an effective native original like a committed historical review. */
function committedDiagnosticAttempt(tx: Tx) {
  return or(
    eq(event.action, 'review'),
    and(
      eq(event.action, 'experimental:assessment_attempt'),
      exists(
        tx
          .select({ id: evaluation_effective_head.evaluation_group_id })
          .from(evaluation_effective_head)
          .where(
            and(
              eq(
                evaluation_effective_head.evaluation_group_id,
                sql`${event.payload}->>'evaluation_group_id'`,
              ),
              eq(evaluation_effective_head.submission_id, sql`${event.payload}->>'submission_id'`),
              isNotNull(evaluation_effective_head.effective_evaluation_id),
            ),
          ),
      ),
    ),
  );
}

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
    // The multimodal-direct judge consumes this canonical response-aware contract
    // even when the diagnostic carries no images.
    probe_spec: input.probeSpec,
  };
}

function learnerFacingInterventionDiagnosticPrompt(
  packageValue: InterventionPackageT,
  kind: 'immediate' | 'delayed' | 'transfer',
): string {
  const probePrompt = packageValue.diagnostics[kind].probe_spec.prompt_md;
  if (kind !== 'immediate') return probePrompt;

  // The intervention must be visible before an outcome can be attributed to it, so
  // the immediate one-shot is its delivery surface: approved material first, then the
  // response-aware check. Later cards stay probe-only to measure retention/transfer.
  return [
    `# ${packageValue.material.title_md}`,
    packageValue.material.body_md,
    '---',
    '## 立即检验',
    probePrompt,
  ].join('\n\n');
}

async function appendImmediateDiagnosticToLiveStream(
  tx: Tx,
  input: {
    questionId: string;
    interventionId: string;
    interventionVersion: number;
    now: Date;
  },
  effects: DiagnosticMaterializeEffects,
): Promise<void> {
  const date = effects.streamLocalDate(input.now);
  // Serialize with lazy/nightly/recompose writers. If no stream exists, leave it empty;
  // the next normal composition picks up this newly-due card. If today's stream exists,
  // append atomically so its non-empty fast path cannot strand the intervention until
  // tomorrow. A timeout aborts this transaction for normal job retry; restore the
  // transaction default after taking the shared lock.
  await tx.execute(sql.raw("SET LOCAL lock_timeout = '5s'"));
  await lockInterventionDiagnosticStream(tx, input.questionId, date);
  await tx.execute(sql.raw("SET LOCAL lock_timeout = '0'"));
  const [existingDelivery] = await tx
    .select({
      id: practice_stream_item.id,
      status: practice_stream_item.status,
      date: practice_stream_item.date,
    })
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
    const [issued] = await tx
      .select({ id: assessment_issuance.issuance_id })
      .from(assessment_issuance)
      .innerJoin(
        question_revision,
        eq(question_revision.revision_id, assessment_issuance.revision_id),
      )
      .where(eq(question_revision.group_id, input.questionId))
      .limit(1);
    if (!issued && existingDelivery.date !== date) {
      const [current] = await tx
        .select({ position: sql<number>`coalesce(max(${practice_stream_item.position}), 0)::int` })
        .from(practice_stream_item)
        .where(and(eq(practice_stream_item.date, date), isNull(practice_stream_item.session_id)));
      await tx
        .update(practice_stream_item)
        .set({
          date,
          position: (current?.position ?? 0) + 1,
          status: 'pending',
          updated_at: input.now,
        })
        .where(eq(practice_stream_item.id, existingDelivery.id));
      return;
    }
    let restorePending = existingDelivery.status === 'skipped';
    if (existingDelivery.status === 'done') {
      const [attempt] = await tx
        .select({ id: event.id })
        .from(event)
        .where(
          and(
            committedDiagnosticAttempt(tx),
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
