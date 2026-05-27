import { z } from 'zod';

import { ArtifactBodyBlocks } from '@/core/schema/business';
import { db } from '@/db/client';
import { editArtifactBodyBlocks } from '@/server/artifacts/body-blocks-edit';
import { ApiError, errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

interface RouteParams {
  params: Promise<{ id: string }>;
}

const PatchBody = z.object({
  artifact_version: z.number().int().nonnegative(),
  body_blocks: ArtifactBodyBlocks,
});

export async function PATCH(req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id: artifactId } = await params;
    if (!artifactId) throw new ApiError('validation_error', 'artifact id is required', 400);
    const rawBody = await req.json().catch(() => null);
    const parsed = PatchBody.safeParse(rawBody);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const result = await editArtifactBodyBlocks({
      db,
      artifactId,
      expectedArtifactVersion: parsed.data.artifact_version,
      bodyBlocks: parsed.data.body_blocks,
    });
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
