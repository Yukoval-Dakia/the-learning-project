import { getDocxConverter } from '@/capabilities/ingestion/server/docx/convert';
import {
  normalizeMediaPath,
  segmentMarkdown,
} from '@/capabilities/ingestion/server/docx/markdown-segment';
import { persistDocxPageEvidence } from '@/capabilities/ingestion/server/docx/persist-page-evidence';
import {
  type DocxLine,
  prepareDocxForConversion,
} from '@/capabilities/ingestion/server/docx/route-classify';
import { redactIngestionText } from '@/capabilities/ingestion/server/privacy-guard';
import * as Ingestion from '@/capabilities/ingestion/server/session-lifecycle';
import {
  attachWordSourcePackage,
  persistPackageMedia,
} from '@/capabilities/ingestion/server/source-package';
import { db } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { getR2 } from '@/kernel/object-storage';
import { getStartedBoss } from '@/server/boss/client';
import { initiateDocxTextUpload } from './text-session-lifecycle';

// Complete DOCX upload operation, private to the ingestion capability.
export async function uploadDocx(input: {
  docxBytes: Uint8Array;
  derivationPolicy: 'allow' | 'answer_only' | null;
}): Promise<{ sessionId: string; line: DocxLine; pageCount: number }> {
  const { docxBytes, derivationPolicy } = input;
  // Deterministic zip parse, security preflight, and MathType count. External
  // non-hyperlink relationships are omitted from the converter copy, so converters
  // never see their targets. Corrupt archives and other guards fail with 400.
  const prep = prepareDocxForConversion(docxBytes);
  const line = prep.line;
  // Forward the same digests and omissions on both lines so receipts match.
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
    // Word converts through pandoc on both lines; MathType also carries rendered
    // pages. Pandoc is tolerant here: a failure must not reject an upload the OCR
    // path accepts; the package attaches without markdown and is flagged.
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
      derivationPolicy,
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
      // The session row exists, so mark it failed rather than orphaning it.
      await Ingestion.markSessionPackageFailed(db, sessionId, err);
      throw err;
    }
    const boss = await getStartedBoss();
    await Ingestion.enqueueExtraction({ db, boss, sessionId });
    return { sessionId, line, pageCount: evidence.pageCount };
  }

  // Text line: pandoc → markdown → segment.
  const { markdown, media } = await converter.docxToMarkdown(prep.converterBytes);
  // Record which redaction categories fired. Stored markdown stays raw; models see
  // it only through the call-site redaction backstops.
  const receiptRedaction = redactIngestionText(markdown);
  const segmented = segmentMarkdown({
    markdown,
    // The manifest has no dimensions, so keep dimensionless media by default.
    media: media.map((m) => ({ path: m.path })),
  });
  if (segmented.length === 0) {
    // No question cut: reject rather than create a half-built session.
    throw new ApiError('validation_error', 'DOCX 未能切出任何题', 400);
  }

  // Key assets by normalized media path: segmentMarkdown looks up the same
  // normalization, so './media/…' and absolute paths still resolve. Skipped media
  // are reported through omitted_media provenance.
  const persisted = await persistPackageMedia(db, r2, media);
  for (const m of persisted.omitted) {
    console.warn(`[docx] skipping embedded image ${m.path}: ${m.reason}`);
  }
  const pathToAssetId = new Map<string, string>();
  for (const m of persisted.media) {
    pathToAssetId.set(normalizeMediaPath(m.path), m.asset_id);
  }

  // Evidence page images: the text line also keeps the originals.
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
    // Omission audit on the text line, present only when sanitized.
    externalRefOmission,
    derivationPolicy,
    usageReceipt: {
      redactedFields: receiptRedaction.fields,
      redactionCounts: receiptRedaction.counts,
    },
  });

  // Attach the word package with ast1 refs rewritten into body_md.
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
    // Do not orphan the session. The text line already committed blocks and
    // reached extracted, so record a package failure on the document and still
    // answer 201; a 500 would invite a duplicate upload. Pre-output sessions fail.
    const outcome = await Ingestion.markSessionPackageFailed(db, sessionId, err);
    if (outcome !== 'kept_extracted') throw err;
  }

  return { sessionId, line, pageCount: evidence.pageCount };
}
