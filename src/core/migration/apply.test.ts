import { describe, expect, it } from 'vitest';
import {
  APPLY_ALGORITHM_VERSION,
  type BuildApplyPlanInput,
  type RevisionRegistry,
  type RevisionRegistryEntry,
  applyRunIdOf,
  buildMigrationApplyPlan,
  parseRevisionRegistry,
  planDigestOf,
  registryDigestOf,
  responseDigestOf,
} from './apply';
import { canonicalHash } from './canonical';
import { classifyMigrationCapture } from './classify';
import {
  FROZEN_DURABLE_SNAPSHOT,
  SNAPSHOT,
  answeredReviewEvent,
  durablePendingEvent,
  emptyCapture,
  ev,
  judgeEvent,
  withEvents,
} from './test-fixtures';
import type { MigrationCapture } from './types';

// YUK-1050 — apply 纯规划器单元测试：分类输出 → 写意图的逐类别映射、
// registry 解析三分支、确定性 id/plan digest、无补造纪律。
// 输入 capture 由 classifyMigrationCapture 真实产出 —— 规划器消费的是
// manifest 持久化的分类形态，不是手造分类（漂移即红）。

function classify(capture: MigrationCapture) {
  const classification = classifyMigrationCapture(capture);
  return {
    classification_version: 'test-classifier',
    classification_hash: canonicalHash({
      classification_version: 'test-classifier',
      records: classification.records,
      unresolved: classification.unresolved,
      deferred_replay: classification.deferred_replay,
    }),
    ...classification,
  };
}

function planInput(
  capture: MigrationCapture,
  registry: RevisionRegistry | null = null,
): BuildApplyPlanInput {
  return {
    capture,
    classification: classify(capture),
    checkpoint_hash: 'chk-test',
    registry,
  };
}

function recordOf(plan: ReturnType<typeof buildMigrationApplyPlan>, locator: string) {
  const found = plan.records.find((r) => r.classification.source_locator === locator);
  expect(found, `record ${locator} 应在 plan 中`).toBeDefined();
  if (found === undefined) throw new Error(`record ${locator} missing`);
  return found;
}

const REGISTRY_ENTRY = (
  questionId: string,
  overrides: Partial<RevisionRegistryEntry> = {},
): RevisionRegistryEntry => ({
  question_id: questionId,
  revision_id: `rev-${questionId}`,
  part_ids: ['p1'],
  slot_id: null,
  scoring_unit_id: null,
  snapshot_digest: null,
  published_at: null,
  ...overrides,
});

function registryOf(entries: RevisionRegistryEntry[]): RevisionRegistry {
  return { registry_version: 1, generated_by: 'test-corpus-import', entries };
}

const COMPLETE_ATTEMPT = ev({
  id: 'att-1',
  action: 'attempt',
  subject_id: 'q-1',
  outcome: 'failure',
  created_at: '2026-09-20T10:00:00.000Z',
  payload: {
    answer_md: '3',
    answer_image_refs: [],
    referenced_knowledge_ids: ['kc-1'],
    question_snapshot: SNAPSHOT,
  },
});
const HEAD_JUDGE = judgeEvent({
  id: 'jud-1',
  subject_id: 'att-1',
  outcome: 'success',
  created_at: '2026-09-20T10:00:05.000Z',
  payload: { coarse_outcome: 'incorrect', score: 0, feedback_md: '应为 2' },
});

describe('parseRevisionRegistry', () => {
  it('接受合法 registry 并保持字段', () => {
    const parsed = parseRevisionRegistry(registryOf([REGISTRY_ENTRY('q-1')]));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.registry.entries[0]?.revision_id).toBe('rev-q-1');
      expect(parsed.registry.entries[0]?.slot_id).toBeNull();
    }
  });

  it('拒绝重复 question_id 与空 part_ids（fail-visible）', () => {
    const dup = parseRevisionRegistry(registryOf([REGISTRY_ENTRY('q-1'), REGISTRY_ENTRY('q-1')]));
    expect(dup.ok).toBe(false);
    const emptyPart = parseRevisionRegistry({
      registry_version: 1,
      generated_by: 'x',
      entries: [{ question_id: 'q-1', revision_id: 'r', part_ids: [] }],
    });
    expect(emptyPart.ok).toBe(false);
  });
});

describe('buildMigrationApplyPlan — per-category write mapping', () => {
  it('complete_attempt + registry 验证 digest → submission 链 + mapped 映射 + head', () => {
    const capture = withEvents(emptyCapture(), [COMPLETE_ATTEMPT, HEAD_JUDGE]);
    const registry = registryOf([
      REGISTRY_ENTRY('q-1', {
        slot_id: 's1',
        scoring_unit_id: 'u1',
        snapshot_digest: canonicalHash(SNAPSHOT),
      }),
    ]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry));

    const anchor = recordOf(plan, 'event:attempt:att-1');
    expect(anchor.mapping?.status).toBe('mapped');
    expect(anchor.mapping?.target_revision_id).toBe('rev-q-1');
    expect(anchor.mapping?.snapshot_digest).toBe(canonicalHash(SNAPSHOT));
    expect(anchor.submission).not.toBeNull();
    const chain = anchor.submission;
    expect(chain).toBeDefined();
    if (chain === null || chain === undefined) return;
    expect(chain.submission.idempotency_key).toBe('legacy-att-1');
    expect(chain.submission.response_set.entries[0]).toMatchObject({
      slot_id: 's1',
      kind: 'open',
      text_md: '3',
    });
    expect(chain.issuance.part_ids).toEqual(['p1']);
    expect(chain.issuance.claim_policy).toBe('unbounded');
    // 一条 judge evaluation，attempt=1，head 指向它
    expect(chain.evaluations.map((e) => e.attempt)).toEqual([1]);
    expect(chain.head.effective_evaluation_id).toBe(chain.evaluations[0]?.evaluation_id);
    expect(chain.head.generation).toBe(1);
    // 判词诚实迁移：unit_results 无 points，aggregate 显式 no_mapping
    expect(chain.evaluations[0]?.unit_results[0]).toMatchObject({
      status: 'scored',
      scoring_unit_id: 'u1',
      points_awarded: null,
    });
    expect(chain.evaluations[0]?.aggregate).toMatchObject({
      kind: 'unresolved',
      reason: 'no_mapping',
    });
    expect(chain.evaluations[0]?.provenance).toMatchObject({ source: 'automatic' });

    // judge 记录：映射行存在（镜像锚状态），但无自己的 submission
    const judge = recordOf(plan, 'event:judge:jud-1');
    expect(judge.mapping?.status).toBe('mapped');
    expect(judge.submission).toBeNull();
    expect((judge.mapping?.evidence.head_selection as string) ?? null).toBe('sole_verdict');
  });

  it('多 judge：attempt 序按 created_at，legacy newest-wins 选 head，非 head 保留为 evaluation', () => {
    const oldJudge = judgeEvent({
      id: 'jud-old',
      subject_id: 'att-1',
      created_at: '2026-09-20T10:00:03.000Z',
      payload: { coarse_outcome: 'correct', score: 1 },
    });
    const capture = withEvents(emptyCapture(), [COMPLETE_ATTEMPT, oldJudge, HEAD_JUDGE]);
    const registry = registryOf([
      REGISTRY_ENTRY('q-1', { snapshot_digest: canonicalHash(SNAPSHOT) }),
    ]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry));
    const chain = recordOf(plan, 'event:attempt:att-1').submission;
    expect(chain).toBeDefined();
    if (chain === null || chain === undefined) return;
    expect(chain.evaluations.map((e) => e.attempt)).toEqual([1, 2]);
    const headId = chain.evaluations.find(
      (e) => e.evaluation_id === chain.head.effective_evaluation_id,
    );
    expect(headId?.run_refs).toEqual(['jud-1']); // newest judge wins
    const nonHead = chain.evaluations.find((e) => e.attempt === 1);
    expect(nonHead?.run_refs).toEqual(['jud-old']);
  });

  it('registry 无 digest（断言绑定）→ mapped + registry_assertion', () => {
    const capture = withEvents(emptyCapture(), [COMPLETE_ATTEMPT, HEAD_JUDGE]);
    const registry = registryOf([REGISTRY_ENTRY('q-1')]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry));
    const anchor = recordOf(plan, 'event:attempt:att-1');
    expect(anchor.mapping?.status).toBe('mapped');
    expect(anchor.mapping?.evidence.resolution).toMatchObject({
      registry_snapshot_binding: 'registry_assertion',
    });
  });

  it('registry digest 不符 → conflicted，绝不绑定（内容漂移不补造）', () => {
    const capture = withEvents(emptyCapture(), [COMPLETE_ATTEMPT, HEAD_JUDGE]);
    const registry = registryOf([
      REGISTRY_ENTRY('q-1', { snapshot_digest: 'sha256-not-the-snapshot' }),
    ]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry));
    const anchor = recordOf(plan, 'event:attempt:att-1');
    expect(anchor.mapping?.status).toBe('conflicted');
    expect(anchor.mapping?.target_revision_id).toBeNull();
    expect(anchor.submission).toBeNull();
    expect(plan.worklists.conflicted).toHaveLength(1);
    // judge 镜像继承锚裁决：不得独立绕过 conflicted 锚拿到 target。
    const judge = recordOf(plan, 'event:judge:jud-1');
    expect(judge.mapping?.status).toBe('conflicted');
    expect(judge.mapping?.target_revision_id).toBeNull();
  });

  it('无 registry → pending，进 awaiting_revision_registry worklist，不产 submission', () => {
    const capture = withEvents(emptyCapture(), [COMPLETE_ATTEMPT, HEAD_JUDGE]);
    const plan = buildMigrationApplyPlan(planInput(capture, null));
    const anchor = recordOf(plan, 'event:attempt:att-1');
    expect(anchor.mapping?.status).toBe('pending');
    expect(anchor.mapping?.target_revision_id).toBeNull();
    expect(anchor.submission).toBeNull();
    expect(plan.worklists.awaiting_revision_registry.map((w) => w.source_locator)).toContain(
      'event:attempt:att-1',
    );
  });

  it('embedded_tutor_grade → submission + embedded evaluation + head', () => {
    const tutorAttempt = ev({
      id: 'att-tutor',
      action: 'attempt',
      subject_id: 'q-1',
      outcome: 'failure',
      payload: {
        answer_md: 'x',
        answer_image_refs: [],
        referenced_knowledge_ids: ['kc-1'],
        question_snapshot: SNAPSHOT,
        source: 'solve_tutor',
        judge_route: 'exact',
        judge_score: 0,
        judge: { route: 'exact', score: 0, coarse_outcome: 'incorrect' },
      },
    });
    const capture = withEvents(emptyCapture(), [tutorAttempt]);
    const registry = registryOf([
      REGISTRY_ENTRY('q-1', { snapshot_digest: canonicalHash(SNAPSHOT) }),
    ]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry));
    const anchor = recordOf(plan, 'event:attempt:att-tutor');
    expect(anchor.mapping?.status).toBe('mapped');
    const chain = anchor.submission;
    expect(chain).toBeDefined();
    if (chain === null || chain === undefined) return;
    expect(chain.evaluations).toHaveLength(1);
    expect(chain.evaluations[0]?.provenance).toMatchObject({ migrated: { embedded: true } });
    expect(chain.head.effective_evaluation_id).toBe(chain.evaluations[0]?.evaluation_id);
  });

  it('durable 回填 review（embedded judge 块）→ complete_attempt + sole_verdict head', () => {
    const pending = durablePendingEvent({
      id: 'run-9',
      runId: 'run-9',
      questionId: 'q-1',
      responseMd: '2',
    });
    const review = answeredReviewEvent({ id: 'run-9', questionId: 'q-1', responseMd: '2' });
    const capture = withEvents(emptyCapture(), [pending, review]);
    const registry = registryOf([
      REGISTRY_ENTRY('q-1', { snapshot_digest: canonicalHash(FROZEN_DURABLE_SNAPSHOT) }),
    ]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry));
    const anchor = recordOf(plan, 'event:review:run-9');
    expect(anchor.classification.category).toBe('complete_attempt');
    expect(anchor.mapping?.status).toBe('mapped');
    const chain = anchor.submission;
    expect(chain).toBeDefined();
    if (chain === null || chain === undefined) return;
    expect(chain.submission.response_set.entries[0]).toMatchObject({ text_md: '2' });
    expect(chain.evaluations[0]?.provenance).toMatchObject({ migrated: { embedded: true } });
    expect(chain.head.effective_evaluation_id).toBe(chain.evaluations[0]?.evaluation_id);
  });

  it('attribution_only → 映射行（registry 规则），无 submission/evaluation', () => {
    const attributionJudge = judgeEvent({
      id: 'jud-attr',
      subject_id: 'att-1',
      payload: { cause: 'kc-fluency' },
    });
    const capture = withEvents(emptyCapture(), [COMPLETE_ATTEMPT, attributionJudge]);
    const registry = registryOf([REGISTRY_ENTRY('q-1')]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry));
    const attr = recordOf(plan, 'event:judge:jud-attr');
    expect(attr.classification.category).toBe('attribution_only');
    expect(attr.mapping?.status).toBe('mapped');
    expect(attr.mapping?.evidence.attribution_only).toBe(true);
    expect(attr.submission).toBeNull();
  });

  it('human_import_assertion → 断言进 evidence，无 evaluation（归因不是分数）', () => {
    const manualAttempt = ev({
      id: 'att-manual',
      action: 'attempt',
      subject_id: 'q-2',
      outcome: 'failure',
      payload: {
        answer_md: '5',
        answer_image_refs: [],
        referenced_knowledge_ids: ['kc-1'],
        question_snapshot: { ...SNAPSHOT, question: { ...SNAPSHOT.question, question_id: 'q-2' } },
        generated_by: 'manual-import',
      },
    });
    const capture = withEvents(emptyCapture(), [manualAttempt]);
    const registry = registryOf([REGISTRY_ENTRY('q-2')]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry));
    const rec = recordOf(plan, 'event:attempt:att-manual');
    expect(rec.classification.category).toBe('human_import_assertion');
    expect(rec.mapping?.status).toBe('mapped');
    expect(rec.mapping?.evidence.manual_assertion).toBe('import');
    expect(rec.submission).toBeNull();
  });

  it('pending_blocked（unbackfilled durable run）→ pending 映射 + PendingState + run_id + response digest', () => {
    const pending = durablePendingEvent({
      id: 'pend-1',
      runId: 'run-unbackfilled',
      questionId: 'q-1',
      responseMd: 'my answer',
    });
    const capture = withEvents(emptyCapture(), [pending]);
    const plan = buildMigrationApplyPlan(planInput(capture, null));
    const rec = recordOf(plan, 'event:experimental:judge_pending_attempt:pend-1');
    expect(rec.classification.category).toBe('pending_blocked');
    expect(rec.mapping?.status).toBe('pending');
    expect(rec.mapping?.evidence.pending).toMatchObject({
      reason: 'infra_failure',
      retryable: true,
    });
    expect(rec.mapping?.evidence.run_id).toBe('run-unbackfilled');
    expect(rec.mapping?.evidence.response_digest).toBe(
      responseDigestOf({ response_md: 'my answer', image_refs: [] }),
    );
    expect(rec.submission).toBeNull();
  });

  it('historical_unresolved（solo answer-bearing review）→ historical_unresolved 映射，无目标', () => {
    const review = answeredReviewEvent({ id: 'rev-solo', questionId: 'q-1', responseMd: '2' });
    const capture = withEvents(emptyCapture(), [review]);
    const registry = registryOf([REGISTRY_ENTRY('q-1')]); // 即使 registry 有绑定也不补造
    const plan = buildMigrationApplyPlan(planInput(capture, registry));
    const rec = recordOf(plan, 'event:review:rev-solo');
    expect(rec.classification.category).toBe('historical_unresolved');
    expect(rec.mapping?.status).toBe('historical_unresolved');
    expect(rec.mapping?.target_revision_id).toBeNull();
    expect(rec.mapping?.evidence.historical_unknown).toMatchObject({
      record_kind: 'historical_unknown',
    });
    expect(rec.submission).toBeNull();
    expect(plan.worklists.unresolved.length).toBeGreaterThan(0);
  });

  it('correction_cycle → conflicted 映射 + deferred_replay worklist', () => {
    const correct = ev({
      id: 'cor-1',
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'jud-1',
      payload: { replacement_event_id: 'jud-2' },
    });
    const judge2 = judgeEvent({
      id: 'jud-2',
      subject_id: 'att-1',
      payload: { coarse_outcome: 'correct', score: 1 },
    });
    const capture = withEvents(emptyCapture(), [COMPLETE_ATTEMPT, HEAD_JUDGE, judge2, correct]);
    const registry = registryOf([REGISTRY_ENTRY('q-1')]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry));
    for (const locator of ['event:attempt:att-1', 'event:judge:jud-1', 'event:judge:jud-2']) {
      const rec = recordOf(plan, locator);
      expect(rec.classification.category, `${locator} 应在纠正闭包内`).toBe(
        'correction_cycle_unresolved',
      );
      expect(rec.mapping?.status).toBe('conflicted');
      expect(rec.submission).toBeNull();
    }
    expect(plan.worklists.deferred_replay.length).toBeGreaterThan(0);
  });

  it('lineage-only 类别（fsrs review / live draft / causal closure）→ 无映射行', () => {
    const ratingReview = ev({
      id: 'rev-rating',
      action: 'review',
      subject_id: 'q-1',
      outcome: 'success',
      payload: { fsrs_rating: 'good', referenced_knowledge_ids: ['kc-1'] },
    });
    const strayEvent = ev({
      id: 'stray-1',
      action: 'knowledge_rename',
      subject_kind: 'knowledge',
      subject_id: 'kc-1',
    });
    const capture = withEvents(emptyCapture(), [ratingReview, strayEvent]);
    capture.rawFacts.answers.push({
      id: 'ans-draft',
      question_id: 'q-1',
      learning_item_id: null,
      input_kind: 'text',
      content_md: 'draft',
      image_refs: [],
      vision_extracted: null,
      tags: [],
      submitted_at: null,
      session_id: null,
      paper_artifact_id: null,
      part_ref: null,
      event_id: null,
    });
    const plan = buildMigrationApplyPlan(planInput(capture, null));
    expect(recordOf(plan, 'event:review:rev-rating').mapping).toBeNull();
    expect(recordOf(plan, 'event:knowledge_rename:stray-1').mapping).toBeNull();
    expect(recordOf(plan, 'answer:ans-draft').mapping).toBeNull();
    expect(plan.rollup.mapping_status.pending + plan.rollup.mapping_status.mapped).toBe(0);
  });

  it('frozen answer 镜像锚分类：映射行独立 locator，无重复 submission', () => {
    const capture = withEvents(emptyCapture(), [COMPLETE_ATTEMPT, HEAD_JUDGE]);
    capture.rawFacts.answers.push({
      id: 'ans-1',
      question_id: 'q-1',
      learning_item_id: null,
      input_kind: 'text',
      content_md: '3',
      image_refs: [],
      vision_extracted: null,
      tags: [],
      submitted_at: '2026-09-20T10:00:00.000Z',
      session_id: null,
      paper_artifact_id: null,
      part_ref: null,
      event_id: 'att-1',
    });
    const registry = registryOf([
      REGISTRY_ENTRY('q-1', { snapshot_digest: canonicalHash(SNAPSHOT) }),
    ]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry));
    const mirror = recordOf(plan, 'answer:ans-1');
    expect(mirror.classification.category).toBe('complete_attempt');
    expect(mirror.mapping?.status).toBe('mapped');
    expect(mirror.mapping?.legacy_part_ref).toBeNull();
    expect(mirror.submission).toBeNull(); // submission 属于锚记录，绝不重复
    expect(plan.rollup.totals.submissions).toBe(1);
  });
});

describe('determinism / idempotency 基座', () => {
  const capture = withEvents(emptyCapture(), [COMPLETE_ATTEMPT, HEAD_JUDGE]);
  const registry = registryOf([
    REGISTRY_ENTRY('q-1', { snapshot_digest: canonicalHash(SNAPSHOT) }),
  ]);

  it('同输入 → 逐字节相同 plan digest 与相同 id', () => {
    const a = buildMigrationApplyPlan(planInput(capture, registry));
    const b = buildMigrationApplyPlan(planInput(capture, registry));
    expect(planDigestOf(a)).toBe(planDigestOf(b));
    expect(a.records.map((r) => r.mapping?.mapping_id)).toEqual(
      b.records.map((r) => r.mapping?.mapping_id),
    );
    const submissionA = a.records.find((r) => r.submission != null)?.submission;
    const submissionB = b.records.find((r) => r.submission != null)?.submission;
    expect(submissionA?.submission.submission_id).toBe(submissionB?.submission.submission_id);
  });

  it('registry 变化 → 不同 run id / plan digest（不吞掉语料导入变化）', () => {
    const withRegistry = buildMigrationApplyPlan(planInput(capture, registry));
    const without = buildMigrationApplyPlan(planInput(capture, null));
    expect(registryDigestOf(registry)).not.toBe(registryDigestOf(null));
    expect(planDigestOf(withRegistry)).not.toBe(planDigestOf(without));
    expect(
      applyRunIdOf({
        checkpoint_hash: 'chk',
        classification_hash: 'cls',
        registry_digest: registryDigestOf(registry),
      }),
    ).not.toBe(
      applyRunIdOf({ checkpoint_hash: 'chk', classification_hash: 'cls', registry_digest: null }),
    );
  });

  it('rollup 计数与记录一致', () => {
    const plan = buildMigrationApplyPlan(planInput(capture, registry));
    const sum = Object.values(plan.rollup.per_category).reduce((acc, b) => acc + b.records, 0);
    expect(sum).toBe(plan.records.length);
    expect(plan.algorithm_version).toBe(APPLY_ALGORITHM_VERSION);
  });
});
