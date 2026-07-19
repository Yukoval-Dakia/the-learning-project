// M5-T5a (YUK-321)：平移自 app/api/_/import/route.ts（spec §3.6 L320 备份恢复
// keep 行；HTTP 路径沿旧 /api/_/import 不变；旧壳 Task 9 拆）。

import { db } from '@/db/client';
import { restoreFromArchive } from '@/server/export/archive';
import { getR2 } from '@/server/r2';
import { BackupImportQuerySchema } from './backup-contracts';

// YUK-729 — destructive-restore OOM tripwire. This is deliberately NOT a
// backup-validity ceiling. #965 round-2 (codex P2): buildBackupArchive dumps the
// ENTIRE DB row set into data.json with no row-count or byte bound, so there is no
// principled maximum a legitimate backup cannot exceed — any cap "derived from the
// export limits" (the earlier MAX_INLINE_ASSETS × MAX_IMAGE_UPLOAD_BYTES + baseline)
// is false precision and can reject a real backup. So the check makes no correctness
// claim: it is only a sanity tripwire that stops an accidentally-huge upload from
// OOMing the worker, which buffers the whole ZIP into memory below
// (`new Uint8Array(await req.arrayBuffer())`) before the wipe-and-reload. Default
// ~1 GB, raise via BACKUP_IMPORT_MAX_BYTES for a genuinely large restore; the 413
// message points the operator at that knob. Known limitation: the body is read
// whole into memory rather than streamed with a running bound — acceptable for this
// single-user tool, streaming is out of scope for this ticket. Sits behind the
// x-internal-token + ?confirm=wipe-and-reload double gate.
const DEFAULT_BACKUP_IMPORT_MAX_BYTES = 1_000_000_000;
function resolveBackupImportMaxBytes(): number {
  const raw = process.env.BACKUP_IMPORT_MAX_BYTES;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BACKUP_IMPORT_MAX_BYTES;
}
export const MAX_BACKUP_UPLOAD_BYTES = resolveBackupImportMaxBytes();

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

  // Trip the OOM sanity check BEFORE reading the body: a declared Content-Length
  // over the tripwire is rejected up front so an accidentally-huge upload is never
  // buffered into memory ahead of the wipe-and-reload. A normal upload (curl/fetch
  // of a sized file) always carries Content-Length; an absent/unparseable header
  // (chunked transfer) falls through to the existing restore path rather than
  // 413-ing a legitimate request. Explicit NaN for an absent header — don't lean on
  // the Number(null) === 0 quirk, which a future refactor could silently break.
  const rawContentLength = req.headers.get('content-length');
  const declaredBytes = rawContentLength ? Number(rawContentLength) : Number.NaN;
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_BACKUP_UPLOAD_BYTES) {
    return Response.json(
      {
        error: 'payload_too_large',
        message: `backup upload exceeds the ${Math.round(MAX_BACKUP_UPLOAD_BYTES / 1_000_000)} MB safety limit; raise BACKUP_IMPORT_MAX_BYTES to allow a larger restore`,
      },
      { status: 413 },
    );
  }

  const bytes = new Uint8Array(await req.arrayBuffer());

  const { status, body } = await restoreFromArchive({ db, r2: getR2(), bytes });
  return Response.json(body, { status });
}
