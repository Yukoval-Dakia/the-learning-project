import { Badge } from '@/ui/primitives/Badge';
import { Button } from '@/ui/primitives/Button';
import Link from 'next/link';

export type ReviewRating = 'again' | 'hard' | 'good';

export type ReviewRatingCounts = Record<ReviewRating, number>;

export interface ReviewSessionChrome {
  id: string;
  status: string;
  started_at: number | string | Date | null;
}

function secondsSince(value: ReviewSessionChrome['started_at']): number {
  if (!value) return 0;
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value < 10_000_000_000
          ? value * 1000
          : value
        : new Date(value).getTime();
  if (Number.isNaN(ms)) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 1000));
}

export function ReviewSessionRibbon({
  session,
  reviewedCount,
  totalCount,
}: {
  session: ReviewSessionChrome | null;
  reviewedCount: number;
  totalCount: number;
}) {
  if (!session) return null;
  const durMin = Math.floor(secondsSince(session.started_at) / 60);
  // YUK-57 — paused gets a different hint: pagehide listener intentionally
  // skips the completion beacon, and resume comes from in-page button or
  // /today SessionStrip's ?session= entry.
  const isPaused = session.status === 'paused';
  return (
    <div className="review-session-ribbon" aria-live="polite">
      <div className="rsr-left">
        <span className="rsr-dot" />
        <code className="rsr-id">{session.id}</code>
        <span className="rsr-meta">type='review' · status={session.status}</span>
      </div>
      <div className="rsr-mid">
        <span className="rsr-stat">
          已复习 <b>{reviewedCount}</b> / {totalCount}
        </span>
        <span className="rsr-sep">·</span>
        <span className="rsr-stat">
          {durMin} 分钟前 {isPaused ? 'paused' : 'started'}
        </span>
      </div>
      <div className="rsr-right">
        <span className="rsr-hint">
          {isPaused
            ? '⏸ 已暂停 · 点上方"继续刷题"或 /today 恢复 · cron 6h 兜底 abandon'
            : '退出页 → sendBeacon · cron 6h 兜底 abandon'}
        </span>
      </div>
    </div>
  );
}

export function SessionEndSummary({
  session,
  reviewedCount,
  ratings,
  durationSec,
  knowledgeTouched,
  aiSummary,
}: {
  session: ReviewSessionChrome | null;
  reviewedCount: number;
  ratings: ReviewRatingCounts;
  durationSec: number;
  knowledgeTouched: string[];
  aiSummary?: string | null;
}) {
  const mm = Math.floor(Math.max(0, durationSec) / 60);
  const ss = Math.max(0, durationSec) % 60;
  return (
    <div className="session-end-summary">
      <header className="ses-head">
        <div>
          <h3>本次 session 结束</h3>
          <div className="ses-meta">
            <code>{session?.id ?? 'local'}</code> · status='completed' · summary_md 异步写入
          </div>
        </div>
        <Badge tone="good" dot dotStatic>
          completed
        </Badge>
      </header>
      <div className="ses-stats">
        <div className="ses-stat">
          <b>{reviewedCount}</b>
          <span>已复习</span>
        </div>
        <div className="ses-stat tone-again">
          <b>{ratings.again}</b>
          <span>不会</span>
        </div>
        <div className="ses-stat tone-hard">
          <b>{ratings.hard}</b>
          <span>模糊</span>
        </div>
        <div className="ses-stat tone-good">
          <b>{ratings.good}</b>
          <span>会了</span>
        </div>
        <div className="ses-stat">
          <b>
            {mm}:{String(ss).padStart(2, '0')}
          </b>
          <span>用时</span>
        </div>
      </div>
      {knowledgeTouched.length > 0 && (
        <div className="ses-touched">
          <span className="ses-label">触及知识点</span>
          {knowledgeTouched.slice(0, 8).map((k) => (
            <code key={k} className="ses-k">
              {k}
            </code>
          ))}
        </div>
      )}
      <div className="ses-ai">
        <div className="ses-ai-head">
          <Badge tone="info">agent · session_recap</Badge>
          <span>session-end 总结</span>
        </div>
        <div className="ses-ai-body">
          {aiSummary ??
            'SessionSummaryTask 会基于本 session 的 review events 生成短复盘；没有生成前先展示本地统计。'}
        </div>
      </div>
      {session?.id && (
        <Link href={`/learning-sessions/${session.id}`} className="ses-link">
          <Button variant="secondary" size="sm" iconRight="arrowR">
            查看事件流
          </Button>
        </Link>
      )}
    </div>
  );
}
