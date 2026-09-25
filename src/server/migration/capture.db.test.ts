import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { canonicalHash } from '@/core/migration/canonical';
import { classifyMigrationCapture } from '@/core/migration/classify';
import { buildMigrationManifest } from '@/core/migration/manifest';
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

// YUK-1048 — capture reader DB 测试：真表 seed 五类代表性历史形状 →
// REPEATABLE READ READ ONLY 捕获 → native 分类各归其位；观测级幂等
// （同事实重跑 hash 稳定）；可变运维字段（event.ingest_at）不进事实哈希。

const NOW = new Date('2026-09-20T00:00:00.000Z');
const SNAPSHOT = { prompt_md: '1+1=?', kind: 'short_answer' } as const;

async function seedAttempt(input: {
  id: string;
  questionId: string;
  payload: Record<string, unknown>;
  outcome?: string;
  sessionId?: string | null;
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
      created_at: NOW,
    });
}

async function seedJudge(
  id: string,
  attemptId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await testDb().insert(event).values({
    id,
    session_id: null,
    actor_kind: 'agent',
    actor_ref: 'judge',
    action: 'judge',
    subject_kind: 'event',
    subject_id: attemptId,
    outcome: 'success',
    payload,
    caused_by_event_id: attemptId,
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

  // (1) 完整 attempt：snapshot + 真实 verdict judge + frozen answer。
  await seedAttempt({
    id: 'att-complete',
    questionId: 'q-main',
    payload: { answer_md: '2', answer_image_refs: [], question_snapshot: SNAPSHOT },
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

  // (2) embedded tutor grade：solve_tutor 嵌入判分。
  await seedAttempt({
    id: 'att-solve',
    questionId: 'q-main',
    payload: {
      answer_md: '推导…',
      question_snapshot: SNAPSHOT,
      source: 'solve_tutor',
      judge_route: 'semantic',
      judge_score: 0.8,
      judge: { coarse_outcome: 'partial' },
    },
    outcome: 'partial',
    sessionId: 'sess-solve',
  });

  // (3) pending：durable run 未 backfill（run_id 无对应事件）。
  await testDb()
    .insert(event)
    .values({
      id: 'pen-1',
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:judge_pending_attempt',
      subject_kind: 'question',
      subject_id: 'q-main',
      outcome: null,
      payload: {
        run_id: 'run-unbackfilled',
        caller: 'submit',
        knowledge_ids: ['kc-1'],
        submit: {
          body: { answer_md: 'x' },
          question_id: 'q-main',
          submitted_at: NOW.toISOString(),
        },
      },
      caused_by_event_id: null,
      task_run_id: null,
      cost_micro_usd: null,
      created_at: NOW,
    });

  // (4) 缺 issued snapshot 的历史 attempt（YUK-804 之前）。
  await seedAttempt({
    id: 'att-no-snapshot',
    questionId: 'q-main',
    payload: { answer_md: '旧答案', answer_image_refs: [] },
    outcome: 'failure',
  });

  // (5) correction cycle：attempt + judge + correct(supersede, replacement)。
  await seedAttempt({
    id: 'att-corrected',
    questionId: 'q-main',
    payload: { answer_md: '2', question_snapshot: SNAPSHOT },
    outcome: 'success',
  });
  await seedJudge('jud-corrected', 'att-corrected', {
    judge_route: 'exact',
    coarse_outcome: 'correct',
    score: 1,
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
    payload: { answer_md: '我写的', question_snapshot: SNAPSHOT },
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

let capturedOnce: Awaited<ReturnType<typeof captureMigrationCheckpoint>> | undefined;

beforeEach(async () => {
  await resetDb();
  await seedRepresentativeShapes();
  capturedOnce = undefined;
});

describe('captureMigrationCheckpoint + classifyMigrationCapture（真表）', () => {
  it('五类代表性形状各归其 native 桶', async () => {
    const capture = await captureMigrationCheckpoint(testDb());
    capturedOnce = capture;
    const classification = classifyMigrationCapture(capture);

    // (1) 完整 attempt → submission + imported eval/head（frozen answer 镜像）。
    expect(categoryOf(classification, 'att-complete')).toBe('complete_attempt');
    expect(categoryOf(classification, 'jud-complete')).toBe('complete_attempt');
    expect(categoryOf(classification, 'ans-complete')).toBe('complete_attempt');
    // (2) embedded tutor grade。
    expect(categoryOf(classification, 'att-solve')).toBe('embedded_tutor_grade');
    // (3) 未 backfill durable run → pending blocked。
    expect(categoryOf(classification, 'pen-1')).toBe('pending_blocked');
    // (4) 缺 issued snapshot → historical_unresolved。
    expect(categoryOf(classification, 'att-no-snapshot')).toBe('historical_unresolved');
    // (5) correction cycle 全链保持 unresolved。
    expect(categoryOf(classification, 'att-corrected')).toBe('correction_cycle_unresolved');
    expect(categoryOf(classification, 'jud-corrected')).toBe('correction_cycle_unresolved');
    expect(categoryOf(classification, 'jud-replacement')).toBe('correction_cycle_unresolved');
    expect(categoryOf(classification, 'cor-1')).toBe('correction_cycle_unresolved');
    // (6) 人工断言诚实标注。
    expect(categoryOf(classification, 'att-manual')).toBe('human_import_assertion');
    // (7) live draft 精确保存。
    expect(categoryOf(classification, 'ans-draft')).toBe('live_draft');

    // deferred replay：correction cycle 入清单。
    expect(classification.deferred_replay.map((d) => d.source_id)).toContain('att-corrected');
    // unresolved 列表含缺 snapshot 与纠正链。
    expect(classification.unresolved.map((u) => u.source_id)).toEqual(
      expect.arrayContaining([
        'att-no-snapshot',
        'att-corrected',
        'jud-corrected',
        'jud-replacement',
        'cor-1',
      ]),
    );
  });

  it('捕获覆盖 FSRS/mastery/calibration/血缘分区，结构血缘含 part 关系', async () => {
    const capture = capturedOnce ?? (await captureMigrationCheckpoint(testDb()));
    expect(capture.rawFacts.fsrs).toHaveLength(1);
    expect(capture.rawFacts.mastery).toHaveLength(1);
    expect(capture.rawFacts.difficulty_labels).toHaveLength(1);
    const part = capture.rawFacts.question_lineage.find((q) => q.id === 'q-part');
    expect(part?.parent_question_id).toBe('q-main');
    expect(part?.part_index).toBe(1);
    expect(capture.rawFacts.sessions.map((s) => s.id)).toContain('sess-solve');
    expect(capture.environment.isolation).toBe('repeatable read read only');
  });

  it('manifest：语义计数/PK、projection baseline、completeness 声明齐备', async () => {
    const capture = capturedOnce ?? (await captureMigrationCheckpoint(testDb()));
    const classification = classifyMigrationCapture(capture);
    const manifest = buildMigrationManifest(capture, classification, {
      tool_version: 'test',
      git_sha: null,
      app_image: 'app:test',
      worker_image: 'worker:test',
      migration_files: null,
      redaction: { applied: false, fields: [] },
    });

    const eventEntry = manifest.semantic_counts.find((s) => s.table === 'event');
    expect(eventEntry?.rows).toBe(capture.rawFacts.events.length);
    expect(eventEntry?.pks).toContain('att-complete');

    expect(manifest.projection_baseline.question).toBeUndefined(); // question 不是 fold owner
    expect(manifest.projection_baseline.knowledge).toBe(0);
    expect(manifest.projection_baseline.question_block).toBe(0);

    expect(manifest.completeness.max_dispatch_seq).not.toBeNull();
    expect(manifest.completeness.note).toContain('不是完整性证明');
    expect(manifest.source.app_image).toBe('app:test');
    expect(manifest.queues.pgboss_schema_present).toBe(false); // 测试容器未建 pgboss schema —— 显式降级

    // 可变运维字段清单显式排除。
    expect(manifest.mutable_ops_fields.excluded_from_fact_hash).toContain('event.ingest_at');
  });
});

describe('幂等与可变运维字段纪律（真库观测）', () => {
  it('同状态重跑捕获 → rawFacts canonical hash 逐字节一致（无重复捕获的事实基础）', async () => {
    const first = await captureMigrationCheckpoint(testDb());
    const second = await captureMigrationCheckpoint(testDb());
    expect(canonicalHash(second.rawFacts)).toBe(canonicalHash(first.rawFacts));
    // 快照时刻可能不同（各自事务的 now()），它不进事实哈希。
    expect(canonicalHash(second.rawFacts.events)).toBe(canonicalHash(first.rawFacts.events));
  });

  it('event.ingest_at（可变运维字段）变化 → 事实哈希不变、ops 单独反映', async () => {
    const before = await captureMigrationCheckpoint(testDb());
    expect(before.ops.event_ingest_at).toHaveLength(0);

    // 模拟 outbox poll：给已捕获事件打 ingest_at（仅测试库写入）。
    await testDb()
      .update(event)
      .set({ ingest_at: new Date('2026-09-21T00:00:00.000Z') })
      .where(eq(event.id, 'att-complete'));

    const after = await captureMigrationCheckpoint(testDb());
    expect(canonicalHash(after.rawFacts)).toBe(canonicalHash(before.rawFacts));
    expect(after.ops.event_ingest_at).toEqual([
      { event_id: 'att-complete', ingest_at: '2026-09-21T00:00:00.000Z' },
    ]);
  });

  it('新事实写入 → 事实哈希变化（捕获能察觉增量）', async () => {
    const before = await captureMigrationCheckpoint(testDb());
    await seedAttempt({
      id: 'att-later',
      questionId: 'q-main',
      payload: { answer_md: '新答案', question_snapshot: SNAPSHOT },
      outcome: 'success',
    });
    const after = await captureMigrationCheckpoint(testDb());
    expect(canonicalHash(after.rawFacts)).not.toBe(canonicalHash(before.rawFacts));
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
