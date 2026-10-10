import { count, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestConfig } from '@/core/config/store';
import { PROBE_QUESTION_KIND, PROBE_QUESTION_SOURCE } from '@/core/schema/conjecture';
import type { ConjectureProbeResponseJudgementT } from '@/core/schema/conjecture-probe-response';
import {
  INTERVENTION_CONTRACT_VERSION,
  InterventionPackage,
  PEDAGOGY_METHOD_DEFINITION_VERSION,
} from '@/core/schema/intervention';
import { event, intervention, knowledge, mastery_state, question } from '@/db/schema';
import { eventCorrectionsGlobalLockKey, writeEvent } from '@/kernel/events';
import type { EventSubscriptionDelivery } from '@/kernel/manifest';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { answerProbe } from '../conjecture/probe-lifecycle';
import { handleProbeResultInterventionDelivery } from './probe-result-subscription';
import { recoverPreparingInterventions } from './reconcile';
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

describe('YUK-791 intervention preparation closed loop', () => {
  beforeEach(resetDb);
  afterEach(async () => {
    await resetTestConfig();
    vi.restoreAllMocks();
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
