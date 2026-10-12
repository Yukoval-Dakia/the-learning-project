import { getDocxConverter } from '@/capabilities/ingestion/server/docx/convert';
import { prepareDocxForConversion } from '@/capabilities/ingestion/server/docx/route-classify';
import { persistDocxSourcePackage } from '@/capabilities/ingestion/server/docx/source-package';
import { MAX_DOCX_UPLOAD_BYTES } from '@/core/limits';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { getStartedBoss } from '@/server/boss/client';
import { getR2 } from '@/server/r2';
import { Ingestion } from '@/server/session';

// DOCX preserves one complete source package and queues the existing extraction job.
// Text/visual class is conversion evidence only; the agent owns question structure.
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

    const source = await persistDocxSourcePackage(db, r2, converter, docxBytes, prep);
    const { sessionId } = await Ingestion.initiateUpload(db, {
      // Existing page_index consumers require page assets in this ordered list.
      assetIds: source.pages.assetIds,
      entrypoint: 'docx',
      externalRefOmission,
      docxSource: { package: source.package, markdown: source.markdown },
    });
    const boss = await getStartedBoss();
    await Ingestion.enqueueExtraction({ db, boss, sessionId });

    return Response.json(
      { session_id: sessionId, line, page_count: source.pages.pageCount },
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
