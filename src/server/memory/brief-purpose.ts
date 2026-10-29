import { eq, sql } from 'drizzle-orm';
import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { memory_brief_note } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import {
  BRIEF_PURPOSE_ACTION,
  briefPurposeCurrent,
  readPurposeReceipt,
  readPurposeRepairs,
} from '@/kernel/read-models/purpose-change';
import { recordPurposeRepair } from './purpose-repair-store';

export async function scopeBriefPurposeCurrent(db: Db | Tx, scopeKey: string) {
  const [row] = await db
    .select({ version: memory_brief_note.version })
    .from(memory_brief_note)
    .where(eq(memory_brief_note.scope_key, scopeKey))
    .limit(1);
  return !row || (await briefPurposeCurrent(db, scopeKey, row.version));
}

export async function markBriefPurpose(
  tx: Tx,
  scopeKey: string,
  version: number,
  withdrawal: string | null,
) {
  await writeEvent(tx, {
    id: newId(),
    actor_kind: 'system',
    actor_ref: 'memory-brief-writer',
    action: BRIEF_PURPOSE_ACTION,
    subject_kind: 'query',
    subject_id: scopeKey,
    payload: {
      version: 1,
      brief_version: version,
      withdrawal_id: withdrawal,
      derivation_policy: 'answer_only',
    },
    affected_scopes: [],
    ingest_at: new Date(),
  });
}

/** Once-only purpose regeneration on the existing paid writer. No queue/provider
 * IO occurs under the reservation lock; unknown attempts are never retried here.
 */
export async function executePurposeBrief(
  db: Db,
  input: { scopeKey: string; operationId?: string; jobId: string },
  generate: (taskRunId?: string) => Promise<void>,
) {
  const { operationId, scopeKey, jobId } = input;
  const taskRunId = operationId ? `memory-purpose-brief:${jobId}` : undefined;
  const run = await db.transaction(async (tx) => {
    if (!operationId) return scopeBriefPurposeCurrent(tx, scopeKey);
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`purpose-brief:${operationId}:${scopeKey}`}, 0))`,
    );
    const receipt = await readPurposeReceipt(tx, operationId);
    if (
      !receipt?.cleanup_required ||
      !receipt.brief_scopes.some((scope) => scope.scope_key === scopeKey)
    )
      throw new Error('unbound purpose brief job');
    if (
      (await readPurposeRepairs(tx, operationId)).some(
        (r) => r.sink === 'brief' && r.source_id === scopeKey,
      )
    )
      return false;
    const current = await scopeBriefPurposeCurrent(tx, scopeKey);
    await recordPurposeRepair(tx, {
      operation_id: operationId,
      sink: 'brief',
      source_id: scopeKey,
      state: current ? 'complete' : 'unknown',
      task_run_id: current ? undefined : taskRunId,
      detail: current
        ? 'current brief already covers latest withdrawal; no provider call'
        : 'writer pipeline reserved; uncertain outcomes cannot automatically retry',
    });
    return !current;
  });
  if (!run) return;
  try {
    await generate(taskRunId);
    if (operationId)
      await recordPurposeRepair(db, {
        operation_id: operationId,
        sink: 'brief',
        source_id: scopeKey,
        state: 'complete',
        task_run_id: taskRunId,
        detail: 'writer committed replacement at current purpose watermark',
      });
  } catch (error) {
    if (operationId)
      await recordPurposeRepair(db, {
        operation_id: operationId,
        sink: 'brief',
        source_id: scopeKey,
        state: 'unknown',
        task_run_id: taskRunId,
        detail: error instanceof Error ? error.message.slice(0, 300) : 'writer outcome unknown',
      });
    throw error;
  }
}
