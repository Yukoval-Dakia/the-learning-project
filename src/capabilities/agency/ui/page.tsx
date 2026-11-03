// "AI 观察" full-screen drill-in (YUK-294) — the 二级 view reached from the Today
// AgentNotesBoard's 看全部 entry. Same drill-in pattern as /events: full content
// area, breadcrumb back, NO new global nav item.
//
// Read-only spectator surface: agents leave observation signals for each other;
// the user only reads. Zero accept/dismiss — the only stateful interaction is the
// local "已读" toggle (shared localStorage with the Today block).
//
// M0 (YUK-313, REV 2)：去旧路由库 import——capability ui 不 import 路由库，
// 导航以 `navigate` prop 由 Start 路由壳（server/start/routes/）注入，页面保持框架无关。
// M3E 呈现（YUK-1473）：外壳 UiNextRoot.ag-page + main.un-m3e-bridge，样式在
// agent-notes-m3e.css，设计记录 docs/design/2026-11-03-inbox-agent-notes-events-m3e.md。
// 查询、筛选、分组与已读逻辑未动。

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Check, Eye, FileQuestion } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { RetryLine } from '@/ui-next/primitives/RetryLine';
import { SectionHead } from '@/ui-next/primitives/SectionHead';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { Button, ChipToggle, UiNextRoot } from '@/ui-next/public';
import { AgentNoteGroupRow, signalToneRole } from './AgentNoteGroupRow';
import { useAgentNoteClient } from './agent-note-client';
import { type AgentNoteGroup, dayGroupOf, groupAgentNotes } from './derive';
import { SIGNAL_META, signalMeta } from './meta';
import type { BoardAgentNote } from './types';
import { useAgentReads } from './useAgentReads';
import './agent-notes-m3e.css';

type BoardStatus = 'loading' | 'empty' | 'error' | 'ok';

// Loading → error → empty → ok (early returns instead of a chained ternary).
function boardStatus(q: { isLoading: boolean; error: unknown }, count: number): BoardStatus {
  if (q.isLoading) return 'loading';
  if (q.error) return 'error';
  if (count === 0) return 'empty';
  return 'ok';
}

/** One state at a time, in the order the page always had. */
function BoardGate({
  status,
  onRetry,
  empty,
  children,
}: {
  status: BoardStatus;
  onRetry: () => void;
  empty: ReactNode;
  children: ReactNode;
}) {
  if (status === 'loading') return <SkeletonLines rows={4} label="正在读取 AI 观察" />;
  if (status === 'error') return <RetryLine message="无法读取 AI 观察信号。" onRetry={onRetry} />;
  if (status === 'empty') return empty;
  return children;
}

export default function AgentNotesPage({ navigate }: { navigate: (to: string) => void }) {
  const { getAgentNoteBoard } = useAgentNoteClient();
  const now = new Date();
  const [filter, setFilter] = useState<string>('all');
  const { isUnread, markAllRead, unreadCount } = useAgentReads(now);

  const q = useQuery({
    queryKey: ['agent-notes', 'full'],
    queryFn: () => getAgentNoteBoard(50),
  });

  const all: BoardAgentNote[] = q.data?.rows ?? [];

  const state = boardStatus(q, all.length);

  // Signal counts across ALL notes (filter chips reflect the full set, not the
  // filtered subset). SIGNAL_META declaration order wins; unknown signal_kinds
  // append after, so the filter bar still lists them (neutral dot).
  const counts: Record<string, number> = {};
  for (const n of all) counts[n.signal_kind] = (counts[n.signal_kind] ?? 0) + 1;
  const known = Object.keys(SIGNAL_META).filter((k) => counts[k]);
  const unknown = Object.keys(counts).filter((k) => !(k in SIGNAL_META));
  const signalOrder = [...known, ...unknown];

  const notes = filter === 'all' ? all : all.filter((n) => n.signal_kind === filter);
  const allGroups = groupAgentNotes(all);
  const noteGroups = groupAgentNotes(notes);
  const unread = unreadCount(all);
  const agentsActive = new Set(all.flatMap((n) => [n.source_task_kind, ...n.target_agents])).size;

  // Group by real local calendar day (newest-first; today / 昨天 / 更早).
  const groups: Array<{ label: string; items: AgentNoteGroup[] }> = [];
  for (const group of noteGroups) {
    const { label } = dayGroupOf(group.latest.created_at, now);
    let g = groups.find((x) => x.label === label);
    if (!g) {
      g = { label, items: [] };
      groups.push(g);
    }
    g.items.push(group);
  }

  return (
    <UiNextRoot className="ag-page">
      <main className="ag-main un-m3e-bridge">
        <button type="button" className="ag-back" onClick={() => navigate('/today')}>
          <ArrowLeft size={16} aria-hidden="true" />
          今日
        </button>
        <header className="ag-head">
          <h1 className="ag-title">AI 之间的观察</h1>
          <p className="ag-lead">
            各项 AI
            工作给彼此留的观察：谁发现了什么、想让谁去补。你只读旁观，无需裁决；过期信号会自动消失。
          </p>
        </header>

        <BoardGate
          status={state}
          onRetry={() => q.refetch()}
          empty={
            <div className="ag-empty">
              <span className="ag-empty-icon" aria-hidden="true">
                <Eye size={20} />
              </span>
              <p className="ag-empty-title">暂无观察信号</p>
              <p className="ag-empty-text">
                AI 们目前没有互留新的观察。新的信号会在夜间推理与日常运行后出现。
              </p>
              <Button onClick={() => navigate('/practice')}>
                <FileQuestion size={16} aria-hidden="true" />
                开始练习
              </Button>
            </div>
          }
        >
          <section className="ag-overview" aria-label="观察概览">
            <div className="ag-ov-top">
              <p className="ag-ov-stat">
                <span className="ag-ov-n un-num">{all.length}</span>
                <span>
                  活跃观察
                  <span className="ag-quiet">
                    {' '}
                    · 聚合为 {allGroups.length} 个主题 · 涉及 {agentsActive} 项 AI 工作
                  </span>
                </span>
              </p>
              {unread > 0 && (
                <Button size="sm" variant="ghost" onClick={() => markAllRead(all)}>
                  <Check size={14} aria-hidden="true" />
                  全部标为已读（{unread}）
                </Button>
              )}
            </div>
            <fieldset className="ag-filters">
              <legend className="ag-filters-legend">信号</legend>
              <ChipToggle pressed={filter === 'all'} onPressedChange={() => setFilter('all')}>
                全部 <b className="un-num">{all.length}</b>
              </ChipToggle>
              {signalOrder.map((k) => {
                const m = signalMeta(k);
                return (
                  <ChipToggle
                    key={k}
                    pressed={filter === k}
                    onPressedChange={() => setFilter(filter === k ? 'all' : k)}
                  >
                    <span
                      className="ag-dot"
                      data-tone={signalToneRole(m.tone)}
                      aria-hidden="true"
                    />
                    {m.label} <b className="un-num">{counts[k]}</b>
                  </ChipToggle>
                );
              })}
            </fieldset>
            <p className="ag-quiet">重复观察已合并；已过期信号会自动隐藏。</p>
          </section>

          {groups.map((g, i) => (
            <section key={g.label} className="ag-day" aria-labelledby={`ag-day-${i}`}>
              <SectionHead id={`ag-day-${i}`} title={g.label} aside={`${g.items.length} 组`} />
              <div className="ag-feed">
                {g.items.map((group) => (
                  <AgentNoteGroupRow
                    key={group.key}
                    group={group}
                    unread={group.notes.some((note) => isUnread(note))}
                    now={now}
                    onNavigate={(route) => navigate(route)}
                  />
                ))}
              </div>
            </section>
          ))}
          {notes.length === 0 && (
            <p className="ag-filter-empty">
              <Eye size={14} aria-hidden="true" />
              该类型下暂无信号。
            </p>
          )}
        </BoardGate>
      </main>
    </UiNextRoot>
  );
}
