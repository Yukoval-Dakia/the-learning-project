// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RcMaturityBadge, RcVerify } from './RecomputeComponents';
import type { RcMaturitySummary, RcSummary } from './recompute-core';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const summary: RcSummary = {
  overall: 'match',
  verdicts: [],
  testedCount: 0,
  driftCount: 0,
};

const maturitySummary: RcMaturitySummary = {
  overall: 'match',
  dFirm: 0,
  sFirm: 0,
  dMedian: null,
  sMedian: null,
  total: 0,
};

describe('recompute rerun controls', () => {
  it('names the profile action precisely when it is available', () => {
    render(
      <RcVerify
        state="match"
        summary={summary}
        detailOpen={false}
        onToggleDetail={vi.fn()}
        onRerun={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '重新核对学习画像' }).hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('disables and announces the profile action while verification is running', () => {
    render(
      <RcVerify
        state="running"
        summary={summary}
        detailOpen={false}
        onToggleDetail={vi.fn()}
        onRerun={vi.fn()}
      />,
    );

    expect(screen.getByText('正在核对学习画像…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /重新核对学习画像/ })).toBeNull();
  });

  it('gives the maturity action its own accessible name and prevents an initial retrigger', () => {
    vi.useFakeTimers();
    render(<RcMaturityBadge summary={maturitySummary} />);

    expect(
      screen.getByRole('button', { name: '正在重新核对判断可靠度' }).hasAttribute('disabled'),
    ).toBe(true);

    act(() => vi.advanceTimersByTime(540));

    expect(
      screen.getByRole('button', { name: '重新核对判断可靠度' }).hasAttribute('disabled'),
    ).toBe(false);
  });
});
