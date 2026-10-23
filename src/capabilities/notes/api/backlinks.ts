// Inbound cross-links for the artifact backlink panel. Visibility, source
// ownership, and enclosing-block snippets are projected by the shared reader.

import { eq } from 'drizzle-orm';

import { ArtifactIdParamsSchema } from '@/capabilities/notes/api/contracts';
import { readVisibleArtifactBacklinks } from '@/capabilities/notes/server/visible-artifact-backlinks';
import { db } from '@/db/client';
import { artifact } from '@/db/schema';
import { ApiError, errorResponse } from '@/kernel/http';

export interface BacklinkPanelRow {
  from_artifact_id: string;
  // Owning learning_item.id, not the artifact id: the panel links to
  // /learning-items/<id>, so a null source renders as plain text instead of a 404.
  from_learning_item_id: string | null;
  from_title: string;
  from_type: string;
  from_block_id: string;
  snippet: string | null;
}

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsedParams = ArtifactIdParamsSchema.safeParse(params);
    if (!parsedParams.success) {
      throw new ApiError('validation_error', 'artifact id is required', 400);
    }
    const toArtifactId = parsedParams.data.id;

    // A missing artifact is a 404, not an empty list: otherwise a typo'd id is
    // indistinguishable from an artifact with no backlinks.
    const [target] = await db
      .select({ id: artifact.id })
      .from(artifact)
      .where(eq(artifact.id, toArtifactId));
    if (!target) {
      throw new ApiError('not_found', `artifact ${toArtifactId} not found`, 404);
    }

    const rows: BacklinkPanelRow[] = await readVisibleArtifactBacklinks(db, toArtifactId, {
      includeSnippets: true,
    });

    return Response.json({ artifact_id: toArtifactId, rows });
  } catch (err) {
    return errorResponse(err);
  }
}
