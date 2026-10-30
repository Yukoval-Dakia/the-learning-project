import { runRescue } from '@/capabilities/ingestion/server/rescue';
import { db } from '@/db/client';
import { ApiError, deprecatedRouteResponse, errorResponse } from '@/kernel/http';
import { getR2 } from '@/kernel/object-storage';
import { RescueBody } from './operation-schema';

/**
 * Manual Vision tier 2/3 rescue. It runs synchronously because the call is fast
 * (seconds), not through pg-boss. The user picks the block and tier; the result
 * replaces the block content.
 */
async function executePOST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const sessionId = params.id;
    const raw = await req.json().catch(() => null);
    const parsed = RescueBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const { block_id, page, tier, strategy } = parsed.data;
    const result = await runRescue({
      db,
      r2: getR2(),
      sessionId,
      blockId: block_id,
      page,
      tier,
      strategy,
    });
    return Response.json({ structured: result.structured });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  const successor = `/api/ingestion-sessions/${encodeURIComponent(params.id ?? '')}/operations`;
  return deprecatedRouteResponse(await executePOST(req, params), successor);
}
