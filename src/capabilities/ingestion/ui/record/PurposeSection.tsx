import { CircleCheck, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from '@/ui-next/public';
import { usePurposeChange } from './purpose-change';
import type { PurposeImpact } from './record-api';
import './record-purpose.css';

const policyWords = {
  allow: '用于后续学习',
  answer_only: '仅用于本次回答',
  crisis: '系统限制用途（不可修改）',
};
const repairWords = {
  complete: '此项已完成',
  pending: '等待处理',
  failed: '此项失败',
  unknown: '结果未知',
};
const stopWords = { confirmed: '已确认停止', pending: '等待停止确认', unknown: '停止结果未知' };
// YUK-1751 — paid_effect states in learner words; an unexpected value reads 「未知」, never the code.
const paidStateWords: Record<string, string> = {
  pending: '等待发出',
  sending: '正在发出',
  unknown: '结果未知',
  receipt_ready: '已收到结果，待入账',
  applied: '已入账',
  voided: '已作废',
  cancelled: '已取消',
  not_claimed_or_unknown: '未记录或未知',
};
const sinkWords = {
  mem0: '长期记忆',
  brief: '学习摘要',
  brief_dispatch: '摘要重算派发',
  mem0_scan: '记忆范围扫描',
};

function ImpactDetails({ impact }: { impact: PurposeImpact }) {
  return (
    <div className="rc-purpose-impact">
      <section>
        <h4>停止确认</h4>
        {impact.stop.length ? (
          <ul>
            {impact.stop.map((row) => (
              <li key={`${row.session_id}:${row.run_ref}:${row.operation_id}`}>
                <strong>{stopWords[row.state]}</strong>
              </li>
            ))}
          </ul>
        ) : (
          <p>没有可展示的停止确认记录，不能据此认定外部请求已撤回。</p>
        )}
      </section>
      <section>
        <h4>清理与修复</h4>
        <dl>
          <dt>整体清理</dt>
          <dd>
            {impact.cleanup === 'pending_or_partial' ? '仍在处理或仅完成一部分' : '本次未请求清理'}
          </dd>
          <dt>长期记忆整体</dt>
          <dd>
            {impact.sinks.mem0 === 'pending_or_partial'
              ? '仍在处理或仅完成一部分'
              : '本次未请求清理'}
          </dd>
        </dl>
        <p className="rc-quiet">单项完成不代表全部副本已删除；未请求也不代表历史内容不存在。</p>
        {impact.repairs.length ? (
          <ul>
            {impact.repairs.map((row) => (
              <li key={`${row.operation_id}:${row.sink}:${row.source_id}`}>
                <div className="rc-purpose-line">
                  <strong>{sinkWords[row.sink]}</strong>
                  <span>{repairWords[row.state]}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p>尚无可展示的单项修复记录。</p>
        )}
        {impact.sinks.briefs.length > 0 && (
          <>
            <h5>学习摘要重算</h5>
            <ul>
              {impact.sinks.briefs.map((row) => (
                <li key={row.scope_key}>
                  <div className="rc-purpose-line">
                    <span>学习摘要</span>
                    <strong>{repairWords[row.state]}</strong>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      <section>
        <h4>题目准入与历史使用</h4>
        <p>
          来源用途检查已启用；
          {impact.admission.state === 'pending' ? '历史处理仍待确认。' : '历史处理结果未知。'}
        </p>
        <p className="rc-quiet">
          既有应用和费用状态属于历史记录，不能证明已撤销、未收费或允许再次执行。
        </p>
        {impact.admission.deliveries.length ? (
          <ul>
            {impact.admission.deliveries.map((row) => (
              <li key={`${row.job_id}:${row.usage_source_event_id}`}>
                <div className="rc-purpose-line">
                  <span>当时用途：{policyWords[row.source_policy]}</span>
                  <span>历史费用状态：{paidStateWords[row.paid_state] ?? '未知'}</span>
                </div>
                {/* The stored error is raw server text; the learner gets that it failed, not the text. */}
                {row.application_error && <p>这次处理没有成功应用。</p>}
              </li>
            ))}
          </ul>
        ) : (
          <p>没有可展示的准入记录，未归因的历史仍未知。</p>
        )}
      </section>
      <section>
        <h4>仍不能确认的范围</h4>
        <p>已经发出的外部请求可能无法撤回，也不能据此承诺没有产生费用。</p>
        <p>未归因历史、备份、跟踪记录、本地历史与外部副本的处理情况仍未知。</p>
      </section>
    </div>
  );
}

export function PurposeSection({ sessionId }: { sessionId: string }) {
  const p = usePurposeChange(sessionId);
  return (
    <details className="rc-purpose" data-ui-next="" data-un-m3e="record-purpose">
      <summary>
        <ShieldCheck size={18} aria-hidden="true" />
        <span>后续用途</span>
        <span className="rc-quiet">{p.current ? policyWords[p.current.policy] : '等待读取'}</span>
      </summary>
      <div className="rc-purpose-body">
        <header className="rc-purpose-line">
          <h3>这份材料如何用于后续学习</h3>
          <Button size="sm" variant="quiet" disabled={p.reading || p.sending} onClick={p.refresh}>
            <RefreshCw size={16} aria-hidden="true" />
            {p.reading ? '正在读取' : '刷新状态'}
          </Button>
        </header>
        {p.currentLoading && <p role="status">正在读取当前用途与来源版本…</p>}
        {p.currentError && (
          <p role="alert">当前用途暂时读不到。已有显示仅是上次读取的记录，暂不发送新变更。</p>
        )}
        {p.current && (
          <div className="rc-purpose-current">
            <span>最近读取的当前用途</span>
            <strong>{policyWords[p.current.policy]}</strong>
          </div>
        )}
        <fieldset disabled={!p.canChoose} className="rc-purpose-options">
          <legend>选择新的用途</legend>
          {(['allow', 'answer_only'] as const).map((target) => (
            <label key={target}>
              <input
                type="radio"
                name={`purpose-${sessionId}`}
                checked={p.selection?.target === target}
                onChange={() => p.choose(target)}
              />
              <span>
                <strong>{policyWords[target]}</strong>
                <span>
                  {target === 'allow'
                    ? '只对新的学习使用生效，不恢复旧运行或已删除的记忆。'
                    : '限制后续使用；停止、清理和历史处理将分别显示结果。'}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        {p.current?.policy === 'crisis' && <p>当前用途由系统限制，这里不能覆盖。</p>}
        {p.selection && (
          <p>
            确认后将按刚才读取的来源版本提交为「{policyWords[p.selection.target]}
            」。已发出的外部请求不可保证撤回，历史费用不因此取消。
          </p>
        )}
        {p.choiceChanged && (
          <p role="alert">来源或版本在选择后发生变化，请重新选择，不能沿用刚才的确认。</p>
        )}
        <Button variant="primary" disabled={!p.canConfirm} onClick={p.confirm}>
          {p.sending ? '正在提交用途' : '确认用途变更'}
        </Button>
        {p.storageError && <p role="alert">{p.storageError}</p>}
        {p.problem && <p role="status">{p.problem}</p>}
        {p.journal && (
          <section className="rc-purpose-request" aria-label="原用途请求">
            <h3>原请求与恢复</h3>
            <p>
              原请求选择：{policyWords[p.journal.body.target]}；来源版本：
              {p.journal.body.expected_version}。
            </p>
            {p.receipt ? (
              <>
                <p className="rc-purpose-committed" role="status">
                  <CircleCheck size={15} aria-hidden="true" />
                  原请求的政策已提交。这不代表停止、修复或历史处理全部完成。
                </p>
                <p>
                  提交的用途：{policyWords[p.receipt.input.target]} · 提交版本：
                  {p.receipt.committed_version}
                  {p.receipt.changed ? '' : '（政策值未变化）'}。
                </p>
              </>
            ) : (
              p.unresolved && (
                <p role="status">
                  是否提交尚未确认。保留原编号和完整输入，不会自动发起另一条请求。
                </p>
              )
            )}
            {p.mismatch && (
              <p role="alert">收到的回执与原输入不一致，已停止新的变更，需先核对请求身份。</p>
            )}
            {p.receiptMissing && (
              <p>
                暂未找到可确认的原回执。即使返回“未找到”，原请求仍可能提交，不能据此换编号重发。
              </p>
            )}
            {p.receipt && p.impactError && (
              <p role="alert">政策提交回执已收到，后续处理状态暂时读不到。请刷新状态。</p>
            )}
            {p.canRetry && (
              <div className="rc-purpose-retry">
                <p>
                  如需重试，只会原样提交这条请求，不改变编号、来源版本或用途。当前标签页内的刷新与重新打开会保留它；结果未知时请保留此标签页。
                </p>
                <Button variant="secondary" onClick={p.retrySame}>
                  按原请求重试
                </Button>
              </div>
            )}
            {p.impact && <ImpactDetails impact={p.impact} />}
            {p.receipt && !p.impact && !p.impactError && (
              <p>停止、修复及准入状态尚未读到，不推断处理结果。</p>
            )}
          </section>
        )}
      </div>
    </details>
  );
}
