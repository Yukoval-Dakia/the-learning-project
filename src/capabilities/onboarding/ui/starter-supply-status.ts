// YUK-1438 — what the placement screen says while it has no question to show.
// Reads the public `starterSupply` outcomes (YUK-1405, on start / next / detail responses) and
// turns them into learner wording. Design H5: only a usable result is "ready"; preparing says
// it cannot start yet; failures and uncertainty name the reason.
import type { PlacementStartResult } from './placement-api';

export type StarterOutcome = NonNullable<PlacementStartResult['starterSupply']>[number];
type StarterFailure = NonNullable<StarterOutcome['failure_reason']>;

export type StarterStatus =
  | { kind: 'need_goal' }
  | { kind: 'not_started' }
  | { kind: 'preparing'; lastFailure: string | null }
  | { kind: 'ready' }
  | { kind: 'failed'; reason: string }
  | { kind: 'unknown'; reason: string; final: boolean };

const FAILURE_TEXT: Record<StarterFailure['code'], string> = {
  schema_invalid: 'AI 出的题格式不对，用不了',
  json_invalid: 'AI 出的题格式不对，用不了',
  json_object_missing: 'AI 出的题格式不对，用不了',
  underfilled: 'AI 出的题不够数',
  verification_timeout: '检查题目时超时了',
  interrupted: '准备过程被中断了',
  delivery_lost: '准备任务中途丢失了',
  cost_unknown: '这次的花费没法确认，为安全起见先停下了',
  budget_exhausted: '本周的 AI 预算用完了',
  authority_unknown: '没法确认学习目标对应哪些内容，之前的准备对不上了',
  unknown: '没有记下具体原因',
};

export function starterFailureText(failure: StarterFailure): string {
  return FAILURE_TEXT[failure.code];
}

// One status for the whole goal: a usable result wins, then work still in progress, then
// failures, then uncertainty. Without outcomes (older responses) nothing is claimed.
export function starterStatus(outcomes: readonly StarterOutcome[] | undefined): StarterStatus {
  const list = outcomes ?? [];
  if (list.some((o) => o.state === 'satisfied')) return { kind: 'ready' };
  const pending = list.find((o) => o.state === 'pending');
  if (pending) {
    return {
      kind: 'preparing',
      lastFailure: pending.failure_reason ? starterFailureText(pending.failure_reason) : null,
    };
  }
  const failed = list.find((o) => o.state === 'exhausted');
  if (failed) return { kind: 'failed', reason: starterFailureText(failed.failure_reason) };
  const unknown = list.find((o) => o.state === 'unknown');
  if (unknown) {
    return {
      kind: 'unknown',
      reason: starterFailureText(unknown.failure_reason),
      // An unconfirmed cost stops paid preparation for good; checking again cannot change it.
      final: unknown.failure_reason.code === 'cost_unknown',
    };
  }
  if (list.some((o) => o.state === 'absent' && o.next_action === 'provide_goal')) {
    return { kind: 'need_goal' };
  }
  return { kind: 'not_started' };
}
