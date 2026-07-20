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

describe('maturity drift detail', () => {
  function renderSettledDrift(overrides: Partial<RcMaturitySummary>) {
    vi.useFakeTimers();
    render(
      <RcMaturityBadge
        summary={{
          ...maturitySummary,
          overall: 'drift',
          dFirm: 2,
          sFirm: 2,
          dMedian: 0.4,
          sMedian: 0.4,
          ...overrides,
        }}
      />,
    );
    act(() => vi.advanceTimersByTime(540));
  }

  it('reports a firm-only mismatch and its two values', () => {
    renderSettledDrift({ sFirm: 3 });

    expect(screen.getByText(/概览有/).textContent).toContain('1');
    expect(screen.getByText(/较可信知识点：当前概览/).textContent).toContain('3 · 重新核对 2');
    expect(screen.queryByText(/整体判断稳定度：当前概览/)).toBeNull();
  });

  it('reports a median-only mismatch instead of showing equal firm counts', () => {
    renderSettledDrift({ sMedian: 0.5 });

    expect(screen.getByText(/概览有/).textContent).toContain('1');
    expect(screen.queryByText(/较可信知识点：当前概览/)).toBeNull();
    expect(screen.getByText(/整体判断稳定度：当前概览/).textContent).toContain(
      '0.50 · 重新核对 0.40',
    );
  });

  it('counts and renders both mismatch dimensions', () => {
    renderSettledDrift({ sFirm: 3, sMedian: null });

    expect(screen.getByText(/概览有/).textContent).toContain('2');
    expect(screen.getByText(/较可信知识点：当前概览/)).toBeTruthy();
    expect(screen.getByText(/整体判断稳定度：当前概览/).textContent).toContain(
      '暂无 · 重新核对 0.40',
    );
  });
});
