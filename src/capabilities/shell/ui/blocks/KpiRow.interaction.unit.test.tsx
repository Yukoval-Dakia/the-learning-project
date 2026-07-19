// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KpiRow } from './KpiRow';

afterEach(cleanup);

const KPI_PROPS = {
  kpi: { due_count: 12, pending_attribution_count: 3, knowledge_count: 27 },
  proposalsDecisionTotal: 4,
  proposalsHasMore: false,
} as const;

describe('KpiRow keyboard activation (YUK-718)', () => {
  it('activates a card on Space and prevents the default page scroll', () => {
    const navigate = vi.fn();
    render(<KpiRow {...KPI_PROPS} navigate={navigate} />);
    const card = screen.getByRole('button', { name: /今日到期\s*12/ });
    const notPrevented = fireEvent.keyDown(card, { key: ' ' });
    expect(navigate).toHaveBeenCalledWith('/practice');
    expect(notPrevented).toBe(false); // dispatchEvent returns false ⇒ preventDefault fired
  });

  it('still activates a card on Enter', () => {
    const navigate = vi.fn();
    render(<KpiRow {...KPI_PROPS} navigate={navigate} />);
    fireEvent.keyDown(screen.getByRole('button', { name: /知识节点\s*27/ }), { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith('/knowledge');
  });
});

describe('KpiRow fact values', () => {
  it('renders every authoritative value on the first frame', () => {
    render(
      <KpiRow
        kpi={{ due_count: 12, pending_attribution_count: 3, knowledge_count: 27 }}
        proposalsDecisionTotal={4}
        proposalsHasMore={false}
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
        proposalsHasMore={false}
        navigate={navigate}
      />,
    );

    rerender(
      <KpiRow
        kpi={{ due_count: 7, pending_attribution_count: 3, knowledge_count: 27 }}
        proposalsDecisionTotal={4}
        proposalsHasMore={false}
        navigate={navigate}
      />,
    );

    expect(screen.getByRole('button', { name: /今日到期\s*7/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /今日到期\s*12/ })).toBeNull();
  });

  it('does not present a truncated lower bound as an exact zero', () => {
    render(
      <KpiRow
        kpi={{ due_count: 0, pending_attribution_count: 0, knowledge_count: 0 }}
        proposalsDecisionTotal={0}
        proposalsHasMore
        navigate={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /AI 提议\s*\?/ })).toBeTruthy();
    expect(screen.getByText('扫描已达上限，可能仍有待审')).toBeTruthy();
  });
});
