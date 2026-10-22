// 对话记录: every conversation, newest first, over the conversation area (the header and the
// composer stay reachable). Picking one or starting a new one closes the list; Esc closes only the
// list. A conversation that has ended opens read-only. Switching only detaches streams — runs in
// the conversation left behind keep going on the server.

import { Plus } from 'lucide-react';
import { useCallback } from 'react';
import { useFocusTrap } from '@/ui/primitives/useFocusTrap';
import { Button, Chip } from '@/ui-next/public';
import type { CompanionController } from './companion-controller';
import { visibleSessions } from './companion-state';
import { toRecentConversation } from './recent-conversation';
import { useCompanion, useCompanionShallow } from './use-companion';

function shortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

export function ConversationList({
  controller,
  id,
}: {
  controller: CompanionController;
  id: string;
}) {
  const sessions = useCompanionShallow(controller, visibleSessions);
  const currentId = useCompanion(controller, (s) => s.currentSessionId);
  const creating = useCompanion(controller, (s) => s.creatingSession);
  const { actions, sessions: visits } = controller;
  const close = useCallback(() => actions.setListOpen(false), [actions]);
  const trapRef = useFocusTrap(true, close);
  const rows = sessions.map(toRecentConversation);

  return (
    <div className="un-cp-list-layer">
      <button
        type="button"
        tabIndex={-1}
        aria-label="收起对话记录"
        className="un-cp-list-scrim"
        onClick={close}
      />
      <section id={id} ref={trapRef} className="un-cp-list un-glass" aria-label="对话记录">
        <header className="un-cp-list-head">
          <h3 className="un-cp-list-title">对话记录</h3>
          <Button
            variant="secondary"
            size="sm"
            disabled={creating}
            onClick={() => {
              close();
              void visits.createConversation();
            }}
          >
            <Plus size={14} aria-hidden="true" />
            {creating ? '创建中…' : '新对话'}
          </Button>
        </header>
        {rows.length === 0 ? (
          <p className="un-cp-quiet un-cp-list-empty">还没有对话。</p>
        ) : (
          <ul className="un-cp-list-rows">
            {rows.map((row) => {
              const current = row.id === currentId;
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    className="un-cp-list-row"
                    aria-current={current ? 'true' : undefined}
                    disabled={current}
                    onClick={() => {
                      close();
                      visits.selectConversation(row.id);
                    }}
                  >
                    <span className="un-cp-list-row-title">{row.title}</span>
                    {row.continuable ? null : <Chip>已结束</Chip>}
                    <time className="un-cp-list-row-date un-num" dateTime={row.updatedAt}>
                      {shortDate(row.updatedAt)}
                    </time>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
