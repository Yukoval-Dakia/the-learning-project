import { PEDAGOGY_METHOD_LIBRARY, selectPedagogyCandidates } from '@/core/pedagogy';
import {
  type InterventionSnapshotT,
  PEDAGOGY_METHOD_DEFINITION_VERSION,
  PedagogyRecommendation,
  PedagogyRecommendationModelOutput,
  type PedagogyRecommendationModelOutputT,
  type PedagogyRecommendationT,
} from '@/core/schema/intervention';
import { parseJsonObjectLoose } from '@/server/ai/json-extract';
import type { TaskTextResult, TaskTextRunFn } from '@/server/ai/provenance';
import type { SubjectProfile } from '@/subjects/profile';

export interface RecommendPedagogyInput {
  snapshot: InterventionSnapshotT;
  runTaskFn: TaskTextRunFn;
  subjectProfile: SubjectProfile;
}

function parseRecommendationModelOutput(
  result: TaskTextResult,
): PedagogyRecommendationModelOutputT {
  if (result.structured_output !== undefined && result.structured_output !== null) {
    return PedagogyRecommendationModelOutput.parse(result.structured_output);
  }
  const extracted = parseJsonObjectLoose(result.text, 'intervention recommendation', {
    riskyRepair: 'reject',
  });
  if (!extracted) throw new Error('intervention recommendation did not contain a JSON object');
  return PedagogyRecommendationModelOutput.parse(extracted.json);
}

export async function recommendPedagogy(
  input: RecommendPedagogyInput,
): Promise<PedagogyRecommendationT> {
  const policy = selectPedagogyCandidates(input.snapshot.learner_context);
  const disabled = new Set(input.snapshot.disabled_method_ids);
  const candidates = policy.candidates.filter((method) => !disabled.has(method.id));
  const excluded = [
    ...policy.excluded,
    ...policy.candidates
      .filter((method) => disabled.has(method.id))
      .map((method) => ({ method_id: method.id, reason: 'disabled' as const })),
  ];
  const candidateIds = candidates.map((method) => method.id);

  if (candidateIds.length === 0) {
    return PedagogyRecommendation.parse({
      kind: 'abstain',
      recommendation_version: 1,
      reason_code: 'no_safe_method',
      detail_md: 'Deterministic pedagogy policy and owner-disabled methods left no legal method.',
      candidate_ids: [],
      excluded,
    });
  }

  // Operational/provider errors deliberately propagate to pg-boss so its
  // durable retry policy can run. Only a returned-but-invalid model artifact is
  // translated into an epistemic preparation failure below.
  const result: TaskTextResult = await input.runTaskFn(
    'InterventionRecommendationTask',
    {
      snapshot: input.snapshot,
      candidate_methods: candidates,
      excluded_methods: excluded,
      prior_interventions: input.snapshot.prior_interventions,
      output_contract: {
        allowed_method_ids: candidateIds,
        recommendation_version: 1,
        method_definition_version: PEDAGOGY_METHOD_DEFINITION_VERSION,
      },
    },
    { subjectProfile: input.subjectProfile },
  );

  let model: PedagogyRecommendationModelOutputT;
  try {
    model = parseRecommendationModelOutput(result);
  } catch (error) {
    return PedagogyRecommendation.parse({
      kind: 'abstain',
      recommendation_version: 1,
      reason_code: 'model_output_invalid',
      detail_md: error instanceof Error ? error.message.slice(0, 2000) : 'invalid model output',
      candidate_ids: candidateIds,
      excluded,
      ...(result.task_run_id ? { model_run_id: result.task_run_id } : {}),
    });
  }

  if (model.kind === 'abstain') {
    return PedagogyRecommendation.parse({
      kind: 'abstain',
      recommendation_version: 1,
      reason_code: model.reason_code,
      detail_md: model.detail_md,
      candidate_ids: candidateIds,
      excluded,
      ...(result.task_run_id ? { model_run_id: result.task_run_id } : {}),
    });
  }
  if (!result.task_run_id) {
    return PedagogyRecommendation.parse({
      kind: 'abstain',
      recommendation_version: 1,
      reason_code: 'model_output_invalid',
      detail_md: 'Recommendation result did not carry an AI task run id.',
      candidate_ids: candidateIds,
      excluded,
    });
  }
  if (!candidateIds.includes(model.method_id)) {
    return PedagogyRecommendation.parse({
      kind: 'abstain',
      recommendation_version: 1,
      reason_code: 'model_output_invalid',
      detail_md: `Model selected excluded method '${model.method_id}'.`,
      candidate_ids: candidateIds,
      excluded,
      model_run_id: result.task_run_id,
    });
  }

  // Belt-and-suspenders: ensure the selected definition is still the same closed
  // palette entry that the policy supplied to the model.
  if (!PEDAGOGY_METHOD_LIBRARY.some((method) => method.id === model.method_id)) {
    throw new Error(
      `selected pedagogy method '${model.method_id}' is not in the canonical palette`,
    );
  }
  return PedagogyRecommendation.parse({
    kind: 'recommendation',
    recommendation_version: 1,
    method_id: model.method_id,
    method_definition_version: PEDAGOGY_METHOD_DEFINITION_VERSION,
    rationale_md: model.rationale_md,
    safety_constraints: model.safety_constraints,
    candidate_ids: candidateIds,
    excluded,
    model_run_id: result.task_run_id,
  });
}
