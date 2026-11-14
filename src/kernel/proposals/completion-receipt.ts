import { and, eq, inArray } from 'drizzle-orm';
import { newId } from '@/core/ids';
import {
  type CompletionReceipt,
  CompletionReceiptV1,
  CompletionSources,
} from '@/core/schema/learning-item-completion';
import type { Db, Tx } from '@/db/client';
import { event, goal, learning_item, materialized_id_index } from '@/db/schema';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import { writeEvent } from '@/kernel/events';
import { resolveGoalKnowledgeIds } from '@/kernel/read-models/active-goal-scope';
import { completionSourcesCurrent, readCompletionSources } from '@/kernel/read-models/usage-policy';
import { learnerSummaryIfAllowed } from './learner-summary';

export function parseCompletionReceipt(value: unknown): CompletionReceipt | null {
  const parsed = CompletionReceiptV1.safeParse(value);
  if (!parsed.success) return null;
  const {
    measured_at: _measured,
    format_version: _format,
    logical_fact_digest,
    evidence_identity_digest,
    ...logical
  } = parsed.data;
  if (
    sha256CanonicalJson(logical) !== logical_fact_digest ||
    sha256CanonicalJson(
      logical.knowledge.map((k) => ({ id: k.id, evidence: k.evidence.filter((e) => e.correct) })),
    ) !== evidence_identity_digest
  )
    return null;
  return parsed.data;
}

/** Decision owners read the stored proof, never a caller's learner-safe inbox payload. */
export async function readStoredCompletionReceipt(
  tx: Tx,
  proposalId: string,
  subjectKind: 'learning_item' | 'goal' = 'learning_item',
): Promise<CompletionReceipt | null> {
  const [row] = await tx.select().from(event).where(eq(event.id, proposalId));
  if (row?.action !== 'experimental:proposal') return null;
  const payload = row.payload.ai_proposal ?? row.payload;
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('kind' in payload) ||
    payload.kind !== 'completion' ||
    !('proposed_change' in payload)
  )
    return null;
  const change = payload.proposed_change;
  if (!change || typeof change !== 'object' || !('receipt' in change)) return null;
  const parsed = parseCompletionReceipt(change.receipt);
  const targetKey = subjectKind === 'goal' ? 'goal_id' : 'learning_item_id';
  if (
    !parsed ||
    !(targetKey in change) ||
    Reflect.get(change, targetKey) !== parsed.item_id ||
    !('target' in payload) ||
    !payload.target ||
    typeof payload.target !== 'object' ||
    !('subject_kind' in payload.target) ||
    payload.target.subject_kind !== subjectKind ||
    !('subject_id' in payload.target) ||
    payload.target.subject_id !== parsed.item_id
  )
    return null;
  return parsed;
}

export async function completionReceiptDisplayAllowed(
  db: Db | Tx,
  receipt: CompletionReceipt,
  subjectKind: 'learning_item' | 'goal' = 'learning_item',
): Promise<boolean> {
  if (!(await completionSourcesCurrent(db, receipt.sources))) return false;
  let ids: string[];
  let sourceRef: string | null;
  if (subjectKind === 'goal') {
    const [currentGoal] = await db.select().from(goal).where(eq(goal.id, receipt.item_id));
    if (
      currentGoal?.status !== 'active' ||
      currentGoal.steering !== null ||
      !(
        (currentGoal.source === 'manual' && currentGoal.source_ref === null) ||
        (currentGoal.source === 'goal_scope_proposal' && currentGoal.source_ref)
      )
    )
      return false;
    ids = await resolveGoalKnowledgeIds(db, currentGoal);
    sourceRef = currentGoal.source_ref;
  } else {
    const [item] = await db
      .select()
      .from(learning_item)
      .where(eq(learning_item.id, receipt.item_id));
    if (
      !item ||
      item.archived_at !== null ||
      !(
        (item.source === 'manual' && item.source_ref === null) ||
        (item.source === 'learning_intent' && item.source_ref)
      )
    )
      return false;
    ids = item.knowledge_ids;
    sourceRef = item.source_ref;
  }
  if (JSON.stringify([...new Set(ids)].sort()) !== JSON.stringify(receipt.knowledge_ids))
    return false;
  const births = ids.length
    ? await db
        .select()
        .from(materialized_id_index)
        .where(
          and(
            eq(materialized_id_index.subject_kind, 'knowledge'),
            inArray(materialized_id_index.materialized_id, ids),
          ),
        )
    : [];
  if (births.length !== new Set(ids).size) return false;
  const roots = [
    ...receipt.sources.nodes,
    ...births.map((b) => ({ kind: 'event' as const, id: b.anchor_event_id })),
    ...(sourceRef ? [{ kind: 'event' as const, id: sourceRef }] : []),
  ];
  return (await readCompletionSources(db, roots)) !== null;
}

export function completionReceiptSummary(receipt: CompletionReceipt, goalTitle?: string): string {
  if (goalTitle !== undefined) {
    return (
      learnerSummaryIfAllowed(
        `你的「${goalTitle.slice(0, 30)}」目标范围已达当前完成门槛，请确认完成。`,
      ) ?? '目标范围内全部知识点达到当前完成门槛，请确认完成。'
    );
  }
  const count = Math.min(
    ...receipt.knowledge.map((k) => k.evidence.filter((e) => e.correct).length),
  );
  const point = Math.min(...receipt.knowledge.map((k) => k.point));
  return `全部 ${receipt.knowledge.length} 个知识点达到当前完成门槛：掌握度≥${Math.round(point * 100)}%，各≥${count}组独立答对。请确认完成。`;
}

/** Seal the exact permitted tool input before the model can receive it. */
export async function bindCompletionEvidenceRead(
  db: Db,
  binding: { askId: string; taskRunId: string; itemId: string },
  receipts: CompletionReceipt[],
): Promise<void> {
  const nodes = new Map(
    receipts.flatMap((r) => r.sources.nodes).map((n) => [`${n.kind}:${n.id}`, n]),
  );
  const sources = CompletionSources.parse({
    nodes: [...nodes.values()],
    epochs: Object.assign({}, ...receipts.map((r) => r.sources.epochs)),
  });
  await writeEvent(db, {
    id: newId(),
    actor_kind: 'system',
    actor_ref: 'completion-evidence',
    action: 'experimental:completion_evidence_read',
    subject_kind: 'learning_item',
    subject_id: binding.itemId,
    payload: { format_version: 1, sources },
    affected_scopes: [],
    caused_by_event_id: binding.askId,
    task_run_id: binding.taskRunId,
  });
}
