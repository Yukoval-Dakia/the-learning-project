// A5 S4 (YUK-531 PR-5) — MisconceptionList:「指向此点的误区」per-KC funnel（RT1 误区
// 一等异构 + 猜想/候选）。挂在 KnowledgeDetailPage 的 .kd-main 首子（TransferList 上）。
//
// PORT 自设计源 docs/design/loom-refresh/project/screen-knowledge-a5.jsx 的 MisconceptionList /
// MisconceptionCard（line 125-172）。三处 wire↔design 偏离（map FLAG）：
//   ① DROP `{mc.note}` —— 节点页 wire 的 MisconceptionRow 无 note 字段；trace 只渲 evidence
//      event 回链 chips，绝不编造 note。
//   ② `segment` 驱动两段区分（mock 无 segment 处理）：confirmed 用 `.kd-misc-card.<status>` +
//      复发中/消退中 status badge；candidate 用 `.kd-misc-card.candidate` + 「猜想 · 候选」tag
//      （dashed/muted，mirror frontier-tag-propose）。诚实标候选「猜想」，绝不暗示已证（⑥）。
//   ③ `mc.targets` 客户端 filter 去掉 —— wire 已 server-filter per-KC，直接渲 items。
//
// 形态：presentational（page-owns-query，mirror S2 FrontierRail）。body-state split 早返
// （error→retry / loading→quiet / empty→honest-empty / else map），loading/error 绝不折进
// 业务空态（S2 CodeRabbit 教训）。MisconceptionCard 持本地 trace+verdict 态；纯渲染体抽成
// MisconceptionCardView（renderToString + element-tree onClick 可测，node 环境无 jsdom）。
//
// veto scope = Option A（owner 拍板）：candidate「判错了」→ onVeto(id,'candidate') → 页面打
// dismiss 端点（live dismiss pending conjecture）；confirmed「判错了」→ 仅渲乐观「已纠偏」本地
// 态（card 自管 verdict），onVeto(id,'confirmed') 在页面侧是 no-op（confirmed-archive 是延后
// soft-track 后端 slice + PR-3 promote flag OFF → confirmed 段 day-one 空）。

import { Btn } from '@/ui/primitives/Btn';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { useState } from 'react';
import type { MisconceptionRow } from './knowledge-api';

export interface MisconceptionListProps {
  items: MisconceptionRow[];
  /** 读模型加载中 → loading 态（别折叠成业务空态，CodeRabbit）。 */
  isLoading?: boolean;
  /** 读模型失败 → 错误 + 重试（别误显示成空态）。 */
  isError?: boolean;
  onRetry?: () => void;
  navigate: (to: string) => void;
  /**
   * 「判错了」否决回调。segment 决定语义（PR-5 Option A）：
   *   - 'candidate' → live dismiss（页面打 veto 端点）。返回的 Promise 让 card await + 失败回滚
   *     乐观 verdict（B）。
   *   - 'confirmed' → 页面侧 no-op（confirmed-archive 是延后 soft-track 后端 slice）；card 的
   *     confirmed「判错了」钮已 disabled（C），故此分支实际不会被触发，仅作兜底。
   * 返回值：candidate 走 mutateAsync（Promise，让 card await + 回滚）；confirmed no-op（undefined）。
   */
  onVeto: (id: string, segment: MisconceptionRow['segment']) => Promise<unknown> | undefined;
}

/**
 * applyVeto — 乐观「判错了」否决：先本地置「已纠偏」verdict + 上抛 (id, segment) 给页面 onVeto，
 * 若服务端写**失败**（409 并发 accept / 404 / 网络）则回滚 verdict + 内联诚实 error。⑥ 红线：
 * 失败的否决绝不能滞留一张假「已纠偏」卡。导出（setter 注入）以便 candidate 段路由 + onError 回滚
 * 在无 DOM renderer 下可单测（#609 / B）。confirmed 永不到这——其「判错了」钮 disabled（无 live
 * confirmed-archive 写路径）。
 */
export async function applyVeto(
  mc: MisconceptionRow,
  onVeto: MisconceptionListProps['onVeto'],
  setVerdict: (v: 'wrong' | null) => void,
  setError: (e: string | null) => void,
): Promise<void> {
  setVerdict('wrong');
  setError(null);
  try {
    await onVeto(mc.id, mc.segment);
  } catch {
    setVerdict(null);
    setError('撤销失败，请重试');
  }
}

const STATUS_LABEL: Record<MisconceptionRow['status'], string> = {
  active: '复发中',
  fading: '消退中',
};

const SOURCE_LABEL: Record<MisconceptionRow['source'], string> = {
  hard: '硬轨校准',
  soft: '软轨先验',
};

/**
 * 纯渲染体（trace / verdict 由父注入）。抽出来让 renderToString 单测能钉 trace 开态的
 * evidence chips + verdict 的「已纠偏」卡，并让 element-tree 浅遍历直接命中三个 onClick。
 */
export function MisconceptionCardView({
  mc,
  trace,
  verdict,
  error,
  navigate,
  onToggleTrace,
  onVerdictWrong,
}: {
  mc: MisconceptionRow;
  trace: boolean;
  verdict: 'wrong' | null;
  /** B (PR-5): 乐观 verdict 回滚后的内联诚实错误（null = 无错误）。 */
  error?: string | null;
  navigate: (to: string) => void;
  onToggleTrace: () => void;
  onVerdictWrong: () => void;
}) {
  if (verdict === 'wrong') {
    return (
      <div className="kd-misc-card fading">
        <div className="kd-misc-top">
          <span className="kd-misc-ic">
            <LoomIcon name="check" size={15} />
          </span>
          {/* 单文本节点（模板串）—— 避 React SSR 在文本/插值间插 `<!-- -->` 注释标记，DOM 更干净。 */}
          <span className="kd-misc-label">{`已纠偏：「${mc.label}」`}</span>
        </div>
        <p className="kd-misc-belief">谢谢，编排者会把这条误区降权 —— 下次不再据此排题。</p>
      </div>
    );
  }

  const isConfirmed = mc.segment === 'confirmed';
  const cardClass = `kd-misc-card ${isConfirmed ? mc.status : 'candidate'}`;
  // D (PR-5): `?? []` 防御（schema 上 evidence 是 notNull default []，纯防御冗余但 cheap，
  // 防 API 漂移传 null 时崩）。E (PR-5): Set 去重——读模型不去重 evidence ids，重复 event ref
  // 会同时产生重复 React key（警告 + 不稳定 reconciliation）与重复显示 chip；去重一并消除两者。
  const evidence = [...new Set(mc.evidence ?? [])];

  return (
    <div className={cardClass}>
      <div className="kd-misc-top">
        <span className="kd-misc-ic">
          {/* confirmed = 确认误区（alert）；candidate = AI 猜想（sparkle，不拉警报）。 */}
          <LoomIcon name={isConfirmed ? 'alert' : 'sparkle'} size={15} />
        </span>
        <span className="kd-misc-label">{mc.label}</span>
        {isConfirmed ? (
          <span className={`kd-misc-status ${mc.status}`}>{STATUS_LABEL[mc.status]}</span>
        ) : (
          // 诚实标候选——非已证误区（⑥ red line：绝不暗示已证）。
          <span className="kd-misc-tag-candidate">猜想 · 候选</span>
        )}
      </div>
      <p className="kd-misc-belief">{mc.belief}</p>
      <div className="kd-misc-meta">
        <span className={`band-chip src-${mc.source}`}>
          <span className="bc-dot" />
          {SOURCE_LABEL[mc.source]}
        </span>
        {/* 模板串单文本节点 —— conf 定性档 / seen 计数；避 SSR 注释标记，且绝不裸概率（⑥）。 */}
        <span>{`置信 ${mc.conf}`}</span>
        <span>·</span>
        <span>{`复现 ${mc.seen} 次`}</span>
      </div>
      {trace && (
        <div className="kd-misc-trace">
          {evidence.length > 0 ? (
            <>
              依据 event：
              {evidence.map((e) => (
                <code key={e} className="evt">
                  {e}
                </code>
              ))}
            </>
          ) : (
            // wire 偏离①：无 mc.note；evidence 为空时诚实标，绝不编造依据。
            <span>暂无可回链的 event 依据。</span>
          )}
        </div>
      )}
      <div className="kd-misc-acts">
        <Btn size="sm" variant="secondary" icon="review" onClick={() => navigate('/practice')}>
          针对性练习
        </Btn>
        <button type="button" className="kd-misc-link" onClick={onToggleTrace}>
          <LoomIcon name="history" size={14} />
          追溯
        </button>
        {isConfirmed ? (
          // C (PR-5 review) — 诚实化：confirmed(RT1 误区) 的否决无 live 写路径（confirmed-archive
          // 是延后 soft-track 后端 slice，YUK 待建，flag 翻前补）。没有服务端写就别给会假「已纠偏」的
          // 可点钮（⑥）——disabled 钮 + 旁注；candidate 段才有 live 否决。
          <span className="kd-misc-veto-deferred">
            <button
              type="button"
              className="kd-misc-link"
              disabled
              title="确认误区的否决需编排者复核——暂不能在此直接否决"
            >
              <LoomIcon name="close" size={14} />
              判错了
            </button>
            <span className="meta">暂不可否决 · 待编排者复核</span>
          </span>
        ) : (
          <button
            type="button"
            className="kd-misc-link"
            title="若 AI 判错了这个候选误区，纠正它"
            onClick={onVerdictWrong}
          >
            <LoomIcon name="close" size={14} />
            判错了
          </button>
        )}
      </div>
      {error && (
        // B (PR-5 review) — 乐观 verdict 回滚后的内联诚实错误（mirror FrontierRail 的 error
        // body-state .quiet-empty 风格；不引第三方 toast）。⑥：失败绝不滞留假「已纠偏」。
        <p className="kd-misc-error quiet-empty">{error}</p>
      )}
    </div>
  );
}

/**
 * 有态壳：管 trace / verdict / error 本地态。「判错了」(仅 candidate 卡可点——confirmed 钮 disabled)
 * 走 applyVeto：乐观置「已纠偏」+ 上抛 onVeto，失败回滚 verdict + 内联 error（B / ⑥）。导出供
 * KnowledgeDetailPage 复用（page-owns-query 渲染壳）。
 */
export function MisconceptionCard({
  mc,
  navigate,
  onVeto,
}: {
  mc: MisconceptionRow;
  navigate: (to: string) => void;
  onVeto: MisconceptionListProps['onVeto'];
}) {
  const [trace, setTrace] = useState(false);
  const [verdict, setVerdict] = useState<'wrong' | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <MisconceptionCardView
      mc={mc}
      trace={trace}
      verdict={verdict}
      error={error}
      navigate={navigate}
      onToggleTrace={() => setTrace((v) => !v)}
      onVerdictWrong={() => void applyVeto(mc, onVeto, setVerdict, setError)}
    />
  );
}

export function MisconceptionList({
  items,
  isLoading = false,
  isError = false,
  onRetry,
  navigate,
  onVeto,
}: MisconceptionListProps) {
  // body-state split（早返，避把 loading/error 折进业务空态——S2 CodeRabbit）。本组件无
  // 持续 head（head 由页面 SectionLabel 承担），故 split 直接是组件体。
  if (isError) {
    return (
      <p className="quiet-empty">
        指向此点的误区暂不可用。
        {onRetry && (
          <button type="button" className="kd-misc-retry" onClick={onRetry}>
            <LoomIcon name="refresh" size={13} />
            重试
          </button>
        )}
      </p>
    );
  }
  if (isLoading) {
    return <p className="quiet-empty">正在看有没有指向此点的误区…</p>;
  }
  if (items.length === 0) {
    return <p className="quiet-empty">没有指向此点的误区 —— 你在这点上没有顽固的错误信念。</p>;
  }
  return (
    <>
      {items.map((mc) => (
        <MisconceptionCard key={mc.id} mc={mc} navigate={navigate} onVeto={onVeto} />
      ))}
    </>
  );
}
