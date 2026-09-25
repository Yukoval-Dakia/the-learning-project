import { describe, expect, it } from 'vitest';
import type { PublishedQuestionRevisionT } from '../schema/assessment';
import { AttemptQuestionSnapshot } from '../schema/question-evidence-snapshot';
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

// YUK-1050（review 修订版）— apply 纯规划器单元测试：registry v2 解析
//（snapshot_verified/question_asserted）、revision 契约驱动的忠实重建与
// 显式降级、pending 恢复信封、live_draft 处置、确定性 digest。
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

/** 五层契约 fixture（open_response 单槽 + rule_reference 单元，发布校验可过）。 */
function contractOf(
  revisionId: string,
  overrides: {
    slotKind?: 'open_response' | 'text' | 'single_choice';
    materials?: PublishedQuestionRevisionT['structure']['materials'];
  } = {},
): PublishedQuestionRevisionT {
  const groupId = `grp-${revisionId}`;
  const slotKind = overrides.slotKind ?? 'open_response';
  const slot =
    slotKind === 'single_choice'
      ? {
          slot_id: 's1',
          part_id: 'p1',
          kind: 'single_choice' as const,
          options: [
            { option_id: 'opt-1', label: 'A', text: 'A' },
            { option_id: 'opt-2', label: 'B', text: 'B' },
          ],
        }
      : slotKind === 'text'
        ? { slot_id: 's1', part_id: 'p1', kind: 'text' as const, math_preview: false }
        : {
            slot_id: 's1',
            part_id: 'p1',
            kind: 'open_response' as const,
            accepted_evidence: [],
            evidence_required: false,
          };
  return {
    revision_id: revisionId,
    group_id: groupId,
    revision_ordinal: 1,
    integrity_digest: canonicalHash({ revision: revisionId }),
    structure: {
      group_id: groupId,
      materials: overrides.materials ?? [],
      parts: [{ part_id: 'p1', prompt_md: '1+1=?', material_ids: [] }],
    },
    response_spec: { slots: [slot] },
    scoring_basis: {
      units: [
        {
          scoring_unit_id: 'u1',
          slot_refs: ['s1'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: {
            kind: 'rule_reference',
            rule_id: 'legacy-import',
            statement_md: 'historical import',
            source: 'manual',
          },
          points: 1,
        },
      ],
      aggregation: { kind: 'sum' },
      blank_scores_zero: false,
    },
    execution_plan: {
      plan_version: 1,
      assignments: [{ scoring_unit_ids: ['u1'], executor: { kind: 'human_review' } }],
      escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'human_review' },
    },
    published_at: '2026-09-01T00:00:00.000Z',
    supersedes_revision_id: null,
  };
}

function planInput(
  capture: MigrationCapture,
  registry: RevisionRegistry | null = null,
  contracts: Map<string, PublishedQuestionRevisionT> = new Map(),
): BuildApplyPlanInput {
  return {
    capture,
    classification: classify(capture),
    checkpoint_hash: 'chk-test',
    registry,
    revisionContracts: contracts,
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
  slot_id: 's1',
  scoring_unit_id: 'u1',
  binding_kind: 'snapshot_verified',
  snapshot_digest: canonicalHash(SNAPSHOT),
  assertion_reason: null,
  published_at: '2026-09-01T00:00:00.000Z',
  ...overrides,
});

function registryOf(entries: RevisionRegistryEntry[]): RevisionRegistry {
  return { registry_version: 2 as const, generated_by: 'test-corpus-import', entries };
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

describe('parseRevisionRegistry — v2', () => {
  it('接受合法 v2 registry 并保留 binding_kind/断言字段', () => {
    const parsed = parseRevisionRegistry(
      registryOf([
        REGISTRY_ENTRY('q-1'),
        REGISTRY_ENTRY('q-2', {
          revision_id: 'rev-q-2-alt',
          binding_kind: 'question_asserted',
          snapshot_digest: null,
          assertion_reason: '历史导出无冻结快照，语料导入方显式断言同版',
        }),
      ]),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.registry.entries[0]?.binding_kind).toBe('snapshot_verified');
      expect(parsed.registry.entries[1]?.assertion_reason).toContain('断言');
    }
  });

  it('拒绝 v1、无 digest 的 snapshot_verified、无理由断言、同题重复断言与同 digest 歧义', () => {
    expect(parseRevisionRegistry({ registry_version: 1, generated_by: 'x', entries: [] }).ok).toBe(
      false,
    );
    expect(
      parseRevisionRegistry({
        registry_version: 2,
        generated_by: 'x',
        entries: [
          {
            question_id: 'q',
            revision_id: 'r',
            part_ids: ['p1'],
            slot_id: 's',
            scoring_unit_id: 'u',
            binding_kind: 'snapshot_verified',
          },
        ],
      }).ok,
    ).toBe(false);
    expect(
      parseRevisionRegistry({
        registry_version: 2,
        generated_by: 'x',
        entries: [
          {
            question_id: 'q',
            revision_id: 'r',
            part_ids: ['p1'],
            slot_id: 's',
            scoring_unit_id: 'u',
            binding_kind: 'question_asserted',
          },
        ],
      }).ok,
    ).toBe(false);
    const dupAssertion = parseRevisionRegistry(
      registryOf([
        REGISTRY_ENTRY('q-1', {
          binding_kind: 'question_asserted',
          snapshot_digest: null,
          assertion_reason: 'a',
        }),
        REGISTRY_ENTRY('q-1', {
          revision_id: 'rev-q-1-b',
          binding_kind: 'question_asserted',
          snapshot_digest: null,
          assertion_reason: 'b',
        }),
      ]),
    );
    expect(dupAssertion.ok).toBe(false);
    const sameDigestTwice = parseRevisionRegistry(
      registryOf([REGISTRY_ENTRY('q-1'), REGISTRY_ENTRY('q-1', { revision_id: 'rev-q-1-b' })]),
    );
    expect(sameDigestTwice.ok).toBe(false);
  });

  it('同一 question 允许多个历史版本绑定（不同 snapshot_digest → 不同 revision）', () => {
    const parsed = parseRevisionRegistry(
      registryOf([
        REGISTRY_ENTRY('q-1'),
        REGISTRY_ENTRY('q-1', {
          revision_id: 'rev-q-1-v2',
          snapshot_digest: canonicalHash({
            ...SNAPSHOT,
            question: { ...SNAPSHOT.question, prompt_md: '2+2=?' },
          }),
        }),
      ]),
    );
    expect(parsed.ok).toBe(true);
  });
});

describe('buildMigrationApplyPlan — per-category write mapping', () => {
  it('complete_attempt + digest 验证 + 契约可忠实重建 → submission 链 + mapped 映射', () => {
    const capture = withEvents(emptyCapture(), [COMPLETE_ATTEMPT, HEAD_JUDGE]);
    const registry = registryOf([REGISTRY_ENTRY('q-1')]);
    const contracts = new Map([['rev-q-1', contractOf('rev-q-1')]]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry, contracts));

    const anchor = recordOf(plan, 'event:attempt:att-1');
    expect(anchor.mapping?.status).toBe('mapped');
    expect(anchor.mapping?.target_revision_id).toBe('rev-q-1');
    expect(anchor.mapping?.target_part_id).toBe('p1');
    expect(anchor.mapping?.target_slot_id).toBe('s1');
    expect(anchor.mapping?.snapshot_digest).toBe(canonicalHash(SNAPSHOT));
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
    // 判词只作 legacy 证据：unit 显式 pending（无获准 points 映射），aggregate
    // unresolved/pending_units —— 不造假分也不冒充 no_mapping。
    expect(chain.evaluations).toHaveLength(1);
    expect(chain.evaluations[0]?.unit_results[0]).toMatchObject({
      status: 'pending',
      scoring_unit_id: 'u1',
      pending: { reason: 'needs_review', trigger: 'flagged' },
    });
    expect(chain.evaluations[0]?.aggregate).toMatchObject({
      kind: 'unresolved',
      reason: 'pending_units',
    });
    expect(chain.evaluations[0]?.provenance).toMatchObject({
      source: 'automatic',
      migrated: { assisted: 'unknown' },
    });
    // P1-5（终裁）：legacy effective head 被保存 —— head 指向被导入的 head
    // evaluation（generation=1，历史生效事实，非激活：无 settlement/FSRS）。
    expect(chain.head.effective_evaluation_id).toBe(chain.evaluations[0]?.evaluation_id);
    expect(chain.head.generation).toBe(1);
    expect(anchor.mapping?.evidence.legacy_effective_truth).toMatchObject({
      head_selection: 'sole_verdict',
      judge_event_id: 'jud-1',
    });

    // judge 镜像：继承锚裁决，无独立 submission。
    const judge = recordOf(plan, 'event:judge:jud-1');
    expect(judge.mapping?.status).toBe('mapped');
    expect(judge.submission).toBeNull();
  });

  it('多 judge：attempt 序按 created_at，legacy newest-wins 记入 evidence，非 head 保留为 evaluation', () => {
    const oldJudge = judgeEvent({
      id: 'jud-old',
      subject_id: 'att-1',
      created_at: '2026-09-20T10:00:03.000Z',
      payload: { coarse_outcome: 'correct', score: 1 },
    });
    const capture = withEvents(emptyCapture(), [COMPLETE_ATTEMPT, oldJudge, HEAD_JUDGE]);
    const registry = registryOf([REGISTRY_ENTRY('q-1')]);
    const contracts = new Map([['rev-q-1', contractOf('rev-q-1')]]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry, contracts));
    const chain = recordOf(plan, 'event:attempt:att-1').submission;
    expect(chain).toBeDefined();
    if (chain === null || chain === undefined) return;
    expect(chain.evaluations.map((e) => e.attempt)).toEqual([1, 2]);
    const headEval = chain.evaluations.find((e) => e.run_refs[0] === 'jud-1');
    expect(headEval?.provenance).toMatchObject({ migrated: { is_legacy_effective_head: true } });
    const nonHead = chain.evaluations.find((e) => e.run_refs[0] === 'jud-old');
    expect(nonHead?.provenance).toMatchObject({ migrated: { is_legacy_effective_head: false } });
  });

  it('question_asserted 绑定：显式断言入 evidence，可审计', () => {
    const capture = withEvents(emptyCapture(), [COMPLETE_ATTEMPT, HEAD_JUDGE]);
    const registry = registryOf([
      REGISTRY_ENTRY('q-1', {
        binding_kind: 'question_asserted',
        snapshot_digest: null,
        assertion_reason: '语料导入方核对后断言当前 revision 即当时所见',
      }),
    ]);
    const contracts = new Map([['rev-q-1', contractOf('rev-q-1')]]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry, contracts));
    const anchor = recordOf(plan, 'event:attempt:att-1');
    expect(anchor.mapping?.status).toBe('mapped');
    expect(anchor.mapping?.evidence.registry_assertion).toMatchObject({
      asserted_by: 'test-corpus-import',
    });
    expect(anchor.mapping?.evidence.resolution).toMatchObject({ binding: 'question_asserted' });
  });

  it('digest 与全部 snapshot_verified 绑定不符 → conflicted（内容漂移不绑定），judge 镜像继承', () => {
    const capture = withEvents(emptyCapture(), [COMPLETE_ATTEMPT, HEAD_JUDGE]);
    const registry = registryOf([
      REGISTRY_ENTRY('q-1', { snapshot_digest: 'sha256-not-the-snapshot' }),
    ]);
    const contracts = new Map([['rev-q-1', contractOf('rev-q-1')]]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry, contracts));
    const anchor = recordOf(plan, 'event:attempt:att-1');
    expect(anchor.mapping?.status).toBe('conflicted');
    expect(anchor.mapping?.target_revision_id).toBeNull();
    expect(anchor.submission).toBeNull();
    expect(plan.worklists.conflicted.length).toBeGreaterThan(0);
    const judge = recordOf(plan, 'event:judge:jud-1');
    expect(judge.mapping?.status).toBe('conflicted');
    expect(judge.mapping?.target_revision_id).toBeNull();
  });

  it('同题多版本：不同冻结 snapshot 各自命中自己的 snapshot_verified 绑定', () => {
    const v2Snapshot = { ...SNAPSHOT, question: { ...SNAPSHOT.question, prompt_md: '2+2=?' } };
    const attemptV2 = ev({
      id: 'att-v2',
      action: 'attempt',
      subject_id: 'q-1',
      outcome: 'failure',
      payload: {
        answer_md: '4',
        answer_image_refs: [],
        referenced_knowledge_ids: ['kc-1'],
        question_snapshot: v2Snapshot,
      },
    });
    const judgeV2 = judgeEvent({
      id: 'jud-v2',
      subject_id: 'att-v2',
      payload: { coarse_outcome: 'correct', score: 1 },
    });
    const capture = withEvents(emptyCapture(), [COMPLETE_ATTEMPT, HEAD_JUDGE, attemptV2, judgeV2]);
    const registry = registryOf([
      REGISTRY_ENTRY('q-1'),
      REGISTRY_ENTRY('q-1', {
        revision_id: 'rev-q-1-v2',
        snapshot_digest: canonicalHash(v2Snapshot),
      }),
    ]);
    const contracts = new Map([
      ['rev-q-1', contractOf('rev-q-1')],
      // v2 契约的题干必须与 v2 冻结 snapshot 一致（P1-2：digest_verified
      // 需目标 revision 内容可由 snapshot 机械推导，否则降级 conflicted）。
      [
        'rev-q-1-v2',
        (() => {
          const c = contractOf('rev-q-1-v2');
          c.structure = {
            ...c.structure,
            parts: [{ ...c.structure.parts[0]!, prompt_md: '2+2=?' }],
          };
          return c;
        })(),
      ],
    ]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry, contracts));
    expect(recordOf(plan, 'event:attempt:att-1').mapping?.target_revision_id).toBe('rev-q-1');
    expect(recordOf(plan, 'event:attempt:att-v2').mapping?.target_revision_id).toBe('rev-q-1-v2');
    expect(plan.rollup.totals.submissions).toBe(2);
  });

  it('无 registry → pending + awaiting worklist，不产 submission', () => {
    const capture = withEvents(emptyCapture(), [COMPLETE_ATTEMPT, HEAD_JUDGE]);
    const plan = buildMigrationApplyPlan(planInput(capture, null));
    const anchor = recordOf(plan, 'event:attempt:att-1');
    expect(anchor.mapping?.status).toBe('pending');
    expect(anchor.mapping?.target_revision_id).toBeNull();
    expect(anchor.submission).toBeNull();
    expect(plan.worklists.awaiting_revision_registry.map((w) => w.source_locator)).toContain(
      'event:attempt:att-1',
    );
    expect(plan.worklists.awaiting_revision_registry[0]?.reason).toBeTruthy();
  });

  it('embedded_tutor_grade → submission + embedded evaluation（verdict 为 legacy 证据）', () => {
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
    const registry = registryOf([REGISTRY_ENTRY('q-1')]);
    const contracts = new Map([['rev-q-1', contractOf('rev-q-1')]]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry, contracts));
    const anchor = recordOf(plan, 'event:attempt:att-tutor');
    expect(anchor.mapping?.status).toBe('mapped');
    const chain = anchor.submission;
    expect(chain).toBeDefined();
    if (chain === null || chain === undefined) return;
    expect(chain.evaluations).toHaveLength(1);
    expect(chain.evaluations[0]?.provenance).toMatchObject({ migrated: { embedded: true } });
    // embedded 判词 = legacy effective truth：head 指向导入的 embedded evaluation。
    expect(chain.head.effective_evaluation_id).toBe(chain.evaluations[0]?.evaluation_id);
    expect(chain.head.generation).toBe(1);
  });

  it('durable 回填 review（embedded judge 块）→ complete_attempt + 冻结 submit 输入', () => {
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
    const contracts = new Map([['rev-q-1', contractOf('rev-q-1')]]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry, contracts));
    const anchor = recordOf(plan, 'event:review:run-9');
    expect(anchor.classification.category).toBe('complete_attempt');
    expect(anchor.mapping?.status).toBe('mapped');
    const chain = anchor.submission;
    expect(chain).toBeDefined();
    if (chain === null || chain === undefined) return;
    expect(chain.submission.response_set.entries[0]).toMatchObject({ text_md: '2' });
    expect(chain.evaluations[0]?.provenance).toMatchObject({ migrated: { embedded: true } });
  });

  it('choice 槽契约：legacy 自由文本不能伪造选项身份 → 显式 reconstruction_blocked，不产冻结 submission', () => {
    // snapshot 携带与契约一致的选项（否则在绑定验证阶段就被 conflicted 拦下，
    // 到不了 reconstruction 判定）：断言 response 文本不能映射到选项身份。
    const choiceSnapshot = AttemptQuestionSnapshot.parse({
      schema_version: 1,
      question: {
        ...SNAPSHOT.question,
        choices_md: ['A', 'B'],
      },
      parent_question: null,
    });
    const attempt = ev({
      id: 'att-1',
      action: 'attempt',
      subject_id: 'q-1',
      outcome: 'failure',
      created_at: '2026-09-20T10:00:00.000Z',
      payload: {
        answer_md: '3',
        answer_image_refs: [],
        referenced_knowledge_ids: ['kc-1'],
        question_snapshot: choiceSnapshot,
      },
    });
    const capture = withEvents(emptyCapture(), [attempt, HEAD_JUDGE]);
    const registry = registryOf([
      REGISTRY_ENTRY('q-1', { snapshot_digest: canonicalHash(choiceSnapshot) }),
    ]);
    const contracts = new Map([['rev-q-1', contractOf('rev-q-1', { slotKind: 'single_choice' })]]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry, contracts));
    const anchor = recordOf(plan, 'event:attempt:att-1');
    expect(anchor.mapping?.status).toBe('historical_unresolved');
    expect(anchor.mapping?.target_revision_id).toBeNull();
    expect(anchor.submission).toBeNull();
    expect(String(anchor.mapping?.evidence.reconstruction_blocked)).toMatch(/single_choice/);
    expect(plan.worklists.reconstruction_blocked.map((w) => w.source_locator)).toContain(
      'event:attempt:att-1',
    );
    const judge = recordOf(plan, 'event:judge:jud-1');
    expect(judge.mapping?.status).toBe('historical_unresolved');
  });

  it('契约缺失（registry 指向未装载的 revision）→ conflicted 降级，不产看似正常的 submission', () => {
    const capture = withEvents(emptyCapture(), [COMPLETE_ATTEMPT, HEAD_JUDGE]);
    const registry = registryOf([REGISTRY_ENTRY('q-1')]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry, new Map()));
    const anchor = recordOf(plan, 'event:attempt:att-1');
    // P1-2（终轮）：registry 绑定了 revision 但契约未装载 = 语料/绑定缺陷，
    // 显式 conflicted（可见可修），不是「无上下文」的 historical_unresolved。
    expect(anchor.mapping?.status).toBe('conflicted');
    expect(anchor.submission).toBeNull();
    expect(plan.worklists.conflicted.map((w) => w.source_locator)).toContain('event:attempt:att-1');
  });

  it('图片作答：source_asset 元数据齐备 → 原生 EvidenceAttachment 保留；元数据缺失 → D5 拒绝降级', () => {
    const attemptWithImage = ev({
      id: 'att-img',
      action: 'attempt',
      subject_id: 'q-1',
      outcome: 'failure',
      payload: {
        answer_md: '手写过程',
        answer_image_refs: ['asset-1'],
        referenced_knowledge_ids: ['kc-1'],
        question_snapshot: SNAPSHOT,
      },
    });
    const judgeImg = judgeEvent({
      id: 'jud-img',
      subject_id: 'att-img',
      payload: { coarse_outcome: 'partial', score: 0.5 },
    });
    const capture = withEvents(emptyCapture(), [attemptWithImage, judgeImg]);
    capture.rawFacts.source_assets.push({
      id: 'asset-1',
      kind: 'image',
      storage_key: 'answers/asset-1.png',
      mime_type: 'image/png',
      byte_size: 1234,
      sha256: 'a'.repeat(64),
      created_at: '2026-09-20T09:59:00.000Z',
    });
    const registry = registryOf([REGISTRY_ENTRY('q-1')]);
    const contracts = new Map([['rev-q-1', contractOf('rev-q-1')]]);

    const plan = buildMigrationApplyPlan(planInput(capture, registry, contracts));
    const chainOk = recordOf(plan, 'event:attempt:att-img').submission;
    expect(chainOk).toBeDefined();
    const entry = chainOk?.submission.response_set.entries[0];
    expect(entry).toMatchObject({ kind: 'open', text_md: '手写过程' });
    if (entry !== undefined && entry.kind === 'open') {
      expect(entry.evidence[0]).toMatchObject({
        evidence_id: 'legacy-asset-1',
        kind: 'image',
        mime_type: 'image/png',
        bytes: 1234,
        asset: { asset_id: 'asset-1', digest: 'a'.repeat(64) },
      });
    }

    // 元数据缺失（asset 不在 capture source_assets）：D5 零丢失 → 拒绝降级。
    const captureNoAsset = withEvents(emptyCapture(), [attemptWithImage, judgeImg]);
    const planNoAsset = buildMigrationApplyPlan(planInput(captureNoAsset, registry, contracts));
    const degraded = recordOf(planNoAsset, 'event:attempt:att-img');
    expect(degraded.mapping?.status).toBe('historical_unresolved');
    expect(String(degraded.mapping?.evidence.reconstruction_blocked)).toMatch(/asset-1/);
  });

  it('attribution_only → 映射行（registry 规则），无 submission/evaluation', () => {
    const attributionJudge = judgeEvent({
      id: 'jud-attr',
      subject_id: 'att-1',
      payload: { cause: 'kc-fluency' },
    });
    const capture = withEvents(emptyCapture(), [COMPLETE_ATTEMPT, attributionJudge]);
    const registry = registryOf([REGISTRY_ENTRY('q-1')]);
    const contracts = new Map([['rev-q-1', contractOf('rev-q-1')]]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry, contracts));
    const attr = recordOf(plan, 'event:judge:jud-attr');
    expect(attr.classification.category).toBe('attribution_only');
    // digest_verified 继承镜像：锚内容已验过，镜像无自身 snapshot，不重复验证。
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
    const q2Snapshot = { ...SNAPSHOT, question: { ...SNAPSHOT.question, question_id: 'q-2' } };
    const capture = withEvents(emptyCapture(), [manualAttempt]);
    const registry = registryOf([
      REGISTRY_ENTRY('q-2', { snapshot_digest: canonicalHash(q2Snapshot) }),
    ]);
    const contracts = new Map([['rev-q-2', contractOf('rev-q-2')]]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry, contracts));
    const rec = recordOf(plan, 'event:attempt:att-manual');
    expect(rec.classification.category).toBe('human_import_assertion');
    expect(rec.mapping?.status).toBe('mapped');
    expect(rec.mapping?.evidence.manual_assertion).toBe('import');
    expect(rec.submission).toBeNull();
  });

  it('pending_blocked（unbackfilled durable run）→ pending 映射 + 恢复信封（run/冻结请求/送达处置）', () => {
    const pending = durablePendingEvent({
      id: 'pend-1',
      runId: 'run-unbackfilled',
      questionId: 'q-1',
      responseMd: 'my answer',
    });
    const capture = withEvents(emptyCapture(), [pending]);
    capture.queues.push({ name: 'judge_run', state: 'active', count: 2 });
    const plan = buildMigrationApplyPlan(planInput(capture, null));
    const rec = recordOf(plan, 'event:experimental:judge_pending_attempt:pend-1');
    expect(rec.classification.category).toBe('pending_blocked');
    expect(rec.mapping?.status).toBe('pending');
    expect(rec.mapping?.evidence.pending).toMatchObject({
      reason: 'infra_failure',
      retryable: true,
    });
    const envelope = rec.mapping?.evidence.pending_recovery as Record<string, unknown> | undefined;
    expect(envelope).toBeDefined();
    expect(envelope?.run_id).toBe('run-unbackfilled');
    expect(envelope?.eval_generation).toBeNull(); // unbackfilled run：显式未知，不猜 0
    expect(envelope?.delivery_disposition).toMatchObject({
      run_status: 'unbackfilled',
    });
    expect(envelope?.queue_observation_at_capture).toEqual([{ state: 'active', count: 2 }]);
    // frozen_request = pending 事件的 submit 块【逐字】（body/question_id/
    // subject_profile/question_snapshot/ability/submitted_at 全量契约面），
    // payload 级 knowledge_ids/ability_global_ids 随信封保留（终轮 P1-4）。
    expect(envelope?.frozen_request).toEqual({
      body: { response_md: 'my answer' },
      question_id: 'q-1',
      subject_profile: { learner_id: 'learner-1', locale: 'zh' },
      ability_global_by_knowledge_id: { 'kc-1': 'ag-1' },
      submitted_at: '2026-09-20T00:00:00.000Z',
      question_snapshot: { ...FROZEN_DURABLE_SNAPSHOT },
    });
    expect(envelope?.knowledge_ids).toEqual(['kc-1']);
    expect(envelope?.ability_global_ids).toEqual(['ag-1']);
    expect(rec.mapping?.evidence.response_digest).toBe(
      responseDigestOf({
        question_id: 'q-1',
        submitted_at: '2026-09-20T00:00:00.000Z',
        response_md: 'my answer',
        image_refs: [],
      }),
    );
    expect(rec.submission).toBeNull();
  });

  it('durable pending 的图片在 submit.body.answer_image_refs（P1-7 路径修正）并计入 digest', () => {
    const pending = durablePendingEvent({
      id: 'pend-img',
      runId: 'run-img',
      questionId: 'q-1',
      responseMd: 'photo answer',
    });
    // body 层补 answer_image_refs（CreateAttemptBody 真实位置）。
    const event = pending as { payload: { submit: { body: Record<string, unknown> } } };
    event.payload.submit.body.answer_image_refs = ['asset-9'];
    const capture = withEvents(emptyCapture(), [pending]);
    const plan = buildMigrationApplyPlan(planInput(capture, null));
    const rec = recordOf(plan, 'event:experimental:judge_pending_attempt:pend-img');
    const envelope = rec.mapping?.evidence.pending_recovery as
      | { frozen_request?: { body?: { answer_image_refs?: string[] } } }
      | undefined;
    expect(envelope?.frozen_request?.body?.answer_image_refs).toEqual(['asset-9']);
    expect(rec.mapping?.evidence.response_digest).toBe(
      responseDigestOf({
        question_id: 'q-1',
        submitted_at: '2026-09-20T00:00:00.000Z',
        response_md: 'photo answer',
        image_refs: ['asset-9'],
      }),
    );
  });

  it('historical_unresolved（solo answer-bearing review）→ historical_unresolved 映射，无目标', () => {
    const review = answeredReviewEvent({ id: 'rev-solo', questionId: 'q-1', responseMd: '2' });
    const capture = withEvents(emptyCapture(), [review]);
    const registry = registryOf([REGISTRY_ENTRY('q-1')]); // 即使 registry 有绑定也不补造
    const contracts = new Map([['rev-q-1', contractOf('rev-q-1')]]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry, contracts));
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
    const contracts = new Map([['rev-q-1', contractOf('rev-q-1')]]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry, contracts));
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

  it('lineage-only 类别 → 无映射行；live_draft 有显式处置 worklist', () => {
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
    expect(plan.worklists.live_drafts).toEqual([
      {
        source_locator: 'answer:ans-draft',
        question_id: 'q-1',
        answer_id: 'ans-draft',
        disposition: 'preserved-in-legacy-awaiting-autosave-migration',
      },
    ]);
  });

  it('frozen answer 镜像锚分类：映射行独立 locator，无重复 submission；part_ref 命中绑定 part', () => {
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
      part_ref: 'p1',
      event_id: 'att-1',
    });
    const registry = registryOf([REGISTRY_ENTRY('q-1')]);
    const contracts = new Map([['rev-q-1', contractOf('rev-q-1')]]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry, contracts));
    const mirror = recordOf(plan, 'answer:ans-1');
    expect(mirror.classification.category).toBe('complete_attempt');
    expect(mirror.mapping?.status).toBe('mapped');
    expect(mirror.mapping?.legacy_part_ref).toBe('p1');
    expect(mirror.submission).toBeNull(); // submission 属于锚记录，绝不重复
    expect(plan.rollup.totals.submissions).toBe(1);
  });
});

describe('determinism / idempotency 基座', () => {
  const capture = withEvents(emptyCapture(), [COMPLETE_ATTEMPT, HEAD_JUDGE]);
  const registry = registryOf([REGISTRY_ENTRY('q-1')]);
  const contracts = new Map([['rev-q-1', contractOf('rev-q-1')]]);

  it('同输入 → 相同 plan digest 与相同 id', () => {
    const a = buildMigrationApplyPlan(planInput(capture, registry, contracts));
    const b = buildMigrationApplyPlan(planInput(capture, registry, contracts));
    expect(planDigestOf(a)).toBe(planDigestOf(b));
    expect(a.records.map((r) => r.mapping?.mapping_id)).toEqual(
      b.records.map((r) => r.mapping?.mapping_id),
    );
    const submissionA = a.records.find((r) => r.submission != null)?.submission;
    const submissionB = b.records.find((r) => r.submission != null)?.submission;
    expect(submissionA?.submission.submission_id).toBe(submissionB?.submission.submission_id);
  });

  it('plan digest 覆盖完整行内容（P1-3）：改 planned response → digest 变', () => {
    const base = buildMigrationApplyPlan(planInput(capture, registry, contracts));
    const tampered = JSON.parse(JSON.stringify(base)) as typeof base;
    const anchor = tampered.records.find((r) => r.submission != null);
    expect(anchor).toBeDefined();
    // 直接改内存对象后重算 digest：planDigestOf 覆盖完整 submission 内容。
    const submission = anchor?.submission;
    if (submission == null) return;
    (submission.submission.response_set.entries[0] as { text_md: string }).text_md = 'tampered';
    expect(planDigestOf(tampered)).not.toBe(planDigestOf(base));
  });

  it('pending 裁决与 mapped 裁决产生不同 mapping_id（P1-5 supersession 换行不冲突）', () => {
    const withRegistry = buildMigrationApplyPlan(planInput(capture, registry, contracts));
    const without = buildMigrationApplyPlan(planInput(capture, null));
    const idWith = withRegistry.records.find(
      (r) => r.classification.source_locator === 'event:attempt:att-1',
    )?.mapping?.mapping_id;
    const idWithout = without.records.find(
      (r) => r.classification.source_locator === 'event:attempt:att-1',
    )?.mapping?.mapping_id;
    expect(idWith).toBeDefined();
    expect(idWithout).toBeDefined();
    expect(idWith).not.toBe(idWithout);
  });

  it('registry 变化 → 不同 run id / plan digest（不吞掉语料导入变化）', () => {
    const withRegistry = buildMigrationApplyPlan(planInput(capture, registry, contracts));
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
    const plan = buildMigrationApplyPlan(planInput(capture, registry, contracts));
    const sum = Object.values(plan.rollup.per_category).reduce((acc, b) => acc + b.records, 0);
    expect(sum).toBe(plan.records.length);
    expect(plan.algorithm_version).toBe(APPLY_ALGORITHM_VERSION);
  });
});

describe('closeout 自验（终轮 oracle repro）', () => {
  it('P1-2：snapshot digest 命中但题干/选项内容推不出目标 revision → conflicted，不产 submission', () => {
    const capture = withEvents(emptyCapture(), [COMPLETE_ATTEMPT, HEAD_JUDGE]);
    const registry = registryOf([REGISTRY_ENTRY('q-1')]);
    // 契约题干与冻结 snapshot 不一致（digest 只证『见过同一快照』，不证可推导）。
    const wrongPrompt = contractOf('rev-q-1');
    wrongPrompt.structure = {
      ...wrongPrompt.structure,
      parts: [{ ...wrongPrompt.structure.parts[0]!, prompt_md: 'completely different stem' }],
    };
    const plan = buildMigrationApplyPlan(
      planInput(capture, registry, new Map([['rev-q-1', wrongPrompt]])),
    );
    const anchor = recordOf(plan, 'event:attempt:att-1');
    expect(anchor.mapping?.status).toBe('conflicted');
    expect(anchor.submission).toBeNull();
    // reason 在 mapping.evidence.resolution.reason（mapping 行无顶层 reason；evidence 为 Record<string, unknown>）。
    const anchorResolution = anchor.mapping?.evidence.resolution as { reason?: string } | undefined;
    expect(String(anchorResolution?.reason)).toMatch(/题干不一致|内容/);
    expect(plan.worklists.conflicted.map((w) => w.source_locator)).toContain('event:attempt:att-1');
  });

  it('P1-2b：part_ref 不在绑定 part 集内 → conflicted（incompatible part_ref 不得 mapped）', () => {
    const capture = withEvents(emptyCapture(), [COMPLETE_ATTEMPT, HEAD_JUDGE]);
    capture.rawFacts.answers.push({
      id: 'ans-badref',
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
      part_ref: 'p-elsewhere', // 不在 entry.part_ids=['p1'] 内
      event_id: 'att-1',
    });
    const registry = registryOf([REGISTRY_ENTRY('q-1')]);
    const contracts = new Map([['rev-q-1', contractOf('rev-q-1')]]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry, contracts));
    const mirror = recordOf(plan, 'answer:ans-badref');
    expect(mirror.mapping?.status).toBe('conflicted');
    const mirrorResolution = mirror.mapping?.evidence.resolution as { reason?: string } | undefined;
    expect(String(mirrorResolution?.reason)).toContain('p-elsewhere');
  });

  it('P1-3：多 part/多槽位 + 整题自由文本 → reconstruction_blocked，不产看似正常的 submission', () => {
    const multiPart = contractOf('rev-multi');
    multiPart.structure = {
      ...multiPart.structure,
      parts: [
        { part_id: 'p1', prompt_md: '1+1=?', material_ids: [] },
        { part_id: 'p2', prompt_md: '3+3=?', material_ids: [] },
      ],
    };
    multiPart.response_spec = {
      slots: [
        {
          slot_id: 's1',
          part_id: 'p1',
          kind: 'open_response',
          accepted_evidence: [],
          evidence_required: false,
        },
        {
          slot_id: 's2',
          part_id: 'p2',
          kind: 'open_response',
          accepted_evidence: [],
          evidence_required: false,
        },
      ],
    };
    multiPart.scoring_basis = {
      units: [
        {
          scoring_unit_id: 'u1',
          slot_refs: ['s1', 's2'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: {
            kind: 'rule_reference',
            rule_id: 'legacy-import',
            statement_md: 'historical import',
            source: 'manual',
          },
          points: 2,
        },
      ],
      aggregation: { kind: 'sum' },
      blank_scores_zero: false,
    };
    const capture = withEvents(emptyCapture(), [COMPLETE_ATTEMPT, HEAD_JUDGE]);
    // asserted 绑定（跳过 snapshot 内容比对）以直达重建阶段验证长度守卫。
    const registry = registryOf([
      REGISTRY_ENTRY('q-1', {
        revision_id: 'rev-multi',
        part_ids: ['p1', 'p2'],
        binding_kind: 'question_asserted',
        snapshot_digest: null,
        assertion_reason: '语料导入方显式断言绑定多 part 契约',
      }),
    ]);
    const contracts = new Map([['rev-multi', multiPart]]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry, contracts));
    const anchor = recordOf(plan, 'event:attempt:att-1');
    expect(anchor.mapping?.status).toBe('historical_unresolved');
    expect(String(anchor.mapping?.evidence.reconstruction_blocked)).toMatch(/2 个槽位/);
    expect(anchor.submission).toBeNull();
    expect(plan.worklists.reconstruction_blocked.map((w) => w.source_locator)).toContain(
      'event:attempt:att-1',
    );
  });

  it('P1-2c：registry 坐标与契约不符（scoring_unit 不消费绑定槽位）→ conflicted，不写', () => {
    const wrongUnit = contractOf('rev-badunit');
    wrongUnit.scoring_basis = {
      ...wrongUnit.scoring_basis,
      units: [
        {
          ...wrongUnit.scoring_basis.units[0]!,
          slot_refs: ['s-other'], // 不覆盖 s1
        },
      ],
    };
    wrongUnit.response_spec = {
      slots: [
        {
          slot_id: 's1',
          part_id: 'p1',
          kind: 'open_response',
          accepted_evidence: [],
          evidence_required: false,
        },
        {
          slot_id: 's-other',
          part_id: 'p1',
          kind: 'open_response',
          accepted_evidence: [],
          evidence_required: false,
        },
      ],
    };
    const capture = withEvents(emptyCapture(), [COMPLETE_ATTEMPT, HEAD_JUDGE]);
    const registry = registryOf([REGISTRY_ENTRY('q-1', { revision_id: 'rev-badunit' })]);
    const contracts = new Map([['rev-badunit', wrongUnit]]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry, contracts));
    const anchor = recordOf(plan, 'event:attempt:att-1');
    expect(anchor.mapping?.status).toBe('conflicted');
    const badUnitResolution = anchor.mapping?.evidence.resolution as
      | { reason?: string }
      | undefined;
    expect(String(badUnitResolution?.reason)).toContain('不消费绑定槽位');
    expect(anchor.submission).toBeNull();
  });

  it('P1-3b：重建缺省值在 evidence 显式披露（reconstruction_defaults），不冒充历史事实', () => {
    const capture = withEvents(emptyCapture(), [COMPLETE_ATTEMPT, HEAD_JUDGE]);
    const registry = registryOf([REGISTRY_ENTRY('q-1')]);
    const contracts = new Map([['rev-q-1', contractOf('rev-q-1')]]);
    const plan = buildMigrationApplyPlan(planInput(capture, registry, contracts));
    const evidence = recordOf(plan, 'event:attempt:att-1').mapping?.evidence;
    expect(evidence?.reconstruction_defaults).toMatchObject({
      claim_policy: expect.stringContaining('unbounded'),
      container_occurrence_ref: expect.stringContaining('null'),
    });
  });

  it('P1-5b：分类器未声明 effective head → head 保持 (null, 0)，不虚构生效事实', () => {
    // 当前分类器仅在锚已判有 head 时产出 submission 目标；这里直接改分类输出
    // （has_effective_head=false）验证 executor 不授权降级 —— 头不存在就空着。
    const capture = withEvents(emptyCapture(), [COMPLETE_ATTEMPT, HEAD_JUDGE]);
    const registry = registryOf([REGISTRY_ENTRY('q-1')]);
    const contracts = new Map([['rev-q-1', contractOf('rev-q-1')]]);
    const base = planInput(capture, registry, contracts);
    const anchorRecord = base.classification.records.find(
      (r) => r.source_locator === 'event:attempt:att-1',
    );
    expect(anchorRecord?.native_target.kind).toBe('submission_with_imported_eval');
    if (anchorRecord?.native_target.kind === 'submission_with_imported_eval') {
      anchorRecord.native_target = {
        ...anchorRecord.native_target,
        has_effective_head: false,
        head_selection: 'not_selected',
      };
    }
    const plan = buildMigrationApplyPlan(base);
    const anchor = recordOf(plan, 'event:attempt:att-1');
    expect(anchor.submission?.head).toMatchObject({
      effective_evaluation_id: null,
      generation: 0,
    });
    // 对侧：被导入的 judge evaluation 仍存在（是 imported eval 证据），只是不是 head。
    expect(anchor.submission?.evaluations.length).toBeGreaterThan(0);
  });
});
