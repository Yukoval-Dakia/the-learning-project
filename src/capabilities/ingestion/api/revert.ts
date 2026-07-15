// POST /api/ingestion/[id]/revert — T-OC slice B1b (YUK-164, OC-5).
//
// Reverts one WorkflowJudge auto-enrolled block (status='auto_enrolled') back to
// 'draft': writes a CorrectEvent(retract), archives the learning_record, and
// clears the block's imported_* links (the question row is kept). The OC-5
// "AI auto-enrolled N items" surface calls this. Block-scoped (the path [id] is
// the session for routing; the revert target is the body's block_id).
import { revertAutoEnrolledBlock } from '@/capabilities/ingestion/server/revert-auto-enroll';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { RevertAutoEnrolledBlockBodySchema } from './contracts';

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const sessionId = params.id;
    const raw = await req.json().catch(() => null);
    const parsed = RevertAutoEnrolledBlockBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => i.message).join('; '),
        400,
      );
    }
    const result = await revertAutoEnrolledBlock(db, {
      blockId: parsed.data.block_id,
      sessionId,
      reasonMd: parsed.data.reason_md,
    });
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
