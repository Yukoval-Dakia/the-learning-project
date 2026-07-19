// M5-T5a (YUK-321)：平移自 app/api/_/import/route.ts（spec §3.6 L320 备份恢复
// keep 行；HTTP 路径沿旧 /api/_/import 不变；旧壳 Task 9 拆）。

import { db } from '@/db/client';
import { restoreFromArchive } from '@/server/export/archive';
import { getR2 } from '@/server/r2';
import { BackupImportQuerySchema } from './backup-contracts';

// YUK-729 — destructive-restore upload cap. This endpoint buffers the WHOLE ZIP
// into memory (`new Uint8Array(await req.arrayBuffer())` below) before a
// wipe-and-reload restore, so an unbounded body would OOM the container. Backups
// are aggregate archives (DB dump + every R2 blob), so the cap sits well above
// the single-document ingestion limits (assets/pdf/docx in src/core/limits.ts)
// yet stays finite. Defense-in-depth behind the x-internal-token +
// ?confirm=wipe-and-reload double gate; this was the one upload path with no
// size gate. Decimal-MB style matches the sibling limits.
const MAX_BACKUP_UPLOAD_BYTES = 64_000_000;

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
  const declaredBytes = Number(req.headers.get('content-length'));
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
