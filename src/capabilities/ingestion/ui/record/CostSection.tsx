import { useId } from 'react';
import { Button } from '@/ui-next/public';
import type { Recording } from './recording-model';
import './record-cost.css';

type CostEvidence = NonNullable<Recording['cost']['evidence']>;

const MISSING = {
  outside_agent_scope: '单独跑的处理和后续入库的费用没有算在内。',
  no_budget: '这次的处理记录还没对上，算不出金额。',
  no_durable_identities: '这次的处理记录还没对上，算不出金额。',
  historical_ocr_attribution_unproven: '以前的文字识别费用，算不清是否属于这次。',
} satisfies Record<CostEvidence['missing'][number], string>;

const UNSETTLED = {
  missing_task_run: '这一步的记录没找到。',
  task_in_progress: '还在处理中，费用可能没算全。',
  missing_attempt_binding: '文字识别的费用还没对上。',
  missing_canonical_cost: '这一步的费用还没找到。',
  unknown_cost_basis: '不确定这笔费用是怎么算的。',
  missing_amount: '金额还没记下来。',
  missing_cost_reference: '这笔费用还没有依据。',
  unknown_currency: '不确定币种，没有算进小计。',
} satisfies Record<CostEvidence['unsettled'][number]['reasons'][number], string>;

const BASIS = { reported: '已报告', estimated: '估计', unknown: '依据未知' };
const KIND = { agent_task: '助手处理', ocr: '文字识别' };

// Preserve a real zero and arbitrarily small nonzero evidence without currency rounding.
const amount = (value: number | null) => (value === null ? '金额未知' : String(value));

export function CostSection({
  cost,
  refreshing,
  onRefresh,
}: {
  cost: Recording['cost'];
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const titleId = useId();
  const evidence = cost.evidence;
  return (
    <section className="rc-cost" data-ui-next data-un-m3e="record-cost" aria-labelledby={titleId}>
      <header className="rc-cost-heading">
        <h3 id={titleId}>费用记录</h3>
        <Button variant="quiet" size="sm" onClick={onRefresh} disabled={refreshing}>
          刷新记录
        </Button>
      </header>
      <p className="rc-cost-status" role="status">
        {cost.state === 'loading'
          ? '正在读取费用记录。'
          : refreshing
            ? evidence
              ? '正在刷新；下面还是刚才算到的金额。'
              : '正在重新读取费用记录，金额尚未确认。'
            : cost.state === 'stale'
              ? '最新的费用读不出来，下面是上次算到的。'
              : cost.state === 'failed'
                ? '费用记录暂时读取失败，无法确认金额。'
                : cost.state === 'unavailable'
                  ? '这次没有费用信息，算不出金额。'
                  : evidence?.by_currency.some((entry) => entry.known_subtotal !== null)
                    ? '费用还没算全，下面是已知的部分。'
                    : '这次的费用暂时算不出来，这不表示没有花钱。'}
      </p>
      {evidence && (
        <>
          {evidence.by_currency.length > 0 && (
            <p className="rc-cost-note">
              只列能确认属于这次录入的费用，不是完整账单。已报告、估计和历史依据分开列，不代表实际扣款。
            </p>
          )}
          {evidence.by_currency.length > 0 && (
            <p className="rc-cost-note">
              算到：
              <time dateTime={evidence.as_of}>
                {new Date(evidence.as_of).toLocaleString('zh-CN', {
                  timeZone: 'UTC',
                  timeZoneName: 'short',
                })}
              </time>
            </p>
          )}
          <div className="rc-cost-currencies">
            {evidence.by_currency.map((entry) => (
              <section className="rc-cost-currency" key={entry.currency}>
                <h4>{entry.currency}</h4>
                <dl className="rc-cost-subtotal">
                  <dt>已知小计</dt>
                  <dd>{amount(entry.known_subtotal)}</dd>
                </dl>
                <dl className="rc-cost-bases">
                  <div>
                    <dt>已报告</dt>
                    <dd>{amount(entry.reported)}</dd>
                  </div>
                  <div>
                    <dt>估计</dt>
                    <dd>{amount(entry.estimated)}</dd>
                  </div>
                  <div>
                    <dt>历史依据未分类</dt>
                    <dd>{amount(entry.legacy)}</dd>
                  </div>
                </dl>
              </section>
            ))}
          </div>
          {evidence.by_currency.length > 0 && (
            <p className="rc-cost-note">小计已经包含这几类金额，不用再相加；不同币种不合计。</p>
          )}
          {evidence.missing.length > 0 && (
            <div className="rc-cost-gaps">
              <h4>为什么算不全</h4>
              <ul>
                {[...new Set(evidence.missing.map((reason) => MISSING[reason]))].map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          {evidence.unsettled.length > 0 && (
            <details>
              <summary>还没对上的费用</summary>
              <ol className="rc-cost-records">
                {evidence.unsettled.map((entry) => (
                  <li key={JSON.stringify(entry)}>
                    <h5>{KIND[entry.kind]}</h5>
                    <ul>
                      {entry.reasons.map((reason) => (
                        <li key={reason}>{UNSETTLED[reason]}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            </details>
          )}
          <details>
            <summary>查看费用依据</summary>
            {evidence.records.length === 0 && <p>还没有能确认的金额，这不表示没有花钱。</p>}
            <ol className="rc-cost-records">
              {evidence.records.map((entry) => (
                <li key={JSON.stringify(entry)}>
                  <h5>
                    {KIND[entry.kind]} · {entry.provider}
                  </h5>
                  <p className="rc-cost-record-amount">
                    {amount(entry.amount)} · {entry.currency}
                  </p>
                  <dl>
                    <dt>金额依据</dt>
                    <dd>
                      {entry.entry_kind === 'legacy'
                        ? '历史依据未分类'
                        : BASIS[entry.cost_basis ?? 'unknown']}
                    </dd>
                    <dt>模型</dt>
                    <dd>{entry.model ?? '未记录'}</dd>
                    <dt>记录来源</dt>
                    <dd>{entry.source === 'cost_ledger' ? '费用账目' : '调用记录'}</dd>
                  </dl>
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
    </section>
  );
}
