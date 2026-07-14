import { describe, expect, it } from 'vitest';

import { classifyCoverageScanState, coverageScanStateLabel } from './coverage-lattice';
import { failedWindowNote, shortErrorSummary, timelineTone } from './observability';

describe('observability truth states (YUK-623)', () => {
  it('never classifies an empty active-goal scope as healthy', () => {
    const state = classifyCoverageScanState({
      activeKcs: 0,
      totalGaps: 0,
      isFetching: false,
      isError: false,
    });

    expect(state).toBe('unscanned');
    expect(coverageScanStateLabel(state)).toBe('not scanned');
  });

  it.each([
    [{ activeKcs: 0, totalGaps: 0, isFetching: true, isError: false }, 'scanning'],
    [{ activeKcs: 3, totalGaps: 0, isFetching: false, isError: true }, 'failed'],
    [{ activeKcs: 3, totalGaps: 0, isFetching: false, isError: false }, 'healthy'],
    [{ activeKcs: 3, totalGaps: 2, isFetching: false, isError: false }, 'degraded'],
  ] as const)('classifies %o as %s', (input, expected) => {
    expect(classifyCoverageScanState(input)).toBe(expected);
  });

  it('marks failed terminal events as errors instead of green completions', () => {
    expect(timelineTone({ type: 'run_finished', label: 'failure', outcome: 'error' })).toBe(
      'again',
    );
    expect(timelineTone({ type: 'run_finished', label: 'failure', outcome: 'tool_error' })).toBe(
      'again',
    );
    expect(timelineTone({ type: 'run_finished', label: 'success', outcome: 'end_turn' })).toBe(
      'good',
    );
  });

  it('normalizes and bounds the copyable error summary', () => {
    expect(shortErrorSummary('  Provider\n timeout   after 30s  ', 24)).toBe(
      'Provider timeout after …',
    );
    expect(shortErrorSummary('   ')).toBeNull();
  });

  it('labels failure counts as a bounded window, not all-time totals', () => {
    expect(failedWindowNote(95, 100, 520)).toBe('95 / 100 in current window · 520 total runs');
  });
});
