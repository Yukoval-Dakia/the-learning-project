import type { z } from 'zod';
import { EventDetailResponseSchema } from '@/capabilities/observability/api/event-contracts';

export const eventNow = new Date('2026-10-09T12:34:56.789Z');
export const eventReason = '  保留原件、条件与歧义。\n'.repeat(70);
export const eventPayload: unknown = JSON.parse(`{
  "answer_md": ${JSON.stringify('第二个分支缺少条件。α🙂\n'.repeat(250))},
  "answer_image_refs": ["asset_original_1", "asset_original_2"],
  "referenced_knowledge_ids": ["k1", "k2"],
  "__proto__": {"must_be_own": [null, false, 0, {"nested": "原文"}]},
  "constructor": {"prototype": "ordinary JSON key"},
  "branches": [{"conditions": [true, null, 0], "ambiguity": {"resolved": false}}]
}`);
export const eventCorrectionInput = {
  correction_kind: 'retract' as const,
  reason_md: eventReason,
  affected_refs: [
    { kind: 'question' as const, id: 'q1' },
    { kind: 'question_part' as const, id: 'part2' },
  ],
};
const active = { state: 'active' as const, correction_event_id: null, replacement_event_id: null };
export function eventRow(id: string) {
  return {
    id,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'q1',
    outcome: 'failure',
    payload: eventPayload,
    created_at: eventNow.toISOString(),
    correction_status: active,
    task_run_id: `run_${id}`,
    cost_micro_usd: 0,
    dispatch_seq: 12,
    affected_scopes: ['global', 'question:q1'],
    future_envelope: JSON.parse('{"__proto__":{"own":true},"constructor":{"nested":[null,false]}}'),
  };
}
export const eventDetail: z.infer<typeof EventDetailResponseSchema> =
  EventDetailResponseSchema.parse({
    event: {
      ...eventRow('focus / 原件'),
      caused_by_event_id: 'cause',
      correction_status: {
        state: 'marked_wrong',
        correction_event_id: 'correction2',
        replacement_event_id: null,
      },
    },
    correction_status: {
      state: 'marked_wrong',
      correction_event_id: 'correction2',
      replacement_event_id: null,
    },
    chain: {
      caused_by: eventRow('cause'),
      caused_events: [eventRow('effect1'), eventRow('effect2')],
      corrections: ['correction2', 'correction1'].map((id) => ({
        ...eventRow(id),
        action: 'correct',
        subject_kind: 'event',
        subject_id: 'focus / 原件',
        payload: eventCorrectionInput,
        caused_by_event_id: 'focus / 原件',
      })),
    },
  });
