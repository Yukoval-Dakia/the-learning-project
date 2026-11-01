// YUK-1578 — degraded-scan merge semantics of the overnight digest's pure
// degraded_kinds computation (no DB).

import { describe, expect, it } from 'vitest';
import {
  DEGRADED_SCAN_NO_REASON_PLACEHOLDER,
  type DegradedScanRow,
  type RunErrorRow,
  computeDegradedKinds,
} from '@/kernel/read-models/overnight-digest-summary';

const T1 = '2026-10-27T19:00:00.000Z';
const T2 = '2026-10-27T20:00:00.000Z';
const T3 = '2026-10-27T21:00:00.000Z';

const err = (task_kind: string, at: string, error_message: string): RunErrorRow => ({
  task_kind,
  error_message,
  finished_at: at,
});
const scan = (task_kind: string, at: string, degraded_reason: string | null): DegradedScanRow => ({
  task_kind,
  degraded_reason,
  occurred_at: at,
});

describe('computeDegradedKinds degraded-scan merge', () => {
  // @invariant data: one degraded scan marks its kind while a single transient error stays silent, and same-kind errors and scans merge into one newest-first flag without crossing kinds
  // @fails-if degraded scans fall under the ≥2 error threshold, the threshold loosens for error rows, counts or message samples split by source, samples misorder, or null reasons lose their placeholder
  it.each([
    {
      name: 'single degraded scan flags threshold-free',
      rows: [] as RunErrorRow[],
      scans: [scan('CoachTask', T3, 'plan_parse_error')],
      expected: [
        { task_kind: 'CoachTask', error_count: 1, recent_error_messages: ['plan_parse_error'] },
      ],
    },
    {
      name: 'single transient error stays silent',
      rows: [err('QuizGenTask', T3, 'boom')],
      scans: [] as DegradedScanRow[],
      expected: [],
    },
    {
      name: 'two errors still flag at the threshold',
      rows: [err('QuizGenTask', T1, 'a'), err('QuizGenTask', T2, 'b')],
      scans: [] as DegradedScanRow[],
      expected: [{ task_kind: 'QuizGenTask', error_count: 2, recent_error_messages: ['b', 'a'] }],
    },
    {
      name: 'same-kind error and scan merge newest-first',
      rows: [err('CoachTask', T1, 'timeout')],
      scans: [scan('CoachTask', T2, 'plan_parse_error')],
      expected: [
        {
          task_kind: 'CoachTask',
          error_count: 2,
          recent_error_messages: ['plan_parse_error', 'timeout'],
        },
      ],
    },
    {
      name: 'null reason keeps the scan placeholder',
      rows: [] as RunErrorRow[],
      scans: [scan('CoachTask', T2, null)],
      expected: [
        {
          task_kind: 'CoachTask',
          error_count: 1,
          recent_error_messages: [DEGRADED_SCAN_NO_REASON_PLACEHOLDER],
        },
      ],
    },
    {
      name: 'kinds stay apart',
      rows: [err('DreamingTask', T1, 'x'), err('DreamingTask', T2, 'y')],
      scans: [scan('CoachTask', T3, 'plan_parse_error')],
      expected: [
        { task_kind: 'CoachTask', error_count: 1, recent_error_messages: ['plan_parse_error'] },
        { task_kind: 'DreamingTask', error_count: 2, recent_error_messages: ['y', 'x'] },
      ],
    },
  ])('$name', ({ rows, scans, expected }) => {
    expect(computeDegradedKinds(rows, scans)).toEqual(expected);
  });
});
