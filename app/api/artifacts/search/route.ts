// YUK-95 P5 Lane-A — title search backing the in-editor cross_link picker.
// Returns artifacts whose title matches the `q` query (case-insensitive
// substring), optionally excluding one artifact id (the one being edited, to
// avoid self-links). Small + read-only; the L2 `artifact_block_ref` index is
// written elsewhere (Lane-0 write-through on save), never here.

import { and, desc, ilike, ne } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/db/client';
import { artifact } from '@/db/schema';
import { ApiError, errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

const QuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  exclude: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(25).optional(),
});

// Escape ILIKE wildcards so user input is matched literally.
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const parsed = QuerySchema.safeParse({
      q: url.searchParams.get('q') ?? '',
      exclude: url.searchParams.get('exclude') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
    });
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }

    const { q, exclude, limit } = parsed.data;
    const conditions = [ilike(artifact.title, `%${escapeLike(q)}%`)];
    if (exclude) conditions.push(ne(artifact.id, exclude));

    const rows = await db
      .select({ id: artifact.id, title: artifact.title, type: artifact.type })
      .from(artifact)
      .where(and(...conditions))
      .orderBy(desc(artifact.updated_at))
      .limit(limit ?? 10);

    return Response.json({ rows });
  } catch (err) {
    return errorResponse(err);
  }
}
