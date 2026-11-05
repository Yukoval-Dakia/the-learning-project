// YUK-523 (复盘中枢 ② 校准诊断) — Coach 复盘中枢的「校准诊断」视图。
//
// 横截面 θ̂/p(L) 点估计 + 置信，答「我现在这块会不会、多可信」。成效趋势（纵向「涨没涨」）的姊妹面、
// 与之正交。读模型是 GET /api/observability/calibration-maturity，本面只读不写。onboarding
// ScreenProfile 也渲一份成熟度对账，二者共享同一读模型，互不影响。
//
// 读函数与顶部「本设备重导对账」徽章（onboarding CalibrationMaturityBadge，gate 同 ScreenProfile）
// 由 /coach 路由注入；shell 不 value-import onboarding。
//
// ⑥红线（ADR-0035）：tier 只表「可信 / 不可信 + 相对次序」，绝不当精确掌握分；θ̂ SE 是置信量（标准误，
// 越小越可信），不是掌握度 %；证据不足显示「— 数据不足」，绝不补一个看起来精确的分数。
//
// 形态 PORT 自设计 docs/design/loom-refresh/project/screen-calibration.jsx（去掉 admin-h / cal-lede——
// 复盘中枢壳已统一持 head + lede）；纯视图逻辑（tier / 排序 / SE 定位 / lane）抽在 calibration-view.ts。
//
// YUK-1473 — M3E presentation (docs/design/2026-11-03-coach-m3e.md): ui-next Button / Chip /
// SkeletonLines / RetryLine, lucide icons, scoped coach-m3e.css. Query, sorting and tiers unchanged.

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Eye, Target } from 'lucide-react';
import { useState } from 'react';
import type {
  CalibrationMaturityBadge,
  CalibrationMaturityResponse,
  PlacementProfileClient,
} from '@/capabilities/onboarding/ui-public';
import { RetryLine } from '@/ui-next/primitives/RetryLine';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { Button, Chip, type ChipTone } from '@/ui-next/public';
import { AreaEmpty } from './AreaGate';
import {
  type CalRow,
  type CalSort,
  type CalTier,
  ariaSortFor,
  calCounts,
  calDots,
  calSorted,
  nextSort,
  seFillPct,
  seToX,
  sortCaret,
  toCalRows,
} from './calibration-view';
import './coach-m3e.css';

// tier → 徽章色调 + 文案（ui-next Chip 的状态色调：可信 positive、渐稳 caution、冷启 neutral）。
const TIER_META: Record<CalTier, { label: string; tone: ChipTone }> = {
  firm: { label: '可信', tone: 'positive' },
  warming: { label: '渐稳', tone: 'caution' },
  blind: { label: '冷启', tone: 'neutral' },
};

export type CoachCalibrationReader = PlacementProfileClient['getCalibrationMaturity'];
export type CoachCalibrationBadge = typeof CalibrationMaturityBadge;

export function CoachCalibrationView({
  navigate,
  readCalibration,
  MaturityBadge,
}: {
  navigate: (to: string) => void;
  readCalibration: CoachCalibrationReader;
  MaturityBadge: CoachCalibrationBadge;
}) {
  const q = useQuery({ queryKey: ['calibration-maturity'], queryFn: readCalibration });

  if (q.isLoading) {
    return (
      <div className="ch-card">
        <SkeletonLines rows={5} label="正在读取校准诊断" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return <RetryLine message="校准成熟度加载失败。" onRetry={() => q.refetch()} />;
  }
  if (q.data.rows.length === 0) {
    return (
      <AreaEmpty
        icon={Target}
        title="还没有可校准的知识点"
        text="先做一轮定位或上传材料，知识点会随练习长出来——这里会显示每块的「可信 / 不可信 + 相对排序」。"
        action={
          <Button variant="primary" onClick={() => navigate('/practice')}>
            去练几道
            <ArrowRight size={16} aria-hidden="true" />
          </Button>
        }
      />
    );
  }

  return <CalibrationBody data={q.data} navigate={navigate} MaturityBadge={MaturityBadge} />;
}

function CalibrationBody({
  data,
  navigate,
  MaturityBadge,
}: {
  data: CalibrationMaturityResponse;
  navigate: (to: string) => void;
  MaturityBadge: CoachCalibrationBadge;
}) {
  const [sort, setSort] = useState<CalSort>({ key: 'se', dir: 1 }); // 默认按 θ̂ SE 升序 → 最可信在上
  const [showAllBlind, setShowAllBlind] = useState(false);
  const rows = toCalRows(data.rows);
  // 双源但同定义（OCR）：meter 大数字 + firm_count 用 server `agg`（权威横截面聚合）；firmbar
  // 的 firm/warming/blind 三段用 client `calCounts(rows)`（agg 不带 warming/blind 细分，必须
  // client recount 才能分段）。两者的 firm 定义 provably 一致——server 保证 evidence=0 ⟹
  // cold_start(=blind)，client `calTier` 同逻辑（evidence=0 优先判 blind 早于 firm），故
  // `counts.firm` ≡ `agg.firm_count`，firm 段宽与 meter 数不会自相矛盾。
  const counts = calCounts(rows);
  const blind = rows.filter((r) => r.tier === 'blind');
  const sorted = calSorted(rows, sort);
  const diagnosed = sorted.filter((row) => row.evidence_count > 0);
  const visibleBlind = showAllBlind ? blind : blind.slice(0, 6);
  const dots = calDots(rows);
  const onSort = (key: CalSort['key']) => setSort((s) => nextSort(s, key));

  const agg = data.aggregate;
  const pct = Math.round(agg.pct_firm * 100);
  const median = agg.median_theta_se;
  const total = Math.max(agg.total_kcs, 1); // 防 /0（rows.length>0 已保 total≥1，留作护栏）

  return (
    <div className="cb">
      {/* #41 profile 级重算徽章 · 本设备核对概览算术（gate 同 ScreenProfile） */}
      <MaturityBadge data={data} />

      {/* A · firm-up 概览 */}
      <div className="cb-overview">
        <section className="ch-card cb-meter" aria-label="判断可信度概览">
          <div className="cb-meter-fig">
            <span className="cb-meter-num un-num">
              {pct}
              <span className="cb-meter-pct">%</span>
            </span>
            <span className="cb-meter-cap">区间已收窄的知识点</span>
          </div>
          <div className="cb-meter-side">
            <p className="cb-meter-line">
              <b className="un-num">{agg.firm_count}</b> / {agg.total_kcs} 个知识点区间已收窄
            </p>
            <p className="ch-note">判断越稳定，越适合用来安排后续复习。</p>
            <div className="ch-dist-bar">
              <span
                className="ch-dist-seg"
                data-tone="good"
                style={{ width: `${(counts.firm / total) * 100}%` }}
                title={`可信 ${counts.firm}`}
              />
              <span
                className="ch-dist-seg"
                data-tone="hard"
                style={{ width: `${(counts.warming / total) * 100}%` }}
                title={`渐稳 ${counts.warming}`}
              />
              <span
                className="ch-dist-seg"
                data-tone="none"
                style={{ width: `${(counts.blind / total) * 100}%` }}
                title={`冷启盲区 ${counts.blind}`}
              />
            </div>
            <div className="ch-legend">
              <span>
                <i data-tone="good" />
                可信 <b className="un-num">{counts.firm}</b>
              </span>
              <span>
                <i data-tone="hard" />
                渐稳 <b className="un-num">{counts.warming}</b>
              </span>
              <span>
                <i data-tone="none" />
                盲区 <b className="un-num">{counts.blind}</b>
              </span>
            </div>
          </div>
        </section>

        <div className="cb-stats">
          <div className="ch-kpi">
            <span className="ch-kpi-l">知识点</span>
            <strong className="ch-kpi-n">{agg.total_kcs}</strong>
          </div>
          <div className="ch-kpi" data-tone="good">
            <span className="ch-kpi-l">判断可信</span>
            <strong className="ch-kpi-n">{agg.firm_count}</strong>
          </div>
          <div className="ch-kpi">
            <span className="ch-kpi-l">尚无作答</span>
            <strong className="ch-kpi-n">{agg.cold_start_count}</strong>
          </div>
          <div className="ch-kpi" data-tone="accent">
            <span className="ch-kpi-l">盲区 · 从没练过</span>
            <strong className="ch-kpi-n">{counts.blind}</strong>
          </div>
        </div>
      </div>

      {/* B · 冷启盲区（actionable） */}
      {blind.length > 0 && (
        <section className="ch-card cb-blind" aria-labelledby="cb-h-blind">
          <div className="cb-blind-head">
            <span className="cb-blind-ic" aria-hidden="true">
              <Eye size={18} />
            </span>
            <div>
              <h2 id="cb-h-blind" className="ch-card-title">
                冷启盲区 · <b className="un-num">{blind.length}</b> 个知识点从没练过
              </h2>
              <p className="ch-note">
                这些知识点还没有作答记录。练习一次后，系统才会开始形成判断。
              </p>
            </div>
          </div>
          <ul className="cb-blind-list">
            {visibleBlind.map((k) => (
              <li key={k.knowledge_id} className="cb-blind-item">
                <span className="cb-blind-name">{k.name}</span>
                <span className="cb-unknown">— 未知</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => navigate(`/knowledge/${encodeURIComponent(k.knowledge_id)}`)}
                >
                  去练
                  <ArrowRight size={14} aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
          {blind.length > 6 && (
            <Button
              size="sm"
              variant="quiet"
              className="cb-blind-more"
              aria-expanded={showAllBlind}
              onClick={() => setShowAllBlind((current) => !current)}
            >
              {showAllBlind ? '收起盲区列表' : `显示全部 ${blind.length} 个盲区`}
            </Button>
          )}
        </section>
      )}

      {/* C · θ̂ SE 分布 · 相对排序 */}
      <section className="ch-card" aria-labelledby="cb-h-strip">
        <div className="cb-card-h">
          <h2 id="cb-h-strip" className="ch-card-title">
            判断可靠度 · 相对排序
          </h2>
          <p className="ch-note">
            每个点代表一个知识点；越靠右表示依据更充分、判断更稳定。记录较少时只看相对顺序，
            不读作精确分数。
          </p>
        </div>
        <div className="cb-strip">
          <div className="cb-strip-track">
            {median != null && (
              <span className="cb-strip-median" style={{ left: `${seToX(median)}%` }}>
                <span className="cb-strip-median-lbl">中间位置</span>
              </span>
            )}
            {dots.map((d) => (
              <span
                key={d.knowledge_id}
                className="cb-dot"
                data-tier={d.tier}
                style={{ left: `${d.x}%`, bottom: `${14 + d.lane * 19}px` }}
                title={`${d.name} · ${d.evidence_count === 0 ? '尚无作答' : TIER_META[d.tier].label}`}
              >
                <span className="cb-dot-lbl">{d.name}</span>
              </span>
            ))}
          </div>
          <div className="cb-strip-axis">
            <span>依据较少</span>
            <span className="cb-strip-axis-mid">判断较弱 ← 相对排序 → 判断较稳</span>
            <span>依据较充分</span>
          </div>
        </div>
      </section>

      {/* D · 逐知识点成熟度 ledger */}
      <section className="cb-ledger" aria-labelledby="cb-h-table">
        <div className="cb-table-h">
          <h2 id="cb-h-table" className="ch-card-title">
            有作答记录的知识点
          </h2>
          <span className="ch-note">{diagnosed.length} 个知识点 · 可按表头排序</span>
        </div>
        <div className="ch-card cb-table-card">
          {diagnosed.length === 0 ? (
            <p className="ch-note cb-table-empty">
              还没有带作答证据的知识点；上面的盲区不冒充已诊断结果。
            </p>
          ) : (
            <section className="cb-table-scroll" aria-label="有作答记录的知识点表格，可横向滚动">
              <table className="cb-table">
                <thead>
                  <tr>
                    <th aria-sort={ariaSortFor(sort, 'name')}>
                      <button
                        type="button"
                        className="cb-th-btn un-hit"
                        onClick={() => onSort('name')}
                      >
                        知识点{sortCaret(sort, 'name')}
                      </button>
                    </th>
                    <th className="cb-num" aria-sort={ariaSortFor(sort, 'evidence')}>
                      <button
                        type="button"
                        className="cb-th-btn un-hit"
                        onClick={() => onSort('evidence')}
                      >
                        证据{sortCaret(sort, 'evidence')}
                      </button>
                    </th>
                    <th aria-sort={ariaSortFor(sort, 'se')}>
                      <button
                        type="button"
                        className="cb-th-btn un-hit"
                        onClick={() => onSort('se')}
                      >
                        判断可靠度{sortCaret(sort, 'se')}
                      </button>
                    </th>
                    <th aria-sort={ariaSortFor(sort, 'tier')}>
                      <button
                        type="button"
                        className="cb-th-btn un-hit"
                        onClick={() => onSort('tier')}
                      >
                        判断阶段{sortCaret(sort, 'tier')}
                      </button>
                    </th>
                    <th>题目置信度</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {diagnosed.map((k) => (
                    <CalLedgerRow key={k.knowledge_id} k={k} navigate={navigate} />
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>
      </section>
      <p className="ch-note cb-foot">
        这里的阶段只表达判断是否已有足够依据，以及知识点之间的相对顺序。<b>题目置信度</b>
        只在依据充分后给出；证据不足时显示「— 数据不足」，不补一个看起来精确的分数。
      </p>
    </div>
  );
}

function CalLedgerRow({ k, navigate }: { k: CalRow; navigate: (to: string) => void }) {
  const m = TIER_META[k.tier];
  return (
    <tr className="cb-row" data-tier={k.tier}>
      <td>
        <span className="cb-name">{k.name}</span>
      </td>
      <td className="cb-num un-num">
        {k.evidence_count === 0 ? (
          <span className="cb-ev0">
            0 <span className="ch-note">从未作答</span>
          </span>
        ) : (
          k.evidence_count
        )}
      </td>
      <td>
        <div className="cb-se">
          <span className="cb-se-txt">{TIER_META[k.tier].label}</span>
          <span className="cb-se-bar">
            <span
              className="cb-se-fill"
              data-tier={k.tier}
              style={{ width: `${seFillPct(k.display_se)}%` }}
            />
          </span>
        </div>
      </td>
      <td>
        <Chip tone={m.tone}>{m.label}</Chip>
        {k.tier === 'blind' && <span className="ch-note cb-blind-tag">盲区</span>}
      </td>
      <td>
        {k.tier === 'firm' && k.confidence != null ? (
          <span className="cb-conf un-num">{Math.round(k.confidence * 100)}%</span>
        ) : (
          <span className="ch-note" title="证据不足，不给精确分数">
            — 数据不足
          </span>
        )}
      </td>
      <td className="cb-num">
        {k.tier !== 'firm' && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => navigate(`/knowledge/${encodeURIComponent(k.knowledge_id)}`)}
          >
            去练
            <ArrowRight size={14} aria-hidden="true" />
          </Button>
        )}
      </td>
    </tr>
  );
}
