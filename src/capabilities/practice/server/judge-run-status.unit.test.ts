// YUK-594 (durable judge main path, W1) — deriveJudgeRunStatus + terminalJudgeRunResult
// pure-reducer unit tests (no DB; mirrors copilot-run-status.test.ts shape).

import { describe, expect, it } from 'vitest';
import {
  JUDGE_RUN_EVENTS,
  type JudgeRunReplayEvent,
  type JudgeRunStatusEvent,
  JudgeRunStatusResponseSchema,
  deriveJudgeRunStatus,
  terminalJudgeRunResult,
} from './judge-run-status';

const ev = (event_type: string): JudgeRunStatusEvent => ({ event_type });

describe('deriveJudgeRunStatus', () => {
  it('empty sequence → queued (conservative initial)', () => {
    expect(deriveJudgeRunStatus([])).toBe('queued');
  });

  it('queued → started on STARTED', () => {
    expect(deriveJudgeRunStatus([ev(JUDGE_RUN_EVENTS.QUEUED), ev(JUDGE_RUN_EVENTS.STARTED)])).toBe(
      'started',
    );
  });

  it('DONE is terminal', () => {
    expect(
      deriveJudgeRunStatus([
        ev(JUDGE_RUN_EVENTS.QUEUED),
        ev(JUDGE_RUN_EVENTS.STARTED),
        ev(JUDGE_RUN_EVENTS.DONE),
      ]),
    ).toBe('done');
  });

  it('FAILED is terminal', () => {
    expect(deriveJudgeRunStatus([ev(JUDGE_RUN_EVENTS.STARTED), ev(JUDGE_RUN_EVENTS.FAILED)])).toBe(
      'failed',
    );
  });

  it('last-writer-wins: a FAILED then a DONE (cross-provider re-delivery recovered) → done', () => {
    expect(
      deriveJudgeRunStatus([
        ev(JUDGE_RUN_EVENTS.STARTED),
        ev(JUDGE_RUN_EVENTS.FAILED),
        ev(JUDGE_RUN_EVENTS.STARTED),
        ev(JUDGE_RUN_EVENTS.DONE),
      ]),
    ).toBe('done');
  });

  it('last-writer-wins: a DONE then a FAILED → failed', () => {
    expect(deriveJudgeRunStatus([ev(JUDGE_RUN_EVENTS.DONE), ev(JUDGE_RUN_EVENTS.FAILED)])).toBe(
      'failed',
    );
  });

  it('STARTED after terminal does not un-terminal', () => {
    expect(deriveJudgeRunStatus([ev(JUDGE_RUN_EVENTS.DONE), ev(JUDGE_RUN_EVENTS.STARTED)])).toBe(
      'done',
    );
  });

  it('unknown event types are ignored (forward-compat)', () => {
    expect(
      deriveJudgeRunStatus([ev(JUDGE_RUN_EVENTS.STARTED), ev('judge_run.some_future_event')]),
    ).toBe('started');
  });
});

describe('terminalJudgeRunResult', () => {
  const rev = (event_type: string, payload: unknown): JudgeRunReplayEvent => ({
    event_type,
    payload,
  });

  it('returns null when no DONE present', () => {
    expect(terminalJudgeRunResult([rev(JUDGE_RUN_EVENTS.STARTED, {})])).toBeNull();
    expect(terminalJudgeRunResult([rev(JUDGE_RUN_EVENTS.FAILED, { error: 'x' })])).toBeNull();
  });

  it('returns the DONE payload (the verdict) when present', () => {
    const verdict = { coarse_outcome: 'correct', score: 1 };
    expect(
      terminalJudgeRunResult([
        rev(JUDGE_RUN_EVENTS.STARTED, {}),
        rev(JUDGE_RUN_EVENTS.DONE, verdict),
      ]),
    ).toEqual(verdict);
  });

  it('last DONE wins (re-delivery re-verdict)', () => {
    const first = { coarse_outcome: 'incorrect' };
    const second = { coarse_outcome: 'correct' };
    expect(
      terminalJudgeRunResult([
        rev(JUDGE_RUN_EVENTS.DONE, first),
        rev(JUDGE_RUN_EVENTS.DONE, second),
      ]),
    ).toEqual(second);
  });
});

// #13 — the response contract now ENCODES the status↔result coupling instead of only
// documenting it in a comment. Pre-fix the flat object admitted `status:'queued'` with a
// populated `result`, so generated clients saw an impossible state as valid.
describe('JudgeRunStatusResponseSchema (contract coupling)', () => {
  const verdict = { attempt_event_id: 'run1', coarse_outcome: 'correct' };

  it('accepts done + a verdict', () => {
    expect(
      JudgeRunStatusResponseSchema.safeParse({ run_id: 'run1', status: 'done', result: verdict })
        .success,
    ).toBe(true);
  });

  it('accepts done + null (the route degrades a malformed terminal payload to null)', () => {
    expect(
      JudgeRunStatusResponseSchema.safeParse({ run_id: 'run1', status: 'done', result: null })
        .success,
    ).toBe(true);
  });

  it.each(['queued', 'started', 'failed'])('accepts %s with a null result', (status) => {
    expect(
      JudgeRunStatusResponseSchema.safeParse({ run_id: 'run1', status, result: null }).success,
    ).toBe(true);
  });

  it.each(['queued', 'started', 'failed'])(
    'REJECTS %s carrying a verdict (the invariant the old flat schema allowed)',
    (status) => {
      expect(
        JudgeRunStatusResponseSchema.safeParse({ run_id: 'run1', status, result: verdict }).success,
      ).toBe(false);
    },
  );
});
