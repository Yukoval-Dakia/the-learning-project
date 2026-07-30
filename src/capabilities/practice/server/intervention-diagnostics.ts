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
import { question } from '@/db/schema';
import { enrollFsrsStateIfAbsent, retireQuestionFsrsState } from '@/server/fsrs/state';
import { inArray } from 'drizzle-orm';
import { initialFsrsState } from './fsrs';

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
  },
): Promise<void> {
  const packageValue = InterventionPackage.parse(input.package);
  const settlement = InterventionSettlement.parse(input.settlement);
  const snapshot = InterventionSnapshot.parse(input.snapshot);
  const sourceRef = `${snapshot.intervention_id}@${snapshot.intervention_version}`;
  const kinds = ['immediate', 'delayed', 'transfer'] as const;

  await tx
    .insert(question)
    .values(
      kinds.map((kind) => {
        const diagnostic = packageValue.diagnostics[kind];
        const scheduled = settlement.diagnostics[kind];
        return {
          id: scheduled.question_id,
          kind: 'short_answer',
          prompt_md: diagnostic.probe_spec.prompt_md,
          reference_md: diagnostic.probe_spec.reference_md,
          judge_kind_override: 'multimodal_direct',
          knowledge_ids: [],
          difficulty: 3,
          source: INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
          source_ref: sourceRef,
          draft_status: 'active',
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

  // A deterministic id collision must never silently bind an intervention to
  // unrelated content. Re-read and prove exact lineage before enrolling cards.
  const ids = kinds.map((kind) => settlement.diagnostics[kind].question_id);
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

    if (scheduled.status === 'scheduled') {
      const dueAt = new Date(scheduled.due_at);
      const initial = initialFsrsState(dueAt);
      await enrollFsrsStateIfAbsent(tx, {
        subject_kind: 'question',
        subject_id: scheduled.question_id,
        state: initial.state,
        due_at: dueAt,
        last_review_event_id: null,
      });
    }
  }
}

/** Practice-owned port for retiring a completed one-shot diagnostic card. */
export async function retireInterventionDiagnosticQuestion(
  tx: Tx,
  questionId: string,
): Promise<boolean> {
  return retireQuestionFsrsState(tx, questionId);
}
