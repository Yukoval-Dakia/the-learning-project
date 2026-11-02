import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { requestPurposeChange, requestPurposeImpact } from '../server/purpose-request';

// Authentication is the composition root's /api/* internal-token boundary.
// The command owner fixes actor=user/self; no client actor or crisis policy exists.
export async function POST(req: Request, params: Record<string, string>) {
  try {
    const result = await requestPurposeChange(db, params, () => req.json());
    return Response.json(result.body, { headers: result.headers });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(req: Request, params: Record<string, string>) {
  try {
    return Response.json(
      await requestPurposeImpact(db, params, Object.fromEntries(new URL(req.url).searchParams)),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
