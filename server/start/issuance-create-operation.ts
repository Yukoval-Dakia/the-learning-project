import { ApiError, errorResponse } from '@/kernel/http';
import type { FrontdoorContext } from './context';

// Keep model-pin and admission reads in the initialized host graph. The existing writer
// owns locking, frozen bindings, claims and replay; the caller supplies no actor or time.
export const createStartIssuance: FrontdoorContext['createIssuance'] = async (body) => {
  try {
    let raw: unknown = null;
    try {
      raw = JSON.parse(body);
    } catch {}
    const { IssueAssessmentBodySchema, issueAssessment, projectIssuanceResult } = await import(
      '@/capabilities/practice/public'
    );
    const parsed = IssueAssessmentBodySchema.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      throw new ApiError('validation_error', message, 400);
    }
    const input = parsed.data;
    const { db } = await import('@/db/client');
    const out = await issueAssessment(db, {
      issuance_id: input.issuance_id,
      group_id: input.group_id,
      revision_id: input.revision_id,
      part_ids: input.part_ids,
      option_order_overrides: input.option_order_overrides,
      mode: input.mode,
      container_occurrence_ref: input.container_occurrence_ref ?? null,
      claim: input.claim,
      actorRef: 'api:issue',
    });
    return projectIssuanceResult(input, out);
  } catch (error) {
    throw errorResponse(error);
  }
};
