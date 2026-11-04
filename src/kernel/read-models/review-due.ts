// Practice owns the due-review predicate (FSRS schedule truth plus never-reviewed
// failures). Non-LLM read paths call this reader so the predicate stays single-sourced;
// Practice binds it at API and worker startup. No events are written.

import { HostOperationNotInstalledError } from '@/kernel/host-operation';
import type { ToolContext } from '@/kernel/tools/types';

export interface ReviewDueQuery {
  limit?: number;
  knowledgeIds?: string[];
  causes?: string[];
  includeReason?: boolean;
}

/**
 * One returned actionable due row. Field set is deliberately the starter-segment
 * projection: implementing readers may return more (the tool output carries tier /
 * fsrs_state / latest_mistake), consumers read only what's declared here.
 */
export interface ReviewDueQueueRow {
  question_id: string;
  prompt_excerpt: string;
  knowledge_ids: string[];
  due_at: string | null;
  reason: 'never_reviewed_failure' | 'overdue' | 'filtered_match';
}

export interface ReviewDueQueue {
  queue_summary: { total_returned: number };
  /** Returned actionable rows (never-reviewed failures, then due-earliest), capped by query limit. */
  rows: ReviewDueQueueRow[];
}

export type ReviewDueReader = (ctx: ToolContext, query: ReviewDueQuery) => Promise<ReviewDueQueue>;

let installedReader: ReviewDueReader | undefined;

export function installReviewDueReader(reader: ReviewDueReader): void {
  installedReader = reader;
}

export async function executeGetReviewDue(
  ctx: ToolContext,
  query: ReviewDueQuery,
): Promise<ReviewDueQueue> {
  if (!installedReader) {
    throw new HostOperationNotInstalledError(
      'review-due reader is not installed; call installPracticeHostOperations at startup',
    );
  }
  return installedReader(ctx, query);
}
