'use client';

// Phase 1d — single event detail + chain navigation.
//
// "错题详情" used to mean opening the Mistake row. Post-event-stream the
// concept maps to "open this attempt event with its caused_by_event_id chain
// + payload pretty-printed". This page is the chain explorer; downstream
// flows (rate, accept, etc.) keep their existing entry points.

import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { type ActivityRefInput, affectedRefsForCorrection } from '@/ui/lib/event-corrections';
import { formatRelTime } from '@/ui/lib/utils';
import { Badge, type BadgeTone } from '@/ui/primitives/Badge';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { use, useState } from 'react';

type CorrectionState = 'active' | 'retracted' | 'marked_wrong' | 'superseded';

interface CorrectionStatus {
  state: CorrectionState;
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

export default function EventDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['event', id],
    queryFn: () => apiJson<EventChainResponse>(`/api/events/${id}`),
  });

  return (
    <main className="page prose">
      <p className="breadcrumb">
        <Link href="/mistakes">← 错题</Link>
      </p>

      <PageHeader
        title="事件链"
        eyebrow={`/events/${id.slice(0, 8)}…`}
        sub="event 的 caused_by 上下文：上游因 → 当前事件 → 下游派生。"
      />

      {q.isLoading && (
        <div className="event-card">
          <p className="ec-row">加载中…</p>
        </div>
      )}

      {q.isError && (
        <div className="event-card">
          <p className="ec-row" style={{ color: 'var(--again-ink)' }}>
            {q.error instanceof ApiAuthError
              ? `${q.error.message} — 请重新进入页面输入 token`
              : `加载失败：${(q.error as Error).message}`}
          </p>
        </div>
      )}

      {q.isSuccess && (
        <>
          {q.data.chain.caused_by && (
            <>
              <p className="event-rail-label">caused_by · 上游</p>
              <EventCard event={q.data.chain.caused_by} kind="upstream" />
            </>
          )}

          <p className="event-rail-label">focal · 当前事件</p>
          <EventCard event={q.data.event} kind="focal" />
          <CorrectionControls
            event={q.data.event}
            onChanged={() => qc.invalidateQueries({ queryKey: ['event', id] })}
          />

          {q.data.chain.caused_events.length > 0 && (
            <>
              <p className="event-rail-label">下游 · {q.data.chain.caused_events.length} 条</p>
              {q.data.chain.caused_events.map((e) => (
                <EventCard key={e.id} event={e} kind="downstream" />
              ))}
            </>
          )}

          {q.data.chain.corrections.length > 0 && (
            <>
              <p className="event-rail-label">corrections · {q.data.chain.corrections.length} 条</p>
              {q.data.chain.corrections.map((e) => (
                <EventCard key={e.id} event={e} kind="correction" />
              ))}
            </>
          )}
        </>
      )}
    </main>
  );
}

type EventKind = 'focal' | 'upstream' | 'downstream' | 'correction';

function actionTone(action: string): BadgeTone {
  if (action === 'attempt') return 'again';
  if (action === 'review') return 'good';
  if (action === 'judge' || action === 'generate') return 'info';
  if (action === 'propose' || action.startsWith('experimental:')) return 'coral';
  if (action === 'rate') return 'neutral';
  return 'neutral';
}

function outcomeTone(outcome: string): BadgeTone {
  if (outcome === 'failure') return 'again';
  if (outcome === 'success') return 'good';
  if (outcome === 'partial') return 'hard';
  return 'neutral';
}

function correctionTone(state: CorrectionState): BadgeTone {
  if (state === 'active') return 'good';
  if (state === 'retracted' || state === 'marked_wrong') return 'again';
  if (state === 'superseded') return 'hard';
  return 'neutral';
}

function EventCard({ event, kind }: { event: EventRow; kind: EventKind }) {
  return (
    <article className={`event-card is-${kind}`}>
      <div className="ec-head">
        <Badge tone={actionTone(event.action)}>{event.action}</Badge>
        <Badge tone="neutral">{event.subject_kind}</Badge>
        {event.outcome && <Badge tone={outcomeTone(event.outcome)}>{event.outcome}</Badge>}
        <Badge tone={correctionTone(event.correction_status.state)}>
          {event.correction_status.state}
        </Badge>
        <span className="when">{formatRelTime(new Date(event.created_at))}</span>
      </div>

      <p className="ec-row">
        <span className="lbl">actor</span>
        <span>
          {event.actor_kind} · {event.actor_ref}
        </span>
      </p>

      <p className="ec-row">
        <span className="lbl">subject_id</span>
        <code>{event.subject_id}</code>
      </p>

      {event.caused_by_event_id && (
        <p className="ec-row">
          <span className="lbl">caused_by</span>
          <Link href={`/events/${event.caused_by_event_id}`}>
            {event.caused_by_event_id.slice(0, 8)}…
          </Link>
        </p>
      )}

      {event.task_run_id && (
        <p className="ec-row">
          <span className="lbl">task_run</span>
          <code>{event.task_run_id.slice(0, 12)}…</code>
        </p>
      )}

      {typeof event.cost_micro_usd === 'number' && event.cost_micro_usd > 0 && (
        <p className="ec-row">
          <span className="lbl">cost</span>
          <span>${(event.cost_micro_usd / 1e6).toFixed(5)}</span>
        </p>
      )}

      <details className="ec-payload">
        <summary>payload ▾</summary>
        <pre>{JSON.stringify(event.payload, null, 2)}</pre>
      </details>

      {kind !== 'focal' && (
        <p className="ec-jump">
          <Link href={`/events/${event.id}`}>→ 看这条事件</Link>
        </p>
      )}
    </article>
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
        <Badge tone={correctionTone(event.correction_status.state)}>
          {event.correction_status.state}
        </Badge>
        {event.correction_status.correction_event_id && (
          <Link href={`/events/${event.correction_status.correction_event_id}`}>
            {event.correction_status.correction_event_id.slice(0, 8)}…
          </Link>
        )}
      </div>

      <textarea
        value={reasonMd}
        onChange={(e) => setReasonMd(e.target.value)}
        rows={3}
        placeholder="reason_md"
      />

      <div className="ec-correction-actions">
        <button type="button" disabled={!canSubmit} onClick={() => correctionM.mutate('retract')}>
          撤回
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => correctionM.mutate('mark_wrong')}
        >
          标错
        </button>
        <button
          type="button"
          disabled={!canSubmit || event.correction_status.state === 'active'}
          onClick={() => correctionM.mutate('restore')}
        >
          恢复
        </button>
      </div>

      {affectedRefs.length === 0 && <p className="ec-muted">无法推断 affected_ref</p>}
      {correctionM.isError && (
        <p className="ec-error">写入失败：{(correctionM.error as Error).message}</p>
      )}
    </section>
  );
}
