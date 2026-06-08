// AgentNotesBoard — the compact, read-only "AI 观察" block on /today.
//
// Quieter than the proposal inbox by design: a SUNK dashed panel holding a
// log-feed with NO action buttons ("AI 间的自言自语", not "等你裁决的提案").
// Caps at 3 notes; "看全部" drills into the full-screen /agent-notes view.
// Collapse + read state is purely local (useAgentReads → localStorage).
//
// Empty state is a single faint line — no SectionLabel, no card — so an empty
// board never occupies 版面 (the common early-stage case).

import { formatRelTime } from '@/ui/lib/utils';
import { Btn } from '@/ui/primitives/Btn';
import { ErrorState } from '@/ui/primitives/ErrorState';
import { LoomBadge } from '@/ui/primitives/LoomBadge';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SectionLabel } from '@/ui/primitives/SectionLabel';
import { SkLines } from '@/ui/primitives/SkLines';
import { AgentNoteCard } from './AgentNoteCard';
import { agentMeta, signalMeta } from './meta';
import type { BoardAgentNote } from './types';
import { useAgentReads } from './useAgentReads';

const COMPACT_CAP = 3;

export interface AgentNotesBoardProps {
  notes: BoardAgentNote[];
  status: 'loading' | 'error' | 'ok';
  now: Date;
  onRetry: () => void;
  onNavigate: (route: string) => void;
}

export function AgentNotesBoard({ notes, status, now, onRetry, onNavigate }: AgentNotesBoardProps) {
  const { open, toggleOpen, isUnread, markAllRead, unreadCount } = useAgentReads(now);

  // Empty — a single faint line, no section label, no card. (Loading/error
  // still render the block so retry is reachable.)
  if (status === 'ok' && notes.length === 0) {
    return (
      <div className="an-empty an-scope">
        <LoomIcon name="eye" size={13} />
        暂时没有 AI 间的观察信号。
      </div>
    );
  }

  const latest = notes[0];
  const unread = unreadCount(notes);
  const visible = notes.slice(0, COMPACT_CAP);

  return (
    <div className="an-scope">
      <SectionLabel count={`${notes.length} 条`}>AI 观察</SectionLabel>
      <LoomCard pad className={`an-board${open ? ' is-open' : ''}`}>
        <div className="an-head">
          <button
            type="button"
            className="an-head-toggle"
            aria-expanded={open}
            onClick={toggleOpen}
          >
            <span className="card-icon">
              <LoomIcon name="eye" size={18} />
            </span>
            <span className="an-head-titles">
              <span className="card-title">AI 之间的观察</span>
              <span className="an-sub">agent 互留的协作信号 · 无需你裁决</span>
            </span>
          </button>
          <span className="an-head-spacer" />
          {unread > 0 && (
            <LoomBadge tone="coral" dot pulse>
              {unread} 新
            </LoomBadge>
          )}
          <button type="button" className="an-open-full" onClick={() => onNavigate('/agent-notes')}>
            看全部
            <LoomIcon name="arrow" size={14} />
          </button>
          <button
            type="button"
            className="an-chev-btn"
            aria-label={open ? '收起' : '展开'}
            onClick={toggleOpen}
          >
            <LoomIcon name="chevronDown" size={18} className="an-chev" />
          </button>
        </div>

        {status === 'loading' ? (
          <SkLines rows={2} />
        ) : status === 'error' ? (
          <ErrorState text="无法读取 agent 观察信号。" onRetry={onRetry} compact />
        ) : open ? (
          <>
            <div className="an-feed">
              {visible.map((n) => (
                <AgentNoteCard
                  key={n.id}
                  note={n}
                  unread={isUnread(n)}
                  now={now}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
            <div className="an-foot">
              <span className="meta">只读旁观 · 过期信号自动消失</span>
              {notes.length > COMPACT_CAP && (
                <button
                  type="button"
                  className="an-foot-link"
                  onClick={() => onNavigate('/agent-notes')}
                >
                  还有 {notes.length - COMPACT_CAP} 条 · 看全部
                  <LoomIcon name="arrow" size={13} />
                </button>
              )}
              {unread > 0 && (
                <Btn size="sm" variant="ghost" icon="check" onClick={() => markAllRead(notes)}>
                  全部已读
                </Btn>
              )}
            </div>
          </>
        ) : (
          <button type="button" className="an-peek" onClick={toggleOpen}>
            <LoomIcon name="dots" size={14} className="meta" />
            <span className="an-peek-txt">
              <b>{agentMeta(latest.source_task_kind).label}</b> →{' '}
              {agentMeta(latest.target_agents[0] ?? '').label}
              {latest.target_agents.length > 1 ? ' 等' : ''} 提到「
              {signalMeta(latest.signal_kind).label}」
            </span>
            <span className="meta">· {formatRelTime(latest.created_at, now)}</span>
          </button>
        )}
      </LoomCard>
    </div>
  );
}
