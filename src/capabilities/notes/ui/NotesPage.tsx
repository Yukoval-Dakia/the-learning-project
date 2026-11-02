// 笔记 (/notes). M3E presentation (YUK-1473, docs/design/2026-11-03-notes-m3e.md): only the
// markup and styles changed; the list query, its key and the search debounce are as before.
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, FileText, List, Network, Search, X } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { useSubjects } from '@/ui/hooks/useSubjects';
import { type SubjectRowLike, listSubjectChoices } from '@/ui/lib/subject';
import { RetryLine } from '@/ui-next/primitives/RetryLine';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { Button, ChipToggle, IconButton, UiNextRoot } from '@/ui-next/public';
import { NoteEmpty } from './NoteEmpty';
import { listNotes } from './notes-api';
import './notes-m3e.css';

const NOTE_TYPE_LABEL: Record<string, string> = {
  note_atomic: '短笔记',
  note_hub: '汇总笔记',
  note_long: '长文笔记',
};

// One sentence of state under the title; blank until the first answer arrives.
function countSentence(count: number | undefined, filtered: boolean): string {
  if (count === undefined) return ' ';
  if (filtered) return `找到 ${count} 篇。`;
  return `共 ${count} 篇。`;
}

function emptyCopy(searching: boolean, subject: string): { title: string; text: string } {
  if (searching) {
    return { title: '没有找到匹配的笔记', text: '换个关键词，或清除搜索看看全部笔记。' };
  }
  if (subject === 'all') {
    return { title: '还没有匹配的笔记', text: '关联知识点的笔记会显示在这里。' };
  }
  return { title: '还没有匹配的笔记', text: '换一个科目筛选试试。' };
}

// Subject filter: one chip per subject plus 全部; a single choice, announced with aria-pressed.
function SubjectChips({
  value,
  rows,
  onChange,
}: {
  value: string;
  rows?: readonly SubjectRowLike[];
  onChange: (value: string) => void;
}) {
  const options = [{ id: 'all', label: '全部' }, ...listSubjectChoices(rows)];
  return (
    <fieldset className="nt-subjects">
      <legend className="nt-subjects-legend">科目</legend>
      {options.map((option) => (
        <ChipToggle
          key={option.id}
          pressed={value === option.id}
          onPressedChange={() => onChange(option.id)}
        >
          {option.label}
        </ChipToggle>
      ))}
    </fieldset>
  );
}

export default function NotesPage({
  navigate,
  list = listNotes,
}: {
  navigate: (to: string) => void;
  list?: typeof listNotes;
}) {
  const [subject, setSubject] = useState('all');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const { subjects } = useSubjects();
  const subjectQuery = subject === 'all' ? undefined : subject;

  // YUK-919 — 250ms 防抖后随查询重发（同 QuestionsPage 的搜索节奏）。输入与清除
  // 都经 changeQuery 重排计时；搜索框卸载（离页）时由 ref cleanup 取消未到期的计时。
  const debounceTimer = useRef<number | null>(null);
  const cancelDebounce = useCallback(() => {
    if (debounceTimer.current === null) return;
    window.clearTimeout(debounceTimer.current);
    debounceTimer.current = null;
  }, []);
  const changeQuery = (next: string) => {
    setQuery(next);
    cancelDebounce();
    debounceTimer.current = window.setTimeout(() => {
      debounceTimer.current = null;
      setDebouncedQuery(next.trim());
    }, 250);
  };
  const searchInputRef = useCallback(
    (node: HTMLInputElement | null) => {
      if (!node) return;
      return cancelDebounce;
    },
    [cancelDebounce],
  );

  const notesQ = useQuery({
    queryKey: ['notes', subjectQuery, debouncedQuery],
    queryFn: () => list(subjectQuery, debouncedQuery || undefined),
  });
  const rows = notesQ.data?.rows ?? [];
  const searching = debouncedQuery.length > 0;

  // Loading, failed, empty, rows: one at a time, in the same order as before.
  const listBody = () => {
    if (notesQ.isLoading) return <SkeletonLines rows={4} label="正在取笔记" />;
    if (notesQ.isError)
      return <RetryLine message="笔记加载失败。" onRetry={() => void notesQ.refetch()} />;
    if (rows.length === 0)
      return <NoteEmpty icon={<FileText size={22} />} {...emptyCopy(searching, subject)} />;
    return (
      <ul className="nt-rows">
        {rows.map((note) => (
          <li key={note.id}>
            <button type="button" className="nt-row" onClick={() => navigate(`/notes/${note.id}`)}>
              <span className="nt-row-icon" aria-hidden="true">
                {note.type === 'note_long' ? <FileText size={17} /> : <List size={17} />}
              </span>
              <span className="nt-row-text">
                <span className="nt-row-title">{note.title}</span>
                <span className="nt-row-meta">
                  {NOTE_TYPE_LABEL[note.type] ?? '笔记'} · 第 {note.version} 版 ·{' '}
                  {new Date(note.updated_at).toLocaleDateString('zh-CN')}
                </span>
              </span>
              <ChevronRight className="nt-row-arrow" size={16} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <UiNextRoot className="nt-page">
      <main className="nt-list-main un-m3e-bridge">
        <header className="nt-head">
          <div className="nt-head-row">
            <h1 className="nt-title">笔记</h1>
            <Button variant="ghost" size="sm" onClick={() => navigate('/knowledge')}>
              <Network size={16} aria-hidden="true" />
              从知识点浏览
            </Button>
          </div>
          <p className="nt-sentence">
            {countSentence(notesQ.data?.rows.length, searching || subject !== 'all')}
          </p>
          <p className="nt-lead">按科目查看已关联知识点的笔记；打开后可继续阅读或编辑。</p>
        </header>

        <div className="nt-controls">
          <div className="nt-search">
            <Search className="nt-search-icon" aria-hidden="true" />
            <input
              ref={searchInputRef}
              type="text"
              className="nt-search-input"
              value={query}
              onChange={(e) => changeQuery(e.target.value)}
              placeholder="搜索笔记标题或正文…"
              aria-label="搜索笔记"
            />
            {query && (
              <IconButton
                className="nt-search-clear"
                label="清除搜索"
                icon={<X size={16} />}
                onClick={() => changeQuery('')}
              />
            )}
          </div>
          <SubjectChips value={subject} rows={subjects} onChange={setSubject} />
        </div>

        <section className="nt-list" aria-label="笔记列表">
          {listBody()}
        </section>
      </main>
    </UiNextRoot>
  );
}
