// YUK-1489 — the draft conflict panel on the practice sheet, in the loft design language. Same
// behaviour and copy as before: this visit's text and the server's current version side by side,
// and two choices (one once the server holds a submitted answer). Autosave is held meanwhile and
// the answer fields are locked; 「返回练习」 still works and says plainly what was not saved.

import { TriangleAlert } from 'lucide-react';
import { Button } from '@/ui-next/public';
import type { DraftSummary, PracticeDraftConflictView } from '../use-practice-submit';

function savedClock(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function DraftVersion({ label, side }: { label: string; side: DraftSummary }) {
  return (
    <div className="un-ps-conflict-side">
      <span className="un-ps-hint">{label}</span>
      <p className="un-ps-conflict-text" data-empty={side.text ? undefined : true}>
        {side.text || '还没写'}
      </p>
      {side.files.length > 0 && <span className="un-ps-hint">另有 {side.files.length} 个附件</span>}
    </div>
  );
}

export function DraftConflictPanel({ view }: { view: PracticeDraftConflictView }) {
  const { conflict, mine, server } = view;
  const submitted = conflict.status === 'ready' && conflict.submitted;
  const clock = savedClock(server?.savedAt ?? null);
  return (
    <div className="un-ps-conflict" aria-live="polite">
      <p className="un-ps-conflict-msg">
        <TriangleAlert size={15} aria-hidden="true" className="un-ps-conflict-ico" />
        {submitted
          ? '这道题已经在别处交过了，你这次写的还没有保存。'
          : '这道题在别处（比如另一个标签页）存了另一份作答，你这次写的还没有保存。选一份留下，再接着写。'}
      </p>
      {conflict.status === 'loading' && <p className="un-ps-hint">正在读取服务器上的那一份…</p>}
      {conflict.status === 'failed' && (
        <div className="un-ps-actions">
          <p className="un-ps-hint">没能读到服务器上的那一份。</p>
          <Button size="sm" variant="secondary" onClick={view.reload}>
            再读一次
          </Button>
        </div>
      )}
      {conflict.status === 'ready' && server && (
        <>
          <div className="un-ps-conflict-cmp">
            <DraftVersion label="你这次写的" side={mine} />
            <DraftVersion
              label={
                submitted
                  ? `交过的${clock ? `（${clock}）` : ''}`
                  : `服务器上的${clock ? `（${clock} 保存）` : ''}`
              }
              side={server}
            />
          </div>
          <p className="un-ps-hint">
            {submitted
              ? '交过的作答不能再改，只能载入它；你这次写的会丢掉。'
              : '用服务器上的：你这次写的会丢掉。保留我的：服务器上那一份会被替换。'}
          </p>
          <div className="un-ps-actions">
            <Button size="sm" variant="secondary" onClick={view.keepServer}>
              {submitted ? '载入交过的作答' : '用服务器上的'}
            </Button>
            {!submitted && (
              <Button size="sm" variant="primary" onClick={view.keepMine}>
                保留我的
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
