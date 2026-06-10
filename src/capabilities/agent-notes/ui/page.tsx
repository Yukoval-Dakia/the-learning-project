'use client';

// "AI 观察" full-screen drill-in (YUK-294) — the 二级 view reached from the Today
// AgentNotesBoard's 看全部 entry. Same drill-in pattern as /events: full content
// area, breadcrumb back, NO new global nav item.
//
// Read-only spectator surface: agents leave observation signals for each other;
// the user only reads. Zero accept/dismiss — the only stateful interaction is the
// local "已读" toggle (shared localStorage with the Today block).

import { apiJson } from '@/ui/lib/api';
import { Btn } from '@/ui/primitives/Btn';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SectionLabel } from '@/ui/primitives/SectionLabel';
import { SkLines } from '@/ui/primitives/SkLines';
import { Stateful, type StatefulStatus } from '@/ui/primitives/Stateful';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AgentNoteCard } from './AgentNoteCard';
import { dayGroupOf } from './derive';
import { SIGNAL_META, signalMeta } from './meta';
import type { AgentNotesResponse, BoardAgentNote } from './types';
import { useAgentReads } from './useAgentReads';

export default function AgentNotesPage() {
  const router = useRouter();
  const now = new Date();
  const [filter, setFilter] = useState<string>('all');
  const { isUnread, markAllRead, unreadCount } = useAgentReads(now);

  const q = useQuery({
    queryKey: ['agent-notes', 'full'],
    queryFn: () => apiJson<AgentNotesResponse>('/api/agents/notes?limit=50'),
  });

  const all: BoardAgentNote[] = q.data?.rows ?? [];

  const state: StatefulStatus = q.isLoading
    ? 'loading'
    : q.error
      ? 'error'
      : all.length === 0
        ? 'empty'
        : 'ok';

  // Signal counts across ALL notes (filter chips reflect the full set, not the
  // filtered subset). SIGNAL_META declaration order wins; unknown signal_kinds
  // append after, so the filter bar still lists them (neutral dot).
  const counts: Record<string, number> = {};
  for (const n of all) counts[n.signal_kind] = (counts[n.signal_kind] ?? 0) + 1;
  const known = Object.keys(SIGNAL_META).filter((k) => counts[k]);
  const unknown = Object.keys(counts).filter((k) => !(k in SIGNAL_META));
  const signalOrder = [...known, ...unknown];

  const notes = filter === 'all' ? all : all.filter((n) => n.signal_kind === filter);
  const unread = unreadCount(all);
  const agentsActive = new Set(all.flatMap((n) => [n.source_task_kind, ...n.target_agents])).size;

  // Group by real local calendar day (newest-first; today / 昨天 / 更早).
  const groups: Array<{ label: string; items: BoardAgentNote[] }> = [];
  for (const n of notes) {
    const { label } = dayGroupOf(n.created_at, now);
    let g = groups.find((x) => x.label === label);
    if (!g) {
      g = { label, items: [] };
      groups.push(g);
    }
    g.items.push(n);
  }

  return (
    <main className="page view agentnotes-loom an-scope">
      <button type="button" className="back-link" onClick={() => router.push('/today')}>
        <LoomIcon name="arrowL" size={14} />
        今日
      </button>
      <div className="page-head">
        <div className="eyebrow">
          <span className="dot-sep">●</span>OBSERVE · experimental:agent_note
        </div>
        <h1 className="page-title serif">AI 之间的观察</h1>
        <p className="page-lead">
          各 AI task
          给彼此留的观察信号：谁发现了什么、想让谁去补。你只读旁观，无需裁决；过期信号会自动消失。
        </p>
      </div>

      <Stateful
        status={state}
        onRetry={() => q.refetch()}
        errorText="无法读取 agent 观察信号。"
        skeleton={
          <LoomCard pad>
            <SkLines rows={4} />
          </LoomCard>
        }
        empty={
          <EmptyState
            icon="eye"
            title="暂无观察信号"
            text="AI 们目前没有互留新的观察。新的信号会在夜间推理与日常运行后出现。"
            futureTag="即将接入：对话 agent 误解检测 · 录入 agent 切题反复"
          />
        }
      >
        <LoomCard pad className="an-overview">
          <div className="an-ov-top">
            <div className="an-ov-stat">
              <span className="an-ov-n serif tnum">{all.length}</span>
              <span className="an-ov-lab">
                活跃信号<span className="meta"> · 涉及 {agentsActive} 个 agent · 只读</span>
              </span>
            </div>
            {unread > 0 && (
              <Btn size="sm" variant="ghost" icon="check" onClick={() => markAllRead(all)}>
                全部标为已读（{unread}）
              </Btn>
            )}
          </div>
          <div className="an-filterbar">
            <button
              type="button"
              className={`an-fchip${filter === 'all' ? ' is-on' : ''}`}
              onClick={() => setFilter('all')}
            >
              全部 <b className="mono">{all.length}</b>
            </button>
            {signalOrder.map((k) => {
              const m = signalMeta(k);
              return (
                <button
                  type="button"
                  key={k}
                  className={`an-fchip${filter === k ? ' is-on' : ''}`}
                  onClick={() => setFilter(filter === k ? 'all' : k)}
                >
                  <span className={`an-fdot tone-dot-${m.tone}`} />
                  {m.label} <b className="mono">{counts[k]}</b>
                </button>
              );
            })}
          </div>
        </LoomCard>

        {groups.map((g) => (
          <div key={g.label}>
            <SectionLabel count={`${g.items.length} 条`}>{g.label}</SectionLabel>
            <LoomCard pad>
              <div className="an-feed">
                {g.items.map((n) => (
                  <AgentNoteCard
                    key={n.id}
                    note={n}
                    unread={isUnread(n)}
                    now={now}
                    onNavigate={(route) => router.push(route)}
                  />
                ))}
              </div>
            </LoomCard>
          </div>
        ))}
        {notes.length === 0 && (
          <div className="an-empty">
            <LoomIcon name="eye" size={13} />
            该类型下暂无信号。
          </div>
        )}
      </Stateful>
    </main>
  );
}
