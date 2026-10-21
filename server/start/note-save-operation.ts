import type { Db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';

// Called after token/epoch authorization. Notes owns the complete edit,
// including row lock, version conflict, history, projection and backlinks.
export async function saveStartNoteBody(
  input: { id: string; body: string },
  options: { database?: Db } = {},
) {
  try {
    const { EditArtifactBodyBlocksBodySchema, editArtifactBodyBlocks } = await import(
      '@/capabilities/notes/public'
    );
    if (typeof input?.id !== 'string' || !input.id) {
      throw new ApiError('validation_error', 'artifact id is required', 400);
    }
    let rawBody: unknown = null;
    try {
      rawBody = JSON.parse(input.body);
    } catch {
      // Match the retained HTTP handler's malformed-JSON validation path.
    }
    const parsed = EditArtifactBodyBlocksBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const database = options.database ?? (await import('@/db/client')).db;
    return await editArtifactBodyBlocks({
      db: database,
      artifactId: input.id,
      expectedArtifactVersion: parsed.data.artifact_version,
      bodyBlocks: parsed.data.body_blocks,
    });
  } catch (error) {
    throw errorResponse(error);
  }
}
