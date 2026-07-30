import { createHash } from 'node:crypto';
import { getEffectiveProbeResultStatuses } from '@/capabilities/agency/server/conjecture/probe-evidence';
import { parseFlag } from '@/core/env-flags';
import {
  PedagogyMethodId,
  type PedagogyMethodIdT,
  type PrecisionBandT,
  type ThetaBandT,
} from '@/core/pedagogy/method-library';
import { ConjectureProbeResponseJudgement } from '@/core/schema/conjecture-probe-response';
import {
  type InterventionDeliveryModeT,
  InterventionPackage,
  InterventionSnapshot,
  type InterventionSnapshotT,
  PedagogyRecommendation,
} from '@/core/schema/intervention';
import { ConjectureProposalChange } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { event, intervention, knowledge, mastery_state } from '@/db/schema';
import { getProposalInboxRow } from '@/server/proposals/inbox';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';

type DbLike = Db | Tx;

export const AUTO_INTERVENTION_EXPANSION_ENABLED = 'AUTO_INTERVENTION_EXPANSION_ENABLED';
export const INTERVENTION_DISABLED_METHOD_IDS = 'INTERVENTION_DISABLED_METHOD_IDS';

export const InterventionSourceProbeResultPayload = z
  .object({
    conjecture_event_id: z.string().trim().min(1),
    outcome: z.literal(0),
    resolution: z.literal('evidence_for'),
    response_judgement: ConjectureProbeResponseJudgement.refine(
      (judgement) =>
        judgement.gradable &&
        judgement.answer_result === 'incorrect' &&
        judgement.target_error_match === 'matched' &&
        judgement.reason_code === 'target_error_signature_matched',
      'intervention preparation requires a gradable target-error signature match',
    ),
  })
  .passthrough();

export function interventionIdentityForProbeResult(sourceProbeResultEventId: string): {
  interventionId: string;
  idempotencyKey: string;
} {
  const digest = createHash('sha256')
    .update(`intervention\0${sourceProbeResultEventId}`)
    .digest('hex');
  return {
    interventionId: `int_${digest.slice(0, 32)}`,
    idempotencyKey: `intervention_prepare_v1_${digest}`,
  };
}

export function thetaBand(thetaHat: number | null): ThetaBandT {
  if (thetaHat === null || thetaHat < -0.5) return 'novice';
  if (thetaHat >= 0.75) return 'secure';
  return 'developing';
}

export function precisionBand(thetaPrecision: number | null): PrecisionBandT {
  if (thetaPrecision === null || thetaPrecision < 1.5) return 'low';
  if (thetaPrecision < 6) return 'medium';
  return 'high';
}

export function disabledPedagogyMethods(env: NodeJS.ProcessEnv): PedagogyMethodIdT[] {
  const raw = env[INTERVENTION_DISABLED_METHOD_IDS]?.trim();
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => PedagogyMethodId.parse(value)),
    ),
  ];
}

export function interventionDeliveryMode(env: NodeJS.ProcessEnv): InterventionDeliveryModeT {
  return parseFlag(env[AUTO_INTERVENTION_EXPANSION_ENABLED], { defaultValue: false })
    ? 'eligible'
    : 'shadow';
}

export async function buildInterventionSnapshotFromProbeResult(
  db: DbLike,
  input: {
    sourceProbeResultEventId: string;
    interventionId: string;
    version: number;
    now: Date;
    env?: NodeJS.ProcessEnv;
  },
): Promise<InterventionSnapshotT> {
  const [source] = await db
    .select({
      id: event.id,
      action: event.action,
      subject_kind: event.subject_kind,
      subject_id: event.subject_id,
      payload: event.payload,
      caused_by_event_id: event.caused_by_event_id,
    })
    .from(event)
    .where(eq(event.id, input.sourceProbeResultEventId))
    .limit(1);
  if (!source) {
    throw new Error(`probe result '${input.sourceProbeResultEventId}' was not found`);
  }
  if (source.action !== 'experimental:probe_result' || source.subject_kind !== 'question') {
    throw new Error(`event '${source.id}' is not a conjecture probe result`);
  }
  const probeResult = InterventionSourceProbeResultPayload.parse(source.payload);
  if (source.caused_by_event_id !== probeResult.conjecture_event_id || !source.caused_by_event_id) {
    throw new Error(`probe result '${source.id}' has invalid conjecture provenance`);
  }
  const effective = await getEffectiveProbeResultStatuses(db, [source.id], {
    validateDirectChain: true,
  });
  if (effective.get(source.id) !== 'active') {
    throw new Error(`probe result '${source.id}' is not effective active evidence`);
  }

  const proposal = await getProposalInboxRow(db, probeResult.conjecture_event_id);
  if (!proposal || proposal.kind !== 'conjecture' || proposal.status !== 'accepted') {
    throw new Error(`conjecture '${probeResult.conjecture_event_id}' is not accepted`);
  }
  const change = ConjectureProposalChange.parse(proposal.payload.proposed_change);
  if (!change.diagnostic_spec) {
    throw new Error(`conjecture '${proposal.id}' has no frozen diagnostic spec`);
  }
  const [knowledgeRow] = await db
    .select({ name: knowledge.name })
    .from(knowledge)
    .where(eq(knowledge.id, change.knowledge_id))
    .limit(1);
  if (!knowledgeRow) {
    throw new Error(`knowledge '${change.knowledge_id}' was not found`);
  }
  const [mastery] = await db
    .select({
      theta_hat: mastery_state.theta_hat,
      theta_precision: mastery_state.theta_precision,
    })
    .from(mastery_state)
    .where(
      and(
        eq(mastery_state.subject_kind, 'knowledge'),
        eq(mastery_state.subject_id, change.knowledge_id),
      ),
    )
    .limit(1);

  const priorRows = await db
    .select({
      id: intervention.id,
      version: intervention.version,
      outcome: intervention.outcome,
      recommendation_json: intervention.recommendation_json,
      package_json: intervention.package_json,
    })
    .from(intervention)
    .where(
      and(
        eq(intervention.status, 'settled'),
        isNotNull(intervention.outcome),
        sql`${intervention.snapshot_json} #>> '{conjecture,knowledge_id}' = ${change.knowledge_id}`,
      ),
    )
    .orderBy(desc(intervention.updated_at), desc(intervention.version))
    .limit(20);
  const priorInterventions = priorRows.flatMap((row) => {
    const recommendation = PedagogyRecommendation.safeParse(row.recommendation_json);
    const packageResult = InterventionPackage.safeParse(row.package_json);
    if (
      !recommendation.success ||
      recommendation.data.kind !== 'recommendation' ||
      !packageResult.success ||
      row.outcome === null
    ) {
      return [];
    }
    return [
      {
        intervention_id: row.id,
        version: row.version,
        method_id: recommendation.data.method_id,
        method_definition_version: recommendation.data.method_definition_version,
        outcome: row.outcome,
      },
    ];
  });

  const evidenceRefs = proposal.payload.evidence_refs.map((ref) => ({
    kind: ref.kind,
    id: ref.id,
  }));
  evidenceRefs.push({ kind: 'event', id: input.sourceProbeResultEventId });

  return InterventionSnapshot.parse({
    schema_version: 1,
    intervention_id: input.interventionId,
    intervention_version: input.version,
    conjecture: {
      conjecture_id: proposal.id,
      claim_md: change.claim_md,
      knowledge_id: change.knowledge_id,
      knowledge_name: knowledgeRow.name,
      cause_category: change.cause_category,
      target_error_rule_md: change.diagnostic_spec.target_error_rule_md,
      diagnostic_spec: change.diagnostic_spec,
      evidence_refs: evidenceRefs,
    },
    learner_context: {
      theta_band: thetaBand(mastery?.theta_hat ?? null),
      precision_band: precisionBand(mastery?.theta_precision ?? null),
      misconception_present: true,
      // No subject-owned KC rule/concept trait exists yet. False is the
      // conservative, explicit value: it withholds reconstruction rather than
      // asking the model to invent a hidden classification.
      kc_is_rule_based: false,
    },
    prior_interventions: priorInterventions,
    disabled_method_ids: disabledPedagogyMethods(input.env ?? process.env),
    source_probe_result_event_id: input.sourceProbeResultEventId,
    created_at: input.now.toISOString(),
  });
}
