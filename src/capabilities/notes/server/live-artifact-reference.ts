import { and, eq, isNull } from 'drizzle-orm';
import { ArtifactType } from '@/core/schema/business';
import type { Db, Tx } from '@/db/client';
import { artifact } from '@/db/schema';

/** Resolve only an existing, non-archived artifact with a known product type. */
export async function getLiveArtifactType(db: Db | Tx, artifactId: string): Promise<string | null> {
  const [row] = await db
    .select({ type: artifact.type })
    .from(artifact)
    .where(and(eq(artifact.id, artifactId), isNull(artifact.archived_at)))
    .limit(1);
  if (!row) return null;
  const parsed = ArtifactType.safeParse(row.type);
  return parsed.success ? parsed.data : null;
}
