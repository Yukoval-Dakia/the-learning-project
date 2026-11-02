import { describe, expect, it } from 'vitest';
import { classifyMigrationCapture } from './classify';
import { redactMigrationCapture } from './redact';
import {
  SNAPSHOT,
  answeredReviewEvent,
  durablePendingEvent,
  emptyCapture,
  ev,
  judgeEvent,
  withEvents,
} from './test-fixtures';

// YUK-1048 — 脱敏单测（终轮 P1-4：默认拒绝 + 完整分区事件家族哨兵）。
// 内容哈希化但结构/标记保留 → 分类结果不变（§14 redacted flags 的诚实支撑）。

const SENTINEL = 'PRIVATE-LEARNER-TEXT-私密的作答';

function learnerCapture() {
  const attempt = ev({
    id: 'a1',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'q-1',
    payload: {
      answer_md: SENTINEL,
      reasoning_trace: `${SENTINEL}-trace`,
      question_snapshot: SNAPSHOT,
      unsupported_judge: true,
    },
  });
  const attribution = judgeEvent({
    id: 'j1',
    subject_id: 'a1',
    payload: {
      cause: { primary_category: '概念不清', analysis_md: `${SENTINEL}-analysis`, confidence: 0.7 },
      referenced_knowledge_ids: [],
    },
  });
  const pending = durablePendingEvent({ id: 'p1', runId: 'run-1', responseMd: SENTINEL });
  const review = answeredReviewEvent({ id: 'run-1', responseMd: SENTINEL });
  const correct = ev({
    id: 'c1',
    action: 'correct',
    subject_kind: 'event',
    subject_id: 'j1',
    actor_kind: 'agent',
    actor_ref: 'rejudge',
    payload: {
      correction_kind: 'supersede',
      replacement_event_id: 'j1b',
      reason_md: `${SENTINEL}-reason`,
      affected_refs: [{ kind: 'question', id: 'q-1' }],
    },
  });
  const replacement = judgeEvent({
    id: 'j1b',
    subject_id: 'a1',
    payload: { coarse_outcome: 'incorrect', score: 0, feedback_md: `${SENTINEL}-feedback` },
  });
  // P1-4（终轮）：完整分区带进的非评估家族 —— 真实生产 payload 形状。
  const copilotUserAsk = ev({
    id: 'cop-1',
    action: 'copilot_user_ask',
    subject_kind: 'query',
    subject_id: 'cop-1',
    actor_kind: 'user',
    actor_ref: 'user:self',
    outcome: null,
    payload: { surface: 'copilot', user_message: `${SENTINEL}-copilot`, session_id: 'sess-x' },
  });
  const recordCapture = ev({
    id: 'rc-1',
    action: 'experimental:record_capture',
    subject_kind: 'record',
    subject_id: 'rec-1',
    actor_kind: 'user',
    actor_ref: 'self',
    outcome: 'success',
    payload: {
      record_kind: 'mistake',
      activity_kind: 'import',
      capture_mode: 'image',
      summary_md: `${SENTINEL}-summary`,
      generated_by: 'auto_capture',
      enroll_outcome: 'unanswered',
    },
  });
  const knowledgePropose = ev({
    id: 'prop-1',
    action: 'propose',
    subject_kind: 'knowledge',
    subject_id: 'kc-9',
    actor_kind: 'cron',
    actor_ref: 'nightly',
    outcome: 'success',
    payload: { title: `${SENTINEL}-title`, rationale_md: `${SENTINEL}-rationale` },
  });

  const capture = withEvents(emptyCapture(), [
    attempt,
    attribution,
    pending,
    review,
    correct,
    replacement,
    copilotUserAsk,
    recordCapture,
    knowledgePropose,
  ]);
  capture.rawFacts.answers = [
    {
      id: 'ans1',
      question_id: 'q-1',
      learning_item_id: null,
      input_kind: 'text',
      content_md: SENTINEL,
      image_refs: [],
      vision_extracted: SENTINEL,
      tags: [],
      submitted_at: null,
      session_id: null,
      paper_artifact_id: null,
      part_ref: null,
      event_id: null,
    },
  ];
  return capture;
}

describe('redactMigrationCapture（终轮：默认拒绝 + 完整分区家族）', () => {
  it('未知家族的未知文本键默认被脱敏（默认拒绝），标记/结构保留 → 分类逐类不变', () => {
    const capture = learnerCapture();
    // 模拟未来新增家族的未知文本键（+ 一个已登记的安全枚举键）。
    capture.rawFacts.events.push(
      ev({
        id: 'future-1',
        action: 'experimental:some_future_event',
        subject_kind: 'chip',
        subject_id: 'future-1',
        payload: { note_md: SENTINEL, status: 'value-a' },
      }),
    );
    const redacted = redactMigrationCapture(capture);
    expect(JSON.stringify(redacted.rawFacts.events)).not.toContain(SENTINEL);
    const future = redacted.rawFacts.events.find((e) => e.id === 'future-1');
    expect(future).toBeDefined();
    const futurePayload = (future as { payload: Record<string, unknown> }).payload;
    expect(futurePayload.note_md).toMatchObject({ __redacted: true });
    expect(futurePayload.status).toBe('value-a');

    const before = classifyMigrationCapture(capture);
    const after = classifyMigrationCapture(redacted);
    expect(after.rollup).toEqual(before.rollup);
    expect(after.records.map((r) => [r.source_id, r.category])).toEqual(
      before.records.map((r) => [r.source_id, r.category]),
    );
  });
});
