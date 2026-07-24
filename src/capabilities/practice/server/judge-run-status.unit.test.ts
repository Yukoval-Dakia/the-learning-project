// YUK-594 (durable judge main path, W1) — deriveJudgeRunStatus + terminalJudgeRunResult
// pure-reducer unit tests (no DB; mirrors copilot-run-status.test.ts shape).

import { describe, expect, it } from 'vitest';
import {
  JUDGE_RUN_EVENTS,
  type JudgeRunReplayEvent,
  type JudgeRunStatusEvent,
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
