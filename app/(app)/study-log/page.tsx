'use client';

// Phase 1c.2 — /study-log standalone page.
//
// StudyLog is cross-cutting user-recorded notes (5 kinds: highlight / insight /
// question / reflection / observation). The unified time-line view that
// integrates StudyLog + auto events (FSRS / mastery / LearningItem) is a
// Phase 2 deliverable; for now this page is just the create + list surface.

import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { formatRelTime } from '@/ui/lib/utils';
import { Badge } from '@/ui/primitives/Badge';
import { Button } from '@/ui/primitives/Button';
import { Card } from '@/ui/primitives/Card';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { TabBar } from '@/ui/primitives/TabBar';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo, useState } from 'react';

type Kind = 'highlight' | 'insight' | 'question' | 'reflection' | 'observation';
type KindFilter = 'all' | Kind;

const KIND_TABS: { id: KindFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'highlight', label: '高亮' },
  { id: 'insight', label: '顿悟' },
  { id: 'question', label: '疑问' },
  { id: 'reflection', label: '反思' },
  { id: 'observation', label: '观察' },
];

const KIND_TONE: Record<Kind, 'coral' | 'good' | 'hard' | 'info' | 'neutral'> = {
  highlight: 'coral',
  insight: 'good',
  question: 'hard',
  reflection: 'info',
  observation: 'neutral',
};
const KIND_LABEL: Record<Kind, string> = {
  highlight: '高亮',
  insight: '顿悟',
  question: '疑问',
  reflection: '反思',
  observation: '观察',
};

interface StudyLogRow {
  id: string;
  kind: Kind;
  content_md: string;
  knowledge_ids: string[];
  question_id: string | null;
  mistake_id: string | null;
  artifact_id: string | null;
  learning_item_id: string | null;
  created_at: number;
  updated_at: number;
}

interface KnowledgeNode {
  id: string;
  name: string;
  effective_domain: string | null;
}

function matchesKnowledgeFilter(
  node: { name: string; effective_domain: string | null },
  filter: string,
): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  return (
    node.name.toLowerCase().includes(f) || (node.effective_domain ?? '').toLowerCase().includes(f)
  );
}

export default function StudyLogPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<KindFilter>('all');
  const [newKind, setNewKind] = useState<Kind>('highlight');
  const [newContent, setNewContent] = useState('');
  const [newKnowledgeIds, setNewKnowledgeIds] = useState<string[]>([]);
  const [knowledgeFilter, setKnowledgeFilter] = useState('');
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const logsQ = useQuery({
    queryKey: ['study-log', filter],
    queryFn: () => {
      const qs = filter === 'all' ? '' : `?kind=${filter}`;
      return apiJson<{ rows: StudyLogRow[] }>(`/api/study-log${qs}`);
    },
  });

  const knowledgeQ = useQuery({
    queryKey: ['knowledge'],
    queryFn: () => apiJson<{ rows: KnowledgeNode[] }>('/api/knowledge'),
  });
  const knowledgeById = useMemo(
    () => new Map((knowledgeQ.data?.rows ?? []).map((n) => [n.id, n])),
    [knowledgeQ.data],
  );

  const createM = useMutation({
    mutationFn: () =>
      apiJson<StudyLogRow>('/api/study-log', {
        method: 'POST',
        body: JSON.stringify({
          kind: newKind,
          content_md: newContent.trim(),
          knowledge_ids: newKnowledgeIds,
        }),
      }),
    onSuccess: () => {
      setNewContent('');
      setNewKnowledgeIds([]);
      qc.invalidateQueries({ queryKey: ['study-log'] });
    },
  });

  const deleteM = useMutation({
    mutationFn: (id: string) => apiJson(`/api/study-log/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setPendingDeleteId(null);
      qc.invalidateQueries({ queryKey: ['study-log'] });
    },
  });

  const rows = logsQ.data?.rows ?? [];

  return (
    <main className="page prose">
      <PageHeader
        title="学习日志"
        eyebrow="STUDY LOG · notes + observations"
        sub="跨学科记录顿悟 / 疑问 / 反思 / 高亮 / 观察。Phase 2 会与自动事件统一进时间线。"
      />

      <TabBar
        items={KIND_TABS.map((t) => ({ id: t.id, label: t.label }))}
        active={filter}
        onSelect={(id) => setFilter(id as KindFilter)}
      />

      <details open style={{ marginTop: 'var(--s-4)' }}>
        <summary style={summaryStyle}>新增记录</summary>
        <Card pad="lg" style={{ marginTop: 'var(--s-2)' }}>
          <p style={metaStyle}>类型</p>
          <div style={chipRowStyle}>
            {(['highlight', 'insight', 'question', 'reflection', 'observation'] as Kind[]).map(
              (k) => (
                <button
                  type="button"
                  key={k}
                  onClick={() => setNewKind(k)}
                  style={chipStyle(newKind === k)}
                >
                  {KIND_LABEL[k]}
                </button>
              ),
            )}
          </div>

          <p style={{ ...metaStyle, marginTop: 'var(--s-3)' }}>内容（markdown）</p>
          <textarea
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            placeholder={
              newKind === 'highlight'
                ? '原文片段或公式'
                : newKind === 'question'
                  ? '你还没想清楚的问题'
                  : '写点什么'
            }
            rows={4}
            style={textareaStyle}
            maxLength={10_000}
          />

          <p style={{ ...metaStyle, marginTop: 'var(--s-3)' }}>
            挂在哪些知识点（可选，已选 {newKnowledgeIds.length}）
          </p>
          <input
            type="text"
            value={knowledgeFilter}
            onChange={(e) => setKnowledgeFilter(e.target.value)}
            placeholder="搜索"
            style={inputStyle}
          />
          <div style={chipRowStyle}>
            {(knowledgeQ.data?.rows ?? [])
              .filter((n) => matchesKnowledgeFilter(n, knowledgeFilter))
              .slice(0, 30)
              .map((n) => {
                const selected = newKnowledgeIds.includes(n.id);
                return (
                  <button
                    type="button"
                    key={n.id}
                    onClick={() =>
                      setNewKnowledgeIds((cur) =>
                        cur.includes(n.id) ? cur.filter((x) => x !== n.id) : [...cur, n.id],
                      )
                    }
                    style={chipStyle(selected)}
                    title={n.effective_domain ?? ''}
                  >
                    {n.name}
                  </button>
                );
              })}
          </div>

          <div
            style={{
              marginTop: 'var(--s-3)',
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 'var(--s-2)',
            }}
          >
            <Button
              onClick={() => createM.mutate()}
              disabled={!newContent.trim() || createM.isPending}
            >
              {createM.isPending ? '创建中…' : '记录'}
            </Button>
          </div>
          {createM.isError && (
            <p style={errorStyle}>创建失败：{(createM.error as Error).message}</p>
          )}
        </Card>
      </details>

      {logsQ.isLoading && (
        <Card style={{ marginTop: 'var(--s-4)' }}>
          <p style={mutedStyle}>正在加载…</p>
        </Card>
      )}

      {logsQ.isError && (
        <Card style={{ marginTop: 'var(--s-4)' }}>
          <p style={errorStyle}>
            {logsQ.error instanceof ApiAuthError
              ? `${logsQ.error.message} — 请重新进入页面输入 token`
              : `加载失败：${(logsQ.error as Error).message}`}
          </p>
        </Card>
      )}

      {logsQ.isSuccess && rows.length === 0 && (
        <Card pad="lg" style={{ marginTop: 'var(--s-4)' }}>
          <p style={{ margin: 0, fontSize: 'var(--fs-body)', color: 'var(--ink-3)' }}>
            {filter === 'all' ? '还没有学习日志。' : `没有 ${KIND_LABEL[filter as Kind]} 记录。`}
          </p>
        </Card>
      )}

      <div style={{ marginTop: 'var(--s-4)' }}>
        {rows.map((row) => (
          <Card key={row.id} pad="lg" style={{ marginBottom: 'var(--s-3)' }}>
            <div style={rowHeadStyle}>
              <Badge tone={KIND_TONE[row.kind]}>{KIND_LABEL[row.kind]}</Badge>
              <span style={metaStyle}>{formatRelTime(new Date(row.created_at * 1000))}</span>
              <span style={{ flex: 1 }} />
              {pendingDeleteId === row.id ? (
                <>
                  <span style={confirmStyle}>确认删除？</span>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => deleteM.mutate(row.id)}
                    disabled={deleteM.isPending}
                  >
                    确认
                  </Button>
                  <Button
                    variant="quiet"
                    size="sm"
                    onClick={() => setPendingDeleteId(null)}
                    disabled={deleteM.isPending}
                  >
                    取消
                  </Button>
                </>
              ) : (
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => setPendingDeleteId(row.id)}
                  aria-label="删除"
                >
                  ×
                </Button>
              )}
            </div>
            <p style={contentStyle}>{row.content_md}</p>
            {row.knowledge_ids.length > 0 && (
              <div style={knowledgeChipsStyle}>
                {row.knowledge_ids.map((kid) => {
                  const node = knowledgeById.get(kid);
                  return (
                    <Link
                      key={kid}
                      href={`/knowledge/${kid}`}
                      style={knowledgeChipLinkStyle}
                      title={node?.effective_domain ?? kid}
                    >
                      #{node?.name ?? kid}
                    </Link>
                  );
                })}
              </div>
            )}
          </Card>
        ))}
      </div>
    </main>
  );
}

const summaryStyle: React.CSSProperties = {
  cursor: 'pointer',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-3)',
  letterSpacing: 'var(--ls-wide)',
};

const metaStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-3)',
  letterSpacing: 'var(--ls-wide)',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  fontFamily: 'var(--font-serif)',
  fontSize: 'var(--fs-body)',
  background: 'var(--paper-sunk)',
  color: 'var(--ink)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-2)',
  outline: 'none',
  boxSizing: 'border-box',
  marginTop: 4,
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  fontFamily: 'var(--font-serif)',
  lineHeight: 'var(--lh-prose)',
  resize: 'vertical',
};

const chipRowStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
  marginTop: 'var(--s-2)',
};

const chipStyle = (active: boolean): React.CSSProperties => ({
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  padding: '4px 10px',
  borderRadius: 'var(--r-pill)',
  border: `1px solid ${active ? 'var(--coral)' : 'var(--line)'}`,
  background: active ? 'var(--coral-soft)' : 'var(--paper-sunk)',
  color: active ? 'var(--coral-ink)' : 'var(--ink-2)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  letterSpacing: 'var(--ls-wide)',
});

const rowHeadStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--s-2)',
};

const contentStyle: React.CSSProperties = {
  margin: 'var(--s-2) 0 0',
  fontFamily: 'var(--font-serif)',
  fontSize: 'var(--fs-body)',
  color: 'var(--ink)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  lineHeight: 'var(--lh-prose)',
};

const knowledgeChipsStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
  marginTop: 'var(--s-2)',
};

const knowledgeChipLinkStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  padding: '2px 8px',
  borderRadius: 'var(--r-pill)',
  border: '1px solid var(--line)',
  background: 'var(--paper-sunk)',
  color: 'var(--coral)',
  textDecoration: 'none',
  letterSpacing: 'var(--ls-wide)',
};

const errorStyle: React.CSSProperties = {
  margin: 'var(--s-2) 0 0',
  fontSize: 'var(--fs-caption)',
  color: 'var(--again-ink)',
};

const mutedStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-body)',
  color: 'var(--ink-3)',
};

const confirmStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--again-ink)',
  letterSpacing: 'var(--ls-wide)',
};
