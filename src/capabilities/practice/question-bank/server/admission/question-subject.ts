// The single answer to "which subject does this question belong to" for every frozen
// admission input. Order: the subject recorded at enrollment
// (`metadata.ingestion_enrollment.subject_id`), then the domain of `knowledge_ids[0]`,
// then null (= general). Enrollment comes first so a re-admission of the same question
// freezes the same subject even after knowledge tags arrive later.

import { eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { knowledge, question } from '@/db/schema';

function enrolledSubjectId(metadata: Record<string, unknown> | null | undefined): string | null {
  const enrollment = metadata?.ingestion_enrollment;
  if (typeof enrollment !== 'object' || enrollment === null) return null;
  const subjectId = (enrollment as { subject_id?: unknown }).subject_id;
  return typeof subjectId === 'string' && subjectId.trim().length > 0 ? subjectId.trim() : null;
}

/** Subject key for profile resolution; null means the general profile. */
export async function questionSubjectKey(db: Db | Tx, questionId: string): Promise<string | null> {
  const [row] = await db
    .select({ knowledge_ids: question.knowledge_ids, metadata: question.metadata })
    .from(question)
    .where(eq(question.id, questionId))
    .limit(1);
  const enrolled = enrolledSubjectId(row?.metadata);
  if (enrolled) return enrolled;
  const first = row?.knowledge_ids?.[0];
  if (!first) return null;
  const [node] = await db
    .select({ domain: knowledge.domain })
    .from(knowledge)
    .where(eq(knowledge.id, first))
    .limit(1);
  return node?.domain ?? null;
}
