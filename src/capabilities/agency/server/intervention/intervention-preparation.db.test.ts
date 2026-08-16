import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  INTERVENTION_DIAGNOSTIC_CLAIM_LEASE_MS,
  authorInterventionPackage,
  handleReviewDue,
} from '@/capabilities/practice/public';
import { JUDGE_RUN_EVENTS, JUDGE_RUN_TABLE } from '@/capabilities/practice/server/judge-run-status';
import { PEDAGOGY_METHOD_LIBRARY } from '@/core/pedagogy';
import { PROBE_QUESTION_KIND, PROBE_QUESTION_SOURCE } from '@/core/schema/conjecture';
import type { ConjectureProbeResponseJudgementT } from '@/core/schema/conjecture-probe-response';
import {
  CurrentInterventionPackageReviewAudit,
  INTERVENTION_CONTRACT_VERSION,
  InterventionPackage,
  InterventionPreparationAttempt,
  PEDAGOGY_METHOD_DEFINITION_VERSION,
  buildInterventionSettlement,
} from '@/core/schema/intervention';
import {
  ai_task_runs,
  event,
  intervention,
  job_events,
  knowledge,
  mastery_state,
  material_fsrs_state,
  practice_stream_item,
  question,
} from '@/db/schema';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import { eventCorrectionsGlobalLockKey, writeEvent } from '@/kernel/events';
import type { EventSubscriptionDelivery } from '@/kernel/manifest';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { AgentRunError } from '@/server/ai/agent-run-error';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { answerProbe } from '../conjecture/probe-lifecycle';
import { prepareInterventionWave } from './prepare';
import { handleProbeResultInterventionDelivery } from './probe-result-subscription';
import { recoverEligibleInterventionDiagnostics, recoverPreparingInterventions } from './reconcile';
import { handleInterventionDiagnosticJudgeDelivery } from './settlement-subscription';
import {
  activateIntervention,
  appendPreparationAttempt,
  loadInterventionVersion,
  saveRecommendation,
} from './store';

const CLAIM = '你把复合函数求导中的外层导数和内层导数相加，而不是相乘。';
const TARGET_ERROR = '把外层导数与内层导数相加，而不是按链式法则相乘。';
const DIAGNOSTIC_SPEC = {
  schema_version: 2 as const,
  target_error_rule_md: TARGET_ERROR,
  trigger_conditions_md: '题目要求对复合函数求导。',
  scope_boundary_md: '不覆盖和、积、商等其他求导法则。',
  expected_wrong_answer_signature_md: '外层导数 + 内层导数。',
  causal_direction_required: false,
};

const PRIMARY = {
  schema_version: 2 as const,
  prompt_md: '求 y=sin(x²) 的导数。',
  reference_md: 'y′=2x cos(x²)',
  expected_target_error_answer_md: 'y′=cos(x²)+2x',
  elicits_target_error_reason_md: '复合函数结构会暴露相加而非相乘的目标错误。',
  context_kind: 'abstract' as const,
  representation_kind: 'symbolic' as const,
  response_mode: 'short_answer' as const,
  gold_response_signature: {
    kind: 'text' as const,
    response_md: 'y′=2x cos(x²)',
  },
  target_error_response_signature: {
    kind: 'text' as const,
    response_md: 'y′=cos(x²)+2x',
  },
};

const FOLLOWUP = {
  schema_version: 2 as const,
  prompt_md: '半径 r=t³ 的圆，其面积 A=πr²，求 dA/dt。',
  reference_md: 'dA/dt=6πt⁵',
  expected_target_error_answer_md: 'dA/dt=2πt³+3t²',
  elicits_target_error_reason_md: '更换物理情境后仍需组合两层导数。',
  context_kind: 'applied' as const,
  representation_kind: 'natural_language' as const,
  response_mode: 'short_answer' as const,
  gold_response_signature: {
    kind: 'text' as const,
    response_md: 'dA/dt=6πt⁵',
  },
  target_error_response_signature: {
    kind: 'text' as const,
    response_md: 'dA/dt=2πt³+3t²',
  },
};

function diagnosticJudgeVerdict(coarseOutcome: 'correct' | 'partial' | 'incorrect') {
  return {
    score_meaning: 'correctness',
    coarse_outcome: coarseOutcome,
    score: coarseOutcome === 'correct' ? 1 : coarseOutcome === 'partial' ? 0.5 : 0,
    confidence: 0.9,
    capability_ref: { id: 'multimodal_direct', version: '1.0.0' },
    feedback_md: coarseOutcome,
    evidence_json: {},
  };
}

function diagnosticJudgeEventPayload(
  coarseOutcome: 'correct' | 'partial' | 'incorrect',
  provenance: 'invoked' | 'supplied_unverified' = 'invoked',
) {
  return {
    cause: {
      primary_category: 'other',
      secondary_categories: [],
      analysis_md: '<diagnostic judge>',
      confidence: 0.9,
    },
    referenced_knowledge_ids: [],
    profile_version: '1.0.0',
    capability_ref: { id: 'multimodal_direct', version: '1.0.0' },
    judge_route: 'multimodal_direct',
    execution_provenance:
      provenance === 'invoked'
        ? {
            version: 1,
            kind: 'invoked',
            prompt_fingerprint: 'a'.repeat(64),
            prompt_template_revision: '1',
            task_run_id: 'task_diagnostic_judge',
            provider: 'test',
            model: 'test',
          }
        : {
            version: 1,
            kind: 'supplied_unverified',
            prompt_fingerprint: 'b'.repeat(64),
            prompt_template_revision: '1',
          },
    coarse_outcome: coarseOutcome,
    score: coarseOutcome === 'correct' ? 1 : coarseOutcome === 'partial' ? 0.5 : 0,
    attribution_pending: true,
  };
}

function conjecturePayload(knowledgeId: string) {
  const hypothesis = {
    kind: 'proposal' as const,
    claim_md: CLAIM,
    knowledge_id: knowledgeId,
    evidence_event_ids: ['attempt_a', 'attempt_b'],
    diagnostic_spec: DIAGNOSTIC_SPEC,
    cause_category: 'concept_misunderstanding',
    recurrence_count: 2,
  };
  const packageValue = { primary: PRIMARY, followup: FOLLOWUP, predicted_p: 0.3 };
  return {
    kind: 'conjecture' as const,
    target: { subject_kind: 'mind_model' as const, subject_id: knowledgeId },
    reason_md: CLAIM,
    evidence_refs: [
      { kind: 'event' as const, id: 'attempt_a' },
      { kind: 'event' as const, id: 'attempt_b' },
    ],
    cooldown_key: `conjecture:${knowledgeId}`,
    proposed_change: {
      claim_md: CLAIM,
      knowledge_id: knowledgeId,
      cause_category: 'concept_misunderstanding',
      confidence: 0.8,
      recurrence_count: 2,
      probe_md: PRIMARY.prompt_md,
      probe_reference_md: PRIMARY.reference_md,
      followup_probe_md: FOLLOWUP.prompt_md,
      followup_probe_reference_md: FOLLOWUP.reference_md,
      diagnostic_spec: DIAGNOSTIC_SPEC,
      probe_spec: PRIMARY,
      followup_probe_spec: FOLLOWUP,
      probe_quality: {
        schema_version: 3 as const,
        passed: true as const,
        attempts: [
          {
            attempt: 1,
            outcome: 'passed' as const,
            failure_codes: [],
            explanation_md: 'grounded and discriminating',
            author_task_run_id: 'probe_author_run',
            reviewer_task_run_id: 'probe_review_run',
          },
        ],
        final_review: {
          verdict: 'pass' as const,
          failure_codes: [],
          explanation_md: 'grounded and discriminating',
        },
        reviewed_hypothesis: hypothesis,
        reviewed_package: packageValue,
      },
      discriminating: true,
      corrected_by_owner: false,
      predicted_p: 0.3,
      baseline_p_at_induction: 0.5,
    },
  };
}

async function seedEvidenceFor(
  suffix: string,
  options: { includeResponseJudgement?: boolean } = {},
) {
  const db = testDb();
  const now = new Date(`2026-07-${suffix === 'a' ? '20' : '21'}T10:00:00.000Z`);
  const knowledgeId = `kc_chain_${suffix}`;
  const conjectureId = `conjecture_${suffix}`;
  await db.insert(knowledge).values({
    id: knowledgeId,
    name: '复合函数链式法则',
    domain: 'math',
    created_at: now,
    updated_at: now,
  });
  await db.insert(mastery_state).values({
    id: `mastery_${suffix}`,
    subject_kind: 'knowledge',
    subject_id: knowledgeId,
    theta_hat: -0.8,
    theta_precision: 1.2,
    evidence_count: 2,
    success_count: 0,
    fail_count: 2,
    updated_at: now,
  });
  await writeAiProposal(db, {
    id: conjectureId,
    actor_ref: 'research_meeting',
    payload: conjecturePayload(knowledgeId),
    created_at: now,
  });
  await writeEvent(db, {
    id: `accept_${suffix}`,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: conjectureId,
    outcome: 'success',
    payload: { rating: 'accept', corrected_by_owner: false },
    caused_by_event_id: conjectureId,
    created_at: new Date(now.getTime() + 1_000),
  });
  await db.insert(question).values({
    id: `probe_${suffix}`,
    kind: PROBE_QUESTION_KIND,
    prompt_md: PRIMARY.prompt_md,
    reference_md: PRIMARY.reference_md,
    choices_md: null,
    knowledge_ids: [knowledgeId],
    source: PROBE_QUESTION_SOURCE,
    source_ref: conjectureId,
    draft_status: 'draft',
    metadata: {
      conjecture_proposal_id: conjectureId,
      probe_sequence: 1,
      probe_spec: PRIMARY,
    },
    version: 0,
    created_at: now,
    updated_at: now,
  });
  const responseJudgement: ConjectureProbeResponseJudgementT = {
    rule_version: 'conjecture_probe_response_signature_v1' as const,
    answer_result: 'incorrect' as const,
    target_error_match: 'matched' as const,
    gradable: true,
    reason_code: 'target_error_signature_matched' as const,
    signature_match_explanation_md: '学习者作答与冻结的目标错误签名语义一致。',
    evidence_refs: [
      'learner_response',
      'gold_response_signature',
      'target_error_response_signature',
      'correctness_judge',
    ],
  };
  if (options.includeResponseJudgement === false) {
    const probeResultId = `probe_result_${suffix}`;
    await writeEvent(db, {
      id: probeResultId,
      actor_kind: 'system',
      actor_ref: 'mind_probe',
      action: 'experimental:probe_result',
      subject_kind: 'question',
      subject_id: `probe_${suffix}`,
      payload: {
        conjecture_event_id: conjectureId,
        outcome: 0,
        resolution: 'evidence_for',
        answer_md: '把两层导数相加',
      },
      caused_by_event_id: conjectureId,
      ingest_at: now,
      created_at: new Date(now.getTime() + 2_000),
    });
    return {
      probeResultId,
      probeResolution: 'evidence_for' as const,
      conjectureId,
      knowledgeId,
      now,
    };
  }

  // Use the real conjecture lifecycle writer for the normal fixture. Under the
  // post-YUK-787 evidence-strength contract, the first matched target error is
  // `evidence_for` (not the historical overclaim `confirmed`) and is the live
  // YUK-791 intervention trigger.
  const answered = await answerProbe({
    db,
    probeQuestionId: `probe_${suffix}`,
    outcome: 0,
    answer_md: '把两层导数相加',
    response_judgement: responseJudgement,
    now: new Date(now.getTime() + 2_000),
  });
  return {
    probeResultId: answered.probe_result_event_id,
    probeResolution: answered.status,
    conjectureId,
    knowledgeId,
    now,
  };
}

function delivery(sourceEventId: string): EventSubscriptionDelivery {
  return {
    subscriberId: 'agency.probe-evidence-intervention-prepare',
    subscriberVersion: 1,
    deliverySeq: '1',
    sourceEventId,
  };
}

function preparationJobIdOf(record: { preparation_job_id: string | null }): string {
  if (!record.preparation_job_id) throw new Error('intervention has no preparation job id');
  return record.preparation_job_id;
}

function authorOutput(attempt: number) {
  const probeSpec = (
    prompt_md: string,
    reference_md: string,
    expected_target_error_answer_md: string,
    context_kind: 'abstract' | 'applied',
    representation_kind: 'symbolic' | 'natural_language',
  ) => ({
    schema_version: 2 as const,
    prompt_md,
    reference_md,
    expected_target_error_answer_md,
    elicits_target_error_reason_md: '该作答会区分相乘的正确链式法则与相加的目标错误。',
    context_kind,
    representation_kind,
    response_mode: 'short_answer' as const,
    gold_response_signature: { kind: 'text' as const, response_md: reference_md },
    target_error_response_signature: {
      kind: 'text' as const,
      response_md: expected_target_error_answer_md,
    },
  });
  return {
    schema_version: 1,
    material: {
      title_md: '链式法则：外层导数乘以内层导数',
      body_md: '先识别外层 sin(u)，再求 cos(u)；随后对 u=x² 求 2x，最后把两者相乘。',
    },
    diagnostics: {
      immediate: {
        kind: 'immediate',
        probe_spec: probeSpec(
          `求 y=exp(x²+${attempt}) 的导数。`,
          `2x exp(x²+${attempt})`,
          `exp(x²+${attempt})+2x`,
          'abstract',
          'symbolic',
        ),
        tested_claim_md: CLAIM,
        target_error_rule_md: TARGET_ERROR,
      },
      delayed: {
        kind: 'delayed',
        probe_spec: probeSpec(
          `求 y=ln(3x²+${attempt}) 的导数。`,
          `6x/(3x²+${attempt})`,
          `1/(3x²+${attempt})+6x`,
          'abstract',
          'symbolic',
        ),
        tested_claim_md: CLAIM,
        target_error_rule_md: TARGET_ERROR,
      },
      transfer: {
        kind: 'transfer',
        probe_spec: probeSpec(
          `球半径 r=t²+${attempt}，体积 V=4πr³/3，求 dV/dt。`,
          `8πt(t²+${attempt})²`,
          `4π(t²+${attempt})²+2t`,
          'applied',
          'natural_language',
        ),
        tested_claim_md: CLAIM,
        target_error_rule_md: TARGET_ERROR,
        context_change_md: '从纯符号函数换到随时间变化的球体积情境。',
      },
    },
  };
}

function reviewDiagnosticChecks(
  overrides: Partial<{
    reference_correct: boolean;
    within_frozen_scope: boolean;
    discipline_grounded: boolean;
  }> = {},
) {
  return (['immediate', 'delayed', 'transfer'] as const).map((kind) => ({
    kind,
    independently_derived_answer_md: `${kind} independently solved answer`,
    required_operations_md: '应用冻结 claim 内的链式法则。',
    reference_correct: overrides.reference_correct ?? true,
    within_frozen_scope: overrides.within_frozen_scope ?? true,
    discipline_grounded: overrides.discipline_grounded ?? true,
    decision_basis_md: '独立答案与 reference 一致；操作在冻结范围内；结论可独立复算。',
    causal_direction_check: {
      applies: false,
      exposure_x_md: '',
      observed_outcome_y_md: '',
      reference_reverse_causation_claim_relations: [],
    },
  }));
}

function reviewPackageChecks(overrides: Partial<ReturnType<typeof reviewPackageChecksBase>> = {}) {
  return { ...reviewPackageChecksBase(), ...overrides };
}

function reviewPackageChecksBase() {
  return {
    material_grounded: true,
    method_followed: true,
    tested_claims_match: true,
    target_errors_match: true,
    answers_unique: true,
    answers_gradable: true,
    no_answer_leak: true,
    diagnostics_same_construct: true,
    transfer_context_changed: true,
    target_error_identifiable: true,
    serious_factual_error_absent: true,
    safe_material: true,
  };
}

function comparatorDiagnosticChecks(input: unknown, checks = reviewDiagnosticChecks()) {
  const sealed = (
    input as {
      sealed_independent_solutions?: Array<{
        kind: string;
        solver_output_sha256: string;
        required_operations: Array<{
          operation_index: number;
          operation_sha256: string;
        }>;
      }>;
    }
  ).sealed_independent_solutions;
  if (!sealed || sealed.length !== 3) throw new Error('missing sealed independent solutions');
  const solutionByKind = new Map(sealed.map((solution) => [solution.kind, solution]));
  return checks.map(
    ({
      independently_derived_answer_md: _answer,
      required_operations_md: _operations,
      ...check
    }) => ({
      ...check,
      required_operation_checks: solutionByKind
        .get(check.kind)
        ?.required_operations.map((operation) => ({
          operation_index: operation.operation_index,
          reference_covers_operation: check.reference_correct,
          within_frozen_scope: check.within_frozen_scope,
          decision_basis_md: '该原子步骤已逐项对照 reference 与冻结 scope，结论与诊断级判据一致。',
        })),
    }),
  );
}

async function recordMockAiRun(
  db: ReturnType<typeof testDb>,
  kind: string,
  input: unknown,
  taskRunId: string,
) {
  const now = new Date('2026-07-20T00:00:00.000Z');
  await db.insert(ai_task_runs).values({
    id: taskRunId,
    task_kind: kind,
    provider: 'xiaomi',
    model: 'mimo-v2.5-pro',
    input_hash: sha256CanonicalJson(input),
    status: 'success',
    finish_reason: 'stop',
    usage_json: { inputTokens: 100, outputTokens: 50 },
    cost_usd: 0.01,
    started_at: now,
    finished_at: now,
  });
}

function concreteRecommendation(modelRunId: string) {
  return {
    kind: 'recommendation' as const,
    recommendation_version: INTERVENTION_CONTRACT_VERSION,
    method_id: 'worked_example' as const,
    method_definition_version: PEDAGOGY_METHOD_DEFINITION_VERSION,
    rationale_md: '先用完整示范显式区分内外层，再用三道独立题验证。',
    safety_constraints: ['不得把一次表现写成能力定论'],
    candidate_ids: ['worked_example' as const],
    excluded: [],
    model_run_id: modelRunId,
  };
}

function successfulRunTask(
  db: ReturnType<typeof testDb>,
  packageOutput: (attempt: number) => ReturnType<typeof authorOutput> = authorOutput,
): {
  fn: TaskTextRunFn;
  calls: string[];
  contexts: Array<{ kind: string; ctx: Parameters<TaskTextRunFn>[2] }>;
} {
  const calls: string[] = [];
  const contexts: Array<{ kind: string; ctx: Parameters<TaskTextRunFn>[2] }> = [];
  const fn: TaskTextRunFn = async (kind, input, ctx) => {
    calls.push(kind);
    contexts.push({ kind, ctx });
    if (kind === 'InterventionRecommendationTask') {
      return {
        text: '',
        task_run_id: 'recommendation_run',
        structured_output: {
          kind: 'recommendation',
          method_id: 'worked_example',
          rationale_md: '低能力、低精度且目标误区已复现，先给完整示范最安全。',
          safety_constraints: ['必须显式区分外层与内层', '不得把一次表现写成能力定论'],
        },
      };
    }
    if (kind === 'InterventionPackageAuthorTask') {
      const attempt = calls.filter((value) => value === kind).length;
      return {
        text: '',
        task_run_id: `author_run_${attempt}`,
        structured_output: packageOutput(attempt),
      };
    }
    if (kind === 'SolutionGenerateTask') {
      const ordinal = calls.filter((value) => value === kind).length;
      const taskRunId = `independent_solution_run_${ordinal}`;
      await recordMockAiRun(db, kind, input, taskRunId);
      return {
        text: '',
        task_run_id: taskRunId,
        structured_output: {
          reference_solution: {
            expected_signals: ['识别题目实际要求的量或结论', '只按题面条件完成学科推导并核对结果'],
            final_answer: `independent solution ${ordinal}`,
            answer_equivalents: [],
          },
          worked_solution_md: '独立求解题面，不读取作者 reference 或干预材料。',
          confidence: 0.92,
        },
      };
    }
    if (kind === 'QuizVerifyTask') {
      const ordinal = calls.filter((value) => value === kind).length;
      const taskRunId = `question_content_validation_run_${ordinal}`;
      await recordMockAiRun(db, kind, input, taskRunId);
      return {
        text: '',
        task_run_id: taskRunId,
        structured_output: {
          grounding: {
            verdict: 'pass',
            note: '逐项复算导数、核对量纲与符号后，题面和 reference 在数学上成立。',
          },
          copy_safety: { verdict: 'original', max_overlap: 0.03 },
          knowledge_hit: {
            verdict: 'pass',
            note: '题目只要求识别复合结构并应用链式法则，命中冻结知识点。',
          },
          overall: 'pass',
          summary_md: '复杂链式法则题面、答案和构念均通过共享内容 validator。',
          confidence: 0.96,
        },
      };
    }
    if (kind === 'InterventionPackageReviewTask') {
      const attempt = calls.filter((value) => value === kind).length;
      const taskRunId = `review_run_${attempt}`;
      await recordMockAiRun(db, kind, input, taskRunId);
      return {
        text: '',
        task_run_id: taskRunId,
        structured_output: {
          review_protocol_version: 2,
          verdict: 'pass',
          failure_codes: [],
          diagnostic_checks: comparatorDiagnosticChecks(input),
          package_checks: reviewPackageChecks(),
          summary_md: '材料、三题和目标错误均对齐，答案可判定且迁移情境已更换。',
        },
      };
    }
    throw new Error(`unexpected task ${kind}`);
  };
  return { fn, calls, contexts };
}

describe('YUK-791 intervention preparation closed loop', () => {
  beforeEach(resetDb);

  it('durably opens shadow preparation, consumes recommendation in the same wave, and activates once', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('a');
    const sends: Array<{ name: string; data: unknown; options: unknown }> = [];
    const first = await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      env: {},
      now: () => new Date(seeded.now.getTime() + 3_000),
      bossSend: async (name, data, options) => {
        sends.push({ name, data, options });
        return options.id;
      },
    });
    expect(first).toMatchObject({
      status: 'succeeded',
      detail: { version: 1, intervention_status: 'preparing', delivery_mode: 'shadow' },
    });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      name: 'prepare_intervention',
      data: { version: 1 },
      options: { id: expect.any(String), db: expect.any(Object) },
    });

    const [opened] = await db.select().from(intervention);
    expect(opened).toMatchObject({
      status: 'preparing',
      delivery_mode: 'shadow',
      source_probe_result_event_id: seeded.probeResultId,
      preparation_job_id: expect.any(String),
    });
    const { fn, calls, contexts } = successfulRunTask(db);
    const result = await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: 1,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: preparationJobIdOf(opened),
      },
      {
        runTaskFn: fn,
        authorPackageFn: authorInterventionPackage,
        now: () => seeded.now,
      },
    );
    expect(result).toMatchObject({ status: 'active', delivery_mode: 'shadow', idempotent: false });
    expect(calls).toEqual([
      'InterventionRecommendationTask',
      'InterventionPackageAuthorTask',
      'SolutionGenerateTask',
      'SolutionGenerateTask',
      'SolutionGenerateTask',
      'QuizVerifyTask',
      'QuizVerifyTask',
      'QuizVerifyTask',
      'InterventionPackageReviewTask',
      'InterventionPackageReviewTask',
    ]);
    expect(
      contexts.map(({ kind, ctx }) => ({
        kind,
        outputFormatType: ctx?.outputFormat?.type,
      })),
    ).toEqual([
      { kind: 'InterventionRecommendationTask', outputFormatType: 'json_schema' },
      { kind: 'InterventionPackageAuthorTask', outputFormatType: 'json_schema' },
      { kind: 'SolutionGenerateTask', outputFormatType: 'json_schema' },
      { kind: 'SolutionGenerateTask', outputFormatType: 'json_schema' },
      { kind: 'SolutionGenerateTask', outputFormatType: 'json_schema' },
      { kind: 'QuizVerifyTask', outputFormatType: undefined },
      { kind: 'QuizVerifyTask', outputFormatType: undefined },
      { kind: 'QuizVerifyTask', outputFormatType: undefined },
      { kind: 'InterventionPackageReviewTask', outputFormatType: 'json_schema' },
      { kind: 'InterventionPackageReviewTask', outputFormatType: 'json_schema' },
    ]);

    const [active] = await db.select().from(intervention);
    expect(active.status).toBe('active');
    expect(active.recommendation_json).toMatchObject({
      kind: 'recommendation',
      method_id: 'worked_example',
      model_run_id: 'recommendation_run',
    });
    expect(active.package_json).toMatchObject({
      intervention_id: active.id,
      intervention_version: 1,
      author_task_run_id: 'author_run_1',
    });
    expect(active.settlement_json).toMatchObject({
      diagnostics: {
        immediate: {
          status: 'scheduled',
          due_at: '2026-07-20T10:00:00.000Z',
        },
        delayed: {
          status: 'scheduled',
          due_at: '2026-07-27T10:00:00.000Z',
        },
        transfer: {
          status: 'scheduled',
          due_at: '2026-08-10T10:00:00.000Z',
        },
      },
    });
    expect(active.preparation_attempts_json).toHaveLength(1);
    expect(active.preparation_attempts_json[0]).toMatchObject({
      review: {
        review_task_run_id: 'review_run_2',
        review_attempt_task_run_ids: ['review_run_1', 'review_run_2'],
        independent_solution_audit: {
          validation_protocol_version: 1,
          diagnostics: [
            {
              kind: 'immediate',
              solver_task_run_id: 'independent_solution_run_1',
              solver_attempt_task_run_ids: ['independent_solution_run_1'],
            },
            {
              kind: 'delayed',
              solver_task_run_id: 'independent_solution_run_2',
              solver_attempt_task_run_ids: ['independent_solution_run_2'],
            },
            {
              kind: 'transfer',
              solver_task_run_id: 'independent_solution_run_3',
              solver_attempt_task_run_ids: ['independent_solution_run_3'],
            },
          ],
        },
        question_content_validation_audit: {
          validation_protocol_version: 1,
          diagnostics: [
            { kind: 'immediate', task_run_id: 'question_content_validation_run_1' },
            { kind: 'delayed', task_run_id: 'question_content_validation_run_2' },
            { kind: 'transfer', task_run_id: 'question_content_validation_run_3' },
          ],
        },
      },
    });
    const diagnosticQuestions = await db
      .select({
        id: question.id,
        source: question.source,
        judge_kind_override: question.judge_kind_override,
        draft_status: question.draft_status,
        metadata: question.metadata,
      })
      .from(question)
      .where(eq(question.source, 'intervention_diagnostic'));
    expect(diagnosticQuestions).toHaveLength(0);
    const diagnosticCards = await db
      .select({
        subject_id: material_fsrs_state.subject_id,
        subject_kind: material_fsrs_state.subject_kind,
        due_at: material_fsrs_state.due_at,
      })
      .from(material_fsrs_state)
      .where(eq(material_fsrs_state.subject_kind, 'question'));
    expect(diagnosticCards).toHaveLength(0);

    const replay = await prepareInterventionWave(
      db,
      {
        interventionId: active.id,
        version: 1,
        idempotencyKey: active.idempotency_key,
        preparationJobId: preparationJobIdOf(active),
      },
      {
        runTaskFn: async () => {
          throw new Error('idempotent replay must not call the model');
        },
        authorPackageFn: async () => {
          throw new Error('idempotent replay must not call QuestionAuthor');
        },
      },
    );
    expect(replay).toMatchObject({ status: 'active', idempotent: true });
    const activated = await db
      .select({ value: count() })
      .from(event)
      .where(
        and(
          eq(event.action, 'experimental:intervention_activated'),
          eq(event.subject_id, seeded.probeResultId),
        ),
      );
    expect(activated[0]?.value).toBe(1);
  });

  it('retries one persisted schema-invalid blind solve and audits both paid attempts', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('strict_solver_retry');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      env: {},
      bossSend: async () => 'prepare_job_strict_solver_retry',
    });
    const [opened] = await db.select().from(intervention);
    const { fn: baseRun, calls } = successfulRunTask(db);
    let injectedInvalidContract = false;
    const oneInvalidThenSuccess: TaskTextRunFn = async (kind, input, ctx) => {
      if (kind === 'SolutionGenerateTask' && !injectedInvalidContract) {
        injectedInvalidContract = true;
        calls.push(kind);
        await recordMockAiRun(db, kind, input, 'independent_solution_invalid_contract_1');
        return {
          text: JSON.stringify({
            reference_solution: {
              final_answer: '只有答案，缺少完整 validator contract',
              answer_equivalents: [],
            },
          }),
          task_run_id: 'independent_solution_invalid_contract_1',
        };
      }
      return baseRun(kind, input, ctx);
    };

    const result = await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: preparationJobIdOf(opened),
      },
      { runTaskFn: oneInvalidThenSuccess, authorPackageFn: authorInterventionPackage },
    );

    expect(result).toMatchObject({ status: 'active' });
    expect(calls.filter((kind) => kind === 'SolutionGenerateTask')).toHaveLength(4);
    expect(calls.filter((kind) => kind === 'InterventionPackageReviewTask')).toHaveLength(2);
    const [active] = await db.select().from(intervention);
    const activatedAttempt = InterventionPreparationAttempt.parse(
      active.preparation_attempts_json[0],
    );
    if (
      activatedAttempt?.kind !== 'reviewed_package' ||
      !('independent_solution_audit' in activatedAttempt.review)
    ) {
      throw new Error('missing FULL activated attempt');
    }
    expect(activatedAttempt.review.independent_solution_audit.diagnostics[0]).toMatchObject({
      kind: 'immediate',
      solver_task_run_id: 'independent_solution_run_2',
      solver_attempt_task_run_ids: [
        'independent_solution_invalid_contract_1',
        'independent_solution_run_2',
      ],
    });
  });

  it('retains a paid release-strict content run with null digest when its output contract is malformed', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('strict_content_provenance');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      env: {},
      bossSend: async () => 'prepare_job_strict_content_provenance',
    });
    const [opened] = await db.select().from(intervention);
    const { fn: baseRun, calls } = successfulRunTask(db);
    let injectedMalformedContent = false;
    const malformedThenFreshPackage: TaskTextRunFn = async (kind, input, ctx) => {
      if (kind === 'QuizVerifyTask' && !injectedMalformedContent) {
        injectedMalformedContent = true;
        calls.push(kind);
        await recordMockAiRun(db, kind, input, 'question_content_malformed_1');
        return {
          text: '{"grounding":{"verdict":"pass"}',
          task_run_id: 'question_content_malformed_1',
        };
      }
      return baseRun(kind, input, ctx);
    };

    const result = await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: preparationJobIdOf(opened),
      },
      { runTaskFn: malformedThenFreshPackage, authorPackageFn: authorInterventionPackage },
    );

    expect(result).toMatchObject({ status: 'active' });
    const active = await loadInterventionVersion(db, opened.id, opened.version);
    expect(active?.preparation_attempts[0]).toMatchObject({
      kind: 'author_failed',
      failure_code: 'question_content_validation_unavailable:immediate',
      validator_task_run_ids: expect.arrayContaining(['question_content_malformed_1']),
    });
    const [malformedRun] = await db
      .select({
        input_hash: ai_task_runs.input_hash,
        prompt_fingerprint: ai_task_runs.prompt_fingerprint,
        result_digest: ai_task_runs.result_digest,
      })
      .from(ai_task_runs)
      .where(eq(ai_task_runs.id, 'question_content_malformed_1'));
    expect(malformedRun).toMatchObject({
      input_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      prompt_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      result_digest: null,
    });
  });

  it('refuses activation when a comparator run is not bound to its canonical input', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('review_run_binding');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      env: {},
      bossSend: async () => 'prepare_job_review_run_binding',
    });
    const [opened] = await db.select().from(intervention);
    const { fn: baseRun } = successfulRunTask(db);
    const mismatchedReviewRun: TaskTextRunFn = async (kind, input, ctx) => {
      const result = await baseRun(kind, input, ctx);
      if (kind === 'InterventionPackageReviewTask' && result.task_run_id) {
        await db
          .update(ai_task_runs)
          .set({ input_hash: 'f'.repeat(64) })
          .where(eq(ai_task_runs.id, result.task_run_id));
      }
      return result;
    };

    const result = await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: preparationJobIdOf(opened),
      },
      { runTaskFn: mismatchedReviewRun, authorPackageFn: authorInterventionPackage },
    );

    expect(result).toMatchObject({
      status: 'preparation_failed',
      reason_code: expect.stringContaining('agency:review_task_run_invalid'),
    });
    const [failed] = await db.select().from(intervention);
    expect(failed).toMatchObject({ status: 'preparation_failed', package_json: null });
    expect(failed.preparation_attempts_json).toHaveLength(2);
    expect(failed.preparation_attempts_json).toEqual([
      expect.objectContaining({
        kind: 'reviewed_package',
        deterministic_failure_codes: ['agency:review_task_run_invalid'],
      }),
      expect.objectContaining({
        kind: 'reviewed_package',
        deterministic_failure_codes: ['agency:review_task_run_invalid'],
      }),
    ]);
  });

  it('rebinds the first pass attempt prompt and result digest instead of trusting the selected second pass', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('first_review_attempt_binding');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      env: {},
      bossSend: async () => 'prepare_job_first_review_attempt_binding',
    });
    const [opened] = await db.select().from(intervention);
    const { fn } = successfulRunTask(db);

    const result = await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: preparationJobIdOf(opened),
      },
      {
        runTaskFn: fn,
        authorPackageFn: async (authorDb, interventionId, deps) => {
          const authored = await authorInterventionPackage(authorDb, interventionId, deps);
          if (authored.kind === 'reviewed_package') {
            const current = CurrentInterventionPackageReviewAudit.parse(authored.review);
            const firstPassTaskRunId = current.review_attempt_task_run_ids[0];
            await authorDb
              .update(ai_task_runs)
              .set({ prompt_fingerprint: 'f'.repeat(64), result_digest: null })
              .where(eq(ai_task_runs.id, firstPassTaskRunId));
          }
          return authored;
        },
      },
    );

    expect(result).toMatchObject({
      status: 'preparation_failed',
      reason_code: 'package_quality:agency:review_task_run_invalid',
    });
    const failed = await loadInterventionVersion(db, opened.id, opened.version);
    expect(failed?.preparation_attempts).toEqual([
      expect.objectContaining({
        kind: 'reviewed_package',
        deterministic_failure_codes: ['agency:review_task_run_invalid'],
      }),
      expect.objectContaining({
        kind: 'reviewed_package',
        deterministic_failure_codes: ['agency:review_task_run_invalid'],
      }),
    ]);
  });

  it('consumes an unconfirmed comparator pass, then activates only after a fresh pass/pass', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('review_contract_retry');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      env: {},
      bossSend: async () => 'prepare_job_review_contract_retry',
    });
    const [opened] = await db.select().from(intervention);
    const { fn: baseRun, calls } = successfulRunTask(db);
    let injectedInvalidReview = false;
    const oneInvalidReviewThenSuccess: TaskTextRunFn = async (kind, input, ctx) => {
      if (kind === 'InterventionPackageReviewTask' && !injectedInvalidReview) {
        injectedInvalidReview = true;
        calls.push(kind);
        await recordMockAiRun(db, kind, input, 'review_invalid_contract_1');
        return {
          text: '{"verdict":"pass"}',
          task_run_id: 'review_invalid_contract_1',
        };
      }
      return baseRun(kind, input, ctx);
    };

    const result = await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: preparationJobIdOf(opened),
      },
      { runTaskFn: oneInvalidReviewThenSuccess, authorPackageFn: authorInterventionPackage },
    );

    expect(result).toMatchObject({ status: 'active' });
    expect(calls.filter((kind) => kind === 'InterventionPackageReviewTask')).toHaveLength(4);
    const active = await loadInterventionVersion(db, opened.id, opened.version);
    expect(active?.preparation_attempts[0]).toMatchObject({
      kind: 'author_failed',
      failure_code: 'review_output_invalid',
      validator_task_run_ids: expect.arrayContaining(['review_invalid_contract_1', 'review_run_2']),
    });
    const attempt = active?.preparation_attempts[1];
    if (attempt?.kind !== 'reviewed_package' || !('independent_solution_audit' in attempt.review)) {
      throw new Error('missing freshly confirmed FULL comparator audit');
    }
    const currentReview = CurrentInterventionPackageReviewAudit.parse(attempt.review);
    expect(currentReview).toMatchObject({
      review_task_run_id: 'review_run_4',
      review_attempt_task_run_ids: ['review_run_3', 'review_run_4'],
      review_attempts: [
        { task_run_id: 'review_run_3', outcome: 'valid', result: { verdict: 'pass' } },
        { task_run_id: 'review_run_4', outcome: 'valid', result: { verdict: 'pass' } },
      ],
      result: { verdict: 'pass', failure_codes: [] },
    });
    const reviewRuns = await db
      .select({
        id: ai_task_runs.id,
        prompt_fingerprint: ai_task_runs.prompt_fingerprint,
        result_digest: ai_task_runs.result_digest,
      })
      .from(ai_task_runs)
      .where(inArray(ai_task_runs.id, currentReview.review_attempt_task_run_ids));
    expect(reviewRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'review_run_3',
          prompt_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          result_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        expect.objectContaining({
          id: 'review_run_4',
          prompt_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          result_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]),
    );
  });

  it('durably consumes a package attempt when the comparator runner times out', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('review_runner_timeout');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      env: {},
      bossSend: async () => 'prepare_job_review_runner_timeout',
    });
    const [opened] = await db.select().from(intervention);
    const { fn: baseRun, calls } = successfulRunTask(db);
    let injectedTimeout = false;
    const oneComparatorTimeoutThenSuccess: TaskTextRunFn = async (kind, input, ctx) => {
      if (kind === 'InterventionPackageReviewTask' && !injectedTimeout) {
        injectedTimeout = true;
        calls.push(kind);
        throw new AgentRunError({
          kind,
          taskRunId: 'review_budget_timeout_1',
          subtype: 'budget_timeout',
          errors: ['budget elapsed after the paid run started'],
        });
      }
      return baseRun(kind, input, ctx);
    };

    const result = await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: preparationJobIdOf(opened),
      },
      { runTaskFn: oneComparatorTimeoutThenSuccess, authorPackageFn: authorInterventionPackage },
    );

    expect(result).toMatchObject({ status: 'active' });
    expect(calls.filter((kind) => kind === 'InterventionPackageReviewTask')).toHaveLength(3);
    const active = await loadInterventionVersion(db, opened.id, opened.version);
    expect(active?.preparation_attempts).toHaveLength(2);
    expect(active?.preparation_attempts[0]).toMatchObject({
      kind: 'author_failed',
      failure_code: 'review_runner_failure',
      validator_task_run_ids: expect.arrayContaining([
        'independent_solution_run_1',
        'independent_solution_run_2',
        'independent_solution_run_3',
        'review_budget_timeout_1',
      ]),
    });
    expect(active?.preparation_attempts[1]).toMatchObject({
      kind: 'reviewed_package',
      review: {
        review_task_run_id: 'review_run_3',
        review_attempt_task_run_ids: ['review_run_2', 'review_run_3'],
      },
    });
  });

  it('records pass then semantic fail and never lets the first pass activate', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('review_pass_then_fail');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      env: {},
      bossSend: async () => 'prepare_job_review_pass_then_fail',
    });
    const [opened] = await db.select().from(intervention);
    const { fn: baseRun, calls } = successfulRunTask(db);
    const passThenFail: TaskTextRunFn = async (kind, input, ctx) => {
      const result = await baseRun(kind, input, ctx);
      if (
        kind === 'InterventionPackageReviewTask' &&
        calls.filter((value) => value === kind).length % 2 === 0
      ) {
        return {
          ...result,
          structured_output: {
            ...(result.structured_output as Record<string, unknown>),
            package_checks: reviewPackageChecks({ material_grounded: false }),
            summary_md:
              '第一次逐项检查暂时通过；确认轮发现材料中的链式法则解释无法支撑题目 reference。',
          },
        };
      }
      return result;
    };

    const result = await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: preparationJobIdOf(opened),
      },
      { runTaskFn: passThenFail, authorPackageFn: authorInterventionPackage },
    );

    expect(result).toMatchObject({
      status: 'preparation_failed',
      reason_code: 'package_quality:material_not_grounded',
    });
    expect(calls.filter((kind) => kind === 'InterventionPackageReviewTask')).toHaveLength(4);
    const failed = await loadInterventionVersion(db, opened.id, opened.version);
    for (const attempt of failed?.preparation_attempts ?? []) {
      if (attempt.kind !== 'reviewed_package') throw new Error('missing failed FULL audit');
      const audit = CurrentInterventionPackageReviewAudit.parse(attempt.review);
      expect(audit.review_attempts).toMatchObject([
        { outcome: 'valid', result: { verdict: 'pass' } },
        { outcome: 'valid', result: { verdict: 'fail' } },
      ]);
      expect(audit.result).toMatchObject({
        verdict: 'fail',
        failure_codes: ['material_not_grounded'],
      });
    }
  });

  it('records contract-invalid then semantic fail as one bounded failed FULL audit', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('review_invalid_then_fail');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      env: {},
      bossSend: async () => 'prepare_job_review_invalid_then_fail',
    });
    const [opened] = await db.select().from(intervention);
    const { fn: baseRun, calls } = successfulRunTask(db);
    const invalidThenFail: TaskTextRunFn = async (kind, input, ctx) => {
      if (kind !== 'InterventionPackageReviewTask') return baseRun(kind, input, ctx);
      const nextOrdinal = calls.filter((value) => value === kind).length + 1;
      if (nextOrdinal % 2 === 1) {
        calls.push(kind);
        const taskRunId = `review_contract_invalid_${nextOrdinal}`;
        await recordMockAiRun(db, kind, input, taskRunId);
        return { text: '{"review_protocol_version":2}', task_run_id: taskRunId };
      }
      const result = await baseRun(kind, input, ctx);
      return {
        ...result,
        structured_output: {
          ...(result.structured_output as Record<string, unknown>),
          package_checks: reviewPackageChecks({ serious_factual_error_absent: false }),
          summary_md: '确认轮发现 reference 含严重事实错误，因此立即停止，不再请求第三次判断。',
        },
      };
    };

    const result = await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: preparationJobIdOf(opened),
      },
      { runTaskFn: invalidThenFail, authorPackageFn: authorInterventionPackage },
    );

    expect(result).toMatchObject({
      status: 'preparation_failed',
      reason_code: 'package_quality:serious_factual_error',
    });
    const failed = await loadInterventionVersion(db, opened.id, opened.version);
    for (const attempt of failed?.preparation_attempts ?? []) {
      if (attempt.kind !== 'reviewed_package') throw new Error('missing bounded failed audit');
      const audit = CurrentInterventionPackageReviewAudit.parse(attempt.review);
      expect(audit.review_attempts).toMatchObject([
        { outcome: 'contract_invalid' },
        { outcome: 'valid', result: { verdict: 'fail' } },
      ]);
    }
  });

  it('treats pass then contract-invalid as invalid and preserves both persisted result digests', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('review_pass_then_invalid');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      env: {},
      bossSend: async () => 'prepare_job_review_pass_then_invalid',
    });
    const [opened] = await db.select().from(intervention);
    const { fn: baseRun, calls } = successfulRunTask(db);
    const passThenInvalid: TaskTextRunFn = async (kind, input, ctx) => {
      if (kind !== 'InterventionPackageReviewTask') return baseRun(kind, input, ctx);
      const nextOrdinal = calls.filter((value) => value === kind).length + 1;
      if (nextOrdinal % 2 === 1) return baseRun(kind, input, ctx);
      calls.push(kind);
      const taskRunId = `review_contract_invalid_${nextOrdinal}`;
      await recordMockAiRun(db, kind, input, taskRunId);
      return { text: '{"verdict":"pass"}', task_run_id: taskRunId };
    };

    const result = await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: preparationJobIdOf(opened),
      },
      { runTaskFn: passThenInvalid, authorPackageFn: authorInterventionPackage },
    );

    expect(result).toMatchObject({
      status: 'preparation_failed',
      reason_code: 'review_output_invalid',
    });
    const failed = await loadInterventionVersion(db, opened.id, opened.version);
    expect(failed?.preparation_attempts).toEqual([
      expect.objectContaining({
        kind: 'author_failed',
        failure_code: 'review_output_invalid',
        validator_task_run_ids: expect.arrayContaining([
          'review_run_1',
          'review_contract_invalid_2',
        ]),
      }),
      expect.objectContaining({
        kind: 'author_failed',
        failure_code: 'review_output_invalid',
        validator_task_run_ids: expect.arrayContaining([
          'review_run_3',
          'review_contract_invalid_4',
        ]),
      }),
    ]);
    const reviewRows = await db
      .select({ id: ai_task_runs.id, result_digest: ai_task_runs.result_digest })
      .from(ai_task_runs)
      .where(
        inArray(ai_task_runs.id, [
          'review_run_1',
          'review_contract_invalid_2',
          'review_run_3',
          'review_contract_invalid_4',
        ]),
      );
    expect(reviewRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'review_run_1',
          result_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        expect.objectContaining({ id: 'review_contract_invalid_2', result_digest: null }),
        expect.objectContaining({
          id: 'review_run_3',
          result_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        expect.objectContaining({ id: 'review_contract_invalid_4', result_digest: null }),
      ]),
    );
  });

  it('fails closed after two comparator contract misses per package attempt', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('review_contract_exhausted');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      env: {},
      bossSend: async () => 'prepare_job_review_contract_exhausted',
    });
    const [opened] = await db.select().from(intervention);
    const { fn: baseRun, calls } = successfulRunTask(db);
    const invalidReviews: TaskTextRunFn = async (kind, input, ctx) => {
      if (kind !== 'InterventionPackageReviewTask') return baseRun(kind, input, ctx);
      calls.push(kind);
      const ordinal = calls.filter((value) => value === kind).length;
      const taskRunId = `review_invalid_contract_${ordinal}`;
      await recordMockAiRun(db, kind, input, taskRunId);
      return { text: '{"verdict":"pass"}', task_run_id: taskRunId };
    };

    const result = await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: preparationJobIdOf(opened),
      },
      { runTaskFn: invalidReviews, authorPackageFn: authorInterventionPackage },
    );

    expect(result).toMatchObject({
      status: 'preparation_failed',
      reason_code: 'review_output_invalid',
    });
    expect(calls.filter((kind) => kind === 'InterventionPackageReviewTask')).toHaveLength(4);
    const failed = await loadInterventionVersion(db, opened.id, opened.version);
    expect(failed?.preparation_attempts).toHaveLength(2);
    expect(failed?.preparation_attempts).toEqual([
      expect.objectContaining({
        kind: 'author_failed',
        failure_code: 'review_output_invalid',
        validator_task_run_ids: expect.arrayContaining([
          'review_invalid_contract_1',
          'review_invalid_contract_2',
        ]),
      }),
      expect.objectContaining({
        kind: 'author_failed',
        failure_code: 'review_output_invalid',
        validator_task_run_ids: expect.arrayContaining([
          'review_invalid_contract_3',
          'review_invalid_contract_4',
        ]),
      }),
    ]);
  });

  it('rebinds a persisted FULL pass on recovery and spends only the remaining attempt slot', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('persisted_full_rebind_retry');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      env: {},
      bossSend: async () => 'prepare_job_persisted_full_rebind_retry',
    });
    const [opened] = await db.select().from(intervention);
    const record = await loadInterventionVersion(db, opened.id, opened.version);
    if (!record) throw new Error('intervention disappeared');
    const recommended = await saveRecommendation(
      db,
      record,
      concreteRecommendation('persisted_full_rebind_recommendation'),
    );
    const { fn, calls } = successfulRunTask(db);
    const attempt1 = await authorInterventionPackage(db, recommended.id, {
      attempt: 1,
      runTaskFn: fn,
      preparationJobId: preparationJobIdOf(recommended),
    });
    if (
      attempt1.kind !== 'reviewed_package' ||
      !('independent_solution_audit' in attempt1.review)
    ) {
      throw new Error('missing first FULL attempt');
    }
    await appendPreparationAttempt(db, recommended, attempt1);
    await db.delete(ai_task_runs).where(eq(ai_task_runs.id, attempt1.review.review_task_run_id));

    const result = await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: preparationJobIdOf(opened),
      },
      { runTaskFn: fn, authorPackageFn: authorInterventionPackage },
    );

    expect(result).toMatchObject({ status: 'active' });
    expect(calls.filter((kind) => kind === 'InterventionPackageAuthorTask')).toHaveLength(2);
    const active = await loadInterventionVersion(db, opened.id, opened.version);
    expect(active?.package).toMatchObject({ author_task_run_id: 'author_run_2' });
    expect(active?.preparation_attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
  });

  it('does not reset the package budget when a persisted final FULL pass loses provenance', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('persisted_full_rebind_exhausted');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      env: {},
      bossSend: async () => 'prepare_job_persisted_full_rebind_exhausted',
    });
    const [opened] = await db.select().from(intervention);
    const record = await loadInterventionVersion(db, opened.id, opened.version);
    if (!record) throw new Error('intervention disappeared');
    const recommended = await saveRecommendation(
      db,
      record,
      concreteRecommendation('persisted_full_rebind_exhausted_recommendation'),
    );
    const withFirst = await appendPreparationAttempt(
      db,
      recommended,
      InterventionPreparationAttempt.parse({
        kind: 'author_failed',
        attempt: 1,
        failure_code: 'seeded_first_attempt_failure',
      }),
    );
    const { fn } = successfulRunTask(db);
    const attempt2 = await authorInterventionPackage(db, recommended.id, {
      attempt: 2,
      runTaskFn: fn,
      preparationJobId: preparationJobIdOf(recommended),
    });
    if (
      attempt2.kind !== 'reviewed_package' ||
      !('independent_solution_audit' in attempt2.review)
    ) {
      throw new Error('missing second FULL attempt');
    }
    await appendPreparationAttempt(db, withFirst, attempt2);
    await db.delete(ai_task_runs).where(eq(ai_task_runs.id, attempt2.review.review_task_run_id));

    const result = await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: preparationJobIdOf(opened),
      },
      {
        runTaskFn: async () => {
          throw new Error('exhausted recovery must not call the model');
        },
        authorPackageFn: async () => {
          throw new Error('exhausted recovery must not call QuestionAuthor');
        },
      },
    );

    expect(result).toMatchObject({
      status: 'preparation_failed',
      reason_code: 'package_quality:agency:review_task_run_invalid',
    });
    const failed = await loadInterventionVersion(db, opened.id, opened.version);
    expect(failed?.preparation_attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
  });

  it('reads a historical FULL audit but refuses to activate it as a current FULL review', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('historical_full_review_rebound');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      env: {},
      bossSend: async () => 'prepare_job_historical_full_review_rebound',
    });
    const [opened] = await db.select().from(intervention);
    const record = await loadInterventionVersion(db, opened.id, opened.version);
    if (!record) throw new Error('intervention disappeared');
    const recommended = await saveRecommendation(
      db,
      record,
      concreteRecommendation('historical_full_review_recommendation'),
    );
    const withFirst = await appendPreparationAttempt(
      db,
      recommended,
      InterventionPreparationAttempt.parse({
        kind: 'author_failed',
        attempt: 1,
        failure_code: 'seeded_first_attempt_failure',
      }),
    );
    const { fn } = successfulRunTask(db);
    const currentAttempt = await authorInterventionPackage(db, recommended.id, {
      attempt: 2,
      runTaskFn: fn,
      preparationJobId: preparationJobIdOf(recommended),
    });
    if (
      currentAttempt.kind !== 'reviewed_package' ||
      !('independent_solution_audit' in currentAttempt.review)
    ) {
      throw new Error('missing current FULL attempt');
    }

    const currentReview = CurrentInterventionPackageReviewAudit.parse(currentAttempt.review);
    const {
      audit_protocol_version: _auditProtocolVersion,
      question_content_validation_audit: _questionContentValidationAudit,
      review_attempts: _reviewAttemptAudits,
      review_attempt_task_run_ids: _reviewAttempts,
      ...historicalReviewOuter
    } = structuredClone(currentReview);
    const historicalCandidate = {
      ...structuredClone(currentAttempt),
      review: {
        ...historicalReviewOuter,
        independent_solution_audit: {
          ...historicalReviewOuter.independent_solution_audit,
          diagnostics: historicalReviewOuter.independent_solution_audit.diagnostics.map(
            ({ required_operations: _requiredOperations, ...diagnostic }) => diagnostic,
          ),
        },
        result: {
          ...historicalReviewOuter.result,
          diagnostic_checks: historicalReviewOuter.result.diagnostic_checks.map(
            ({ required_operation_checks: _operationChecks, ...check }) => {
              const {
                reference_claimed_reverse_cause_relation: _relation,
                reference_reverse_causation_claim_checks: _claimChecks,
                ...historicalCausalDirectionCheck
              } = check.causal_direction_check;
              return { ...check, causal_direction_check: historicalCausalDirectionCheck };
            },
          ),
        },
      },
    };
    const historicalAttempt = InterventionPreparationAttempt.parse(historicalCandidate);
    if (
      historicalAttempt.kind !== 'reviewed_package' ||
      !('independent_solution_audit' in historicalAttempt.review)
    ) {
      throw new Error('historical FULL audit did not remain readable');
    }
    await db
      .update(ai_task_runs)
      .set({ result_digest: sha256CanonicalJson(historicalAttempt.review.result) })
      .where(eq(ai_task_runs.id, historicalAttempt.review.review_task_run_id));
    const withHistorical = await appendPreparationAttempt(db, withFirst, historicalAttempt);
    expect(withHistorical.preparation_attempts).toHaveLength(2);

    const result = await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: preparationJobIdOf(opened),
      },
      {
        runTaskFn: async () => {
          throw new Error('exhausted historical recovery must not call the model');
        },
        authorPackageFn: async () => {
          throw new Error('exhausted historical recovery must not call QuestionAuthor');
        },
      },
    );

    expect(result).toMatchObject({
      status: 'preparation_failed',
      reason_code: 'package_quality:agency:current_full_review_required',
    });
    const failed = await loadInterventionVersion(db, opened.id, opened.version);
    expect(failed).toMatchObject({
      status: 'preparation_failed',
      failure_code: 'package_quality:agency:current_full_review_required',
    });
    expect(failed?.preparation_attempts[1]).toMatchObject({ kind: 'reviewed_package' });
  });

  it('consumes one real review per window, retires one-shot cards, and settles deterministically', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('settlement');
    expect(seeded.probeResolution).toBe('evidence_for');
    const [sourceProbeResult] = await db
      .select({ payload: event.payload })
      .from(event)
      .where(eq(event.id, seeded.probeResultId));
    expect(sourceProbeResult?.payload).toMatchObject({
      resolution: 'evidence_for',
      response_judgement: {
        answer_result: 'incorrect',
        target_error_match: 'matched',
        gradable: true,
      },
    });
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      env: { AUTO_INTERVENTION_EXPANSION_ENABLED: 'true' },
      bossSend: async (_name, _data, options) => options.id,
    });
    const [opened] = await db.select().from(intervention);
    const { fn } = successfulRunTask(db);
    const activationNow = new Date(Math.floor(Date.now() / 1000) * 1000);
    const activationDate = activationNow.toLocaleDateString('sv-SE', {
      timeZone: 'Asia/Shanghai',
    });
    await db.insert(practice_stream_item).values({
      id: 'stream_existing_before_intervention',
      date: activationDate,
      position: 1,
      item_kind: 'question',
      ref_id: 'probe_settlement',
      source: 'decay',
      status: 'pending',
      reasoning: 'existing daily item',
      added_by: 'composer_live',
      signals: {},
      created_at: activationNow,
      updated_at: activationNow,
    });
    await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: preparationJobIdOf(opened),
      },
      {
        runTaskFn: fn,
        authorPackageFn: authorInterventionPackage,
        now: () => activationNow,
      },
    );
    const active = await loadInterventionVersion(db, opened.id, opened.version);
    expect(active?.status).toBe('active');
    expect(active?.delivery_mode).toBe('eligible');
    if (!active?.settlement) throw new Error('active intervention has no settlement schedule');
    const diagnosticQuestions = await db
      .select({
        id: question.id,
        prompt_md: question.prompt_md,
        source: question.source,
        judge_kind_override: question.judge_kind_override,
        draft_status: question.draft_status,
        metadata: question.metadata,
      })
      .from(question)
      .where(eq(question.source, 'intervention_diagnostic'));
    expect(diagnosticQuestions).toHaveLength(3);
    const immediateQuestion = diagnosticQuestions.find(
      (row) => row.id === active.settlement?.diagnostics.immediate.question_id,
    );
    expect(immediateQuestion?.prompt_md).toBe(
      [
        '# 链式法则：外层导数乘以内层导数',
        '先识别外层 sin(u)，再求 cos(u)；随后对 u=x² 求 2x，最后把两者相乘。',
        '---',
        '## 立即检验',
        '求 y=exp(x²+1) 的导数。',
      ].join('\n\n'),
    );
    expect(diagnosticQuestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'intervention_diagnostic',
          judge_kind_override: 'multimodal_direct',
          metadata: expect.objectContaining({
            intervention_diagnostic: expect.objectContaining({
              intervention_id: active.id,
            }),
            probe_spec: expect.any(Object),
          }),
        }),
      ]),
    );
    expect(
      diagnosticQuestions
        .filter((row) => row.id !== active.settlement?.diagnostics.immediate.question_id)
        .map((row) => row.draft_status),
    ).toEqual(['draft', 'draft']);
    const liveStream = await db
      .select({
        ref_id: practice_stream_item.ref_id,
        position: practice_stream_item.position,
        source: practice_stream_item.source,
        signals: practice_stream_item.signals,
      })
      .from(practice_stream_item)
      .where(
        and(
          eq(practice_stream_item.date, activationDate),
          sql`${practice_stream_item.session_id} IS NULL`,
        ),
      );
    expect(liveStream).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref_id: active.settlement.diagnostics.immediate.question_id,
          position: 2,
          source: 'intervention',
          signals: expect.objectContaining({
            interventionDelivery: expect.objectContaining({
              interventionId: active.id,
              interventionVersion: active.version,
              diagnosticKind: 'immediate',
            }),
          }),
        }),
      ]),
    );
    await db
      .update(practice_stream_item)
      .set({ status: 'skipped', updated_at: activationNow })
      .where(eq(practice_stream_item.ref_id, active.settlement.diagnostics.immediate.question_id));
    await recoverEligibleInterventionDiagnostics(db, activationNow);
    const [repairedDelivery] = await db
      .select({ status: practice_stream_item.status })
      .from(practice_stream_item)
      .where(eq(practice_stream_item.ref_id, active.settlement.diagnostics.immediate.question_id));
    expect(repairedDelivery?.status).toBe('pending');
    const dueResponse = await handleReviewDue(
      new Request('http://localhost/api/review/due?limit=20'),
      { listActiveGoalsFn: async () => [] },
    );
    expect(dueResponse.status).toBe(200);
    const dueBody = (await dueResponse.json()) as {
      rows: Array<{ question_id: string }>;
    };
    expect(dueBody.rows.map((row) => row.question_id)).toEqual([
      active.settlement.diagnostics.immediate.question_id,
    ]);

    const staleClaimedAt = new Date(
      activationNow.getTime() - INTERVENTION_DIAGNOSTIC_CLAIM_LEASE_MS - 1,
    );
    await db
      .update(question)
      .set({ draft_status: 'draft', updated_at: staleClaimedAt })
      .where(eq(question.id, active.settlement.diagnostics.immediate.question_id));
    await expect(recoverEligibleInterventionDiagnostics(db, activationNow)).resolves.toEqual({
      scanned: 1,
      ensured: 1,
      raced: 0,
      failed: 0,
    });
    const [reclaimedSynchronousCrash] = await db
      .select({ draft_status: question.draft_status })
      .from(question)
      .where(eq(question.id, active.settlement.diagnostics.immediate.question_id));
    expect(reclaimedSynchronousCrash?.draft_status).toBe('active');

    const immediate = active.settlement.diagnostics.immediate;
    const delayed = active.settlement.diagnostics.delayed;
    await db
      .update(question)
      .set({ draft_status: 'draft', updated_at: staleClaimedAt })
      .where(eq(question.id, immediate.question_id));
    await db.insert(event).values({
      id: 'pending_durable_diagnostic_guard',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:judge_pending_attempt',
      subject_kind: 'question',
      subject_id: immediate.question_id,
      outcome: null,
      payload: { run_id: 'pending_durable_diagnostic_run' },
      created_at: staleClaimedAt,
    });
    await recoverEligibleInterventionDiagnostics(db, activationNow);
    const [durableClaimStillFenced] = await db
      .select({ draft_status: question.draft_status })
      .from(question)
      .where(eq(question.id, immediate.question_id));
    expect(durableClaimStillFenced?.draft_status).toBe('draft');
    await db.insert(job_events).values({
      business_table: JUDGE_RUN_TABLE,
      business_id: 'pending_durable_diagnostic_run',
      event_type: JUDGE_RUN_EVENTS.FAILED,
      payload: { reason: 'retries_exhausted' },
    });
    await recoverEligibleInterventionDiagnostics(db, activationNow);
    const [terminalAttemptReleased] = await db
      .select({ draft_status: question.draft_status })
      .from(question)
      .where(eq(question.id, immediate.question_id));
    expect(terminalAttemptReleased?.draft_status).toBe('active');

    await db
      .update(question)
      .set({ draft_status: 'draft', updated_at: staleClaimedAt })
      .where(eq(question.id, immediate.question_id));
    await db.insert(job_events).values({
      business_table: JUDGE_RUN_TABLE,
      business_id: 'pending_durable_diagnostic_run',
      event_type: JUDGE_RUN_EVENTS.REQUEUED,
      payload: { delivery_id: 'pending_durable_diagnostic_recovery' },
    });
    await recoverEligibleInterventionDiagnostics(db, activationNow);
    const [reopenedAttemptStillFenced] = await db
      .select({ draft_status: question.draft_status })
      .from(question)
      .where(eq(question.id, immediate.question_id));
    expect(reopenedAttemptStillFenced?.draft_status).toBe('draft');

    await db.delete(job_events).where(eq(job_events.business_id, 'pending_durable_diagnostic_run'));
    await db.delete(event).where(eq(event.id, 'pending_durable_diagnostic_guard'));
    await db
      .update(question)
      .set({ draft_status: 'active', updated_at: activationNow })
      .where(eq(question.id, immediate.question_id));

    const [delayedCard] = await db
      .select({ state: material_fsrs_state.state })
      .from(material_fsrs_state)
      .where(eq(material_fsrs_state.subject_id, delayed.question_id));
    expect(delayedCard).toBeUndefined();
    const [immediateCard] = await db
      .select({ state: material_fsrs_state.state })
      .from(material_fsrs_state)
      .where(eq(material_fsrs_state.subject_id, immediate.question_id));
    if (!immediateCard) throw new Error('missing immediate diagnostic card');
    const preExposureAfterProvisionalDue = new Date(
      activationNow.getTime() + 8 * 24 * 60 * 60 * 1000,
    );
    await writeEvent(db, {
      id: 'review_settlement_delayed_too_early',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'review',
      subject_kind: 'question',
      subject_id: delayed.question_id,
      outcome: 'success',
      payload: {
        fsrs_rating: 'good',
        fsrs_state_after: immediateCard.state,
        user_response_md: '提前直连作答',
        referenced_knowledge_ids: [],
        judge: diagnosticJudgeVerdict('correct'),
      },
      created_at: preExposureAfterProvisionalDue,
    });
    await writeEvent(db, {
      id: 'judge_settlement_delayed_too_early',
      actor_kind: 'agent',
      actor_ref: 'review_judge',
      action: 'judge',
      subject_kind: 'event',
      subject_id: 'review_settlement_delayed_too_early',
      outcome: 'success',
      payload: diagnosticJudgeEventPayload('correct'),
      caused_by_event_id: 'review_settlement_delayed_too_early',
      created_at: preExposureAfterProvisionalDue,
    });
    await expect(
      handleInterventionDiagnosticJudgeDelivery(db, {
        subscriberId: 'agency.intervention-diagnostic-review-settlement',
        subscriberVersion: 2,
        deliverySeq: 'pre-due',
        sourceEventId: 'judge_settlement_delayed_too_early',
      }),
    ).resolves.toMatchObject({ status: 'skipped', reason: 'intervention_not_exposed' });
    await expect(loadInterventionVersion(db, opened.id, opened.version)).resolves.toMatchObject({
      status: 'active',
      settlement: { diagnostics: { delayed: { status: 'scheduled', review_event_id: null } } },
    });

    const verdicts = {
      immediate: { eventOutcome: 'success', rating: 'good', judge: 'correct' },
      // A learner-controlled `hard` rating still writes outcome=success. The
      // diagnostic verdict must follow judge=partial and settle as failed.
      delayed: { eventOutcome: 'success', rating: 'hard', judge: 'partial' },
      transfer: { eventOutcome: 'success', rating: 'good', judge: 'correct' },
    } as const;
    let lastDelivery: EventSubscriptionDelivery | null = null;
    for (const kind of ['immediate', 'delayed', 'transfer'] as const) {
      const beforeReview = await loadInterventionVersion(db, opened.id, opened.version);
      if (!beforeReview?.settlement) throw new Error('intervention settlement disappeared');
      const scheduled = beforeReview.settlement.diagnostics[kind];
      const reviewEventId = `review_settlement_${kind}`;
      const reviewedAt =
        kind === 'immediate'
          ? new Date(activationNow.getTime() + 10 * 24 * 60 * 60 * 1000 + 500)
          : new Date(scheduled.due_at.replace('.000Z', '.500Z'));
      const [cardBeforeReview] = await db
        .select({ state: material_fsrs_state.state })
        .from(material_fsrs_state)
        .where(eq(material_fsrs_state.subject_id, scheduled.question_id))
        .limit(1);
      if (!cardBeforeReview) throw new Error(`missing ${kind} diagnostic card`);
      await writeEvent(db, {
        id: reviewEventId,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'review',
        subject_kind: 'question',
        subject_id: scheduled.question_id,
        outcome: verdicts[kind].eventOutcome,
        payload: {
          fsrs_rating: verdicts[kind].rating,
          fsrs_state_after: cardBeforeReview.state,
          user_response_md: kind === 'delayed' ? '部分正确但仍有遗漏' : '作答正确',
          referenced_knowledge_ids: [],
          judge: diagnosticJudgeVerdict(verdicts[kind].judge),
        },
        created_at: reviewedAt,
      });
      if (kind === 'immediate') {
        await writeEvent(db, {
          id: 'judge_settlement_immediate_unverified',
          actor_kind: 'agent',
          actor_ref: 'review_judge',
          action: 'judge',
          subject_kind: 'event',
          subject_id: reviewEventId,
          outcome: 'success',
          payload: diagnosticJudgeEventPayload('correct', 'supplied_unverified'),
          caused_by_event_id: reviewEventId,
          created_at: new Date(reviewedAt.getTime() + 1),
        });
        await expect(
          handleInterventionDiagnosticJudgeDelivery(db, {
            subscriberId: 'agency.intervention-diagnostic-review-settlement',
            subscriberVersion: 2,
            deliverySeq: 'unverified',
            sourceEventId: 'judge_settlement_immediate_unverified',
          }),
        ).resolves.toMatchObject({
          status: 'skipped',
          reason: 'diagnostic has no active trusted judge verdict',
        });
      }
      const verdictEventId = `judge_settlement_${kind}`;
      await writeEvent(db, {
        id: verdictEventId,
        actor_kind: 'agent',
        actor_ref: 'review_judge',
        action: 'judge',
        subject_kind: 'event',
        subject_id: reviewEventId,
        outcome: 'success',
        payload: diagnosticJudgeEventPayload(verdicts[kind].judge),
        caused_by_event_id: reviewEventId,
        created_at: new Date(reviewedAt.getTime() + 2),
      });
      lastDelivery = {
        subscriberId: 'agency.intervention-diagnostic-review-settlement',
        subscriberVersion: 2,
        deliverySeq: String(kind === 'immediate' ? 1 : kind === 'delayed' ? 2 : 3),
        sourceEventId: verdictEventId,
      };
      const result = await handleInterventionDiagnosticJudgeDelivery(db, lastDelivery);
      expect(result.status).toBe('succeeded');
      if (kind === 'immediate') {
        const afterExposure = await loadInterventionVersion(db, opened.id, opened.version);
        if (!afterExposure?.settlement) throw new Error('anchored settlement disappeared');
        const exposureAt = reviewedAt.getTime();
        expect(afterExposure.settlement.diagnostics.delayed.due_at).toBe(
          new Date(exposureAt + 7 * 24 * 60 * 60 * 1000).toISOString(),
        );
        expect(afterExposure.settlement.diagnostics.transfer.due_at).toBe(
          new Date(exposureAt + 21 * 24 * 60 * 60 * 1000).toISOString(),
        );
        const anchoredCards = await db
          .select({
            subject_id: material_fsrs_state.subject_id,
            due_at: material_fsrs_state.due_at,
          })
          .from(material_fsrs_state)
          .where(
            inArray(material_fsrs_state.subject_id, [
              afterExposure.settlement.diagnostics.delayed.question_id,
              afterExposure.settlement.diagnostics.transfer.question_id,
            ]),
          );
        expect(anchoredCards).toEqual(
          expect.arrayContaining([
            {
              subject_id: afterExposure.settlement.diagnostics.delayed.question_id,
              due_at: new Date(afterExposure.settlement.diagnostics.delayed.due_at),
            },
            {
              subject_id: afterExposure.settlement.diagnostics.transfer.question_id,
              due_at: new Date(afterExposure.settlement.diagnostics.transfer.due_at),
            },
          ]),
        );
        const nextDay = new Date(reviewedAt.getTime() + 24 * 60 * 60 * 1000);
        const nextDate = nextDay.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
        await db.insert(practice_stream_item).values({
          id: 'stream_existing_after_immediate_completion',
          date: nextDate,
          position: 1,
          item_kind: 'question',
          ref_id: delayed.question_id,
          source: 'decay',
          status: 'pending',
          reasoning: 'next-day stream anchor',
          added_by: 'composer_live',
          signals: {},
          created_at: nextDay,
          updated_at: nextDay,
        });
        expect(await recoverEligibleInterventionDiagnostics(db, nextDay)).toEqual({
          scanned: 1,
          ensured: 1,
          raced: 0,
          failed: 0,
        });
        const immediateDeliveries = await db
          .select({ date: practice_stream_item.date })
          .from(practice_stream_item)
          .where(
            and(
              eq(practice_stream_item.ref_id, active.settlement.diagnostics.immediate.question_id),
              eq(practice_stream_item.source, 'intervention'),
            ),
          );
        expect(immediateDeliveries).toEqual([{ date: activationDate }]);
      }
      if (kind === 'delayed') {
        const rejudgeEventId = 'judge_settlement_delayed_rejudge';
        await writeEvent(db, {
          id: rejudgeEventId,
          actor_kind: 'agent',
          actor_ref: 'rejudge',
          action: 'judge',
          subject_kind: 'event',
          subject_id: reviewEventId,
          outcome: 'success',
          payload: diagnosticJudgeEventPayload('correct'),
          caused_by_event_id: reviewEventId,
          created_at: new Date(reviewedAt.getTime() + 3),
        });
        await writeEvent(db, {
          id: 'correct_settlement_delayed_judge',
          actor_kind: 'user',
          actor_ref: 'self',
          action: 'correct',
          subject_kind: 'event',
          subject_id: verdictEventId,
          outcome: 'success',
          payload: {
            correction_kind: 'supersede',
            replacement_event_id: rejudgeEventId,
            reason_md: '申诉重判改为正确。',
            affected_refs: [{ kind: 'question', id: scheduled.question_id }],
          },
          caused_by_event_id: rejudgeEventId,
          created_at: new Date(reviewedAt.getTime() + 4),
        });
        await expect(
          handleInterventionDiagnosticJudgeDelivery(db, {
            subscriberId: 'agency.intervention-diagnostic-review-settlement',
            subscriberVersion: 2,
            deliverySeq: 'rejudge-delayed',
            sourceEventId: rejudgeEventId,
          }),
        ).resolves.toMatchObject({
          status: 'succeeded',
          detail: { idempotent: false, verdict_event_id: rejudgeEventId },
        });
        await expect(loadInterventionVersion(db, opened.id, opened.version)).resolves.toMatchObject(
          {
            status: 'active',
            settlement: {
              diagnostics: {
                delayed: {
                  status: 'passed',
                  review_event_id: reviewEventId,
                  verdict_event_id: rejudgeEventId,
                },
              },
            },
          },
        );
      }
      const card = await db
        .select({ id: material_fsrs_state.id })
        .from(material_fsrs_state)
        .where(eq(material_fsrs_state.subject_id, scheduled.question_id));
      expect(card).toHaveLength(0);
      const [retiredQuestion] = await db
        .select({ draft_status: question.draft_status })
        .from(question)
        .where(eq(question.id, scheduled.question_id));
      expect(retiredQuestion?.draft_status).toBe('draft');
    }

    const settled = await loadInterventionVersion(db, opened.id, opened.version);
    expect(settled).toMatchObject({
      status: 'settled',
      outcome: 'effective',
      settlement: {
        diagnostics: {
          immediate: {
            status: 'passed',
            review_event_id: 'review_settlement_immediate',
            verdict_event_id: 'judge_settlement_immediate',
          },
          delayed: {
            status: 'passed',
            review_event_id: 'review_settlement_delayed',
            verdict_event_id: 'judge_settlement_delayed_rejudge',
          },
          transfer: {
            status: 'passed',
            review_event_id: 'review_settlement_transfer',
            verdict_event_id: 'judge_settlement_transfer',
          },
        },
      },
    });
    const settledEvents = await db
      .select({ value: count() })
      .from(event)
      .where(eq(event.action, 'experimental:intervention_settled'));
    expect(settledEvents[0]?.value).toBe(1);
    const afterSettlementDue = await handleReviewDue(
      new Request('http://localhost/api/review/due?limit=20'),
      { listActiveGoalsFn: async () => [] },
    );
    expect(afterSettlementDue.status).toBe(200);
    const afterSettlementBody = (await afterSettlementDue.json()) as {
      rows: Array<{ question_id: string }>;
    };
    const afterSettlementQuestionIds = afterSettlementBody.rows.map((row) => row.question_id);
    for (const diagnostic of Object.values(active.settlement.diagnostics)) {
      expect(afterSettlementQuestionIds).not.toContain(diagnostic.question_id);
    }

    if (!lastDelivery) throw new Error('missing replay delivery');
    const replay = await handleInterventionDiagnosticJudgeDelivery(db, lastDelivery);
    expect(replay).toMatchObject({
      status: 'succeeded',
      detail: { idempotent: true, intervention_status: 'settled' },
    });
  });

  it('keyset-recovers every eligible row beyond the 100-row batch boundary', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('recovery-page');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      env: { AUTO_INTERVENTION_EXPANSION_ENABLED: 'true' },
      bossSend: async (_name, _data, options) => options.id,
    });
    const [opened] = await db.select().from(intervention);
    const { fn } = successfulRunTask(db);
    await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: preparationJobIdOf(opened),
      },
      { runTaskFn: fn, authorPackageFn: authorInterventionPackage },
    );
    const active = await loadInterventionVersion(db, opened.id, opened.version);
    if (
      !active ||
      !active.package ||
      !active.recommendation ||
      !active.settlement ||
      !active.activated_at
    ) {
      throw new Error('eligible recovery fixture did not activate');
    }
    const activatedAt = active.activated_at;

    const cloneCount = 100;
    const cloneIds = Array.from({ length: cloneCount }, (_, index) => `recovery_clone_${index}`);
    const cloneEvents: Array<typeof event.$inferInsert> = cloneIds.map((id, index) => ({
      id: `probe_result_${id}`,
      actor_kind: 'system',
      actor_ref: 'mind_probe',
      action: 'experimental:probe_result',
      subject_kind: 'question',
      subject_id: `probe_recovery_${index}`,
      payload: {
        conjecture_event_id: active.conjecture_event_id,
        outcome: 0,
        resolution: 'evidence_for',
        response_judgement: {
          rule_version: 'conjecture_probe_response_signature_v1',
          answer_result: 'incorrect',
          target_error_match: 'matched',
          gradable: true,
          reason_code: 'target_error_signature_matched',
          signature_match_explanation_md: 'recovery pagination fixture',
          evidence_refs: ['learner_response'],
        },
      },
      caused_by_event_id: active.conjecture_event_id,
      created_at: activatedAt,
    }));
    await db.insert(event).values(cloneEvents);
    const cloneInterventions: Array<typeof intervention.$inferInsert> = cloneIds.map((id) => ({
      id,
      version: 1,
      revision: 1,
      source_probe_result_event_id: `probe_result_${id}`,
      conjecture_event_id: active.conjecture_event_id,
      status: 'active',
      delivery_mode: 'eligible',
      outcome: null,
      idempotency_key: `recovery_key_${id}`,
      preparation_job_id: null,
      snapshot_json: {
        ...active.snapshot,
        intervention_id: id,
        intervention_version: 1,
        source_probe_result_event_id: `probe_result_${id}`,
      },
      recommendation_json: active.recommendation,
      package_json: {
        ...active.package,
        intervention_id: id,
        intervention_version: 1,
      },
      settlement_json: buildInterventionSettlement({
        interventionId: id,
        version: 1,
        activatedAt,
      }),
      preparation_attempts_json: active.preparation_attempts,
      failure_code: null,
      created_at: activatedAt,
      updated_at: activatedAt,
      activated_at: activatedAt,
    }));
    await db.insert(intervention).values(cloneInterventions);
    await db.delete(material_fsrs_state).where(eq(material_fsrs_state.subject_kind, 'question'));
    await db.delete(question).where(eq(question.source, 'intervention_diagnostic'));
    const recoveryNow = new Date(activatedAt.getTime() + 24 * 60 * 60 * 1000);
    const recoveryDate = recoveryNow.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    await db.insert(practice_stream_item).values({
      id: 'recovery_day_existing_stream',
      date: recoveryDate,
      position: 1,
      item_kind: 'question',
      ref_id: 'recovery_day_existing_question',
      source: 'decay',
      status: 'pending',
      reasoning: 'recovery date anchor',
      added_by: 'composer_live',
      signals: {},
      created_at: recoveryNow,
      updated_at: recoveryNow,
    });

    await expect(recoverEligibleInterventionDiagnostics(db, recoveryNow)).resolves.toEqual({
      scanned: 101,
      ensured: 101,
      raced: 0,
      failed: 0,
    });
    const recoveredQuestions = await db
      .select({ value: count() })
      .from(question)
      .where(eq(question.source, 'intervention_diagnostic'));
    const recoveredCards = await db
      .select({ value: count() })
      .from(material_fsrs_state)
      .where(eq(material_fsrs_state.subject_kind, 'question'));
    expect(recoveredQuestions[0]?.value).toBe(303);
    // Only the immediate delivery is due before exposure; +7/+21 follow-ups
    // remain draft questions with no FSRS card until that review is recorded.
    expect(recoveredCards[0]?.value).toBe(101);
    const [recoveredImmediateStreamRow] = await db
      .select({ date: practice_stream_item.date, source: practice_stream_item.source })
      .from(practice_stream_item)
      .where(eq(practice_stream_item.ref_id, active.settlement.diagnostics.immediate.question_id));
    expect(recoveredImmediateStreamRow).toEqual({
      date: recoveryDate,
      source: 'intervention',
    });
  });

  it('retries the whole package once then fails closed without a partial package', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('b');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      env: {},
      bossSend: async () => 'prepare_job_b',
    });
    const [opened] = await db.select().from(intervention);
    const { fn: baseRun, calls } = successfulRunTask(db);
    const failingRun: TaskTextRunFn = async (kind, input, ctx) => {
      if (kind === 'InterventionPackageReviewTask') {
        calls.push(kind);
        const attempt = calls.filter((value) => value === kind).length;
        const taskRunId = `review_fail_${attempt}`;
        await recordMockAiRun(db, kind, input, taskRunId);
        return {
          text: '',
          task_run_id: taskRunId,
          structured_output: {
            review_protocol_version: 2,
            verdict: 'fail',
            failure_codes: ['answer_not_unique'],
            diagnostic_checks: comparatorDiagnosticChecks(input),
            package_checks: reviewPackageChecks({ answers_unique: false }),
            summary_md: '参考答案不是唯一可接受答案。',
          },
        };
      }
      return baseRun(kind, input, ctx);
    };
    const result = await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: preparationJobIdOf(opened),
      },
      { runTaskFn: failingRun, authorPackageFn: authorInterventionPackage },
    );
    expect(result).toMatchObject({
      status: 'preparation_failed',
      reason_code: 'package_quality:answer_not_unique',
    });
    const [failed] = await db.select().from(intervention);
    expect(failed.status).toBe('preparation_failed');
    expect(failed.package_json).toBeNull();
    expect(failed.preparation_attempts_json).toHaveLength(2);
    expect(calls.filter((kind) => kind === 'InterventionPackageAuthorTask')).toHaveLength(2);
    expect(calls.filter((kind) => kind === 'InterventionPackageReviewTask')).toHaveLength(2);
    const failedEvents = await db
      .select({ value: count() })
      .from(event)
      .where(eq(event.action, 'experimental:intervention_preparation_failed'));
    expect(failedEvents[0]?.value).toBe(1);
  });

  it('fails fast when the delayed blind solver violates its contract and never runs transfer/comparator', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('blind_fail_fast');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      env: {},
      bossSend: async () => 'prepare_job_blind_fail_fast',
    });
    const [opened] = await db.select().from(intervention);
    const { fn: baseRun, calls } = successfulRunTask(db);
    let solveInAttempt = 0;
    const incompleteDelayedSolver: TaskTextRunFn = async (kind, input, ctx) => {
      if (kind === 'InterventionPackageAuthorTask') solveInAttempt = 0;
      if (kind === 'SolutionGenerateTask') {
        solveInAttempt += 1;
        if (solveInAttempt === 2 || solveInAttempt === 3) {
          calls.push(kind);
          return {
            text: JSON.stringify({
              reference_solution: {
                final_answer: '只有 final answer，没有完整 validator contract',
                answer_equivalents: [],
              },
            }),
            task_run_id: `incomplete_delayed_${calls.filter((value) => value === kind).length}`,
          };
        }
      }
      return baseRun(kind, input, ctx);
    };

    const result = await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: preparationJobIdOf(opened),
      },
      { runTaskFn: incompleteDelayedSolver, authorPackageFn: authorInterventionPackage },
    );

    expect(result).toMatchObject({
      status: 'preparation_failed',
      reason_code: 'independent_solution_unavailable:delayed',
    });
    expect(calls.filter((kind) => kind === 'InterventionPackageAuthorTask')).toHaveLength(2);
    expect(calls.filter((kind) => kind === 'SolutionGenerateTask')).toHaveLength(6);
    expect(calls).not.toContain('InterventionPackageReviewTask');
    const [failed] = await db.select().from(intervention);
    expect(failed).toMatchObject({ status: 'preparation_failed', package_json: null });
    expect(failed.preparation_attempts_json).toEqual([
      expect.objectContaining({
        kind: 'author_failed',
        failure_code: 'independent_solution_unavailable:delayed',
        validator_task_run_ids: expect.arrayContaining([
          'independent_solution_run_1',
          'incomplete_delayed_2',
        ]),
      }),
      expect.objectContaining({
        kind: 'author_failed',
        failure_code: 'independent_solution_unavailable:delayed',
      }),
    ]);
  });

  it('rejects the area-as-length false pass twice and keeps the full reviewer audit without fallback', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('review_scope');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      env: {},
      bossSend: async () => 'prepare_job_review_scope',
    });
    const [opened] = await db.select().from(intervention);
    const [{ value: questionCountBefore }] = await db.select({ value: count() }).from(question);
    const areaAsLengthOutput = (attempt: number) => {
      const output = authorOutput(attempt);
      output.diagnostics.transfer.probe_spec = {
        ...output.diagnostics.transfer.probe_spec,
        prompt_md: '一个长方形的宽为 (w-4)，长为 -5(w-4)。求这个长方形的面积并化简。',
        reference_md: '-5w+20',
        gold_response_signature: { kind: 'text', response_md: '-5w+20' },
        expected_target_error_answer_md: '-5w-20',
        target_error_response_signature: { kind: 'text', response_md: '-5w-20' },
      };
      return output;
    };
    const { fn: baseRun, calls } = successfulRunTask(db, areaAsLengthOutput);
    const falsePassRun: TaskTextRunFn = async (kind, input, ctx) => {
      if (kind !== 'InterventionPackageReviewTask') return baseRun(kind, input, ctx);
      calls.push(kind);
      const attempt = calls.filter((value) => value === kind).length;
      const taskRunId = `review_scope_${attempt}`;
      await recordMockAiRun(db, kind, input, taskRunId);
      const checks = reviewDiagnosticChecks();
      checks[2] = {
        ...checks[2],
        independently_derived_answer_md: '-5(w-4)² = -5w²+40w-80',
        required_operations_md: '面积=长×宽，需要把两个含 w 的因式相乘。',
        reference_correct: false,
        within_frozen_scope: false,
        decision_basis_md: 'reference -5w+20 只化简了长度，没有回答面积；多项式乘法超出冻结范围。',
      };
      return {
        text: '',
        task_run_id: taskRunId,
        structured_output: {
          review_protocol_version: 2,
          // Regression: a contradictory bare pass cannot override the
          // reviewer's own independent reference/scope findings.
          verdict: 'pass',
          failure_codes: [],
          diagnostic_checks: comparatorDiagnosticChecks(input, checks),
          package_checks: reviewPackageChecks(),
          summary_md: '错误地自认证为通过。',
        },
      };
    };

    const result = await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: preparationJobIdOf(opened),
      },
      { runTaskFn: falsePassRun, authorPackageFn: authorInterventionPackage },
    );

    expect(result).toMatchObject({
      status: 'preparation_failed',
      reason_code: 'package_quality:claim_scope_expansion,reference_incorrect',
    });
    const [failed] = await db.select().from(intervention);
    expect(failed).toMatchObject({
      status: 'preparation_failed',
      package_json: null,
      settlement_json: null,
    });
    expect(failed.preparation_attempts_json).toHaveLength(2);
    for (const [index, rawAttempt] of failed.preparation_attempts_json.entries()) {
      const attempt = rawAttempt as {
        kind: string;
        package: Record<string, unknown>;
        review: {
          package_digest_sha256: string;
          review_task_run_id: string;
          result: {
            review_protocol_version: number;
            verdict: string;
            failure_codes: string[];
            diagnostic_checks: unknown[];
          };
        };
      };
      expect(attempt.kind).toBe('reviewed_package');
      expect(attempt.package).toMatchObject({ author_task_run_id: `author_run_${index + 1}` });
      expect(attempt.review).toMatchObject({
        review_task_run_id: `review_scope_${index + 1}`,
        result: {
          review_protocol_version: 2,
          verdict: 'fail',
          failure_codes: ['claim_scope_expansion', 'reference_incorrect'],
          diagnostic_checks: expect.arrayContaining([
            expect.objectContaining({
              kind: 'transfer',
              reference_correct: false,
              within_frozen_scope: false,
            }),
          ]),
        },
      });
      expect(attempt.review.package_digest_sha256).toBe(sha256CanonicalJson(attempt.package));
    }
    expect(calls.filter((kind) => kind === 'InterventionPackageAuthorTask')).toHaveLength(2);
    expect(calls.filter((kind) => kind === 'InterventionPackageReviewTask')).toHaveLength(2);
    const [{ value: questionCountAfter }] = await db.select({ value: count() }).from(question);
    expect(questionCountAfter).toBe(questionCountBefore);
    const [{ value: diagnosticCount }] = await db
      .select({ value: count() })
      .from(question)
      .where(eq(question.source, 'intervention_diagnostic'));
    expect(diagnosticCount).toBe(0);
  });

  it('rejects a self-consistent sealed hash when the blind input belongs to a different prompt', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('blind_input_swap');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      env: {},
      bossSend: async () => 'prepare_job_blind_input_swap',
    });
    const [opened] = await db.select().from(intervention);
    const { fn } = successfulRunTask(db);
    const swappedBlindInputAuthor: typeof authorInterventionPackage = async (...args) => {
      const attempt = await authorInterventionPackage(...args);
      if (
        attempt.kind !== 'reviewed_package' ||
        !('independent_solution_audit' in attempt.review)
      ) {
        return attempt;
      }
      const clone = structuredClone(attempt);
      if (!('independent_solution_audit' in clone.review)) return clone;
      const immediate = clone.review.independent_solution_audit.diagnostics.find(
        (diagnostic) => diagnostic.kind === 'immediate',
      );
      if (!immediate) throw new Error('missing immediate blind audit');
      immediate.task_input.prompt_md = '这是另一道题，但攻击者同时重算了 input hash。';
      immediate.question_input_sha256 = sha256CanonicalJson(immediate.task_input);
      return clone;
    };

    const result = await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: preparationJobIdOf(opened),
      },
      { runTaskFn: fn, authorPackageFn: swappedBlindInputAuthor },
    );

    expect(result).toMatchObject({
      status: 'preparation_failed',
      reason_code: expect.stringContaining('agency:immediate:independent_solution_input_mismatch'),
    });
    const [failed] = await db.select().from(intervention);
    expect(failed).toMatchObject({
      status: 'preparation_failed',
      package_json: null,
      settlement_json: null,
    });
  });

  it('treats a review without run provenance as a retryable package attempt failure', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('k');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      bossSend: async (_name, _data, options) => options.id,
    });
    const [opened] = await db.select().from(intervention);
    const { fn: baseRun, calls } = successfulRunTask(db);
    const missingReviewRun: TaskTextRunFn = async (kind, input, ctx) => {
      if (kind === 'InterventionPackageReviewTask') {
        calls.push(kind);
        return {
          text: '',
          structured_output: {
            verdict: 'pass',
            failure_codes: [],
            summary_md: '缺少持久化 run provenance，不能接纳。',
          },
        };
      }
      return baseRun(kind, input, ctx);
    };

    const result = await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: preparationJobIdOf(opened),
      },
      { runTaskFn: missingReviewRun, authorPackageFn: authorInterventionPackage },
    );

    expect(result).toMatchObject({
      status: 'preparation_failed',
      reason_code: 'review_task_run_id_missing',
    });
    const [failed] = await db.select().from(intervention);
    expect(failed.package_json).toBeNull();
    expect(failed.preparation_attempts_json).toEqual([
      expect.objectContaining({
        kind: 'author_failed',
        failure_code: 'review_task_run_id_missing',
      }),
      expect.objectContaining({
        kind: 'author_failed',
        failure_code: 'review_task_run_id_missing',
      }),
    ]);
  });

  it('replayed delivery re-enqueues recovery but never creates a second aggregate', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('a');
    let sendCount = 0;
    const reservedIds: string[] = [];
    const bossSend = async (
      _name: 'prepare_intervention',
      _data: unknown,
      options: { id: string },
    ) => {
      sendCount += 1;
      reservedIds.push(options.id);
      return sendCount === 1 ? options.id : null;
    };
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      bossSend,
    });
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      bossSend,
    });
    const rows = await db.select().from(intervention);
    expect(rows).toHaveLength(1);
    expect(rows[0].preparation_job_id).toBe(reservedIds[0]);
    expect(reservedIds[1]).toBe(reservedIds[0]);
    expect(sendCount).toBe(2);
  });

  it('fails closed when every deterministically safe pedagogy method is owner-disabled', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('c');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      env: {
        INTERVENTION_DISABLED_METHOD_IDS: PEDAGOGY_METHOD_LIBRARY.map((method) => method.id).join(
          ',',
        ),
      },
      bossSend: async (_name, _data, options) => options.id,
    });
    const [opened] = await db.select().from(intervention);
    let modelCalls = 0;
    const result = await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: preparationJobIdOf(opened),
      },
      {
        runTaskFn: async () => {
          modelCalls += 1;
          throw new Error('no safe method must abstain before a model call');
        },
        authorPackageFn: async () => {
          throw new Error('an abstaining recommendation must not invoke QuestionAuthor');
        },
      },
    );

    expect(result).toMatchObject({
      status: 'preparation_failed',
      reason_code: 'recommendation:no_safe_method',
    });
    expect(modelCalls).toBe(0);
    const [failed] = await db.select().from(intervention);
    expect(failed).toMatchObject({
      status: 'preparation_failed',
      package_json: null,
      failure_code: 'recommendation:no_safe_method',
    });
  });

  it('ignores legacy evidence_for events that lack a response-signature judgement', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('d', { includeResponseJudgement: false });
    let sends = 0;

    const result = await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      bossSend: async (_name, _data, options) => {
        sends += 1;
        return options.id;
      },
    });

    expect(result).toEqual({
      status: 'skipped',
      reason: 'probe result has no gradable target-error response signature match',
    });
    expect(sends).toBe(0);
    await expect(db.select().from(intervention)).resolves.toHaveLength(0);
  });

  it('ignores a source result corrected before subscription delivery', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('e');
    await writeEvent(db, {
      id: 'correct_probe_result_e',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: seeded.probeResultId,
      outcome: 'success',
      payload: {
        correction_kind: 'mark_wrong',
        reason_md: '该结果的目标错误匹配被人工判错。',
        affected_refs: [{ kind: 'question', id: 'probe_e' }],
      },
      created_at: new Date(seeded.now.getTime() + 3_000),
    });
    let sends = 0;

    const result = await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      bossSend: async (_name, _data, options) => {
        sends += 1;
        return options.id;
      },
    });

    expect(result).toEqual({
      status: 'skipped',
      reason: `probe result '${seeded.probeResultId}' is not effective active evidence`,
    });
    expect(sends).toBe(0);
    await expect(db.select().from(intervention)).resolves.toHaveLength(0);
  });

  it('terminalizes evidence corrected after enqueue before any paid model call', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('m');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      bossSend: async (_name, _data, options) => options.id,
    });
    const [opened] = await db.select().from(intervention);
    await writeEvent(db, {
      id: 'correct_probe_result_m_before_prepare',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: seeded.probeResultId,
      outcome: 'success',
      payload: {
        correction_kind: 'mark_wrong',
        reason_md: 'worker 开始前，owner 判定原目标错误匹配无效。',
        affected_refs: [{ kind: 'question', id: 'probe_m' }],
      },
      created_at: new Date(seeded.now.getTime() + 4_000),
    });

    const result = await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: preparationJobIdOf(opened),
      },
      {
        runTaskFn: async () => {
          throw new Error('inactive evidence must fail before paid recommendation');
        },
        authorPackageFn: async () => {
          throw new Error('inactive evidence must fail before QuestionAuthor');
        },
      },
    );

    expect(result).toMatchObject({
      status: 'preparation_failed',
      reason_code: 'source_evidence_inactive',
    });
    const [failed] = await db.select().from(intervention);
    expect(failed).toMatchObject({
      status: 'preparation_failed',
      recommendation_json: null,
      package_json: null,
      preparation_attempts_json: [],
    });
  });

  it('skips a restored/superseded pg-boss job before any paid model call', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('n');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      bossSend: async (_name, _data, options) => options.id,
    });
    const [opened] = await db.select().from(intervention);
    const archivedJobId = preparationJobIdOf(opened);
    await db
      .update(intervention)
      .set({ preparation_job_id: 'replacement-job-after-restore' })
      .where(eq(intervention.id, opened.id));

    const result = await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: archivedJobId,
      },
      {
        runTaskFn: async () => {
          throw new Error('superseded job must not call the model');
        },
        authorPackageFn: async () => {
          throw new Error('superseded job must not call QuestionAuthor');
        },
      },
    );

    expect(result).toMatchObject({
      status: 'skipped',
      terminal_status: 'preparation_job_superseded',
    });
    const [current] = await db.select().from(intervention);
    expect(current).toMatchObject({
      status: 'preparing',
      preparation_job_id: 'replacement-job-after-restore',
      recommendation_json: null,
      preparation_attempts_json: [],
    });
  });

  it('does not persist recommendation output when restore supersedes an active job mid-call', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('o');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      bossSend: async (_name, _data, options) => options.id,
    });
    const [opened] = await db.select().from(intervention);
    const archivedJobId = preparationJobIdOf(opened);
    const { fn, calls } = successfulRunTask(db);
    const supersedingRun: TaskTextRunFn = async (kind, input, context) => {
      const output = await fn(kind, input, context);
      if (kind === 'InterventionRecommendationTask') {
        await db
          .update(intervention)
          .set({ preparation_job_id: 'replacement-job-during-recommendation' })
          .where(eq(intervention.id, opened.id));
      }
      return output;
    };

    const result = await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: archivedJobId,
      },
      { runTaskFn: supersedingRun, authorPackageFn: authorInterventionPackage },
    );

    expect(result).toMatchObject({
      status: 'skipped',
      terminal_status: 'preparation_job_superseded',
    });
    expect(calls).toEqual(['InterventionRecommendationTask']);
    const [current] = await db.select().from(intervention);
    expect(current).toMatchObject({
      status: 'preparing',
      preparation_job_id: 'replacement-job-during-recommendation',
      recommendation_json: null,
      preparation_attempts_json: [],
    });
  });

  it('revalidates corrected evidence after author and does not start paid review', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('p');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      bossSend: async (_name, _data, options) => options.id,
    });
    const [opened] = await db.select().from(intervention);
    const { fn, calls } = successfulRunTask(db);
    const correctingRun: TaskTextRunFn = async (kind, input, context) => {
      const output = await fn(kind, input, context);
      if (kind === 'InterventionPackageAuthorTask') {
        await writeEvent(db, {
          id: 'correct_probe_result_p_after_author',
          actor_kind: 'user',
          actor_ref: 'self',
          action: 'correct',
          subject_kind: 'event',
          subject_id: seeded.probeResultId,
          outcome: 'success',
          payload: {
            correction_kind: 'mark_wrong',
            reason_md: 'author 完成后，owner 判定原目标错误匹配无效。',
            affected_refs: [{ kind: 'question', id: 'probe_p' }],
          },
          created_at: new Date(seeded.now.getTime() + 4_000),
        });
      }
      return output;
    };

    const result = await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: preparationJobIdOf(opened),
      },
      { runTaskFn: correctingRun, authorPackageFn: authorInterventionPackage },
    );

    expect(result).toMatchObject({
      status: 'preparation_failed',
      reason_code: 'source_evidence_inactive',
    });
    expect(calls).toEqual(['InterventionRecommendationTask', 'InterventionPackageAuthorTask']);
    const [failed] = await db.select().from(intervention);
    expect(failed).toMatchObject({
      status: 'preparation_failed',
      package_json: null,
      preparation_attempts_json: [],
      failure_code: 'source_evidence_inactive',
    });
  });

  it('rejects colliding gold and target-error response signatures even when self-review passes', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('f');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      bossSend: async (_name, _data, options) => options.id,
    });
    const [opened] = await db.select().from(intervention);
    const { fn, calls } = successfulRunTask(db, (attempt) => {
      const output = authorOutput(attempt);
      output.diagnostics.immediate.probe_spec.target_error_response_signature = {
        ...output.diagnostics.immediate.probe_spec.gold_response_signature,
      };
      return output;
    });

    const result = await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: preparationJobIdOf(opened),
      },
      { runTaskFn: fn, authorPackageFn: authorInterventionPackage },
    );

    expect(result).toMatchObject({
      status: 'preparation_failed',
      reason_code: 'package_quality:immediate:target_error_answer_not_distinct',
    });
    expect(calls.filter((kind) => kind === 'InterventionPackageAuthorTask')).toHaveLength(2);
    expect(calls.filter((kind) => kind === 'InterventionPackageReviewTask')).toHaveLength(4);
    const [failed] = await db.select().from(intervention);
    expect(failed.package_json).toBeNull();
    expect(failed.preparation_attempts_json).toHaveLength(2);
  });

  it('keeps operational model failures retryable instead of writing a terminal quality verdict', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('g');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      bossSend: async (_name, _data, options) => options.id,
    });
    const [opened] = await db.select().from(intervention);

    await expect(
      prepareInterventionWave(
        db,
        {
          interventionId: opened.id,
          version: opened.version,
          idempotencyKey: opened.idempotency_key,
          preparationJobId: preparationJobIdOf(opened),
        },
        {
          runTaskFn: async () => {
            throw new Error('provider timeout');
          },
          authorPackageFn: async () => {
            throw new Error('recommendation failure must stop before QuestionAuthor');
          },
        },
      ),
    ).rejects.toThrow('provider timeout');

    const [retryable] = await db.select().from(intervention);
    expect(retryable).toMatchObject({
      status: 'preparing',
      recommendation_json: null,
      package_json: null,
      preparation_attempts_json: [],
      failure_code: null,
    });
    const terminalEvents = await db
      .select({ value: count() })
      .from(event)
      .where(eq(event.action, 'experimental:intervention_preparation_failed'));
    expect(terminalEvents[0]?.value).toBe(0);
  });

  it('revalidates source evidence after paid author/review work and refuses stale activation', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('h');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      bossSend: async (_name, _data, options) => options.id,
    });
    const [opened] = await db.select().from(intervention);
    const { fn } = successfulRunTask(db);
    let corrected = false;

    const result = await prepareInterventionWave(
      db,
      {
        interventionId: opened.id,
        version: opened.version,
        idempotencyKey: opened.idempotency_key,
        preparationJobId: preparationJobIdOf(opened),
      },
      {
        runTaskFn: fn,
        authorPackageFn: async (authorDb, interventionId, deps) => {
          const authored = await authorInterventionPackage(authorDb, interventionId, deps);
          if (!corrected) {
            corrected = true;
            await writeEvent(db, {
              id: 'correct_probe_result_h_during_prepare',
              actor_kind: 'user',
              actor_ref: 'self',
              action: 'correct',
              subject_kind: 'event',
              subject_id: seeded.probeResultId,
              outcome: 'success',
              payload: {
                correction_kind: 'mark_wrong',
                reason_md: '干预生成期间，owner 判定原目标错误匹配无效。',
                affected_refs: [{ kind: 'question', id: 'probe_h' }],
              },
              created_at: new Date(seeded.now.getTime() + 4_000),
            });
          }
          return authored;
        },
      },
    );

    expect(result).toMatchObject({
      status: 'preparation_failed',
      reason_code: 'source_evidence_inactive',
    });
    const [failed] = await db.select().from(intervention);
    expect(failed).toMatchObject({
      status: 'preparation_failed',
      package_json: null,
      failure_code: 'source_evidence_inactive',
      activated_at: null,
    });
    const activated = await db
      .select({ value: count() })
      .from(event)
      .where(eq(event.action, 'experimental:intervention_activated'));
    expect(activated[0]?.value).toBe(0);
  });

  it('serializes activation with a concurrent source correction and fails closed', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('r');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      bossSend: async (_name, _data, options) => options.id,
    });
    const [opened] = await db.select().from(intervention);
    const record = await loadInterventionVersion(db, opened.id, opened.version);
    if (!record) throw new Error('intervention disappeared');
    const recommended = await saveRecommendation(db, record, {
      kind: 'recommendation',
      recommendation_version: INTERVENTION_CONTRACT_VERSION,
      method_id: 'worked_example',
      method_definition_version: PEDAGOGY_METHOD_DEFINITION_VERSION,
      rationale_md: '先用完整示范显式区分内外层。',
      safety_constraints: ['不得把一次表现写成能力定论'],
      candidate_ids: ['worked_example'],
      excluded: [],
      model_run_id: 'activation_race_recommendation_run',
    });
    const packageValue = InterventionPackage.parse({
      ...authorOutput(1),
      intervention_id: recommended.id,
      intervention_version: recommended.version,
      package_version: INTERVENTION_CONTRACT_VERSION,
      method_id: 'worked_example',
      method_definition_version: PEDAGOGY_METHOD_DEFINITION_VERSION,
      author_task_run_id: 'activation_race_author_run',
    });

    let activation: ReturnType<typeof activateIntervention> | undefined;
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${eventCorrectionsGlobalLockKey()}, 0))`,
      );
      activation = activateIntervention(db, {
        interventionId: recommended.id,
        version: recommended.version,
        preparationJobId: preparationJobIdOf(opened),
        package: packageValue,
      });
      const state = await Promise.race([
        activation.then(() => 'settled' as const),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 50)),
      ]);
      expect(state).toBe('blocked');
      await writeEvent(tx, {
        id: 'correct_probe_result_r_before_activation_commit',
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'correct',
        subject_kind: 'event',
        subject_id: seeded.probeResultId,
        outcome: 'success',
        payload: {
          correction_kind: 'mark_wrong',
          reason_md: 'activation 等待提交时，owner 判定原目标错误匹配无效。',
          affected_refs: [{ kind: 'question', id: 'probe_r' }],
        },
        created_at: new Date(seeded.now.getTime() + 4_000),
      });
    });
    if (!activation) throw new Error('activation was not started');
    const result = await activation;

    expect(result).toMatchObject({
      status: 'preparation_failed',
      failure_code: 'source_evidence_inactive',
      package: null,
      activated_at: null,
    });
    const activated = await db
      .select({ value: count() })
      .from(event)
      .where(eq(event.action, 'experimental:intervention_activated'));
    expect(activated[0]?.value).toBe(0);
  });

  it('does not let an old active handler activate a replacement job after restore', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('s');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      bossSend: async (_name, _data, options) => options.id,
    });
    const [opened] = await db.select().from(intervention);
    const oldJobId = preparationJobIdOf(opened);
    const record = await loadInterventionVersion(db, opened.id, opened.version);
    if (!record) throw new Error('intervention disappeared');
    const recommended = await saveRecommendation(db, record, {
      kind: 'recommendation',
      recommendation_version: INTERVENTION_CONTRACT_VERSION,
      method_id: 'worked_example',
      method_definition_version: PEDAGOGY_METHOD_DEFINITION_VERSION,
      rationale_md: '先用完整示范显式区分内外层。',
      safety_constraints: ['不得把一次表现写成能力定论'],
      candidate_ids: ['worked_example'],
      excluded: [],
      model_run_id: 'activation_job_race_recommendation_run',
    });
    const packageValue = InterventionPackage.parse({
      ...authorOutput(1),
      intervention_id: recommended.id,
      intervention_version: recommended.version,
      package_version: INTERVENTION_CONTRACT_VERSION,
      method_id: 'worked_example',
      method_definition_version: PEDAGOGY_METHOD_DEFINITION_VERSION,
      author_task_run_id: 'activation_job_race_author_run',
    });

    let activation: ReturnType<typeof activateIntervention> | undefined;
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${eventCorrectionsGlobalLockKey()}, 0))`,
      );
      activation = activateIntervention(db, {
        interventionId: recommended.id,
        version: recommended.version,
        preparationJobId: oldJobId,
        package: packageValue,
      });
      const state = await Promise.race([
        activation.then(() => 'settled' as const),
        new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 50)),
      ]);
      expect(state).toBe('blocked');
      await tx
        .update(intervention)
        .set({ preparation_job_id: 'replacement-during-activation' })
        .where(eq(intervention.id, recommended.id));
    });
    if (!activation) throw new Error('activation was not started');
    const result = await activation;

    expect(result).toMatchObject({
      status: 'preparing',
      preparation_job_id: 'replacement-during-activation',
      package: null,
      activated_at: null,
    });
    const activated = await db
      .select({ value: count() })
      .from(event)
      .where(eq(event.action, 'experimental:intervention_activated'));
    expect(activated[0]?.value).toBe(0);
  });

  it('recreates a missing operational job for a restored preparing aggregate exactly once', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('i');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      bossSend: async (_name, _data, options) => options.id,
    });
    const [opened] = await db.select().from(intervention);
    if (!opened?.preparation_job_id) throw new Error('seed did not reserve a preparation job');

    const sent: {
      id: string;
      intervention_id: string;
      version: number;
      idempotency_key: string;
    }[] = [];
    const liveJobIds = new Set<string>();
    const boss = {
      getJobById: async (_name: string, id: string) =>
        liveJobIds.has(id) ? { state: 'active' as const } : null,
      send: async (
        _name: string,
        data: { intervention_id: string; version: number; idempotency_key: string },
        options: { id: string },
      ) => {
        sent.push({ id: options.id, ...data });
        liveJobIds.add(options.id);
        return options.id;
      },
    };

    const recovered = await recoverPreparingInterventions(db, boss);
    expect(recovered).toEqual({
      scanned: 1,
      live: 0,
      reenqueued: 1,
      terminalized: 0,
      raced: 0,
      failed: 0,
    });
    const [afterRecovery] = await db.select().from(intervention);
    expect(afterRecovery?.preparation_job_id).not.toBe(opened.preparation_job_id);
    expect(sent).toEqual([
      {
        id: afterRecovery?.preparation_job_id,
        intervention_id: opened.id,
        version: opened.version,
        idempotency_key: opened.idempotency_key,
      },
    ]);

    const replay = await recoverPreparingInterventions(db, boss);
    expect(replay).toEqual({
      scanned: 1,
      live: 1,
      reenqueued: 0,
      terminalized: 0,
      raced: 0,
      failed: 0,
    });
    expect(sent).toHaveLength(1);
  });

  it('turns an exhausted operational job into an auditable terminal failure', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('j');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      bossSend: async (_name, _data, options) => options.id,
    });
    const report = await recoverPreparingInterventions(db, {
      getJobById: async () => ({ state: 'failed' }),
      send: async () => {
        throw new Error('terminal jobs must not be re-enqueued forever');
      },
    });

    expect(report).toEqual({
      scanned: 1,
      live: 0,
      reenqueued: 0,
      terminalized: 1,
      raced: 0,
      failed: 0,
    });
    const [failed] = await db.select().from(intervention);
    expect(failed).toMatchObject({
      status: 'preparation_failed',
      failure_code: 'preparation_job_failed',
      package_json: null,
      activated_at: null,
    });
  });

  it('does not terminalize a replacement job from a stale terminal recovery scan', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('q');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      bossSend: async (_name, _data, options) => options.id,
    });
    const [opened] = await db.select().from(intervention);
    const scannedJobId = preparationJobIdOf(opened);

    const report = await recoverPreparingInterventions(db, {
      getJobById: async () => {
        await db
          .update(intervention)
          .set({ preparation_job_id: 'replacement-after-terminal-scan' })
          .where(eq(intervention.id, opened.id));
        return { state: 'failed' };
      },
      send: async () => {
        throw new Error('terminal scan must not enqueue');
      },
    });

    expect(scannedJobId).not.toBe('replacement-after-terminal-scan');
    expect(report).toEqual({
      scanned: 1,
      live: 0,
      reenqueued: 0,
      terminalized: 0,
      raced: 1,
      failed: 0,
    });
    const [current] = await db.select().from(intervention);
    expect(current).toMatchObject({
      status: 'preparing',
      preparation_job_id: 'replacement-after-terminal-scan',
      failure_code: null,
    });
  });

  it('rechecks liveness under the shared source lock before enqueueing recovery', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('l');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      bossSend: async (_name, _data, options) => options.id,
    });
    let livenessReads = 0;
    const report = await recoverPreparingInterventions(db, {
      getJobById: async () => {
        livenessReads += 1;
        return livenessReads === 1 ? null : { state: 'active' };
      },
      send: async () => {
        throw new Error('stale pre-lock read must not enqueue a second paid job');
      },
    });

    expect(report).toEqual({
      scanned: 1,
      live: 1,
      reenqueued: 0,
      terminalized: 0,
      raced: 0,
      failed: 0,
    });
    expect(livenessReads).toBe(2);
  });
});
