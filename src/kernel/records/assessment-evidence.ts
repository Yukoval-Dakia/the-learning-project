import { inArray } from 'drizzle-orm';
import { EvidenceAttachment, type EvidenceAttachmentT } from '@/core/schema/assessment';
import type { Db, Tx } from '@/db/client';
import { source_asset } from '@/db/schema';
import { ApiError } from '@/kernel/http';

/** Freeze uploaded originals from trusted asset metadata, preserving caller order. */
export async function freezeImageEvidence(
  db: Db | Tx,
  assetIds: readonly string[],
): Promise<EvidenceAttachmentT[]> {
  if (assetIds.length === 0) return [];
  if (new Set(assetIds).size !== assetIds.length)
    throw new ApiError('invalid_evidence', 'duplicate image asset', 400);
  const rows = await db
    .select()
    .from(source_asset)
    .where(inArray(source_asset.id, [...assetIds]));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return assetIds.map((id) => {
    const row = byId.get(id);
    if (!row || !['image/png', 'image/jpeg', 'image/webp'].includes(row.mime_type)) {
      throw new ApiError('invalid_evidence', `image asset is unavailable: ${id}`, 422);
    }
    return EvidenceAttachment.parse({
      evidence_id: `image:${id}`,
      kind: 'image',
      asset: { asset_id: id, digest: `sha256:${row.sha256}` },
      mime_type: row.mime_type,
      bytes: row.byte_size,
      uploaded_at: row.created_at.toISOString(),
    });
  });
}
