'use client';

import {
  CorrectionStateRenderer,
  type CorrectionStateSnapshot,
} from '@/ui/correction/CorrectionStateRenderer';
import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { formatRelTime } from '@/ui/lib/utils';
import { Btn } from '@/ui/primitives/Btn';
import { CauseBadge } from '@/ui/primitives/CauseBadge';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SkLines } from '@/ui/primitives/SkLines';
import { Stateful, type StatefulStatus } from '@/ui/primitives/Stateful';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

interface MistakeRow {
  id: string;
  question_id: string;
  prompt_md: string;
  wrong_answer_md: string;
  knowledge_ids: string[];
  cause: {
    source?: 'user' | 'agent';
    primary_category: string;
    secondary_categories?: string[];
    user_notes: string | null;
    confidence?: number | null;
  } | null;
  correction_state: CorrectionStateSnapshot;
  created_at: number; // unix seconds
}

export default function MistakesPage() {
  const q = useQuery({
    queryKey: ['mistakes'],
    queryFn: () => apiJson<{ rows: MistakeRow[] }>('/api/mistakes?limit=100'),
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });

  const rows = q.data?.rows ?? [];
  const total = rows.length;
  const pending = rows.filter((r) => r.cause === null).length;

  // Map the single query's status onto the Stateful status vocabulary. Error
  // copy still distinguishes the auth case (token re-entry) from generic load
  // failure, mirroring the legacy page's two-branch error message.
  const status: StatefulStatus = q.isLoading
    ? 'loading'
    : q.isError
      ? 'error'
      : total === 0
        ? 'empty'
        : 'ok';
  const errorText =
    q.error instanceof ApiAuthError
      ? `${q.error.message} — 请重新进入页面输入 token`
      : q.error
        ? `加载失败：${(q.error as Error).message}`
        : '错题加载失败。';

  return (
    // Scoped under .mistakes-loom so the loom chrome / card classes do not
    // collide with legacy globals of the same name (sibling of .today-loom /
    // .knowledge-loom).
    <main className="page mistakes-page mistakes-loom">
      <div className="page-head">
        <div className="eyebrow">
          MISTAKES · 错题归因{total > 0 ? ` · 最近 ${total} 条 · 归因中 ${pending}` : ''}
        </div>
        <div className="page-head-row">
          <h1 className="page-title serif">错题本</h1>
          <div className="hero-cta">
            {/* Pure navigation chrome (no new data wiring): record + review. */}
            <Link href="/record">
              <Btn variant="ghost" size="sm" icon="record">
                录新错题
              </Btn>
            </Link>
            <Link href="/review">
              <Btn variant="primary" size="sm" icon="review">
                重练薄弱点
              </Btn>
            </Link>
          </div>
        </div>
        <p className="page-lead">
          每条错题是一条 event-sourced 记录：题面 / 错答 / 知识点 / 归因（AI vs 人）/
          纠错状态。点「→ 事件链」看完整 caused_by 链。
        </p>
      </div>

      <Stateful
        status={status}
        onRetry={() => q.refetch()}
        errorText={errorText}
        skeleton={
          <div className="grid" style={{ gap: 'var(--s-3)' }}>
            {[1, 2, 3].map((i) => (
              <LoomCard key={i} pad>
                <SkLines rows={1} />
              </LoomCard>
            ))}
          </div>
        }
        empty={
          <EmptyState
            icon="mistakes"
            title="还没有错题"
            text="复习答错或手动录入后，错题会聚到这里并自动归因。"
            action={
              <Link href="/record">
                <Btn variant="primary" size="sm" icon="record">
                  录新错题
                </Btn>
              </Link>
            }
          />
        }
      >
        <div className="grid stagger" style={{ gap: 'var(--s-3)' }}>
          {rows.map((row) => (
            <MistakeCard key={row.id} row={row} />
          ))}
        </div>
      </Stateful>
    </main>
  );
}

function MistakeCard({ row }: { row: MistakeRow }) {
  const createdAt = new Date(row.created_at * 1000);
  const pendingSince = Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / 1000));
  const cause = row.cause
    ? {
        actor_kind: row.cause.source === 'user' ? ('user' as const) : ('agent' as const),
        primary: row.cause.primary_category,
        secondary: row.cause.secondary_categories ?? [],
        confidence: row.cause.confidence ?? null,
      }
    : null;
  return (
    <LoomCard pad className="mistake-card">
      <div className="mistake-top">
        <div className="mistake-q wenyan">{row.prompt_md}</div>
        <span className="mistake-time mono">{formatRelTime(createdAt)}</span>
      </div>

      {/* phase-deferred: the 正解 (reference_md) is NOT carried in the
          /api/mistakes projection (listMistakeProjectionRows returns only
          prompt_md + wrong_answer_md — see src/server/records/mistakes.ts L61).
          The prototype's 误/正 two-row compare degrades to a single 误 row
          until the projection is extended to return reference_md. */}
      {row.wrong_answer_md && (
        <div className="mistake-cmp">
          <span className="mistake-cmp-line">
            <span className="cmp-label">误</span>
            <span className="cmp-wrong">{row.wrong_answer_md}</span>
          </span>
        </div>
      )}

      <div className="mistake-meta-row">
        <div className="kp-badges">
          {/* No knowledge-name query on this page (projection returns only
              knowledge_ids); chips show the id text and link to /knowledge,
              matching the legacy page's behaviour. */}
          {row.knowledge_ids.map((id) => (
            <Link key={id} href="/knowledge" className="chip chip-k mono kp-chip">
              {id}
            </Link>
          ))}
        </div>
        <div className="mistake-state-cluster">
          <CorrectionStateRenderer state={row.correction_state} compact />
          <CauseBadge cause={cause} pendingSinceSec={pendingSince} />
        </div>
      </div>

      <div className="mistake-foot">
        {/* Inline event-chain expansion (prototype m.events[]) is dropped: this
            page has no event-list query — the full caused_by chain lives on the
            /events/[id] detail route. Keep the link. */}
        <Link href={`/events/${row.id}`} className="mistake-evlink mono">
          <LoomIcon name="link" size={12} />→ 事件链 · events:{row.id.slice(0, 8)}
        </Link>
      </div>
    </LoomCard>
  );
}
