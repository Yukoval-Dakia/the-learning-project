// POST /api/ingestion/[id]/revert — T-OC slice B1b (YUK-164, OC-5).
//
// Reverts one WorkflowJudge auto-enrolled block (status='auto_enrolled') back to
// 'draft': writes a CorrectEvent(retract), archives the learning_record, and
// clears the block's imported_* links (the question row is kept). The OC-5
// "AI auto-enrolled N items" surface calls this. Block-scoped (the path [id] is
// the session for routing; the revert target is the body's block_id).
import { z } from 'zod';

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { revertAutoEnrolledBlock } from '@/server/ingestion/revert-auto-enroll';

export const runtime = 'nodejs';

const Body = z.object({
  block_id: z.string().min(1),
  reason_md: z.string().max(2000).optional(),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    await ctx.params; // session id in the path; the revert target is block_id.
    const raw = await req.json().catch(() => null);
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => i.message).join('; '),
        400,
      );
    }
    const result = await revertAutoEnrolledBlock(db, {
      blockId: parsed.data.block_id,
      reasonMd: parsed.data.reason_md,
    });
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
