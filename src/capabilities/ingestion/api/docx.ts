import { uploadDocx } from '@/capabilities/ingestion/server/docx/upload-operation';
import { MAX_DOCX_UPLOAD_BYTES } from '@/core/limits';
import { ApiError, errorResponse } from '@/kernel/http';
import { IngestionDerivationPolicy } from './contracts';

// DOCX HTTP endpoint: validate multipart input, then present the upload result.
// The upload operation owns conversion, persistence, session state, and dispatch.

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export async function POST(req: Request): Promise<Response> {
  try {
    const form = await req.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) {
      throw new ApiError('validation_error', 'file is required', 400);
    }
    // Accept the docx mime or an empty type with a .docx filename (drag-and-drop).
    // This is not the security gate: prepareDocxForConversion validates the zip.
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

    // Optional consent ('allow' | 'answer_only'); invalid values are rejected.
    const rawPolicy = form?.get('derivation_policy');
    const derivationPolicy =
      rawPolicy == null || rawPolicy === ''
        ? null
        : (IngestionDerivationPolicy.safeParse(typeof rawPolicy === 'string' ? rawPolicy : null)
            .data ??
          (() => {
            throw new ApiError(
              'validation_error',
              `derivation_policy must be 'allow' or 'answer_only'`,
              400,
            );
          })());

    const docxBytes = new Uint8Array(await file.arrayBuffer());
    const { sessionId, line, pageCount } = await uploadDocx({ docxBytes, derivationPolicy });
    return Response.json(
      { session_id: sessionId, line, page_count: pageCount },
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
