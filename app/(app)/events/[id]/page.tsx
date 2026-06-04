'use client';

// Phase 1d — single event detail + chain navigation (loom redraw, wave 2 / YUK-169).
//
// "错题详情" used to mean opening the Mistake row. Post-event-stream the
// concept maps to "open this attempt event with its caused_by_event_id chain
// + payload pretty-printed". This page is the chain explorer; downstream
// flows (rate, accept, etc.) keep their existing entry points. The correction
// write path (CorrectionControls) keeps its real wiring — only the visual
// shell is loom-ified.

import {
  CorrectionStateRenderer,
  type CorrectionStateSnapshot,
} from '@/ui/correction/CorrectionStateRenderer';
import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { type ActivityRefInput, affectedRefsForCorrection } from '@/ui/lib/event-corrections';
import { formatRelTime } from '@/ui/lib/utils';
import { Btn } from '@/ui/primitives/Btn';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import type { LoomIconName } from '@/ui/primitives/LoomIcon';
import { SectionLabel } from '@/ui/primitives/SectionLabel';
import { SkLines } from '@/ui/primitives/SkLines';
import { Stateful, type StatefulStatus } from '@/ui/primitives/Stateful';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { use, useState } from 'react';

interface CorrectionStatus extends CorrectionStateSnapshot {
  correction_event_id: string | null;
  replacement_event_id: string | null;
}

interface EventRow {
  id: string;
  actor_kind: string;
  actor_ref: string;
  action: string;
  subject_kind: string;
  subject_id: string;
  outcome: string | null;
  payload: Record<string, unknown>;
  caused_by_event_id?: string;
  task_run_id?: string;
  cost_micro_usd?: number;
  created_at: string;
  correction_status: CorrectionStatus;
}

interface EventChainResponse {
  event: EventRow;
  correction_status: CorrectionStatus;
  chain: {
    caused_by: EventRow | null;
    caused_events: EventRow[];
    corrections: EventRow[];
  };
}

// actor_kind → loom icon (prototype ACTOR_ICON, screen-events.jsx L2).
const ACTOR_ICON: Record<string, LoomIconName> = {
  user: 'today',
  agent: 'sparkle',
  cron: 'moon',
  system: 'bolt',
};

function actorIcon(kind: string): LoomIconName {
  return ACTOR_ICON[kind] ?? 'bolt';
}

function eventTone(e: EventRow): string {
  if (e.outcome === 'failure') return 'again';
  if (e.outcome === 'success') return 'good';
  if (e.outcome === 'partial') return 'hard';
  if (e.action === 'propose' || e.action.startsWith('experimental:')) return 'coral';
  return 'info';
}

export default function EventDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['event', id],
    queryFn: () => apiJson<EventChainResponse>(`/api/events/${id}`),
  });

  const state: StatefulStatus = q.isLoading ? 'loading' : q.isError ? 'error' : 'ok';
  const errorText =
    q.error instanceof ApiAuthError
      ? `${q.error.message} — 请重新进入页面输入 token`
      : q.error
        ? `加载失败：${(q.error as Error).message}`
        : '事件加载失败。';

  return (
    <main className="page page-narrow events-loom">
      <button type="button" className="back-link" onClick={() => router.push('/mistakes')}>
        <LoomIcon name="arrowL" size={14} />
        错题
      </button>

      <div className="page-head">
        <div className="eyebrow">EVENT · {id.slice(0, 8)}…</div>
        <h1 className="page-title serif">事件链</h1>
        <p className="page-lead">
          每个事件是不可变记录，带 actor、caused_by 链与成本。下面是该焦点事件的来龙去脉。
        </p>
      </div>

      <Stateful
        status={state}
        onRetry={() => q.refetch()}
        errorText={errorText}
        skeleton={
          <LoomCard pad>
            <SkLines rows={3} />
          </LoomCard>
        }
      >
        {q.isSuccess && (
          <>
            {/* caused_by · 由什么导致 */}
            {q.data.chain.caused_by && (
              <div className="ev-lane">
                <div className="ev-lane-label meta">caused_by · 由什么导致</div>
                <button
                  type="button"
                  className="ev-node ev-cause"
                  onClick={() => router.push(`/events/${q.data.chain.caused_by?.id}`)}
                >
                  <span className="ev-actor">
                    <LoomIcon name={actorIcon(q.data.chain.caused_by.actor_kind)} size={14} />
                  </span>
                  <span>
                    {q.data.chain.caused_by.action} · {q.data.chain.caused_by.subject_kind}
                  </span>
                  <LoomIcon name="arrow" size={13} className="thread-arrow" />
                </button>
                <div className="ev-connector" />
              </div>
            )}

            {/* focal */}
            <FocalEvent event={q.data.event} />
            <CorrectionControls
              event={q.data.event}
              onChanged={() => qc.invalidateQueries({ queryKey: ['event', id] })}
            />

            {/* downstream */}
            {q.data.chain.caused_events.length > 0 && (
              <div className="ev-lane">
                <div className="ev-connector" />
                <div className="ev-lane-label meta">
                  导致了 · downstream · {q.data.chain.caused_events.length} 条
                </div>
                {q.data.chain.caused_events.map((e) => (
                  <button
                    type="button"
                    key={e.id}
                    className="ev-node"
                    onClick={() => router.push(`/events/${e.id}`)}
                    style={{ marginBottom: 'var(--s-2)' }}
                  >
                    <span
                      className={`ev-dot tone-${eventTone(e)}`}
                      style={{ background: `var(--${eventTone(e)})` }}
                    />
                    <span>
                      {e.action}
                      {e.outcome ? `:${e.outcome}` : ''} · {e.subject_kind}
                    </span>
                    <span className="ev-actor-mini mono">{e.actor_kind}</span>
                  </button>
                ))}
              </div>
            )}

            {/* corrections · 纠正 */}
            {q.data.chain.corrections.length > 0 && (
              <>
                <SectionLabel count={q.data.chain.corrections.length}>
                  corrections · 纠正
                </SectionLabel>
                <LoomCard pad>
                  {q.data.chain.corrections.map((e) => (
                    // Clickable like the downstream ev-node rows — the old
                    // EventCard path linked corrections to their own event
                    // page (Codex, PR #294 r2).
                    <button
                      type="button"
                      key={e.id}
                      className="corr-row"
                      onClick={() => router.push(`/events/${e.id}`)}
                      style={{
                        background: 'none',
                        border: 0,
                        font: 'inherit',
                        cursor: 'pointer',
                        width: '100%',
                        textAlign: 'left',
                      }}
                    >
                      <span className="ev-dot tone-good" style={{ background: 'var(--good)' }} />
                      <span>
                        {e.action}
                        {e.outcome ? `:${e.outcome}` : ''}
                      </span>
                      <span className="meta" style={{ marginLeft: 'auto' }}>
                        {formatRelTime(new Date(e.created_at))} · {e.actor_kind}
                      </span>
                    </button>
                  ))}
                </LoomCard>
              </>
            )}
          </>
        )}
      </Stateful>
    </main>
  );
}

function FocalEvent({ event }: { event: EventRow }) {
  const [rawOpen, setRawOpen] = useState(false);
  return (
    <div className="ev-focal">
      <div className="ev-focal-head">
        <span className="badge tone-again">
          <span className="dot" />
          focal
        </span>
        <span className="ev-actor">
          <LoomIcon name={actorIcon(event.actor_kind)} size={14} />
          {event.actor_kind}
        </span>
        <CorrectionStateRenderer state={event.correction_status} showActive compact />
        <span className="meta mono" style={{ marginLeft: 'auto' }}>
          {formatRelTime(new Date(event.created_at))}
        </span>
      </div>
      {/* gap G6: no human-readable subject name server-side — use real ids */}
      <div className="ev-focal-title serif">
        {event.action}
        {event.outcome ? `:${event.outcome}` : ''} ·{' '}
        <span className="mono">
          {event.subject_kind}:{event.subject_id}
        </span>
      </div>
      {event.caused_by_event_id && (
        <div className="meta mono" style={{ marginTop: 'var(--s-2)' }}>
          caused_by · {event.caused_by_event_id.slice(0, 8)}…
        </div>
      )}
      {event.task_run_id && (
        <div className="meta mono">task_run · {event.task_run_id.slice(0, 12)}…</div>
      )}
      {typeof event.cost_micro_usd === 'number' && event.cost_micro_usd > 0 && (
        <div className="meta mono">cost · ${(event.cost_micro_usd / 1e6).toFixed(5)}</div>
      )}
      <button
        type="button"
        className={`raw-toggle${rawOpen ? ' open' : ''}`}
        onClick={() => setRawOpen((o) => !o)}
      >
        <LoomIcon name="slash" size={13} />
        {rawOpen ? '收起' : '展开'} raw payload
      </button>
      {rawOpen && <pre className="raw-payload">{JSON.stringify(event.payload, null, 2)}</pre>}
    </div>
  );
}

function CorrectionControls({
  event,
  onChanged,
}: {
  event: EventRow;
  onChanged: () => Promise<unknown>;
}) {
  const [reasonMd, setReasonMd] = useState('');
  const affectedRefs = affectedRefsForCorrection(event);
  const correctionM = useMutation({
    mutationFn: (correction_kind: 'retract' | 'mark_wrong' | 'restore') =>
      apiJson<{ correction_event_id: string }>(`/api/events/${event.id}/correct`, {
        method: 'POST',
        body: JSON.stringify({
          correction_kind,
          reason_md: reasonMd.trim(),
          affected_refs: affectedRefs,
        }),
      }),
    onSuccess: async () => {
      setReasonMd('');
      await onChanged();
    },
  });
  const canSubmit = reasonMd.trim().length > 0 && affectedRefs.length > 0 && !correctionM.isPending;

  return (
    <section className="ec-correction-panel">
      <div className="ec-correction-head">
        <CorrectionStateRenderer state={event.correction_status} showActive />
      </div>

      <textarea
        value={reasonMd}
        onChange={(e) => setReasonMd(e.target.value)}
        rows={3}
        placeholder="reason_md"
      />

      <div className="ec-correction-actions">
        <Btn
          size="sm"
          variant="secondary"
          disabled={!canSubmit}
          onClick={() => correctionM.mutate('retract')}
        >
          撤回
        </Btn>
        <Btn
          size="sm"
          variant="secondary"
          disabled={!canSubmit}
          onClick={() => correctionM.mutate('mark_wrong')}
        >
          标错
        </Btn>
        <Btn
          size="sm"
          variant="ghost"
          disabled={!canSubmit || event.correction_status.state === 'active'}
          onClick={() => correctionM.mutate('restore')}
        >
          恢复
        </Btn>
      </div>

      {affectedRefs.length === 0 && <p className="meta">无法推断 affected_ref</p>}
      {correctionM.isError && (
        <p className="meta" style={{ color: 'var(--again-ink)' }}>
          写入失败：{(correctionM.error as Error).message}
        </p>
      )}
    </section>
  );
}
