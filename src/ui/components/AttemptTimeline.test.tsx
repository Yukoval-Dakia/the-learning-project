import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AttemptTimeline, type AttemptTimelineEvent } from './AttemptTimeline';

const NOW_SEC = 1_716_000_000; // 2024-05-18, deterministic anchor

function mkAttempt(
  partial: Partial<Extract<AttemptTimelineEvent, { kind: 'attempt' }>> & { event_id: string },
): AttemptTimelineEvent {
  return {
    kind: 'attempt',
    event_id: partial.event_id,
    created_at_sec: partial.created_at_sec ?? NOW_SEC - 60,
    outcome: partial.outcome ?? 'failure',
    duration_ms: partial.duration_ms ?? null,
    cause: partial.cause ?? null,
  };
}

function mkReview(
  partial: Partial<Extract<AttemptTimelineEvent, { kind: 'review' }>> & { event_id: string },
): AttemptTimelineEvent {
  return {
    kind: 'review',
    event_id: partial.event_id,
    created_at_sec: partial.created_at_sec ?? NOW_SEC - 60,
    fsrs_rating: partial.fsrs_rating ?? 'good',
    outcome: partial.outcome ?? 'success',
    duration_ms: partial.duration_ms ?? null,
  };
}

describe('AttemptTimeline', () => {
  it('renders empty state when there are no events', () => {
    const html = renderToString(<AttemptTimeline events={[]} now_sec={NOW_SEC} />);
    expect(html).toContain('暂无历史记录');
    expect(html).not.toContain('attempt-timeline-list');
  });

  it('renders attempts and reviews in order with timestamps and badges', () => {
    const events: AttemptTimelineEvent[] = [
      mkAttempt({
        event_id: 'a1',
        outcome: 'failure',
        cause: { primary: 'careless_mistake', confidence: 0.8 },
        duration_ms: 4_500,
      }),
      mkReview({
        event_id: 'r1',
        fsrs_rating: 'hard',
        duration_ms: 9_200,
      }),
    ];

    const html = renderToString(<AttemptTimeline events={events} now_sec={NOW_SEC} />);
    expect(html).toMatch(/共 (?:<!-- -->)?2(?:<!-- -->)? 条/);
    expect(html).toContain('答错');
    expect(html).toContain('careless_mistake');
    expect(html).toContain('复习');
    expect(html).toContain('模糊');
    expect(html).toContain('4.5s');
    expect(html).toContain('9.2s');
  });

  it('marks repeated cause with the again tone', () => {
    const events: AttemptTimelineEvent[] = [
      mkAttempt({
        event_id: 'a1',
        cause: { primary: 'careless_mistake', confidence: 0.7 },
      }),
      mkAttempt({
        event_id: 'a2',
        cause: { primary: 'careless_mistake', confidence: 0.8 },
      }),
      mkAttempt({
        event_id: 'a3',
        cause: { primary: 'concept', confidence: 0.6 },
      }),
    ];

    const html = renderToString(<AttemptTimeline events={events} now_sec={NOW_SEC} />);
    // The "×" prefix and data-repeated-cause flag both surface for the repeated cause.
    expect(html).toContain('data-repeated-cause="true"');
    // React SSR inserts <!-- --> between sibling text nodes; allow that gap.
    expect(html).toMatch(/×[^<]*?<!-- -->careless_mistake|×careless_mistake/);
    // The non-repeated cause should NOT carry the "×" marker.
    expect(html).not.toMatch(/×[^<]*?concept|×concept/);
  });

  it('falls back to time formatting when older than a day', () => {
    const events: AttemptTimelineEvent[] = [
      mkAttempt({
        event_id: 'a_old',
        created_at_sec: NOW_SEC - 3 * 86_400,
      }),
    ];
    const html = renderToString(<AttemptTimeline events={events} now_sec={NOW_SEC} />);
    expect(html).toContain('3 天前');
  });
});
