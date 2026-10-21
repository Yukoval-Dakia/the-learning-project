// Inbound cross-links for the artifact backlink panel. Rows come from the
// single-owner `listBacklinks` read of the L2 index; the read-time filters below
// drop what that index deliberately does not encode:
//
//   1. only `cross_link` refs (embedded_check refs belong to their own surface);
//   2. only live, ready source artifacts;
//   3. only sources whose block and artifact were not retracted/superseded.
//      Correction events do not rewrite body_blocks, so block state is projected
//      at read time.
//
// Snippets come from the enclosing block (or the cross-link title): the source
// node itself is an atom with no text.

import { eq, inArray } from 'drizzle-orm';

import { ArtifactIdParamsSchema } from '@/capabilities/notes/api/contracts';
import {
  listBacklinks,
  resolveOwningLearningItemIds,
} from '@/capabilities/notes/server/block-refs';
import { extractCrossLinkSnippet } from '@/capabilities/notes/server/body-blocks';
import { db } from '@/db/client';
import { artifact } from '@/db/schema';
import { ApiError, errorResponse } from '@/kernel/http';
import { getArtifactCorrectionStates } from '../server/artifact-corrections';

const CROSS_LINK_REF_KIND = 'cross_link';
const SNIPPET_MAX_LENGTH = 120;

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

    // Single-owner read of the L2 index; cross_link refs only.
    const inbound = (await listBacklinks(db, { toArtifactId })).filter(
      (ref) => ref.ref_kind === CROSS_LINK_REF_KIND,
    );

    if (inbound.length === 0) {
      return Response.json({ artifact_id: toArtifactId, rows: [] });
    }

    const sourceIds = Array.from(new Set(inbound.map((ref) => ref.from_artifact_id)));
    const sourceRows = await db
      .select({
        id: artifact.id,
        archived_at: artifact.archived_at,
        generation_status: artifact.generation_status,
        body_blocks: artifact.body_blocks,
      })
      .from(artifact)
      .where(inArray(artifact.id, sourceIds));
    const sourceById = new Map(sourceRows.map((row) => [row.id, row]));

    // Project correction state for the source artifacts and drop refs whose
    // source block (or whole artifact) is retracted/superseded.
    const correctionStates = await getArtifactCorrectionStates(db, sourceIds);

    // The panel links to the owning learning_item, not the artifact, so both
    // panels resolve identically.
    const owningLearningItemByArtifactId = await resolveOwningLearningItemIds(db, sourceIds);

    const rows: BacklinkPanelRow[] = [];
    for (const ref of inbound) {
      const source = sourceById.get(ref.from_artifact_id);
      // Source row missing (race) or not surface-eligible.
      if (!source) continue;
      if (source.archived_at != null) continue;
      if (source.generation_status !== 'ready') continue;

      const correction = correctionStates.get(ref.from_artifact_id);
      if (correction) {
        if (correction.whole.state === 'retracted' || correction.whole.state === 'superseded') {
          continue;
        }
        const blockState = correction.blocks.get(ref.from_block_id);
        if (blockState && (blockState.state === 'retracted' || blockState.state === 'superseded')) {
          continue;
        }
      }

      rows.push({
        from_artifact_id: ref.from_artifact_id,
        from_learning_item_id: owningLearningItemByArtifactId.get(ref.from_artifact_id) ?? null,
        from_title: ref.from_artifact_title,
        from_type: ref.from_artifact_type,
        from_block_id: ref.from_block_id,
        snippet: extractCrossLinkSnippet(source.body_blocks, ref.from_block_id, SNIPPET_MAX_LENGTH),
      });
    }

    return Response.json({ artifact_id: toArtifactId, rows });
  } catch (err) {
    return errorResponse(err);
  }
}
