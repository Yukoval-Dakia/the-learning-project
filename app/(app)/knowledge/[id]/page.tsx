'use client';

import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { formatRelTime } from '@/ui/lib/utils';
import { Badge } from '@/ui/primitives/Badge';
import { Card } from '@/ui/primitives/Card';
import { CauseBadge } from '@/ui/primitives/CauseBadge';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { use } from 'react';

interface KnowledgeNode {
  id: string;
  name: string;
  domain: string | null;
  parent_id: string | null;
  effective_domain: string | null;
}

interface MistakeRow {
  id: string;
  question_id: string;
  prompt_md: string;
  wrong_answer_md: string;
  knowledge_ids: string[];
  cause: { primary_category: string; user_notes: string | null } | null;
  created_at: number;
}

export default function KnowledgeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  const knowledgeQ = useQuery({
    queryKey: ['knowledge'],
    queryFn: () => apiJson<{ rows: KnowledgeNode[] }>('/api/knowledge'),
  });

  const mistakesQ = useQuery({
    queryKey: ['mistakes'],
    queryFn: () => apiJson<{ rows: MistakeRow[] }>('/api/mistakes?limit=200'),
  });

  const node = knowledgeQ.data?.rows.find((n) => n.id === id);
  const parent = node?.parent_id
    ? knowledgeQ.data?.rows.find((n) => n.id === node.parent_id)
    : null;
  const linkedMistakes = (mistakesQ.data?.rows ?? []).filter((m) => m.knowledge_ids.includes(id));

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
      <p style={breadcrumbStyle}>
        <Link href="/knowledge" style={{ color: 'var(--coral)' }}>
          ← 知识图谱
        </Link>
      </p>

      <PageHeader
        title={node?.name ?? '加载中…'}
        eyebrow={`/knowledge/${id.slice(0, 8)}…`}
        sub={node?.effective_domain ? `domain · ${node.effective_domain}` : undefined}
      />

      {knowledgeQ.isError && (
        <Card>
          <p style={errorStyle}>
            {knowledgeQ.error instanceof ApiAuthError
              ? `${knowledgeQ.error.message} — 请重新进入页面输入 token`
              : `加载失败：${(knowledgeQ.error as Error).message}`}
          </p>
        </Card>
      )}

      {knowledgeQ.isSuccess && !node && (
        <Card pad="lg">
          <p style={{ margin: 0, fontSize: 'var(--fs-body)', color: 'var(--ink-3)' }}>
            找不到该节点（id={id}）。
          </p>
        </Card>
      )}

      {node && (
        <>
          <Card pad="lg" style={{ marginTop: 'var(--s-4)' }}>
            <SectionLabel>元信息</SectionLabel>
            <dl style={dlStyle}>
              <Row label="id" value={node.id} mono />
              <Row label="name" value={node.name} />
              <Row label="domain" value={node.domain ?? '(继承)'} />
              <Row
                label="parent"
                value={
                  parent ? (
                    <Link href={`/knowledge/${parent.id}`} style={{ color: 'var(--coral)' }}>
                      {parent.name}
                    </Link>
                  ) : (
                    '(根节点)'
                  )
                }
              />
              <Row label="effective_domain" value={node.effective_domain ?? '—'} />
            </dl>
          </Card>

          <Card pad="lg" style={{ marginTop: 'var(--s-4)' }}>
            <SectionLabel>
              错题（{linkedMistakes.length}）{mistakesQ.isLoading && ' · 加载中'}
            </SectionLabel>
            {mistakesQ.isSuccess && linkedMistakes.length === 0 && (
              <p style={{ ...mutedStyle, margin: 0 }}>这个节点暂时没有挂错题。</p>
            )}
            {linkedMistakes.map((m) => (
              <div key={m.id} style={mistakeRowStyle}>
                <div style={mistakeMetaStyle}>
                  <span style={metaTextStyle}>{formatRelTime(new Date(m.created_at * 1000))}</span>
                  <CauseBadge
                    cause={
                      m.cause ? { actor_kind: 'agent', primary: m.cause.primary_category } : null
                    }
                  />
                </div>
                <p style={mistakePromptStyle}>{m.prompt_md}</p>
                {m.wrong_answer_md && <p style={mistakeAnswerStyle}>错答：{m.wrong_answer_md}</p>}
              </div>
            ))}
          </Card>

          <p style={{ ...mutedStyle, marginTop: 'var(--s-5)', textAlign: 'center' }}>
            单道题详情页待 Phase 1d 实现。
          </p>
        </>
      )}
    </main>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--fs-meta)',
        color: 'var(--ink-4)',
        letterSpacing: 'var(--ls-wide)',
        display: 'block',
        marginBottom: 'var(--s-3)',
      }}
    >
      {children}
    </span>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <>
      <dt style={dtStyle}>{label}</dt>
      <dd style={mono ? ddMonoStyle : ddStyle}>{value}</dd>
    </>
  );
}

const breadcrumbStyle: React.CSSProperties = {
  margin: '0 0 var(--s-2)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  letterSpacing: 'var(--ls-wide)',
};

const errorStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-body)',
  color: 'var(--again-ink)',
};

const mutedStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-caption)',
  color: 'var(--ink-3)',
};

const dlStyle: React.CSSProperties = {
  margin: 0,
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  rowGap: 'var(--s-2)',
  columnGap: 'var(--s-3)',
};

const dtStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-4)',
  letterSpacing: 'var(--ls-wide)',
};

const ddStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-body)',
  color: 'var(--ink)',
};

const ddMonoStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-2)',
};

const mistakeRowStyle: React.CSSProperties = {
  padding: 'var(--s-3) 0',
  borderTop: '1px solid var(--line-soft)',
};

const mistakeMetaStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--s-2)',
};

const metaTextStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-4)',
  letterSpacing: 'var(--ls-wide)',
};

const mistakePromptStyle: React.CSSProperties = {
  margin: 'var(--s-2) 0 0',
  fontFamily: 'var(--font-serif)',
  fontSize: 'var(--fs-body)',
  color: 'var(--ink)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const mistakeAnswerStyle: React.CSSProperties = {
  margin: 'var(--s-2) 0 0',
  fontSize: 'var(--fs-caption)',
  color: 'var(--ink-2)',
};
