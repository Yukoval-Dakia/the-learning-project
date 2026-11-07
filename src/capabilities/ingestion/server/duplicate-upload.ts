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

/** Exact ordered page-set match against an earlier document; null when unknown or unique. */
export async function findDuplicateUpload(
  tx: Tx,
  input: { sourceDocumentId: string; assetIds: readonly string[] },
): Promise<DuplicateUploadMatch | null> {
  if (input.assetIds.length === 0) return null;

  const newAssets = await tx
    .select({ id: source_asset.id, sha256: source_asset.sha256 })
    .from(source_asset)
    .where(inArray(source_asset.id, [...input.assetIds]));
  const shaById = new Map(newAssets.map((row) => [row.id, row.sha256]));
  const target = input.assetIds.map((id) => shaById.get(id));
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
  const samePageCount = candidates.filter(
    (doc) => (doc.assetIds ?? []).length === input.assetIds.length,
  );
  if (samePageCount.length === 0) return null;

  const candidateAssetIds = [
    ...new Set(samePageCount.flatMap((doc) => doc.assetIds ?? [])),
  ].filter((id) => shaById.get(id) === undefined);
  const candidateAssets =
    candidateAssetIds.length === 0
      ? []
      : await tx
          .select({ id: source_asset.id, sha256: source_asset.sha256 })
          .from(source_asset)
          .where(inArray(source_asset.id, candidateAssetIds));
  const candidateSha = new Map(candidateAssets.map((row) => [row.id, row.sha256]));

  for (const doc of samePageCount) {
    const sameOrder = (doc.assetIds ?? []).every((id, index) => {
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
