'use client';

import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { formatRelTime } from '@/ui/lib/utils';
import { Badge } from '@/ui/primitives/Badge';
import { Card } from '@/ui/primitives/Card';
import { CauseBadge } from '@/ui/primitives/CauseBadge';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { useQuery } from '@tanstack/react-query';

interface MistakeRow {
  id: string;
  question_id: string;
  prompt_md: string;
  wrong_answer_md: string;
  knowledge_ids: string[];
  cause: {
    source?: 'user' | 'agent';
    primary_category: string;
    user_notes: string | null;
  } | null;
  created_at: number; // unix seconds
}

export default function MistakesPage() {
  const q = useQuery({
    queryKey: ['mistakes'],
    queryFn: () => apiJson<{ rows: MistakeRow[] }>('/api/mistakes?limit=100'),
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });

  const rows = q.data?.rows ?? [];
  const total = rows.length;
  const pending = rows.filter((r) => r.cause === null).length;
  const attributed = total - pending;

  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'var(--paper)',
        padding: '36px 28px',
        maxWidth: 'var(--cap-prose, 780px)',
        margin: '0 auto',
        width: '100%',
        boxSizing: 'border-box',
      }}
    >
      <PageHeader
        title="错题列表"
        eyebrow="/mistakes"
        sub={
          total === 0 ? undefined : `最近 ${total} 条 · 归因中 ${pending} / 已归因 ${attributed}`
        }
      />

      {q.isLoading && (
        <Card>
          <p style={loadingStyle}>正在加载…</p>
        </Card>
      )}

      {q.isError && (
        <Card>
          <p style={errorStyle}>
            {q.error instanceof ApiAuthError
              ? `${q.error.message} — 请重新进入页面输入 token`
              : `加载失败：${(q.error as Error).message}`}
          </p>
        </Card>
      )}

      {q.isSuccess && total === 0 && (
        <Card pad="lg">
          <p style={{ ...emptyStyle, margin: 0 }}>暂时没有错题记录。</p>
          <p style={{ ...subEmptyStyle, marginTop: 'var(--s-2)' }}>
            去{' '}
            <a href="/record" style={linkStyle}>
              /record
            </a>{' '}
            录入第一道。
          </p>
        </Card>
      )}

      {q.isSuccess && total > 0 && (
        <div style={listStyle}>
          {rows.map((row) => (
            <MistakeCard key={row.id} row={row} />
          ))}
        </div>
      )}
    </main>
  );
}

function MistakeCard({ row }: { row: MistakeRow }) {
  const createdAt = new Date(row.created_at * 1000);
  const pendingSince = Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / 1000));
  const cause = row.cause
    ? {
        actor_kind: row.cause.source === 'user' ? ('user' as const) : ('agent' as const),
        primary: row.cause.primary_category,
      }
    : null;
  return (
    <Card pad="lg" style={{ marginBottom: 'var(--s-3)' }}>
      <div style={cardHeadStyle}>
        <span style={metaStyle}>{formatRelTime(createdAt)}</span>
        <CauseBadge cause={cause} pendingSinceSec={pendingSince} />
      </div>
      <p style={promptStyle}>{row.prompt_md}</p>
      {row.wrong_answer_md && (
        <p style={wrongAnswerStyle}>
          <span style={inlineLabelStyle}>错答 · </span>
          {row.wrong_answer_md}
        </p>
      )}
      {row.knowledge_ids.length > 0 && (
        <div style={knowledgeRowStyle}>
          {row.knowledge_ids.map((id) => (
            <Badge key={id} tone="neutral">
              {id}
            </Badge>
          ))}
        </div>
      )}
    </Card>
  );
}

const loadingStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-body)',
  color: 'var(--ink-3)',
};

const errorStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-body)',
  color: 'var(--again-ink)',
};

const emptyStyle: React.CSSProperties = {
  fontSize: 'var(--fs-h4)',
  color: 'var(--ink-2)',
  fontFamily: 'var(--font-serif)',
};

const subEmptyStyle: React.CSSProperties = {
  fontSize: 'var(--fs-caption)',
  color: 'var(--ink-3)',
  margin: 0,
  lineHeight: 'var(--lh-prose)',
};

const linkStyle: React.CSSProperties = {
  color: 'var(--coral)',
};

const listStyle: React.CSSProperties = {
  marginTop: 'var(--s-4)',
};

const cardHeadStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--s-2)',
};

const metaStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-4)',
  letterSpacing: 'var(--ls-wide)',
};

const promptStyle: React.CSSProperties = {
  margin: 'var(--s-2) 0 0',
  fontFamily: 'var(--font-serif)',
  fontSize: 'var(--fs-body)',
  lineHeight: 'var(--lh-prose)',
  color: 'var(--ink)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const wrongAnswerStyle: React.CSSProperties = {
  margin: 'var(--s-2) 0 0',
  fontSize: 'var(--fs-caption)',
  lineHeight: 'var(--lh-prose)',
  color: 'var(--ink-2)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const inlineLabelStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-4)',
  letterSpacing: 'var(--ls-wide)',
};

const knowledgeRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
  marginTop: 'var(--s-2)',
};
