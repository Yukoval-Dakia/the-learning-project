'use client';

// /practice — 今日/往日 成卷练习 一级页面.
// Ported from docs/design/loom-prototype/screen-practice.jsx:116-175.
//
// 今日 = papers that are generating, not yet started, or currently in progress.
// 往日 = papers with a completed (or abandoned) session.
// Source-filter tabs apply client-side over the `source` field returned by
// GET /api/practice (§4.10 critic #4 / plan §5.1).
//
// session.type is always 'review' (RL1). No `type='paper'` string here.

import type { PracticePaperItem } from '@/capabilities/practice/server/practice-read';
import { apiJson } from '@/ui/lib/api';
import { PaperCard } from '@/ui/practice/PaperCard';
import { PracticeEmptyToday } from '@/ui/practice/PracticeEmptyToday';
import { Btn } from '@/ui/primitives/Btn';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SectionLabel } from '@/ui/primitives/SectionLabel';
import { SkLines } from '@/ui/primitives/SkLines';
import { Stateful } from '@/ui/primitives/Stateful';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface PracticeListResponse {
  papers: PracticePaperItem[];
}

type FilterId = '全部' | 'coach' | 'custom' | 'note';

const FILTERS: Array<{ id: FilterId; label: string; icon?: 'target' | 'pencil' | 'doc' }> = [
  { id: '全部', label: '全部' },
  { id: 'coach', label: 'Coach 排期', icon: 'target' },
  { id: 'custom', label: '用户自建', icon: 'pencil' },
  { id: 'note', label: '笔记小测', icon: 'doc' },
];

/** Is this paper in "today" bucket: generating (not failed), not started, or in-progress. */
function isToday(p: PracticePaperItem): boolean {
  if (p.generation_status === 'failed') return false; // failed → show in past/error bucket
  if (p.generation_status !== 'ready') return true; // pending/generating (not failed)
  const st = p.session?.status ?? null;
  // CR Round-2 #3359486401: a ready paper with no session is "today" if it was
  // created today (same calendar date). Papers created on previous days with no
  // session have been sitting untouched and belong in 往日.
  // CR Round-3 #3359561294: p.created_at arrives as a JSON string over the wire;
  // always coerce through new Date() before calling Date methods.
  if (st === null) {
    const today = new Date();
    const c = new Date(p.created_at);
    return (
      c.getFullYear() === today.getFullYear() &&
      c.getMonth() === today.getMonth() &&
      c.getDate() === today.getDate()
    );
  }
  if (st === 'abandoned') return false; // abandoned → 往日
  return st !== 'completed'; // started/paused → today
}

/** Is this paper in "往日" bucket: a completed (or abandoned+ready) past paper. */
function isPast(p: PracticePaperItem): boolean {
  return !isToday(p);
}

export default function PracticePage() {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterId>('全部');

  const listQ = useQuery({
    queryKey: ['practice-list'],
    queryFn: () => apiJson<PracticeListResponse>('/api/practice'),
  });

  const allPapers = listQ.data?.papers ?? [];
  const todayPapers = allPapers.filter(isToday);
  const pastPapers = allPapers.filter(isPast);
  const filteredPast =
    filter === '全部' ? pastPapers : pastPapers.filter((p) => p.source === filter);

  const listStatus = listQ.isLoading ? 'loading' : listQ.isError ? 'error' : 'ok';

  function handleAction(artifactId: string) {
    router.push(`/practice/${artifactId}`);
  }

  const eyebrow = `PRACTICE · 成卷练习 · 今日 ${todayPapers.length} · 往日 ${pastPapers.length}`;

  return (
    <div className="page view practice-loom">
      {/* ── page head ── */}
      <div className="page-head">
        <div className="eyebrow">
          <span className="dot-sep">●</span>
          {eyebrow}
        </div>
        <div className="page-head-row">
          <h1 className="page-title serif">练习</h1>
          <div className="practice-aux">
            <Btn variant="ghost" icon="clock" onClick={() => router.push('/coach')}>
              Coach 排期
            </Btn>
            <Btn variant="secondary" icon="plus" onClick={() => router.push('/record')}>
              新建自定义卷
            </Btn>
          </div>
        </div>
        <p className="page-lead">
          成卷练习管理成组的试卷 —— Coach
          夜间排出的今日卷、你自建的测验，以及笔记里的内嵌小测。与「复习」逐张到期的 FSRS
          流不同，这里以整张卷为单位作答与回顾。
        </p>
      </div>

      {/* ── 今日 ── */}
      <SectionLabel count={todayPapers.length}>今日</SectionLabel>
      <Stateful
        status={listStatus}
        onRetry={() => void listQ.refetch()}
        errorText="无法读取今日成卷。"
        skeleton={
          <div className="paper-grid">
            {[1, 2].map((i) => (
              <LoomCard key={i} pad>
                <SkLines rows={2} />
              </LoomCard>
            ))}
          </div>
        }
        empty={<PracticeEmptyToday />}
      >
        {todayPapers.length === 0 ? (
          <PracticeEmptyToday />
        ) : (
          <div className="paper-grid stagger">
            {todayPapers.map((p) => (
              <PaperCard key={p.artifact_id} paper={p} onAction={handleAction} />
            ))}
          </div>
        )}
      </Stateful>

      {/* ── 往日 ── */}
      <SectionLabel count={pastPapers.length}>往日</SectionLabel>

      {/* source-filter tabs — client-side predicate over `source` (§4.10 critic #4) */}
      <div className="status-tabs" role="tablist">
        {FILTERS.map((f) => {
          const n =
            f.id === '全部'
              ? pastPapers.length
              : pastPapers.filter((p) => p.source === f.id).length;
          return (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              className={`status-tab${filter === f.id ? ' on' : ''}`}
              onClick={() => setFilter(f.id)}
            >
              {f.icon && <LoomIcon name={f.icon} size={13} />}
              {f.label}
              <span className="mono status-tab-n">{n}</span>
            </button>
          );
        })}
      </div>

      <Stateful
        status={listStatus}
        onRetry={() => void listQ.refetch()}
        errorText="无法读取往日成卷。"
        skeleton={
          <div className="paper-grid">
            {[1, 2].map((i) => (
              <LoomCard key={i} pad>
                <SkLines rows={2} />
              </LoomCard>
            ))}
          </div>
        }
        empty={
          <EmptyState
            icon="history"
            title="这个来源还没有记录"
            text="切换其它来源，或先做一张卷。"
          />
        }
      >
        {filteredPast.length === 0 ? (
          <EmptyState
            icon="history"
            title="这个来源还没有记录"
            text="切换其它来源，或先做一张卷。"
          />
        ) : (
          <div className="paper-grid stagger">
            {filteredPast.map((p) => (
              <PaperCard key={p.artifact_id} paper={p} onAction={handleAction} past />
            ))}
          </div>
        )}
      </Stateful>
    </div>
  );
}
