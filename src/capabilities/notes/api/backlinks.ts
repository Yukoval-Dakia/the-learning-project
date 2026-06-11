// YUK-95 P5 Lane-B — read API behind the artifact backlink panel.
//
// Surfaces inbound cross-links pointing AT this artifact. Source of truth for
// the L2 index is `artifact_block_ref` (written by Lane-0's
// `syncBlockRefsForArtifact`); we read it via the single-owner `listBacklinks`
// (never re-querying the table directly). Then we apply read-time filters that
// the index intentionally does not encode:
//
//   1. ref_kind — only `cross_link` rows surface here (embedded_check quiz refs
//      are owned/displayed elsewhere).
//   2. source artifact lifecycle — drop backlinks whose SOURCE artifact is
//      archived (`archived_at != null`) or not yet `generation_status='ready'`
//      (pending/failed/archived notes are not surfaced; this also closes the
//      Lane-A search follow-up around stale sources).
//   3. XC-5 event-driven retraction — drop backlinks whose SOURCE block was
//      retracted/superseded. Correction events do NOT mutate body_blocks, so we
//      project per-block state via `getArtifactCorrectionStates` and filter at
//      read time (whole-artifact retract/supersede drops every backlink from
//      that source too).
//
// Each surviving row carries a ~120-char context snippet. Because the source
// block IS a crossLinkBlock atom (no inline content), the snippet is derived from
// the enclosing block's text, falling back to the cross-link's title attr
// (`extractCrossLinkSnippet`), so the panel can show where the link lives.

import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import {
  listBacklinks,
  resolveOwningLearningItemIds,
} from '@/capabilities/notes/server/block-refs';
import { extractCrossLinkSnippet } from '@/capabilities/notes/server/body-blocks';
import { db } from '@/db/client';
import { artifact } from '@/db/schema';
import { getArtifactCorrectionStates } from '@/server/events/artifact-corrections';
import { ApiError, errorResponse } from '@/server/http/errors';

const CROSS_LINK_REF_KIND = 'cross_link';
const SNIPPET_MAX_LENGTH = 120;

const ParamsSchema = z.object({ id: z.string().trim().min(1) });

export interface BacklinkPanelRow {
  from_artifact_id: string;
  // owning learning_item.id for the source artifact (primary_artifact_id == from_artifact_id),
  // null when the source has no non-archived owning learning_item. The panel links to
  // /learning-items/<from_learning_item_id> (that route queries learning_item.id, NOT
  // artifact.id); when null the source renders as a non-link to avoid a 404. (YUK-160)
  from_learning_item_id: string | null;
  from_title: string;
  from_type: string;
  from_block_id: string;
  snippet: string | null;
}

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsedParams = ParamsSchema.safeParse(params);
    if (!parsedParams.success) {
      throw new ApiError('validation_error', 'artifact id is required', 400);
    }
    const toArtifactId = parsedParams.data.id;

    // Mirror the sibling `correct` route: a backlinks GET for an artifact id that
    // doesn't exist is a 404, not a 200 with an empty list. (Without this the
    // index read silently returns [] for a typo'd / deleted id, masking the error.)
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

    // Load each distinct source artifact's lifecycle + body_blocks once.
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

    // XC-5: project correction state for the source artifacts and drop refs
    // whose source block (or whole source artifact) is retracted/superseded.
    const correctionStates = await getArtifactCorrectionStates(db, sourceIds);

    // Resolve each source artifact to its owning learning_item so the panel links
    // to /learning-items/<learning_item_id> rather than the artifact id (those are
    // distinct; linking by artifact id 404s — YUK-160). Shared with the P6 node
    // page so both panels resolve identically.
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
        // FIX 2 (YUK-95 P5 review): the source block is the crossLinkBlock itself
        // (an atom with no content), so derive the snippet from the enclosing
        // block's text / the cross-link title rather than the empty atom.
        snippet: extractCrossLinkSnippet(source.body_blocks, ref.from_block_id, SNIPPET_MAX_LENGTH),
      });
    }

    return Response.json({ artifact_id: toArtifactId, rows });
  } catch (err) {
    return errorResponse(err);
  }
}
