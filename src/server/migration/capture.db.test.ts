import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { canonicalHash } from '@/core/migration/canonical';
import { checkpointHashOf } from '@/core/migration/checkpoint';
import { classifyMigrationCapture } from '@/core/migration/classify';
import { type ManifestOptions, buildMigrationManifest } from '@/core/migration/manifest';
import type { RecordClassification } from '@/core/migration/types';

import {
  answer,
  difficulty_calibration_label,
  event,
  item_calibration,
  learning_record,
  learning_session,
  mastery_state,
  material_fsrs_state,
  question,
} from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import { captureMigrationCheckpoint } from './capture';

// YUK-1048 — capture reader DB 测试（review P1-3/P1-4/P1-7 修订）。
// 真表 seed 代表性历史形状（含真实 durable 冻结输入与 answer-bearing review）
// → REPEATABLE READ READ ONLY 捕获 → native 分类各归其位；观测级幂等
// （同观测重跑 hash 稳定）；可变运维字段（event.ingest_at）不进事实哈希但
// 【进】checkpoint 身份（P1-1）。

const NOW = new Date('2026-09-20T00:00:00.000Z');

// 真实冻结契约形状（AttemptQuestionSnapshot，question-evidence-snapshot.ts）。
const SNAPSHOT = {
  schema_version: 1,
  question: {
    question_id: 'q-main',
    question_version: 0,
    parent_question_id: null,
    prompt_md: '1+1=?',
    reference_md: '2',
    choices_md: null,
    image_refs: [],
    figures: [],
    updated_at: '2026-09-01T00:00:00.000Z',
  },
  parent_question: null,
} as const;

// 真实 durable 冻结输入（FrozenQuestionSnapshot 结构，judge-run-payload.ts）。
const FROZEN_DURABLE = {
  kind: 'short_answer',
  prompt_md: '1+1=?',
  reference_md: '2',
  rubric_json: null,
  choices_md: null,
  judge_kind_override: null,
  knowledge_ids: ['kc-1'],
  difficulty: 3,
  metadata: null,
  figures: [],
  image_refs: [],
  structured: null,
  version: 0,
  updated_at: '2026-09-01T00:00:00.000Z',
} as const;

const PROVENANCE: ManifestOptions = {
  tool_version: 'test',
  git_sha: null,
  app_image: null,
  worker_image: null,
  migration_files: null,
  redaction: { applied: false, fields: [] },
};

async function seedAttempt(input: {
  id: string;
  questionId: string;
  payload: Record<string, unknown>;
  outcome?: string;
  sessionId?: string | null;
  created_at?: Date;
}) {
  await testDb()
    .insert(event)
    .values({
      id: input.id,
      session_id: input.sessionId ?? null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: input.questionId,
      outcome: input.outcome ?? 'failure',
      payload: input.payload,
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: input.created_at ?? NOW,
    });
}

async function seedJudge(
  id: string,
  targetEventId: string,
  payload: Record<string, unknown>,
  causedBy?: string,
): Promise<void> {
  await testDb()
    .insert(event)
    .values({
      id,
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'judge',
      action: 'judge',
      subject_kind: 'event',
      subject_id: targetEventId,
      outcome: 'success',
      payload,
      caused_by_event_id: causedBy ?? targetEventId,
      task_run_id: null,
      cost_micro_usd: 12,
      created_at: NOW,
    });
}

async function seedQuestion(id: string, extra: Partial<typeof question.$inferInsert> = {}) {
  await testDb()
    .insert(question)
    .values({
      id,
      kind: 'short_answer',
      prompt_md: `${id} 题面`,
      reference_md: '2',
      knowledge_ids: ['kc-1'],
      difficulty: 3,
      source: 'manual',
      variant_depth: 0,
      image_refs: [],
      figures: [],
      created_at: NOW,
      updated_at: NOW,
      version: 0,
      ...extra,
    });
}

/** 真实 JudgePendingAttemptPayload 形状（含 submit 冻结输入）。 */
async function seedDurablePending(input: {
  id: string;
  runId: string;
  responseMd: string;
  withSnapshot: boolean;
}) {
  await testDb()
    .insert(event)
    .values({
      id: input.id,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:judge_pending_attempt',
      subject_kind: 'question',
      subject_id: 'q-main',
      outcome: null,
      payload: {
        run_id: input.runId,
        caller: 'submit',
        knowledge_ids: ['kc-1'],
        submit: {
          body: { response_md: input.responseMd },
          question_id: 'q-main',
          submitted_at: NOW.toISOString(),
          ...(input.withSnapshot ? { question_snapshot: { ...FROZEN_DURABLE } } : {}),
        },
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: NOW,
    });
}

/** review-settlement 形状：durable 回填 review（id=run_id）携作答 + embedded judge。 */
async function seedBackfilledReview(input: {
  runId: string;
  responseMd: string;
  withVerdict: boolean;
  withPending: boolean;
  pendingId?: string;
  pendingSnapshot?: boolean;
}) {
  if (input.withPending) {
    await seedDurablePending({
      id: input.pendingId ?? `pen-${input.runId}`,
      runId: input.runId,
      responseMd: input.responseMd,
      withSnapshot: input.pendingSnapshot ?? true,
    });
  }
  await testDb()
    .insert(event)
    .values({
      id: input.runId,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'review',
      subject_kind: 'question',
      subject_id: 'q-main',
      outcome: 'success',
      payload: {
        fsrs_rating: 'good',
        user_response_md: input.responseMd,
        answer_image_refs: [],
        referenced_knowledge_ids: ['kc-1'],
        ...(input.withVerdict
          ? {
              judge: {
                route: 'exact',
                score: 1,
                score_meaning: 'correctness',
                coarse_outcome: 'correct',
                confidence: 0.9,
                feedback_md: '答对了',
                evidence_json: {},
                capability_ref: { id: 'exact', version: '1.0.0' },
                suggested_rating: 'good',
                auto_rated: true,
              },
            }
          : {}),
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: NOW,
    });
}

async function seedRepresentativeShapes() {
  await seedQuestion('q-main');
  await seedQuestion('q-part', { parent_question_id: 'q-main', part_index: 1 });
  await testDb().insert(learning_session).values({
    id: 'sess-solve',
    type: 'tutor',
    status: 'judged',
    started_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    version: 0,
  });

  // (1) 完整 attempt：真实契约 snapshot + verdict judge + frozen answer。
  await seedAttempt({
    id: 'att-complete',
    questionId: 'q-main',
    payload: { answer_md: '2', answer_image_refs: [], question_snapshot: { ...SNAPSHOT } },
    outcome: 'success',
  });
  await seedJudge('jud-complete', 'att-complete', {
    judge_route: 'exact',
    coarse_outcome: 'correct',
    score: 1,
    referenced_knowledge_ids: ['kc-1'],
  });
  await testDb().insert(answer).values({
    id: 'ans-complete',
    question_id: 'q-main',
    input_kind: 'text',
    content_md: '2',
    image_refs: [],
    tags: [],
    submitted_at: NOW,
    session_id: 'sess-solve',
    part_ref: null,
    event_id: 'att-complete',
    autosaved_at: NOW,
  });

  // (2) embedded tutor grade：solve_tutor 嵌入 verdict。
  await seedAttempt({
    id: 'att-solve',
    questionId: 'q-main',
    payload: {
      answer_md: '推导…',
      question_snapshot: { ...SNAPSHOT },
      source: 'solve_tutor',
      judge_route: 'semantic',
      judge_score: 0.8,
      judge: { coarse_outcome: 'partial' },
    },
    outcome: 'partial',
    sessionId: 'sess-solve',
  });

  // (3) durable：完整回填链（真实 submit 冻结输入 + answer-bearing review）。
  await seedBackfilledReview({
    runId: 'run-backfilled',
    responseMd: '我的手写作答',
    withVerdict: true,
    withPending: true,
    pendingId: 'pen-ok',
    pendingSnapshot: true,
  });
  // (3b) durable 未 backfill（真实 submit 结构）。
  await seedDurablePending({
    id: 'pen-1',
    runId: 'run-unbackfilled',
    responseMd: '排队中的作答',
    withSnapshot: true,
  });

  // (4) 缺 issued snapshot 的历史 attempt（YUK-804 之前）。
  await seedAttempt({
    id: 'att-no-snapshot',
    questionId: 'q-main',
    payload: { answer_md: '旧答案', answer_image_refs: [] },
    outcome: 'failure',
  });

  // (5) correction cycle：correct 触及 judge，且（P1-4）传播到 attempt 与同锚 judge。
  await seedAttempt({
    id: 'att-corrected',
    questionId: 'q-main',
    payload: { answer_md: '2', question_snapshot: { ...SNAPSHOT } },
    outcome: 'success',
  });
  await seedJudge('jud-corrected', 'att-corrected', {
    judge_route: 'exact',
    coarse_outcome: 'correct',
    score: 1,
    referenced_knowledge_ids: [],
  });
  await seedJudge('jud-sibling', 'att-corrected', {
    judge_route: 'semantic',
    coarse_outcome: 'partial',
    score: 0.5,
    referenced_knowledge_ids: [],
  });
  await seedJudge('jud-replacement', 'att-corrected', {
    judge_route: 'exact',
    coarse_outcome: 'incorrect',
    score: 0,
    referenced_knowledge_ids: [],
  });
  await testDb()
    .insert(event)
    .values({
      id: 'cor-1',
      session_id: null,
      actor_kind: 'agent',
      actor_ref: 'rejudge',
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'jud-corrected',
      outcome: 'success',
      payload: {
        correction_kind: 'supersede',
        replacement_event_id: 'jud-replacement',
        reason_md: '答案键缺陷，双向纠正（D6）',
        affected_refs: [{ kind: 'question', id: 'q-main' }],
      },
      caused_by_event_id: 'jud-corrected',
      task_run_id: null,
      cost_micro_usd: null,
      created_at: NOW,
    });

  // (6) 人工错题断言：attempt + learning_record(mistake, manual)。
  await seedAttempt({
    id: 'att-manual',
    questionId: 'q-main',
    payload: { answer_md: '我写的', question_snapshot: { ...SNAPSHOT } },
    outcome: 'failure',
  });
  await testDb()
    .insert(learning_record)
    .values({
      id: 'lr-manual',
      kind: 'mistake',
      content_md: '我写的',
      source: 'manual',
      capture_mode: 'text',
      activity_kind: 'attempt',
      processing_status: 'raw',
      knowledge_ids: ['kc-1'],
      question_id: 'q-main',
      attempt_event_id: 'att-manual',
      origin_event_id: 'att-manual',
      asset_refs: [],
      payload: {},
      created_at: NOW,
      updated_at: NOW,
      version: 0,
    });

  // (7) live draft（未提交）。
  await testDb().insert(answer).values({
    id: 'ans-draft',
    question_id: 'q-main',
    input_kind: 'text',
    content_md: '写了一半',
    image_refs: [],
    tags: [],
    submitted_at: null,
    session_id: 'sess-solve',
    part_ref: null,
    event_id: null,
    autosaved_at: NOW,
  });

  // (8) 闭包引用：非评估事件被 judge 的 caused_by 指向（P1-7）。
  await testDb()
    .insert(event)
    .values({
      id: 'knode-1',
      session_id: null,
      actor_kind: 'cron',
      actor_ref: 'nightly',
      action: 'propose',
      subject_kind: 'knowledge',
      subject_id: 'kc-9',
      outcome: 'success',
      payload: { title: '闭包引用的候选 KC' },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: NOW,
    });
  await seedJudge(
    'jud-closure',
    'att-complete',
    { coarse_outcome: 'correct', score: 1, referenced_knowledge_ids: [] },
    'knode-1',
  );
  // 注意：jud-closure 是 att-complete 的第二个 verdict（created_at 相同 ⇒ 并列
  // ambiguous held —— 故意保留该形态验证 P1-4 held 路径？不 —— att-complete 需要
  // 干净的 complete。给 jud-closure 更晚的 created_at，成为 newest head。
  await testDb()
    .update(event)
    .set({ created_at: new Date('2026-09-20T00:00:01.000Z') })
    .where(eq(event.id, 'jud-closure'));

  // 状态分区各一行（manifest 语义计数 + 事实哈希覆盖）。
  await testDb()
    .insert(material_fsrs_state)
    .values({
      id: 'fsrs-1',
      subject_kind: 'question',
      subject_id: 'q-main',
      state: {
        due: new Date('2026-10-01T00:00:00.000Z'),
        stability: 1,
        difficulty: 5,
        scheduled_days: 1,
        learning_steps: 0,
        reps: 1,
        lapses: 0,
        state: 'review',
        last_review: null,
      },
      due_at: new Date('2026-10-01T00:00:00.000Z'),
      last_review_event_id: 'att-complete',
      updated_at: NOW,
    });
  await testDb().insert(mastery_state).values({
    id: 'mas-1',
    subject_kind: 'knowledge',
    subject_id: 'kc-1',
    theta_hat: 0.5,
    evidence_count: 1,
    success_count: 1,
    fail_count: 0,
    last_outcome_at: NOW,
    theta_precision: 1.2,
    updated_at: NOW,
  });
  await testDb().insert(difficulty_calibration_label).values({
    id: 'dcl-1',
    question_id: 'q-main',
    attempt_event_id: 'att-complete',
    theta_snapshot: 0.4,
    outcome: 1,
    b_label: -0.3,
    inclusion_probability: 0.7,
    created_at: NOW,
  });
}

function categoryOf(
  classification: { records: RecordClassification[] },
  sourceId: string,
): string | undefined {
  return classification.records.find((r) => r.source_id === sourceId)?.category;
}

beforeEach(async () => {
  await resetDb();
  await seedRepresentativeShapes();
});

describe('captureMigrationCheckpoint + classifyMigrationCapture（真表）', () => {
  it('代表性形状各归其 native 桶（含 P1-3 review 双形态与 P1-4 传播）', async () => {
    const capture = await captureMigrationCheckpoint(testDb());
    const classification = classifyMigrationCapture(capture);

    // (1) 完整 attempt —— jud-complete 与 jud-closure 两个 verdict、不同时刻 ⇒
    // newest（jud-closure）为 head，jud-complete 为 not_selected（P1-4）。
    expect(categoryOf(classification, 'att-complete')).toBe('complete_attempt');
    const headRecord = classification.records.find(
      (r) =>
        r.source_id === 'jud-closure' && r.native_target.kind === 'submission_with_imported_eval',
    );
    expect(headRecord).toMatchObject({
      native_target: { has_effective_head: true, head_selection: 'legacy_newest_judge' },
    });
    expect(classification.records.find((r) => r.source_id === 'jud-complete')).toMatchObject({
      native_target: { has_effective_head: false, head_selection: 'not_selected' },
    });
    expect(categoryOf(classification, 'ans-complete')).toBe('complete_attempt');

    // (2) embedded tutor grade。
    expect(categoryOf(classification, 'att-solve')).toBe('embedded_tutor_grade');

    // (3) durable 完整链：answer-bearing review → complete；pending → 世系（P1-3）。
    expect(categoryOf(classification, 'run-backfilled')).toBe('complete_attempt');
    expect(categoryOf(classification, 'pen-ok')).toBe('pending_resolved_lineage');
    // (3b) 未 backfill → pending blocked（真实 submit 冻结输入保留在 capture）。
    expect(categoryOf(classification, 'pen-1')).toBe('pending_blocked');
    const pendingPayloadKept = capture.rawFacts.events.find((e) => e.id === 'pen-1');
    expect(JSON.stringify(pendingPayloadKept?.payload)).toContain('排队中的作答');

    // (4) 缺 issued snapshot → historical_unresolved。
    expect(categoryOf(classification, 'att-no-snapshot')).toBe('historical_unresolved');

    // (5) correction cycle 全链保持 unresolved（P1-4：传播含 sibling judge）。
    expect(categoryOf(classification, 'att-corrected')).toBe('correction_cycle_unresolved');
    expect(categoryOf(classification, 'jud-corrected')).toBe('correction_cycle_unresolved');
    expect(categoryOf(classification, 'jud-sibling')).toBe('correction_cycle_unresolved');
    expect(categoryOf(classification, 'jud-replacement')).toBe('correction_cycle_unresolved');
    expect(categoryOf(classification, 'cor-1')).toBe('correction_cycle_unresolved');

    // (6) 人工断言诚实标注。
    expect(categoryOf(classification, 'att-manual')).toBe('human_import_assertion');
    // (7) live draft 精确保存。
    expect(categoryOf(classification, 'ans-draft')).toBe('live_draft');
    // (8) 闭包引用的非评估事件 → causal_closure_lineage（P1-7）。
    expect(categoryOf(classification, 'knode-1')).toBe('causal_closure_lineage');

    // deferred replay：correction cycle 入清单。
    expect(classification.deferred_replay.map((d) => d.source_id)).toContain('att-corrected');
    expect(classification.unresolved.map((u) => u.source_id)).toEqual(
      expect.arrayContaining([
        'att-no-snapshot',
        'att-corrected',
        'jud-corrected',
        'jud-sibling',
        'jud-replacement',
        'cor-1',
      ]),
    );
  });

  it('P1-3 补充形态：durable pre-snapshot 回填 → historical_unresolved；solo answer-bearing review → historical_unresolved；自评回填 → manual', async () => {
    await seedBackfilledReview({
      runId: 'run-presnap',
      responseMd: '旧 durable 作答',
      withVerdict: true,
      withPending: true,
      pendingId: 'pen-presnap',
      pendingSnapshot: false,
    });
    await testDb()
      .insert(event)
      .values({
        id: 'rev-solo',
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'review',
        subject_kind: 'question',
        subject_id: 'q-main',
        outcome: 'success',
        payload: { fsrs_rating: 'good', user_response_md: 'solo 作答', answer_image_refs: [] },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
        created_at: NOW,
      });
    await seedBackfilledReview({
      runId: 'run-selfrate',
      responseMd: '自评作答',
      withVerdict: false,
      withPending: true,
      pendingId: 'pen-selfrate',
      pendingSnapshot: true,
    });

    const capture = await captureMigrationCheckpoint(testDb());
    const classification = classifyMigrationCapture(capture);
    expect(categoryOf(classification, 'run-presnap')).toBe('historical_unresolved');
    expect(categoryOf(classification, 'rev-solo')).toBe('historical_unresolved');
    expect(categoryOf(classification, 'run-selfrate')).toBe('human_import_assertion');
  });

  it('捕获覆盖 FSRS/mastery/calibration/血缘分区 + 完整 event 分区（P1-7）', async () => {
    const capture = await captureMigrationCheckpoint(testDb());
    expect(capture.rawFacts.fsrs).toHaveLength(1);
    expect(capture.rawFacts.mastery).toHaveLength(1);
    expect(capture.rawFacts.difficulty_labels).toHaveLength(1);
    const part = capture.rawFacts.question_lineage.find((q) => q.id === 'q-part');
    expect(part?.parent_question_id).toBe('q-main');
    expect(part?.part_index).toBe(1);
    expect(capture.rawFacts.sessions.map((s) => s.id)).toContain('sess-solve');
    expect(capture.environment.isolation).toBe('repeatable read read only');
    // 完整分区：非评估动作（propose）的事件体也被捕获。
    const propose = capture.rawFacts.events.find((e) => e.id === 'knode-1');
    expect(propose?.action).toBe('propose');
    expect(capture.rawFacts.event_action_counts.map((c) => c.action)).toContain('propose');
  });

  it('manifest：checkpoint 身份、分类持久化、completeness 声明齐备（P1-1/P1-2）', async () => {
    const capture = await captureMigrationCheckpoint(testDb());
    const classification = classifyMigrationCapture(capture);
    const manifest = buildMigrationManifest(capture, classification, PROVENANCE);

    const eventEntry = manifest.semantic_counts.find((s) => s.table === 'event');
    expect(eventEntry?.rows).toBe(capture.rawFacts.events.length);
    expect(eventEntry?.pks).toContain('att-complete');

    expect(manifest.projection_baseline.question).toBeUndefined(); // question 不是 fold owner
    expect(manifest.projection_baseline.knowledge).toBe(0);

    expect(manifest.completeness.max_dispatch_seq).not.toBeNull();
    expect(manifest.completeness.note).toContain('不是完整性证明');
    expect(manifest.queues.pgboss_schema_present).toBe(false); // 测试容器未建 pgboss schema —— 显式降级
    expect(manifest.mutable_ops_fields.excluded_from_fact_hash).toContain('event.ingest_at');

    // P1-2：完整分类随清单持久化。
    expect(manifest.classification.records).toEqual(classification.records);
    expect(manifest.classification.unresolved).toEqual(classification.unresolved);
    expect(manifest.classification.deferred_replay).toEqual(classification.deferred_replay);
    // P1-1：checkpoint 身份与 capture/provenance 复算一致。
    expect(manifest.checkpoint_hash).toBe(checkpointHashOf(capture, PROVENANCE));
  });
});

describe('幂等与可变运维字段纪律（真库观测）', () => {
  it('同状态重跑捕获 → rawFacts canonical hash 逐字节一致', async () => {
    const first = await captureMigrationCheckpoint(testDb());
    const second = await captureMigrationCheckpoint(testDb());
    expect(canonicalHash(second.rawFacts)).toBe(canonicalHash(first.rawFacts));
  });

  it('P1-1：event.ingest_at（可变运维字段）变化 → 事实哈希不变、ops 反映、checkpoint 身份变化', async () => {
    const before = await captureMigrationCheckpoint(testDb());
    expect(before.ops.event_ingest_at).toHaveLength(0);

    // 模拟 outbox poll：给事件打 ingest_at（仅测试库写入）。
    await testDb()
      .update(event)
      .set({ ingest_at: new Date('2026-09-21T00:00:00.000Z') })
      .where(eq(event.id, 'att-complete'));

    const after = await captureMigrationCheckpoint(testDb());
    // 事实哈希不受可变运维字段影响。
    expect(canonicalHash(after.rawFacts)).toBe(canonicalHash(before.rawFacts));
    // ops 单独反映。
    expect(after.ops.event_ingest_at).toEqual([
      { event_id: 'att-complete', ingest_at: '2026-09-21T00:00:00.000Z' },
    ]);
    // 但 checkpoint 身份覆盖运维态 —— 运维变了就是另一个 checkpoint。
    expect(checkpointHashOf(after, PROVENANCE)).not.toBe(checkpointHashOf(before, PROVENANCE));
  });

  it('YUK-1098：learning_session.version/updated_at 与 item_calibration.updated_at 变化 → ops 反映 + checkpoint 身份变化', async () => {
    const base = await captureMigrationCheckpoint(testDb());
    expect(base.ops.state_version_max.learning_session).toBe(0);
    expect(base.ops.state_updated_at_max.learning_session).toBe('2026-09-20T00:00:00.000Z');
    expect(base.ops.state_updated_at_max.item_calibration).toBeNull();

    // 仅可变运维字段变化（seed 之后 version 自増/updated_at 刷新）。
    await testDb()
      .update(learning_session)
      .set({ version: 7, updated_at: new Date('2026-09-22T00:00:00.000Z') })
      .where(eq(learning_session.id, 'sess-solve'));
    const bumped = await captureMigrationCheckpoint(testDb());
    expect(bumped.ops.state_version_max.learning_session).toBe(7);
    expect(bumped.ops.state_updated_at_max.learning_session).toBe('2026-09-22T00:00:00.000Z');
    // 事实哈希不变（这些列不在原始 SELECT），但 checkpoint 身份必变 ——
    // 修复前该观测会被工件寻址当 already-present 静默丢掉。
    expect(canonicalHash(bumped.rawFacts)).toBe(canonicalHash(base.rawFacts));
    expect(checkpointHashOf(bumped, PROVENANCE)).not.toBe(checkpointHashOf(base, PROVENANCE));

    // item_calibration.updated_at 同样在观测窗内可变 → 采集覆盖。
    await testDb().insert(item_calibration).values({
      id: 'ical-1',
      question_id: 'q-main',
      b: 0.3,
      confidence: 0.8,
      track: 'hard',
      source: 'llm_prior',
      calibration_n: 0,
      created_at: NOW,
      updated_at: NOW,
    });
    await testDb()
      .update(item_calibration)
      .set({ updated_at: new Date('2026-09-23T00:00:00.000Z') })
      .where(eq(item_calibration.id, 'ical-1'));
    const calib = await captureMigrationCheckpoint(testDb());
    expect(calib.ops.state_updated_at_max.item_calibration).toBe('2026-09-23T00:00:00.000Z');
    expect(checkpointHashOf(calib, PROVENANCE)).not.toBe(checkpointHashOf(bumped, PROVENANCE));
  });

  it('新事实写入 → 事实哈希与 checkpoint 身份都变化（捕获能察觉增量）', async () => {
    const before = await captureMigrationCheckpoint(testDb());
    await seedAttempt({
      id: 'att-later',
      questionId: 'q-main',
      payload: { answer_md: '新答案', question_snapshot: { ...SNAPSHOT } },
      outcome: 'success',
    });
    const after = await captureMigrationCheckpoint(testDb());
    expect(canonicalHash(after.rawFacts)).not.toBe(canonicalHash(before.rawFacts));
    expect(checkpointHashOf(after, PROVENANCE)).not.toBe(checkpointHashOf(before, PROVENANCE));
  });

  it('快照时刻变化不影响 checkpoint 身份（重跑不产生重复捕获的前提）', async () => {
    const first = await captureMigrationCheckpoint(testDb());
    const second = await captureMigrationCheckpoint(testDb());
    expect(second.environment.snapshot_at).not.toBe(first.environment.snapshot_at);
    expect(checkpointHashOf(second, PROVENANCE)).toBe(checkpointHashOf(first, PROVENANCE));
  });
  it('终轮 P1-1 repro（真库）：4 字段残缺 durable snapshot + 作答 + verdict ⇒ NOT complete', async () => {
    const fourFieldSnapshot = {
      kind: 'short_answer',
      prompt_md: '1+1=?',
      version: 0,
      updated_at: '2026-09-01T00:00:00Z',
    };
    await testDb()
      .insert(event)
      .values({
        id: 'pen-r1',
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'experimental:judge_pending_attempt',
        subject_kind: 'question',
        subject_id: 'q-main',
        outcome: null,
        payload: {
          run_id: 'run-r1',
          caller: 'submit',
          knowledge_ids: ['kc-1'],
          submit: {
            body: { response_md: '残缺快照作答' },
            question_id: 'q-main',
            submitted_at: NOW.toISOString(),
            question_snapshot: fourFieldSnapshot,
          },
        },
        created_at: NOW,
      });
    await seedBackfilledReview({
      runId: 'run-r1',
      responseMd: '残缺快照作答',
      withVerdict: true,
      withPending: false,
    });
    const capture = await captureMigrationCheckpoint(testDb());
    const classification = classifyMigrationCapture(capture);
    expect(categoryOf(classification, 'run-r1')).toBe('historical_unresolved');
  });

  it('终轮 P1-1 repro（真库）：跨题快照身份不绑定 ⇒ unresolved', async () => {
    const wrongQuestionSnapshot = JSON.parse(JSON.stringify(SNAPSHOT)) as {
      question: { question_id: string };
    };
    wrongQuestionSnapshot.question.question_id = 'q-other';
    await seedAttempt({
      id: 'att-mismatch',
      questionId: 'q-main',
      payload: { answer_md: '2', question_snapshot: wrongQuestionSnapshot },
      outcome: 'success',
    });
    await seedJudge('jud-mismatch', 'att-mismatch', { coarse_outcome: 'correct', score: 1 });
    const capture = await captureMigrationCheckpoint(testDb());
    const classification = classifyMigrationCapture(capture);
    expect(categoryOf(classification, 'att-mismatch')).toBe('historical_unresolved');
    expect(categoryOf(classification, 'jud-mismatch')).toBe('historical_unresolved');
  });

  it('终轮 P1-1 repro（真库）：值域非法判词 ⇒ judge 不可 effective，attempt blocked', async () => {
    await seedAttempt({
      id: 'att-bogus',
      questionId: 'q-main',
      payload: { answer_md: '2', question_snapshot: { ...SNAPSHOT } },
      outcome: 'success',
    });
    await seedJudge('jud-bogus', 'att-bogus', { coarse_outcome: 'bogus', score: false });
    const capture = await captureMigrationCheckpoint(testDb());
    const classification = classifyMigrationCapture(capture);
    expect(categoryOf(classification, 'jud-bogus')).toBe('historical_unresolved');
    expect(categoryOf(classification, 'att-bogus')).toBe('pending_blocked');
    const headRecords = classification.records.filter(
      (r) =>
        r.native_target.kind === 'submission_with_imported_eval' &&
        r.native_target.has_effective_head,
    );
    expect(headRecords.map((r) => r.source_id)).not.toContain('jud-bogus');
  });

  it('终轮 P1-3 repro（真库）：unsupported_judge + 后到有效 verdict ⇒ 一致提升为 complete', async () => {
    await seedAttempt({
      id: 'att-unsupported',
      questionId: 'q-main',
      payload: {
        answer_md: null,
        answer_image_refs: ['asset-9'],
        question_snapshot: { ...SNAPSHOT },
        unsupported_judge: true,
      },
      outcome: 'failure',
    });
    await seedJudge(
      'jud-late',
      'att-unsupported',
      { coarse_outcome: 'correct', score: 1 },
      undefined,
    );
    const capture = await captureMigrationCheckpoint(testDb());
    const classification = classifyMigrationCapture(capture);
    expect(categoryOf(classification, 'att-unsupported')).toBe('complete_attempt');
    const judgeRow = classification.records.find((r) => r.source_id === 'jud-late');
    expect(judgeRow).toMatchObject({ native_target: { has_effective_head: true } });
  });
});

describe('空库形状（D19 类比）', () => {
  it('无事件/无 answers → 分类空输出，捕获不抛错', async () => {
    await resetDb();
    const capture = await captureMigrationCheckpoint(testDb());
    const classification = classifyMigrationCapture(capture);
    expect(classification.records).toEqual([]);
    expect(capture.rawFacts.events).toEqual([]);
    expect(capture.rawFacts.answers).toEqual([]);
    expect(capture.environment.migrations_applied).not.toBeNull(); // 迁移表探测成功
  });
});
