// YUK-95 P5 Lane-A — title search backing the in-editor cross_link picker.
// Returns artifacts whose title matches the `q` query (case-insensitive
// substring), optionally excluding one artifact id (the one being edited, to
// avoid self-links). Only LIVE, READY notes are eligible targets: archived
// (`archived_at != null`) or non-ready (`generation_status != 'ready'`) artifacts
// are filtered out so the picker never offers a dead/pending link target (FIX 3,
// P5 review). Small + read-only; the L2 `artifact_block_ref` index is written
// elsewhere (Lane-0 write-through on save), never here.

import { and, desc, eq, ilike, inArray, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '@/db/client';
import { artifact } from '@/db/schema';
import { ApiError, errorResponse } from '@/server/http/errors';


const QuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  exclude: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().positive().max(25).optional(),
});

// ADR-0033 D1 (YUK-306) — closed allowlist of cross-linkable artifact types.
// type='interactive' is OPAQUE to the note block-tree mesh: it must never be
// offered as a cross_link target (a link would write it INTO the mesh via the
// block_refs write-through). tool_quiz's mesh participation is deliberate
// (body-blocks.ts tool_quiz embeds); an allowlist (not `ne 'interactive'`)
// keeps future opaque types out by default.
const CROSS_LINKABLE_TYPES = ['note_atomic', 'note_hub', 'note_long', 'tool_quiz'];

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
    // FIX 3 (YUK-95 P5 review): the picker must never offer archived or
    // pending/failed artifacts as cross-link targets — only live, ready notes.
    const conditions = [
      ilike(artifact.title, `%${escapeLike(q)}%`),
      isNull(artifact.archived_at),
      eq(artifact.generation_status, 'ready'),
      // ADR-0033 D1 (YUK-306) — keep opaque types (interactive) out of the mesh.
      inArray(artifact.type, CROSS_LINKABLE_TYPES),
    ];
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
