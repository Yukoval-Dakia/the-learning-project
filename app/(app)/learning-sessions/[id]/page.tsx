'use client';

// Phase 1d — learning_session detail page (loom redraw, wave 2 / YUK-169).
//
// Surfaces a single session row + every event chained via session_id, with
// per-rating stats computed client-side. Stub area reserves space for
// SessionSummaryTask output (RESUME.md item 2 follow-up).

import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { formatRelTime } from '@/ui/lib/utils';
import { Btn } from '@/ui/primitives/Btn';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SectionLabel } from '@/ui/primitives/SectionLabel';
import { SkLines } from '@/ui/primitives/SkLines';
import { Stateful, type StatefulStatus } from '@/ui/primitives/Stateful';
import { StatusBadge } from '@/ui/primitives/StatusBadge';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { use } from 'react';

interface SessionEvent {
  id: string;
  action: string;
  actor_kind: string;
  actor_ref: string;
  subject_kind: string;
  subject_id: string;
  outcome: string | null;
  payload: Record<string, unknown>;
  caused_by_event_id: string | null;
  cost_micro_usd: number | null;
  created_at: number;
  question: { id: string; prompt_md: string; reference_md: string | null } | null;
}

interface SessionDetail {
  id: string;
  type: string;
  status: string;
  summary_md: string | null;
  goal_id: string | null;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  version: number;
  events: SessionEvent[];
}

const TYPE_LABEL: Record<string, string> = {
  review: '复习',
  ingestion: '录入',
  tutor: '辅导',
  explore: '探索',
  create: '创作',
  conversation: '对话',
};

type Rating = 'again' | 'hard' | 'good' | 'easy';
const RATING_LABELS: Record<Rating, string> = {
  again: '不会',
  hard: '模糊',
  good: '会了',
  easy: '熟练',
};

// event-chain dot tone by outcome / rating (non-color cue carried by label).
function eventTone(e: SessionEvent): string {
  const rating = (e.payload as { fsrs_rating?: string }).fsrs_rating;
  if (rating && rating in RATING_LABELS) return rating === 'easy' ? 'good' : rating;
  if (e.outcome === 'failure') return 'again';
  if (e.outcome === 'success') return 'good';
  if (e.outcome === 'partial') return 'hard';
  return 'info';
}

export default function SessionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const q = useQuery({
    queryKey: ['learning-session', id],
    queryFn: () => apiJson<SessionDetail>(`/api/learning-sessions/${id}`),
  });

  const state: StatefulStatus = q.isLoading ? 'loading' : q.isError ? 'error' : 'ok';
  const errorText =
    q.error instanceof ApiAuthError
      ? `${q.error.message} — 请重新进入页面输入 token`
      : q.error
        ? `加载失败：${(q.error as Error).message}`
        : '会话加载失败。';

  return (
    <main className="page page-narrow sessions-loom">
      <Link href="/learning-sessions" className="back-link" style={{ textDecoration: 'none' }}>
        <LoomIcon name="arrowL" size={14} />
        学习会话
      </Link>

      <div className="page-head">
        <div className="eyebrow">SESSION · {id.slice(0, 8)}…</div>
        <div className="page-head-row">
          <h1 className="page-title serif">会话详情</h1>
          {q.isSuccess && <StatusBadge status={q.data.status} />}
        </div>
      </div>

      <Stateful
        status={state}
        onRetry={() => q.refetch()}
        errorText={errorText}
        skeleton={
          <LoomCard pad>
            <SkLines rows={3} />
          </LoomCard>
        }
      >
        {q.isSuccess && <SessionView session={q.data} />}
      </Stateful>
    </main>
  );
}

function SessionView({ session }: { session: SessionDetail }) {
  const reviewEvents = session.events.filter(
    (e) => e.action === 'review' && e.subject_kind === 'question',
  );
  const ratingCounts: Record<Rating, number> = { again: 0, hard: 0, good: 0, easy: 0 };
  for (const e of reviewEvents) {
    const r = (e.payload as { fsrs_rating?: string }).fsrs_rating as Rating | undefined;
    if (r && r in ratingCounts) ratingCounts[r] += 1;
  }
  const totalRated = reviewEvents.length;

  const totalCostUsd = session.events.reduce((s, e) => s + (e.cost_micro_usd ?? 0), 0) / 1e6;

  // gap G3: no model dimension is aggregated server-side — sess-summary keeps
  // 4 real cells (type / duration / count / cost), prototype's 5th "模型" cell
  // is dropped rather than mocked. Model needs a task_run join (deferred).
  return (
    <>
      <div className="sess-summary">
        <SumCell label="类型">{TYPE_LABEL[session.type] ?? session.type}</SumCell>
        <SumCell label="时长">
          {session.duration_ms !== null ? formatDuration(session.duration_ms) : '—'}
        </SumCell>
        <SumCell label="复习数">{totalRated}</SumCell>
        <SumCell label="成本">{totalCostUsd > 0 ? `$${totalCostUsd.toFixed(5)}` : '$0'}</SumCell>
      </div>

      {totalRated > 0 && (
        <LoomCard pad style={{ marginTop: 'var(--s-5)' }}>
          <div className="card-head">
            <span className="card-icon">
              <LoomIcon name="review" size={18} />
            </span>
            <div className="card-title">评分分布</div>
            <span className="meta" style={{ marginLeft: 'auto' }}>
              {totalRated} 次
            </span>
          </div>
          {/* gap G4: real data has 4 tiers (incl. easy) vs prototype's 3 — keep all 4 */}
          <div className="dist-bar">
            {(['again', 'hard', 'good', 'easy'] as Rating[]).map((r) => {
              const pct = (ratingCounts[r] / totalRated) * 100;
              if (pct === 0) return null;
              return (
                <span
                  key={r}
                  className={`dist-seg tone-${r}`}
                  style={{ width: `${pct}%` }}
                  title={`${RATING_LABELS[r]} ${ratingCounts[r]} / ${totalRated}`}
                />
              );
            })}
          </div>
          <div className="dist-legend">
            {(['again', 'hard', 'good', 'easy'] as Rating[]).map((r) => (
              <span key={r}>
                <span className={`dist-key tone-${r}`} />
                {RATING_LABELS[r]} <b className="mono">{ratingCounts[r]}</b>
              </span>
            ))}
          </div>
        </LoomCard>
      )}

      <LoomCard
        pad
        sunk
        style={{ marginTop: 'var(--s-4)', borderColor: 'var(--coral-line)' }}
        aria-label="session summary"
      >
        <div className="card-head">
          <span className="card-icon accent">
            <LoomIcon name="sparkle" size={18} />
          </span>
          <div className="card-title">AI 会话总结</div>
        </div>
        {session.summary_md ? (
          <p className="prose-cn" style={{ marginTop: 'var(--s-2)' }}>
            {session.summary_md}
          </p>
        ) : (
          <p className="prose-cn" style={{ marginTop: 'var(--s-2)' }}>
            尚未生成 — SessionSummaryTask 计划在 session close 事件后自动跑（Phase 1d 后续；当前
            stub）。
          </p>
        )}
      </LoomCard>

      <SectionLabel count={session.events.length}>逐事件流</SectionLabel>
      {session.events.length === 0 ? (
        <LoomCard pad>
          <p className="meta">这个 session 还没有事件挂上来。</p>
        </LoomCard>
      ) : (
        <LoomCard pad>
          <div className="event-chain">
            {session.events.map((e, i) => (
              <Link
                key={e.id}
                href={`/events/${e.id}`}
                className="event-row event-link"
                style={{ textDecoration: 'none' }}
              >
                <span className="event-rail">
                  <span className="event-dot" style={{ background: `var(--${eventTone(e)})` }} />
                  {i < session.events.length - 1 && <span className="event-line" />}
                </span>
                <div className="event-body">
                  <div className="event-head nowrap-meta">
                    <span className="mono event-label">
                      {e.action}
                      {e.outcome ? `:${e.outcome}` : ''}
                    </span>
                    <span className="meta">{formatRelTime(new Date(e.created_at * 1000))}</span>
                  </div>
                  <div className="meta mono">→ events:{e.id.slice(0, 8)}…</div>
                </div>
                <LoomIcon name="arrow" size={14} className="thread-arrow" />
              </Link>
            ))}
          </div>
        </LoomCard>
      )}
    </>
  );
}

function SumCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="sess-sum-cell">
      <div className="sess-sum-n serif">{children}</div>
      <div className="meta">{label}</div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const h = Math.floor(min / 60);
  const mm = min % 60;
  return `${h}h ${mm}m`;
}
