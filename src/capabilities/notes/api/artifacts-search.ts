import { searchArtifactReferences } from '@/capabilities/notes/server/artifact-reference-search';
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    return Response.json(
      await searchArtifactReferences(db, {
        q: url.searchParams.get('q') ?? '',
        exclude: url.searchParams.get('exclude') ?? undefined,
        limit: url.searchParams.get('limit') ?? undefined,
      }),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
