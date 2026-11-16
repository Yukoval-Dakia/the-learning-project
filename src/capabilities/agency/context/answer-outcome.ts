import { inArray } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import {
  nativeAttemptOutcome,
  resolveVerdictsForNativeAttempts,
} from '@/kernel/read-models/assessment-verdict';

type DbLike = Db | Tx;

export type GradedOutcome = 'success' | 'failure' | 'partial';

function graded(outcome: string | null | undefined): GradedOutcome | null {
  return outcome === 'success' || outcome === 'failure' || outcome === 'partial' ? outcome : null;
}

export function outcomeWord(outcome: string | null): string {
  return outcome === 'success'
    ? '对'
    : outcome === 'failure'
      ? '错'
      : outcome === 'partial'
        ? '半对'
        : '已记';
}

/**
 * Right/wrong for answer rows. A native attempt's grade is its effective
 * evaluation; a legacy attempt or review keeps the outcome stored on the row.
 * Pending, self-report, and unsupported answers are null.
 */
export async function gradedOutcomesForAnswerRows(
  db: DbLike,
  rows: readonly { id: string; action: string; outcome: string | null }[],
): Promise<Map<string, GradedOutcome | null>> {
  const out = new Map<string, GradedOutcome | null>();
  const nativeIds = rows
    .filter((row) => row.action === 'experimental:assessment_attempt')
    .map((row) => row.id);
  const anchors =
    nativeIds.length === 0 ? [] : await db.select().from(event).where(inArray(event.id, nativeIds));
  const verdicts =
    anchors.length === 0 ? new Map() : await resolveVerdictsForNativeAttempts(db, anchors);
  for (const row of rows) {
    if (row.action === 'experimental:assessment_attempt') {
      const outcome = nativeAttemptOutcome(verdicts.get(row.id));
      out.set(row.id, graded(outcome));
      continue;
    }
    if (row.action === 'attempt' || row.action === 'review') out.set(row.id, graded(row.outcome));
  }
  return out;
}
