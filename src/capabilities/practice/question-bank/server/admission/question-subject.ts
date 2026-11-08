// The single answer to "which subject does this question belong to" for every frozen
// admission input. The domain of `knowledge_ids[0]` wins when present; the subject
// StructureTask recorded at enrollment (`metadata.ingestion_enrollment.subject_id`)
// covers questions that have no knowledge yet; neither means null (= general). A
// disagreement between the two is returned so the frozen input records it. Already
// frozen inputs are reused by the paid-effect claim, so a later tag only affects
// future revisions.

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import { normalizeSubjectKey, resolveKnownSubjectId } from '@/subjects/profile';

export const SubjectMismatch = z.object({
  used: z.literal('knowledge'),
  enrollment: z.object({
    subject_id: z.string(),
    source: z.literal('metadata.ingestion_enrollment.subject_id'),
  }),
  knowledge: z.object({
    domain: z.string(),
    knowledge_id: z.string(),
    source: z.literal('knowledge_ids[0]'),
  }),
});
export type SubjectMismatch = z.infer<typeof SubjectMismatch>;

export interface QuestionSubject {
  /** Subject key for profile resolution; null means the general profile. */
  key: string | null;
  /** Present only when enrollment and knowledge name different subjects. */
  mismatch?: SubjectMismatch;
}

function enrolledSubjectId(metadata: Record<string, unknown> | null | undefined): string | null {
  const enrollment = metadata?.ingestion_enrollment;
  if (typeof enrollment !== 'object' || enrollment === null) return null;
  const subjectId = (enrollment as { subject_id?: unknown }).subject_id;
  return typeof subjectId === 'string' && subjectId.trim().length > 0 ? subjectId.trim() : null;
}

function sameSubject(enrolled: string, domain: string): boolean {
  const canonical = (raw: string) => resolveKnownSubjectId(raw) ?? normalizeSubjectKey(raw);
  return canonical(enrolled) === canonical(domain);
}

export async function questionSubject(db: Db | Tx, questionId: string): Promise<QuestionSubject> {
  const [row] = await db
    .select({ knowledge_ids: question.knowledge_ids, metadata: question.metadata })
    .from(question)
    .where(eq(question.id, questionId))
    .limit(1);
  const enrolled = enrolledSubjectId(row?.metadata);
  const first = row?.knowledge_ids?.[0];
  const [node] = first
    ? await db
        .select({ domain: knowledge.domain })
        .from(knowledge)
        .where(eq(knowledge.id, first))
        .limit(1)
    : [undefined];
  const domain = node?.domain?.trim() ? node.domain : null;
  if (!domain) return { key: enrolled };
  if (!enrolled || sameSubject(enrolled, domain)) return { key: domain };
  return {
    key: domain,
    mismatch: {
      used: 'knowledge',
      enrollment: { subject_id: enrolled, source: 'metadata.ingestion_enrollment.subject_id' },
      knowledge: { domain, knowledge_id: first as string, source: 'knowledge_ids[0]' },
    },
  };
}
