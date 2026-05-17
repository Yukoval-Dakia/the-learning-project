'use client';

import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { formatRelTime } from '@/ui/lib/utils';
import { Button } from '@/ui/primitives/Button';
import { Card } from '@/ui/primitives/Card';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { StatusBadge } from '@/ui/primitives/StatusBadge';
import { TabBar } from '@/ui/primitives/TabBar';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

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

type ItemStatus = 'pending' | 'in_progress' | 'done' | 'resting' | 'dismissed' | 'archived';
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
  { id: 'resting', label: '养护' },
  { id: 'dismissed', label: '已拒' },
  { id: 'archived', label: '归档' },
];

interface KnowledgeNode {
  id: string;
  name: string;
  effective_domain: string | null;
}

interface IntentProposal {
  proposal_id: string;
  topic: string;
  knowledge_node: { id: string; name: string; domain: string | null };
  hub: { title: string; summary_md: string };
  atomics: Array<{ knowledge_id: string; title: string; one_line_intent: string }>;
}

export default function LearningItemsPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [newTitle, setNewTitle] = useState('');
  const [newKnowledgeIds, setNewKnowledgeIds] = useState<string[]>([]);
  const [knowledgeFilter, setKnowledgeFilter] = useState('');
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [editingKnowledgeId, setEditingKnowledgeId] = useState<string | null>(null);
  const [draftKnowledgeIds, setDraftKnowledgeIds] = useState<string[]>([]);

  // Phase 2B intent flow state
  const [intentTopic, setIntentTopic] = useState('');
  const [intentProposal, setIntentProposal] = useState<IntentProposal | null>(null);
  const [intentError, setIntentError] = useState<string | null>(null);

  const intentPlanM = useMutation({
    mutationFn: (topic: string) =>
      apiJson<IntentProposal>('/api/learning-intents', {
        method: 'POST',
        body: JSON.stringify({ topic }),
      }),
    onSuccess: (data) => {
      setIntentProposal(data);
      setIntentError(null);
    },
    onError: (err: Error) => {
      setIntentError(err.message);
      setIntentProposal(null);
    },
  });

  const intentAcceptM = useMutation({
    mutationFn: (proposalId: string) =>
      apiJson<{ hub_learning_item_id: string }>(`/api/learning-intents/${proposalId}/accept`, {
        method: 'POST',
      }),
    onSuccess: (data) => {
      setIntentProposal(null);
      setIntentTopic('');
      qc.invalidateQueries({ queryKey: ['learning-items'] });
      router.push(`/learning-items/${data.hub_learning_item_id}`);
    },
  });

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

  const knowledgeQ = useQuery({
    queryKey: ['knowledge'],
    queryFn: () => apiJson<{ rows: KnowledgeNode[] }>('/api/knowledge'),
  });
  const knowledgeById = new Map(knowledgeQ.data?.rows.map((n) => [n.id, n]) ?? []);

  const createM = useMutation({
    mutationFn: (payload: { title: string; knowledge_ids: string[] }) =>
      apiJson<{ id: string }>('/api/learning-items', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      setNewTitle('');
      setNewKnowledgeIds([]);
      qc.invalidateQueries({ queryKey: ['learning-items'] });
    },
  });

  const updateM = useMutation({
    mutationFn: (vars: {
      id: string;
      version: number;
      status?: ItemStatus;
      knowledge_ids?: string[];
    }) =>
      apiJson(`/api/learning-items/${vars.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          version: vars.version,
          ...(vars.status ? { status: vars.status } : {}),
          ...(vars.knowledge_ids ? { knowledge_ids: vars.knowledge_ids } : {}),
        }),
      }),
    onSuccess: () => {
      setEditingKnowledgeId(null);
      qc.invalidateQueries({ queryKey: ['learning-items'] });
    },
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
    <main className="page prose">
      <PageHeader
        title="学习项"
        eyebrow="ITEMS · free queue"
        sub="自由 TODO，不进入 FSRS 排程。intent 可以拆成 hub + atomic learning items。"
      />

      {/* Phase 2B — Learning Intent input */}
      <section className="intent-input-section">
        <h4 className="intent-section-label">我想学…</h4>
        <div className="intent-input-row">
          <input
            type="text"
            value={intentTopic}
            onChange={(e) => setIntentTopic(e.target.value)}
            placeholder="例：虚词、文言句式、氧化还原反应"
            maxLength={80}
            disabled={intentPlanM.isPending || intentAcceptM.isPending}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && intentTopic.trim() && !intentPlanM.isPending) {
                intentPlanM.mutate(intentTopic.trim());
              }
            }}
            className="intent-input"
          />
          <Button
            onClick={() => intentTopic.trim() && intentPlanM.mutate(intentTopic.trim())}
            disabled={!intentTopic.trim() || intentPlanM.isPending || intentAcceptM.isPending}
          >
            {intentPlanM.isPending ? '生成提议中…' : '提议拆分'}
          </Button>
        </div>
        {intentError && <p className="intent-error">{intentError}</p>}
        {intentProposal && (
          <div className="intent-proposal-panel">
            <div className="intent-proposal-hub">
              <span className="intent-proposal-tag">HUB</span>
              <strong>{intentProposal.hub.title}</strong>
              <span className="intent-proposal-knowledge">
                #{intentProposal.knowledge_node.name}
              </span>
            </div>
            <p className="intent-proposal-summary">{intentProposal.hub.summary_md}</p>
            <ul className="intent-proposal-atomics">
              {intentProposal.atomics.map((a) => (
                <li key={a.knowledge_id}>
                  <span className="intent-proposal-tag-sm">ATOMIC</span>
                  <strong>{a.title}</strong>
                  <span className="intent-proposal-intent">{a.one_line_intent}</span>
                </li>
              ))}
            </ul>
            <div className="intent-proposal-actions">
              <Button
                variant="secondary"
                onClick={() => setIntentProposal(null)}
                disabled={intentAcceptM.isPending}
              >
                取消
              </Button>
              <Button
                onClick={() => intentAcceptM.mutate(intentProposal.proposal_id)}
                disabled={intentAcceptM.isPending}
              >
                {intentAcceptM.isPending
                  ? '正在创建 + 入队…'
                  : `接受（1 hub + ${intentProposal.atomics.length} atomic）`}
              </Button>
            </div>
            {intentAcceptM.isError && (
              <p className="intent-error">Accept 失败：{(intentAcceptM.error as Error).message}</p>
            )}
          </div>
        )}
      </section>

      <TabBar
        items={FILTER_TABS.map((t) => ({ id: t.id, label: t.label }))}
        active={filter}
        onSelect={(id) => setFilter(id as StatusFilter)}
      />

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
                createM.mutate({ title: newTitle.trim(), knowledge_ids: newKnowledgeIds });
              }
            }}
            style={inputStyle}
          />

          <p style={{ ...metaStyle, marginTop: 'var(--s-3)' }}>
            知识点（可选，已选 {newKnowledgeIds.length}）
          </p>
          <input
            type="text"
            value={knowledgeFilter}
            onChange={(e) => setKnowledgeFilter(e.target.value)}
            placeholder="搜索知识点"
            style={{ ...inputStyle, marginTop: 4 }}
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
              onClick={() =>
                newTitle.trim() &&
                createM.mutate({ title: newTitle.trim(), knowledge_ids: newKnowledgeIds })
              }
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
                <h3 style={titleStyle}>
                  <Link
                    href={`/learning-items/${item.id}`}
                    style={{ color: 'inherit', textDecoration: 'none' }}
                  >
                    {item.title}
                  </Link>
                </h3>
                <p style={metaStyle}>
                  创建 {formatRelTime(item.created_at)} · v{item.version}
                </p>
              </div>
              <StatusBadge status={item.status} />
            </div>
            {item.content && <p style={contentStyle}>{item.content}</p>}

            {/* knowledge_ids display + inline editor */}
            {editingKnowledgeId === item.id ? (
              <div style={{ marginTop: 'var(--s-2)' }}>
                <p style={metaStyle}>编辑知识点（已选 {draftKnowledgeIds.length}）</p>
                <input
                  type="text"
                  value={knowledgeFilter}
                  onChange={(e) => setKnowledgeFilter(e.target.value)}
                  placeholder="搜索"
                  style={{ ...inputStyle, marginTop: 4 }}
                />
                <div style={chipRowStyle}>
                  {(knowledgeQ.data?.rows ?? [])
                    .filter((n) => matchesKnowledgeFilter(n, knowledgeFilter))
                    .slice(0, 30)
                    .map((n) => {
                      const selected = draftKnowledgeIds.includes(n.id);
                      return (
                        <button
                          type="button"
                          key={n.id}
                          onClick={() =>
                            setDraftKnowledgeIds((cur) =>
                              cur.includes(n.id) ? cur.filter((x) => x !== n.id) : [...cur, n.id],
                            )
                          }
                          style={chipStyle(selected)}
                        >
                          {n.name}
                        </button>
                      );
                    })}
                </div>
                <div
                  style={{
                    marginTop: 'var(--s-2)',
                    display: 'flex',
                    justifyContent: 'flex-end',
                    gap: 'var(--s-2)',
                  }}
                >
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setEditingKnowledgeId(null)}
                    disabled={updateM.isPending}
                  >
                    取消
                  </Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      updateM.mutate({
                        id: item.id,
                        version: item.version,
                        knowledge_ids: draftKnowledgeIds,
                      })
                    }
                    disabled={updateM.isPending}
                  >
                    {updateM.isPending ? '保存中…' : '保存'}
                  </Button>
                </div>
              </div>
            ) : (
              item.knowledge_ids.length > 0 && (
                <div style={knowledgeChipsStyle}>
                  {item.knowledge_ids.map((kid) => {
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
              )
            )}

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
                <>
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
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      updateM.mutate({ id: item.id, version: item.version, status: 'resting' })
                    }
                    disabled={updateM.isPending}
                    title="进入养护 — dreaming 会从这里挑复学"
                  >
                    去养护
                  </Button>
                </>
              )}
              {item.status === 'resting' && (
                <Button
                  variant="info"
                  size="sm"
                  onClick={() =>
                    updateM.mutate({ id: item.id, version: item.version, status: 'in_progress' })
                  }
                  disabled={updateM.isPending}
                >
                  复学
                </Button>
              )}
              {item.status === 'dismissed' && (
                <Button
                  variant="info"
                  size="sm"
                  onClick={() =>
                    updateM.mutate({ id: item.id, version: item.version, status: 'pending' })
                  }
                  disabled={updateM.isPending}
                >
                  恢复
                </Button>
              )}
              {item.status === 'archived' && (
                <Button
                  variant="info"
                  size="sm"
                  onClick={() =>
                    updateM.mutate({ id: item.id, version: item.version, status: 'pending' })
                  }
                  disabled={updateM.isPending}
                >
                  取出归档
                </Button>
              )}
              {item.status !== 'archived' && (
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() =>
                    updateM.mutate({ id: item.id, version: item.version, status: 'archived' })
                  }
                  disabled={updateM.isPending}
                  title="归档 — 不在主列表显示"
                >
                  归档
                </Button>
              )}
              <span style={{ flex: 1 }} />
              {editingKnowledgeId !== item.id && (
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => {
                    setEditingKnowledgeId(item.id);
                    setDraftKnowledgeIds(item.knowledge_ids);
                    setKnowledgeFilter('');
                  }}
                >
                  改知识点
                </Button>
              )}
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
