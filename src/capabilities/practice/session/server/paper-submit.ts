import type { Db } from '@/db/client';
import { db as defaultDb } from '@/db/client';
import { ApiError } from '@/kernel/http';
import { type NativePaperAttemptInput, submitNativePaperAttempt } from './assessment/paper-attempt';

export const HIDE_FEEDBACK_POLICY = 'judge_now_show_later' as const;

export interface PaperSubmitSlotInput extends Omit<NativePaperAttemptInput, 'assessment'> {
  /** Required at runtime; historical callers receive a structured conflict. */
  assessment?: NativePaperAttemptInput['assessment'];
  /** Historical capture arguments never select native scoring or learning targets. */
  primaryKnowledgeId?: string | null;
  secondaryKnowledgeIds?: string[];
  feedbackPolicy?: string | null;
}
export type PaperSubmitSlotResult = Awaited<ReturnType<typeof submitNativePaperAttempt>>;

/** The sole paper execution route consumes the original opening receipt. */
export async function submitPaperSlot(
  input: PaperSubmitSlotInput,
  db: Db = defaultDb,
): Promise<PaperSubmitSlotResult> {
  if (!input.assessment) {
    throw new ApiError(
      'historical_unknown',
      'paper submission requires an original issued assessment',
      409,
    );
  }
  return submitNativePaperAttempt(db, { ...input, assessment: input.assessment });
}
