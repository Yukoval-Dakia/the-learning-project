// The appeal execution receipt: grading writes it, settlement verifies it. It lives here so
// neither owner has to import the other for the contract.
import { z } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import { EvaluationAdmissionSnapshot, EvaluationInputSnapshot } from '@/core/schema/assessment';

export const APPEAL_EXECUTION_BINDING_ACTION = 'experimental:assessment_appeal_execution_binding';

export const AppealExecutionBindingIdentity = z.object({
  version: z.literal(1),
  appeal_event_id: z.string().min(1),
  evaluation_group_id: z.string().min(1),
  submission_id: z.string().min(1),
  execution_key: z.string().min(1),
  input_snapshot: EvaluationInputSnapshot,
  intent_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

export const AppealExecutionBinding = AppealExecutionBindingIdentity.extend({
  attempt: z.number().int().positive().safe(),
  admission_snapshot: EvaluationAdmissionSnapshot.nullable(),
  model_hold_reason: z.string().min(1).nullable(),
}).strict();

export type AppealExecutionBindingT = z.infer<typeof AppealExecutionBinding>;

export function appealExecutionBindingId(
  evaluationGroupId: string,
  executionKey: string | undefined,
): string {
  return `evt_appeal_binding_${canonicalHash([evaluationGroupId, executionKey])}`;
}
