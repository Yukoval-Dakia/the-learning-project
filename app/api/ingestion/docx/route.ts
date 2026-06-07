import { MAX_DOCX_UPLOAD_BYTES } from '@/core/limits';
import { db } from '@/db/client';
import { getStartedBoss } from '@/server/boss/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { getDocxConverter } from '@/server/ingestion/docx/convert';
import { segmentMarkdown } from '@/server/ingestion/docx/markdown-segment';
import { persistDocxPageEvidence } from '@/server/ingestion/docx/persist-page-evidence';
import { classifyDocx } from '@/server/ingestion/docx/route-classify';
import { persistImageAsset } from '@/server/ingestion/persist-image-asset';
import { getR2 } from '@/server/r2';
import { Ingestion } from '@/server/session';
import { initiateDocxTextUpload } from '@/server/session/docx-ingestion';

export const runtime = 'nodejs';

// YUK-258 — DOCX ingestion endpoint. ONE .docx multipart upload → classify into
// text / visual line → build a ready-to-review ingestion session.
//
//   text line (语文/纯文本卷, zero MathType):
//     pandoc → markdown → segment into question_blocks → persist embedded images +
//     evidence page images → initiateDocxTextUpload (uploaded→extracted直达).
//   visual line (MathType 卷):
//     LibreOffice→PDF→PDFium page images (= expandPdf equivalent) →
//     initiateUpload(entrypoint='docx') → enqueueExtraction(tencent_ocr_extract).
//
// Unlike PDF, this endpoint is SELF-CONTAINED: it builds the session itself
// (the client does NOT then call /api/ingestion). Returns
// `{ session_id, line, page_count }`.
//
// All external conversion is收口在 the converter seam (getDocxConverter); render +
// asset persistence reuse #332. The route runs synchronously — segmentation is
// sub-second; the converter has its own 60s timeout guard.

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export async function POST(req: Request): Promise<Response> {
  try {
    const form = await req.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) {
      throw new ApiError('validation_error', 'file is required', 400);
    }
    // Accept the canonical docx mime, plus empty type when the filename ends in
    // .docx (browsers send '' for drag-and-drop / some OS pickers). This is NOT
    // the security gate: classifyDocx validates the zip / word/document.xml and
    // 400s a misnamed non-docx.
    const isDocxMime =
      file.type === DOCX_MIME || (file.type === '' && file.name.toLowerCase().endsWith('.docx'));
    if (!isDocxMime) {
      throw new ApiError('validation_error', `unsupported mime_type: ${file.type}`, 400);
    }
    if (file.size <= 0) {
      throw new ApiError('validation_error', 'DOCX 文件为空', 400);
    }
    if (file.size > MAX_DOCX_UPLOAD_BYTES) {
      throw new ApiError(
        'validation_error',
        `DOCX 超过 ${MAX_DOCX_UPLOAD_BYTES / 1_000_000} MB 上限`,
        400,
      );
    }

    const docxBytes = new Uint8Array(await file.arrayBuffer());
    // Deterministic, sub-ms: zip-parse + MathType OLE count. Throws 400 on a
    // corrupt / non-docx zip.
    const line = classifyDocx(docxBytes);

    const converter = getDocxConverter();
    const r2 = getR2();

    if (line === 'visual') {
      // Visual line: page images ARE the extract input. Render + persist (=
      // expandPdf equivalent), then run the standard upload+extract flow.
      const evidence = await persistDocxPageEvidence(db, r2, converter, docxBytes);
      const { sessionId } = await Ingestion.initiateUpload(db, {
        assetIds: evidence.assetIds,
        entrypoint: 'docx',
      });
      const boss = await getStartedBoss();
      await Ingestion.enqueueExtraction({ db, boss, sessionId });
      return Response.json(
        { session_id: sessionId, line, page_count: evidence.pageCount },
        { status: 201 },
      );
    }

    // Text line: pandoc → markdown → segment.
    const { markdown, media } = await converter.docxToMarkdown(docxBytes);
    const segmented = segmentMarkdown({
      markdown,
      // The converter media manifest has no dimensions; the noise filter keeps
      // dimensionless media (拿不准默认存). Tiny-image filtering activates only when
      // a future converter supplies width/height.
      media: media.map((m) => ({ path: m.path })),
    });
    if (segmented.length === 0) {
      // No question cut → reject; do NOT create a half-baked session.
      throw new ApiError('validation_error', 'DOCX 未能切出任何题', 400);
    }

    // Persist embedded images → asset ids, keyed by their relative media path so
    // each block's imagePaths can be swapped for asset_ids.
    const pathToAssetId = new Map<string, string>();
    for (const m of media) {
      const row = await persistImageAsset(db, r2, { bytes: m.bytes, mime: mimeForMedia(m.path) });
      pathToAssetId.set(m.path, row.id);
    }

    // Evidence page images (原图同步存储不变式 — text line也存证).
    const evidence = await persistDocxPageEvidence(db, r2, converter, docxBytes);

    const blocks = segmented.map((s) => ({
      structured: s.structured,
      imageRefs: s.imagePaths
        .map((p) => pathToAssetId.get(p))
        .filter((id): id is string => id != null),
    }));

    const { sessionId } = await initiateDocxTextUpload(db, {
      evidenceAssetIds: evidence.assetIds,
      blocks,
    });

    return Response.json(
      { session_id: sessionId, line, page_count: evidence.pageCount },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}

// pandoc names media imageN.<ext>; map the common raster extensions to a mime so
// persistImageAsset stamps the source_asset row correctly. Default to PNG.
function mimeForMedia(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  return 'image/png';
}
