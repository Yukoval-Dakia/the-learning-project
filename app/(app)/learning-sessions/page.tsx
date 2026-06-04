'use client';

import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { formatRelTime } from '@/ui/lib/utils';
import { Btn } from '@/ui/primitives/Btn';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SkLines } from '@/ui/primitives/SkLines';
import { Stateful, type StatefulStatus } from '@/ui/primitives/Stateful';
import { StatusBadge } from '@/ui/primitives/StatusBadge';
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

export default function LearningSessionsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  // NOTE: query is review-only by product decision (resume/reopen semantics).
  // The prototype list also shows ingestion sessions; loosening the `type`
  // filter is a separate ingestion-surface decision tracked outside this
  // redraw lane (preflight gap G1). The type-icon mapping below is kept
  // structural so an ingestion row renders correctly if/when the filter opens.
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

  const state: StatefulStatus = q.isLoading
    ? 'loading'
    : q.isError
      ? 'error'
      : q.isSuccess && q.data.rows.length === 0
        ? 'empty'
        : 'ok';

  const errorText =
    q.error instanceof ApiAuthError
      ? `${q.error.message} — 请重新进入页面输入 token`
      : q.error
        ? `加载失败：${(q.error as Error).message}`
        : '会话历史加载失败。';

  return (
    <main className="page sessions-loom">
      <button type="button" className="back-link" onClick={() => router.push('/today')}>
        <LoomIcon name="arrowL" size={14} />
        今日
      </button>

      <div className="page-head">
        <div className="eyebrow">
          SESSIONS · LearningSession · {q.isSuccess ? q.data.rows.length : 0} 条
        </div>
        <h1 className="page-title serif">学习会话</h1>
        <p className="page-lead">
          过往复习与录入会话。复习会话可重开或恢复；录入会话带 ingestion 生命周期状态。
        </p>
      </div>

      <Stateful
        status={state}
        onRetry={() => q.refetch()}
        errorText={errorText}
        skeleton={
          <LoomCard pad>
            <SkLines rows={4} />
          </LoomCard>
        }
        empty={
          <EmptyState icon="history" title="还没有会话" text="开始一次复习后，会话会记录在这里。" />
        }
      >
        {q.isSuccess && (
          <LoomCard>
            <div className="sess-head-row meta">
              <span>会话</span>
              <span>状态</span>
              <span>已复习</span>
              <span>评分</span>
              <span>时长</span>
              <span />
            </div>
            {q.data.rows.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                reopening={reopenM.isPending}
                reopenError={reopenM.isError ? (reopenM.error as Error).message : null}
                onReopen={() => reopenM.mutate(session.id)}
              />
            ))}
          </LoomCard>
        )}
      </Stateful>
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
  const isReview = session.type === 'review';
  return (
    <div className="sess-row">
      <div className="sess-id">
        <span className={`sess-type-ic tone-${isReview ? 'coral' : 'info'}`}>
          <LoomIcon name={isReview ? 'review' : 'record'} size={15} />
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="mono sess-id-t">{session.id.slice(0, 12)}</div>
          <div className="meta nowrap-meta">
            {formatRelTime(new Date(session.started_at * 1000))}
            {session.knowledge_touched.slice(0, 6).map((kid) => (
              <span key={kid} className="chip chip-k mono" style={{ padding: '0 5px' }}>
                {kid}
              </span>
            ))}
          </div>
          {session.summary_md && <div className="meta">{session.summary_md}</div>}
        </div>
      </div>
      <div>
        <StatusBadge status={session.status} />
      </div>
      <div className="mono sess-reviewed">{session.reviewed_count || '—'}</div>
      <div>
        <MiniDist dist={session.rating_counts} />
      </div>
      <div className="mono">{formatDuration(session.duration_ms)}</div>
      <div className="sess-acts">
        <Link href={`/learning-sessions/${session.id}`} style={{ textDecoration: 'none' }}>
          <Btn size="sm" variant="secondary">
            详情
          </Btn>
        </Link>
        {/* YUK-57/63 pause/resume wiring — preserved verbatim */}
        {session.status === 'paused' && (
          <Link href={`/review?session=${session.id}`} style={{ textDecoration: 'none' }}>
            <Btn size="sm" variant="ghost" icon="undo">
              恢复
            </Btn>
          </Link>
        )}
        {session.status === 'abandoned' && (
          <Btn size="sm" variant="ghost" icon="refresh" onClick={onReopen} disabled={reopening}>
            重开
          </Btn>
        )}
        {session.status === 'abandoned' && reopenError && (
          <span className="meta" style={{ color: 'var(--again-ink)' }}>
            重开失败：{reopenError}
          </span>
        )}
      </div>
    </div>
  );
}

function MiniDist({ dist }: { dist: { again: number; hard: number; good: number } }) {
  const total = dist.again + dist.hard + dist.good;
  if (total === 0) return <span className="meta">—</span>;
  return (
    <div className="mini-dist" title={`不会 ${dist.again} · 模糊 ${dist.hard} · 会了 ${dist.good}`}>
      <span className="tone-again" style={{ width: `${(dist.again / total) * 100}%` }} />
      <span className="tone-hard" style={{ width: `${(dist.hard / total) * 100}%` }} />
      <span className="tone-good" style={{ width: `${(dist.good / total) * 100}%` }} />
    </div>
  );
}

function formatDuration(ms: number | null): string {
  if (!ms || ms < 0) return '—';
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `${minutes}m`;
}
