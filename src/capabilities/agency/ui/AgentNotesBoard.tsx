// AgentNotesBoard — the compact, read-only "AI 观察" block on /today.
//
// Quieter than the proposal inbox by design: a SUNK panel holding a log-feed with NO
// decision buttons ("AI 间的自言自语", not "等你裁决的提案").
// Caps at 3 notes; "看全部" drills into the full-screen /agent-notes view.
// Collapse + read state is purely local (useAgentReads → localStorage).
//
// Empty state is a single faint line — no section heading, no card — so an empty
// board never occupies 版面 (the common early-stage case).
//
// YUK-1713 — M3E presentation: the same grouped rows as /agent-notes (AgentNoteGroupRow),
// ui-next Button / RetryLine / SkeletonLines, styles in agent-notes-m3e.css (.ag-board*).
// Grouping, the cap, unread counting, mark-all-read and every navigation target are unchanged.

import { ArrowRight, Check, ChevronDown, Ellipsis, Eye } from 'lucide-react';
import type { ReactNode } from 'react';
import { formatRelTime } from '@/ui/lib/utils';
import { RetryLine } from '@/ui-next/primitives/RetryLine';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { Button } from '@/ui-next/public';
import { AgentNoteGroupRow } from './AgentNoteGroupRow';
import { groupAgentNotes } from './derive';
import { agentMeta, signalMeta } from './meta';
import type { BoardAgentNote } from './types';
import { useAgentReads } from './useAgentReads';
import './agent-notes-m3e.css';

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
      <p className="ag-board-empty un-m3e-bridge">
        <Eye size={14} aria-hidden="true" />
        暂时没有 AI 间的观察信号。
      </p>
    );
  }

  const groups = groupAgentNotes(notes);
  const latest = groups[0]?.latest;
  const unread = unreadCount(notes);
  const visible = groups.slice(0, COMPACT_CAP);

  // One body at a time, in the order the board always had: loading → error → open feed →
  // collapsed peek of the latest note → nothing (if/else instead of a nested ternary).
  let body: ReactNode = null;
  if (status === 'loading') {
    body = <SkeletonLines rows={2} label="正在读取 AI 观察" />;
  } else if (status === 'error') {
    body = <RetryLine message="无法读取 AI 观察信号。" onRetry={onRetry} />;
  } else if (open) {
    body = (
      <>
        <div className="ag-feed">
          {visible.map((group) => (
            <AgentNoteGroupRow
              key={group.key}
              group={group}
              unread={group.notes.some((note) => isUnread(note))}
              now={now}
              onNavigate={onNavigate}
            />
          ))}
        </div>
        <div className="ag-board-foot">
          <span className="ag-quiet ag-board-note">只读旁观 · 过期信号自动消失</span>
          {groups.length > COMPACT_CAP && (
            <button
              type="button"
              className="ag-board-more un-hit"
              onClick={() => onNavigate('/agent-notes')}
            >
              还有 {groups.length - COMPACT_CAP} 组 · 看全部
              <ArrowRight size={13} aria-hidden="true" />
            </button>
          )}
          {unread > 0 && (
            <Button size="sm" variant="ghost" onClick={() => markAllRead(notes)}>
              <Check size={16} aria-hidden="true" />
              全部已读
            </Button>
          )}
        </div>
      </>
    );
  } else if (latest) {
    body = (
      <button type="button" className="ag-board-peek" onClick={toggleOpen}>
        <Ellipsis size={14} aria-hidden="true" />
        <span className="ag-board-peek-t">
          <b>{agentMeta(latest.source_task_kind).label}</b> →{' '}
          {agentMeta(latest.target_agents[0] ?? '').label}
          {latest.target_agents.length > 1 ? ' 等' : ''} 提到「
          {signalMeta(latest.signal_kind).label}」
        </span>
        <span className="ag-quiet">· {formatRelTime(latest.created_at, now)}</span>
      </button>
    );
  }

  return (
    <section className="ag-board un-m3e-bridge">
      <div className="ag-board-label">
        <h2 className="un-today-section-title">AI 观察</h2>
        <span className="ag-quiet un-num">{`${groups.length} 组 · ${notes.length} 条`}</span>
      </div>
      <div className="ag-board-card" data-open={open ? '1' : '0'}>
        <div className="ag-board-head">
          <button
            type="button"
            className="ag-board-toggle"
            aria-expanded={open}
            onClick={toggleOpen}
          >
            <span className="ag-board-ic" aria-hidden="true">
              <Eye size={18} />
            </span>
            <span className="ag-board-titles">
              <span className="ag-board-title">AI 之间的观察</span>
              <span className="ag-quiet">AI 工作间互留的协作信号 · 无需你裁决</span>
            </span>
          </button>
          {unread > 0 && (
            <span className="ag-tag un-num" data-tone="accent">
              {unread} 新
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={() => onNavigate('/agent-notes')}>
            看全部
            <ArrowRight size={14} aria-hidden="true" />
          </Button>
          <button
            type="button"
            className="ag-board-chevbtn un-hit"
            aria-label={open ? '收起' : '展开'}
            onClick={toggleOpen}
          >
            <ChevronDown size={18} aria-hidden="true" className="ag-board-chev" />
          </button>
        </div>
        {body}
      </div>
    </section>
  );
}
