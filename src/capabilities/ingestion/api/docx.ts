import { getDocxConverter } from '@/capabilities/ingestion/server/docx/convert';
import {
  normalizeMediaPath,
  segmentMarkdown,
} from '@/capabilities/ingestion/server/docx/markdown-segment';
import { persistDocxPageEvidence } from '@/capabilities/ingestion/server/docx/persist-page-evidence';
import { prepareDocxForConversion } from '@/capabilities/ingestion/server/docx/route-classify';
import {
  attachWordSourcePackage,
  markSessionPackageFailed,
  persistPackageMedia,
} from '@/capabilities/ingestion/server/source-package';
import { MAX_DOCX_UPLOAD_BYTES } from '@/core/limits';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { getStartedBoss } from '@/server/boss/client';
import { getR2 } from '@/server/r2';
import { Ingestion } from '@/server/session';
import { initiateDocxTextUpload } from '@/server/session/docx-ingestion';

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
    // the security gate: prepareDocxForConversion validates the zip /
    // word/document.xml and 400s a misnamed non-docx.
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
    // Deterministic, sub-ms: zip-parse + security preflight + MathType OLE count.
    // YUK-1476 — external NON-hyperlink relationships (header/footer/body) are
    // omitted from a sanitized CONVERTER INPUT COPY; pandoc/LibreOffice only ever
    // see converterBytes, never the original external targets. Throws 400 on a
    // corrupt / non-docx zip and on every preserved fail-closed guard.
    const prep = prepareDocxForConversion(docxBytes);
    const line = prep.line;
    // YUK-1476 (R1 P1-2) — the SAME honest omission facts (both digests + omitted
    // facts) are forwarded on BOTH lines so every docx receipt is identical.
    const externalRefOmission =
      prep.omissions.length > 0
        ? {
            inputSha256: prep.inputSha256,
            converterInputSha256: prep.converterInputSha256,
            omissions: prep.omissions,
          }
        : undefined;

    const converter = getDocxConverter();
    const r2 = getR2();

    if (line === 'visual') {
      // Visual line: page images ARE the extract input. Render + persist (=
      // expandPdf equivalent), then run the standard upload+extract flow.
      const evidence = await persistDocxPageEvidence(db, r2, converter, prep.converterBytes);
      // YUK-1404 (B2/R1) — Word goes through pandoc to Markdown on BOTH lines;
      // a MathType doc additionally carries the rendered page images. Pandoc is
      // TOLERANT on the visual line (P2-3): a conversion failure must not
      // reject uploads that the OCR path used to accept — the package simply
      // attaches without markdown, flagged. The legacy pipeline is untouched.
      let markdown: string | null = null;
      let media: { path: string; bytes: Uint8Array }[] = [];
      let markdownAbsentReason: string | undefined;
      try {
        ({ markdown, media } = await converter.docxToMarkdown(prep.converterBytes));
      } catch (err) {
        markdownAbsentReason = err instanceof Error ? err.message : String(err);
        console.warn(
          `[docx] visual-line pandoc failed (package attaches without markdown): ${markdownAbsentReason}`,
        );
      }
      const persisted = await persistPackageMedia(db, r2, media);
      const { sessionId, sourceDocumentId } = await Ingestion.initiateUpload(db, {
        assetIds: evidence.assetIds,
        entrypoint: 'docx',
        externalRefOmission,
      });
      try {
        await attachWordSourcePackage(db, r2, {
          sourceDocumentId,
          originalBytes: docxBytes,
          converterBytes: prep.converterBytes,
          markdown,
          markdownAbsentReason,
          media: persisted.media,
          omittedMedia: persisted.omitted,
          pageAssetIds: evidence.assetIds,
          renderedPdfAssetId: evidence.pdfAssetId,
        });
      } catch (err) {
        // P2-8 — the session row exists: mark it failed, don't orphan it.
        await markSessionPackageFailed(db, sessionId, err);
        throw err;
      }
      const boss = await getStartedBoss();
      await Ingestion.enqueueExtraction({ db, boss, sessionId });
      return Response.json(
        { session_id: sessionId, line, page_count: evidence.pageCount },
        {
          status: 201,
          headers: {
            Location: `/api/ingestion-sessions/${encodeURIComponent(sessionId)}`,
          },
        },
      );
    }

    // Text line: pandoc → markdown → segment.
    const { markdown, media } = await converter.docxToMarkdown(prep.converterBytes);
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

    // Persist embedded images → asset ids, keyed by their NORMALIZED relative
    // media path (coderabbit-b: segmentMarkdown looks these up via
    // normalizeMediaPath, so the map key must use the same normalization or refs
    // silently drop when a converter emits './media/…' or an absolute path).
    // YUK-1404 (B2/R1): shared persistPackageMedia helper — same per-image byte
    // cap; skipped media are reported via `omitted` and land in the package's
    // omitted_media provenance instead of a console.warn.
    const persisted = await persistPackageMedia(db, r2, media);
    for (const m of persisted.omitted) {
      console.warn(`[docx] skipping embedded image ${m.path}: ${m.reason}`);
    }
    const pathToAssetId = new Map<string, string>();
    for (const m of persisted.media) {
      pathToAssetId.set(normalizeMediaPath(m.path), m.asset_id);
    }

    // Evidence page images (原图同步存储不变式 — text line也存证).
    const evidence = await persistDocxPageEvidence(db, r2, converter, prep.converterBytes);

    const blocks = segmented.map((s) => ({
      structured: s.structured,
      imageRefs: s.imagePaths
        .map((p) => pathToAssetId.get(p))
        .filter((id): id is string => id != null),
    }));

    const { sessionId, sourceDocumentId } = await initiateDocxTextUpload(db, {
      evidenceAssetIds: evidence.assetIds,
      blocks,
      // YUK-1476 — honest omission audit (both digests + omitted facts) on the
      // text-line session; only present when the converter input was sanitized.
      externalRefOmission,
    });

    // YUK-1404 (B2/R1) — attach the unified 'word' source package: original +
    // converter input + source.md + media + page images, with ast1 refs
    // rewritten into body_md. The legacy blocks flow is unchanged.
    try {
      await attachWordSourcePackage(db, r2, {
        sourceDocumentId,
        originalBytes: docxBytes,
        converterBytes: prep.converterBytes,
        markdown,
        media: persisted.media,
        omittedMedia: persisted.omitted,
        pageAssetIds: evidence.assetIds,
        renderedPdfAssetId: evidence.pdfAssetId,
      });
    } catch (err) {
      // P2-8 — the session row exists: mark it failed, don't orphan it.
      await markSessionPackageFailed(db, sessionId, err);
      throw err;
    }

    return Response.json(
      { session_id: sessionId, line, page_count: evidence.pageCount },
      {
        status: 201,
        headers: {
          Location: `/api/ingestion-sessions/${encodeURIComponent(sessionId)}`,
        },
      },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
