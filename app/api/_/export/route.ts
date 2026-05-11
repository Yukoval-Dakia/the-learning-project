import { db } from '@/db/client';
import { buildBackupArchive } from '@/server/export/archive';
import { getR2 } from '@/server/r2';

export const runtime = 'nodejs';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const includeAssets = url.searchParams.get('include_assets') === '1';

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
