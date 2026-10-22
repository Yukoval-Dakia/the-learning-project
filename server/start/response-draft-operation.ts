import { ApiError, errorResponse } from '@/kernel/http';
import type { FrontdoorContext } from './context';

// Host-bound adapter; Practice owns issuance locking, tombstones and draft epochs.
export const saveStartResponseDraft: FrontdoorContext['saveResponseDraft'] = async (input) => {
  try {
    if (typeof input?.issuanceId !== 'string') {
      throw new ApiError('validation_error', 'issuance id must be a string', 400);
    }
    const { SaveResponseDraftBodySchema, saveResponseDraft } = await import(
      '@/capabilities/practice/public'
    );
    let rawBody: unknown = null;
    try {
      rawBody = JSON.parse(input.body);
    } catch {
      // Preserve the HTTP handler's malformed-JSON validation path.
    }
    const parsed = SaveResponseDraftBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        400,
      );
    }
    const { db } = await import('@/db/client');
    const out = await saveResponseDraft(db, {
      issuance_id: input.issuanceId,
      evaluation_group_ref: parsed.data.evaluation_group_ref ?? null,
      response_set: parsed.data.response_set,
      group_evidence: parsed.data.group_evidence,
      expected_save_epoch: parsed.data.expected_save_epoch,
    });
    switch (out.status) {
      case 'saved':
        return out;
      case 'issuance_not_found':
        throw new ApiError('not_found', `issuance '${input.issuanceId}' not found`, 404);
      case 'invalid_response':
        throw new ApiError(
          'invalid_response',
          `response_set invalid for issued scope: ${(out.issues ?? []).join('; ')}`,
          422,
        );
      case 'stale_draft':
        throw new ApiError(
          'stale_draft',
          `draft epoch ${out.current_save_epoch} is newer than expected_save_epoch — refresh before overwriting`,
          409,
        );
      case 'already_submitted':
        throw new ApiError(
          'already_submitted',
          out.conflict_reason ?? 'draft for an already-submitted attempt cannot be recreated',
          409,
        );
      default:
        throw new ApiError('internal_error', 'unexpected saveResponseDraft status', 500);
    }
  } catch (error) {
    // The shared authenticated fetch restores the existing browser ApiError, including 409.
    throw errorResponse(error);
  }
};
