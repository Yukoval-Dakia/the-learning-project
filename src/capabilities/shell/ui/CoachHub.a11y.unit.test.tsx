// @vitest-environment jsdom

import type { CalibrationMaturityResponse } from '@/capabilities/onboarding/ui/recompute/calibration-maturity-api';
import type { EffectivenessTrendResponse } from '@/capabilities/shell/ui/effectiveness-trend-api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { CoachCalibrationView } from './CoachCalibrationView';
import CoachHub from './CoachHub';

afterEach(cleanup);

const emptyTrend: EffectivenessTrendResponse = {
  series: [],
  subject_roots: [],
  aggregate: { total_kcs_with_activity: 0, total_events: 0, by_subject: [] },
  metadata: {
    as_of: '2026-07-23T00:00:00.000Z',
    window_start: '2026-06-23T16:00:00.000Z',
    window_end: '2026-07-23T16:00:00.000Z',
    timezone: 'Asia/Shanghai',
    granularity: 'calendar_day',
    notable_limit: 6,
    eligible: 0,
    returned: 0,
    truncated: false,
  },
};

function queryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(['effectiveness-trend'], emptyTrend);
  return client;
}

function maturity(blindCount = 8, diagnosedCount = 2): CalibrationMaturityResponse {
  const blind = Array.from({ length: blindCount }, (_, index) => ({
    knowledge_id: `blind-${index}`,
    name: `尚未练习的知识点 ${index + 1}`,
    evidence_count: 0,
    theta_se: null,
    confidence: null,
    track: null,
    cold_start: true,
  }));
  const diagnosed = Array.from({ length: diagnosedCount }, (_, index) => ({
    knowledge_id: `diagnosed-${index}`,
    name: `有证据的知识点 ${index + 1}`,
    evidence_count: index === 0 ? 2 : 8,
    theta_se: index === 0 ? 0.8 : 0.3,
    confidence: index === 0 ? null : 0.9,
    track: null,
    cold_start: index === 0,
  }));
  const theta = diagnosed.map((row) => row.theta_se as number).sort((a, b) => a - b);
  const median = theta.length === 0 ? null : theta[Math.floor((theta.length - 1) / 2)];
  const rows = [...blind, ...diagnosed];
  const firmCount = diagnosed.filter((row) => !row.cold_start).length;
  return {
    rows,
    aggregate: {
      total_kcs: rows.length,
      cold_start_count: rows.filter((row) => row.cold_start).length,
      firm_count: firmCount,
      pct_firm: rows.length === 0 ? 0 : firmCount / rows.length,
      median_theta_se: median,
    },
  };
}

describe('CoachHub three-view tabs', () => {
  it('uses roving tabindex + tabpanel semantics and supports arrows/Home/End', async () => {
    const client = queryClient();
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={client}>
        <CoachHub navigate={() => {}} />
      </QueryClientProvider>,
    );

    const tablist = screen.getByRole('tablist', { name: '复盘视图' });
    const activity = within(tablist).getByRole('tab', { name: '活动量' });
    const calibration = within(tablist).getByRole('tab', { name: '校准诊断' });
    const efficacy = within(tablist).getByRole('tab', { name: '成效趋势' });
    expect(efficacy.getAttribute('tabindex')).toBe('0');
    expect(activity.getAttribute('tabindex')).toBe('-1');
    expect(screen.getByRole('tabpanel', { name: '成效趋势' })).toBeTruthy();

    efficacy.focus();
    await user.keyboard('{ArrowLeft}');
    expect(calibration.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(calibration);
    expect(screen.getByRole('tabpanel', { name: '校准诊断' })).toBeTruthy();

    await user.keyboard('{Home}');
    expect(activity.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(activity);

    await user.keyboard('{End}');
    expect(efficacy.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(efficacy);

    await user.keyboard('{ArrowRight}');
    expect(activity.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(activity);
  });
});

describe('Coach calibration evidence semantics', () => {
  it('caps blind chips, excludes zero-evidence rows from the diagnosed table, and exposes sort state', async () => {
    const client = queryClient();
    client.setQueryData(['calibration-maturity'], maturity());
    const user = userEvent.setup();
    const { container } = render(
      <QueryClientProvider client={client}>
        <CoachCalibrationView navigate={() => {}} />
      </QueryClientProvider>,
    );

    expect(container.querySelectorAll('.cal-blind-chip')).toHaveLength(6);
    expect(screen.getByText('2 个知识点 · 可按表头排序')).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + 2 diagnosed rows
    expect(screen.queryByRole('row', { name: /尚未练习的知识点/ })).toBeNull();
    expect(screen.getByRole('region', { name: '有作答记录的知识点表格，可横向滚动' })).toBeTruthy();

    const reliability = screen.getByRole('columnheader', { name: '判断可靠度 ↑' });
    expect(reliability.getAttribute('aria-sort')).toBe('ascending');
    await user.click(screen.getByRole('button', { name: '证据' }));
    expect(screen.getByRole('columnheader', { name: '证据 ↓' }).getAttribute('aria-sort')).toBe(
      'descending',
    );

    await user.click(screen.getByRole('button', { name: '显示全部 8 个盲区' }));
    expect(container.querySelectorAll('.cal-blind-chip')).toHaveLength(8);
    expect(screen.getByRole('button', { name: '收起盲区列表' })).toBeTruthy();
  });

  it('renders an honest empty diagnosed state when every row has zero evidence', () => {
    const client = queryClient();
    client.setQueryData(['calibration-maturity'], maturity(4, 0));
    render(
      <QueryClientProvider client={client}>
        <CoachCalibrationView navigate={() => {}} />
      </QueryClientProvider>,
    );

    expect(screen.getByText('0 个知识点 · 可按表头排序')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('还没有带作答证据的知识点；上面的盲区不冒充已诊断结果。')).toBeTruthy();
  });
});
