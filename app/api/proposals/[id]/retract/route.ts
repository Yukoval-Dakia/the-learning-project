import { ActivityRef } from '@/core/schema/activity';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { retractAiProposal } from '@/server/proposals/actions';
import { z } from 'zod';

export const runtime = 'nodejs';

const RetractBody = z.object({
  reason_md: z.string().trim().min(1).max(2000).optional(),
  affected_refs: z.array(ActivityRef).min(1).optional(),
});

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id } = await params;
    const raw = await req.json().catch(() => ({}));
    const parsed = RetractBody.safeParse(raw);
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
