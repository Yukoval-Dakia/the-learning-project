import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { classifyMigrationCapture } from '@/core/migration/classify';
import type { ManifestOptions } from '@/core/migration/manifest';
import type { RecordClassification } from '@/core/migration/types';

import {
  answer,
  difficulty_calibration_label,
  event,
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

const _PROVENANCE: ManifestOptions = {
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
  // shard 共享 fork：worker-boot/epoch 等测试会真建 pgboss schema 且不回收，
  // 本文件的 capture 断言（queues.pgboss_schema_present=false）需要干净前提——
  // 主动 drop，测试自身自证「无 pgboss」而不是假定别的测试没留下。
  await testDb().execute(sql`DROP SCHEMA IF EXISTS pgboss CASCADE`);
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
});
