// YUK-617 W1 — narrowing adapter: /api/questions/:id 的 QFullTimelineEntry（宽 outcome:string、
// cause? 可选）→ AttemptTimeline 组件严格消费的 AttemptTimelineEvent（判别联合）。避免 blind cast，
// 把不合法/残缺的条目安全丢弃而非渲染坏数据。

import { describe, expect, it } from 'vitest';
import { toAttemptTimelineEvents } from './attempt-timeline-adapter';
import type { QFullTimelineEntry } from './practice-api';

const attempt = (o: Partial<QFullTimelineEntry> = {}): QFullTimelineEntry => ({
  kind: 'attempt',
  event_id: 'ev_a',
  created_at_sec: 1000,
  outcome: 'failure',
  duration_ms: 4200,
  cause: { primary: '虚词误判', confidence: 0.7 },
  ...o,
});

const review = (o: Partial<QFullTimelineEntry> = {}): QFullTimelineEntry => ({
  kind: 'review',
  event_id: 'ev_r',
  created_at_sec: 2000,
  outcome: 'success',
  duration_ms: 1500,
  fsrs_rating: 'good',
  ...o,
});

describe('toAttemptTimelineEvents', () => {
  it('maps a valid attempt (outcome + cause preserved)', () => {
    const [e] = toAttemptTimelineEvents([attempt()]);
    expect(e).toEqual({
      kind: 'attempt',
      event_id: 'ev_a',
      created_at_sec: 1000,
      outcome: 'failure',
      duration_ms: 4200,
      cause: { primary: '虚词误判', confidence: 0.7 },
    });
  });

  it('maps all three attempt outcomes (success/failure/partial)', () => {
    const out = toAttemptTimelineEvents([
      attempt({ event_id: 's', outcome: 'success' }),
      attempt({ event_id: 'f', outcome: 'failure' }),
      attempt({ event_id: 'p', outcome: 'partial' }),
    ]);
    expect(out.map((e) => e.kind === 'attempt' && e.outcome)).toEqual([
      'success',
      'failure',
      'partial',
    ]);
  });

  it('maps a valid review (fsrs_rating + outcome)', () => {
    const [e] = toAttemptTimelineEvents([review()]);
    expect(e).toEqual({
      kind: 'review',
      event_id: 'ev_r',
      created_at_sec: 2000,
      outcome: 'success',
      duration_ms: 1500,
      fsrs_rating: 'good',
    });
  });

  it('normalizes attempt cause of null/undefined to null', () => {
    const [a1] = toAttemptTimelineEvents([attempt({ cause: null })]);
    const [a2] = toAttemptTimelineEvents([attempt({ cause: undefined })]);
    expect(a1.kind === 'attempt' && a1.cause).toBeNull();
    expect(a2.kind === 'attempt' && a2.cause).toBeNull();
  });

  it('preserves null duration_ms', () => {
    const [e] = toAttemptTimelineEvents([attempt({ duration_ms: null })]);
    expect(e.duration_ms).toBeNull();
  });

  it('drops an attempt with an out-of-contract outcome (never renders bad data)', () => {
    expect(toAttemptTimelineEvents([attempt({ outcome: 'bogus' })])).toEqual([]);
    // review outcome only allows success/failure — 'partial' is invalid for a review
    expect(toAttemptTimelineEvents([review({ outcome: 'partial' })])).toEqual([]);
  });

  it('drops a review missing fsrs_rating', () => {
    expect(toAttemptTimelineEvents([review({ fsrs_rating: undefined })])).toEqual([]);
  });

  it('drops a review with an out-of-contract fsrs_rating', () => {
    expect(
      toAttemptTimelineEvents([
        review({ fsrs_rating: 'meh' as QFullTimelineEntry['fsrs_rating'] }),
      ]),
    ).toEqual([]);
  });

  it('returns [] for empty input', () => {
    expect(toAttemptTimelineEvents([])).toEqual([]);
  });

  it('preserves order and keeps valid entries while dropping invalid ones', () => {
    const out = toAttemptTimelineEvents([
      attempt({ event_id: 'ok1' }),
      attempt({ event_id: 'bad', outcome: 'nope' }),
      review({ event_id: 'ok2' }),
    ]);
    expect(out.map((e) => e.event_id)).toEqual(['ok1', 'ok2']);
  });
});
