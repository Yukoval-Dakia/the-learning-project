import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { readAgentBudget, writeAgentBudgetPath } from './agent/budget-state';

// The reader refuses non-uuid operation ids; a future anchor-format change
// must degrade to "identity not recorded", never poison the session evidence.
const uuidSchema = z.uuid();

export type ExtractCostIdentities = {
  readonly task_run_ids: string[];
  readonly ocr_operation_ids: string[];
};

const EMPTY: ExtractCostIdentities = { task_run_ids: [], ocr_operation_ids: [] };

/** The extract lane's own key inside the shared agent_budget envelope. */
export function extractCostIdentitiesOf(
  budget: {
    extract_cost?: unknown;
  } | null,
): ExtractCostIdentities {
  const raw = budget?.extract_cost;
  if (raw === null || typeof raw !== 'object') return EMPTY;
  const record = raw as { task_run_ids?: unknown; ocr_operation_ids?: unknown };
  const clean = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  return {
    task_run_ids: clean(record.task_run_ids),
    ocr_operation_ids: clean(record.ocr_operation_ids),
  };
}

/**
 * Durable binding between an ingestion session and its extract-lane paid calls
 * (OCR page operations, StructureTask / assembly / bridge / naming task runs).
 * Written on the same session row the cost-evidence read model already loads;
 * the row lock serializes concurrent writers (extract job vs enroll follow-ups).
 */
export async function recordExtractCostIdentities(
  db: Db,
  sessionId: string,
  identities: {
    taskRunIds?: readonly string[];
    ocrOperationIds?: readonly string[];
  },
): Promise<void> {
  const taskRunIds = (identities.taskRunIds ?? []).filter((id) => id.trim().length > 0);
  const ocrOperationIds = (identities.ocrOperationIds ?? []).filter(
    (id) => uuidSchema.safeParse(id).success,
  );
  if (taskRunIds.length === 0 && ocrOperationIds.length === 0) return;
  await db.transaction(async (tx: Tx) => {
    const budget = await readAgentBudget(tx, sessionId, true);
    const existing = extractCostIdentitiesOf(budget);
    await writeAgentBudgetPath(tx, sessionId, ['extract_cost'], {
      task_run_ids: [...new Set([...existing.task_run_ids, ...taskRunIds])],
      ocr_operation_ids: [...new Set([...existing.ocr_operation_ids, ...ocrOperationIds])],
    });
  });
}
