'use client';

// Phase 1d — Coach 周度 review 报表
//
// Aggregates FSRS review activity over a 7d / 30d / 90d window. Computed from
// the event stream at request time (single-shot fetch per page load; client
// re-fetches on window change).

import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

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

export default function CoachPage() {
  const [days, setDays] = useState<Window>(7);

  const q = useQuery({
    queryKey: ['weekly-review', days],
    queryFn: () => apiJson<WeeklyResponse>(`/api/review/weekly?days=${days}`),
  });

  return (
    <main className="page">
      <PageHeader
        title="周度报表"
        eyebrow="/coach"
        sub="过去 N 天的 FSRS 复习、错题归因与 AI 提议总览。"
      />

      <div className="coach-window-tabs">
        {WINDOW_OPTIONS.map((opt) => (
          <button
            key={opt.days}
            type="button"
            className={days === opt.days ? 'is-on' : ''}
            onClick={() => setDays(opt.days)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {q.isLoading && (
        <div className="coach-panel">
          <p className="empty">加载中…</p>
        </div>
      )}

      {q.isError && (
        <div className="coach-panel">
          <p className="empty" style={{ color: 'var(--again-ink)' }}>
            {q.error instanceof ApiAuthError
              ? `${q.error.message} — 请重新进入页面输入 token`
              : `加载失败：${(q.error as Error).message}`}
          </p>
        </div>
      )}

      {q.isSuccess && <CoachReport data={q.data} />}
    </main>
  );
}

function CoachReport({ data }: { data: WeeklyResponse }) {
  const { totals, ratings, daily, top_causes, top_knowledge } = data;
  const total = ratings.again + ratings.hard + ratings.good + ratings.easy;
  const correctRate =
    totals.reviews > 0 ? Math.round(((ratings.good + ratings.easy) / totals.reviews) * 100) : 0;

  return (
    <>
      <div className="kpi-strip">
        <div className="kpi">
          <div className="kpi-label">复习总数</div>
          <div className="kpi-num">
            {totals.reviews}
            <small> 题</small>
          </div>
          <div className="kpi-trend">action=review · {data.window.days}d</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">正确率</div>
          <div className="kpi-num">
            {correctRate}
            <small> %</small>
          </div>
          <div
            className={`kpi-trend${correctRate >= 70 ? ' up' : correctRate < 50 ? ' down' : ''}`}
          >
            good + easy / 总数
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">新错题</div>
          <div className="kpi-num">
            {totals.failures}
            <small> 条</small>
          </div>
          <div className="kpi-trend">attempt:failure · {data.window.days}d</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">AI 成本</div>
          <div className="kpi-num">${totals.cost_usd.toFixed(3)}</div>
          <div className="kpi-trend">cost_micro_usd · {data.window.days}d</div>
        </div>
      </div>

      {total > 0 && (
        <div className="session-rating-bar">
          {(['again', 'hard', 'good', 'easy'] as const).map((r) => {
            const pct = (ratings[r] / total) * 100;
            if (pct === 0) return null;
            return (
              <div
                key={r}
                className={`seg ${r}`}
                style={{ width: `${pct}%` }}
                title={`${r} ${ratings[r]} / ${total}`}
              >
                {pct > 12 ? `${ratings[r]}` : ''}
              </div>
            );
          })}
        </div>
      )}
      <div className="session-rating-legend">
        <span className="item">
          <span className="swatch again" /> 不会 {ratings.again}
        </span>
        <span className="item">
          <span className="swatch hard" /> 勉强 {ratings.hard}
        </span>
        <span className="item">
          <span className="swatch good" /> 会 {ratings.good}
        </span>
        <span className="item">
          <span className="swatch easy" /> 熟练 {ratings.easy}
        </span>
      </div>

      <div className="coach-daily">
        <h4>每日 review 数（绿=对 / 红=错）</h4>
        <DailyBars daily={daily} />
        <div className="coach-daily-labels">
          {daily.map((d) => (
            <span key={d.date} className="lbl">
              {d.date.slice(5)}
            </span>
          ))}
        </div>
      </div>

      <div className="coach-grid">
        <div className="coach-panel">
          <h4>易错知识点</h4>
          {top_knowledge.length === 0 ? (
            <p className="empty">窗口内无失败 attempt。</p>
          ) : (
            <TopList
              entries={top_knowledge.map((k) => ({
                name: k.name,
                count: k.failure_count,
              }))}
              suffix=" 次"
            />
          )}
        </div>

        <div className="coach-panel">
          <h4>归因分布</h4>
          {top_causes.length === 0 ? (
            <p className="empty">尚无归因数据。</p>
          ) : (
            <TopList
              entries={top_causes.map((c) => ({
                name: CAUSE_LABELS[c.category] ?? c.category,
                count: c.count,
              }))}
              suffix=" 次"
            />
          )}
        </div>
      </div>
    </>
  );
}

function DailyBars({
  daily,
}: {
  daily: Array<{ date: string; count: number; correct: number }>;
}) {
  const max = Math.max(1, ...daily.map((d) => d.count));
  return (
    <div className="coach-daily-bars">
      {daily.map((d) => {
        const heightPct = (d.count / max) * 100;
        const correctPct = d.count > 0 ? (d.correct / d.count) * 100 : 0;
        return (
          <div
            key={d.date}
            className={`coach-daily-bar${d.count === 0 ? ' empty' : ''}`}
            title={`${d.date} · ${d.count} 题 · ${d.count > 0 ? Math.round(correctPct) : 0}% 对`}
          >
            <div className="stack" style={{ height: `${Math.max(heightPct, 2)}%` }}>
              {d.count > 0 && (
                <>
                  <div className="correct" style={{ flex: correctPct }} />
                  <div className="wrong" style={{ flex: 100 - correctPct }} />
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TopList({
  entries,
  suffix,
}: {
  entries: Array<{ name: string; count: number }>;
  suffix?: string;
}) {
  const max = Math.max(1, ...entries.map((e) => e.count));
  return (
    <>
      {entries.map((e) => (
        <div className="row" key={e.name}>
          <span className="name" title={e.name}>
            {e.name}
          </span>
          <span className="count">
            {e.count}
            {suffix}
          </span>
          <span className="meter">
            <span style={{ width: `${(e.count / max) * 100}%` }} />
          </span>
        </div>
      ))}
    </>
  );
}
