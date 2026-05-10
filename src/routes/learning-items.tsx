import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

const INTERNAL_TOKEN = import.meta.env.VITE_INTERNAL_TOKEN ?? '';

interface LearningItem {
  id: string;
  title: string;
  content: string;
  knowledge_ids: string[];
  status: 'pending' | 'in_progress' | 'done';
  completed_at: number | null;
  created_at: number;
  updated_at: number;
  version: number;
}

interface KnowledgeNode {
  id: string;
  name: string;
  parent_id: string | null;
  archived_at: number | null;
  effective_domain: string | null;
}

type StatusFilter = '' | 'pending' | 'in_progress' | 'done';

async function fetchList(statusFilter: StatusFilter): Promise<LearningItem[]> {
  const url = statusFilter
    ? `/api/learning-items?status=${statusFilter}`
    : '/api/learning-items';
  const res = await fetch(url, { headers: { 'x-internal-token': INTERNAL_TOKEN } });
  if (!res.ok) throw new Error(`GET /api/learning-items ${res.status}`);
  const body = (await res.json()) as { rows: LearningItem[] };
  return body.rows;
}

async function fetchKnowledge(): Promise<KnowledgeNode[]> {
  const res = await fetch('/api/knowledge', { headers: { 'x-internal-token': INTERNAL_TOKEN } });
  if (!res.ok) throw new Error(`GET /api/knowledge ${res.status}`);
  const body = (await res.json()) as { rows: KnowledgeNode[] };
  return body.rows;
}

async function postCreate(payload: {
  title: string;
  content: string;
  knowledge_ids: string[];
}): Promise<LearningItem> {
  const res = await fetch('/api/learning-items', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST /api/learning-items ${res.status}: ${text}`);
  }
  return (await res.json()) as LearningItem;
}

async function patchItem(
  id: string,
  payload: {
    version: number;
    title?: string;
    content?: string;
    knowledge_ids?: string[];
    status?: 'pending' | 'in_progress' | 'done';
    user_notes?: string;
  },
): Promise<LearningItem> {
  const res = await fetch(`/api/learning-items/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PATCH /api/learning-items/${id} ${res.status}: ${text}`);
  }
  return (await res.json()) as LearningItem;
}

async function deleteItem(id: string, version: number): Promise<void> {
  const res = await fetch(`/api/learning-items/${id}?version=${version}`, {
    method: 'DELETE',
    headers: { 'x-internal-token': INTERNAL_TOKEN },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`DELETE /api/learning-items/${id} ${res.status}: ${text}`);
  }
}

export function LearningItemsList() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [createTitle, setCreateTitle] = useState('');
  const [createContent, setCreateContent] = useState('');
  const [createKnowledgeIds, setCreateKnowledgeIds] = useState<string[]>([]);
  const [expandedItemId, setExpandedItemId] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ['/api/learning-items', statusFilter],
    queryFn: () => fetchList(statusFilter),
  });

  const knowledgeQuery = useQuery({
    queryKey: ['/api/knowledge'],
    queryFn: fetchKnowledge,
  });

  const knowledgeOptions = useMemo(
    () =>
      [...(knowledgeQuery.data ?? [])].sort((a, b) => {
        const da = a.effective_domain ?? '';
        const db = b.effective_domain ?? '';
        if (da !== db) return da.localeCompare(db);
        return a.name.localeCompare(b.name);
      }),
    [knowledgeQuery.data],
  );

  const invalidateList = () =>
    queryClient.invalidateQueries({ queryKey: ['/api/learning-items'] });

  const createMutation = useMutation({
    mutationFn: postCreate,
    onSuccess: () => {
      setCreateTitle('');
      setCreateContent('');
      setCreateKnowledgeIds([]);
      invalidateList();
    },
    onError: (err: Error) => setErrorMsg(err.message),
  });

  const patchMutation = useMutation({
    mutationFn: ({
      id,
      payload,
    }: {
      id: string;
      payload: {
        version: number;
        title?: string;
        content?: string;
        knowledge_ids?: string[];
        status?: 'pending' | 'in_progress' | 'done';
        user_notes?: string;
      };
    }) => patchItem(id, payload),
    onSuccess: () => invalidateList(),
    onError: (err: Error) => setErrorMsg(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) => deleteItem(id, version),
    onSuccess: () => invalidateList(),
    onError: (err: Error) => setErrorMsg(err.message),
  });

  function handleCreate() {
    setErrorMsg(null);
    if (!createTitle.trim()) {
      setErrorMsg('标题不能为空');
      return;
    }
    createMutation.mutate({
      title: createTitle,
      content: createContent,
      knowledge_ids: createKnowledgeIds,
    });
  }

  function transition(item: LearningItem, newStatus: 'pending' | 'in_progress' | 'done') {
    setErrorMsg(null);
    if (newStatus === 'done') {
      const notes = window.prompt('一句话总结你学到了什么 (可空)') ?? '';
      patchMutation.mutate({
        id: item.id,
        payload: {
          version: item.version,
          status: 'done',
          ...(notes.trim() ? { user_notes: notes } : {}),
        },
      });
    } else {
      patchMutation.mutate({
        id: item.id,
        payload: { version: item.version, status: newStatus },
      });
    }
  }

  function handleDelete(item: LearningItem) {
    if (!window.confirm(`删除「${item.title}」?`)) return;
    setErrorMsg(null);
    deleteMutation.mutate({ id: item.id, version: item.version });
  }

  const data = listQuery.data ?? [];

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-xl font-semibold mb-4">学习项</h1>

      <div className="flex gap-2 mb-6 text-sm">
        {(['', 'pending', 'in_progress', 'done'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1 rounded ${statusFilter === s ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700'}`}
          >
            {s === '' ? '全部' : s === 'pending' ? '待办' : s === 'in_progress' ? '进行中' : '已完成'}
          </button>
        ))}
      </div>

      <details className="mb-6 border rounded p-3" open>
        <summary className="text-sm font-medium cursor-pointer">+ 新增学习项</summary>
        <div className="mt-3 space-y-2">
          <input
            type="text"
            value={createTitle}
            onChange={(e) => setCreateTitle(e.target.value)}
            placeholder="标题 (例: 学好之乎者也)"
            className="w-full border rounded p-2 text-sm"
          />
          <textarea
            value={createContent}
            onChange={(e) => setCreateContent(e.target.value)}
            rows={2}
            placeholder="备注 (可空)"
            className="w-full border rounded p-2 text-sm"
          />
          {knowledgeQuery.data && (
            <div className="flex flex-wrap gap-1">
              {knowledgeOptions
                .filter((k) => k.archived_at === null)
                .map((k) => {
                  const checked = createKnowledgeIds.includes(k.id);
                  return (
                    <button
                      key={k.id}
                      type="button"
                      onClick={() =>
                        setCreateKnowledgeIds((prev) =>
                          prev.includes(k.id)
                            ? prev.filter((x) => x !== k.id)
                            : [...prev, k.id],
                        )
                      }
                      className={`text-xs px-2 py-1 rounded ${
                        checked ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {k.name}
                    </button>
                  );
                })}
            </div>
          )}
          <button
            type="button"
            disabled={createMutation.isPending}
            onClick={handleCreate}
            className="bg-slate-900 text-white px-4 py-2 rounded text-sm disabled:opacity-50"
          >
            {createMutation.isPending ? '创建中...' : '创建'}
          </button>
        </div>
      </details>

      {errorMsg && <p className="text-sm text-red-600 mb-3">{errorMsg}</p>}
      {listQuery.isLoading && <p className="text-sm text-slate-500">加载中...</p>}
      {listQuery.isError && (
        <p className="text-sm text-red-600">加载失败: {String(listQuery.error)}</p>
      )}

      <ul className="space-y-3">
        {data.map((item) => (
          <li key={item.id} className="border rounded p-3">
            <div className="flex items-baseline justify-between mb-1">
              <StatusBadge status={item.status} />
              <button
                type="button"
                className="text-xs text-slate-400 hover:text-red-600"
                onClick={() => handleDelete(item)}
              >
                ×
              </button>
            </div>
            <p className="font-medium">{item.title}</p>
            <p className="text-xs text-slate-500 mt-1">
              {item.status === 'done' && item.completed_at
                ? `完成于 ${new Date(item.completed_at * 1000).toLocaleDateString('zh-CN')}`
                : `创建于 ${new Date(item.created_at * 1000).toLocaleDateString('zh-CN')}`}
              {item.knowledge_ids.length > 0 && ` · 知识点: ${item.knowledge_ids.join(', ')}`}
            </p>
            {item.content && (
              <details
                className="mt-2"
                open={expandedItemId === item.id}
                onToggle={(e) => {
                  if ((e.target as HTMLDetailsElement).open) {
                    setExpandedItemId(item.id);
                  }
                }}
              >
                <summary className="text-xs text-slate-500 cursor-pointer">备注</summary>
                <p className="mt-1 text-sm text-slate-700 whitespace-pre-wrap">{item.content}</p>
              </details>
            )}
            <div className="mt-3 flex gap-2 text-xs">
              {item.status === 'pending' && (
                <>
                  <button
                    onClick={() => transition(item, 'in_progress')}
                    className="px-2 py-1 bg-yellow-100 text-yellow-900 rounded"
                  >
                    开始学
                  </button>
                  <button
                    onClick={() => transition(item, 'done')}
                    className="px-2 py-1 bg-green-100 text-green-900 rounded"
                  >
                    我学完了
                  </button>
                </>
              )}
              {item.status === 'in_progress' && (
                <>
                  <button
                    onClick={() => transition(item, 'done')}
                    className="px-2 py-1 bg-green-100 text-green-900 rounded"
                  >
                    我学完了
                  </button>
                  <button
                    onClick={() => transition(item, 'pending')}
                    className="px-2 py-1 bg-slate-100 text-slate-700 rounded"
                  >
                    改回待办
                  </button>
                </>
              )}
              {item.status === 'done' && (
                <button
                  onClick={() => transition(item, 'in_progress')}
                  className="px-2 py-1 bg-yellow-100 text-yellow-900 rounded"
                >
                  重学
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {!listQuery.isLoading && data.length === 0 && (
        <p className="text-sm text-slate-500">还没创建任何学习项 — 试试 + 新增</p>
      )}
    </main>
  );
}

function StatusBadge({ status }: { status: 'pending' | 'in_progress' | 'done' }) {
  const map = {
    pending: { label: '待办', cls: 'bg-slate-100 text-slate-700' },
    in_progress: { label: '进行中', cls: 'bg-yellow-100 text-yellow-800' },
    done: { label: '已完成', cls: 'bg-green-100 text-green-800' },
  };
  const m = map[status];
  return <span className={`text-xs px-2 py-1 rounded ${m.cls}`}>{m.label}</span>;
}
