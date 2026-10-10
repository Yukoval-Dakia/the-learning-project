import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  INTERVENTION_DIAGNOSTIC_CLAIM_LEASE_MS,
  JUDGE_RUN_EVENTS,
  JUDGE_RUN_TABLE,
  authorInterventionPackage,
  handleReviewDue,
} from '@/capabilities/practice/public';

import {
  dispatchNativeAttempt,
  executeNativeAttempt,
} from '@/capabilities/practice/server/assessment/durable-attempt';

import * as evaluationService from '@/capabilities/practice/server/judge/evaluate-submission';
import { createRecordedModelExecutor } from '@/capabilities/practice/server/judge/recorded-model-executor';
import {
  disposeJudgeRun,
  fenceJudgeUnitClaim,
} from '@/capabilities/practice/server/judge-operational';
import { readJudgeQuestionActivity } from '@/capabilities/practice/server/judge-run-observation';
import { freezeQuestionForJudge } from '@/capabilities/practice/server/judge-run-payload';

import { resetTestConfig } from '@/core/config/store';
import { newId } from '@/core/ids';

import type { ModelExecutorRequest, ModelUnitOutcomeT } from '@/core/schema/assessment';
import { PROBE_QUESTION_KIND, PROBE_QUESTION_SOURCE } from '@/core/schema/conjecture';
import type { ConjectureProbeResponseJudgementT } from '@/core/schema/conjecture-probe-response';
import { JudgeWorkflowInput } from '@/core/schema/event/judge-operational-events';
import {
  JudgePendingAttemptPayload,
  NativeJudgePendingSubmitInput,
} from '@/core/schema/event/judge-pending-events';
import {
  INTERVENTION_CONTRACT_VERSION,
  InterventionPackage,
  PEDAGOGY_METHOD_DEFINITION_VERSION,
} from '@/core/schema/intervention';
import {
  ai_task_runs,
  evaluation,
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

import type { TaskTextRunFn } from '@/server/ai/provenance';
import { resolveSubjectProfile } from '@/subjects/profile';
import { publishPaperModelFixture } from '../../../../../tests/fixtures/assessment-paper';
import { issueSoloFixture } from '../../../../../tests/fixtures/assessment-solo';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { answerProbe } from '../conjecture/probe-lifecycle';
import { prepareInterventionWave } from './prepare';
import { handleProbeResultInterventionDelivery } from './probe-result-subscription';
import { recoverEligibleInterventionDiagnostics, recoverPreparingInterventions } from './reconcile';
import { handleInterventionDiagnosticJudgeDelivery } from './settlement-subscription';
import { activateIntervention, loadInterventionVersion, saveRecommendation } from './store';

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
  if (sealed?.length !== 3) throw new Error('missing sealed independent solutions');
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

async function prepareAdmittedDiagnosticFixture(label: string) {
  const db = testDb();
  const seeded = await seedEvidenceFor(label);
  await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
    env: { AUTO_INTERVENTION_EXPANSION_ENABLED: 'true' },
    bossSend: async (_name, _data, options) => options.id,
  });
  const [opened] = await db.select().from(intervention);
  const { fn } = successfulRunTask(db);
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  await prepareInterventionWave(
    db,
    {
      interventionId: opened.id,
      version: opened.version,
      idempotencyKey: opened.idempotency_key,
      preparationJobId: preparationJobIdOf(opened),
    },
    { runTaskFn: fn, authorPackageFn: authorInterventionPackage, now: () => now },
  );
  const active = await loadInterventionVersion(db, opened.id, opened.version);
  if (!active?.settlement) throw new Error('active diagnostics missing');
  const questionId = active.settlement.diagnostics.immediate.question_id;
  await publishPaperModelFixture(db, questionId);
  await recoverEligibleInterventionDiagnostics(db, now);
  const staleAt = new Date(now.getTime() - INTERVENTION_DIAGNOSTIC_CLAIM_LEASE_MS - 1);
  return { db, opened, active, questionId, now, staleAt };
}

describe('YUK-791 intervention preparation closed loop', () => {
  beforeEach(resetDb);
  afterEach(async () => {
    await resetTestConfig();
    vi.restoreAllMocks();
  });

  it.each(['malformed', 'historical'] as const)(
    'holds a %s permanent pending diagnostic despite FAILED and REQUEUED notifications',
    async (kind) => {
      const f = await prepareAdmittedDiagnosticFixture(`pending_guard_${kind}`);
      const runId = newId();
      const [originalQuestion] = await f.db
        .select()
        .from(question)
        .where(eq(question.id, f.questionId));
      const payload =
        kind === 'malformed'
          ? { run_id: runId }
          : JudgePendingAttemptPayload.parse({
              run_id: runId,
              caller: 'submit',
              knowledge_ids: originalQuestion.knowledge_ids,
              ability_global_ids: [],
              submit: {
                body: {
                  question_id: f.questionId,
                  rating: 'good',
                  response_md: 'y′=2x exp(x²+1)，先求外层导数，再乘以内层导数。',
                  latency_ms: 3456,
                  referenced_knowledge_ids: [],
                },
                question_id: f.questionId,
                subject_profile: resolveSubjectProfile('math'),
                question_snapshot: freezeQuestionForJudge(originalQuestion),
                submitted_at: f.staleAt.toISOString(),
              },
            });
      await f.db
        .update(question)
        .set({ draft_status: 'draft', updated_at: f.staleAt })
        .where(eq(question.id, f.questionId));
      // Raw insertion deliberately retains the malformed historical row at the read boundary.
      const [pending] = await f.db
        .insert(event)
        .values({
          id: `evt_pending_${runId}`,
          actor_kind: 'user',
          actor_ref: 'self',
          action: 'experimental:judge_pending_attempt',
          subject_kind: 'question',
          subject_id: f.questionId,
          outcome: null,
          payload,
          created_at: f.staleAt,
        })
        .returning();
      for (const notification of [null, JUDGE_RUN_EVENTS.FAILED, JUDGE_RUN_EVENTS.REQUEUED]) {
        if (notification)
          await f.db.insert(job_events).values({
            business_table: JUDGE_RUN_TABLE,
            business_id: runId,
            event_type: notification,
            payload: { reason: 'retries_exhausted', delivery_id: `historical:${runId}` },
          });
        expect(
          (await readJudgeQuestionActivity(f.db, [f.questionId])).get(f.questionId),
        ).toMatchObject([
          {
            kind: 'unmapped',
            activity: 'held',
            reason: kind === 'malformed' ? 'corrupt' : 'legacy',
          },
        ]);
        await recoverEligibleInterventionDiagnostics(f.db, f.now);
        expect(
          (await f.db.select().from(question).where(eq(question.id, f.questionId)))[0],
        ).toMatchObject({
          draft_status: 'draft',
          updated_at: f.staleAt,
        });
        expect(await f.db.select().from(event).where(eq(event.id, pending.id))).toEqual([pending]);
        expect(
          (await loadInterventionVersion(f.db, f.opened.id, f.opened.version))?.settlement,
        ).toEqual(f.active.settlement);
        expect(await f.db.select().from(evaluation)).toHaveLength(0);
      }
    },
  );

  it('reopens an unanswered stale diagnostic when only legacy notifications exist', async () => {
    const f = await prepareAdmittedDiagnosticFixture('notification_only');
    const runId = newId();
    for (const notification of [JUDGE_RUN_EVENTS.FAILED, JUDGE_RUN_EVENTS.REQUEUED]) {
      await f.db
        .update(question)
        .set({ draft_status: 'draft', updated_at: f.staleAt })
        .where(eq(question.id, f.questionId));
      await f.db.insert(job_events).values({
        business_table: JUDGE_RUN_TABLE,
        business_id: runId,
        event_type: notification,
        payload: { question_id: f.questionId, delivery_id: `historical:${runId}` },
      });
      expect(
        (await readJudgeQuestionActivity(f.db, [f.questionId])).get(f.questionId),
      ).toBeUndefined();
      await recoverEligibleInterventionDiagnostics(f.db, f.now);
      expect(
        (await f.db.select().from(question).where(eq(question.id, f.questionId)))[0].draft_status,
      ).toBe('active');
      expect(await f.db.select().from(evaluation)).toHaveLength(0);
      expect(
        (await loadInterventionVersion(f.db, f.opened.id, f.opened.version))?.settlement,
      ).toEqual(f.active.settlement);
    }
  });

  it.each(['manual', 'resolved'] as const)(
    'retains a valid %s permanent diagnostic disposition and its real settlement despite late notifications',
    async (disposition) => {
      const f = await prepareAdmittedDiagnosticFixture(`permanent_${disposition}`);
      const issued = await issueSoloFixture(f.db, f.questionId, true);
      await f.db
        .update(question)
        .set({ draft_status: 'draft', updated_at: f.staleAt })
        .where(eq(question.id, f.questionId));
      const jobSchema = z.object({
        run_id: z.string(),
        caller: z.literal('native_assessment'),
        submit: NativeJudgePendingSubmitInput,
        operational: JudgeWorkflowInput,
      });
      const send = vi.fn(async (_queue: string, data: unknown, options?: { id?: string }) => {
        const job = jobSchema.parse(data);
        expect(options?.id).toBe(job.operational.delivery_id);
        return options?.id ?? null;
      });
      const runId = await dispatchNativeAttempt(
        f.db,
        f.questionId,
        issued.assessment('y′=2x exp(x²+1)，外层导数与内层导数相乘。'),
        { enabled: true, capture: {}, requireUnassistedModelEvidence: true },
        { checkRateLimit: () => 1, boss: { send } },
      );
      if (!runId) throw new Error('missing permanent diagnostic run');
      expect(send).toHaveBeenCalledTimes(1);
      const job = jobSchema.parse(send.mock.calls[0][1]);
      const [pending] = await f.db
        .select()
        .from(event)
        .where(eq(event.id, `evt_pending_${runId}`));
      expect(
        (await readJudgeQuestionActivity(f.db, [f.questionId])).get(f.questionId),
      ).toMatchObject([{ kind: 'pending', activity: 'pending', delivery: { kind: 'accepted' } }]);
      await recoverEligibleInterventionDiagnostics(f.db, f.now);
      expect(
        (await f.db.select().from(question).where(eq(question.id, f.questionId)))[0].draft_status,
      ).toBe('draft');
      const execute = vi.fn(
        async (
          input: ModelExecutorRequest,
          _signal: AbortSignal | undefined,
          taskRunId: string,
        ): Promise<ModelUnitOutcomeT> => ({
          kind: 'scored',
          points_awarded: input.unit.points,
          probe_signature_match: {
            match: 'gold',
            explanation_md: '链式法则推导与冻结的正确答案签名一致。',
          },
          matched: {
            rule_id:
              input.unit.criterion.kind === 'rule_reference'
                ? input.unit.criterion.rule_id
                : 'fixture',
            option_ids: [],
          },
          feedback_md: '外层导数与内层导数相乘。',
          confidence: 0.95,
          evidence_citations: [{ slot_id: input.response_slots[0].slot_id, quote: '2x exp(x²+1)' }],
          run_refs: [taskRunId],
          cost_usd_micros: 100,
        }),
      );
      vi.spyOn(evaluationService, 'createFormalModelExecutor').mockImplementation(
        (_database, _signal, _admission, execution) =>
          createRecordedModelExecutor(
            f.db,
            execute,
            execution
              ? { fence: (tx, request) => fenceJudgeUnitClaim(tx, execution, request) }
              : {},
          ),
      );
      let activationId: string | undefined;
      if (disposition === 'manual') {
        expect(
          await disposeJudgeRun(f.db, runId, {
            reason: 'explicit_disposal',
            actorRef: 'test:diagnostic-owner',
            evidenceRefs: [pending.id],
            evidenceDigest: sha256CanonicalJson(pending.payload),
          }),
        ).toMatchObject({ kind: 'disposed' });
        await expect(executeNativeAttempt(f.db, job)).rejects.toMatchObject({
          code: 'judge_disposed',
        });
      } else {
        expect(await executeNativeAttempt(f.db, job)).toMatchObject({ status: 'effective' });
        expect(
          (await readJudgeQuestionActivity(f.db, [f.questionId])).get(f.questionId),
        ).toMatchObject([{ kind: 'resolved', activity: 'terminal' }]);
        // Domain completion closes the card even before its settlement subscriber arrives.
        await recoverEligibleInterventionDiagnostics(f.db, f.now);
        expect(
          (await f.db.select().from(question).where(eq(question.id, f.questionId)))[0].draft_status,
        ).toBe('draft');
        expect(
          (await loadInterventionVersion(f.db, f.opened.id, f.opened.version))?.settlement,
        ).toEqual(f.active.settlement);
        const [activation] = await f.db
          .select()
          .from(event)
          .where(
            and(
              eq(event.action, 'experimental:assessment_activation'),
              eq(event.subject_id, job.submit.evaluation_group_id),
            ),
          );
        if (!activation) throw new Error('diagnostic activation missing');
        activationId = activation.id;
        expect(
          await handleInterventionDiagnosticJudgeDelivery(f.db, {
            subscriberId: 'agency.intervention-diagnostic-review-settlement',
            subscriberVersion: 4,
            deliverySeq: activation.id,
            sourceEventId: activation.id,
          }),
        ).toMatchObject({ status: 'succeeded' });
      }
      const settled = await loadInterventionVersion(f.db, f.opened.id, f.opened.version);
      expect(settled?.settlement?.diagnostics.immediate).toMatchObject(
        disposition === 'manual'
          ? { status: 'scheduled', review_event_id: null }
          : {
              status: 'passed',
              review_event_id: `evt_assessment_${job.submit.submission_id}`,
              verdict_event_id: activationId,
            },
      );
      for (const notification of [JUDGE_RUN_EVENTS.FAILED, JUDGE_RUN_EVENTS.REQUEUED]) {
        await f.db.insert(job_events).values({
          business_table: JUDGE_RUN_TABLE,
          business_id: runId,
          event_type: notification,
          payload: { delivery_id: job.operational.delivery_id, reason: 'late historical marker' },
        });
        expect(
          (await readJudgeQuestionActivity(f.db, [f.questionId])).get(f.questionId),
        ).toMatchObject([
          { kind: disposition, activity: disposition === 'manual' ? 'held' : 'terminal' },
        ]);
        await recoverEligibleInterventionDiagnostics(f.db, f.now);
        expect(
          (await f.db.select().from(question).where(eq(question.id, f.questionId)))[0].draft_status,
        ).toBe('draft');
        expect(await f.db.select().from(event).where(eq(event.id, pending.id))).toEqual([pending]);
        expect(
          (await loadInterventionVersion(f.db, f.opened.id, f.opened.version))?.settlement,
        ).toEqual(settled?.settlement);
      }
      expect(execute).toHaveBeenCalledTimes(disposition === 'manual' ? 0 : 1);
      expect(await f.db.select().from(evaluation)).toHaveLength(disposition === 'manual' ? 0 : 1);
      if (activationId) {
        expect(
          await handleInterventionDiagnosticJudgeDelivery(f.db, {
            subscriberId: 'agency.intervention-diagnostic-review-settlement',
            subscriberVersion: 4,
            deliverySeq: `replay:${activationId}`,
            sourceEventId: activationId,
          }),
        ).toMatchObject({ status: 'succeeded', detail: { idempotent: true } });
        expect(
          await f.db
            .select()
            .from(material_fsrs_state)
            .where(eq(material_fsrs_state.subject_id, f.questionId)),
        ).toHaveLength(0);
        expect(
          await f.db
            .select()
            .from(event)
            .where(eq(event.action, 'experimental:assessment_settlement')),
        ).toHaveLength(1);
      }
    },
  );

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
    for (const diagnostic of Object.values(active.settlement.diagnostics)) {
      await publishPaperModelFixture(db, diagnostic.question_id);
    }
    await recoverEligibleInterventionDiagnostics(db, activationNow);
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
