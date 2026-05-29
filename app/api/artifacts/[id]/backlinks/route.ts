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
// Each surviving row carries a ~120-char context snippet extracted from the
// source block so the panel can show where the link lives.

import { inArray } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/db/client';
import { artifact } from '@/db/schema';
import { listBacklinks } from '@/server/artifacts/block-refs';
import { extractBlockSnippet } from '@/server/artifacts/body-blocks';
import { getArtifactCorrectionStates } from '@/server/events/artifact-corrections';
import { ApiError, errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

const CROSS_LINK_REF_KIND = 'cross_link';
const SNIPPET_MAX_LENGTH = 120;

const ParamsSchema = z.object({ id: z.string().trim().min(1) });

interface RouteParams {
  params: Promise<{ id: string }>;
}

export interface BacklinkPanelRow {
  from_artifact_id: string;
  from_title: string;
  from_type: string;
  from_block_id: string;
  snippet: string | null;
}

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const parsedParams = ParamsSchema.safeParse(await params);
    if (!parsedParams.success) {
      throw new ApiError('validation_error', 'artifact id is required', 400);
    }
    const toArtifactId = parsedParams.data.id;

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
        from_title: ref.from_artifact_title,
        from_type: ref.from_artifact_type,
        from_block_id: ref.from_block_id,
        snippet: extractBlockSnippet(source.body_blocks, ref.from_block_id, SNIPPET_MAX_LENGTH),
      });
    }

    return Response.json({ artifact_id: toArtifactId, rows });
  } catch (err) {
    return errorResponse(err);
  }
}
