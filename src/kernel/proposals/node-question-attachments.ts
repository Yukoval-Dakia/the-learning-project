// Auto-ownership proof for question→node attachments, shared by the
// knowledge_node retract applier (enforcement), the batch-undo classifier
// (advisory verdict — both must agree or the inbox offers an undo the backend
// refuses), and the root-placement mover (never relocates a question whose
// attachment was ever decided).
//
// The proof is event chronology, not row metadata: an attachment is
// auto-owned iff the question is attached to exactly nodeId AND its
// attachment history contains exactly one attribution-changing
// QUESTION_EDIT_ACTION event, and that event is the root_placement_refile
// whose after-state is [nodeId]. Anything else — a manual PATCH, a resubmit
// that rewrote the ids, a merge rewrite, an exact-duplicate KC merge — means
// a later decision may stand behind the current row, so the attachment is
// foreign and blocks. A question born on the node (same-name reuse, merge
// target) has no refile event and blocks. Multi-attachment rows ([N,M]) are
// never auto-owned: stripping N would silently rewrite an attachment shape
// the automation did not produce.
//
// question.version is deliberately NOT evidence: normal admission bumps it
// without touching attribution, and a knowledge merge rewrites attribution
// without bumping it. teaching_draft metadata records birth, not current
// ownership, so it is not consulted either.
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { QUESTION_EDIT_ACTION } from '@/core/schema/event/experimental';
import type { Db, Tx } from '@/db/client';
import { event, question } from '@/db/schema';

export interface AttachedQuestionRow {
  readonly id: string;
  readonly knowledgeIds: string[];
  readonly version: number;
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
    })
    .from(question)
    .where(sql`${question.knowledge_ids} @> ${JSON.stringify([nodeId])}::jsonb`)
    // Parents before parts: editQuestion FOR UPDATEs the group root before it
    // updates a part, so a FOR UPDATE batch must take the same rows in the
    // same order or a child-first sort deadlocks against an in-flight edit.
    .orderBy(sql`${question.parent_question_id} is not null`, asc(question.id));
  const rows = await (opts.forUpdate ? query.for('update') : query);
  return rows;
}

/** `payload.reason` written by the mover; the only placement this proof accepts. */
export const ROOT_PLACEMENT_REFILE_REASON = 'root_placement_refile';
/** `payload.reason` written when a retract returns an auto-owned attachment to root. */
export const KNOWLEDGE_UNDO_REFILE_REASON = 'knowledge_undo_refile';
/** `payload.reason` written by the knowledge-merge attribution rewrite. */
export const KNOWLEDGE_MERGE_REWRITE_REASON = 'knowledge_merge_rewrite';
/** `payload.reason` written when an admitted resubmit rewrites attribution. */
export const SUBMIT_ATTRIBUTION_REASON = 'submit_attribution';

export interface AttachmentChange {
  readonly reason: string | null;
  readonly afterIds: string[];
}

function readIds(value: unknown): string[] | null {
  return Array.isArray(value) ? (value as string[]) : null;
}

function sameIds(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a == null || b == null) return a === b;
  if (a.length !== b.length) return false;
  return a.every((id, index) => id === b[index]);
}

/** question_id → attribution-changing edit events, oldest first. An event
 * counts only when before.knowledge_ids differs from after.knowledge_ids —
 * content edits that leave attribution alone are not ownership decisions, and
 * events that track no attribution fields at all are skipped the same way. */
export async function loadAttachmentChangeMap(
  db: Db | Tx,
  questionIds: readonly string[],
): Promise<Map<string, AttachmentChange[]>> {
  const changes = new Map<string, AttachmentChange[]>();
  if (questionIds.length === 0) return changes;
  const rows = await db
    .select({ subjectId: event.subject_id, payload: event.payload })
    .from(event)
    .where(and(eq(event.action, QUESTION_EDIT_ACTION), inArray(event.subject_id, [...questionIds])))
    .orderBy(asc(event.created_at), asc(event.id));
  for (const row of rows) {
    if (row.subjectId == null) continue;
    const payload = row.payload as {
      reason?: unknown;
      before?: { knowledge_ids?: unknown };
      after?: { knowledge_ids?: unknown };
    } | null;
    const before = readIds(payload?.before?.knowledge_ids);
    const after = readIds(payload?.after?.knowledge_ids);
    if (before == null && after == null) continue;
    if (sameIds(before ?? [], after ?? [])) continue;
    const list = changes.get(row.subjectId) ?? [];
    list.push({
      reason: typeof payload?.reason === 'string' ? payload.reason : null,
      afterIds: after ?? [],
    });
    changes.set(row.subjectId, list);
  }
  return changes;
}

/** True only while the current [nodeId] attachment is provably the mover's own
 * placement: one recorded attribution change, and it is the refile that put the
 * question on this node. Zero changes (born here, silent writers) or any other
 * event in the chain makes the attachment unprovable — retract then blocks. */
export function isAutoOwnedAttachment(
  row: AttachedQuestionRow,
  nodeId: string,
  changes: Map<string, AttachmentChange[]>,
): boolean {
  if (row.knowledgeIds.length !== 1 || row.knowledgeIds[0] !== nodeId) return false;
  const list = changes.get(row.id) ?? [];
  const only = list.length === 1 ? list[0] : undefined;
  return (
    only !== undefined &&
    only.reason === ROOT_PLACEMENT_REFILE_REASON &&
    sameIds(only.afterIds, [nodeId])
  );
}
