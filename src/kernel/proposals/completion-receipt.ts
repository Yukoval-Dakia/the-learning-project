import { and, eq, inArray } from 'drizzle-orm';
import { newId } from '@/core/ids';
import {
  type CompletionReceipt,
  CompletionReceiptV1,
  CompletionSources,
} from '@/core/schema/learning-item-completion';
import type { Db, Tx } from '@/db/client';
import { event, learning_item, materialized_id_index } from '@/db/schema';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import { writeEvent } from '@/kernel/events';
import { completionSourcesCurrent, readCompletionSources } from '@/kernel/read-models/usage-policy';

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
  if (!parsed || !('learning_item_id' in change) || change.learning_item_id !== parsed.item_id)
    return null;
  return parsed;
}

export async function completionReceiptDisplayAllowed(
  db: Db | Tx,
  receipt: CompletionReceipt,
): Promise<boolean> {
  if (!(await completionSourcesCurrent(db, receipt.sources))) return false;
  const [item] = await db.select().from(learning_item).where(eq(learning_item.id, receipt.item_id));
  if (
    !item ||
    item.archived_at !== null ||
    JSON.stringify([...new Set(item.knowledge_ids)].sort()) !==
      JSON.stringify(receipt.knowledge_ids) ||
    !(
      (item.source === 'manual' && item.source_ref === null) ||
      (item.source === 'learning_intent' && item.source_ref)
    )
  )
    return false;
  const births = item.knowledge_ids.length
    ? await db
        .select()
        .from(materialized_id_index)
        .where(
          and(
            eq(materialized_id_index.subject_kind, 'knowledge'),
            inArray(materialized_id_index.materialized_id, item.knowledge_ids),
          ),
        )
    : [];
  if (births.length !== new Set(item.knowledge_ids).size) return false;
  const roots = [
    ...receipt.sources.nodes,
    ...births.map((b) => ({ kind: 'event' as const, id: b.anchor_event_id })),
    ...(item.source_ref ? [{ kind: 'event' as const, id: item.source_ref }] : []),
  ];
  return (await readCompletionSources(db, roots)) !== null;
}

export function completionReceiptSummary(receipt: CompletionReceipt): string {
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
