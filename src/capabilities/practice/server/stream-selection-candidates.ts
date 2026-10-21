import { inArray } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { question } from '@/db/schema';
import type { CandidateInput } from './candidate-signals';
import { rotationClassForKind } from './variant-rotation';

/**
 * Read signal inputs for already-selected stream candidates, without deciding eligibility.
 * Query ids are deduplicated; output preserves raw order, duplicates, and missing rows.
 */
export async function readStreamSelectionCandidates(
  db: Db | Tx,
  raws: readonly { questionId: string; role: 'variant' | 'new_check' | 'frontier' }[],
): Promise<CandidateInput[]> {
  if (raws.length === 0) return [];
  const qids = [...new Set(raws.map((r) => r.questionId))];
  const rows = await db
    .select({
      id: question.id,
      kind: question.kind,
      knowledge_ids: question.knowledge_ids,
      difficulty: question.difficulty,
      source: question.source,
    })
    .from(question)
    .where(inArray(question.id, qids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return raws.map((raw) => {
    const q = byId.get(raw.questionId);
    const kind = q?.kind;
    return {
      refKind: 'question' as const,
      refId: raw.questionId,
      // Variants use diagnostic scoring; new-check and frontier retain their own roles.
      role: raw.role === 'variant' ? ('diagnostic' as const) : raw.role,
      // Unknown/missing labels must reach the signal collector as undefined so it
      // recall-locks them. Preserve known labels, using the rotation owner's table.
      kind: kind != null && rotationClassForKind(kind) !== undefined ? kind : undefined,
      knowledgeIds: q?.knowledge_ids,
      difficulty: q?.difficulty,
      // Question provenance for family_key resolution, distinct from stream-slot source.
      source: q?.source,
    };
  });
}
