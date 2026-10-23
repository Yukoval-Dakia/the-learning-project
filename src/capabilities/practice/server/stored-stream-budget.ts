import { estimateStreamItemMinutes, fitStreamToTimeBudget } from './stream-budget';

interface StoredStreamBudgetRow {
  readonly id: string;
  readonly item_kind: 'question' | 'paper';
}

interface StoredStreamBudgetInput {
  readonly rows: readonly StoredStreamBudgetRow[];
  readonly recoveryRowIds: ReadonlySet<string>;
  readonly budgetMinutes: number;
  readonly questionMinutes: number;
}

interface StoredStreamBudgetTrimInput extends StoredStreamBudgetInput {
  readonly rows: readonly (StoredStreamBudgetRow & {
    readonly status: string;
    readonly source: string;
  })[];
}

/** All non-recovery rows count, including completed and intervention rows. */
export function storedStreamExceedsBudget({
  rows,
  recoveryRowIds,
  budgetMinutes,
  questionMinutes,
}: StoredStreamBudgetInput): boolean {
  return (
    rows
      .filter((row) => !recoveryRowIds.has(row.id))
      .reduce((sum, row) => sum + estimateStreamItemMinutes(row.item_kind, questionMinutes), 0) >
    budgetMinutes
  );
}

/** Plan removable pending IDs; admission and recovery identity are supplied by the caller. */
export function planStoredStreamBudgetTrim({
  rows: eligible,
  recoveryRowIds,
  budgetMinutes,
  questionMinutes,
}: StoredStreamBudgetTrimInput): string[] {
  // Recovery rows (unsupported pinned contract + accepted submission) are not
  // prospective work: they stay visible as the settlement/recovery entry point
  // but sit outside the budget economy entirely — never a trimmable tail, and
  // never consuming the minutes that decide other rows' fate.
  const frozen = eligible.filter((row) => row.status !== 'pending' && !recoveryRowIds.has(row.id));
  const frozenMinutes = frozen.reduce(
    (sum, row) => sum + estimateStreamItemMinutes(row.item_kind, questionMinutes),
    0,
  );
  const pending = eligible.filter((row) => row.status === 'pending' && !recoveryRowIds.has(row.id));
  // An intervention row is the learner-visible delivery of approved material,
  // not an ordinary recommendation tail. Never trim it merely because it was
  // appended after the day's budget was composed; instead budget the remaining
  // pending rows around this protected delivery.
  const protectedPending = pending.filter((row) => row.source === 'intervention');
  const budgetablePending = pending.filter((row) => row.source !== 'intervention');
  const protectedMinutes = protectedPending.reduce(
    (sum, row) => sum + estimateStreamItemMinutes(row.item_kind, questionMinutes),
    0,
  );
  const remaining = Math.max(0, budgetMinutes - frozenMinutes - protectedMinutes);
  const keptBudgetable =
    remaining === 0
      ? []
      : fitStreamToTimeBudget(budgetablePending, remaining, questionMinutes).kept;
  const keptPending = [...protectedPending, ...keptBudgetable];
  const keptIds = new Set(keptPending.map((row) => row.id));
  return pending.filter((row) => !keptIds.has(row.id)).map((row) => row.id);
}
