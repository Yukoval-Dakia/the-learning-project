// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { OvernightCostSummary } from './OvernightCostSummary';
import type { OvernightDigest } from './workbench-api';

type Cost = OvernightDigest['cost'];
const window = { from: '2026-10-04T16:00:00.000Z', to: '2026-10-05T16:00:00.000Z' };
const detail: Cost['details'][number] = {
  provider: 'provider-with-long-name',
  model: 'model/long-version',
  lane_id: 'subscription',
  task_kind: 'CoachTask',
  source: 'provider_attempt',
  entry_kind: 'attempt',
  cost_basis: 'reported',
  cost_ref: null,
  currency: 'USD',
  amount: 0,
  records: 2,
  wire_calls: 1,
  unknown_wire_records: 1,
  usage_basis: 'reported',
  usage_unit: 'tokens',
  usage_source: 'provider-response',
  usage_input: 12000,
  usage_output: null,
  usage_total: 12000,
  missing_input_records: 1,
  missing_output_records: 2,
  missing_total_records: 1,
};
const bucket: Cost['by_currency'][number] = {
  currency: 'USD',
  cost: 0,
  reported_cost: 0,
  estimated_cost: 0,
  legacy_cost: 0,
  reported_attempts: 2,
  estimated_attempts: 0,
  legacy_rows: 0,
  unknown_attempts: 1,
};
const cost: Cost = {
  scope: 'all_activity',
  records: 3,
  by_currency: [bucket],
  details: [
    detail,
    {
      ...detail,
      lane_id: null,
      model: null,
      cost_basis: 'unknown',
      amount: null,
      records: 1,
      wire_calls: null,
      unknown_wire_records: 1,
      usage_basis: 'unknown',
      usage_unit: null,
      usage_source: null,
      usage_input: null,
      usage_output: null,
      usage_total: null,
      missing_input_records: 1,
      missing_output_records: 1,
      missing_total_records: 1,
    },
  ],
};

afterEach(cleanup);
async function open(data: Cost = cost) {
  render(<OvernightCostSummary cost={data} window={window} />);
  await userEvent.click(screen.getByRole('button', { name: '昨日 AI 用量与费用' }));
}

describe('Yesterday cost disclosure', () => {
  it('starts collapsed and supports keyboard expansion and collapse', async () => {
    const user = userEvent.setup();
    render(<OvernightCostSummary cost={cost} window={window} />);
    const button = screen.getByRole('button', { name: '昨日 AI 用量与费用' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('list', { name: '费用与用量明细' })).toBeNull();
    await user.tab();
    expect(document.activeElement).toBe(button);
    await user.keyboard('{Enter}');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('list', { name: '费用与用量明细' })).toBeTruthy();
    await user.keyboard(' ');
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('uses fixed Beijing dates and explicitly includes foreground and background', async () => {
    await open();
    expect(screen.getByText(/北京时间 2026\/10\/05 00:00 至 2026\/10\/06 00:00/)).toBeTruthy();
    expect(screen.getByText(/不含结束时刻.*包含前台与后台活动/)).toBeTruthy();
  });

  it('distinguishes missing records from a reported zero', async () => {
    await open({ scope: 'all_activity', records: 0, by_currency: [], details: [] });
    expect(screen.getByText('昨日暂无费用记录，不代表实际费用为零。')).toBeTruthy();
    expect(screen.queryByText(/已报告：USD 0/)).toBeNull();
  });

  it('preserves reported zero alongside unknown amounts and partial usage', async () => {
    await open();
    expect(screen.getByText('已报告：USD 0 · 2 条记录')).toBeTruthy();
    expect(screen.getByText('费用未知：1 条记录')).toBeTruthy();
    const list = screen.getByRole('list', { name: '费用与用量明细' });
    expect(within(list).getByText(/通道：subscription/)).toBeTruthy();
    expect(within(list).getAllByText('12,000（已知小计，另 1 条记录缺失）')).toHaveLength(2);
    expect(within(list).getByText('未知（2 条记录缺失）')).toBeTruthy();
    expect(within(list).getByText('已知实际请求数：1；另 1 条记录的请求数未知')).toBeTruthy();
    expect(screen.getByText('3 条费用记录；记录数不等于实际请求数。')).toBeTruthy();
    expect(screen.getByText('用量：未知 · 单位：未知')).toBeTruthy();
  });

  it('keeps currencies and estimated/historical evidence separate, even for tiny costs', async () => {
    await open({
      ...cost,
      records: 4,
      by_currency: [
        {
          ...bucket,
          reported_attempts: 0,
          unknown_attempts: 0,
          estimated_attempts: 1,
          estimated_cost: 0.0000000123,
          cost: 0.0000000123,
        },
        {
          ...bucket,
          currency: 'CNY',
          reported_attempts: 0,
          unknown_attempts: 0,
          legacy_rows: 3,
          legacy_cost: 2.5,
          cost: 2.5,
        },
      ],
      details: [
        {
          ...detail,
          cost_basis: 'estimated',
          amount: 0.0000000123,
          records: 1,
          wire_calls: 1,
          unknown_wire_records: 0,
          usage_input: 12,
          usage_output: 2,
          usage_total: 14,
          missing_input_records: 0,
          missing_output_records: 0,
          missing_total_records: 0,
        },
        {
          ...detail,
          entry_kind: 'legacy',
          records: 3,
          wire_calls: null,
          unknown_wire_records: 3,
          source: 'cost_ledger',
          currency: 'CNY',
          amount: 2.5,
          cost_basis: null,
          lane_id: null,
          usage_basis: 'unclassified',
        },
      ],
    });
    expect(screen.getByText('估算：USD 0.0000000123 · 1 条记录')).toBeTruthy();
    expect(screen.getAllByText('历史口径：CNY 2.5 · 3 条记录')).toHaveLength(2);
    expect(screen.getByText(/估算不是账单，也不代表订阅额度扣减/)).toBeTruthy();
    expect(screen.queryByText(/2\.5000000123/)).toBeNull();
  });

  it('does not invent zero for unknown-only currency or convert non-token units', async () => {
    await open({
      ...cost,
      records: 2,
      by_currency: [{ ...bucket, currency: 'XXX', reported_attempts: 0, unknown_attempts: 2 }],
      details: [
        {
          ...detail,
          currency: 'XXX',
          amount: null,
          cost_basis: 'unknown',
          model: null,
          lane_id: null,
          usage_unit: 'seconds',
          usage_input: 0,
          missing_input_records: 0,
          wire_calls: null,
          unknown_wire_records: 2,
        },
      ],
    });
    expect(screen.getByText('币种未明')).toBeTruthy();
    expect(screen.queryByText(/币种未明 0/)).toBeNull();
    expect(screen.getByText(/未知费用：金额未知/)).toBeTruthy();
    expect(screen.getByText('用量：已报告 · 单位：seconds')).toBeTruthy();
    expect(screen.getByText('0')).toBeTruthy();
    expect(screen.getByText(/模型未知/)).toBeTruthy();
    expect(screen.getByText(/已知实际请求数：未知/)).toBeTruthy();
  });
});
