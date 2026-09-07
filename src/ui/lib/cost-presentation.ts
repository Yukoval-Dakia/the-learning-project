import type { ApiOperationJsonResponse } from './api';

type CostBucket = ApiOperationJsonResponse<'getTodayCost'>['today']['by_currency'][number];

function money(value: number, currency: string, precision: number): string {
  const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : `${currency} `;
  const smallest = 10 ** -precision;
  if (value > 0 && value < smallest / 2) return `<${symbol}${smallest.toFixed(precision)}`;
  return `${symbol}${value.toFixed(precision)}`;
}

/** Same truth vocabulary for Today, admin totals, days and tasks; never sum currencies. */
export function describeCosts(
  rows: readonly CostBucket[],
  precision: 2 | 4 = 2,
): { amount: string; note: string } {
  if (rows.length === 0) return { amount: '暂无费用记录', note: '当前窗口没有费用记录' };
  const buckets = new Map<string, CostBucket>();
  for (const row of rows) {
    const previous = buckets.get(row.currency);
    buckets.set(
      row.currency,
      previous
        ? {
            currency: row.currency,
            cost: previous.cost + row.cost,
            reported_cost: previous.reported_cost + row.reported_cost,
            estimated_cost: previous.estimated_cost + row.estimated_cost,
            legacy_cost: previous.legacy_cost + row.legacy_cost,
            unknown_attempts: previous.unknown_attempts + row.unknown_attempts,
            legacy_rows: previous.legacy_rows + row.legacy_rows,
          }
        : { ...row },
    );
  }
  const amounts: string[] = [];
  const notes: string[] = [];
  for (const row of buckets.values()) {
    const unknownOnly = row.cost === 0 && row.unknown_attempts > 0;
    amounts.push(
      unknownOnly
        ? `${row.currency === 'XXX' ? '币种未明' : row.currency} 费用未知`
        : `${money(row.cost, row.currency, precision)}${row.unknown_attempts > 0 ? ' + 未知' : ''}`,
    );
    const parts: string[] = [];
    if (row.reported_cost > 0)
      parts.push(`已报告 ${money(row.reported_cost, row.currency, precision)}`);
    if (row.estimated_cost > 0)
      parts.push(`估算 ${money(row.estimated_cost, row.currency, precision)}`);
    if (row.legacy_rows > 0)
      parts.push(
        `历史口径 ${money(row.legacy_cost, row.currency, precision)}（${row.legacy_rows} 条）`,
      );
    if (row.unknown_attempts > 0) parts.push(`${row.unknown_attempts} 次费用未知`);
    if (parts.length === 0)
      parts.push(
        row.cost === 0 ? `${row.currency} 已知金额为零` : `${row.currency} 金额口径未分类`,
      );
    notes.push(parts.join(' · '));
  }
  return { amount: amounts.join(' · '), note: `已知小计不含未知费用；${notes.join('；')}` };
}
