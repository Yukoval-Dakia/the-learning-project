'use client';

import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { formatRelTime } from '@/ui/lib/utils';
import { Badge, type BadgeTone } from '@/ui/primitives/Badge';
import { Button } from '@/ui/primitives/Button';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

interface LearningSessionRow {
  id: string;
  type: string;
  status: 'started' | 'paused' | 'completed' | 'abandoned' | string;
  summary_md: string | null;
  started_at: number;
  ended_at: number | null;
  duration_ms: number | null;
  reviewed_count: number;
  rating_counts: { again: number; hard: number; good: number };
  knowledge_touched: string[];
}

const STATUS_TONE: Record<string, BadgeTone> = {
  started: 'info',
  paused: 'hard',
  completed: 'good',
  abandoned: 'again',
};

export default function LearningSessionsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['learning-sessions', 'review'],
    queryFn: () =>
      apiJson<{ rows: LearningSessionRow[] }>('/api/learning-sessions?type=review&limit=50'),
  });

  const reopenM = useMutation({
    mutationFn: (sessionId: string) =>
      apiJson<{ ok: true; status: 'started' }>(
        `/api/review/sessions/${encodeURIComponent(sessionId)}/reopen`,
        { method: 'POST' },
      ),
    onSuccess: (_data, sessionId) => {
      qc.invalidateQueries({ queryKey: ['learning-sessions'] });
      router.push(`/review?session=${encodeURIComponent(sessionId)}`);
    },
  });

  return (
    <main className="page">
      <p className="breadcrumb">
        <Link href="/today">← 今日</Link>
      </p>
      <PageHeader
        title="Review sessions"
        eyebrow="/learning-sessions"
        sub="最近 review learning_session；abandoned 可重新打开继续。"
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

      {q.isSuccess && q.data.rows.length === 0 && (
        <div className="event-card">
          <p className="ec-row">还没有 review session。</p>
        </div>
      )}

      {q.isSuccess && (
        <div className="learning-session-list">
          {q.data.rows.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              reopening={reopenM.isPending}
              reopenError={reopenM.isError ? (reopenM.error as Error).message : null}
              onReopen={() => reopenM.mutate(session.id)}
            />
          ))}
        </div>
      )}
    </main>
  );
}

function SessionRow({
  session,
  reopening,
  reopenError,
  onReopen,
}: {
  session: LearningSessionRow;
  reopening: boolean;
  reopenError: string | null;
  onReopen: () => void;
}) {
  const total =
    session.rating_counts.again + session.rating_counts.hard + session.rating_counts.good;
  return (
    <article className="event-card learning-session-row">
      <div className="ec-head">
        <Badge tone={STATUS_TONE[session.status] ?? 'neutral'} dot={session.status === 'started'}>
          {session.status}
        </Badge>
        <code>{session.id.slice(0, 12)}</code>
        <span className="when">{formatRelTime(new Date(session.started_at * 1000))}</span>
      </div>
      <p className="ec-row">
        <span className="lbl">复习</span>
        <span>
          {session.reviewed_count} 题 · 不会 {session.rating_counts.again} · 模糊{' '}
          {session.rating_counts.hard} · 会 {session.rating_counts.good}
        </span>
      </p>
      <p className="ec-row">
        <span className="lbl">时长</span>
        <span>
          {formatDuration(session.duration_ms)}
          {total > 0 && ` · ${Math.round((session.rating_counts.good / total) * 100)}% good`}
        </span>
      </p>
      {session.summary_md && (
        <p className="ec-row">
          <span className="lbl">总结</span>
          <span>{session.summary_md}</span>
        </p>
      )}
      {session.knowledge_touched.length > 0 && (
        <div className="learning-session-chips">
          {session.knowledge_touched.slice(0, 8).map((kid) => (
            <code key={kid}>{kid}</code>
          ))}
        </div>
      )}
      <div className="learning-session-actions">
        <Link href={`/learning-sessions/${session.id}`} style={{ textDecoration: 'none' }}>
          <Button variant="quiet" size="sm" iconRight="arrowR">
            详情
          </Button>
        </Link>
        {session.status === 'paused' && (
          <Link href={`/review?session=${session.id}`} style={{ textDecoration: 'none' }}>
            <Button variant="info" size="sm" iconRight="arrowR">
              恢复
            </Button>
          </Link>
        )}
        {session.status === 'abandoned' && (
          <Button variant="primary" size="sm" onClick={onReopen} disabled={reopening}>
            Resume
          </Button>
        )}
      </div>
      {session.status === 'abandoned' && reopenError && (
        <p className="ec-row" style={{ color: 'var(--again-ink)' }}>
          resume 失败：{reopenError}
        </p>
      )}
    </article>
  );
}

function formatDuration(ms: number | null): string {
  if (!ms || ms < 0) return '0 分钟';
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `${minutes} 分钟`;
}
