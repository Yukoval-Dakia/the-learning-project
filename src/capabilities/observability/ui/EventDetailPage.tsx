import { ApiError, apiJson } from '@/ui/lib/api';
import { affectedRefsForCorrection } from '@/ui/lib/event-corrections';
import { formatRelTime } from '@/ui/lib/utils';
import { Btn } from '@/ui/primitives/Btn';
import { EmptyState } from '@/ui/primitives/EmptyState';
import { ErrorState } from '@/ui/primitives/ErrorState';
import { LoomBadge } from '@/ui/primitives/LoomBadge';
import { LoomCard } from '@/ui/primitives/LoomCard';
import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { SectionLabel } from '@/ui/primitives/SectionLabel';
import { SkLines } from '@/ui/primitives/SkLines';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  type EventDetailResponse,
  type EventDetailRow,
  actionLabel,
  actorMeta,
  correctionMeta,
  eventTone,
  outcomeLabel,
  subjectHref,
  subjectLabel,
} from './event-detail-model';

export interface EventDetailPageProps {
  id: string;
  navigate: (to: string) => void;
  onBack: () => void;
}

export default function EventDetailPage({ id, navigate, onBack }: EventDetailPageProps) {
  const query = useQuery({
    queryKey: ['event-detail', id],
    queryFn: () => apiJson<EventDetailResponse>(`/api/events/${encodeURIComponent(id)}`),
    retry: false,
  });

  const errorStatus = query.error instanceof ApiError ? query.error.status : null;
  const eyebrow = query.data ? `证据记录 · ${actionLabel(query.data.event.action)}` : '证据记录';

  return (
    <main className="page page-narrow events-loom">
      <button type="button" className="back-link" onClick={onBack}>
        <LoomIcon name="arrowL" size={14} />
        返回来源
      </button>

      <div className="page-head">
        <div className="eyebrow">{eyebrow}</div>
        <h1 className="page-title serif">事件证据</h1>
        <p className="page-lead">
          这里按时间说明谁做了什么、由什么触发，以及之后发生了什么。历史不会被直接改写；纠正也会留下记录。
        </p>
      </div>

      {query.isLoading && (
        <LoomCard pad>
          <SkLines rows={4} />
        </LoomCard>
      )}

      {query.isError && errorStatus === 404 && (
        <EmptyState
          icon="search"
          title="这条证据不存在"
          text="链接可能已经失效，或这条记录从未写入。你可以返回来源继续查看其它内容。"
          action={
            <Btn variant="secondary" icon="arrowL" onClick={onBack}>
              返回来源
            </Btn>
          }
        />
      )}

      {query.isError && errorStatus === 403 && (
        <EmptyState
          icon="lock"
          title="无法查看这条证据"
          text="当前访问范围不包含这条记录。返回来源不会影响其它学习内容。"
          action={
            <Btn variant="secondary" icon="arrowL" onClick={onBack}>
              返回来源
            </Btn>
          }
        />
      )}

      {query.isError && errorStatus !== 404 && errorStatus !== 403 && (
        <ErrorState text="事件证据暂时加载失败。" onRetry={() => query.refetch()} />
      )}

      {query.data && <EventChainView data={query.data} navigate={navigate} />}
    </main>
  );
}

function EventChainView({
  data,
  navigate,
}: {
  data: EventDetailResponse;
  navigate: (to: string) => void;
}) {
  const queryClient = useQueryClient();
  const { event, chain } = data;

  return (
    <>
      {chain.caused_by && (
        <section className="ev-lane" aria-labelledby="event-cause-heading">
          <div id="event-cause-heading" className="ev-lane-label meta">
            由这条记录触发
          </div>
          <ChainEventButton event={chain.caused_by} navigate={navigate} />
          <div className="ev-connector" aria-hidden="true" />
        </section>
      )}

      <FocalEvent event={event} navigate={navigate} />
      <CorrectionControls
        event={event}
        onChanged={() => queryClient.invalidateQueries({ queryKey: ['event-detail', event.id] })}
      />

      {chain.caused_events.length > 0 && (
        <section className="ev-lane" aria-labelledby="event-effects-heading">
          <div className="ev-connector" aria-hidden="true" />
          <div id="event-effects-heading" className="ev-lane-label meta">
            之后发生 · {chain.caused_events.length} 条
          </div>
          {chain.caused_events.map((row) => (
            <ChainEventButton key={row.id} event={row} navigate={navigate} />
          ))}
        </section>
      )}

      {chain.corrections.length > 0 && (
        <section aria-labelledby="event-corrections-heading">
          <SectionLabel count={chain.corrections.length}>纠正记录</SectionLabel>
          <LoomCard pad>
            {chain.corrections.map((row) => (
              <button
                type="button"
                key={row.id}
                className="corr-row"
                onClick={() => navigate(`/events/${encodeURIComponent(row.id)}`)}
              >
                <span className="ev-dot" style={{ background: 'var(--good)' }} />
                <span>{actionLabel(row.action)}</span>
                <span className="meta" style={{ marginLeft: 'auto' }}>
                  {formatRelTime(row.created_at)} · {actorMeta(row.actor_kind).label}
                </span>
              </button>
            ))}
          </LoomCard>
        </section>
      )}
    </>
  );
}

function ChainEventButton({
  event,
  navigate,
}: {
  event: EventDetailRow;
  navigate: (to: string) => void;
}) {
  const actor = actorMeta(event.actor_kind);
  const outcome = outcomeLabel(event.outcome);
  return (
    <button
      type="button"
      className="ev-node"
      onClick={() => navigate(`/events/${encodeURIComponent(event.id)}`)}
      style={{ marginBottom: 'var(--s-2)' }}
    >
      <span className="ev-actor">
        <LoomIcon name={actor.icon} size={14} />
        {actor.label}
      </span>
      <span>
        {actionLabel(event.action)} · {subjectLabel(event.subject_kind)}
        {outcome ? ` · ${outcome}` : ''}
      </span>
      <LoomIcon name="arrow" size={13} className="thread-arrow" />
    </button>
  );
}

function FocalEvent({
  event,
  navigate,
}: {
  event: EventDetailRow;
  navigate: (to: string) => void;
}) {
  const actor = actorMeta(event.actor_kind);
  const correction = correctionMeta(event.correction_status.state);
  const outcome = outcomeLabel(event.outcome);
  const target = subjectHref(event);

  return (
    <article className="ev-focal">
      <div className="ev-focal-head">
        <LoomBadge tone={eventTone(event)} dot>
          当前记录
        </LoomBadge>
        <span className="ev-actor">
          <LoomIcon name={actor.icon} size={14} />
          {actor.label}
        </span>
        <LoomBadge tone={correction.tone}>{correction.label}</LoomBadge>
        <time className="meta" style={{ marginLeft: 'auto' }} dateTime={event.created_at}>
          {formatRelTime(event.created_at)}
        </time>
      </div>

      <div className="ev-focal-title serif">
        {actionLabel(event.action)}
        {outcome ? ` · ${outcome}` : ''}
      </div>
      <p className="meta" style={{ marginTop: 'var(--s-2)' }}>
        涉及：{subjectLabel(event.subject_kind)}
      </p>
      {target && target !== `/events/${encodeURIComponent(event.id)}` && (
        <Btn size="sm" variant="ghost" iconEnd="arrow" onClick={() => navigate(target)}>
          查看相关{subjectLabel(event.subject_kind)}
        </Btn>
      )}

      <details className="raw-toggle">
        <summary>技术详情</summary>
        <div className="raw-payload">
          <p>记录 ID：{event.id}</p>
          <p>
            动作：{event.action} · 对象：{event.subject_kind}:{event.subject_id}
          </p>
          {event.actor_ref && <p>执行者标识：{event.actor_ref}</p>}
          {event.caused_by_event_id && <p>前因记录：{event.caused_by_event_id}</p>}
          {event.task_run_id && <p>AI 运行：{event.task_run_id}</p>}
          <pre>{JSON.stringify(event.payload, null, 2)}</pre>
        </div>
      </details>
    </article>
  );
}

function CorrectionControls({
  event,
  onChanged,
}: {
  event: EventDetailRow;
  onChanged: () => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  const affectedRefs = affectedRefsForCorrection(event);
  const mutation = useMutation({
    mutationFn: (correctionKind: 'retract' | 'mark_wrong' | 'restore') =>
      apiJson<{ correction_event_id: string }>(
        `/api/events/${encodeURIComponent(event.id)}/correct`,
        {
          method: 'POST',
          body: JSON.stringify({
            correction_kind: correctionKind,
            reason_md: reason.trim(),
            affected_refs: affectedRefs,
          }),
        },
      ),
    onSuccess: async () => {
      setReason('');
      await onChanged();
    },
  });

  if (affectedRefs.length === 0) {
    return <p className="meta">这类记录暂时只能查看，不能在这里直接纠正。</p>;
  }

  const canSubmit = reason.trim().length > 0 && !mutation.isPending;
  return (
    <section className="ec-correction-panel" aria-labelledby="event-correction-title">
      <div id="event-correction-title" className="card-title">
        这条记录有误？
      </div>
      <label htmlFor="event-correction-reason" className="field-label">
        说明原因
      </label>
      <textarea
        id="event-correction-reason"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        rows={3}
        placeholder="写下需要纠正的地方"
        disabled={mutation.isPending}
      />
      <div className="ec-correction-actions">
        {event.correction_status.state === 'active' ? (
          <>
            <Btn
              size="sm"
              variant="secondary"
              disabled={!canSubmit}
              onClick={() => mutation.mutate('retract')}
            >
              撤回记录
            </Btn>
            <Btn
              size="sm"
              variant="secondary"
              disabled={!canSubmit}
              onClick={() => mutation.mutate('mark_wrong')}
            >
              标记为错误
            </Btn>
          </>
        ) : (
          <Btn
            size="sm"
            variant="secondary"
            disabled={!canSubmit}
            onClick={() => mutation.mutate('restore')}
          >
            恢复为有效记录
          </Btn>
        )}
      </div>
      {mutation.isPending && <p className="meta">正在记录纠正…</p>}
      {mutation.isSuccess && <p className="meta">纠正已记录。</p>}
      {mutation.isError && (
        <p className="meta" role="alert" style={{ color: 'var(--again-ink)' }}>
          纠正失败：{(mutation.error as Error).message}
        </p>
      )}
    </section>
  );
}
