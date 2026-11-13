// issueAssessment / saveSubmission / 自动保存的 route handler。
// 薄层：只做 HTTP 整形；发题与自动保存的解析和域状态 → ApiError 映射在
// server/assessment/request.ts（Start 前门共用），业务在 server/assessment/submit.ts。

import { db } from '@/db/client';
import { ApiError, errorResponse, resourceResponse } from '@/kernel/http';
import { CreateSubmissionBodySchema } from '../../api/assessment-contracts';
import {
  parseAssessmentBody,
  requestAssessmentIssuance,
  requestResponseDraftSave,
} from '../server/assessment/request';
import { revealFrozenStudyReference } from '../server/assessment/study-context';
import { getIssuanceState, saveSubmission } from '../server/assessment/submit';

export async function revealStudyReference(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    return Response.json(await revealFrozenStudyReference(db, params.id));
  } catch (error) {
    return errorResponse(error);
  }
}

// ---------- POST /api/issuances ----------

export async function createIssuance(req: Request): Promise<Response> {
  try {
    const response = await requestAssessmentIssuance(db, () => req.json());
    return resourceResponse(response, {
      outcome: response.status === 'issued' ? 'created' : 'existing',
      location: `/api/issuances/${encodeURIComponent(response.issuance.issuance_id)}`,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------- GET /api/issuances/[id] ----------

export async function getIssuance(
  _req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const state = await getIssuanceState(db, params.id);
    if (state.issuance == null) {
      throw new ApiError('not_found', `issuance '${params.id}' not found`, 404);
    }
    return Response.json(state);
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------- POST /api/issuances/[id]/responses ----------

export async function saveDraft(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    return Response.json(await requestResponseDraftSave(db, params.id, () => req.json()));
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------- POST /api/submissions ----------

export async function createSubmission(req: Request): Promise<Response> {
  try {
    const body = await parseAssessmentBody(() => req.json(), CreateSubmissionBodySchema);
    const out = await saveSubmission(db, {
      issuance_id: body.issuance_id,
      evaluation_group_id: body.evaluation_group_id,
      idempotency_key: body.idempotency_key,
      response_set: body.response_set,
      group_evidence: body.group_evidence,
      submission_id: body.submission_id,
      expected_save_epoch: body.expected_save_epoch,
      actorRef: 'api:submit',
    });
    switch (out.status) {
      case 'saved':
      case 'replayed':
        return resourceResponse(out, {
          outcome: out.status === 'saved' ? 'created' : 'existing',
          location: `/api/submissions/${encodeURIComponent(out.submission.submission_id)}`,
        });
      case 'stale_draft':
        throw new ApiError('stale_draft', '草稿已在别处更新，请读取最新答案', 409, undefined, {
          current_save_epoch: out.current_save_epoch,
        });
      case 'issuance_not_found':
        throw new ApiError('not_found', `issuance '${body.issuance_id}' not found`, 404);
      case 'revision_not_found':
        throw new ApiError('revision_not_found', 'pinned revision missing for issuance', 409);
      case 'invalid_response':
        throw new ApiError(
          'invalid_response',
          `response_set invalid for issued scope: ${(out.issues ?? []).join('; ')}`,
          422,
        );
      case 'group_conflict':
        throw new ApiError(
          'group_conflict',
          out.conflict_reason ?? 'submission group mismatch',
          409,
        );
      case 'idempotency_conflict':
        throw new ApiError(
          'idempotency_conflict',
          out.conflict_reason ?? 'same idempotency key, different payload',
          409,
        );
      case 'coordinate_conflict':
        throw new ApiError(
          'coordinate_conflict',
          out.conflict_reason ?? 'concurrent submission coordinate conflict — safe to retry',
          409,
        );
      default:
        throw new ApiError('internal_error', 'unexpected saveSubmission status', 500);
    }
  } catch (err) {
    return errorResponse(err);
  }
}
