// POST /api/ingestion/[id]/revert
//
// Reverts one auto-enrolled block to draft: retract event, archived record, and
// cleared import links, while keeping the question row. The [id] path is the
// session; the target block is in the body.
import { revertAutoEnrolledBlock } from '@/capabilities/ingestion/server/revert-auto-enroll';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
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
