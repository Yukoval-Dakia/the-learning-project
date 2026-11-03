// 事件证据 (/events/$id). M3E presentation (YUK-1473): UiNextRoot.ed-page + main.un-m3e-bridge,
// styles in event-detail-m3e.css, design record
// docs/design/2026-11-03-inbox-agent-notes-events-m3e.md. The query, the correction mutation and
// its invalidation are unchanged.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Lock,
  type LucideIcon,
  Moon,
  Search,
  Sparkles,
  User,
  Zap,
} from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '@/ui/lib/api';
import { affectedRefsForCorrection } from '@/ui/lib/event-corrections';
import { formatRelTime } from '@/ui/lib/utils';
import { FoldList } from '@/ui-next/primitives/FoldList';
import { RetryLine } from '@/ui-next/primitives/RetryLine';
import { SectionHead } from '@/ui-next/primitives/SectionHead';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { Button, UiNextRoot } from '@/ui-next/public';
import { type EventDetailClient, httpEventDetailClient } from './event-detail-client';
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
import './event-detail-m3e.css';

// actorMeta icon names → lucide (an unknown actor is 系统 with the bolt, as before).
const ACTOR_ICON: Record<string, LucideIcon> = {
  today: User,
  sparkle: Sparkles,
  moon: Moon,
  bolt: Zap,
};

/** Badge tone (good / hard / again / info / coral / neutral) → ui-next tone role. */
const TONE_ROLE: Record<string, string> = {
  good: 'positive',
  hard: 'caution',
  again: 'critical',
  info: 'accent',
  coral: 'secondary',
  neutral: 'neutral',
};

function toneRole(tone: string): string {
  return TONE_ROLE[tone] ?? 'neutral';
}

function ActorTag({ kind }: { kind: string }) {
  const actor = actorMeta(kind);
  const Icon = ACTOR_ICON[actor.icon] ?? Zap;
  return (
    <span className="ed-actor">
      <Icon size={14} aria-hidden="true" />
      {actor.label}
    </span>
  );
}

/** A missing or out-of-scope record: says why and offers the way back. */
function Blocked({
  icon: Icon,
  title,
  text,
  onBack,
}: {
  icon: LucideIcon;
  title: string;
  text: string;
  onBack: () => void;
}) {
  return (
    <div className="ed-empty">
      <span className="ed-empty-icon" aria-hidden="true">
        <Icon size={20} />
      </span>
      <p className="ed-empty-title">{title}</p>
      <p className="ed-empty-text">{text}</p>
      <Button onClick={onBack}>
        <ArrowLeft size={16} aria-hidden="true" />
        返回来源
      </Button>
    </div>
  );
}

export interface EventDetailPageProps {
  id: string;
  navigate: (to: string) => void;
  onBack: () => void;
  client?: EventDetailClient;
}

export default function EventDetailPage({
  id,
  navigate,
  onBack,
  client = httpEventDetailClient,
}: EventDetailPageProps) {
  const query = useQuery({
    queryKey: ['event-detail', id],
    queryFn: () => client.getEventDetail(id),
    retry: false,
  });

  const errorStatus = query.error instanceof ApiError ? query.error.status : null;
  const eyebrow = query.data ? `证据记录 · ${actionLabel(query.data.event.action)}` : '证据记录';

  return (
    <UiNextRoot className="ed-page">
      <main className="ed-main un-m3e-bridge">
        <button type="button" className="ed-back" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden="true" />
          返回来源
        </button>

        <header className="ed-head">
          <p className="ed-kicker">{eyebrow}</p>
          <h1 className="ed-title">事件证据</h1>
          <p className="ed-lead">
            这里按时间说明谁做了什么、由什么触发，以及之后发生了什么。历史不会被直接改写；纠正也会留下记录。
          </p>
        </header>

        {query.isLoading && <SkeletonLines rows={4} label="正在读取事件证据" />}

        {query.isError && errorStatus === 404 && (
          <Blocked
            icon={Search}
            title="这条证据不存在"
            text="链接可能已经失效，或这条记录从未写入。你可以返回来源继续查看其它内容。"
            onBack={onBack}
          />
        )}

        {query.isError && errorStatus === 403 && (
          <Blocked
            icon={Lock}
            title="无法查看这条证据"
            text="当前访问范围不包含这条记录。返回来源不会影响其它学习内容。"
            onBack={onBack}
          />
        )}

        {query.isError && errorStatus !== 404 && errorStatus !== 403 && (
          <RetryLine message="事件证据暂时加载失败。" onRetry={() => query.refetch()} />
        )}

        {query.data && <EventChainView data={query.data} navigate={navigate} client={client} />}
      </main>
    </UiNextRoot>
  );
}

function EventChainView({
  data,
  navigate,
  client,
}: {
  client: EventDetailClient;
  data: EventDetailResponse;
  navigate: (to: string) => void;
}) {
  const queryClient = useQueryClient();
  const { event, chain } = data;

  return (
    <>
      <div className="ed-chain">
        {chain.caused_by && (
          <section className="ed-lane" aria-labelledby="event-cause-heading">
            <p id="event-cause-heading" className="ed-lane-label">
              由这条记录触发
            </p>
            <ChainEventButton event={chain.caused_by} navigate={navigate} />
            <span className="ed-connector" aria-hidden="true" />
          </section>
        )}

        <FocalEvent event={event} navigate={navigate} />

        {chain.caused_events.length > 0 && (
          <section className="ed-lane" aria-labelledby="event-effects-heading">
            <span className="ed-connector" aria-hidden="true" />
            <p id="event-effects-heading" className="ed-lane-label">
              之后发生 · {chain.caused_events.length} 条
            </p>
            <FoldList
              as="div"
              className="ed-lane-list"
              items={chain.caused_events}
              renderItem={(row) => (
                <ChainEventButton key={row.id} event={row} navigate={navigate} />
              )}
            />
          </section>
        )}
      </div>

      <CorrectionControls
        client={client}
        event={event}
        onChanged={() => queryClient.invalidateQueries({ queryKey: ['event-detail', event.id] })}
      />

      {chain.corrections.length > 0 && (
        <section className="ed-corrections" aria-labelledby="event-corrections-heading">
          <SectionHead
            id="event-corrections-heading"
            title="纠正记录"
            aside={<span className="un-num">{chain.corrections.length}</span>}
          />
          <FoldList
            as="div"
            className="ed-corr-list"
            items={chain.corrections}
            renderItem={(row) => (
              <button
                type="button"
                key={row.id}
                className="ed-corr-row"
                onClick={() => navigate(`/events/${encodeURIComponent(row.id)}`)}
              >
                <span className="ed-dot" aria-hidden="true" />
                <span>{actionLabel(row.action)}</span>
                <span className="ed-corr-meta">
                  {formatRelTime(row.created_at)} · {actorMeta(row.actor_kind).label}
                </span>
                <ArrowRight size={14} aria-hidden="true" className="ed-row-arrow" />
              </button>
            )}
          />
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
  const outcome = outcomeLabel(event.outcome);
  return (
    <button
      type="button"
      className="ed-node"
      onClick={() => navigate(`/events/${encodeURIComponent(event.id)}`)}
    >
      <ActorTag kind={event.actor_kind} />
      <span className="ed-node-text">
        {actionLabel(event.action)} · {subjectLabel(event.subject_kind)}
        {outcome ? ` · ${outcome}` : ''}
      </span>
      <ArrowRight size={14} aria-hidden="true" className="ed-row-arrow" />
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
  const correction = correctionMeta(event.correction_status.state);
  const outcome = outcomeLabel(event.outcome);
  const target = subjectHref(event);

  return (
    <article className="ed-focal">
      <div className="ed-focal-head">
        <span className="ed-tag" data-tone={toneRole(eventTone(event))}>
          <span className="ed-tag-dot" aria-hidden="true" />
          当前记录
        </span>
        <ActorTag kind={event.actor_kind} />
        <span className="ed-tag" data-tone={toneRole(correction.tone)}>
          {correction.label}
        </span>
        <time className="ed-time" dateTime={event.created_at}>
          {formatRelTime(event.created_at)}
        </time>
      </div>

      <h2 className="ed-focal-title">
        {actionLabel(event.action)}
        {outcome ? ` · ${outcome}` : ''}
      </h2>
      <p className="ed-focal-subject">涉及：{subjectLabel(event.subject_kind)}</p>
      {target && target !== `/events/${encodeURIComponent(event.id)}` && (
        <Button size="sm" variant="ghost" className="ed-focal-go" onClick={() => navigate(target)}>
          查看相关{subjectLabel(event.subject_kind)}
          <ArrowRight size={14} aria-hidden="true" />
        </Button>
      )}

      <details className="ed-raw">
        <summary className="un-hit">
          技术详情
          <ChevronDown size={14} aria-hidden="true" className="ed-raw-chev" />
        </summary>
        <div className="ed-raw-body">
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
  client,
  event,
  onChanged,
}: {
  event: EventDetailRow;
  onChanged: () => Promise<unknown>;
  client: EventDetailClient;
}) {
  const [reason, setReason] = useState('');
  const affectedRefs = affectedRefsForCorrection(event);
  const mutation = useMutation({
    mutationFn: (correctionKind: 'retract' | 'mark_wrong' | 'restore') =>
      client.createEventCorrection(event.id, {
        correction_kind: correctionKind,
        reason_md: reason.trim(),
        affected_refs: affectedRefs,
      }),
    retry: false,
    onSuccess: async () => {
      setReason('');
      await onChanged();
    },
  });

  if (affectedRefs.length === 0) {
    return <p className="ed-quiet">这类记录暂时只能查看，不能在这里直接纠正。</p>;
  }

  const canSubmit = reason.trim().length > 0 && !mutation.isPending;
  return (
    <section className="ed-correct" aria-labelledby="event-correction-title">
      <h2 id="event-correction-title" className="ed-correct-title">
        这条记录有误？
      </h2>
      <label htmlFor="event-correction-reason" className="ed-label">
        说明原因
      </label>
      <textarea
        id="event-correction-reason"
        className="ed-textarea"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        rows={3}
        placeholder="写下需要纠正的地方"
        disabled={mutation.isPending}
      />
      <div className="ed-acts">
        {event.correction_status.state === 'active' ? (
          <>
            <Button size="sm" disabled={!canSubmit} onClick={() => mutation.mutate('retract')}>
              撤回记录
            </Button>
            <Button size="sm" disabled={!canSubmit} onClick={() => mutation.mutate('mark_wrong')}>
              标记为错误
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={!canSubmit} onClick={() => mutation.mutate('restore')}>
            恢复为有效记录
          </Button>
        )}
      </div>
      {mutation.isPending && <p className="ed-quiet">正在记录纠正…</p>}
      {mutation.isSuccess && <p className="ed-quiet ed-ok">纠正已记录。</p>}
      {mutation.isError && (
        <p className="ed-error" role="alert">
          纠正失败：{(mutation.error as Error).message}
        </p>
      )}
    </section>
  );
}
