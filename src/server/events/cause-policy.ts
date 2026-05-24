import type { CauseCategoryT } from '@/core/schema/event/blocks';
import type { EffectiveTruth } from '@/server/review/effective-truth';
import type { FailureAttempt } from './queries';

export type EffectiveFailureCause =
  | {
      source: 'user';
      event_id: string;
      primary_category: CauseCategoryT;
      secondary_categories: [];
      analysis_md: null;
      user_notes: string | null;
      confidence: null;
      created_at: Date;
      correction_state: EffectiveTruth;
    }
  | {
      source: 'agent';
      event_id: string;
      primary_category: CauseCategoryT;
      secondary_categories: string[];
      analysis_md: string;
      user_notes: null;
      confidence: number;
      created_at: Date;
      correction_state: EffectiveTruth;
    };

/**
 * Effective cause policy for mistake projections:
 * active user_cause is authoritative; otherwise use the latest active agent judge.
 *
 * "Active" is already resolved by getFailureAttempts through correction/effective-truth.
 * This helper deliberately does no timestamp comparison between channels.
 */
export function effectiveCauseForFailureAttempt(
  failure: FailureAttempt,
): EffectiveFailureCause | null {
  if (failure.user_cause) {
    return {
      source: 'user',
      event_id: failure.user_cause.user_cause_event_id,
      primary_category: failure.user_cause.primary_category,
      secondary_categories: [],
      analysis_md: null,
      user_notes: failure.user_cause.user_notes,
      confidence: null,
      created_at: failure.user_cause.created_at,
      correction_state: failure.user_cause.correction_state,
    };
  }

  if (failure.judge) {
    return {
      source: 'agent',
      event_id: failure.judge.judge_event_id,
      primary_category: failure.judge.cause.primary_category,
      secondary_categories: (failure.judge.cause.secondary_categories ?? []) as string[],
      analysis_md: failure.judge.cause.analysis_md,
      user_notes: null,
      confidence: failure.judge.cause.confidence,
      created_at: failure.judge.created_at,
      correction_state: failure.judge.correction_state,
    };
  }

  return null;
}

export function effectiveCauseCategoryForFailureAttempt(
  failure: FailureAttempt,
): CauseCategoryT | null {
  return effectiveCauseForFailureAttempt(failure)?.primary_category ?? null;
}
