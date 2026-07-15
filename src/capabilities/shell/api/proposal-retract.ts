// M4-T5 (YUK-319)：旧 app/api/proposals/[id]/retract 等价平移为 kernel v2
// (req, params) 签名；body 契约（reason_md trim 1-2000 / affected_refs min 1）
// 与下游 retractAiProposal 调用一字不改。

import { db } from '@/db/client';
import { deprecatedRouteResponse } from '@/kernel/http';
import { ApiError, errorResponse } from '@/server/http/errors';
import { retractAiProposal } from '@/server/proposals/actions';
import { LegacyProposalRetractBodySchema } from './contracts';

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  const response = await handleLegacyRetract(req, params);
  const successor = `/api/proposals/${encodeURIComponent(params.id ?? '')}/decisions`;
  return deprecatedRouteResponse(response, successor);
}

async function handleLegacyRetract(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const { id } = params;
    if (!id) {
      throw new ApiError('validation_error', 'proposal id is required', 400);
    }
    const raw = await req.json().catch(() => ({}));
    const parsed = LegacyProposalRetractBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const result = await retractAiProposal(db, id, parsed.data);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
