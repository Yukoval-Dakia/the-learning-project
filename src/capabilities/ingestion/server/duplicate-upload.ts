/**
 * Duplicate-upload recognition for one ingestion creation.
 *
 * A re-uploaded photo keeps its bytes but gets fresh source_asset ids, so identity is
 * the ordered sha256 list the existing asset store already computes. Matching is exact
 * (same pages in the same upload order): a partial page overlap is a different capture
 * and is not reported. Recognition never blocks or rewrites the new upload; it records
 * one typed event the learner-facing read can show.
 */
import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';

import type { Tx } from '@/db/client';
import { learning_session, source_asset, source_document } from '@/db/schema';
import { writeEvent } from '@/kernel/events';

export const DUPLICATE_UPLOAD_ACTION = 'experimental:ingestion_duplicate_upload' as const;

/** How many earlier documents one creation checks before giving up. */
const DUPLICATE_SCAN_LIMIT = 50;

export interface DuplicateUploadMatch {
  source_document_id: string;
  session_id: string | null;
  uploaded_at: string;
}

/**
 * Evidence pages only: Word sessions also pin embedded media on the session so imports
 * can reference it, but the same docx must still compare as the same page set. Media is
 * `role='media'` from persistPackageMedia; everything else is a page.
 */
function evidencePageIds(
  rows: Array<{ id: string; provenance?: unknown }>,
  orderedIds: readonly string[],
): string[] {
  const media = new Set(
    rows
      .filter((row) => {
        const provenance = row.provenance as { role?: unknown } | null | undefined;
        return provenance?.role === 'media';
      })
      .map((row) => row.id),
  );
  return orderedIds.filter((id) => !media.has(id));
}

/** Exact ordered page-set match against an earlier document; null when unknown or unique. */
export async function findDuplicateUpload(
  tx: Tx,
  input: { sourceDocumentId: string; assetIds: readonly string[] },
): Promise<DuplicateUploadMatch | null> {
  if (input.assetIds.length === 0) return null;

  const newAssets = await tx
    .select({
      id: source_asset.id,
      sha256: source_asset.sha256,
      provenance: source_asset.provenance,
    })
    .from(source_asset)
    .where(inArray(source_asset.id, [...input.assetIds]));
  if (newAssets.length !== input.assetIds.length) return null;
  const shaById = new Map(newAssets.map((row) => [row.id, row.sha256]));
  const targetIds = evidencePageIds(
    newAssets,
    input.assetIds,
  );
  const target = targetIds.map((id) => shaById.get(id));
  // An unresolvable asset identity must not turn into a false duplicate claim.
  if (target.some((sha) => sha === undefined)) return null;

  const candidates = await tx
    .select({
      id: source_document.id,
      assetIds: source_document.source_asset_ids,
      createdAt: source_document.created_at,
    })
    .from(source_document)
    .where(ne(source_document.id, input.sourceDocumentId))
    .orderBy(desc(source_document.created_at))
    .limit(DUPLICATE_SCAN_LIMIT);
  const candidateAssetIds = [...new Set(candidates.flatMap((doc) => doc.assetIds ?? []))].filter(
    (id) => shaById.get(id) === undefined,
  );
  const candidateAssets =
    candidateAssetIds.length === 0
      ? []
      : await tx
          .select({
            id: source_asset.id,
            sha256: source_asset.sha256,
            provenance: source_asset.provenance,
          })
          .from(source_asset)
          .where(inArray(source_asset.id, candidateAssetIds));
  const candidateSha = new Map(candidateAssets.map((row) => [row.id, row.sha256]));
  const candidateById = new Map(
    [...newAssets, ...candidateAssets].map((row) => [row.id, row]),
  );
  const samePageCount = candidates.filter((doc) => {
    const ids = evidencePageIds(
      (doc.assetIds ?? []).map((id) => candidateById.get(id)).filter((row) => row !== undefined),
      doc.assetIds ?? [],
    );
    return ids.length === targetIds.length;
  });
  if (samePageCount.length === 0) return null;

  for (const doc of samePageCount) {
    const ids = evidencePageIds(
      (doc.assetIds ?? []).map((id) => candidateById.get(id)).filter((row) => row !== undefined),
      doc.assetIds ?? [],
    );
    const sameOrder = ids.every((id, index) => {
      const sha = shaById.get(id) ?? candidateSha.get(id);
      return sha !== undefined && sha === target[index];
    });
    if (!sameOrder) continue;
    const [session] = await tx
      .select({ id: learning_session.id })
      .from(learning_session)
      .where(
        and(
          eq(learning_session.source_document_id, doc.id),
          eq(learning_session.type, 'ingestion'),
        ),
      )
      .limit(1);
    return {
      source_document_id: doc.id,
      session_id: session?.id ?? null,
      uploaded_at: doc.createdAt.toISOString(),
    };
  }
  return null;
}

/**
 * Recognise and record a duplicate in a savepoint so a detection fault never aborts the
 * surrounding creation transaction (e.g. a statement timeout). Unknown stays unknown.
 */
export async function detectDuplicateUpload(
  tx: Tx,
  input: { sessionId: string; sourceDocumentId: string; assetIds: readonly string[] },
): Promise<DuplicateUploadMatch | null> {
  try {
    return await tx.transaction(async (savepoint) => {
      const duplicate = await findDuplicateUpload(savepoint, {
        sourceDocumentId: input.sourceDocumentId,
        assetIds: input.assetIds,
      });
      if (duplicate !== null) {
        await recordDuplicateUpload(savepoint, {
          sessionId: input.sessionId,
          sourceDocumentId: input.sourceDocumentId,
          duplicate,
        });
      }
      return duplicate;
    });
  } catch (err) {
    console.error('[ingestion] duplicate upload detection failed', err);
    return null;
  }
}

/** Persist the typed signal; the caller's creation transaction owns it. */
export async function recordDuplicateUpload(
  tx: Tx,
  input: { sessionId: string; sourceDocumentId: string; duplicate: DuplicateUploadMatch },
): Promise<void> {
  await writeEvent(tx, {
    id: createId(),
    session_id: input.sessionId,
    actor_kind: 'system',
    actor_ref: 'ingestion_duplicate_upload',
    action: DUPLICATE_UPLOAD_ACTION,
    subject_kind: 'source_document',
    subject_id: input.sourceDocumentId,
    outcome: 'success',
    payload: { duplicate_of: input.duplicate },
    caused_by_event_id: null,
    task_run_id: null,
    cost_micro_usd: null,
    ingest_at: new Date(),
    created_at: new Date(),
  });
}
