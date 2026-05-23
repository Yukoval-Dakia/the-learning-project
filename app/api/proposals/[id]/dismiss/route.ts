import { z } from 'zod';

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { dismissAiProposal } from '@/server/proposals/actions';

export const runtime = 'nodejs';

const DismissBody = z.object({
  user_note: z.string().max(2000).optional(),
});

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id } = await params;
    const raw = await req.json().catch(() => ({}));
    const parsed = DismissBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const result = await dismissAiProposal(db, id, parsed.data);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
