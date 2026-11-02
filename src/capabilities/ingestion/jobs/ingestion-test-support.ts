import { createId } from '@paralleldrive/cuid2';
import sharp from 'sharp';

import { db } from '@/db/client';
import { learning_session, source_asset, source_document } from '@/db/schema';

export async function seedIngestionSession(pageCount: number): Promise<{
  readonly sessionId: string;
  readonly operationId: string;
}> {
  const sourceDocumentId = createId();
  const sessionId = createId();
  const assetIds = Array.from({ length: pageCount }, () => createId());
  const now = new Date();
  await db.insert(source_document).values({
    id: sourceDocumentId,
    title: null,
    source_asset_ids: assetIds,
    body_md: null,
    provenance: {},
    created_at: now,
    updated_at: now,
    version: 0,
  });
  await db.insert(source_asset).values(
    assetIds.map((assetId, pageIndex) => ({
      id: assetId,
      kind: 'image' as const,
      storage_key: `resume-page-${pageIndex}`,
      mime_type: 'image/png',
      byte_size: 100,
      sha256: `resume-${pageIndex}`,
      width: 80,
      height: 120,
      provenance: {},
      created_at: now,
    })),
  );
  await db.insert(learning_session).values({
    id: sessionId,
    type: 'ingestion',
    source_document_id: sourceDocumentId,
    source_asset_ids: assetIds,
    status: 'queued',
    entrypoint: 'vision_single',
    error_message: null,
    warnings: [],
    started_at: now,
    created_at: now,
    updated_at: now,
    version: 0,
  });
  return { sessionId, operationId: `ingop_${createId()}` };
}

export async function createImageR2() {
  const image = await sharp({
    create: { width: 80, height: 120, channels: 3, background: '#fff' },
  })
    .png()
    .toBuffer();
  return {
    async get() {
      return new Uint8Array(image);
    },
    async put() {},
    async delete() {},
  };
}
