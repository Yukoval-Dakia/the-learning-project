// YUK-523 (复盘中枢 ② 校准诊断) — Coach 复盘中枢的「校准诊断」视图。
//
// 横截面 θ̂/p(L) 点估计 + 置信，答「我现在这块会不会、多可信」。成效趋势（纵向「涨没涨」）的姊妹面、
// 与之正交。**复用既有读模型** getCalibrationMaturity（GET /api/observability/calibration-maturity，
// calibration-maturity-api.ts）—— 读模型/逻辑不动，本面只读不写。**双挂**：onboarding ScreenProfile 也
// 渲一份成熟度对账，二者共享同一读模型，互不影响（ScreenProfile 保留不动）。
//
// 既有 RcMaturityBadge（onboarding/recompute/RecomputeComponents.tsx）原样复用为顶部「本设备重导对账」
// 徽章，gate 同 ScreenProfile（RECOMPUTE_BADGE_ENABLED）。
//
// ⑥红线（ADR-0035）：tier 只表「可信 / 不可信 + 相对次序」，绝不当精确掌握分；θ̂ SE 是置信量（标准误，
// 越小越可信），不是掌握度 %；证据不足显示「— 数据不足」，绝不补一个看起来精确的分数。
//
// 形态 PORT 自设计 docs/design/loom-refresh/project/screen-calibration.jsx（去掉 admin-h / cal-lede——
// 复盘中枢壳已统一持 head + lede）；纯视图逻辑（tier / 排序 / SE 定位 / lane）抽在 calibration-view.ts。

import { RcMaturityBadge } from '@/capabilities/onboarding/ui/recompute/RecomputeComponents';
import {
  type CalibrationMaturityResponse,
  getCalibrationMaturity,
} from '@/capabilities/onboarding/ui/recompute/calibration-maturity-api';
import {
  RECOMPUTE_BADGE_ENABLED,
  summarizeMaturity,
} from '@/capabilities/onboarding/ui/recompute/recompute-core';
import { Btn } from '@/ui/primitives/Btn';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { ErrorState } from '@/ui/primitives/ErrorState';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SkLines } from '@/ui/primitives/SkLines';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  type CalRow,
  type CalSort,
  type CalTier,
  calCounts,
  calDots,
  calSorted,
  nextSort,
  seFillPct,
  seToX,
  sortCaret,
  toCalRows,
} from './calibration-view';
import '@/capabilities/onboarding/ui/recompute/recompute.css';

// tier → 徽章色调 + 文案（badge tone-* 复用全局 badge 体系）。
const TIER_META: Record<CalTier, { label: string; tone: string }> = {
  firm: { label: '可信', tone: 'good' },
  warming: { label: '渐稳', tone: 'hard' },
  blind: { label: '冷启', tone: 'neutral' },
};

export function CoachCalibrationView({ navigate }: { navigate: (to: string) => void }) {
  const q = useQuery({ queryKey: ['calibration-maturity'], queryFn: getCalibrationMaturity });

  if (q.isLoading) {
    return (
      <LoomCard pad>
        <SkLines rows={5} />
      </LoomCard>
    );
  }
  if (q.isError || !q.data) {
    return <ErrorState text="校准成熟度加载失败。" onRetry={() => q.refetch()} />;
  }
  if (q.data.rows.length === 0) {
    return (
      <EmptyState
        icon="target"
        title="还没有可校准的知识点"
        text="先做一轮定位或上传材料，知识点会随练习长出来——这里会显示每块的「可信 / 不可信 + 相对排序」。"
        action={
          <Btn variant="primary" iconEnd="arrow" onClick={() => navigate('/practice')}>
            去练几道
          </Btn>
        }
      />
    );
  }

  return <CalibrationBody data={q.data} navigate={navigate} />;
}

function CalibrationBody({
  data,
  navigate,
}: {
  data: CalibrationMaturityResponse;
  navigate: (to: string) => void;
}) {
  const [sort, setSort] = useState<CalSort>({ key: 'se', dir: 1 }); // 默认按 θ̂ SE 升序 → 最可信在上
  const rows = toCalRows(data.rows);
  const counts = calCounts(rows);
  const blind = rows.filter((r) => r.tier === 'blind');
  const sorted = calSorted(rows, sort);
  const dots = calDots(rows);
  const onSort = (key: CalSort['key']) => setSort((s) => nextSort(s, key));

  const agg = data.aggregate;
  const pct = Math.round(agg.pct_firm * 100);
  const median = agg.median_theta_se;
  const medianStr = median != null ? median.toFixed(2) : '—';
  const total = Math.max(agg.total_kcs, 1); // 防 /0（rows.length>0 已保 total≥1，留作护栏）
  const maturity = summarizeMaturity(data);

  return (
    <div className="cal">
      {/* #41 profile 级重算徽章 · 本设备核对概览算术（gate 同 ScreenProfile） */}
      {RECOMPUTE_BADGE_ENABLED && <RcMaturityBadge summary={maturity} />}

      {/* A · firm-up 概览 */}
      <div className="cal-overview">
        <LoomCard pad className="cal-meter">
          <div className="cal-meter-fig">
            <span className="cal-meter-num serif">
              {pct}
              <span className="cal-meter-pct">%</span>
            </span>
            <span className="cal-meter-cap meta">知识图 firm 占比</span>
          </div>
          <div className="cal-meter-side">
            <div className="cal-meter-line">
              <b className="mono">{agg.firm_count}</b> / {agg.total_kcs} 知识点已可信
            </div>
            <div className="cal-meter-line meta">
              中位 θ̂ SE <b className="mono">{medianStr}</b> · 越小越可信
            </div>
            <div className="cal-firmbar">
              <span
                className="cal-firmbar-seg t-firm"
                style={{ width: `${(counts.firm / total) * 100}%` }}
                title={`可信 ${counts.firm}`}
              />
              <span
                className="cal-firmbar-seg t-warm"
                style={{ width: `${(counts.warming / total) * 100}%` }}
                title={`渐稳 ${counts.warming}`}
              />
              <span
                className="cal-firmbar-seg t-blind"
                style={{ width: `${(counts.blind / total) * 100}%` }}
                title={`冷启盲区 ${counts.blind}`}
              />
            </div>
            <div className="cal-legend">
              <span>
                <i className="t-firm" />
                可信 <b className="mono">{counts.firm}</b>
              </span>
              <span>
                <i className="t-warm" />
                渐稳 <b className="mono">{counts.warming}</b>
              </span>
              <span>
                <i className="t-blind" />
                盲区 <b className="mono">{counts.blind}</b>
              </span>
            </div>
          </div>
        </LoomCard>

        <div className="cal-stats">
          <div className="cal-stat is-total_kcs">
            <span className="cal-stat-num mono">{agg.total_kcs}</span>
            <span className="cal-stat-lbl meta">知识点</span>
          </div>
          <div className="cal-stat is-firm">
            <span className="cal-stat-num mono">{agg.firm_count}</span>
            <span className="cal-stat-lbl meta">可信 firm</span>
          </div>
          <div className="cal-stat is-cold">
            <span className="cal-stat-num mono">{agg.cold_start_count}</span>
            <span className="cal-stat-lbl meta">冷启 cold-start</span>
          </div>
          <div className="cal-stat is-blind">
            <span className="cal-stat-num mono">{counts.blind}</span>
            <span className="cal-stat-lbl meta">盲区 · 从没练过</span>
          </div>
        </div>
      </div>

      {/* B · 冷启盲区（actionable） */}
      {blind.length > 0 && (
        <LoomCard pad className="cal-blind">
          <div className="cal-blind-head">
            <span className="cal-blind-icon">
              <LoomIcon name="eye" size={16} />
            </span>
            <div>
              <div className="cal-blind-title">
                冷启盲区 · <b className="mono">{blind.length}</b> 个知识点从没练过
              </div>
              <div className="cal-blind-sub meta">
                evidence = 0 → θ̂ 一直停在冷启先验（se ≈ 1.00）。练它一次就能开始 firm up。
              </div>
            </div>
          </div>
          <div className="cal-blind-list">
            {blind.map((k) => (
              <div key={k.knowledge_id} className="cal-blind-chip">
                <span className="cal-blind-name">{k.name}</span>
                {k.track && <span className="cal-blind-track meta">{k.track}</span>}
                <span className="cal-blind-unknown mono">— 未知</span>
                <Btn
                  size="sm"
                  variant="ghost"
                  iconEnd="arrow"
                  onClick={() => navigate(`/knowledge/${encodeURIComponent(k.knowledge_id)}`)}
                >
                  去练
                </Btn>
              </div>
            ))}
          </div>
        </LoomCard>
      )}

      {/* C · θ̂ SE 分布 · 相对排序 */}
      <LoomCard pad className="cal-strip-card">
        <div className="cal-card-h">
          <div className="card-title">θ̂ 标准误分布 · 相对排序</div>
          <span className="meta">
            每个点一个圆；越靠右标准误越小、越可信。慢热期只信这条相对次序（adr-0035），不读精确分数。
          </span>
        </div>
        <div className="cal-strip">
          <div className="cal-strip-track">
            {median != null && (
              <span className="cal-strip-median" style={{ left: `${seToX(median)}%` }}>
                <span className="cal-strip-median-lbl mono">中位 {medianStr}</span>
              </span>
            )}
            {dots.map((d) => (
              <span
                key={d.knowledge_id}
                className={`cal-dot is-${d.tier}`}
                style={{ left: `${d.x}%`, bottom: `${14 + d.lane * 19}px` }}
                title={`${d.name} · se ${d.display_se.toFixed(2)}${d.evidence_count === 0 ? ' · 冷启' : ''}`}
              >
                <span className="cal-dot-lbl">{d.name}</span>
              </span>
            ))}
          </div>
          <div className="cal-strip-axis">
            <span className="mono">se ≈ 1.00</span>
            <span className="cal-strip-axis-mid meta">不可信 ← 相对排序 → 可信</span>
            <span className="mono">se 低</span>
          </div>
        </div>
      </LoomCard>

      {/* D · 逐知识点成熟度 ledger */}
      <div className="cal-table-h">
        <div className="card-title">逐知识点成熟度</div>
        <span className="meta mono">{rows.length} kcs · 点表头排序</span>
      </div>
      <LoomCard className="cal-table-card">
        <table className="cal-table">
          <thead>
            <tr>
              <th>
                <button type="button" className="cal-th-btn" onClick={() => onSort('name')}>
                  知识点{sortCaret(sort, 'name')}
                </button>
              </th>
              <th>track</th>
              <th className="num">
                <button type="button" className="cal-th-btn" onClick={() => onSort('evidence')}>
                  证据{sortCaret(sort, 'evidence')}
                </button>
              </th>
              <th>
                <button type="button" className="cal-th-btn" onClick={() => onSort('se')}>
                  θ̂ SE · 可信度{sortCaret(sort, 'se')}
                </button>
              </th>
              <th>
                <button type="button" className="cal-th-btn" onClick={() => onSort('tier')}>
                  成熟度{sortCaret(sort, 'tier')}
                </button>
              </th>
              <th>题目置信度</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sorted.map((k) => (
              <CalLedgerRow key={k.knowledge_id} k={k} navigate={navigate} />
            ))}
          </tbody>
        </table>
      </LoomCard>
      <p className="cal-foot meta">
        口径：成熟度只表「可信 / 不可信 + 相对次序」。<b>题目置信度</b>仅在知识点 firm
        后给出；证据不足时显示「— 数据不足」，绝不补一个看起来精确的分数。
      </p>
    </div>
  );
}

function CalLedgerRow({ k, navigate }: { k: CalRow; navigate: (to: string) => void }) {
  const m = TIER_META[k.tier];
  return (
    <tr className={`cal-row is-${k.tier}`}>
      <td>
        <span className="cal-name">{k.name}</span> <code className="cal-id">{k.knowledge_id}</code>
      </td>
      <td>
        {k.track ? <span className="cal-track">{k.track}</span> : <span className="meta">—</span>}
      </td>
      <td className="num mono">
        {k.evidence_count === 0 ? (
          <span className="cal-ev0">
            0 <span className="meta">从未作答</span>
          </span>
        ) : (
          k.evidence_count
        )}
      </td>
      <td>
        <div className="cal-se">
          <span className="cal-se-num mono">
            {/* 数字一律 derive display_se（cold-start 冠 ≈ 标先验）——不硬编码 '1.00'，
                免 server prior 改了文本撒谎而 bar(seFillPct) 仍对（reviewer NIT）。 */}
            {k.evidence_count === 0 ? `≈${k.display_se.toFixed(2)}` : k.display_se.toFixed(2)}
          </span>
          <span className="cal-se-bar">
            <span
              className={`cal-se-fill is-${k.tier}`}
              style={{ width: `${seFillPct(k.display_se)}%` }}
            />
          </span>
        </div>
      </td>
      <td>
        <span className={`badge tone-${m.tone}`}>{m.label}</span>
        {k.tier === 'blind' && <span className="cal-blind-tag meta">盲区</span>}
      </td>
      <td>
        {k.tier === 'firm' && k.confidence != null ? (
          <span className="cal-conf mono">{Math.round(k.confidence * 100)}%</span>
        ) : (
          <span className="cal-conf-na meta" title="证据不足，不给精确分数">
            — 数据不足
          </span>
        )}
      </td>
      <td className="num">
        {k.tier !== 'firm' && (
          <Btn
            size="sm"
            variant="ghost"
            iconEnd="arrow"
            onClick={() => navigate(`/knowledge/${encodeURIComponent(k.knowledge_id)}`)}
          >
            去练
          </Btn>
        )}
      </td>
    </tr>
  );
}
