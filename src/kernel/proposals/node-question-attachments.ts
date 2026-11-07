// Auto-ownership proof for question→node attachments, shared by the
// knowledge_node retract applier (enforcement) and the batch-undo classifier
// (advisory verdict — both must agree or the inbox offers an undo the backend
// refuses).
//
// An attachment is auto-owned only while it is PROVABLY still the machine's
// own placement, in exactly one of two ways:
//   born   — a version-0 companion teaching draft authored directly at the
//            node (the attach happened at authoring; no human edit exists);
//   refiled — a root_placement_refile event records this question's move to
//            the node at the row's CURRENT version, so nothing edited it since.
// Multi-attachment rows ([N,M]) are never auto-owned: stripping N would
// silently rewrite an attachment shape the automation did not produce.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { QUESTION_EDIT_ACTION } from '@/core/schema/event/experimental';
import type { Db, Tx } from '@/db/client';
import { event, question } from '@/db/schema';

export interface AttachedQuestionRow {
  readonly id: string;
  readonly knowledgeIds: string[];
  readonly version: number;
  readonly companionAuthored: boolean;
}

export async function selectNodeAttachedQuestions(
  db: Db | Tx,
  nodeId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<AttachedQuestionRow[]> {
  const query = db
    .select({
      id: question.id,
      knowledgeIds: question.knowledge_ids,
      version: question.version,
      companionAuthored: sql<boolean>`${question.metadata} -> 'teaching_draft' is not null`,
    })
    .from(question)
    .where(sql`${question.knowledge_ids} @> ${JSON.stringify([nodeId])}::jsonb`)
    .orderBy(asc(question.id));
  const rows = await (opts.forUpdate ? query.for('update') : query);
  return rows;
}

type RefileProofMap = Map<string, Set<number>>;

/** question_id → recorded next_versions whose after-state attached it to nodeId. */
export async function loadRefileProofMap(
  db: Db | Tx,
  nodeId: string,
  questionIds: readonly string[],
): Promise<RefileProofMap> {
  const proofs: RefileProofMap = new Map();
  if (questionIds.length === 0) return proofs;
  const rows = await db
    .select({ subjectId: event.subject_id, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, QUESTION_EDIT_ACTION),
        inArray(event.subject_id, [...questionIds]),
        sql`${event.payload} ->> 'reason' = 'root_placement_refile'`,
      ),
    );
  for (const row of rows) {
    const payload = row.payload as Record<string, unknown> | null;
    const after = payload?.after as { knowledge_ids?: unknown } | undefined;
    const nextVersion = payload?.next_version;
    const ids = Array.isArray(after?.knowledge_ids) ? after.knowledge_ids : null;
    if (
      row.subjectId === null ||
      typeof nextVersion !== 'number' ||
      ids === null ||
      ids.length !== 1 ||
      ids[0] !== nodeId
    ) {
      continue;
    }
    const versions = proofs.get(row.subjectId) ?? new Set<number>();
    versions.add(nextVersion);
    proofs.set(row.subjectId, versions);
  }
  return proofs;
}

export function isAutoOwnedAttachment(
  row: AttachedQuestionRow,
  nodeId: string,
  proofs: RefileProofMap,
): boolean {
  if (row.knowledgeIds.length !== 1 || row.knowledgeIds[0] !== nodeId) return false;
  if (row.version === 0 && row.companionAuthored) return true;
  return proofs.get(row.id)?.has(row.version) ?? false;
}
