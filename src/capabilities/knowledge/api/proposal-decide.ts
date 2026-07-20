import { LegacyKnowledgeProposalDecisionBodySchema } from '@/capabilities/knowledge/api/contracts';
import { acceptProposal, dismissProposal } from '@/capabilities/knowledge/server/proposals';
import { db } from '@/db/client';
import { deprecatedRouteResponse } from '@/kernel/http';
import { enqueueHubAutoSync } from '@/server/boss/hub-auto-sync-enqueue';
import { ApiError, errorResponse } from '@/server/http/errors';

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  const response = await handleLegacyKnowledgeDecision(req, params);
  const successor = `/api/proposals/${encodeURIComponent(params.id ?? '')}/decisions`;
  return deprecatedRouteResponse(response, successor);
}

async function handleLegacyKnowledgeDecision(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const { id } = params;
    const raw = await req.json().catch(() => null);
    const parsed = LegacyKnowledgeProposalDecisionBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError('invalid_decision', 'decision must be accept or reject', 400);
    }
    const body = parsed.data;

    if (body.decision === 'accept') {
      const result = await acceptProposal(db, id);
      if (result.kind === 'merge_applied') await enqueueHubAutoSync();
      return Response.json(result);
    }

    // reject
    await dismissProposal(db, id);
    return Response.json({ kind: 'dismissed' });
  } catch (err) {
    if (err instanceof ApiError) {
      return errorResponse(err);
    }
    const msg = (err as Error).message;
    if (/PR A.*propose_new/i.test(msg)) {
      return Response.json({ error: 'unsupported_mutation', message: msg }, { status: 400 });
    }
    if (/^unknown_mutation/i.test(msg)) {
      return Response.json({ error: 'unknown_mutation', message: msg }, { status: 400 });
    }
    if (/not.*pending/i.test(msg)) {
      return Response.json({ error: 'not_pending', message: msg }, { status: 409 });
    }
    if (/not found/i.test(msg)) {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    if (/^stale/i.test(msg)) {
      return Response.json({ error: 'stale', message: msg }, { status: 409 });
    }
    return errorResponse(err);
  }
}
