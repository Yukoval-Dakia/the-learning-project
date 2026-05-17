'use client';

// Phase 1d — learning_session detail page.
//
// Surfaces a single session row + every event chained via session_id, with
// per-rating stats computed client-side. Stub area reserves space for
// SessionSummaryTask output (RESUME.md item 2 follow-up).

import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { formatRelTime } from '@/ui/lib/utils';
import { Badge, type BadgeTone } from '@/ui/primitives/Badge';
import { PageHeader } from '@/ui/primitives/PageHeader';
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

const STATUS_TONE: Record<string, BadgeTone> = {
  started: 'info',
  completed: 'good',
  abandoned: 'neutral',
  failed: 'again',
};

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
  hard: '勉强',
  good: '会',
  easy: '熟练',
};

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

  return (
    <main className="page">
      <p className="breadcrumb">
        <Link href="/today">← 今日</Link>
      </p>

      <PageHeader
        title="学习会话"
        eyebrow={`/learning-sessions/${id.slice(0, 8)}…`}
        sub="learning_session 行 + session_id 串联的事件流。"
      />

      {q.isLoading && (
        <div className="event-card">
          <p className="ec-row">加载中…</p>
        </div>
      )}

      {q.isError && (
        <div className="event-card">
          <p className="ec-row" style={{ color: 'var(--again-ink)' }}>
            {q.error instanceof ApiAuthError
              ? `${q.error.message} — 请重新进入页面输入 token`
              : `加载失败：${(q.error as Error).message}`}
          </p>
        </div>
      )}

      {q.isSuccess && <SessionView session={q.data} />}
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

  return (
    <>
      <div className="session-meta">
        <MetaCell label="类型">{TYPE_LABEL[session.type] ?? session.type}</MetaCell>
        <MetaCell label="状态">
          <Badge tone={STATUS_TONE[session.status] ?? 'neutral'}>{session.status}</Badge>
        </MetaCell>
        <MetaCell label="时长">
          {session.duration_ms !== null ? formatDuration(session.duration_ms) : '—'}
        </MetaCell>
        <MetaCell label="复习题数">
          {totalRated}
          <small>题</small>
        </MetaCell>
        <MetaCell label="AI 成本">
          {totalCostUsd > 0 ? `$${totalCostUsd.toFixed(5)}` : '$0'}
        </MetaCell>
        <MetaCell label="开始">{formatRelTime(new Date(session.started_at * 1000))}</MetaCell>
      </div>

      {totalRated > 0 && (
        <>
          <div className="session-rating-bar">
            {(['again', 'hard', 'good', 'easy'] as Rating[]).map((r) => {
              const pct = (ratingCounts[r] / totalRated) * 100;
              if (pct === 0) return null;
              return (
                <div
                  key={r}
                  className={`seg ${r}`}
                  style={{ width: `${pct}%` }}
                  title={`${RATING_LABELS[r]} ${ratingCounts[r]} / ${totalRated}`}
                >
                  {pct > 15 ? `${RATING_LABELS[r]} ${ratingCounts[r]}` : ratingCounts[r]}
                </div>
              );
            })}
          </div>
          <div className="session-rating-legend">
            {(['again', 'hard', 'good', 'easy'] as Rating[]).map((r) => (
              <span key={r} className="item">
                <span className={`swatch ${r}`} /> {RATING_LABELS[r]} {ratingCounts[r]}
              </span>
            ))}
          </div>
        </>
      )}

      <section
        className={`session-summary${session.summary_md ? '' : ' is-stub'}`}
        aria-label="session summary"
      >
        <h4>AI 总结</h4>
        {session.summary_md ? (
          <p>{session.summary_md}</p>
        ) : (
          <p>
            尚未生成 — SessionSummaryTask 计划在 session close 事件后自动跑（Phase 1d 后续；当前
            stub）。
          </p>
        )}
      </section>

      <p className="event-rail-label">事件流 · {session.events.length} 条</p>
      {session.events.length === 0 ? (
        <div className="event-card">
          <p className="ec-row">这个 session 还没有事件挂上来。</p>
        </div>
      ) : (
        session.events.map((e) => <SessionEventCard key={e.id} event={e} />)
      )}
    </>
  );
}

function MetaCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="meta-cell">
      <span className="lbl">{label}</span>
      <span className="val">{children}</span>
    </div>
  );
}

function actionTone(action: string): BadgeTone {
  if (action === 'attempt') return 'again';
  if (action === 'review') return 'good';
  if (action === 'judge' || action === 'generate') return 'info';
  if (action === 'propose' || action.startsWith('experimental:')) return 'coral';
  return 'neutral';
}

function outcomeTone(outcome: string): BadgeTone {
  if (outcome === 'failure') return 'again';
  if (outcome === 'success') return 'good';
  if (outcome === 'partial') return 'hard';
  return 'neutral';
}

function SessionEventCard({ event }: { event: SessionEvent }) {
  const ratingFromPayload = (event.payload as { fsrs_rating?: string }).fsrs_rating;
  const responseMd = (event.payload as { user_response_md?: string | null }).user_response_md;
  const durationMs = (event.payload as { duration_ms?: number }).duration_ms;
  return (
    <article className="event-card">
      <div className="ec-head">
        <Badge tone={actionTone(event.action)}>{event.action}</Badge>
        <Badge tone="neutral">{event.subject_kind}</Badge>
        {event.outcome && <Badge tone={outcomeTone(event.outcome)}>{event.outcome}</Badge>}
        {ratingFromPayload && (
          <Badge tone={outcomeTone(event.outcome ?? '')}>{ratingFromPayload}</Badge>
        )}
        {typeof durationMs === 'number' && (
          <Badge tone="neutral">⏱ {formatDuration(durationMs)}</Badge>
        )}
        <span className="when">{formatRelTime(new Date(event.created_at * 1000))}</span>
      </div>

      {event.question && (
        <p className="ec-row" style={{ alignItems: 'flex-start' }}>
          <span className="lbl">题面</span>
          <span style={{ fontFamily: 'var(--font-wenyan)', fontSize: '14.5px' }}>
            {event.question.prompt_md}
          </span>
        </p>
      )}

      {responseMd && (
        <p className="ec-row" style={{ alignItems: 'flex-start' }}>
          <span className="lbl">回答</span>
          <span style={{ fontFamily: 'var(--font-wenyan)', fontSize: '14px' }}>{responseMd}</span>
        </p>
      )}

      <p className="ec-jump">
        <Link href={`/events/${event.id}`}>→ 事件详情</Link>
      </p>
    </article>
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
