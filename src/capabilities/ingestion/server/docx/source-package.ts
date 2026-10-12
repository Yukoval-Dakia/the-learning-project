import { eq, inArray } from 'drizzle-orm';
import type { DocxSourcePackageT } from '@/core/schema/docx-agent';
import type { Db } from '@/db/client';
import { source_asset } from '@/db/schema';
import type { BlobStore } from '@/kernel/blob-store';
import { persistSourceAsset } from '../persist-image-asset';
import type { DocxConverter } from './convert';
import { persistDocxPageEvidence } from './persist-page-evidence';
import type { prepareDocxForConversion } from './route-classify';

/** Preserve the complete source before any agent structure decisions. */
export async function persistDocxSourcePackage(
  db: Db,
  r2: BlobStore,
  converter: DocxConverter,
  original: Uint8Array,
  prep: ReturnType<typeof prepareDocxForConversion>,
) {
  const files: DocxSourcePackageT['files'] = [];
  const save = async (
    bytes: Uint8Array,
    name: string,
    role: DocxSourcePackageT['files'][number]['role'],
    mime: string,
    kind: 'docx' | 'text' | 'image',
  ) => {
    const row = await persistSourceAsset(db, r2, { bytes, mime, kind });
    files.push({ asset_id: row.id, name, role, sha256: row.sha256, mime });
  };
  const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  await save(original, 'original.docx', 'original', docxMime, 'docx');
  await save(prep.converterBytes, 'converter.docx', 'converter', docxMime, 'docx');
  const { markdown, media, layout } = await converter.docxToMarkdown(prep.converterBytes);
  await save(new TextEncoder().encode(markdown), 'source.md', 'markdown', 'text/markdown', 'text');
  if (layout) {
    await save(layout.bytes, 'layout.json', 'layout', 'application/json', 'text');
    files[files.length - 1].format = layout.format;
  }
  for (const m of media) {
    // The original path is a display label only, never a filesystem path.
    const suffix = m.path.toLowerCase().split('.').at(-1);
    const mime =
      (
        {
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          png: 'image/png',
          gif: 'image/gif',
          webp: 'image/webp',
          bmp: 'image/bmp',
          svg: 'image/svg+xml',
        } as Record<string, string>
      )[suffix ?? ''] ?? 'application/octet-stream';
    await save(m.bytes, m.path, 'media', mime, 'image');
  }
  const pages = await persistDocxPageEvidence(db, r2, converter, prep.converterBytes);
  const rows = await db
    .select()
    .from(source_asset)
    .where(inArray(source_asset.id, [...pages.assetIds, pages.pdfAssetId]));
  for (const [page_index, id] of pages.assetIds.entries()) {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new Error('DOCX source page persistence failed');
    files.push({
      asset_id: id,
      name: `page-${page_index + 1}.png`,
      role: 'page',
      sha256: row.sha256,
      mime: row.mime_type,
      page_index,
    });
  }
  const [pdf] = await db.select().from(source_asset).where(eq(source_asset.id, pages.pdfAssetId));
  files.push({
    asset_id: pdf.id,
    name: 'rendered.pdf',
    role: 'pdf',
    sha256: pdf.sha256,
    mime: pdf.mime_type,
  });
  return {
    markdown,
    pages,
    package: { version: 1, input_sha256: prep.inputSha256, files } satisfies DocxSourcePackageT,
  };
}
