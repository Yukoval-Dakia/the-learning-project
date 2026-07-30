import { authorInterventionPackage, handleReviewDue } from '@/capabilities/practice/public';
import { PEDAGOGY_METHOD_LIBRARY } from '@/core/pedagogy';
import { PROBE_QUESTION_KIND, PROBE_QUESTION_SOURCE } from '@/core/schema/conjecture';
import type { ConjectureProbeResponseJudgementT } from '@/core/schema/conjecture-probe-response';
import {
  INTERVENTION_CONTRACT_VERSION,
  InterventionPackage,
  PEDAGOGY_METHOD_DEFINITION_VERSION,
  buildInterventionSettlement,
} from '@/core/schema/intervention';
import {
  event,
  intervention,
  knowledge,
  mastery_state,
  material_fsrs_state,
  question,
} from '@/db/schema';
import { eventCorrectionsGlobalLockKey, writeEvent } from '@/kernel/events';
import type { EventSubscriptionDelivery } from '@/kernel/manifest';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { writeAiProposal } from '@/server/proposals/writer';
import { and, count, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { answerProbe } from '../conjecture/probe-lifecycle';
import { prepareInterventionWave } from './prepare';
import { handleProbeResultInterventionDelivery } from './probe-result-subscription';
import { recoverEligibleInterventionDiagnostics, recoverPreparingInterventions } from './reconcile';
import { handleInterventionDiagnosticReviewDelivery } from './settlement-subscription';
import { activateIntervention, loadInterventionVersion, saveRecommendation } from './store';

const CLAIM = '你把复合函数求导中的外层导数和内层导数相加，而不是相乘。';
const TARGET_ERROR = '把外层导数与内层导数相加，而不是按链式法则相乘。';
const DIAGNOSTIC_SPEC = {
  schema_version: 1 as const,
  target_error_rule_md: TARGET_ERROR,
  trigger_conditions_md: '题目要求对复合函数求导。',
  scope_boundary_md: '不覆盖和、积、商等其他求导法则。',
  expected_wrong_answer_signature_md: '外层导数 + 内层导数。',
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

function successfulRunTask(
  packageOutput: (attempt: number) => ReturnType<typeof authorOutput> = authorOutput,
): {
  fn: TaskTextRunFn;
  calls: string[];
  contexts: Array<{ kind: string; ctx: Parameters<TaskTextRunFn>[2] }>;
} {
  const calls: string[] = [];
  const contexts: Array<{ kind: string; ctx: Parameters<TaskTextRunFn>[2] }> = [];
  const fn: TaskTextRunFn = async (kind, _input, ctx) => {
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
    if (kind === 'InterventionPackageReviewTask') {
      const attempt = calls.filter((value) => value === kind).length;
      return {
        text: '',
        task_run_id: `review_run_${attempt}`,
        structured_output: {
          verdict: 'pass',
          failure_codes: [],
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
    const { fn, calls, contexts } = successfulRunTask();
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
    const diagnosticQuestions = await db
      .select({
        id: question.id,
        source: question.source,
        judge_kind_override: question.judge_kind_override,
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
    const { fn } = successfulRunTask();
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
    expect(active?.status).toBe('active');
    expect(active?.delivery_mode).toBe('eligible');
    if (!active?.settlement) throw new Error('active intervention has no settlement schedule');
    const diagnosticQuestions = await db
      .select({
        id: question.id,
        source: question.source,
        judge_kind_override: question.judge_kind_override,
        metadata: question.metadata,
      })
      .from(question)
      .where(eq(question.source, 'intervention_diagnostic'));
    expect(diagnosticQuestions).toHaveLength(3);
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

    const delayed = active.settlement.diagnostics.delayed;
    const [delayedCard] = await db
      .select({ state: material_fsrs_state.state })
      .from(material_fsrs_state)
      .where(eq(material_fsrs_state.subject_id, delayed.question_id));
    if (!delayedCard) throw new Error('missing delayed diagnostic card');
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
        fsrs_state_after: delayedCard.state,
        user_response_md: '提前直连作答',
        referenced_knowledge_ids: [],
        judge: diagnosticJudgeVerdict('correct'),
      },
      created_at: new Date(active.settlement.diagnostics.immediate.due_at),
    });
    await expect(
      handleInterventionDiagnosticReviewDelivery(db, {
        subscriberId: 'agency.intervention-diagnostic-review-settlement',
        subscriberVersion: 1,
        deliverySeq: 'pre-due',
        sourceEventId: 'review_settlement_delayed_too_early',
      }),
    ).resolves.toMatchObject({ status: 'skipped', reason: 'diagnostic_not_due' });
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
      const reviewEventId = `review_settlement_${kind}`;
      const [cardBeforeReview] = await db
        .select({ state: material_fsrs_state.state })
        .from(material_fsrs_state)
        .where(eq(material_fsrs_state.subject_id, active.settlement.diagnostics[kind].question_id))
        .limit(1);
      if (!cardBeforeReview) throw new Error(`missing ${kind} diagnostic card`);
      await writeEvent(db, {
        id: reviewEventId,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'review',
        subject_kind: 'question',
        subject_id: active.settlement.diagnostics[kind].question_id,
        outcome: verdicts[kind].eventOutcome,
        payload: {
          fsrs_rating: verdicts[kind].rating,
          fsrs_state_after: cardBeforeReview.state,
          user_response_md: kind === 'delayed' ? '部分正确但仍有遗漏' : '作答正确',
          referenced_knowledge_ids: [],
          judge: diagnosticJudgeVerdict(verdicts[kind].judge),
        },
        created_at: new Date(active.settlement.diagnostics[kind].due_at.replace('.000Z', '.500Z')),
      });
      lastDelivery = {
        subscriberId: 'agency.intervention-diagnostic-review-settlement',
        subscriberVersion: 1,
        deliverySeq: String(kind === 'immediate' ? 1 : kind === 'delayed' ? 2 : 3),
        sourceEventId: reviewEventId,
      };
      const result = await handleInterventionDiagnosticReviewDelivery(db, lastDelivery);
      expect(result.status).toBe('succeeded');
      if (kind === 'immediate') {
        expect(await recoverEligibleInterventionDiagnostics(db)).toEqual({
          scanned: 1,
          ensured: 1,
          raced: 0,
          failed: 0,
        });
      }
      const card = await db
        .select({ id: material_fsrs_state.id })
        .from(material_fsrs_state)
        .where(eq(material_fsrs_state.subject_id, active.settlement.diagnostics[kind].question_id));
      expect(card).toHaveLength(0);
      const [retiredQuestion] = await db
        .select({ draft_status: question.draft_status })
        .from(question)
        .where(eq(question.id, active.settlement.diagnostics[kind].question_id));
      expect(retiredQuestion?.draft_status).toBe('draft');
    }

    const settled = await loadInterventionVersion(db, opened.id, opened.version);
    expect(settled).toMatchObject({
      status: 'settled',
      outcome: 'inconclusive',
      settlement: {
        diagnostics: {
          immediate: { status: 'passed', review_event_id: 'review_settlement_immediate' },
          delayed: { status: 'failed', review_event_id: 'review_settlement_delayed' },
          transfer: { status: 'passed', review_event_id: 'review_settlement_transfer' },
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
    const replay = await handleInterventionDiagnosticReviewDelivery(db, lastDelivery);
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
    const { fn } = successfulRunTask();
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

    await expect(recoverEligibleInterventionDiagnostics(db)).resolves.toEqual({
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
    expect(recoveredCards[0]?.value).toBe(303);
  });

  it('retries the whole package once then fails closed without a partial package', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('b');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      env: {},
      bossSend: async () => 'prepare_job_b',
    });
    const [opened] = await db.select().from(intervention);
    const { fn: baseRun, calls } = successfulRunTask();
    const failingRun: TaskTextRunFn = async (kind, input, ctx) => {
      if (kind === 'InterventionPackageReviewTask') {
        calls.push(kind);
        const attempt = calls.filter((value) => value === kind).length;
        return {
          text: '',
          task_run_id: `review_fail_${attempt}`,
          structured_output: {
            verdict: 'fail',
            failure_codes: ['answer_not_unique'],
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

  it('treats a review without run provenance as a retryable package attempt failure', async () => {
    const db = testDb();
    const seeded = await seedEvidenceFor('k');
    await handleProbeResultInterventionDelivery(db, delivery(seeded.probeResultId), {
      bossSend: async (_name, _data, options) => options.id,
    });
    const [opened] = await db.select().from(intervention);
    const { fn: baseRun, calls } = successfulRunTask();
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
    const { fn, calls } = successfulRunTask();
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
    const { fn, calls } = successfulRunTask();
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
    const { fn, calls } = successfulRunTask((attempt) => {
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
    expect(calls.filter((kind) => kind === 'InterventionPackageReviewTask')).toHaveLength(2);
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
    const { fn } = successfulRunTask();
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
