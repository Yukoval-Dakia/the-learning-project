import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProbeAnswerResponseSchema } from '@/capabilities/agency/api/contracts';
import { POST as ANSWER } from '@/capabilities/agency/api/probe-answer';
import {
  answerProbe,
  getEffectiveProbeResultStatuses,
  serveProbeOnce,
  servePublishedProbe,
} from '@/capabilities/agency/public';
import * as evaluationService from '@/capabilities/practice/server/judge/evaluate-submission';
import { createRecordedModelExecutor } from '@/capabilities/practice/server/judge/recorded-model-executor';
import type { PublishedQuestionRevisionT } from '@/core/schema/assessment';
import {
  ConjectureProbePackageV1,
  ConjectureProbeSpecV1,
  ConjectureProbeSpecV2,
} from '@/core/schema/business';
import { PROBE_RESOLUTION_RULE_VERSION } from '@/core/schema/conjecture';
import { ConjectureProposalChange } from '@/core/schema/proposal';
import {
  ai_task_runs,
  assessment_issuance,
  assessment_submission,
  cost_ledger,
  evaluation,
  event,
  knowledge,
  provider_attempt,
  provider_attempt_admission,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { revisionRowToContract } from '@/kernel/records/assessment-issuance';
import { contractIntegrityDigest } from '@/kernel/records/assessment-normalization';
import { publishQuestionGroup } from '@/kernel/records/assessment-publication';
import * as jevExecutor from '@/server/assessment/jev-model-executor';
import * as piExecutor from '@/server/assessment/pi-model-executor';
import { __resetRateLimitForTests } from '@/server/http/rate-limit';
import { editQuestion } from '@/server/questions/write';
import { computeTeachingBriefReport } from '../../../../scripts/lib/teaching-brief-report';
import { loadTeachingBriefReportInput } from '../../../../scripts/report-teaching-brief';
import { withProbeSpecs } from '../../../../tests/fixtures/conjecture-probe-spec';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST as ACK } from '../api/teaching-brief-ack';
import { loadActiveProbes } from './prep-desk-probes';
import { loadTeachingBrief, validateAckableOutcome } from './teaching-brief';

const NOW = new Date('2026-10-07T12:00:00Z');
const PRIMARY = ConjectureProbeSpecV1.parse({
  prompt_md: '求 sin(x²) 的导数，解释内外层导数如何组合；说明 x=0 的偶然相同为何不能验证一般规则。',
  reference_md: '2x cos(x²)。外层 cos(x²) 乘以内层 2x；特殊点相同不能证明函数恒等。',
  expected_target_error_answer_md: 'cos(x²) + 2x，把内外层导数相加。',
  elicits_target_error_reason_md: '区分内外层导数相加与相乘，排除用特殊点推断一般结论。',
  context_kind: 'abstract',
  representation_kind: 'symbolic',
});
const FOLLOWUP = ConjectureProbeSpecV1.parse({
  ...PRIMARY,
  prompt_md:
    '面积变化模型为 cos(t³)。求瞬时变化率，说明组合内外层的规则，并判断 t=0 能否验证全部时间。',
  reference_md: '-3t² sin(t³)。外层 -sin(t³) 与内层 3t² 相乘。',
  expected_target_error_answer_md: '-sin(t³) + 3t²，把内外层导数相加。',
  context_kind: 'applied',
  representation_kind: 'natural_language',
});
const PACKAGE = ConjectureProbePackageV1.parse({
  primary: PRIMARY,
  followup: FOLLOWUP,
  predicted_p: 0.3,
});
const CHANGE = withProbeSpecs(
  ConjectureProposalChange.parse({
    claim_md: '求复合函数导数时可能把内外层导数相加。',
    knowledge_id: 'kn_chain_rule',
    cause_category: 'concept_misunderstanding',
    confidence: 0.7,
    recurrence_count: 2,
    probe_md: PRIMARY.prompt_md,
    probe_reference_md: PRIMARY.reference_md,
    followup_probe_md: FOLLOWUP.prompt_md,
    followup_probe_reference_md: FOLLOWUP.reference_md,
    discriminating: true,
    predicted_p: PACKAGE.predicted_p,
    baseline_p_at_induction: 0.6,
  }),
  PACKAGE.primary,
  PACKAGE.followup,
);
const SEQUENCES = [1, 2] as const;
const CORRUPTIONS = [
  { kind: 'execution', reason: 'probe_execution_contract_mismatch' },
  { kind: 'reference', reason: 'probe_reference_mismatch' },
  { kind: 'prompt', reason: 'probe_prompt_mismatch' },
  { kind: 'V1 proposal with V2 frozen spec', reason: 'probe_spec_mismatch' },
] as const;
type Corruption = (typeof CORRUPTIONS)[number]['kind'];
const CORRUPTION_CASES = SEQUENCES.flatMap((sequence) =>
  CORRUPTIONS.map((corruption) => ({ sequence, ...corruption })),
);

async function seed(sequence: 1 | 2, specPresent = true) {
  const db = testDb();
  await writeAiProposal(db, {
    id: 'v1_proposal',
    actor_ref: 'research_meeting',
    created_at: new Date(NOW.getTime() - 600_000),
    payload: {
      kind: 'conjecture',
      target: { subject_kind: 'mind_model', subject_id: CHANGE.knowledge_id },
      reason_md: '两次嵌套求导出错，另一次独立练习正确；历史 V1 包含独立复验与完整审核来源。',
      evidence_refs: [{ kind: 'event', id: 'offline-evidence' }],
      cooldown_key: 'v1-compat',
      proposed_change: specPresent
        ? CHANGE
        : ConjectureProposalChange.parse({
            ...CHANGE,
            diagnostic_spec: undefined,
            probe_spec: undefined,
            followup_probe_spec: undefined,
            probe_quality: undefined,
          }),
    },
  });
  await writeEvent(db, {
    id: 'accepted_v1',
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: 'v1_proposal',
    outcome: 'success',
    payload: { rating: 'accept', conjecture_id: 'v1_proposal', calibration_anchor: 'accept' },
    caused_by_event_id: 'v1_proposal',
    created_at: NOW,
  });
  expect(CHANGE.probe_spec).toEqual(PRIMARY);
  expect(CHANGE.followup_probe_spec).toEqual(FOLLOWUP);
  expect(CHANGE.probe_quality).toMatchObject({ schema_version: 2, reviewed_package: PACKAGE });
  const spec = sequence === 1 ? PRIMARY : FOLLOWUP;
  const served = await serveProbeOnce({
    db,
    conjectureProposalId: 'v1_proposal',
    knowledgeId: CHANGE.knowledge_id,
    probeMd: spec.prompt_md,
    referenceMd: spec.reference_md,
    ...(specPresent ? { probeSpec: spec } : {}),
    probeSequence: sequence,
    now: new Date(NOW.getTime() - 600_000),
  });
  if (served.status !== 'served') throw new Error(`fixture serve: ${served.status}`);
  return served.probe_question_id;
}

/** Admit the real publisher's contract without replacing its legacy scoring criterion. */
async function admitAndIssue(
  probeId: string,
  mutate?: (contract: PublishedQuestionRevisionT) => void,
) {
  const db = testDb();
  const [lifecycle] = await db
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, probeId));
  const [revision] = await db
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, lifecycle.current_revision_id ?? 'missing'));
  const contract = revisionRowToContract(revision);
  expect(contract.scoring_basis.units[0].criterion).not.toHaveProperty('probe_spec');
  for (const assignment of contract.execution_plan.assignments) {
    assignment.executor = {
      kind: 'model_executor',
      task_kind: 'AssessmentRuleJudgeTask',
      admitted_slice_id: 'offline-v1-compat-slice',
      max_cost_usd_micros: 1000,
    };
  }
  mutate?.(contract);
  contract.integrity_digest = contractIntegrityDigest(contract);
  expect(
    await publishQuestionGroup(db, {
      group_id: probeId,
      contract,
      expectedCurrentRevision: lifecycle.current_revision_id,
      expectedAdmissionGeneration: lifecycle.scoring_admission_generation,
      availability: 'container_only',
      actorRef: 'test:v1-compat',
      now: NOW,
      admission: {
        state: 'admitted',
        evidence: {
          marking_provenance: 'official',
          verification: { structural_check_passed: true, independent_verification: null },
          model_slice: null,
        },
      },
    }),
  ).toMatchObject({ status: 'published' });
  expect(await servePublishedProbe(db, probeId)).toMatchObject({ status: 'issued' });
}

function scriptedJudge(points: 0 | 1 = 1) {
  const execute = vi.fn<Parameters<typeof createRecordedModelExecutor>[1]>(
    async (input, _signal, runId) => ({
      kind: 'scored',
      points_awarded: points,
      matched: {
        rule_id: input.unit.criterion.kind === 'rule_reference' ? input.unit.criterion.rule_id : '',
        option_ids: [],
      },
      confidence: 0.9,
      feedback_md: '脚本化历史 V1 评分，只验证真实发题、评分持久化与结果来源，不调用 provider。',
      evidence_citations: input.slot_responses.flatMap((r) =>
        r.kind === 'open' && r.text_md ? [{ slot_id: r.slot_id, quote: r.text_md }] : [],
      ),
      run_refs: [runId],
      cost_usd_micros: 0,
    }),
  );
  const factory = vi
    .spyOn(evaluationService, 'createFormalModelExecutor')
    .mockImplementation(() => createRecordedModelExecutor(testDb(), execute));
  return { execute, factory };
}
function answer(probeId: string) {
  return ANSWER(
    new Request('http://test.invalid/probe/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer_md: '内外层导数相加，并用特殊点检验规则。' }),
    }),
    { id: probeId },
  );
}
function ack(resultId: string) {
  return ACK(
    new Request('http://test.invalid/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ probe_result_event_id: resultId }),
    }),
  );
}
function snapshot() {
  const db = testDb();
  return Promise.all([
    db.select().from(question),
    db.select().from(event),
    db.select().from(assessment_issuance),
    db.select().from(question_revision),
    db.select().from(question_group_lifecycle),
    db.select().from(assessment_submission),
    db.select().from(evaluation),
    db.select().from(ai_task_runs),
    db.select().from(provider_attempt),
    db.select().from(provider_attempt_admission),
    db.select().from(cost_ledger),
  ]);
}
async function resultRow(id: string) {
  const [row] = await testDb().select().from(event).where(eq(event.id, id));
  if (!row) throw new Error('fixture result missing');
  return row;
}
async function editCompleted(probeId: string) {
  const [q] = await testDb().select().from(question).where(eq(question.id, probeId));
  expect(
    await editQuestion(
      testDb(),
      probeId,
      q.version,
      {
        knowledge_ids: [],
        draft_status: 'active',
        kind: 'choice',
        choices_md: ['相加', '相乘'],
        prompt_md: '后续编目题干，与原题不同。',
        reference_md: '后续参考，不能改写原结果。',
      },
      'self',
    ),
  ).toMatchObject({ status: 'updated' });
}
async function status(id: string) {
  return (await getEffectiveProbeResultStatuses(testDb(), [id], { validateDirectChain: true })).get(
    id,
  );
}
async function report() {
  return computeTeachingBriefReport(
    await loadTeachingBriefReportInput(testDb(), '2026-10-07', '2026-10-07'),
  );
}

/** Restore/import corruption only; ordinary SQL writers still cannot edit a frozen revision. */
async function corruptFrozen(probeId: string, sequence: 1 | 2, kind: Corruption) {
  const db = testDb();
  const [issuance] = await db
    .select()
    .from(assessment_issuance)
    .where(eq(assessment_issuance.issuance_id, `iss_probe_${probeId}`));
  const [revision] = await db
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, issuance.revision_id));
  const contract = revisionRowToContract(revision);
  const criterion = contract.scoring_basis.units[0].criterion;
  if (criterion.kind !== 'rule_reference') throw new Error('fixture needs rule reference');
  if (kind === 'reference') criterion.statement_md = '错误的导入参考，漏掉内层导数。';
  else if (kind === 'prompt')
    contract.structure.parts[0].prompt_md = '错误导入的题干，求 sin(x⁴) 的导数。';
  else if (kind === 'execution') {
    const executor = contract.execution_plan.assignments[0].executor;
    if (executor.kind !== 'model_executor') throw new Error('expected admitted model');
    executor.task_kind = 'JevScoringDecisionTask';
  } else {
    const spec = sequence === 1 ? PRIMARY : FOLLOWUP;
    criterion.probe_spec = ConjectureProbeSpecV2.parse({
      ...spec,
      schema_version: 2,
      response_mode: 'short_answer',
      gold_response_signature: { kind: 'text', response_md: spec.reference_md },
      target_error_response_signature: {
        kind: 'text',
        response_md: spec.expected_target_error_answer_md,
      },
    });
  }
  contract.integrity_digest = contractIntegrityDigest(contract);
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.assessment_restore_mode = 'on'`);
    await tx
      .update(question_revision)
      .set({
        structure: contract.structure,
        scoring_basis: contract.scoring_basis,
        execution_plan: contract.execution_plan,
        integrity_digest: contract.integrity_digest,
      })
      .where(eq(question_revision.revision_id, revision.revision_id));
  });
  await expect(
    db
      .update(question_revision)
      .set({ integrity_digest: 'ordinary-writer-must-fail' })
      .where(eq(question_revision.revision_id, revision.revision_id)),
  ).rejects.toMatchObject({ cause: { code: 'P0001' } });
}

describe('YUK-1364 historical V1 issued probe compatibility', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    __resetRateLimitForTests();
    await resetDb();
    await testDb()
      .insert(knowledge)
      .values({ id: CHANGE.knowledge_id, name: '链式法则', created_at: NOW, updated_at: NOW });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.useRealTimers());

  it.each(
    SEQUENCES.flatMap((sequence) =>
      [true, false].map((specPresent) => ({ sequence, specPresent })),
    ),
  )(
    'rejects foreign execution before dispatch for legacy spec=$specPresent sequence=$sequence',
    async ({ sequence, specPresent }) => {
      const probeId = await seed(sequence, specPresent);
      await admitAndIssue(probeId, (c) => {
        const originalCriterion = structuredClone(c.scoring_basis.units[0].criterion);
        const executor = c.execution_plan.assignments[0].executor;
        if (executor.kind !== 'model_executor') throw new Error('model expected');
        executor.task_kind = 'JevScoringDecisionTask';
        expect(c.scoring_basis.units[0].criterion).toEqual(originalCriterion);
      });
      const execute = vi.fn<Parameters<typeof createRecordedModelExecutor>[1]>(async (input) => ({
        kind: 'scored',
        points_awarded: 1,
        matched: {
          rule_id:
            input.unit.criterion.kind === 'rule_reference' ? input.unit.criterion.rule_id : '',
          option_ids: [],
        },
        confidence: 0.9,
        feedback_md: 'Offline foreign score, no provider invocation.',
        evidence_citations: [],
        run_refs: [],
        cost_usd_micros: 0,
      }));
      const jev = vi
        .spyOn(jevExecutor, 'createJevModelExecutor')
        .mockImplementation(
          (options) => (input, signal) =>
            execute(input, signal, options.taskRunId ?? 'missing-claim'),
        );
      const pi = vi.spyOn(piExecutor, 'createPiModelExecutor').mockImplementation(() => {
        throw new Error('foreign task must reach Jev, not Pi');
      });
      const factory = vi.spyOn(evaluationService, 'createFormalModelExecutor');
      const before = await snapshot();
      expect.soft((await loadTeachingBrief(testDb(), NOW)).brief).toBeNull();
      expect.soft((await loadActiveProbes(testDb())).probes).toEqual([]);
      const response = await answer(probeId);
      const body = await response.json();
      const evaluations = await testDb().select().from(evaluation);
      const events = await testDb().select().from(event);
      console.info(
        '[legacy execution rejection]',
        JSON.stringify({
          sequence,
          specPresent,
          status: response.status,
          body,
          executed_descriptor: execute.mock.calls[0]?.[0].executor,
          jev_dispatch: jev.mock.calls.length,
          pi_dispatch: pi.mock.calls.length,
          submission: (await testDb().select().from(assessment_submission)).length,
          evaluations: evaluations.map((row) => ({
            aggregate: row.aggregate,
            unit_results: row.unit_results,
          })),
          probe_results: events
            .filter((row) => row.action === 'experimental:probe_result')
            .map((row) => row.payload),
        }),
      );
      expect.soft(response.status).toBe(409);
      expect.soft(body).toMatchObject({ error: 'probe_execution_contract_mismatch' });
      expect.soft(factory).not.toHaveBeenCalled();
      expect.soft(jev).not.toHaveBeenCalled();
      expect.soft(pi).not.toHaveBeenCalled();
      expect.soft(execute).not.toHaveBeenCalled();
      expect.soft(await snapshot()).toEqual(before);
    },
  );

  it.each(
    SEQUENCES.flatMap((sequence) =>
      [true, false].map((specPresent) => ({ sequence, specPresent })),
    ),
  )(
    'keeps canonical legacy human execution spec=$specPresent sequence=$sequence',
    async ({ sequence, specPresent }) => {
      const probeId = await seed(sequence, specPresent);
      await admitAndIssue(probeId, (c) => {
        c.execution_plan.assignments[0].executor = { kind: 'human_review' };
      });
      const completed = await answerProbe({
        db: testDb(),
        probeQuestionId: probeId,
        outcome: 1,
        now: NOW,
      });
      expect(
        await validateAckableOutcome(
          testDb(),
          await resultRow(completed.probe_result_event_id),
          NOW,
        ),
      ).not.toHaveProperty('reason');
      // Immutable historical human-review publication remains readable after ordinary edits.
      await editCompleted(probeId);
      expect(await status(completed.probe_result_event_id)).toBe('active');
    },
  );

  it.each(
    SEQUENCES.flatMap((sequence) =>
      [true, false].map((specPresent) => ({ sequence, specPresent })),
    ),
  )(
    'shows and grades valid legacy spec=$specPresent sequence=$sequence, preserving native completion after normal edits',
    async ({ sequence, specPresent }) => {
      const probeId = await seed(sequence, specPresent);
      await admitAndIssue(probeId);
      const spec = sequence === 1 ? PRIMARY : FOLLOWUP;
      const { execute } = scriptedJudge();
      const before = await snapshot();
      expect.soft((await loadTeachingBrief(testDb(), NOW)).brief).toMatchObject({
        state: 'probe_ready',
        prepared_action: { probe_question_id: probeId, prompt_md: spec.prompt_md },
      });
      expect.soft((await loadActiveProbes(testDb())).probes).toEqual([
        {
          probe_question_id: probeId,
          prompt_md: spec.prompt_md,
          knowledge_id: CHANGE.knowledge_id,
        },
      ]);
      expect(await snapshot()).toEqual(before);
      const response = await answer(probeId);
      expect(response.status).toBe(200);
      const result = ProbeAnswerResponseSchema.parse(await response.json());
      expect(result).toMatchObject({ status: 'retired', coarse_outcome: 'correct' });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][0].unit.criterion).toMatchObject({
        statement_md: `${spec.reference_md}\n\n（判分意图：multimodal_direct）`,
      });
      expect(execute.mock.calls[0][0].unit.criterion).not.toHaveProperty('probe_spec');
      const [submission] = await testDb().select().from(assessment_submission);
      const [evaluated] = await testDb().select().from(evaluation);
      const row = await resultRow(result.probe_result_event_id);
      expect(row.payload).toMatchObject({
        assessment: {
          issuance_id: `iss_probe_${probeId}`,
          submission_id: submission.submission_id,
          evaluation_id: evaluated.evaluation_id,
        },
      });
      await editCompleted(probeId);
      expect(await validateAckableOutcome(testDb(), row, NOW)).not.toHaveProperty('reason');
      expect(await status(row.id)).toBe('active');
      expect((await loadTeachingBrief(testDb(), NOW)).brief).toMatchObject({
        state: 'outcome_retired',
        current_outcome: { probe_result_event_id: row.id },
      });
      expect(await report()).toMatchObject({
        outcomes: { evidence_for: 0, confirmed: 0, retired: 1 },
        skipped_corrupt_outcomes: 0,
      });
      expect((await ack(row.id)).status).toBe(201);
    },
  );

  it.each(SEQUENCES)(
    'retains historical completed V1 sequence %s across edits, report and idempotent ack',
    async (sequence) => {
      const probeId = await seed(sequence);
      await admitAndIssue(probeId);
      const { execute, factory } = scriptedJudge();
      const completed = await answerProbe({
        db: testDb(),
        probeQuestionId: probeId,
        outcome: 1,
        now: NOW,
      });
      const row = await resultRow(completed.probe_result_event_id);
      expect(row.payload).not.toHaveProperty('assessment');
      await editCompleted(probeId);
      const before = await snapshot();
      expect.soft(await validateAckableOutcome(testDb(), row, NOW)).not.toHaveProperty('reason');
      expect.soft(await status(row.id)).toBe('active');
      expect.soft((await loadTeachingBrief(testDb(), NOW)).brief).toMatchObject({
        state: 'outcome_retired',
        current_outcome: { probe_result_event_id: row.id },
      });
      expect.soft(await report()).toMatchObject({
        outcomes: { evidence_for: 0, confirmed: 0, retired: 1 },
        probe_completion: { numerator: 1, denominator: 1, rate: 1 },
        skipped_corrupt_outcomes: 0,
      });
      expect(await snapshot()).toEqual(before);
      expect.soft((await ack(row.id)).status).toBe(201);
      const repeated = await ack(row.id);
      expect.soft(repeated.status).toBe(200);
      expect.soft(await repeated.json()).toMatchObject({ idempotent: true });
      expect(factory).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each(['support', 'terminal', 'proposal'] as const)(
    'confirms V1 recurrence after completed edits and preserves %s correction folds',
    async (target) => {
      const initial = await seed(1);
      await admitAndIssue(initial);
      const { execute } = scriptedJudge(0);
      const firstResponse = await answer(initial);
      expect(firstResponse.status).toBe(200);
      const first = ProbeAnswerResponseSchema.parse(await firstResponse.json());
      expect(first.status).toBe('evidence_for');
      await editCompleted(initial);
      expect((await ack(first.probe_result_event_id)).status).toBe(201);
      const [followup] = (await testDb().select().from(question)).filter(
        (q) => q.source_ref === 'v1_proposal' && q.metadata?.probe_sequence === 2,
      );
      expect(followup.metadata).toMatchObject({ probe_spec: FOLLOWUP });
      await admitAndIssue(followup.id);
      expect((await loadTeachingBrief(testDb(), NOW)).brief?.prepared_action).toMatchObject({
        probe_question_id: followup.id,
        prompt_md: FOLLOWUP.prompt_md,
      });
      const terminalResponse = await answer(followup.id);
      expect(terminalResponse.status).toBe(200);
      const terminal = ProbeAnswerResponseSchema.parse(await terminalResponse.json());
      expect(terminal.status).toBe('confirmed');
      const row = await resultRow(terminal.probe_result_event_id);
      expect(row.payload).toMatchObject({
        resolution_rule_version: PROBE_RESOLUTION_RULE_VERSION,
        independent_probe_question_ids: expect.arrayContaining([initial, followup.id]),
      });
      await editCompleted(followup.id);
      expect(await status(row.id)).toBe('active');
      expect(await validateAckableOutcome(testDb(), row, NOW)).not.toHaveProperty('reason');
      expect(await report()).toMatchObject({
        outcomes: { evidence_for: 1, confirmed: 1, retired: 0 },
        probe_completion: { numerator: 2, denominator: 2, rate: 1 },
        skipped_corrupt_outcomes: 0,
      });
      const targetId =
        target === 'support'
          ? first.probe_result_event_id
          : target === 'terminal'
            ? row.id
            : 'v1_proposal';
      for (const [index, kind] of (['retract', 'restore'] as const).entries()) {
        const now = new Date(NOW.getTime() + (index + 1) * 1000);
        vi.setSystemTime(now);
        await writeEvent(testDb(), {
          id: `${target}_${kind}`,
          actor_kind: 'user',
          actor_ref: 'self',
          action: 'correct',
          subject_kind: 'event',
          subject_id: targetId,
          outcome: 'success',
          caused_by_event_id: targetId,
          payload: {
            correction_kind: kind,
            reason_md: '历史 V1 完成来源撤回与恢复。',
            affected_refs: [{ kind: 'question', id: initial }],
          },
          created_at: now,
        });
        expect(await status(row.id)).toBe(
          kind === 'restore'
            ? 'active'
            : target === 'terminal'
              ? 'corrected'
              : 'dependency_inactive',
        );
        if (kind === 'retract') {
          expect((await loadTeachingBrief(testDb(), now)).brief).toBeNull();
          expect((await ack(row.id)).status).toBe(409);
        } else {
          expect((await loadTeachingBrief(testDb(), now)).brief).toMatchObject({
            state: 'outcome_confirmed',
          });
          expect((await ack(row.id)).status).toBe(201);
        }
      }
      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute.mock.calls.map(([input]) => input.question_parts)).toMatchObject([
        [{ prompt_md: PRIMARY.prompt_md }],
        [{ prompt_md: FOLLOWUP.prompt_md }],
      ]);
      expect(
        execute.mock.calls.every(
          ([input]) =>
            input.unit.criterion.kind === 'rule_reference' &&
            input.unit.criterion.probe_spec === undefined,
        ),
      ).toBe(true);
    },
  );

  it.each(CORRUPTION_CASES)(
    'rejects V1 $kind in sequence $sequence before visible delivery or executor admission',
    async ({ sequence, kind, reason }) => {
      const probeId = await seed(sequence);
      await admitAndIssue(probeId);
      await corruptFrozen(probeId, sequence, kind);
      const { execute, factory } = scriptedJudge();
      const before = await snapshot();
      expect((await loadTeachingBrief(testDb(), NOW)).brief?.prepared_action).not.toMatchObject({
        probe_question_id: probeId,
      });
      expect((await loadActiveProbes(testDb())).probes).toEqual([]);
      const response = await answer(probeId);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: reason });
      expect(factory).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each(
    CORRUPTION_CASES.flatMap((entry) =>
      [true, false].map((specPresent) => ({ ...entry, specPresent })),
    ),
  )(
    'rejects completed legacy spec=$specPresent $kind in sequence $sequence across evidence, report and ack',
    async ({ sequence, specPresent, kind, reason }) => {
      const probeId = await seed(sequence, specPresent);
      await admitAndIssue(probeId);
      const completed = await answerProbe({
        db: testDb(),
        probeQuestionId: probeId,
        outcome: 1,
        now: NOW,
      });
      await editCompleted(probeId);
      await corruptFrozen(probeId, sequence, kind);
      const row = await resultRow(completed.probe_result_event_id);
      const before = await snapshot();
      expect(await validateAckableOutcome(testDb(), row, NOW)).toEqual({ reason });
      expect(await status(row.id)).toBe('dependency_inactive');
      expect((await loadTeachingBrief(testDb(), NOW)).brief).toBeNull();
      expect(await report()).toMatchObject({
        outcomes: { evidence_for: 0, confirmed: 0, retired: 0 },
        skipped_corrupt_outcomes: 1,
      });
      expect((await ack(row.id)).status).toBe(409);
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each(SEQUENCES)(
    'rejects malformed original V1 sequence %s without interpreting it as an absent spec',
    async (sequence) => {
      const probeId = await seed(sequence);
      await admitAndIssue(probeId);
      const original = await resultRow('v1_proposal');
      const field = sequence === 1 ? 'probe_spec' : 'followup_probe_spec';
      const malformed = {
        ...(sequence === 1 ? PRIMARY : FOLLOWUP),
        unparsed_scoring_rule: 'must reject',
      };
      expect(ConjectureProbeSpecV1.safeParse(malformed).success).toBe(false);
      await testDb()
        .update(event)
        .set({
          payload: sql`jsonb_set(${event.payload}, ARRAY['ai_proposal', 'proposed_change', ${field}], ${JSON.stringify(malformed)}::jsonb)`,
        })
        .where(eq(event.id, original.id));
      const { execute, factory } = scriptedJudge();
      const before = await snapshot();
      expect((await loadTeachingBrief(testDb(), NOW)).brief).toBeNull();
      expect((await loadActiveProbes(testDb())).probes).toEqual([]);
      const response = await answer(probeId);
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ error: 'probe_proposal_invalid' });
      expect(factory).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
    },
  );
});
