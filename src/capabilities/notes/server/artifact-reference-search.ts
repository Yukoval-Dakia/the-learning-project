// Complete title lookup for the note editor's cross-link picker.
// Both HTTP and Start share validation, visibility, literal matching and ordering.
import { and, desc, ilike, inArray, ne } from 'drizzle-orm';
import { ArtifactSearchQuerySchema } from '@/capabilities/notes/api/contracts';
import type { Db } from '@/db/client';
import { artifact } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { readyArtifactReferenceCondition } from '@/kernel/read-models/live-artifact-reference';

// Allowlist, not a denylist: an interactive artifact is opaque to the note mesh
// and a link would write it into the backlink index, so new opaque types must
// stay out by default. tool_quiz participates deliberately.
const CROSS_LINKABLE_TYPES = ['note_atomic', 'note_hub', 'note_long', 'tool_quiz'];

// Escape ILIKE wildcards so user input is matched literally.
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export async function searchArtifactReferences(db: Db, input: unknown) {
  const parsed = ArtifactSearchQuerySchema.safeParse(input);
  if (!parsed.success) {
    throw new ApiError(
      'validation_error',
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      400,
    );
  }

  const { q, exclude, limit } = parsed.data;
  const conditions = [
    ilike(artifact.title, `%${escapeLike(q)}%`),
    readyArtifactReferenceCondition,
    inArray(artifact.type, CROSS_LINKABLE_TYPES),
  ];
  if (exclude) conditions.push(ne(artifact.id, exclude));

  const rows = await db
    .select({ id: artifact.id, title: artifact.title, type: artifact.type })
    .from(artifact)
    .where(and(...conditions))
    .orderBy(desc(artifact.updated_at))
    .limit(limit ?? 10);
  return { rows };
}
