// M4-T5 (YUK-319)：旧 app/api/proposals/[id]/{accept,dismiss} 两路由合并为单
// decide 端点（kernel v2 (req, params) 签名）。decision 必填四值——'dismiss'
// 走 dismissAiProposal，其余三值走 acceptAiProposal（旧 AcceptBody 的
// optional decision 缺省语义由显式 'accept' 承担）；superRefine 约束照旧。

import { db } from '@/db/client';
import { deprecatedRouteResponse } from '@/kernel/http';
import { ApiError, errorResponse } from '@/server/http/errors';
import { acceptAiProposal, dismissAiProposal } from '@/server/proposals/actions';
import { LegacyProposalDecisionBodySchema } from './contracts';

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  const response = await handleLegacyDecision(req, params);
  const successor = `/api/proposals/${encodeURIComponent(params.id ?? '')}/decisions`;
  return deprecatedRouteResponse(response, successor);
}

async function handleLegacyDecision(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const { id } = params;
    if (!id) {
      throw new ApiError('validation_error', 'proposal id is required', 400);
    }
    const raw = await req.json().catch(() => ({}));
    const parsed = LegacyProposalDecisionBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const { decision, new_relation_type, user_note } = parsed.data;
    if (decision === 'change_type') {
      if (!new_relation_type) {
        throw new ApiError('validation_error', 'change_type requires new_relation_type', 400);
      }
      return Response.json(
        await acceptAiProposal(db, id, { decision, new_relation_type, user_note }),
      );
    }
    const result =
      decision === 'dismiss'
        ? await dismissAiProposal(db, id, { user_note })
        : await acceptAiProposal(db, id, { decision, user_note });
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
