import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProbeAnswerResponseSchema } from '@/capabilities/agency/api/contracts';
import { POST as ANSWER } from '@/capabilities/agency/api/probe-answer';
import {
  getEffectiveProbeResultStatuses,
  serveProbeOnce,
  servePublishedProbe,
} from '@/capabilities/agency/public';
import * as evaluationService from '@/capabilities/practice/server/judge/evaluate-submission';
import { createRecordedModelExecutor } from '@/capabilities/practice/server/judge/recorded-model-executor';
import type { PublishedQuestionRevisionT, RuleReferenceCriterionT } from '@/core/schema/assessment';
import { ConjectureProbeSpecV2, type ConjectureProbeSpecV2T } from '@/core/schema/business';
import { PROBE_QUESTION_INITIAL_VERSION } from '@/core/schema/conjecture';
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
import { contractIntegrityDigest } from '@/kernel/records/assessment-normalization';
import { publishQuestionGroup } from '@/kernel/records/assessment-publication';
import * as jevExecutor from '@/server/assessment/jev-model-executor';
import * as piExecutor from '@/server/assessment/pi-model-executor';
import { __resetRateLimitForTests } from '@/server/http/rate-limit';
import { editQuestion } from '@/server/questions/write';
import { loadTeachingBriefReportInput } from '../../../../scripts/report-teaching-brief';
import { publishPaperModelFixture } from '../../../../tests/fixtures/assessment-paper';
import { withProbeSpecs } from '../../../../tests/fixtures/conjecture-probe-spec';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { POST as ACK } from '../api/teaching-brief-ack';
import { loadActiveProbes } from './prep-desk-probes';
import { loadTeachingBrief, validateAckableOutcome } from './teaching-brief';

const NOW = new Date('2026-10-07T12:00:00Z');
const PRIMARY = ConjectureProbeSpecV2.parse({
  schema_version: 2,
  prompt_md:
    '求 sin(x²) 的导数。解释外层与内层导数如何组合，并说明 x=0 的特殊值为何不能验证一般规则。',
  reference_md: '2x cos(x²)。外层 cos(x²) 与内层 2x 相乘；特殊点相同不能证明函数恒等。',
  expected_target_error_answer_md: 'cos(x²) + 2x，把内外层导数相加。',
  elicits_target_error_reason_md: '把乘法规则与加法错误区分开，同时避免用特殊点推断一般结论。',
  context_kind: 'abstract',
  representation_kind: 'symbolic',
  response_mode: 'short_answer',
  gold_response_signature: { kind: 'text', response_md: '2x cos(x²)' },
  target_error_response_signature: { kind: 'text', response_md: 'cos(x²) + 2x' },
});
const FOLLOWUP = ConjectureProbeSpecV2.parse({
  ...PRIMARY,
  prompt_md:
    '面积变化率模型为 cos(t³)。求其瞬时变化率并解释内外层的组合；判断 t=0 能否验证全部时间。',
  reference_md: '-3t² sin(t³)。外层 -sin(t³) 与内层 3t² 相乘。',
  expected_target_error_answer_md: '-sin(t³) + 3t²，把内外层导数相加。',
  context_kind: 'applied',
  representation_kind: 'natural_language',
  gold_response_signature: { kind: 'text', response_md: '-3t² sin(t³)' },
  target_error_response_signature: { kind: 'text', response_md: '-sin(t³) + 3t²' },
});
const CHANGE = ConjectureProposalChange.parse({
  claim_md: '求导复合函数时可能把内外层导数相加。',
  knowledge_id: 'kn_chain_rule',
  cause_category: 'concept_misunderstanding',
  confidence: 0.7,
  recurrence_count: 2,
  probe_md: PRIMARY.prompt_md,
  probe_reference_md: PRIMARY.reference_md,
  followup_probe_md: FOLLOWUP.prompt_md,
  followup_probe_reference_md: FOLLOWUP.reference_md,
  discriminating: true,
  predicted_p: 0.3,
  baseline_p_at_induction: 0.6,
});

type SpecMutation = {
  name: string;
  mutate: (spec: ConjectureProbeSpecV2T) => ConjectureProbeSpecV2T;
};
const MUTATIONS: SpecMutation[] = [
  { name: 'prompt', mutate: (s) => ({ ...s, prompt_md: '另一份题干，要求求 sin(x³) 的导数。' }) },
  { name: 'reference', mutate: (s) => ({ ...s, reference_md: '另一份金标，3x² cos(x³)。' }) },
  {
    name: 'gold signature',
    mutate: (s) => ({
      ...s,
      gold_response_signature: { kind: 'text', response_md: '错误金标：内外层导数相加。' },
    }),
  },
  {
    name: 'target-error signature',
    mutate: (s) => ({
      ...s,
      target_error_response_signature: {
        kind: 'text',
        response_md: '另一种错误：遗漏全部内层因子。',
      },
    }),
  },
  {
    name: 'expected target-error answer',
    mutate: (s) => ({
      ...s,
      expected_target_error_answer_md: '遗漏内层因子，这是另一个错误规则。',
    }),
  },
  {
    name: 'elicitation rule',
    mutate: (s) => ({ ...s, elicits_target_error_reason_md: '只检测外层负号，不检测内外层组合。' }),
  },
  {
    name: 'context',
    mutate: (s) => ({ ...s, context_kind: s.context_kind === 'abstract' ? 'applied' : 'abstract' }),
  },
  {
    name: 'representation',
    mutate: (s) => ({
      ...s,
      representation_kind: s.representation_kind === 'symbolic' ? 'natural_language' : 'symbolic',
    }),
  },
  {
    name: 'response mode and nested reason signatures',
    mutate: (s) => ({
      ...s,
      response_mode: 'answer_with_reason',
      gold_response_signature: {
        kind: 'answer_with_reason',
        answer_md: s.reference_md,
        required_reason_features_md: ['说明外层导数。', '解释内外层为何相乘。'],
      },
      target_error_response_signature: {
        kind: 'answer_with_reason',
        answer_md: s.expected_target_error_answer_md,
        required_reason_features_md: ['说明加法错误规则。'],
      },
    }),
  },
];
const CASES = ([1, 2] as const).flatMap((sequence) =>
  MUTATIONS.map((mutation) => ({ sequence, ...mutation })),
);
const MODES = [
  {
    mode: 'single_choice',
    gold: { kind: 'choice', option_ids: ['A'] },
    target: { kind: 'choice', option_ids: ['B'] },
  },
  {
    mode: 'multiple_select',
    gold: { kind: 'choice', option_ids: ['A', 'C'] },
    target: { kind: 'choice', option_ids: ['B', 'D'] },
  },
  {
    mode: 'short_answer',
    gold: PRIMARY.gold_response_signature,
    target: PRIMARY.target_error_response_signature,
  },
  {
    mode: 'answer_with_reason',
    gold: {
      kind: 'answer_with_reason',
      answer_md: PRIMARY.reference_md,
      required_reason_features_md: ['外层导数。', '内层因子。'],
    },
    target: {
      kind: 'answer_with_reason',
      answer_md: PRIMARY.expected_target_error_answer_md,
      required_reason_features_md: ['把内外层导数相加。', '错误地用特殊点验证恒等。'],
    },
  },
  {
    mode: 'constructed_response',
    gold: { kind: 'rubric', required_features_md: ['正确外层导数。', '乘以内层导数。'] },
    target: { kind: 'rubric', required_features_md: ['错误外层组合。', '内外层导数相加。'] },
  },
] as const;
const MODE_CASES = ([1, 2] as const).flatMap((sequence) =>
  MODES.map((mode) => ({ sequence, ...mode })),
);
const SIGNATURE_CASES = MODE_CASES.flatMap((mode) =>
  (['gold_response_signature', 'target_error_response_signature'] as const).map((field) => ({
    ...mode,
    field,
  })),
);

type CriterionMutation = {
  name: string;
  mutate: (criterion: RuleReferenceCriterionT) => void;
};
const CRITERION_MUTATIONS: CriterionMutation[] = [
  {
    name: 'statement',
    mutate: (criterion) => {
      criterion.statement_md = '只要外层导数正确就给满分；无需内层因子，忽略原有完整作答要求。';
    },
  },
  {
    name: 'rule identity',
    mutate: (criterion) => {
      criterion.rule_id = 'unrelated:probe-v2';
    },
  },
  {
    name: 'authority',
    mutate: (criterion) => {
      criterion.source = 'official';
    },
  },
];
const CRITERION_CASES = ([1, 2] as const).flatMap((sequence) =>
  CRITERION_MUTATIONS.map((mutation) => ({ sequence, ...mutation })),
);

type ExecutionContract = Pick<
  PublishedQuestionRevisionT,
  'execution_plan' | 'scoring_basis' | 'response_spec' | 'structure'
>;
type ExecutionMutation = {
  name: string;
  mutate: (contract: ExecutionContract) => void;
};
const EXECUTION_MUTATIONS: ExecutionMutation[] = [
  {
    name: 'foreign Jev task',
    mutate: (c) => {
      const executor = c.execution_plan.assignments[0].executor;
      if (executor.kind !== 'model_executor') throw new Error('expected model executor');
      executor.task_kind = 'JevScoringDecisionTask';
    },
  },
  {
    name: 'unknown model task',
    mutate: (c) => {
      const executor = c.execution_plan.assignments[0].executor;
      if (executor.kind !== 'model_executor') throw new Error('expected model executor');
      executor.task_kind = 'UnknownProbeTask';
    },
  },
  {
    name: 'human executor',
    mutate: (c) => {
      c.execution_plan.assignments[0].executor = { kind: 'human_review' };
    },
  },
  {
    name: 'zero points',
    mutate: (c) => {
      c.scoring_basis.units[0].points = 0;
    },
  },
  {
    name: 'two points',
    mutate: (c) => {
      c.scoring_basis.units[0].points = 2;
    },
  },
  {
    name: 'missing response binding',
    mutate: (c) => {
      c.scoring_basis.units[0].slot_refs = [];
    },
  },
  {
    name: 'missing evidence binding',
    mutate: (c) => {
      c.scoring_basis.units[0].evidence_slot_refs = [];
    },
  },
  {
    name: 'group evidence requirement',
    mutate: (c) => {
      c.scoring_basis.units[0].requires_group_evidence = true;
    },
  },
  {
    name: 'additional model material',
    mutate: (c) => {
      c.scoring_basis.units[0].material_refs = [c.structure.materials[0].material_id];
    },
  },
  {
    name: 'blank scoring bypass',
    mutate: (c) => {
      c.scoring_basis.blank_scores_zero = true;
    },
  },
  {
    name: 'capped aggregation',
    mutate: (c) => {
      c.scoring_basis.aggregation = { kind: 'capped_sum', cap: 0 };
    },
  },
  {
    name: 'low confidence acceptance',
    mutate: (c) => {
      c.execution_plan.escalation.on_low_confidence = 'accept';
    },
  },
  {
    name: 'unadmitted escalation',
    mutate: (c) => {
      c.execution_plan.escalation.on_unadmitted_model = 'human_review';
    },
  },
];
const EXECUTION_CASES = ([1, 2] as const).flatMap((sequence) =>
  EXECUTION_MUTATIONS.map((mutation) => ({ sequence, ...mutation })),
);
const INVALID_ASSIGNMENTS: ExecutionMutation[] = [
  {
    name: 'deterministic rule comparator',
    mutate: (c) => {
      c.execution_plan.assignments[0].executor = {
        kind: 'deterministic',
        comparator: 'exact_text',
      };
    },
  },
  {
    name: 'unknown assignment unit',
    mutate: (c) => {
      c.execution_plan.assignments[0].scoring_unit_ids = ['foreign-unit'];
    },
  },
  {
    name: 'duplicate assignment unit',
    mutate: (c) => {
      c.execution_plan.assignments[0].scoring_unit_ids.push(
        c.scoring_basis.units[0].scoring_unit_id,
      );
    },
  },
  {
    name: 'duplicate assignment',
    mutate: (c) => {
      c.execution_plan.assignments.push(structuredClone(c.execution_plan.assignments[0]));
    },
  },
];

/** Restore/import corruption only; normal publication cannot create invalid assignment bindings. */
async function replaceFrozenExecution(probeId: string, mutate: ExecutionMutation['mutate']) {
  const db = testDb();
  const [issuance] = await db
    .select()
    .from(assessment_issuance)
    .where(eq(assessment_issuance.issuance_id, `iss_probe_${probeId}`));
  const [revision] = await db
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, issuance.revision_id));
  mutate(revision);
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.assessment_restore_mode = 'on'`);
    await tx
      .update(question_revision)
      .set({
        scoring_basis: revision.scoring_basis,
        execution_plan: revision.execution_plan,
        integrity_digest: contractIntegrityDigest(revision),
      })
      .where(eq(question_revision.revision_id, revision.revision_id));
  });
  await expect(
    db
      .update(question_revision)
      .set({ execution_plan: revision.execution_plan })
      .where(eq(question_revision.revision_id, revision.revision_id)),
  ).rejects.toMatchObject({ cause: { code: 'P0001' } });
}

/** Model corrupted imported/restore bindings without weakening production immutability. */
async function replaceFrozenCriterion(probeId: string, patch: Record<string, unknown>) {
  const db = testDb();
  const [issuance] = await db
    .select()
    .from(assessment_issuance)
    .where(eq(assessment_issuance.issuance_id, `iss_probe_${probeId}`));
  const [revision] = await db
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, issuance.revision_id));
  const copy = structuredClone(revision);
  const scoringBasis = {
    ...copy.scoring_basis,
    units: copy.scoring_basis.units.map((unit) => ({
      ...unit,
      criterion: { ...unit.criterion, ...patch },
    })),
  };
  copy.integrity_digest = contractIntegrityDigest({ ...copy, scoring_basis: scoringBasis });
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.assessment_restore_mode = 'on'`);
    await tx
      .update(question_revision)
      .set({
        scoring_basis: sql`${JSON.stringify(scoringBasis)}::jsonb`,
        integrity_digest: copy.integrity_digest,
      })
      .where(eq(question_revision.revision_id, copy.revision_id));
  });
  await expect(
    db
      .update(question_revision)
      .set({ integrity_digest: 'ordinary-writer-must-fail' })
      .where(eq(question_revision.revision_id, copy.revision_id)),
  ).rejects.toMatchObject({ cause: { code: 'P0001' } });
}

async function replaceFrozenSpec(probeId: string, spec: unknown) {
  await replaceFrozenCriterion(probeId, { probe_spec: spec });
}

async function seed(
  sequence: 1 | 2,
  frozenSpec: ConjectureProbeSpecV2T | null,
  nativeProposal = true,
  pair = { primary: PRIMARY, followup: FOLLOWUP },
  mutateCriterion?: CriterionMutation['mutate'],
  mutateExecution?: ExecutionMutation['mutate'],
) {
  const db = testDb();
  const original = sequence === 1 ? pair.primary : pair.followup;
  await writeAiProposal(db, {
    id: 'original_proposal',
    actor_ref: 'research_meeting',
    created_at: new Date(NOW.getTime() - 600_000),
    payload: {
      kind: 'conjecture',
      target: { subject_kind: 'mind_model', subject_id: CHANGE.knowledge_id },
      reason_md: '两次嵌套求导出错，另一次独立练习正确；冻结完整探针以区分稳定错误与偶发失误。',
      evidence_refs: [{ kind: 'event', id: 'offline-evidence' }],
      cooldown_key: 'complete-spec',
      proposed_change: nativeProposal
        ? withProbeSpecs(CHANGE, pair.primary, pair.followup)
        : CHANGE,
    },
  });
  await writeEvent(db, {
    id: 'accepted_original',
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'rate',
    subject_kind: 'event',
    subject_id: 'original_proposal',
    outcome: 'success',
    payload: { rating: 'accept', conjecture_id: 'original_proposal', calibration_anchor: 'accept' },
    caused_by_event_id: 'original_proposal',
    created_at: NOW,
  });
  const served = await serveProbeOnce({
    db,
    conjectureProposalId: 'original_proposal',
    knowledgeId: CHANGE.knowledge_id,
    probeMd: original.prompt_md,
    referenceMd: original.reference_md,
    probeSequence: sequence,
    ...(nativeProposal ? { probeSpec: original } : {}),
    now: new Date(NOW.getTime() - 600_000),
  });
  if (served.status !== 'served') throw new Error(`fixture serve: ${served.status}`);
  const probeId = served.probe_question_id;
  const contract = await publishPaperModelFixture(db, probeId);
  const criterion = contract.scoring_basis.units[0].criterion;
  if (criterion.kind !== 'rule_reference') throw new Error('fixture needs a rule reference');
  if (frozenSpec) criterion.probe_spec = frozenSpec;
  else delete criterion.probe_spec;
  mutateCriterion?.(criterion);
  mutateExecution?.(contract);
  contract.integrity_digest = contractIntegrityDigest(contract);
  const [lifecycle] = await db
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, probeId));
  expect(
    await publishQuestionGroup(db, {
      group_id: probeId,
      contract,
      expectedCurrentRevision: lifecycle.current_revision_id,
      expectedAdmissionGeneration: lifecycle.scoring_admission_generation,
      availability: lifecycle.availability,
      actorRef: 'test:complete-spec',
      now: NOW,
      admission: { state: 'admitted', evidence: lifecycle.scoring_admission_evidence },
    }),
  ).toMatchObject({ status: 'published' });
  expect(await servePublishedProbe(db, probeId)).toMatchObject({ status: 'issued' });
  return probeId;
}

function pairForMode(mode: (typeof MODES)[number]) {
  const convert = (spec: ConjectureProbeSpecV2T) =>
    ConjectureProbeSpecV2.parse({
      ...spec,
      response_mode: mode.mode,
      gold_response_signature:
        mode.mode === 'short_answer'
          ? spec.gold_response_signature
          : mode.mode === 'answer_with_reason'
            ? { ...mode.gold, answer_md: spec.reference_md }
            : mode.gold,
      target_error_response_signature:
        mode.mode === 'short_answer'
          ? spec.target_error_response_signature
          : mode.mode === 'answer_with_reason'
            ? { ...mode.target, answer_md: spec.expected_target_error_answer_md }
            : mode.target,
    });
  return { primary: convert(PRIMARY), followup: convert(FOLLOWUP) };
}

function offlineJudge(match: 'gold' | 'target_error' | 'neither' = 'gold') {
  const execute = vi.fn<Parameters<typeof createRecordedModelExecutor>[1]>(
    async (input, _signal, runId) => ({
      kind: 'scored',
      points_awarded: match === 'gold' ? (input.unit.points ?? 0) : 0,
      matched: {
        rule_id: input.unit.criterion.kind === 'rule_reference' ? input.unit.criterion.rule_id : '',
        option_ids: [],
      },
      probe_signature_match: {
        match,
        explanation_md: '脚本化签名匹配，仅验证本地真实评分持久化与来源约束。',
      },
      confidence: 0.9,
      feedback_md: '离线模型，无 provider 调用。',
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
      body: JSON.stringify({
        answer_md: '给出完整推导，外层与内层导数相乘并排除特殊点的偶然相同。',
      }),
    }),
    { id: probeId },
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
async function expectRejected(
  probeId: string,
  reason = 'probe_spec_mismatch',
  judge = offlineJudge(),
) {
  const { execute, factory } = judge;
  const before = await snapshot();
  expect
    .soft((await loadTeachingBrief(testDb(), NOW)).brief?.prepared_action)
    .not.toMatchObject({ probe_question_id: probeId });
  expect
    .soft((await loadActiveProbes(testDb())).probes)
    .not.toEqual(expect.arrayContaining([expect.objectContaining({ probe_question_id: probeId })]));
  const response = await answer(probeId);
  const body: unknown = await response.json();
  expect.soft(response.status).toBe(409);
  expect.soft(body).toMatchObject({ error: reason });
  expect.soft(factory).not.toHaveBeenCalled();
  expect.soft(execute).not.toHaveBeenCalled();
  expect.soft(await testDb().select().from(assessment_submission)).toHaveLength(0);
  expect.soft(await testDb().select().from(evaluation)).toHaveLength(0);
  expect.soft(await testDb().select().from(ai_task_runs)).toHaveLength(0);
  expect.soft(await testDb().select().from(provider_attempt)).toHaveLength(0);
  expect.soft(await testDb().select().from(provider_attempt_admission)).toHaveLength(0);
  expect.soft(await testDb().select().from(cost_ledger)).toHaveLength(0);
  expect
    .soft(
      (await testDb().select().from(event)).filter(
        (e) => e.action === 'experimental:probe_judge_started',
      ),
    )
    .toHaveLength(0);
  expect.soft(await snapshot()).toEqual(before);
  console.info(
    '[complete-spec rejection counts]',
    JSON.stringify({
      http_status: response.status,
      response: body,
      executed_descriptor: execute.mock.calls[0]?.[0].executor,
      persisted_units: (await testDb().select().from(evaluation)).map((row) => row.unit_results),
      executed_criterion: execute.mock.calls[0]?.[0].unit.criterion,
      factory: factory.mock.calls.length,
      executor: execute.mock.calls.length,
      judge_claim: (await testDb().select().from(event)).filter(
        (e) => e.action === 'experimental:probe_judge_started',
      ).length,
      submission: (await testDb().select().from(assessment_submission)).length,
      evaluation: (await testDb().select().from(evaluation)).length,
      task_run: (await testDb().select().from(ai_task_runs)).length,
      provider_attempt: (await testDb().select().from(provider_attempt)).length,
      provider_admission: (await testDb().select().from(provider_attempt_admission)).length,
      cost_ledger: (await testDb().select().from(cost_ledger)).length,
    }),
  );
}

/** Keep production dispatch/receipts; replace only the foreign executor with an offline script. */
function foreignDispatchJudge() {
  const execute = vi.fn<Parameters<typeof createRecordedModelExecutor>[1]>(async (input) => ({
    kind: 'scored',
    points_awarded: 1,
    matched: {
      rule_id: input.unit.criterion.kind === 'rule_reference' ? input.unit.criterion.rule_id : '',
      option_ids: [],
    },
    confidence: 0.9,
    feedback_md: 'Offline foreign score without native probe signature.',
    evidence_citations: [],
    run_refs: [],
    cost_usd_micros: 0,
  }));
  vi.spyOn(jevExecutor, 'createJevModelExecutor').mockImplementation(
    (options) => (input, signal) => execute(input, signal, options.taskRunId ?? 'missing-claim'),
  );
  vi.spyOn(piExecutor, 'createPiModelExecutor').mockImplementation(() => {
    throw new Error('foreign task must reach Jev, not Pi');
  });
  const factory = vi.spyOn(evaluationService, 'createFormalModelExecutor');
  return { execute, factory };
}

describe('YUK-1364 complete original probe-spec binding', () => {
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

  it.each(EXECUTION_CASES)(
    'rejects pre-issuance execution $name in sequence $sequence',
    async ({ sequence, name, mutate }) => {
      const spec = sequence === 1 ? PRIMARY : FOLLOWUP;
      const probeId = await seed(sequence, spec, true, undefined, undefined, (contract) => {
        const criterion = structuredClone(contract.scoring_basis.units[0].criterion);
        mutate(contract);
        expect(contract.scoring_basis.units[0].criterion).toEqual(criterion);
      });
      const [authored] = await testDb().select().from(question).where(eq(question.id, probeId));
      expect(authored).toMatchObject({
        version: PROBE_QUESTION_INITIAL_VERSION,
        prompt_md: spec.prompt_md,
        reference_md: spec.reference_md,
        metadata: { probe_spec: spec },
      });
      await expectRejected(
        probeId,
        'probe_execution_contract_mismatch',
        name === 'foreign Jev task' ? foreignDispatchJudge() : offlineJudge(),
      );
    },
  );

  it.each(
    ([1, 2] as const).flatMap((sequence) =>
      INVALID_ASSIGNMENTS.map((entry) => ({ ...entry, sequence })),
    ),
  )(
    'normal publication rejects $name sequence $sequence and restored bindings fail before evaluation',
    async ({ sequence, mutate }) => {
      await expect(
        seed(sequence, sequence === 1 ? PRIMARY : FOLLOWUP, true, undefined, undefined, mutate),
      ).rejects.toThrow('execution_plan invalid');
      const [probe] = await testDb().select().from(question);
      expect(await testDb().select().from(assessment_issuance)).toHaveLength(0);
      expect(await servePublishedProbe(testDb(), probe.id)).toMatchObject({ status: 'issued' });
      await replaceFrozenExecution(probe.id, mutate);
      await expectRejected(probe.id, 'probe_execution_contract_mismatch');
    },
  );

  it.each([1, 2] as const)(
    'accepts dynamic admission and cost caps in sequence %s',
    async (sequence) => {
      const probeId = await seed(
        sequence,
        sequence === 1 ? PRIMARY : FOLLOWUP,
        true,
        undefined,
        undefined,
        (c) => {
          const executor = c.execution_plan.assignments[0].executor;
          if (executor.kind !== 'model_executor') throw new Error('model expected');
          executor.admitted_slice_id = `independently-admitted-sequence-${sequence}`;
          executor.max_cost_usd_micros = 4321;
          c.execution_plan.max_total_cost_usd_micros = 8765;
        },
      );
      const { execute } = offlineJudge();
      expect((await answer(probeId)).status).toBe(200);
      expect(execute.mock.calls[0][0].executor).toMatchObject({
        admitted_slice_id: `independently-admitted-sequence-${sequence}`,
        max_cost_usd_micros: 4321,
      });
    },
  );

  it.each(EXECUTION_CASES)(
    'rejects completed execution $name in sequence $sequence across evidence report and ack',
    async ({ sequence, mutate }) => {
      const probeId = await seed(sequence, sequence === 1 ? PRIMARY : FOLLOWUP);
      offlineJudge();
      const response = await answer(probeId);
      expect(response.status).toBe(200);
      const result = ProbeAnswerResponseSchema.parse(await response.json());
      const [row] = await testDb()
        .select()
        .from(event)
        .where(eq(event.id, result.probe_result_event_id));
      await replaceFrozenExecution(probeId, mutate);
      const before = await snapshot();
      expect(await validateAckableOutcome(testDb(), row, NOW)).toEqual({
        reason: 'probe_execution_contract_mismatch',
      });
      expect(
        (
          await getEffectiveProbeResultStatuses(testDb(), [row.id], { validateDirectChain: true })
        ).get(row.id),
      ).toBe('dependency_inactive');
      expect((await loadTeachingBrief(testDb(), NOW)).brief?.current_outcome).not.toMatchObject({
        probe_result_event_id: row.id,
      });
      const report = await loadTeachingBriefReportInput(testDb(), '2026-10-07', '2026-10-07');
      expect(report.probeResults).toEqual([]);
      expect(report.skippedCorruptOutcomes).toBe(1);
      expect(
        (
          await ACK(
            new Request('http://test.invalid/ack', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ probe_result_event_id: row.id }),
            }),
          )
        ).status,
      ).toBe(409);
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each(CRITERION_CASES)(
    'rejects pre-issuance V2 criterion $name drift in sequence $sequence',
    async ({ sequence, mutate }) => {
      const spec = sequence === 1 ? PRIMARY : FOLLOWUP;
      const probeId = await seed(sequence, spec, true, undefined, mutate);
      const [authored] = await testDb().select().from(question).where(eq(question.id, probeId));
      expect(authored).toMatchObject({
        version: PROBE_QUESTION_INITIAL_VERSION,
        prompt_md: spec.prompt_md,
        reference_md: spec.reference_md,
        metadata: { probe_spec: spec },
      });
      const [issuance] = await testDb()
        .select()
        .from(assessment_issuance)
        .where(eq(assessment_issuance.issuance_id, `iss_probe_${probeId}`));
      const [revision] = await testDb()
        .select()
        .from(question_revision)
        .where(eq(question_revision.revision_id, issuance.revision_id));
      expect(revision.scoring_basis.units[0].criterion).toMatchObject({ probe_spec: spec });
      await expectRejected(probeId, 'probe_criterion_mismatch');
    },
  );

  it.each(CASES)(
    'rejects complete spec drift in sequence $sequence: $name before advertisement or answer',
    async ({ sequence, name, mutate }) => {
      const original = sequence === 1 ? PRIMARY : FOLLOWUP;
      const drifted = ConjectureProbeSpecV2.parse(mutate(original));
      const probeId = await seed(sequence, drifted);
      // Even a matching mutable metadata copy cannot replace the original proposal.
      const [row] = await testDb().select().from(question).where(eq(question.id, probeId));
      if (name !== 'prompt' && name !== 'reference') {
        await testDb()
          .update(question)
          .set({ metadata: { ...row.metadata, probe_spec: drifted } })
          .where(eq(question.id, probeId));
      }
      await expectRejected(probeId);
    },
  );

  it.each(SIGNATURE_CASES)(
    'rejects changed nested $field for $mode in sequence $sequence',
    async ({ sequence, field, ...modeCase }) => {
      const pair = pairForMode(modeCase);
      const original = sequence === 1 ? pair.primary : pair.followup;
      const drifted = structuredClone(original);
      const signature = drifted[field];
      switch (signature.kind) {
        case 'choice':
          signature.option_ids = [...signature.option_ids, 'Z'];
          if (modeCase.mode === 'single_choice') signature.option_ids = ['Z'];
          break;
        case 'text':
          signature.response_md = '另一种目标错误。';
          break;
        case 'answer_with_reason':
          signature.required_reason_features_md.reverse();
          break;
        case 'rubric':
          signature.required_features_md.reverse();
          break;
      }
      await expectRejected(await seed(sequence, ConjectureProbeSpecV2.parse(drifted), true, pair));
    },
  );

  it.each(MODE_CASES)(
    'accepts the complete original $mode spec in sequence $sequence',
    async ({ sequence, ...modeCase }) => {
      const pair = pairForMode(modeCase);
      const spec = sequence === 1 ? pair.primary : pair.followup;
      const probeId = await seed(sequence, spec, true, pair);
      const { execute } = offlineJudge();
      const response = await answer(probeId);
      expect(response.status).toBe(200);
      expect(ProbeAnswerResponseSchema.parse(await response.json())).toMatchObject({
        status: 'retired',
        answer_result: 'correct',
        target_error_match: 'not_matched',
      });
      expect(execute.mock.calls[0][0].unit.criterion).toMatchObject({ probe_spec: spec });
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it('accepts schema-normalized spec whitespace and object key order', async () => {
    if (PRIMARY.target_error_response_signature.kind !== 'text')
      throw new Error('text fixture expected');
    const normalized = {
      ...PRIMARY,
      elicits_target_error_reason_md: `  ${PRIMARY.elicits_target_error_reason_md}  `,
      target_error_response_signature: {
        response_md: `  ${PRIMARY.target_error_response_signature.response_md}  `,
        kind: 'text' as const,
      },
    };
    const probeId = await seed(1, normalized);
    offlineJudge();
    const response = await answer(probeId);
    expect(response.status).toBe(200);
  });

  it('keeps full native recurrence, normal completed edits, corrections and criterion restoration consistent', async () => {
    const initial = await seed(1, PRIMARY);
    const { execute } = offlineJudge('target_error');
    const firstResponse = await answer(initial);
    expect(firstResponse.status).toBe(200);
    const first = ProbeAnswerResponseSchema.parse(await firstResponse.json());
    expect(first.status).toBe('evidence_for');
    expect(
      (
        await ACK(
          new Request('http://test.invalid/ack', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ probe_result_event_id: first.probe_result_event_id }),
          }),
        )
      ).status,
    ).toBe(201);
    const [followup] = (await testDb().select().from(question)).filter(
      (q) => q.source_ref === 'original_proposal' && q.metadata?.probe_sequence === 2,
    );
    expect(followup.metadata).toMatchObject({ probe_spec: FOLLOWUP });
    await publishPaperModelFixture(testDb(), followup.id);
    await servePublishedProbe(testDb(), followup.id);
    expect((await loadTeachingBrief(testDb(), NOW)).brief?.prepared_action).toMatchObject({
      probe_question_id: followup.id,
      prompt_md: FOLLOWUP.prompt_md,
    });
    const terminalResponse = await answer(followup.id);
    expect(terminalResponse.status).toBe(200);
    const terminal = ProbeAnswerResponseSchema.parse(await terminalResponse.json());
    expect(terminal.status).toBe('confirmed');
    expect(execute.mock.calls.map(([input]) => input.unit.criterion)).toMatchObject([
      { probe_spec: PRIMARY },
      { probe_spec: FOLLOWUP },
    ]);
    for (const probeId of [initial, followup.id]) {
      const [q] = await testDb().select().from(question).where(eq(question.id, probeId));
      expect(
        await editQuestion(
          testDb(),
          probeId,
          q.version,
          {
            prompt_md: '后续编目修改。',
            reference_md: '后续参考修改。',
            knowledge_ids: [],
            draft_status: 'active',
            kind: 'choice',
            choices_md: ['A', 'B'],
          },
          'self',
        ),
      ).toMatchObject({ status: 'updated' });
    }
    const [terminalRow] = await testDb()
      .select()
      .from(event)
      .where(eq(event.id, terminal.probe_result_event_id));
    const status = async () =>
      (
        await getEffectiveProbeResultStatuses(testDb(), [terminalRow.id], {
          validateDirectChain: true,
        })
      ).get(terminalRow.id);
    expect(await status()).toBe('active');
    expect(await validateAckableOutcome(testDb(), terminalRow, NOW)).not.toHaveProperty('reason');
    const [initialIssuance] = await testDb()
      .select()
      .from(assessment_issuance)
      .where(eq(assessment_issuance.issuance_id, `iss_probe_${initial}`));
    const [initialRevision] = await testDb()
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, initialIssuance.revision_id));
    const originalCriterion = initialRevision.scoring_basis.units[0].criterion;
    for (const patch of [
      { probe_spec: MUTATIONS[3].mutate(PRIMARY) },
      { statement_md: '任意答案都给满分，不再检查内层导数。' },
    ]) {
      await replaceFrozenCriterion(initial, patch);
      expect(await status()).toBe('dependency_inactive');
      expect(await validateAckableOutcome(testDb(), terminalRow, NOW)).toHaveProperty('reason');
      await replaceFrozenCriterion(initial, originalCriterion);
      expect(await status()).toBe('active');
    }
    for (const { mutate } of EXECUTION_MUTATIONS) {
      await replaceFrozenExecution(initial, mutate);
      expect(await status()).toBe('dependency_inactive');
      expect(await validateAckableOutcome(testDb(), terminalRow, NOW)).toHaveProperty('reason');
      await replaceFrozenExecution(initial, (contract) => {
        contract.execution_plan = structuredClone(initialRevision.execution_plan);
        contract.scoring_basis = structuredClone(initialRevision.scoring_basis);
      });
      expect(await status()).toBe('active');
    }
    for (const subjectId of [first.probe_result_event_id, 'original_proposal']) {
      for (const [index, kind] of (['retract', 'restore'] as const).entries()) {
        await writeEvent(testDb(), {
          id: `${subjectId}_${kind}`,
          actor_kind: 'user',
          actor_ref: 'self',
          action: 'correct',
          subject_kind: 'event',
          subject_id: subjectId,
          outcome: 'success',
          caused_by_event_id: subjectId,
          payload: {
            correction_kind: kind,
            reason_md: '核验完成来源的撤回与恢复。',
            affected_refs: [{ kind: 'question', id: initial }],
          },
          created_at: new Date(NOW.getTime() + index + 1),
        });
        expect(await status()).toBe(kind === 'retract' ? 'dependency_inactive' : 'active');
      }
    }
    expect((await loadTeachingBrief(testDb(), NOW)).brief).toMatchObject({
      state: 'outcome_confirmed',
    });
    expect(
      (await loadTeachingBriefReportInput(testDb(), '2026-10-07', '2026-10-07'))
        .skippedCorruptOutcomes,
    ).toBe(0);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each(['schema version', 'unknown field', 'invalid signature'] as const)(
    'rejects malformed frozen native %s before any writes',
    async (kind) => {
      const probeId = await seed(1, PRIMARY);
      const malformed =
        kind === 'schema version'
          ? { ...PRIMARY, schema_version: 1 }
          : kind === 'unknown field'
            ? { ...PRIMARY, new_scoring_rule: 'unparsed rule' }
            : {
                ...PRIMARY,
                target_error_response_signature: {
                  kind: 'rubric',
                  required_features_md: ['错误规则'],
                },
              };
      await replaceFrozenSpec(probeId, malformed);
      await expectRejected(probeId, 'probe_issuance_unprojectable');
    },
  );

  it.each([
    ...CASES.map(({ sequence, name, mutate }) => ({
      sequence,
      name: `spec ${name}`,
      reason: 'probe_spec_mismatch',
      patch: (spec: ConjectureProbeSpecV2T, _criterion: RuleReferenceCriterionT) => ({
        probe_spec: ConjectureProbeSpecV2.parse(mutate(spec)),
      }),
    })),
    ...CRITERION_CASES.map(({ sequence, name, mutate }) => ({
      sequence,
      name: `criterion ${name}`,
      reason: 'probe_criterion_mismatch',
      patch: (_spec: ConjectureProbeSpecV2T, criterion: RuleReferenceCriterionT) => {
        mutate(criterion);
        return criterion;
      },
    })),
  ])(
    'rejects altered completed frozen $name in sequence $sequence across evidence, delivery, ack and report',
    async ({ sequence, patch, reason }) => {
      const original = sequence === 1 ? PRIMARY : FOLLOWUP;
      const probeId = await seed(sequence, original);
      offlineJudge();
      const response = await answer(probeId);
      expect(response.status).toBe(200);
      const result = ProbeAnswerResponseSchema.parse(await response.json());
      const [resultRow] = await testDb()
        .select()
        .from(event)
        .where(eq(event.id, result.probe_result_event_id));
      expect(await validateAckableOutcome(testDb(), resultRow, NOW)).not.toHaveProperty('reason');
      const [issuance] = await testDb()
        .select()
        .from(assessment_issuance)
        .where(eq(assessment_issuance.issuance_id, `iss_probe_${probeId}`));
      const [revision] = await testDb()
        .select()
        .from(question_revision)
        .where(eq(question_revision.revision_id, issuance.revision_id));
      const criterion = revision.scoring_basis.units[0].criterion;
      if (criterion.kind !== 'rule_reference') throw new Error('expected rule reference');
      await replaceFrozenCriterion(probeId, patch(original, criterion));
      const before = await snapshot();
      expect(await validateAckableOutcome(testDb(), resultRow, NOW)).toEqual({
        reason,
      });
      expect(
        (
          await getEffectiveProbeResultStatuses(testDb(), [resultRow.id], {
            validateDirectChain: true,
          })
        ).get(resultRow.id),
      ).toBe('dependency_inactive');
      expect((await loadTeachingBrief(testDb(), NOW)).brief?.current_outcome).not.toMatchObject({
        probe_result_event_id: resultRow.id,
      });
      const report = await loadTeachingBriefReportInput(testDb(), '2026-10-07', '2026-10-07');
      expect(report.probeResults).toEqual([]);
      expect(report.skippedCorruptOutcomes).toBe(1);
      expect(
        (
          await ACK(
            new Request('http://test.invalid/ack', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ probe_result_event_id: resultRow.id }),
            }),
          )
        ).status,
      ).toBe(409);
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([1, 2] as const)(
    'uses the original native response mode when mutable metadata is absent in sequence %s',
    async (sequence) => {
      const probeId = await seed(sequence, sequence === 1 ? PRIMARY : FOLLOWUP);
      const [row] = await testDb().select().from(question).where(eq(question.id, probeId));
      const { probe_spec: _spec, ...metadata } = row.metadata ?? {};
      await testDb().update(question).set({ metadata }).where(eq(question.id, probeId));
      const { execute } = offlineJudge('neither');
      const response = await answer(probeId);
      expect(response.status).toBe(200);
      expect(ProbeAnswerResponseSchema.parse(await response.json())).toMatchObject({
        status: 'inconclusive',
        answer_result: 'incorrect',
        target_error_match: 'not_matched',
      });
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it.each([1, 2] as const)(
    'rejects a missing native frozen spec in sequence %s',
    async (sequence) => {
      await expectRejected(await seed(sequence, null));
    },
  );
  it.each([1, 2] as const)(
    'rejects an unexpected native frozen spec for a no-spec proposal in sequence %s',
    async (sequence) => {
      await expectRejected(await seed(sequence, sequence === 1 ? PRIMARY : FOLLOWUP, false));
    },
  );

  it.each([1, 2] as const)(
    'accepts the exact original native sequence %s and preserves completion after normal edits',
    async (sequence) => {
      const spec = sequence === 1 ? PRIMARY : FOLLOWUP;
      const probeId = await seed(sequence, spec);
      const { execute } = offlineJudge();
      expect((await loadTeachingBrief(testDb(), NOW)).brief).toMatchObject({
        state: 'probe_ready',
        prepared_action: { probe_question_id: probeId, prompt_md: spec.prompt_md },
      });
      expect((await loadActiveProbes(testDb())).probes).toEqual([
        {
          probe_question_id: probeId,
          prompt_md: spec.prompt_md,
          knowledge_id: CHANGE.knowledge_id,
        },
      ]);
      const response = await answer(probeId);
      expect(response.status).toBe(200);
      const result = ProbeAnswerResponseSchema.parse(await response.json());
      expect(result.status).toBe('retired');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][0].unit.criterion).toMatchObject({ probe_spec: spec });
      const [row] = await testDb().select().from(question).where(eq(question.id, probeId));
      expect(
        await editQuestion(
          testDb(),
          probeId,
          row.version,
          {
            knowledge_ids: [],
            draft_status: 'active',
            kind: 'choice',
            choices_md: ['加', '乘'],
            prompt_md: '后续编目题面。',
            reference_md: '后续编目参考。',
          },
          'self',
        ),
      ).toMatchObject({ status: 'updated' });
      const [resultRow] = await testDb()
        .select()
        .from(event)
        .where(eq(event.id, result.probe_result_event_id));
      const before = await snapshot();
      expect(await validateAckableOutcome(testDb(), resultRow, NOW)).not.toHaveProperty('reason');
      expect(
        (
          await getEffectiveProbeResultStatuses(testDb(), [resultRow.id], {
            validateDirectChain: true,
          })
        ).get(resultRow.id),
      ).toBe('active');
      expect((await loadTeachingBrief(testDb(), NOW)).brief).toMatchObject({
        state: 'outcome_retired',
      });
      expect(
        (await loadTeachingBriefReportInput(testDb(), '2026-10-07', '2026-10-07')).probeResults,
      ).toEqual([{ result_event_id: resultRow.id, resolution: 'retired' }]);
      expect(await snapshot()).toEqual(before);
      expect(
        (
          await ACK(
            new Request('http://test.invalid/ack', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ probe_result_event_id: resultRow.id }),
            }),
          )
        ).status,
      ).toBe(201);
    },
  );
});
