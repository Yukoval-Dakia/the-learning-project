import { describe, expect, it } from 'vitest';
import { canonicalHash } from './canonical';
import { classifyMigrationCapture } from './classify';
import { redactMigrationCapture, redactedFieldPolicy } from './redact';
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
  it('全家族私有文本被替换 —— copilot user_message / record summary_md / propose 标题也不漏', () => {
    const redacted = redactMigrationCapture(learnerCapture());
    const serialized = JSON.stringify(redacted.rawFacts.events);
    expect(serialized).not.toContain(SENTINEL);
    expect(JSON.stringify(redacted.rawFacts.answers)).not.toContain(SENTINEL);

    const byId = new Map(redacted.rawFacts.events.map((e) => [e.id, e]));
    const payloadOf = (id: string) => byId.get(id)?.payload as Record<string, unknown>;

    // 原有变体（review P1-6）继续覆盖。
    expect(payloadOf('a1').answer_md).toMatchObject({ __redacted: true, length: SENTINEL.length });
    expect(payloadOf('a1').reasoning_trace).toMatchObject({ __redacted: true });
    expect((payloadOf('j1').cause as Record<string, unknown>).analysis_md).toMatchObject({
      __redacted: true,
    });
    const pendingBody = (payloadOf('p1').submit as Record<string, unknown>).body as Record<
      string,
      unknown
    >;
    expect(pendingBody.response_md).toMatchObject({ __redacted: true });
    expect(payloadOf('run-1').user_response_md).toMatchObject({ __redacted: true });
    const judgeBlock = payloadOf('run-1').judge as Record<string, unknown>;
    expect(judgeBlock.feedback_md).toMatchObject({ __redacted: true });
    expect(judgeBlock.score).toBe(1);
    expect(judgeBlock.coarse_outcome).toBe('correct');
    expect(payloadOf('c1').reason_md).toMatchObject({ __redacted: true });
    expect(payloadOf('j1b').feedback_md).toMatchObject({ __redacted: true });

    // P1-4（终轮）：copilot 输入、record capture 摘要、知识 propose 标题。
    expect(payloadOf('cop-1').user_message).toMatchObject({ __redacted: true });
    expect(payloadOf('cop-1').surface).toBe('copilot'); // 标记保留
    expect(payloadOf('rc-1').summary_md).toMatchObject({ __redacted: true });
    expect(payloadOf('rc-1').record_kind).toBe('mistake');
    expect(payloadOf('rc-1').generated_by).toBe('auto_capture');
    expect(payloadOf('prop-1').title).toMatchObject({ __redacted: true });
    expect(payloadOf('prop-1').rationale_md).toMatchObject({ __redacted: true });

    const answer = redacted.rawFacts.answers[0];
    expect(answer.content_md).toMatchObject({ __redacted: true });
    expect(answer.vision_extracted).toMatchObject({ __redacted: true });
  });

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

  it('YUK-1098：数组标量继承父键策略 —— 非安全键 string[] 逐元素脱敏，安全键数组保留', () => {
    const capture = withEvents(emptyCapture(), [
      ev({
        id: 'doc-1',
        action: 'experimental:extract_source_document',
        subject_kind: 'record',
        subject_id: 'doc-1',
        payload: {
          warnings: [`${SENTINEL}-w1`, `${SENTINEL}-w2`],
          failure_reasons: [`${SENTINEL}-f1`],
          question_id: ['q-1', 'q-2'],
          knowledge_ids: ['kc-1', 'kc-2'],
          image_refs: [`${SENTINEL}-asset`],
          status: 'done',
          nested: { warnings: [`${SENTINEL}-deep`] },
          matrix: [[`${SENTINEL}-m1`]],
          rows: [{ note_md: `${SENTINEL}-row`, status: 'active' }],
        },
      }),
    ]);
    const redacted = redactMigrationCapture(capture);
    expect(JSON.stringify(redacted.rawFacts.events)).not.toContain(SENTINEL);

    const payload = redacted.rawFacts.events[0]?.payload as Record<string, unknown>;
    expect(payload.warnings).toHaveLength(2);
    for (const w of payload.warnings as unknown[]) {
      expect(w).toMatchObject({ __redacted: true });
    }
    expect((payload.warnings as Array<{ sha256: string }>)[0]?.sha256).toHaveLength(64);
    expect(payload.failure_reasons).toEqual([expect.objectContaining({ __redacted: true })]);
    // 安全键数组整体保留（登记键的 id 数组）。
    expect(payload.question_id).toEqual(['q-1', 'q-2']);
    // 未登记的 _ids/_refs 数组键同属默认拒绝 —— 元素是标量，父键不安全即脱敏
    // （比旧「数组元素无键」更严；分类器只读 Array.isArray/length，不受影响）。
    expect(payload.knowledge_ids).toEqual([
      expect.objectContaining({ __redacted: true }),
      expect.objectContaining({ __redacted: true }),
    ]);
    expect(payload.image_refs).toEqual([expect.objectContaining({ __redacted: true })]);
    expect(payload.status).toBe('done');
    // 嵌套对象内的非安全 string[] 同样按其父键脱敏。
    const nested = payload.nested as Record<string, unknown>;
    expect(nested.warnings).toEqual([expect.objectContaining({ __redacted: true })]);
    // 嵌套数组标量逐层继承外层键。
    expect(payload.matrix).toEqual([[expect.objectContaining({ __redacted: true })]]);
    // 数组内对象元素按自身键判定。
    const row = (payload.rows as Array<Record<string, unknown>>)[0];
    expect(row?.note_md).toMatchObject({ __redacted: true });
    expect(row?.status).toBe('active');
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

  it('redactedFieldPolicy 描述默认拒绝策略与两张安全清单', () => {
    const policy = redactedFieldPolicy();
    expect(policy.policy).toContain('default-deny');
    expect(policy.safe_string_keys).toContain('coarse_outcome');
    // 私有文本键绝不在安全清单（默认拒绝）。
    expect(policy.safe_string_keys).not.toContain('user_message');
    expect(policy.safe_string_keys).not.toContain('summary_md');
    expect(policy.safe_subtree_keys).toContain('question_snapshot');
  });
});
