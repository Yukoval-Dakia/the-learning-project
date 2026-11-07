// POST /api/ingestion/[id]/blocks/[block_id]/enroll

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { EnrollIngestionBlockBodySchema } from '../api/contracts';
import { enrollIngestionBlock } from '../server/single-block-enroll';

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const body = EnrollIngestionBlockBodySchema.safeParse(await req.json().catch(() => null));
    if (!body.success) {
      throw new ApiError(
        'validation_error',
        body.error.issues.map((issue) => issue.message).join('; '),
        400,
      );
    }
    const result = await enrollIngestionBlock(db, {
      sessionId: params.id,
      blockId: params.block_id,
      expectedVersion: body.data.expected_version,
      promptMd: body.data.prompt_md,
    });
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
