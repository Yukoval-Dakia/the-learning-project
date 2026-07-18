// YUK-495 S5 #41 — recompute verify layer components (ported from the claude.ai/design
// recompute-profile.jsx). The simulated Beta-binomial math is REPLACED by the real
// re-derivation (recompute-core → src/core/recompute). Read-only; renders the verify bar,
// per-KC chips, the bit-for-bit ledger, the drift detail, and the honesty footnote.

import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { type RcKcVerdict, type RcMaturitySummary, type RcSummary, rcFmt } from './recompute-core';
import { type RcState, useRecompute } from './useRecompute';

/** Offline chip — emphasise the pure on-device, no-network re-derivation. */
export function RcOffline() {
  return (
    <span className="rc-offline" title="只在此设备核对显示结果">
      <LoomIcon name="bolt" size={11} />
      本地核对
    </span>
  );
}

/** per-KC indicator: ✓ re-derived / ✗ drift / no numbers — hidden while idle/running. */
export function RcKcChip({ state, kind }: { state: RcState; kind: RcKcVerdict['kind'] }) {
  if (state === 'idle' || state === 'running') return null;
  if (kind === 'na') {
    return (
      <span className="rc-chip rc-na" title="还没有作答记录可供核对">
        暂无记录
      </span>
    );
  }
  if (kind === 'drift') {
    return (
      <span className="rc-chip rc-x">
        <LoomIcon name="alert" size={11} />
        显示待同步
      </span>
    );
  }
  // match (poly) or preview (libm)
  return (
    <span className="rc-chip rc-ok">
      <LoomIcon name="check" size={11} />
      {kind === 'preview' ? '已初步核对' : '已核对'}
    </span>
  );
}

function RcRerunButton({
  state,
  label,
  onClick,
}: {
  state: RcState;
  label: string;
  onClick: () => void;
}) {
  const accessibleLabel = state === 'running' ? `正在${label}` : label;
  return (
    <button
      type="button"
      className="rc-rerun"
      disabled={state === 'running'}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      onClick={onClick}
    >
      <LoomIcon name="refresh" size={14} />
    </button>
  );
}

/** The recompute / verify control bar — A idle → B running → C match | D drift | preview. */
export function RcVerify({
  state,
  summary,
  detailOpen,
  onToggleDetail,
  onRerun,
}: {
  state: RcState;
  summary: RcSummary;
  detailOpen: boolean;
  onToggleDetail: () => void;
  onRerun: () => void;
}) {
  const icon =
    state === 'match'
      ? 'checkCircle'
      : state === 'drift'
        ? 'alert'
        : state === 'preview'
          ? 'bolt'
          : 'refresh';
  const resolved = state === 'match' || state === 'drift' || state === 'preview';

  return (
    <div className={`rc-verify rc-state-${state}`}>
      <span className="rc-verify-icon">
        <LoomIcon name={icon} size={18} />
      </span>
      <div className="rc-verify-text">
        {state === 'running' && <div className="rc-verify-title">正在核对学习画像…</div>}

        {state === 'match' && (
          <>
            <div className="rc-verify-title">
              学习画像已核对 <span className="rc-tick">✓</span>
            </div>
            <div className="rc-verify-sub">
              <b className="mono">{summary.testedCount}</b> 个知识点的显示结果一致 · <RcOffline />
            </div>
          </>
        )}

        {state === 'preview' && (
          <>
            <div className="rc-verify-title">已完成初步核对</div>
            <div className="rc-verify-sub">
              <b className="mono">{summary.testedCount}</b>{' '}
              个知识点的显示结果一致；记录增加后会继续核对 · <RcOffline />
            </div>
          </>
        )}

        {state === 'drift' && (
          <>
            <div className="rc-verify-title">
              画像有 <b className="mono">{summary.driftCount}</b> 处显示不同步
            </div>
            <div className="rc-verify-sub">
              学习记录没有丢失；这些项的显示结果会在下次同步时重新核对 · <RcOffline />
            </div>
          </>
        )}
      </div>
      {resolved && (
        <div className="rc-verify-act">
          <button type="button" className="rc-detail-toggle" onClick={onToggleDetail}>
            {detailOpen ? '收起明细' : '查看核对明细'}
          </button>
          <RcRerunButton state={state} label="重新核对学习画像" onClick={onRerun} />
        </div>
      )}
    </div>
  );
}

/** C state — the bit-for-bit ledger (raw evidence → re-derived display). */
export function RcLedgerTable({ verdicts }: { verdicts: RcKcVerdict[] }) {
  const rows = verdicts.filter((v) => v.ledger);
  return (
    <div className="rc-ledger">
      <div className="rc-ledger-head">
        <span>知识点</span>
        <span className="rc-num">答对 / 待巩固</span>
        <span className="rc-num">当前判断</span>
        <span className="rc-num">可能区间</span>
        <span className="rc-eq">核对</span>
      </div>
      {rows.map((v) => {
        const l = v.ledger as NonNullable<RcKcVerdict['ledger']>;
        return (
          <div key={v.id} className="rc-ledger-row">
            <span className="rc-ledger-name">{v.name}</span>
            <span className="rc-num mono">
              {l.s} / {l.f}
            </span>
            <span className="rc-num mono">{Math.round(l.p_l * 100)}%</span>
            <span className="rc-num mono">
              {Math.round(l.mastery_lo * 100)}%–{Math.round(l.mastery_hi * 100)}%
            </span>
            <span className="rc-eq">
              {v.kind === 'drift' ? (
                <span className="rc-eq-x">
                  <LoomIcon name="alert" size={12} />
                  不符
                </span>
              ) : (
                <span className="rc-eq-ok">
                  <LoomIcon name="check" size={12} />
                  一致
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** D state — single-KC drift detail: server display vs device re-derivation, calm + honest. */
export function RcDriftDetail({
  verdict,
  otherCount,
}: {
  verdict: RcKcVerdict;
  otherCount: number;
}) {
  return (
    <div className="rc-drift">
      <div className="rc-drift-head">
        <span className="rc-drift-kc">{verdict.name}</span>
        <span className="rc-drift-tag">此处记录不同步</span>
      </div>
      <div className="rc-drift-table">
        <div className="rc-drift-col rc-drift-labels">
          <span className="rc-drift-h" />
          <span>当前显示</span>
          <span>本地核对</span>
        </div>
        {verdict.diffs.map((d) => (
          <div key={d.field} className="rc-drift-col">
            <span className="rc-drift-h">{d.label}</span>
            <span className="mono rc-drift-server">{rcFmt(d.server)}</span>
            <span className="mono rc-drift-device">{rcFmt(d.device)}</span>
          </div>
        ))}
      </div>
      <p className="rc-drift-note">
        只是<b>这一项的显示结果暂时不同步</b> —— 你的作答记录没有问题，其它 {otherCount}{' '}
        个知识点显示一致。核对过程只读，不会改动任何记录；下次同步时会重新检查这一项。
      </p>
    </div>
  );
}

/** Honest-boundary footnote — what the recompute does and (loudly) does NOT do. */
export function RcBoundaryNote() {
  return (
    <div className="rc-boundary">
      <LoomIcon name="lock" size={13} />
      <span>
        核对过程<b>只读</b>，不会改动任何学习记录。它只检查当前显示是否能由已有作答得到，
        不会重新判题或改写历史。区间较宽、依据不足或尚未作答都仍会如实显示；“已核对”只表示
        显示一致，不表示系统对你的判断突然变得更准。
      </span>
    </div>
  );
}

/** The collapsible detail panel — ledger (match/preview) or drift detail, plus the boundary note. */
export function RcDetailPanel({ summary }: { summary: RcSummary }) {
  return (
    <div className="rc-detail">
      {summary.overall === 'drift' && summary.firstDrift ? (
        <RcDriftDetail
          verdict={summary.firstDrift}
          otherCount={Math.max(summary.testedCount - 1, 0)}
        />
      ) : (
        <RcLedgerTable verdicts={summary.verdicts} />
      )}
      <RcBoundaryNote />
    </div>
  );
}

/**
 * D2 (#45) — calibration-maturity 卡 · profile 级成熟度对账徽章.
 *
 * profile 屏是观察面（「这份测量有多可信」），所以 verified ✓ 设成静息态：打开即在本设备
 * 重导成熟度概览（firm 计数 · 中位 θ̂ SE）并与服务端 aggregate 逐位对账。与 per-KC 的
 * RcVerify 不同：maturity 两个量都与 σ flag 无关（见 summarizeMaturity），故无 poly/libm
 * preview 区分——只有 match（逐位）/ drift（不等）/ running 三态，drift 由 summarizeMaturity
 * 的真实比较得出（非模拟 prop）。
 */
export function RcMaturityBadge({ summary }: { summary: RcMaturitySummary }) {
  // Own the verify state machine; settle on the REAL reconciliation outcome.
  const { state, run } = useRecompute({ auto: true, outcome: summary.overall });
  const { dFirm, total } = summary;

  return (
    <div className={`rc-cal rc-state-${state}`}>
      <span className="rc-cal-icon">
        <LoomIcon
          name={state === 'match' ? 'checkCircle' : state === 'drift' ? 'alert' : 'refresh'}
          size={18}
        />
      </span>
      <div className="rc-cal-text">
        {state === 'running' && <div className="rc-cal-title">正在核对判断可靠度…</div>}

        {state === 'match' && (
          <>
            <div className="rc-cal-title">
              判断可靠度已核对 <span className="rc-tick">✓</span>
            </div>
            <div className="rc-cal-sub">
              <span className="mono">{total}</span> 个知识点的显示结果一致
              <span className="rc-cal-figs">
                <span className="rc-cal-fig">
                  <b className="mono">判断较可信 {dFirm}</b>
                  <LoomIcon name="check" size={11} />
                </span>
              </span>
              · <RcOffline />
            </div>
          </>
        )}

        {state === 'drift' && (
          <>
            <div className="rc-cal-title">
              概览有 <b className="mono">1</b> 处不同步
            </div>
            <div className="rc-cal-sub">
              学习记录没有丢失；概览会在下次同步时重新核对。核对过程只读，不会改动记录。 ·{' '}
              <RcOffline />
            </div>
          </>
        )}
      </div>
      <RcRerunButton state={state} label="重新核对判断可靠度" onClick={run} />
    </div>
  );
}
