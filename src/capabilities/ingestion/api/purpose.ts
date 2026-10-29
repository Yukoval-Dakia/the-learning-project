import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { PurposeChangeInput } from '@/kernel/read-models/purpose-change';
import { changeIngestionPurpose, readIngestionPurposeImpact } from '../server/purpose-change';
import {
  PurposeChangeResponse,
  PurposeImpactQuery,
  PurposeImpactResponse,
} from './purpose-contracts';

// Authentication is the composition root's /api/* internal-token boundary.
// The command owner fixes actor=user/self; no client actor or crisis policy exists.
export async function POST(req: Request, params: Record<string, string>) {
  try {
    const parsed = PurposeChangeInput.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new ApiError('validation_error', 'invalid purpose command', 400);
    const result = await changeIngestionPurpose(db, params.id, parsed.data);
    return Response.json(PurposeChangeResponse.parse(result), {
      headers: {
        Location: `/api/ingestion-sessions/${encodeURIComponent(params.id)}/purpose?request_id=${parsed.data.request_id}`,
        ...(result.replayed ? { 'Idempotency-Replayed': 'true' } : {}),
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(req: Request, params: Record<string, string>) {
  try {
    const query = PurposeImpactQuery.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!query.success) throw new ApiError('validation_error', 'invalid purpose impact query', 400);
    return Response.json(
      PurposeImpactResponse.parse(
        await readIngestionPurposeImpact(db, params.id, query.data.request_id),
      ),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
