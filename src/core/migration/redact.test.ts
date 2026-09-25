import { describe, expect, it } from 'vitest';
import { canonicalHash } from './canonical';
import { classifyMigrationCapture } from './classify';
import { redactMigrationCapture, redactedFieldList } from './redact';
import { SNAPSHOT, emptyCapture, ev, judgeEvent, withEvents } from './test-fixtures';

// YUK-1048 — 脱敏单测：内容哈希化但结构/标记保留 → 分类结果不变（§14
// redacted flags 的诚实支撑）。

function learnerCapture() {
  const attempt = ev({
    id: 'a1',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'q-1',
    payload: {
      answer_md: '我的手写作答文本',
      reasoning_trace: '我先算了…再…',
      question_snapshot: SNAPSHOT,
      unsupported_judge: true,
    },
  });
  const attribution = judgeEvent({
    id: 'j1',
    subject_id: 'a1',
    payload: {
      cause: { primary_category: '概念不清', analysis_md: '模型分析原文', confidence: 0.7 },
      referenced_knowledge_ids: [],
    },
  });
  const capture = withEvents(emptyCapture(), [attempt, attribution]);
  capture.rawFacts.answers = [
    {
      id: 'ans1',
      question_id: 'q-1',
      learning_item_id: null,
      input_kind: 'text',
      content_md: '草稿原文',
      image_refs: [],
      vision_extracted: 'OCR 原文',
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

describe('redactMigrationCapture', () => {
  it('替换 learner/模型自由文本为 {__redacted, sha256, length}，结构与其余字段保留', () => {
    const redacted = redactMigrationCapture(learnerCapture());
    const attemptPayload = redacted.rawFacts.events[0].payload as Record<string, unknown>;
    expect(attemptPayload.answer_md).toMatchObject({
      __redacted: true,
      length: '我的手写作答文本'.length,
    });
    expect(attemptPayload.reasoning_trace).toMatchObject({ __redacted: true });
    // 标记保留（分类依赖）。
    expect(attemptPayload.unsupported_judge).toBe(true);
    expect(attemptPayload.question_snapshot).toEqual(SNAPSHOT);

    const judgePayload = redacted.rawFacts.events[1].payload as Record<string, unknown>;
    const cause = judgePayload.cause as Record<string, unknown>;
    expect(cause.analysis_md).toMatchObject({ __redacted: true });
    expect(cause.primary_category).toBe('概念不清');

    const answer = redacted.rawFacts.answers[0];
    expect(answer.content_md).toMatchObject({ __redacted: true });
    expect(answer.vision_extracted).toMatchObject({ __redacted: true });
    expect(answer.question_id).toBe('q-1');
  });

  it('脱敏不改分类结果（分类读 marker，不读内容）', () => {
    const capture = learnerCapture();
    const before = classifyMigrationCapture(capture);
    const after = classifyMigrationCapture(redactMigrationCapture(capture));
    expect(after.rollup).toEqual(before.rollup);
    expect(after.records.map((r) => [r.source_id, r.category])).toEqual(
      before.records.map((r) => [r.source_id, r.category]),
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
      'event.payload.answer_md',
      'event.payload.reasoning_trace',
      'event.payload.wrong_answer_md',
      'event.payload.cause.analysis_md',
      'answer.content_md',
      'answer.vision_extracted',
    ]);
  });
});
