import { EditArtifactBodyBlocksBodySchema } from '@/capabilities/notes/api/contracts';
import { editArtifactBodyBlocks } from '@/capabilities/notes/server/body-blocks-edit';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';

export async function PATCH(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const { id: artifactId } = params;
    if (!artifactId) throw new ApiError('validation_error', 'artifact id is required', 400);
    const rawBody = await req.json().catch(() => null);
    const parsed = EditArtifactBodyBlocksBodySchema.safeParse(rawBody);
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
