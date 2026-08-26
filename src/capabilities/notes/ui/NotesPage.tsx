import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { SubjectFilterTabs } from '@/ui/components/SubjectFilterTabs';
import { useSubjects } from '@/ui/hooks/useSubjects';
import { Btn } from '@/ui/primitives/Btn';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { listNotes } from './notes-api';

const NOTE_TYPE_LABEL: Record<string, string> = {
  note_atomic: '短笔记',
  note_hub: '汇总笔记',
  note_long: '长文笔记',
};

export default function NotesPage({ navigate }: { navigate: (to: string) => void }) {
  const [subject, setSubject] = useState('all');
  const { subjects } = useSubjects();
  const subjectQuery = subject === 'all' ? undefined : subject;
  const notesQ = useQuery({
    queryKey: ['notes', subjectQuery],
    queryFn: () => listNotes(subjectQuery),
  });
  const rows = notesQ.data?.rows ?? [];

  return (
    <main className="page wide notes-loom">
      <header className="page-head">
        <div className="eyebrow">NOTES · 笔记 · {rows.length} 篇</div>
        <div className="page-head-row">
          <h1 className="page-title serif">笔记</h1>
          <Btn variant="ghost" size="sm" icon="knowledge" onClick={() => navigate('/knowledge')}>
            从知识点浏览
          </Btn>
        </div>
        <p className="page-lead">按科目查看已关联知识点的笔记；打开后可继续阅读或编辑。</p>
        <SubjectFilterTabs value={subject} rows={subjects} onChange={setSubject} />
      </header>

      {notesQ.isLoading ? (
        <p className="quiet-empty">取笔记…</p>
      ) : notesQ.isError ? (
        <div className="card card-pad">
          <p className="quiet-empty">笔记加载失败。</p>
          <Btn size="sm" variant="secondary" onClick={() => void notesQ.refetch()}>
            重试
          </Btn>
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon="doc"
          title="还没有匹配的笔记"
          text={subject === 'all' ? '关联知识点的笔记会显示在这里。' : '换一个科目筛选试试。'}
        />
      ) : (
        <div className="grid" style={{ gap: 'var(--s-3)' }}>
          {rows.map((note) => (
            <button
              type="button"
              key={note.id}
              className="card card-pad"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--s-3)',
                textAlign: 'left',
              }}
              onClick={() => navigate(`/notes/${note.id}`)}
            >
              <LoomIcon name={note.type === 'note_long' ? 'doc' : 'list'} size={17} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontWeight: 500 }}>{note.title}</span>
                <span className="meta">
                  {NOTE_TYPE_LABEL[note.type] ?? '笔记'} · 第 {note.version} 版 ·{' '}
                  {new Date(note.updated_at).toLocaleDateString('zh-CN')}
                </span>
              </span>
              <LoomIcon name="arrow" size={14} className="thread-arrow" />
            </button>
          ))}
        </div>
      )}
    </main>
  );
}
