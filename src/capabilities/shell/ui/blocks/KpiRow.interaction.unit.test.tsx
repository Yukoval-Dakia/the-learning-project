// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KpiRow } from './KpiRow';

afterEach(cleanup);

describe('KpiRow fact values', () => {
  it('renders every authoritative value on the first frame', () => {
    render(
      <KpiRow
        kpi={{ due_count: 12, pending_attribution_count: 3, knowledge_count: 27 }}
        proposalsDecisionTotal={4}
        navigate={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /今日到期\s*12/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /待归因\s*3/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /知识节点\s*27/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /AI 提议\s*4/ })).toBeTruthy();
  });

  it('replaces an updated value immediately without an intermediate integer', () => {
    const navigate = vi.fn();
    const { rerender } = render(
      <KpiRow
        kpi={{ due_count: 12, pending_attribution_count: 3, knowledge_count: 27 }}
        proposalsDecisionTotal={4}
        navigate={navigate}
      />,
    );

    rerender(
      <KpiRow
        kpi={{ due_count: 7, pending_attribution_count: 3, knowledge_count: 27 }}
        proposalsDecisionTotal={4}
        navigate={navigate}
      />,
    );

    expect(screen.getByRole('button', { name: /今日到期\s*7/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /今日到期\s*12/ })).toBeNull();
  });
});
