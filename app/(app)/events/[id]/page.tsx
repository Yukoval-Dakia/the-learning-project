'use client';

// Phase 1d — single event detail + chain navigation.
//
// "错题详情" used to mean opening the Mistake row. Post-event-stream the
// concept maps to "open this attempt event with its caused_by_event_id chain
// + payload pretty-printed". This page is the chain explorer; downstream
// flows (rate, accept, etc.) keep their existing entry points.

import { ApiAuthError, apiJson } from '@/ui/lib/api';
import { formatRelTime } from '@/ui/lib/utils';
import { Badge } from '@/ui/primitives/Badge';
import { Card } from '@/ui/primitives/Card';
import { PageHeader } from '@/ui/primitives/PageHeader';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { use } from 'react';

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
}

interface EventChainResponse {
  event: EventRow;
  chain: {
    caused_by: EventRow | null;
    caused_events: EventRow[];
  };
}

export default function EventDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const q = useQuery({
    queryKey: ['event', id],
    queryFn: () => apiJson<EventChainResponse>(`/api/events/${id}`),
  });

  return (
    <main
      style={{
        minHeight: '100vh',
        background: 'var(--paper)',
        padding: '36px 28px',
        maxWidth: 'var(--cap-prose, 820px)',
        margin: '0 auto',
        width: '100%',
        boxSizing: 'border-box',
      }}
    >
      <p style={breadcrumbStyle}>
        <Link href="/mistakes" style={{ color: 'var(--coral)' }}>
          ← 错题
        </Link>
      </p>

      <PageHeader
        title="事件链"
        eyebrow={`/events/${id.slice(0, 8)}…`}
        sub="一条 event 的 caused_by 上下文。"
      />

      {q.isLoading && (
        <Card>
          <p style={mutedStyle}>加载中…</p>
        </Card>
      )}

      {q.isError && (
        <Card>
          <p style={errorStyle}>
            {q.error instanceof ApiAuthError
              ? `${q.error.message} — 请重新进入页面输入 token`
              : `加载失败：${(q.error as Error).message}`}
          </p>
        </Card>
      )}

      {q.isSuccess && (
        <>
          {q.data.chain.caused_by && (
            <Section label="caused_by · 上游">
              <EventCard event={q.data.chain.caused_by} kind="upstream" />
            </Section>
          )}

          <Section label="focal · 当前事件">
            <EventCard event={q.data.event} kind="focal" />
          </Section>

          {q.data.chain.caused_events.length > 0 && (
            <Section label={`下游 · ${q.data.chain.caused_events.length} 条`}>
              {q.data.chain.caused_events.map((e) => (
                <EventCard key={e.id} event={e} kind="downstream" />
              ))}
            </Section>
          )}
        </>
      )}
    </main>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 'var(--s-5)' }}>
      <p style={sectionLabelStyle}>{label}</p>
      <div style={{ marginTop: 'var(--s-2)' }}>{children}</div>
    </div>
  );
}

function EventCard({
  event,
  kind,
}: {
  event: EventRow;
  kind: 'focal' | 'upstream' | 'downstream';
}) {
  const tone = kind === 'focal' ? 'coral' : kind === 'upstream' ? 'info' : 'neutral';
  return (
    <Card pad="lg" style={{ marginBottom: 'var(--s-2)' }}>
      <div style={headRowStyle}>
        <Badge tone={tone}>{event.action}</Badge>
        <Badge tone="neutral">{event.subject_kind}</Badge>
        {event.outcome && <Badge tone="neutral">{event.outcome}</Badge>}
        <span style={metaStyle}>{formatRelTime(new Date(event.created_at))}</span>
      </div>
      <p style={subjectStyle}>
        <span style={metaStyle}>actor</span> {event.actor_kind} · {event.actor_ref}
      </p>
      <p style={subjectStyle}>
        <span style={metaStyle}>subject_id</span> <code>{event.subject_id}</code>
      </p>
      {event.caused_by_event_id && (
        <p style={subjectStyle}>
          <span style={metaStyle}>caused_by</span>{' '}
          <Link
            href={`/events/${event.caused_by_event_id}`}
            style={{ color: 'var(--coral)', fontFamily: 'var(--font-mono)' }}
          >
            {event.caused_by_event_id.slice(0, 8)}…
          </Link>
        </p>
      )}
      <details style={{ marginTop: 'var(--s-2)' }}>
        <summary style={metaStyle}>payload</summary>
        <pre style={preStyle}>{JSON.stringify(event.payload, null, 2)}</pre>
      </details>
      {kind !== 'focal' && (
        <p style={{ ...metaStyle, marginTop: 'var(--s-2)' }}>
          <Link href={`/events/${event.id}`} style={{ color: 'var(--coral)' }}>
            → 看这条事件
          </Link>
        </p>
      )}
    </Card>
  );
}

const breadcrumbStyle: React.CSSProperties = {
  margin: '0 0 var(--s-2)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  letterSpacing: 'var(--ls-wide)',
};

const sectionLabelStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-4)',
  letterSpacing: 'var(--ls-wide)',
};

const headRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--s-2)',
  flexWrap: 'wrap',
};

const metaStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-4)',
  letterSpacing: 'var(--ls-wide)',
};

const subjectStyle: React.CSSProperties = {
  margin: 'var(--s-2) 0 0',
  fontSize: 'var(--fs-caption)',
  color: 'var(--ink-2)',
};

const preStyle: React.CSSProperties = {
  margin: 'var(--s-2) 0 0',
  padding: 'var(--s-3)',
  background: 'var(--paper-sunk)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-2)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--fs-meta)',
  color: 'var(--ink-2)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  overflow: 'auto',
  maxHeight: 320,
};

const mutedStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-body)',
  color: 'var(--ink-3)',
};

const errorStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 'var(--fs-body)',
  color: 'var(--again-ink)',
};
