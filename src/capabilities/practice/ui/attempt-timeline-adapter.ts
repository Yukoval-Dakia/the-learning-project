// YUK-617 W1 — 把 /api/questions/:id 聚合里的 timeline（QFullTimelineEntry，宽 outcome:string、
// cause? 可选）收窄成 AttemptTimeline 组件严格消费的 AttemptTimelineEvent（判别联合）。
// 服务端已保证 outcome/fsrs_rating 落在合法集，但客户端 wire 类型是宽的——这里做类型边界收窄，
// 顺手把任何不合法/残缺条目安全丢弃（宁可不渲染，也不渲染坏数据）。

import type { AttemptTimelineEvent } from '@/ui/components/AttemptTimeline';
import type { QFullTimelineEntry } from './practice-api';

const ATTEMPT_OUTCOMES = new Set(['success', 'failure', 'partial']);
const REVIEW_OUTCOMES = new Set(['success', 'failure']);
const RATINGS = new Set(['again', 'hard', 'good']);

export function toAttemptTimelineEvents(entries: QFullTimelineEntry[]): AttemptTimelineEvent[] {
  const out: AttemptTimelineEvent[] = [];
  for (const e of entries) {
    if (e.kind === 'attempt') {
      if (!ATTEMPT_OUTCOMES.has(e.outcome)) continue;
      out.push({
        kind: 'attempt',
        event_id: e.event_id,
        created_at_sec: e.created_at_sec,
        outcome: e.outcome as 'success' | 'failure' | 'partial',
        duration_ms: e.duration_ms,
        cause: e.cause ?? null,
      });
    } else if (e.kind === 'review') {
      if (!REVIEW_OUTCOMES.has(e.outcome)) continue;
      if (!e.fsrs_rating || !RATINGS.has(e.fsrs_rating)) continue;
      out.push({
        kind: 'review',
        event_id: e.event_id,
        created_at_sec: e.created_at_sec,
        fsrs_rating: e.fsrs_rating,
        outcome: e.outcome as 'success' | 'failure',
        duration_ms: e.duration_ms,
      });
    }
  }
  return out;
}
