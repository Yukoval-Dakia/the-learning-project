// Practice owns the due-review predicate (FSRS schedule truth plus never-reviewed
// failures). Non-LLM read paths call this reader so the predicate stays single-sourced;
// Practice binds it at API and worker startup. No events are written.

import type { ToolContext } from '@/kernel/tools/types';

export interface ReviewDueQuery {
  limit?: number;
  knowledgeIds?: string[];
  causes?: string[];
  includeReason?: boolean;
}

export interface ReviewDueQueue {
  queue_summary: { total_returned: number };
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
    throw new Error(
      'review-due reader is not installed; call installPracticeHostOperations at startup',
    );
  }
  return installedReader(ctx, query);
}
