import { useId, useState } from 'react';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import type { OvernightDigest } from './workbench-api';

type CostDetail = OvernightDigest['cost']['details'][number];

const quantity = new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 10 });
const dateTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const usageLabels = {
  reported: '已报告',
  estimated: '估算',
  unknown: '未知',
  unclassified: '未分类',
} satisfies Record<CostDetail['usage_basis'], string>;

function currencyLabel(currency: string): string {
  return currency === 'XXX' ? '币种未明' : currency;
}

function amount(value: number | null, currency: string): string {
  if (value === null) return '金额未知';
  return `${currencyLabel(currency)} ${quantity.format(value)}`;
}

function costBasis(detail: CostDetail): string {
  if (detail.entry_kind === 'legacy') return '历史口径';
  if (detail.cost_basis === null) return '费用口径未知';
  return `${usageLabels[detail.cost_basis]}费用`;
}

function usage(value: number | null, missing: number): string {
  if (value === null) return `未知（${missing} 条记录缺失）`;
  const known = quantity.format(value);
  return missing > 0 ? `${known}（已知小计，另 ${missing} 条记录缺失）` : known;
}

function CostDetailRow({ detail }: { detail: CostDetail }) {
  return (
    <li className="overnight-cost-detail">
      <div className="overnight-cost-provider">
        {detail.provider} · {detail.model ?? '模型未知'}
      </div>
      <p>
        通道：{detail.lane_id ?? '未知'} · 任务：{detail.task_kind}
      </p>
      <p>
        {costBasis(detail)}：{amount(detail.amount, detail.currency)} · {detail.records} 条记录
      </p>
      <p>
        用量：{usageLabels[detail.usage_basis]} · 单位：{detail.usage_unit ?? '未知'}
      </p>
      <dl className="overnight-cost-usage">
        <div>
          <dt>输入</dt>
          <dd>{usage(detail.usage_input, detail.missing_input_records)}</dd>
        </div>
        <div>
          <dt>输出</dt>
          <dd>{usage(detail.usage_output, detail.missing_output_records)}</dd>
        </div>
        <div>
          <dt>合计</dt>
          <dd>{usage(detail.usage_total, detail.missing_total_records)}</dd>
        </div>
      </dl>
      <p>
        已知实际请求数：{detail.wire_calls === null ? '未知' : quantity.format(detail.wire_calls)}
        {detail.unknown_wire_records > 0 &&
          `；另 ${detail.unknown_wire_records} 条记录的请求数未知`}
      </p>
      <p>
        记录来源：{detail.source === 'provider_attempt' ? '模型调用记录' : '费用账本'}
        {detail.usage_source && ` · 用量来源：${detail.usage_source}`}
      </p>
    </li>
  );
}

export function OvernightCostSummary({ cost, window }: Pick<OvernightDigest, 'cost' | 'window'>) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <section className="overnight-cost" aria-label="昨日 AI 用量与费用">
      <button
        type="button"
        className={`chip chip-toggle${open ? ' is-open' : ''}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        昨日 AI 用量与费用
        <LoomIcon name="chevronDown" size={13} className="pd-chev" />
      </button>
      <div id={panelId} hidden={!open} className="prep-desk-expand">
        <p>
          北京时间 {dateTime.format(new Date(window.from))} 至{' '}
          {dateTime.format(new Date(window.to))}
          （不含结束时刻），包含前台与后台活动。
        </p>
        {cost.records === 0 ? (
          <p className="quiet-empty">昨日暂无费用记录，不代表实际费用为零。</p>
        ) : (
          <>
            <p>{cost.records} 条费用记录；记录数不等于实际请求数。</p>
            <ul className="overnight-cost-currencies">
              {cost.by_currency.map((row) => (
                <li key={row.currency}>
                  <strong>{currencyLabel(row.currency)}</strong>
                  <ul>
                    {row.reported_attempts > 0 && (
                      <li>
                        已报告：{amount(row.reported_cost, row.currency)} · {row.reported_attempts}{' '}
                        条记录
                      </li>
                    )}
                    {row.estimated_attempts > 0 && (
                      <li>
                        估算：{amount(row.estimated_cost, row.currency)} · {row.estimated_attempts}{' '}
                        条记录
                      </li>
                    )}
                    {row.legacy_rows > 0 && (
                      <li>
                        历史口径：{amount(row.legacy_cost, row.currency)} · {row.legacy_rows} 条记录
                      </li>
                    )}
                    {row.unknown_attempts > 0 && <li>费用未知：{row.unknown_attempts} 条记录</li>}
                  </ul>
                </li>
              ))}
            </ul>
            <p>金额按币种分别列出，已知金额不含未知费用；估算不是账单，也不代表订阅额度扣减。</p>
            <ul className="overnight-cost-details" aria-label="费用与用量明细">
              {cost.details.map((detail) => (
                <CostDetailRow
                  key={JSON.stringify([
                    detail.provider,
                    detail.model,
                    detail.lane_id,
                    detail.task_kind,
                    detail.source,
                    detail.entry_kind,
                    detail.cost_basis,
                    detail.cost_ref,
                    detail.currency,
                    detail.usage_basis,
                    detail.usage_unit,
                    detail.usage_source,
                  ])}
                  detail={detail}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
