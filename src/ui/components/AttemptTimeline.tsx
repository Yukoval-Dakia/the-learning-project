// AttemptTimeline — YUK-58
//
// Renders the recent attempt + review history for one question inside the
// review feedback panel. Cause repetition (≥2 occurrences of the same
// primary_category in the slice) gets `tone='again'` so the user sees the
// "stuck on the same misconception" signal at a glance.

import { Badge } from '@/ui/primitives/Badge';

export type AttemptTimelineEvent =
  | {
      kind: 'attempt';
      event_id: string;
      created_at_sec: number;
      outcome: 'success' | 'failure' | 'partial';
      duration_ms: number | null;
      cause: { primary: string; confidence: number | null } | null;
    }
  | {
      kind: 'review';
      event_id: string;
      created_at_sec: number;
      fsrs_rating: 'again' | 'hard' | 'good';
      outcome: 'success' | 'failure';
      duration_ms: number | null;
    };

export interface AttemptTimelineProps {
  events: AttemptTimelineEvent[];
  /** Override clock for deterministic rendering / tests. Unix seconds. */
  now_sec?: number;
}

const RATING_LABEL: Record<'again' | 'hard' | 'good', string> = {
  again: '不会',
  hard: '模糊',
  good: '会了',
};

const RATING_TONE: Record<'again' | 'hard' | 'good', 'again' | 'hard' | 'good'> = {
  again: 'again',
  hard: 'hard',
  good: 'good',
};

const ATTEMPT_OUTCOME_LABEL: Record<'success' | 'failure' | 'partial', string> = {
  success: '答对',
  failure: '答错',
  partial: '部分',
};

const ATTEMPT_OUTCOME_TONE: Record<'success' | 'failure' | 'partial', 'good' | 'again' | 'hard'> = {
  success: 'good',
  failure: 'again',
  partial: 'hard',
};

function formatRelative(seconds_sec: number, now_sec: number): string {
  const diffSec = Math.max(0, now_sec - seconds_sec);
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)} 小时前`;
  if (diffSec < 30 * 86_400) return `${Math.floor(diffSec / 86_400)} 天前`;
  // For older entries, show YYYY-MM-DD UTC.
  const d = new Date(seconds_sec * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function formatDuration(ms: number | null): string | null {
  if (ms == null) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1000)}s`;
}

function countCauses(events: AttemptTimelineEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.kind === 'attempt' && e.cause) {
      counts.set(e.cause.primary, (counts.get(e.cause.primary) ?? 0) + 1);
    }
  }
  return counts;
}

export function AttemptTimeline({ events, now_sec }: AttemptTimelineProps) {
  if (events.length === 0) {
    return (
      <div className="attempt-timeline">
        <div className="attempt-timeline-header">
          <span className="label-mono">最近历史</span>
        </div>
        <p className="attempt-timeline-empty">暂无历史记录</p>
      </div>
    );
  }

  const clockSec = now_sec ?? Math.floor(Date.now() / 1000);
  const causeCounts = countCauses(events);

  return (
    <div className="attempt-timeline" data-testid="attempt-timeline">
      <div className="attempt-timeline-header">
        <span className="label-mono">最近历史</span>
        <span className="attempt-timeline-count">共 {events.length} 条</span>
      </div>
      <ol className="attempt-timeline-list">
        {events.map((entry) => {
          const time = formatRelative(entry.created_at_sec, clockSec);
          const dur = formatDuration(entry.duration_ms);
          if (entry.kind === 'attempt') {
            const isRepeatedCause =
              entry.cause != null && (causeCounts.get(entry.cause.primary) ?? 0) >= 2;
            return (
              <li
                key={entry.event_id}
                className="attempt-timeline-row"
                data-kind="attempt"
                data-repeated-cause={isRepeatedCause ? 'true' : undefined}
              >
                <span className="attempt-timeline-time label-mono">{time}</span>
                <Badge tone={ATTEMPT_OUTCOME_TONE[entry.outcome]}>
                  {ATTEMPT_OUTCOME_LABEL[entry.outcome]}
                </Badge>
                {entry.cause && (
                  <Badge tone={isRepeatedCause ? 'again' : 'info'}>
                    {isRepeatedCause ? '×' : ''}
                    {entry.cause.primary}
                  </Badge>
                )}
                {dur && <span className="attempt-timeline-dur label-mono">{dur}</span>}
              </li>
            );
          }
          return (
            <li
              key={entry.event_id}
              className="attempt-timeline-row"
              data-kind="review"
            >
              <span className="attempt-timeline-time label-mono">{time}</span>
              <Badge tone={RATING_TONE[entry.fsrs_rating]}>
                复习 · {RATING_LABEL[entry.fsrs_rating]}
              </Badge>
              {dur && <span className="attempt-timeline-dur label-mono">{dur}</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
