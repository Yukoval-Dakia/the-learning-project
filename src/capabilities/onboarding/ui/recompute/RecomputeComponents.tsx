// YUK-495 S5 #41 — recompute verify layer components (ported from the claude.ai/design
// recompute-profile.jsx). The simulated Beta-binomial math is REPLACED by the real
// re-derivation (recompute-core → src/core/recompute). Read-only; renders the verify bar,
// per-KC chips, the bit-for-bit ledger, the drift detail, and the honesty footnote.

import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { type RcKcVerdict, type RcSummary, rcFmt } from './recompute-core';
import type { RcState } from './useRecompute';

/** Offline chip — emphasise the pure on-device, no-network re-derivation. */
export function RcOffline() {
  return (
    <span className="rc-offline" title="纯设备端重导 · 无需联网">
      <LoomIcon name="bolt" size={11} />
      离线 · 本地
    </span>
  );
}

/** per-KC indicator: ✓ re-derived / ✗ drift / no numbers — hidden while idle/running. */
export function RcKcChip({ state, kind }: { state: RcState; kind: RcKcVerdict['kind'] }) {
  if (state === 'idle' || state === 'running') return null;
  if (kind === 'na') {
    return (
      <span className="rc-chip rc-na" title="未测 —— 没有数字可重导">
        无数字可验
      </span>
    );
  }
  if (kind === 'drift') {
    return (
      <span className="rc-chip rc-x">
        <LoomIcon name="alert" size={11} />
        重导不符
      </span>
    );
  }
  // match (poly) or preview (libm)
  return (
    <span className="rc-chip rc-ok">
      <LoomIcon name="check" size={11} />
      {kind === 'preview' ? '已重导 · 预览' : '已重导'}
    </span>
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
        {state === 'running' && <div className="rc-verify-title">正在本设备重导画像…</div>}

        {state === 'match' && (
          <>
            <div className="rc-verify-title">
              画像已在本设备重导 <span className="rc-tick">✓</span>
            </div>
            <div className="rc-verify-sub">
              <b className="mono">{summary.testedCount}</b> 个知识点的显示数字 · 与服务端
              <b>逐位相等</b>· <RcOffline />
            </div>
          </>
        )}

        {state === 'preview' && (
          <>
            <div className="rc-verify-title">已在本设备重导（预览）</div>
            <div className="rc-verify-sub">
              <b className="mono">{summary.testedCount}</b> 个知识点已从你的证据重导，显示一致 · σ
              对齐后转<b>逐位校验</b> · <RcOffline />
            </div>
          </>
        )}

        {state === 'drift' && (
          <>
            <div className="rc-verify-title">
              画像有 <b className="mono">{summary.driftCount}</b> 处显示不同步
            </div>
            <div className="rc-verify-sub">
              等级与相对排序本身没问题，重算只读 —— 联网后会让这些项重新对账 · <RcOffline />
            </div>
          </>
        )}
      </div>
      {resolved && (
        <div className="rc-verify-act">
          <button type="button" className="rc-detail-toggle" onClick={onToggleDetail}>
            {detailOpen ? '收起明细' : '查看逐位明细'}
          </button>
          <button type="button" className="rc-rerun" onClick={onRerun} title="再算一次">
            <LoomIcon name="refresh" size={14} />
          </button>
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
        <span className="rc-num">账本 succ/fail · 锚</span>
        <span className="rc-num">p̂ 点</span>
        <span className="rc-num">可能区间</span>
        <span className="rc-num">SE</span>
        <span className="rc-eq">核对</span>
      </div>
      {rows.map((v) => {
        const l = v.ledger as NonNullable<RcKcVerdict['ledger']>;
        return (
          <div key={v.id} className="rc-ledger-row">
            <span className="rc-ledger-name">{v.name}</span>
            <span className="rc-num mono">
              {l.s}/{l.f} · {rcFmt(l.b)}
            </span>
            <span className="rc-num mono">{rcFmt(l.p_l)}</span>
            <span className="rc-num mono">
              {rcFmt(l.mastery_lo)}–{rcFmt(l.mastery_hi)}
            </span>
            <span className="rc-num mono">{rcFmt(l.se)}</span>
            <span className="rc-eq">
              {v.kind === 'drift' ? (
                <span className="rc-eq-x">
                  <LoomIcon name="alert" size={12} />
                  不符
                </span>
              ) : (
                <span className="rc-eq-ok">
                  <LoomIcon name="check" size={12} />
                  {v.kind === 'preview' ? '一致' : '逐位'}
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
          <span>服务端显示</span>
          <span>本设备重导</span>
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
        只是<b>这一项的显示口径与本地重导没对上</b> —— 你的作答证据没有问题，其它 {otherCount}{' '}
        个数字都逐位相等。重算只读，不会改动任何记录；联网后系统会让这一项重新对账。
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
        重算<b>只读</b>，不改任何数据。它在本设备从你的 succ / fail / 难度锚，用与服务端
        <b>同一份</b>
        数学重导每个显示数字（p̂ 点 · 区间 · SE）并逐位核对。它<b>不</b>重跑整条管线 ——
        不重算难度锚的库内聚合、不重跑 AI 判分。宽区间 / 低置信 / 未测是诚实的特性：verified ✓
        表示「这个宽带本身可重导」，不表示「现在它更准了」。
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
