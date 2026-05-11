import { db } from '@/db/client';
import { restoreFromArchive } from '@/server/export/archive';
import { getR2 } from '@/server/r2';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.searchParams.get('confirm') !== 'wipe-and-reload') {
    return Response.json(
      {
        error: 'confirm_required',
        message: 'pass ?confirm=wipe-and-reload to acknowledge wipe',
      },
      { status: 400 },
    );
  }

  const bytes = new Uint8Array(await req.arrayBuffer());

  const { status, body } = await restoreFromArchive({ db, r2: getR2(), bytes });
  return Response.json(body, { status });
}
