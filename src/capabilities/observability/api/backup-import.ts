// M5-T5a (YUK-321)：平移自 app/api/_/import/route.ts（spec §3.6 L320 备份恢复
// keep 行；HTTP 路径沿旧 /api/_/import 不变；旧壳 Task 9 拆）。

import { MAX_IMAGE_UPLOAD_BYTES } from '@/core/limits';
import { db } from '@/db/client';
import { restoreFromArchive } from '@/server/export/archive';
import { MAX_INLINE_ASSETS } from '@/server/export/constants';
import { getR2 } from '@/server/r2';
import { BackupImportQuerySchema } from './backup-contracts';

// YUK-729 — destructive-restore upload cap, DERIVED from the export side so it can
// never drift below a backup this app itself produces (codex P1: a fixed 64 MB
// blocked a legitimate 45-asset backup). buildBackupArchive (export/archive.ts)
// inlines at most MAX_INLINE_ASSETS R2 blobs, and every source_asset is an image
// bounded by MAX_IMAGE_UPLOAD_BYTES — uploads are size-checked and rendered
// PDF/DOCX pages go through persistImageAsset as PNGs — so the asset payload is at
// most MAX_INLINE_ASSETS × MAX_IMAGE_UPLOAD_BYTES. Add a JSON baseline for data.json
// (the whole-DB row dump). Importing the two source constants keeps the cap in
// lockstep: if either export limit grows, this grows with it (no hardcoded drift).
// The endpoint buffers the entire ZIP into memory before the wipe-and-reload, so
// this bounds OOM; it sits behind the x-internal-token + ?confirm=wipe-and-reload
// double gate. (~424 MB today, well under the ~1 GB point where a streaming read
// would be the better tool.)
const BACKUP_JSON_BASELINE_BYTES = 64_000_000;
export const MAX_BACKUP_UPLOAD_BYTES =
  MAX_INLINE_ASSETS * MAX_IMAGE_UPLOAD_BYTES + BACKUP_JSON_BASELINE_BYTES;

export async function POST(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const query = BackupImportQuerySchema.safeParse({ confirm: url.searchParams.get('confirm') });
  if (!query.success) {
    return Response.json(
      {
        error: 'confirm_required',
        message: 'pass ?confirm=wipe-and-reload to acknowledge wipe',
      },
      { status: 400 },
    );
  }

  // Bound the input BEFORE reading the body: a declared Content-Length over the
  // cap is rejected up front so an oversized backup is never buffered into memory
  // ahead of the wipe-and-reload. A normal upload (curl/fetch of a sized file)
  // always carries Content-Length, which is the realistic OOM vector here — an
  // accidental oversized backup. An absent/unparseable header (chunked transfer)
  // falls through to the existing restore path rather than 413-ing a legitimate
  // request; a deliberately-chunked oversize is out of scope for this cheap
  // pre-check (it sits behind the x-internal-token + confirm double gate).
  // Explicit NaN for an absent header — don't lean on the Number(null) === 0 quirk,
  // which a future refactor could silently break.
  const rawContentLength = req.headers.get('content-length');
  const declaredBytes = rawContentLength ? Number(rawContentLength) : Number.NaN;
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_BACKUP_UPLOAD_BYTES) {
    return Response.json(
      {
        error: 'payload_too_large',
        message: `backup exceeds the ${MAX_BACKUP_UPLOAD_BYTES / 1_000_000} MB limit`,
      },
      { status: 413 },
    );
  }

  const bytes = new Uint8Array(await req.arrayBuffer());

  const { status, body } = await restoreFromArchive({ db, r2: getR2(), bytes });
  return Response.json(body, { status });
}
