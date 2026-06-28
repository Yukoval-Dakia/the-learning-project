// Phase 1d — Coach 周度 review 报表 (loom redraw, wave 2 / YUK-169)
// M5-T4b (YUK-321) — 迁 shell 包（spec §3.6「Coach 周报 keep · 归工作台/复盘面」
// → shell），SPA 路由 /coach。等价平移：useRouter → navigate prop，其余 wiring
// 逐字保留；旧 app/(app)/coach/page.tsx 改薄壳（Task 9 整体删）。
//
// Aggregates FSRS review activity over a 7d / 30d / 90d window. Computed from
// the event stream at request time (single-shot fetch per page load; client
// re-fetches on window change). Read-only: this surface never mutates.
//
// Redraw note (see docs/design/2026-06-04-redraw-coach-preflight.md):
//   - Visual layer ported from loom-prototype screen-coach.jsx; all wiring
//     (query / days state / WINDOW_OPTIONS / CAUSE_LABELS / correctRate)
//     preserved.
//   - The prototype's TodayPlan / strand / goal-strand sections are DROPPED:
//     the current /coach route has zero wiring for them. Those are future
//     Coach-engine surfaces (Coach brief -> ReviewPlanTask two-stage
//     pipeline + ADR-0025 goal strand) not yet exposed to this page. No mock.
//     Phase-deferred context: docs/design/2026-06-04-u0-decisions.md D5.

import { apiJson } from '@/ui/lib/api';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SectionLabel } from '@/ui/primitives/SectionLabel';
import { SkLines } from '@/ui/primitives/SkLines';
import { Stateful } from '@/ui/primitives/Stateful';
import { useCountUp } from '@/ui/primitives/useCountUp';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { EffectivenessTrendPanel } from './EffectivenessTrendPanel';

interface WeeklyResponse {
  window: { days: number; from: number; to: number };
  totals: { reviews: number; failures: number; cost_usd: number };
  ratings: { again: number; hard: number; good: number; easy: number };
  daily: Array<{ date: string; count: number; correct: number }>;
  top_causes: Array<{ category: string; count: number }>;
  top_knowledge: Array<{ id: string; name: string; failure_count: number }>;
}

type Window = 7 | 30 | 90;

const WINDOW_OPTIONS: { days: Window; label: string }[] = [
  { days: 7, label: '7 天' },
  { days: 30, label: '30 天' },
  { days: 90, label: '90 天' },
];

const CAUSE_LABELS: Record<string, string> = {
  concept: '概念',
  knowledge_gap: '知识缺',
  calculation: '运算',
  reading: '审题',
  memory: '记忆',
  expression: '表达',
  method: '方法',
  carelessness: '手滑',
  time_pressure: '时间',
  other: '其它',
};

// Loom CoachKpi — animated count-up KPI (screen-coach.jsx L2-6).
function CoachKpi({
  label,
  value,
  unit,
  prefix,
  active,
  decimals = 0,
}: {
  label: string;
  value: number;
  unit?: string;
  prefix?: string;
  active: boolean;
  decimals?: number;
}) {
  const v = useCountUp(value, { start: active, dur: 900, decimals });
  const shown = decimals > 0 ? v.toFixed(decimals) : Math.round(v);
  return (
    <div className="coach-kpi">
      <div className="coach-kpi-n serif tnum">
        {prefix}
        {shown}
        {unit ? <span className="coach-kpi-u">{unit}</span> : null}
      </div>
      <div className="coach-kpi-l meta">{label}</div>
    </div>
  );
}

// YUK-354 (A7) — Coach 从单一周报升级为「复盘中枢」雏形：顶部分段切两个正交视图
// （活动量 = 现有 FSRS 报表，不动逻辑；成效趋势 = 新纵向 delta 面）。完整三视图中枢
// （+ 校准诊断从 admin 迁入 + 容器重命名 + 默认视图决策）= YUK-523 紧邻 follow-up；
// 读模型规模化（窗口化 / notable 排序）= YUK-524（后端）。本面只做最小 2 视图切换。
type CoachView = 'activity' | 'effectiveness';

export default function CoachPage({ navigate }: { navigate: (to: string) => void }) {
  const [view, setView] = useState<CoachView>('activity');
  return (
    <main className="page view coach-loom coachhub">
      <div className="coachhub-switch">
        <div className="coachhub-tabs" role="tablist" aria-label="Coach 复盘视图">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'activity'}
            className={view === 'activity' ? 'coachhub-tab on' : 'coachhub-tab'}
            onClick={() => setView('activity')}
          >
            <LoomIcon name="review" size={15} />
            活动量
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'effectiveness'}
            className={view === 'effectiveness' ? 'coachhub-tab on' : 'coachhub-tab'}
            onClick={() => setView('effectiveness')}
          >
            <LoomIcon name="target" size={15} />
            成效趋势
          </button>
        </div>
      </div>
      {view === 'activity' ? (
        <CoachActivityView navigate={navigate} />
      ) : (
        <EffectivenessTrendPanel navigate={navigate} />
      )}
    </main>
  );
}

// 活动量视图 = 原 CoachPage 周报，逐字保留（只去掉外层 <main>，由复盘中枢壳统一持有）。
function CoachActivityView({ navigate }: { navigate: (to: string) => void }) {
  const [days, setDays] = useState<Window>(7);
  // Count-up animations: useCountUp(start: true) already animates 0→target on
  // mount, and `key={days}` below remounts CoachReport on window change. The
  // former rAF false→true toggle caused a one-frame final-value flash before
  // replaying (CodeRabbit, PR #294).
  const active = true;

  const q = useQuery({
    queryKey: ['weekly-review', days],
    queryFn: () => apiJson<WeeklyResponse>(`/api/review/weekly?days=${days}`),
  });

  // Empty only when the window has NO signal at all — a failure-only window
  // (attempt:failure / cost / causes / top-knowledge, zero reviews) must still
  // render the report (Codex, PR #294 r2).
  const windowIsEmpty =
    q.data !== undefined &&
    q.data.totals.reviews === 0 &&
    q.data.totals.failures === 0 &&
    q.data.totals.cost_usd === 0 &&
    q.data.top_causes.length === 0 &&
    q.data.top_knowledge.length === 0;
  const status = q.isLoading ? 'loading' : q.isError ? 'error' : windowIsEmpty ? 'empty' : 'ok';

  return (
    <>
      <div className="page-head">
        <div className="eyebrow">COACH · 只读分析 · 近 {days} 天</div>
        <div className="page-head-row">
          <h1 className="page-title serif">Coach 周报</h1>
          <div className="seg">
            {WINDOW_OPTIONS.map((opt) => (
              <button
                key={opt.days}
                type="button"
                className={days === opt.days ? 'on' : ''}
                onClick={() => setDays(opt.days)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <p className="page-lead">
          复盘最近的复习与错题：评分构成、逐日节奏、薄弱知识点与归因分布。只读，不改数据。
        </p>
      </div>

      <Stateful
        status={status}
        onRetry={() => q.refetch()}
        errorText="分析数据加载失败。"
        skeleton={
          <LoomCard pad>
            <SkLines rows={4} />
          </LoomCard>
        }
        empty={<EmptyState icon="target" title="窗口内无数据" text="该时间窗内还没有复习记录。" />}
      >
        {q.data ? (
          <CoachReport key={days} data={q.data} active={active} navigate={navigate} />
        ) : null}
      </Stateful>
    </>
  );
}

function CoachReport({
  data,
  active,
  navigate,
}: {
  data: WeeklyResponse;
  active: boolean;
  navigate: (to: string) => void;
}) {
  const { totals, ratings, daily, top_causes, top_knowledge } = data;
  const distTotal = ratings.again + ratings.hard + ratings.good + ratings.easy;
  const correctRate =
    totals.reviews > 0 ? Math.round(((ratings.good + ratings.easy) / totals.reviews) * 100) : 0;
  const causeTotal = top_causes.reduce((s, c) => s + c.count, 0);
  const maxDay = Math.max(1, ...daily.map((d) => d.count));
  const maxFail = Math.max(1, ...top_knowledge.map((k) => k.failure_count));

  return (
    <>
      <div className="coach-kpis stagger">
        <CoachKpi label="reviews" value={totals.reviews} active={active} />
        <CoachKpi label="正确率" value={correctRate} unit="%" active={active} />
        <CoachKpi label="新增错题" value={totals.failures} active={active} />
        <CoachKpi label="AI 成本" value={totals.cost_usd} prefix="$" active={active} decimals={3} />
      </div>

      <div className="coach-grid">
        <LoomCard pad>
          <div className="card-head">
            <span className="card-icon">
              <LoomIcon name="review" size={18} />
            </span>
            <div className="card-title">评分分布</div>
            <span className="meta" style={{ marginLeft: 'auto' }}>
              {distTotal} 次
            </span>
          </div>
          {distTotal > 0 && (
            <div className="dist-bar">
              <span
                className="dist-seg tone-again"
                style={{ width: `${(ratings.again / distTotal) * 100}%` }}
              />
              <span
                className="dist-seg tone-hard"
                style={{ width: `${(ratings.hard / distTotal) * 100}%` }}
              />
              <span
                className="dist-seg tone-good"
                style={{ width: `${(ratings.good / distTotal) * 100}%` }}
              />
              <span
                className="dist-seg tone-easy"
                style={{ width: `${(ratings.easy / distTotal) * 100}%` }}
              />
            </div>
          )}
          <div className="dist-legend">
            <span>
              <span className="dist-key tone-again" />
              不会 <b className="mono">{ratings.again}</b>
            </span>
            <span>
              <span className="dist-key tone-hard" />
              勉强 <b className="mono">{ratings.hard}</b>
            </span>
            <span>
              <span className="dist-key tone-good" />
              会了 <b className="mono">{ratings.good}</b>
            </span>
            <span>
              <span className="dist-key tone-easy" />
              熟练 <b className="mono">{ratings.easy}</b>
            </span>
          </div>
        </LoomCard>

        <LoomCard pad>
          <div className="card-head">
            <span className="card-icon">
              <LoomIcon name="bolt" size={18} />
            </span>
            <div className="card-title">归因分布</div>
            <span className="meta" style={{ marginLeft: 'auto' }}>
              只读
            </span>
          </div>
          {top_causes.length === 0 ? (
            <p className="meta">尚无归因数据。</p>
          ) : (
            <div className="cause-list">
              {top_causes.map((c) => (
                <div key={c.category} className="cause-row">
                  <span className="cause-name">{CAUSE_LABELS[c.category] ?? c.category}</span>
                  <div className="cause-track">
                    <span
                      style={{ width: `${causeTotal > 0 ? (c.count / causeTotal) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="mono cause-n">
                    {causeTotal > 0 ? Math.round((c.count / causeTotal) * 100) : 0}%
                  </span>
                </div>
              ))}
            </div>
          )}
        </LoomCard>
      </div>

      <SectionLabel>逐日复习量</SectionLabel>
      <LoomCard pad>
        {/* Per-day stack is 2-segment (correct=good / wrong=again): the
            weekly endpoint exposes only daily {count, correct}, not an
            again/hard/good per-day split. Three-tier per-day breakdown is
            phase-deferred to FSRS event-stream group-by-rating (P3) — see
            docs/design/2026-06-04-u0-decisions.md D1/D5. No mock. */}
        <div className="stack-chart">
          {daily.map((d) => {
            const wrong = d.count - d.correct;
            return (
              <div key={d.date} className="stack-col">
                <div className="stack-bars" style={{ height: 140 }}>
                  <span
                    className="stack-seg tone-good"
                    style={{ height: `${(d.correct / maxDay) * 140}px` }}
                    title={`对 ${d.correct}`}
                  />
                  <span
                    className="stack-seg tone-again"
                    style={{ height: `${(wrong / maxDay) * 140}px` }}
                    title={`错 ${wrong}`}
                  />
                </div>
                <span className="stack-x meta">{d.date.slice(5)}</span>
                <span className="stack-total mono">{d.count}</span>
              </div>
            );
          })}
        </div>
      </LoomCard>

      <SectionLabel>失败排行 · 按知识点</SectionLabel>
      <LoomCard pad>
        {top_knowledge.length === 0 ? (
          <p className="meta">窗口内无失败 attempt。</p>
        ) : (
          top_knowledge.map((k) => (
            <button
              key={k.id}
              type="button"
              className="fail-row"
              onClick={() => navigate(`/knowledge/${k.id}`)}
            >
              {/* de-wenyan: top_knowledge rows carry no subject/domain field, so
                  drop the hardcoded serif and use the neutral default font. */}
              <span className="fail-name">{k.name}</span>
              <div className="fail-track">
                <span
                  className="tone-again"
                  style={{ width: `${(k.failure_count / maxFail) * 100}%` }}
                />
              </div>
              <span className="mono fail-n">{k.failure_count} 次</span>
              <LoomIcon name="arrow" size={14} className="thread-arrow" />
            </button>
          ))
        )}
      </LoomCard>
    </>
  );
}
