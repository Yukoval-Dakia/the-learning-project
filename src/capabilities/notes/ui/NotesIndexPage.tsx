import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { searchArtifacts } from './notes-api';

export default function NotesIndexPage({ navigate }: { navigate: (to: string) => void }) {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim();
  const searchQ = useQuery({
    queryKey: ['notes-index-search', normalizedQuery],
    queryFn: () => searchArtifacts(normalizedQuery),
    enabled: normalizedQuery.length > 0,
  });

  const rows = searchQ.data?.rows ?? [];

  return (
    <main className="page wide">
      <div className="page-head">
        <div className="eyebrow">整理 · 文档</div>
        <div className="page-head-row">
          <h1 className="page-title serif">我的笔记</h1>
        </div>
        <p className="page-lead">按标题找回已生成的知识笔记和互动内容。</p>
      </div>

      <label className="sr-only" htmlFor="notes-index-search">
        搜索笔记
      </label>
      <div className="composer" style={{ marginBottom: 'var(--s-5)' }}>
        <LoomIcon name="search" size={15} />
        <input
          id="notes-index-search"
          className="input"
          value={query}
          placeholder="搜索笔记标题…"
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </div>

      {searchQ.isError ? (
        <p className="quiet-empty" role="alert">
          笔记搜索暂不可用，请稍后重试。
        </p>
      ) : normalizedQuery.length === 0 ? (
        <EmptyState icon="doc" title="输入标题开始查找" text="笔记会在这里集中显示入口。" />
      ) : rows.length === 0 && !searchQ.isLoading ? (
        <EmptyState icon="doc" title="没有找到匹配笔记" text="换个关键词试试。" />
      ) : (
        <div className="card" aria-busy={searchQ.isLoading}>
          {rows.map((row) => (
            <button
              type="button"
              className="note-link-row"
              key={row.id}
              onClick={() => navigate(`/notes/${encodeURIComponent(row.id)}`)}
            >
              <LoomIcon name={row.type === 'tool_quiz' ? 'sparkle' : 'doc'} size={15} />
              <span className="note-link-title">{row.title}</span>
              <span className="meta">{row.type === 'tool_quiz' ? '互动内容' : '笔记'}</span>
              <LoomIcon name="arrow" size={13} className="thread-arrow" />
            </button>
          ))}
        </div>
      )}
    </main>
  );
}
