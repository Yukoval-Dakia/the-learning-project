'use client';

import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { formatRelTime } from '@/ui/lib/utils';
import { Button } from '@/ui/primitives/Button';
import { Card } from '@/ui/primitives/Card';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { StatusBadge } from '@/ui/primitives/StatusBadge';
import { TabBar } from '@/ui/primitives/TabBar';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

type ItemStatus = 'pending' | 'in_progress' | 'done';
type StatusFilter = 'all' | ItemStatus;

interface LearningItem {
  id: string;
  title: string;
  content: string;
  knowledge_ids: string[];
  status: ItemStatus;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

const FILTER_TABS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'pending', label: '待办' },
  { id: 'in_progress', label: '进行中' },
  { id: 'done', label: '已完成' },
];

export default function LearningItemsPage() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [newTitle, setNewTitle] = useState('');
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const itemsQ = useQuery({
    queryKey: ['learning-items', filter],
    queryFn: () => {
      const url =
        filter === 'all'
          ? '/api/learning-items?limit=200'
          : `/api/learning-items?limit=200&status=${filter}`;
      return apiJson<{ rows: LearningItem[] }>(url);
    },
  });

  const createM = useMutation({
    mutationFn: (title: string) =>
      apiJson<{ id: string }>('/api/learning-items', {
        method: 'POST',
        body: JSON.stringify({ title }),
      }),
    onSuccess: () => {
      setNewTitle('');
      qc.invalidateQueries({ queryKey: ['learning-items'] });
    },
  });

  const updateM = useMutation({
    mutationFn: (vars: { id: string; version: number; status: ItemStatus }) =>
      apiJson(`/api/learning-items/${vars.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ version: vars.version, status: vars.status }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['learning-items'] }),
  });

  const deleteM = useMutation({
    mutationFn: (id: string) => apiJson(`/api/learning-items/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setPendingDeleteId(null);
      qc.invalidateQueries({ queryKey: ['learning-items'] });
    },
  });

  const rows = itemsQ.data?.rows ?? [];

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
      <PageHeader title="学习项" eyebrow="/learning-items" sub="自由 TODO，不进入 FSRS 排程" />

      <div style={{ marginTop: 'var(--s-4)' }}>
        <TabBar
          items={FILTER_TABS.map((t) => ({ id: t.id, label: t.label }))}
          active={filter}
          onSelect={(id) => setFilter(id as StatusFilter)}
        />
      </div>

      <details open style={{ marginTop: 'var(--s-4)' }}>
        <summary style={summaryStyle}>新增学习项</summary>
        <Card pad="lg" style={{ marginTop: 'var(--s-2)' }}>
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="例：FSRS 间隔重复算法"
            maxLength={200}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newTitle.trim() && !createM.isPending) {
                createM.mutate(newTitle.trim());
              }
            }}
            style={inputStyle}
          />
          <div
            style={{
              marginTop: 'var(--s-3)',
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 'var(--s-2)',
            }}
          >
            <Button
              onClick={() => newTitle.trim() && createM.mutate(newTitle.trim())}
              disabled={!newTitle.trim() || createM.isPending}
            >
              {createM.isPending ? '创建中…' : '创建'}
            </Button>
          </div>
          {createM.isError && (
            <p style={errorStyle}>创建失败：{(createM.error as Error).message}</p>
          )}
        </Card>
      </details>

      {itemsQ.isLoading && (
        <Card style={{ marginTop: 'var(--s-4)' }}>
          <p style={mutedStyle}>正在加载…</p>
        </Card>
      )}

      {itemsQ.isError && (
        <Card style={{ marginTop: 'var(--s-4)' }}>
          <p style={errorStyle}>
            {itemsQ.error instanceof ApiAuthError
              ? `${itemsQ.error.message} — 请重新进入页面输入 token`
              : `加载失败：${(itemsQ.error as Error).message}`}
          </p>
        </Card>
      )}

      {itemsQ.isSuccess && rows.length === 0 && (
        <Card pad="lg" style={{ marginTop: 'var(--s-4)' }}>
          <p style={{ margin: 0, fontSize: 'var(--fs-body)', color: 'var(--ink-3)' }}>
            {filter === 'all' ? '还没有学习项。' : `没有 ${labelFor(filter)} 状态的学习项。`}
          </p>
        </Card>
      )}

      <div style={{ marginTop: 'var(--s-4)' }}>
        {rows.map((item) => (
          <Card key={item.id} pad="lg" style={{ marginBottom: 'var(--s-3)' }}>
            <div style={itemHeadStyle}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <h3 style={titleStyle}>{item.title}</h3>
                <p style={metaStyle}>
                  创建 {formatRelTime(item.created_at)} · v{item.version}
                </p>
              </div>
              <StatusBadge status={item.status} />
            </div>
            {item.content && <p style={contentStyle}>{item.content}</p>}
            <div style={actionsStyle}>
              {item.status === 'pending' && (
                <>
                  <Button
                    variant="hard"
                    size="sm"
                    onClick={() =>
                      updateM.mutate({ id: item.id, version: item.version, status: 'in_progress' })
                    }
                    disabled={updateM.isPending}
                  >
                    开始学
                  </Button>
                  <Button
                    variant="good"
                    size="sm"
                    onClick={() =>
                      updateM.mutate({ id: item.id, version: item.version, status: 'done' })
                    }
                    disabled={updateM.isPending}
                  >
                    我学完了
                  </Button>
                </>
              )}
              {item.status === 'in_progress' && (
                <>
                  <Button
                    variant="good"
                    size="sm"
                    onClick={() =>
                      updateM.mutate({ id: item.id, version: item.version, status: 'done' })
                    }
                    disabled={updateM.isPending}
                  >
                    我学完了
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      updateM.mutate({ id: item.id, version: item.version, status: 'pending' })
                    }
                    disabled={updateM.isPending}
                  >
                    改回待办
                  </Button>
                </>
              )}
              {item.status === 'done' && (
                <Button
                  variant="info"
                  size="sm"
                  onClick={() =>
                    updateM.mutate({ id: item.id, version: item.version, status: 'in_progress' })
                  }
                  disabled={updateM.isPending}
                >
                  重学
                </Button>
              )}
              <span style={{ flex: 1 }} />
              {pendingDeleteId === item.id ? (
                <>
                  <span style={confirmStyle}>确认删除？</span>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => deleteM.mutate(item.id)}
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
                  onClick={() => setPendingDeleteId(item.id)}
                  aria-label="删除"
                >
                  ×
                </Button>
              )}
            </div>
          </Card>
        ))}
      </div>
    </main>
  );
}

function labelFor(s: StatusFilter): string {
  const found = FILTER_TABS.find((t) => t.id === s);
  return found?.label ?? s;
}

const summaryStyle: React.CSSProperties = {
  cursor: 'pointer',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-3)',
  letterSpacing: 'var(--ls-wide)',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  fontSize: 'var(--fs-body)',
  fontFamily: 'var(--font-serif)',
  background: 'var(--paper-sunk)',
  color: 'var(--ink)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-2)',
  outline: 'none',
  boxSizing: 'border-box',
};

const itemHeadStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 'var(--s-3)',
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-serif)',
  fontSize: 'var(--fs-h4)',
  fontWeight: 500,
  color: 'var(--ink)',
  wordBreak: 'break-word',
};

const metaStyle: React.CSSProperties = {
  margin: '4px 0 0',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-4)',
  letterSpacing: 'var(--ls-wide)',
};

const contentStyle: React.CSSProperties = {
  margin: 'var(--s-2) 0 0',
  fontSize: 'var(--fs-body)',
  color: 'var(--ink-2)',
  lineHeight: 'var(--lh-prose)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const actionsStyle: React.CSSProperties = {
  marginTop: 'var(--s-3)',
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 'var(--s-2)',
};

const mutedStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-body)',
  color: 'var(--ink-3)',
};

const errorStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-body)',
  color: 'var(--again-ink)',
};

const confirmStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--again-ink)',
  letterSpacing: 'var(--ls-wide)',
};
