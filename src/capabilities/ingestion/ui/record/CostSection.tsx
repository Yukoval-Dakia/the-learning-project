import { useId } from 'react';
import { Button } from '@/ui-next/public';
import type { Recording } from './recording-model';
import './record-cost.css';

type CostEvidence = NonNullable<Recording['cost']['evidence']>;

const MISSING = {
  outside_agent_scope: '不包含所有独立调用和后续入库处理的费用。',
  no_budget: '缺少可关联的预算记录，无法据此确定费用。',
  no_durable_identities: '没有找到可归属的任务记录，不能据此判断是否发生过调用。',
  historical_ocr_attribution_unproven: '历史文字识别费用尚不能确认属于这次录入。',
} satisfies Record<CostEvidence['missing'][number], string>;

const UNSETTLED = {
  missing_task_run: '实际任务记录缺失，无法确认执行情况。',
  task_in_progress: '任务仍在处理中或尚未确认结束，费用可能尚未齐全。',
  missing_attempt_binding: '文字识别记录尚未关联到实际调用。',
  missing_canonical_cost: '尚未找到这项记录对应的费用凭据。',
  unknown_cost_basis: '费用依据尚不明确。',
  missing_amount: '金额尚未记录。',
  missing_cost_reference: '缺少费用依据的引用。',
  unknown_currency: '币种尚不明确，无法计入某个币种的小计。',
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
              ? '正在刷新；已有金额仍属于下方标注的快照。'
              : '正在重新读取费用记录，金额尚未确认。'
            : cost.state === 'stale'
              ? '最新记录暂时读取失败。下方保留上次快照，不代表当前费用。'
              : cost.state === 'failed'
                ? '费用记录暂时读取失败，无法确认金额。'
                : cost.state === 'unavailable'
                  ? '这次返回的记录未提供费用信息，无法确认金额。'
                  : '仅覆盖部分费用，整次录入总额未知。'}
      </p>
      {evidence && (
        <>
          <p className="rc-cost-note">
            只展示有证据归属本次录入的处理费用，不是整次录入的账单。已报告、估计和历史依据分别列出，不代表精确实收。
          </p>
          <p className="rc-cost-note">
            费用快照：
            <time dateTime={evidence.as_of}>
              {new Date(evidence.as_of).toLocaleString('zh-CN', {
                timeZone: 'UTC',
                timeZoneName: 'short',
              })}
            </time>
            {' · '}整次录入总额：未知
          </p>
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
          {evidence.by_currency.length === 0 ? (
            <p>尚无可展示的币种小计；这不表示没有产生费用。</p>
          ) : (
            <p className="rc-cost-note">
              小计由服务端提供，已包含对应依据；三类金额不再与小计相加，币种之间不合计。
            </p>
          )}
          {evidence.missing.length > 0 && (
            <div className="rc-cost-gaps">
              <h4>尚不完整的部分</h4>
              <ul>
                {evidence.missing.map((reason) => (
                  <li key={reason}>{MISSING[reason]}</li>
                ))}
              </ul>
            </div>
          )}
          {evidence.unsettled.length > 0 && (
            <details>
              <summary>待核对的费用记录</summary>
              <p className="rc-cost-note">
                每项是一组尚缺证据的关联记录，不代表调用次数，也不表示可以重新发起处理。
              </p>
              <ol className="rc-cost-records">
                {evidence.unsettled.map((entry) => (
                  <li key={JSON.stringify(entry)}>
                    <h5>{KIND[entry.kind]}</h5>
                    <ul>
                      {entry.reasons.map((reason) => (
                        <li key={reason}>{UNSETTLED[reason]}</li>
                      ))}
                    </ul>
                    <p className="rc-cost-reference">任务记录：{entry.task_run_id}</p>
                  </li>
                ))}
              </ol>
            </details>
          )}
          <details>
            <summary>查看费用依据</summary>
            {evidence.records.length === 0 && <p>没有可展示的金额依据，不能据此判断为免费。</p>}
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
                    <dd>{entry.source === 'cost_ledger' ? '费用账目' : '服务调用记录'}</dd>
                    <dt>依据引用</dt>
                    <dd>{entry.cost_ref ?? '未记录'}</dd>
                    <dt>任务记录</dt>
                    <dd>{entry.task_run_id}</dd>
                    {entry.attempt_id !== null && (
                      <>
                        <dt>调用记录</dt>
                        <dd>{entry.attempt_id}</dd>
                      </>
                    )}
                    {entry.operation_id !== null && (
                      <>
                        <dt>操作记录</dt>
                        <dd>{entry.operation_id}</dd>
                      </>
                    )}
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
