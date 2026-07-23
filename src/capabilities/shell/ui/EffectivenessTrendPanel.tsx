// YUK-354 (A7 成效趋势面) — Coach 复盘中枢的「成效趋势」视图。
//
// 纵向 delta：per-subject / per-KC 相对自己过去轨迹的方向 + 置信。横截面诊断（校准成熟度，
// 「现在多准」）的姊妹面，答「相比上次涨了吗」。读 GET /api/observability/effectiveness-trend。
//
// 形态（owner 拍定 rollup-first，handoff「多科目+规模」节）：默认首屏 = 科目卷起（lead with
// aggregate.by_subject），每科高亮「本期动了的」KC、holding/insufficient 折叠；点科目下钻该科
// 逐 KC 轨迹。三个合成根毛刺：① seed-root 自指 = 科目整体；② null domain = 显式「未归类」桶；
// ③ 跨科 KC 单继承（本期接受）。
//
// ⑥硬约束（gate doc §1.5.2 ⑥ + ADR-0035）：趋势绝不裸 delta（不渲染 theta_delta/p_learned 数
// 值，只画相对位置轨迹 + 定性方向 + 置信档）；低置信显著降级；`insufficient`/`low` 一等公民态。
// 空态不画假上升线 / 0 值平线；读模型故障不回落「全部 0」（认识论诚实）。
//
// 纯视图逻辑（合成根识别 / ⑥映射 / 分桶 / 轨迹几何）抽在 effectiveness-trend-view.ts（DB-free,
// unit 覆盖）；本文件只做 React 装配。

import { resolveSubjectRenderModelForDomain } from '@/ui/lib/subject';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SkLines } from '@/ui/primitives/SkLines';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  type EffectivenessTrendResponse,
  type EffectivenessTrendSeries,
  type SubjectTrendRollup,
  type TrendConfidence,
  type TrendDirection,
  getEffectivenessTrend,
} from './effectiveness-trend-api';
import {
  type ConfidenceClass,
  UNCATEGORIZED_LABEL,
  bandTier,
  confidenceClass,
  confidenceLabel,
  countSettled,
  directionMeta,
  isTender,
  partitionSubjectSeries,
  pointsToValues,
  selectMovedKcs,
  seriesForDomain,
  summarizeOverview,
  trajGeometry,
} from './effectiveness-trend-view';

// p(L) 四分相对参照档（仅定性，绝不当精确分）。
const BANDS = ['萌芽', '成长', '稳固', '精熟'];
const UNCAT_KEY = '\0uncat';

function subjectLabel(domain: string | null): string {
  if (domain === null) return UNCATEGORIZED_LABEL;
  return resolveSubjectRenderModelForDomain(domain).displayName;
}

// ── ⑥ 置信 chip（低置信显著降级）─────────────────────────────────────────────
function confTagText(cls: ConfidenceClass, span: number, mini: boolean): string {
  const lbl = confidenceLabel(cls);
  if (mini) return lbl.mini;
  if (cls === 'is-firm') return `${lbl.full} · ${span} 个活跃日`;
  return lbl.full;
}

function EffConfTag({
  direction,
  confidence,
  spanEvidence,
  mini = false,
}: {
  direction: TrendDirection;
  confidence: TrendConfidence;
  spanEvidence: number;
  mini?: boolean;
}) {
  const cls = confidenceClass(direction, confidence);
  return (
    <span className={`eff-conf ${cls}${mini ? ' mini' : ''}`} title={confidenceLabel(cls).full}>
      {confTagText(cls, spanEvidence, mini)}
    </span>
  );
}

// ── 方向 chip ─────────────────────────────────────────────────────────────────
function EffDirChip({
  direction,
  prefix = '',
  lg = false,
}: {
  direction: TrendDirection;
  prefix?: string;
  lg?: boolean;
}) {
  const m = directionMeta(direction);
  return (
    <span className={`eff-dirchip tone-${m.tone}${lg ? ' lg' : ''}`}>
      {m.glyph} {prefix}
      {m.label}
    </span>
  );
}

// ── 轨迹 SVG（相对位置 p(L) 0..1 + 不确定带；⑥ 低置信带更宽）────────────────────
function EffTrajectory({
  series,
  w,
  h,
  padX = 8,
  padY = 9,
  showBands = false,
}: {
  series: EffectivenessTrendSeries;
  w: number;
  h: number;
  padX?: number;
  padY?: number;
  showBands?: boolean;
}) {
  const { trend } = series;
  const values = pointsToValues(series.points);
  const tier = bandTier(trend.direction, trend.confidence);
  const g = trajGeometry(values, tier, w, h, padX, padY);
  const tender = isTender(trend.direction, trend.confidence);
  const m = directionMeta(trend.direction);

  // 退化态：θ̂/p(L) 全空 → 不画假线，改走活动量代理（handoff 故障/退化态约束）。
  if (g.n === 0) {
    return (
      <div className="eff-traj-degenerate meta">活动 {series.activity_count} 次 · 无掌握度轨迹</div>
    );
  }

  const innerH = h - 2 * padY;
  const yOf = (p: number) => h - padY - Math.max(0, Math.min(1, p)) * innerH;
  const last = g.pts[g.n - 1];
  const v0 = values[0];

  return (
    <svg
      className={`eff-traj is-${trend.direction}${tender ? ' is-tender' : ''}`}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${series.name ?? '未命名知识点'} · ${m.label}`}
    >
      {showBands &&
        [0, 0.5, 1].map((p) => (
          <line key={p} className="eff-traj-grid" x1={padX} y1={yOf(p)} x2={w - padX} y2={yOf(p)} />
        ))}
      {g.n >= 2 && <path className="eff-traj-band" d={g.bandPath} />}
      {g.n === 1 && (
        <line
          className="eff-traj-errbar"
          x1={last.x}
          y1={yOf(Math.min(1, v0 + last.half))}
          x2={last.x}
          y2={yOf(Math.max(0, v0 - last.half))}
        />
      )}
      {g.n >= 2 && <path className="eff-traj-line" d={g.linePath} />}
      {g.pts.map((q, i) => (
        <circle
          key={q.x}
          className={`eff-traj-dot${i === g.n - 1 ? ' last' : ''}`}
          cx={q.x}
          cy={q.y}
          r={i === g.n - 1 ? 3.4 : 2}
        />
      ))}
    </svg>
  );
}

// ── 概览条（方向分布 + ⑥「多数低置信」诚实信号）──────────────────────────────
function EffOverview({ series }: { series: EffectivenessTrendSeries[] }) {
  const o = summarizeOverview(series);
  const segs: Array<[TrendDirection, number]> = [
    ['rising', o.counts.rising],
    ['holding', o.counts.holding],
    ['falling', o.counts.falling],
    ['insufficient', o.counts.insufficient],
  ];
  const tot = o.total || 1;
  return (
    <LoomCard pad className="eff-overview-card">
      <div className="eff-dirbar">
        {segs.map(([d, n]) =>
          n > 0 ? (
            <span
              key={d}
              className={`eff-dirbar-seg is-${d}`}
              style={{ width: `${(n / tot) * 100}%` }}
              title={`${directionMeta(d).label} ${n}`}
            />
          ) : null,
        )}
      </div>
      <div className="eff-legend">
        {segs.map(([d, n]) => (
          <span key={d}>
            <i className={`is-${d}`} />
            {directionMeta(d).label} <b className="mono">{n}</b>
          </span>
        ))}
      </div>
      <p className="eff-overview-note meta">
        本窗共 {o.total} 个入选的显著变化知识点 · <b className="mono">{o.firm}</b> 条方向较可靠，
        <b className="mono">{o.tender}</b>{' '}
        条仍需更多记录。这里只展示全局排序后的有限子集，不代表全部知识点。
      </p>
    </LoomCard>
  );
}

// ── 科目整体行（毛刺 ①：seed-root = 科目整体，子 KC 未抽出）───────────────────
function EffSubjectWholeRow({
  label,
  whole,
}: {
  label: string;
  whole: EffectivenessTrendSeries;
}) {
  const { trend } = whole;
  return (
    <div className="eff-subj is-whole">
      <div className="eff-subj-head">
        <span className="eff-subj-name serif">{label}</span>
        <span className="eff-subj-wholetag">
          <LoomIcon name="layers" size={12} />
          整科概览
        </span>
        <EffDirChip direction={trend.direction} prefix="整科" lg />
        <EffConfTag
          direction={trend.direction}
          confidence={trend.confidence}
          spanEvidence={trend.span_evidence}
        />
      </div>
      <div className="eff-subj-wholeviz">
        <EffTrajectory series={whole} w={300} h={56} showBands />
        <div className="eff-subj-wholeside">
          <span className="eff-subj-wholehint meta">
            积累到更多知识点记录后，这里会展开更细的趋势。
          </span>
        </div>
      </div>
    </div>
  );
}

// ── 「本期动了的」紧凑项 ──────────────────────────────────────────────────────
function EffMovedKc({
  kc,
  onDrill,
}: {
  kc: EffectivenessTrendSeries;
  onDrill: () => void;
}) {
  const m = directionMeta(kc.trend.direction);
  const tender = isTender(kc.trend.direction, kc.trend.confidence);
  return (
    <button
      type="button"
      className={`eff-moved is-${kc.trend.direction}${tender ? ' is-tender' : ''}`}
      onClick={onDrill}
    >
      <span className="eff-moved-top">
        <span className={`eff-moved-glyph tone-${m.tone}`}>{m.glyph}</span>
        <span className="eff-moved-name">{kc.name ?? '未命名知识点'}</span>
        <EffConfTag
          direction={kc.trend.direction}
          confidence={kc.trend.confidence}
          spanEvidence={kc.trend.span_evidence}
          mini
        />
      </span>
      <EffTrajectory series={kc} w={132} h={34} />
    </button>
  );
}

// ── 科目卷起行（首屏；方向 + 置信 + 动了的 + 折叠 + 下钻）──────────────────────
function EffSubjectRow({
  rollup,
  rows,
  onDrill,
}: {
  rollup: SubjectTrendRollup;
  rows: EffectivenessTrendSeries[];
  onDrill: (domain: string | null) => void;
}) {
  const { whole, kcs } = partitionSubjectSeries(rows);
  const uncategorized = rollup.effective_domain === null;
  const label = subjectLabel(rollup.effective_domain);

  // 子 KC 未抽出 → 只有 seed-root 整科轨迹（毛刺 ①）。
  if (whole && kcs.length === 0) {
    return <EffSubjectWholeRow label={label} whole={whole} />;
  }

  const moved = selectMovedKcs(kcs);
  const settled = countSettled(kcs);
  const settledTotal = settled.holding + settled.insufficient;

  return (
    <div className={`eff-subj${uncategorized ? ' is-uncat' : ''}`}>
      <div className="eff-subj-head">
        <button
          type="button"
          className="eff-subj-name-btn"
          onClick={() => onDrill(rollup.effective_domain)}
        >
          {uncategorized && (
            <span className="eff-subj-uncat-ic">
              <LoomIcon name="hash" size={15} />
            </span>
          )}
          <span className="eff-subj-name serif">{label}</span>
          <span className="eff-subj-count mono">{rollup.kc_count} 个知识点</span>
        </button>
        <EffDirChip direction={rollup.direction} prefix="整科" lg />
        <EffConfTag
          direction={rollup.direction}
          confidence={rollup.confidence}
          spanEvidence={rollup.activity_count}
        />
        <button
          type="button"
          className="eff-subj-drill"
          onClick={() => onDrill(rollup.effective_domain)}
        >
          展开知识点 <LoomIcon name="chevronDown" size={14} />
        </button>
      </div>
      <div className="eff-subj-moved">
        <span className="eff-subj-moved-l meta">本期动了的</span>
        {moved.length > 0 ? (
          moved.map((k) => (
            <EffMovedKc
              key={k.knowledge_id}
              kc={k}
              onDrill={() => onDrill(rollup.effective_domain)}
            />
          ))
        ) : (
          <span className="eff-subj-nomove meta">这科最近没有明显上升或回落的知识点</span>
        )}
        {settledTotal > 0 && (
          <button
            type="button"
            className="eff-subj-settled"
            onClick={() => onDrill(rollup.effective_domain)}
            title="默认折叠，点开看入选项"
          >
            +{settled.holding} 持平 · {settled.insufficient} 数据不足{' '}
            <span className="eff-subj-settled-x">默认折叠</span>
          </button>
        )}
      </div>
    </div>
  );
}

// ── 逐 KC 轨迹行（下钻态）─────────────────────────────────────────────────────
function rowNote(kc: EffectivenessTrendSeries): string {
  const n = kc.trend.span_evidence;
  if (kc.trend.direction === 'insufficient') {
    return `证据太少（${n} 个活跃日），连方向都不该断言 —— 这是「数据不足」，不是涨也不是退。再积累一些活跃日就看得出走向。`;
  }
  if (kc.trend.confidence === 'low') {
    return `目前只能看大致方向（${n} 个活跃日），记录较少可能掩盖真实变化。`;
  }
  return `${n} 个活跃日支撑：相对过去的你${directionMeta(kc.trend.direction).label} —— 信方向，幅度别当精确值。`;
}

function EffSparkRow({
  kc,
  navigate,
}: {
  kc: EffectivenessTrendSeries;
  navigate: (to: string) => void;
}) {
  const tender = isTender(kc.trend.direction, kc.trend.confidence);
  // KC id 可能含 `:`（如 seed:wenyan:root）→ encodeURIComponent。
  const href = `/knowledge/${encodeURIComponent(kc.knowledge_id)}`;
  return (
    <div className={`eff-row is-${kc.trend.direction}${tender ? ' is-tender' : ''}`}>
      <div className="eff-row-main">
        <div className="eff-row-top">
          <span className="eff-row-name">{kc.name ?? '未命名知识点'}</span>
          <EffDirChip direction={kc.trend.direction} prefix="相对" />
          <EffConfTag
            direction={kc.trend.direction}
            confidence={kc.trend.confidence}
            spanEvidence={kc.trend.span_evidence}
          />
        </div>
        <p className="eff-row-note">{rowNote(kc)}</p>
        <div className="eff-row-foot">
          <button type="button" className="eff-linkbtn" onClick={() => navigate(href)}>
            <LoomIcon name="knowledge" size={13} />
            看图谱
          </button>
        </div>
      </div>
      <div className="eff-row-viz">
        <EffTrajectory series={kc} w={188} h={66} showBands />
        <div className="eff-row-axis">
          <span className="mono">{kc.points.length <= 1 ? '首次' : '起'}</span>
          <span className="eff-row-axis-bands">{BANDS.join(' ‹ ')}</span>
          <span className="mono">现在</span>
        </div>
      </div>
    </div>
  );
}

// ── 首屏：科目卷起 ────────────────────────────────────────────────────────────
function RollupScreen({
  data,
  onDrill,
}: {
  data: EffectivenessTrendResponse;
  onDrill: (domain: string | null) => void;
}) {
  return (
    <section className="eff-vizsec">
      <div className="eff-vizhead">
        <div className="eff-vizhead-l">
          <div className="card-title">方向与轨迹 · 按科目查看</div>
          <span className="meta">
            先看科目整体，再展开最近有变化的知识点。记录较少时，科目整体通常比单个知识点更稳定。
          </span>
        </div>
      </div>
      <div className="eff-rollup">
        {data.aggregate.by_subject.map((rollup) => (
          <EffSubjectRow
            key={rollup.effective_domain ?? UNCAT_KEY}
            rollup={rollup}
            rows={seriesForDomain([...data.subject_roots, ...data.series], rollup.effective_domain)}
            onDrill={onDrill}
          />
        ))}
      </div>
    </section>
  );
}

// ── 下钻：某科逐 KC 轨迹 ──────────────────────────────────────────────────────
function DrilldownScreen({
  data,
  domain,
  navigate,
  onBack,
}: {
  data: EffectivenessTrendResponse;
  domain: string | null;
  navigate: (to: string) => void;
  onBack: () => void;
}) {
  const rows = seriesForDomain([...data.subject_roots, ...data.series], domain);
  const { whole, kcs } = partitionSubjectSeries(rows);
  const label = subjectLabel(domain);
  return (
    <section className="eff-vizsec">
      <div className="eff-vizhead">
        <div className="eff-vizhead-l">
          <button type="button" className="eff-back" onClick={onBack}>
            <LoomIcon name="arrowL" size={14} />
            返回科目
          </button>
          <div className="card-title">
            {label} · 显著变化知识点{' '}
            <span className="eff-vizhead-sub meta">最多 {data.metadata.notable_limit} 个</span>
          </div>
        </div>
      </div>
      {whole && <EffSubjectWholeRow label={label} whole={whole} />}
      {kcs.length > 0 ? (
        <div className="eff-rows">
          {kcs.map((kc) => (
            <EffSparkRow key={kc.knowledge_id} kc={kc} navigate={navigate} />
          ))}
        </div>
      ) : (
        !whole && (
          <div className="eff-reserve">
            <LoomIcon name="layers" size={18} />
            <div>
              <div className="eff-reserve-t">这科还没有更细的知识点趋势</div>
              <div className="eff-reserve-s">继续练习后，这里会逐步展开。</div>
            </div>
          </div>
        )
      )}
    </section>
  );
}

// ── 空态 / 故障态（认识论诚实：不画假线 / 不回落全 0）─────────────────────────
function EffEmpty({ navigate }: { navigate: (to: string) => void }) {
  return (
    <div className="eff-empty">
      <span className="eff-empty-ic">
        <LoomIcon name="target" size={26} />
      </span>
      <div className="eff-empty-t serif">还没有成效数据</div>
      <p className="eff-empty-s">
        成效是「相对过去的你」。现在还没有一条作答记录长出趋势 —— 没有起点，就画不出方向。去练几道，
        这里会长出每块的涨 / 保持 / 退。<b>我不会先画一条假的上升线，也不画一条 0 值平线。</b>
      </p>
      <button type="button" className="eff-cta" onClick={() => navigate('/practice')}>
        <LoomIcon name="layers" size={15} />
        去练几道
      </button>
    </div>
  );
}

function EffError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="eff-error" role="alert">
      <span className="eff-error-ic">
        <LoomIcon name="alert" size={22} />
      </span>
      <div className="eff-error-body">
        <div className="eff-error-t">成效数据暂时取不到</div>
        <p className="eff-error-s">
          这次没能加载趋势。<b>不会把加载失败显示成「全部 0」或「全部持平」</b>，
          以免把「暂时读不到」误成「没有变化」。请稍后重试。
        </p>
      </div>
      <button type="button" className="eff-cta secondary" onClick={onRetry}>
        <LoomIcon name="refresh" size={15} />
        重试
      </button>
    </div>
  );
}

// embedded（YUK-523）：Coach 复盘中枢「成效趋势」视图直接挂载本面时，复盘中枢壳已统一持 page-head
// （eyebrow / 标题 / 视图 lede），故 embedded 模式下 PanelShell 不再渲自己的 page-head——只回 children。
// 独立路由 / 旧调用点（embedded 缺省 false）保持原 page-head 不变。
function PanelShell({
  children,
  embedded = false,
}: {
  children: React.ReactNode;
  embedded?: boolean;
}) {
  if (embedded) return <>{children}</>;
  return (
    <>
      <div className="page-head">
        <div className="eyebrow">复盘 · 成效趋势</div>
        <div className="page-head-row">
          <h1 className="page-title serif">成效趋势</h1>
        </div>
        <p className="page-lead">
          成效答「相对上次，我涨了吗」—— 和过去的你比，不和任何标准比。慢热期只信相对方向，
          绝对数字别太当真；退步也如实说，不替你美化。
        </p>
      </div>
      {children}
    </>
  );
}

export function EffectivenessTrendPanel({
  navigate,
  embedded = false,
}: {
  navigate: (to: string) => void;
  embedded?: boolean;
}) {
  const [drill, setDrill] = useState<{ domain: string | null } | null>(null);
  const q = useQuery({ queryKey: ['effectiveness-trend'], queryFn: getEffectivenessTrend });

  if (q.isLoading) {
    return (
      <PanelShell embedded={embedded}>
        <LoomCard pad>
          <SkLines rows={5} />
        </LoomCard>
      </PanelShell>
    );
  }
  if (q.isError) {
    return (
      <PanelShell embedded={embedded}>
        <EffError onRetry={() => q.refetch()} />
      </PanelShell>
    );
  }
  if (!q.data) return <PanelShell embedded={embedded}>{null}</PanelShell>;
  if (q.data.series.length === 0) {
    return (
      <PanelShell embedded={embedded}>
        <EffEmpty navigate={navigate} />
      </PanelShell>
    );
  }

  const data = q.data;
  return (
    <PanelShell embedded={embedded}>
      <EffOverview series={data.series} />
      {drill === null ? (
        <RollupScreen data={data} onDrill={(domain) => setDrill({ domain })} />
      ) : (
        <DrilldownScreen
          data={data}
          domain={drill.domain}
          navigate={navigate}
          onBack={() => setDrill(null)}
        />
      )}
    </PanelShell>
  );
}
