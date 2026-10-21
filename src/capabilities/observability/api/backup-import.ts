// Backup restore. The existing HTTP path is unchanged.

import { retireInterventionPreparationJobs } from '@/capabilities/agency/public';
import { getConfig } from '@/core/config/store';
import { db } from '@/db/client';
import { restoreFromArchive } from '@/server/export/archive';
import { getR2 } from '@/server/r2';
import { BackupImportQuerySchema } from './backup-contracts';

// OOM tripwire, not a backup-validity limit: exports have no byte bound, so only a
// sanity ceiling is defensible. The body is buffered whole before the destructive
// restore, so stop an accidental giant upload here. ~1 GB default, tunable via
// config; the 413 points at that knob. Streaming is out of scope for this tool.
const DEFAULT_BACKUP_IMPORT_MAX_BYTES = 1_000_000_000;
// Any real backup is over ~1 MB; a lower cap is almost certainly a typo that would
// reject every restore, so warn and use the default.
const MIN_BACKUP_IMPORT_MAX_BYTES = 1_000_000;
// Per-call getter so config hot reload applies. DB, then env, then default.
export function maxBackupUploadBytes(): number {
  const resolved = getConfig('BACKUP_IMPORT_MAX_BYTES');
  if (resolved === undefined) return DEFAULT_BACKUP_IMPORT_MAX_BYTES;
  const parsed = typeof resolved === 'number' ? resolved : Number(resolved);
  if (!Number.isFinite(parsed) || parsed < MIN_BACKUP_IMPORT_MAX_BYTES) {
    console.warn(
      `[backup_import] ignoring BACKUP_IMPORT_MAX_BYTES=${resolved}: must be a number >= ${MIN_BACKUP_IMPORT_MAX_BYTES} bytes; falling back to the ${DEFAULT_BACKUP_IMPORT_MAX_BYTES}-byte default (a too-low cap would silently 413 every restore)`,
    );
    return DEFAULT_BACKUP_IMPORT_MAX_BYTES;
  }
  return parsed;
}

// Shared 413 for both tripwire checks, so the operator hint stays identical.
function payloadTooLargeResponse(): Response {
  return Response.json(
    {
      error: 'payload_too_large',
      message: `backup upload exceeds the ${Math.round(maxBackupUploadBytes() / 1_000_000)} MB safety limit; raise BACKUP_IMPORT_MAX_BYTES to allow a larger restore`,
    },
    { status: 413 },
  );
}

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

  // Check a declared length before buffering. An absent header falls through to the
  // post-read check; use explicit NaN rather than relying on Number(null).
  const rawContentLength = req.headers.get('content-length');
  const declaredBytes = rawContentLength ? Number(rawContentLength) : Number.NaN;
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBackupUploadBytes()) {
    return payloadTooLargeResponse();
  }

  const bytes = new Uint8Array(await req.arrayBuffer());

  // Chunked bodies skip the declared-length check. They are already resident here,
  // so this only refuses to feed an oversized body into the destructive restore.
  if (bytes.byteLength > maxBackupUploadBytes()) {
    return payloadTooLargeResponse();
  }

  const { status, body } = await restoreFromArchive({
    db,
    r2: getR2(),
    bytes,
    retireInterventionPreparationJobs,
  });
  return Response.json(body, { status });
}
