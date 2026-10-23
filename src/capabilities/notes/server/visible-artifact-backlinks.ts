// Read-time visibility and source-link projection shared by the note page and
// artifact backlink panel. The L2 index itself includes every ref kind.

import { inArray } from 'drizzle-orm';

import { extractCrossLinkSnippet } from '@/capabilities/notes/server/body-blocks';
import type { Db } from '@/db/client';
import { artifact } from '@/db/schema';
import {
  listBacklinks,
  resolveOwningLearningItemIds,
} from '@/kernel/read-models/artifact-backlinks';
import { getArtifactCorrectionStates } from '@/kernel/read-models/artifact-corrections';

const CROSS_LINK_REF_KIND = 'cross_link';
const SNIPPET_MAX_LENGTH = 120;

interface VisibleArtifactBacklink {
  from_artifact_id: string;
  from_learning_item_id: string | null;
  from_title: string;
  from_type: string;
  from_block_id: string;
}

interface VisibleArtifactBacklinkWithSnippet extends VisibleArtifactBacklink {
  snippet: string | null;
}

export function readVisibleArtifactBacklinks(
  db: Db,
  toArtifactId: string,
  projection?: { includeSnippets?: false },
): Promise<VisibleArtifactBacklink[]>;
export function readVisibleArtifactBacklinks(
  db: Db,
  toArtifactId: string,
  projection: { includeSnippets: true },
): Promise<VisibleArtifactBacklinkWithSnippet[]>;
export async function readVisibleArtifactBacklinks(
  db: Db,
  toArtifactId: string,
  projection: { includeSnippets?: boolean } = {},
): Promise<(VisibleArtifactBacklink | VisibleArtifactBacklinkWithSnippet)[]> {
  const inbound = (await listBacklinks(db, { toArtifactId })).filter(
    (ref) => ref.ref_kind === CROSS_LINK_REF_KIND,
  );
  if (inbound.length === 0) return [];

  const sourceIds = Array.from(new Set(inbound.map((ref) => ref.from_artifact_id)));
  const sourceFields = {
    id: artifact.id,
    archived_at: artifact.archived_at,
    generation_status: artifact.generation_status,
  };
  // Only the panel reads bodies; the note page keeps its smaller source SELECT.
  const sourceRows = projection.includeSnippets
    ? await db
        .select({ ...sourceFields, body_blocks: artifact.body_blocks })
        .from(artifact)
        .where(inArray(artifact.id, sourceIds))
    : await db.select(sourceFields).from(artifact).where(inArray(artifact.id, sourceIds));
  const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
  const correctionStates = await getArtifactCorrectionStates(db, sourceIds);
  const owningByArtifact = await resolveOwningLearningItemIds(db, sourceIds);

  const rows: (VisibleArtifactBacklink | VisibleArtifactBacklinkWithSnippet)[] = [];
  for (const ref of inbound) {
    const source = sourceById.get(ref.from_artifact_id);
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

    const row: VisibleArtifactBacklink = {
      from_artifact_id: ref.from_artifact_id,
      // Both surfaces link to the owning learning item; an absent owner is plain text.
      from_learning_item_id: owningByArtifact.get(ref.from_artifact_id) ?? null,
      from_title: ref.from_artifact_title,
      from_type: ref.from_artifact_type,
      from_block_id: ref.from_block_id,
    };
    rows.push(
      projection.includeSnippets
        ? {
            ...row,
            snippet: extractCrossLinkSnippet(
              'body_blocks' in source ? source.body_blocks : undefined,
              ref.from_block_id,
              SNIPPET_MAX_LENGTH,
            ),
          }
        : row,
    );
  }
  return rows;
}
