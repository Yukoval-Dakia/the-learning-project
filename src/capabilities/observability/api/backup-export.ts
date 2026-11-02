// Backup export: streams a ZIP of the database and, with include_assets=1, R2 assets.

import { db } from '@/db/client';
import { getR2 } from '@/kernel/object-storage';
import { buildBackupArchive } from '@/server/export/archive';
import { BackupExportQuerySchema } from './backup-contracts';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const query = BackupExportQuerySchema.parse({
    include_assets: url.searchParams.get('include_assets') ?? undefined,
  });
  const includeAssets = query.include_assets === '1';

  const result = await buildBackupArchive({ db, r2: getR2(), includeAssets });

  if (result.error) {
    return Response.json(result.error, { status: 400 });
  }

  return new Response(result.stream, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="loom-backup-${result.dateStamp}.zip"`,
    },
  });
}
