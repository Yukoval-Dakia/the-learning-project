import { describe, expect, it } from 'vitest';
import { canonicalHash } from './canonical';
import { classifyMigrationCapture } from './classify';
import { redactMigrationCapture, redactedFieldList } from './redact';
import {
  SNAPSHOT,
  answeredReviewEvent,
  durablePendingEvent,
  emptyCapture,
  ev,
  judgeEvent,
  withEvents,
} from './test-fixtures';

// YUK-1048 — 脱敏单测（review P1-6：按实际捕获事件变体做深.walk）。
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
  // P1-6：durable pending 的嵌套 submit.body.response_md + review 的
  // user_response_md / embedded judge.feedback_md / reasoning_trace。
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
    payload: { coarse_outcome: 'incorrect', feedback_md: `${SENTINEL}-feedback` },
  });
  const capture = withEvents(emptyCapture(), [
    attempt,
    attribution,
    pending,
    review,
    correct,
    replacement,
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

describe('redactMigrationCapture（P1-6 深按实际事件变体）', () => {
  it('全事件变体的 learner/模型自由文本都被替换为 {__redacted, sha256, length}', () => {
    const redacted = redactMigrationCapture(learnerCapture());
    const serialized = JSON.stringify(redacted.rawFacts.events);

    // 哨兵文本在捕获中不复存在。
    expect(serialized).not.toContain(SENTINEL);
    expect(JSON.stringify(redacted.rawFacts.answers)).not.toContain(SENTINEL);

    const byId = new Map(redacted.rawFacts.events.map((e) => [e.id, e]));
    const attemptPayload = byId.get('a1')?.payload as Record<string, unknown>;
    expect(attemptPayload.answer_md).toMatchObject({ __redacted: true, length: SENTINEL.length });
    expect(attemptPayload.reasoning_trace).toMatchObject({ __redacted: true });

    const attributionPayload = byId.get('j1')?.payload as Record<string, unknown>;
    expect((attributionPayload.cause as Record<string, unknown>).analysis_md).toMatchObject({
      __redacted: true,
    });

    const pendingPayload = byId.get('p1');
    expect(pendingPayload).toBeDefined();
    const pendingSubmit = (pendingPayload as { payload: Record<string, unknown> }).payload
      .submit as Record<string, unknown>;
    const pendingBody = pendingSubmit.body as Record<string, unknown>;
    expect(pendingBody.response_md).toMatchObject({ __redacted: true, length: SENTINEL.length });

    const reviewPayload = byId.get('run-1')?.payload as Record<string, unknown>;
    expect(reviewPayload.user_response_md).toMatchObject({ __redacted: true });
    const judgeBlock = reviewPayload.judge as Record<string, unknown>;
    expect(judgeBlock.feedback_md).toMatchObject({ __redacted: true });
    // 非文本判分字段保留（score/coarse_outcome 是判词不是内容）。
    expect(judgeBlock.score).toBe(1);
    expect(judgeBlock.coarse_outcome).toBe('correct');

    const correctPayload = byId.get('c1')?.payload as Record<string, unknown>;
    expect(correctPayload.reason_md).toMatchObject({ __redacted: true });

    const replacementPayload = byId.get('j1b')?.payload as Record<string, unknown>;
    expect(replacementPayload.feedback_md).toMatchObject({ __redacted: true });

    const answer = redacted.rawFacts.answers[0];
    expect(answer.content_md).toMatchObject({ __redacted: true });
    expect(answer.vision_extracted).toMatchObject({ __redacted: true });
  });

  it('结构与分类 marker 保留 → 脱敏后分类逐类不变（P1-6：分类读 marker 不读内容）', () => {
    const capture = learnerCapture();
    const before = classifyMigrationCapture(capture);
    const after = classifyMigrationCapture(redactMigrationCapture(capture));
    expect(after.rollup).toEqual(before.rollup);
    expect(
      after.records.map((r) => [r.source_id, r.category, JSON.stringify(r.native_target)]),
    ).toEqual(
      before.records.map((r) => [r.source_id, r.category, JSON.stringify(r.native_target)]),
    );
  });

  it('原 capture 不被修改；脱敏后事实哈希变化且脱敏模式内稳定', () => {
    const capture = learnerCapture();
    const before = canonicalHash(capture.rawFacts);
    const redacted1 = redactMigrationCapture(capture);
    const redacted2 = redactMigrationCapture(capture);
    expect(canonicalHash(capture.rawFacts)).toBe(before); // 不可变
    expect(canonicalHash(redacted1.rawFacts)).not.toBe(before);
    expect(canonicalHash(redacted1.rawFacts)).toBe(canonicalHash(redacted2.rawFacts));
  });

  it('redactedFieldList 与实现一一对应', () => {
    expect(redactedFieldList()).toEqual([
      'event.payload..answer_md',
      'event.payload..user_response_md',
      'event.payload..response_md',
      'event.payload..wrong_answer_md',
      'event.payload..reasoning_trace',
      'event.payload..analysis_md',
      'event.payload..feedback_md',
      'event.payload..rejudge_raw_output',
      'event.payload..reason_md',
      'answer.content_md',
      'answer.vision_extracted',
    ]);
  });
});
