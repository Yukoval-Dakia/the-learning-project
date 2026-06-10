import { MAX_IMAGE_UPLOAD_BYTES } from '@/core/limits';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { persistImageAsset } from '@/capabilities/ingestion/server/persist-image-asset';
import { getR2 } from '@/server/r2';

export const runtime = 'nodejs';

// Single-source the per-image cap (src/core/limits.ts) so the DOCX embedded-media
// path enforces the identical limit (codex-4 / YUK-250 limits pattern).
const MAX_UPLOAD_BYTES = MAX_IMAGE_UPLOAD_BYTES;
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

export async function POST(req: Request): Promise<Response> {
  try {
    const form = await req.formData().catch(() => null);
    const file = form?.get('file');
    if (!(file instanceof File)) {
      throw new ApiError('validation_error', 'file is required', 400);
    }
    if (!ALLOWED_MIME.has(file.type)) {
      throw new ApiError('validation_error', `unsupported mime_type: ${file.type}`, 400);
    }
    if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
      throw new ApiError('validation_error', `file size must be 1..${MAX_UPLOAD_BYTES}`, 400);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const row = await persistImageAsset(db, getR2(), { bytes, mime: file.type });

    return Response.json({ asset: row }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
