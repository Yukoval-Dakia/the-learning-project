import { createId } from '@paralleldrive/cuid2';
import { eq, sql } from 'drizzle-orm';
import { judgeDeliveryInput } from '@/capabilities/practice/public';
import { dispatchNativeAttempt } from '@/capabilities/practice/server/assessment/durable-attempt';
import { issueAssessment } from '@/capabilities/practice/server/assessment/issue';
import type { JudgeRunEnqueueDeps } from '@/capabilities/practice/server/judge-run-dispatch';
import { readJudgeRunPermanent } from '@/capabilities/practice/server/judge-run-observation';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { inspectJudgePendingImport } from '@/server/durable/judge-family';
import {
  contractIntegrityDigest,
  normalizeQuestionRowToContract,
} from '@/server/questions/contract-normalizer';
import { publishQuestionGroup } from '@/server/questions/publisher';
export async function resetJudgeControl(database: Db, phase = 'pg-boss') {
  await database.execute(
    sql`update judge_run_control set phase=${phase},epoch=0,incarnation=gen_random_uuid(),transition_event_id=null,phase_changed_at=clock_timestamp()`,
  );
}
export async function frozenJudge(database: Db, now = new Date()) {
  const id = createId(),
    text = 'v+c=18，v-c=12；两式相加2v=30，故v=15 km/h，水速c=3 km/h。\n';
  await database.insert(question).values({
    id,
    kind: 'derivation',
    prompt_md: '顺流与逆流速度的方程、消元与单位。\n'.repeat(140),
    reference_md: 'v=15 km/h; c=3 km/h',
    judge_kind_override: 'exact',
    knowledge_ids: [],
    difficulty: 3,
    source: 'web_sourced',
    created_at: now,
    updated_at: now,
    version: 0,
  });
  const [row] = await database.select().from(question).where(eq(question.id, id));
  if (!row) throw new Error('Frozen question missing');
  const contract = normalizeQuestionRowToContract(row),
    base = contract.scoring_basis.units[0];
  if (!base) throw new Error('Frozen unit missing');
  contract.scoring_basis.units = ['equations', 'elimination', 'units'].map((name, index) => ({
    ...base,
    scoring_unit_id: `${id}::${name}`,
    points: index + 1,
    criterion: {
      kind: 'rule_reference',
      rule_id: name,
      source: 'official',
      statement_md: `${name}: ${text.repeat(40)} 注意v、c的歧义，说明每步和单位。`,
    },
  }));
  contract.execution_plan.assignments = [
    {
      scoring_unit_ids: contract.scoring_basis.units.map((u) => u.scoring_unit_id),
      executor: {
        kind: 'model_executor',
        task_kind: 'AssessmentRuleJudgeTask',
        admitted_slice_id: 'frozen-speed-slice',
        max_cost_usd_micros: 1000,
      },
    },
  ];
  contract.integrity_digest = contractIntegrityDigest(contract);
  const published = await publishQuestionGroup(database, {
    group_id: id,
    contract,
    expectedCurrentRevision: null,
    expectedAdmissionGeneration: null,
    availability: 'general_pool',
    actorRef: 'test:judge-frozen',
    now,
    admission: {
      state: 'admitted',
      evidence: {
        marking_provenance: 'official',
        verification: { structural_check_passed: true, independent_verification: null },
        model_slice: {
          slice_id: 'frozen-speed-slice',
          holdout_cases: 35,
          severe_errors_observed: 0,
          per_criterion_agreement: 1,
          pipeline_coverage: 1,
        },
      },
    },
  });
  if (published.status !== 'published') throw new Error(published.status);
  const issued = await issueAssessment(database, { group_id: id });
  if (issued.status !== 'issued') throw new Error(issued.status);
  const slot = contract.response_spec.slots[0];
  if (!slot) throw new Error('Frozen response slot missing');
  const request = {
    issuance_id: issued.issuance.issuance_id,
    evaluation_group_id: `group_${id}`,
    idempotency_key: `frozen_${id}`,
    now,
    response_set: {
      entries: [{ slot_id: slot.slot_id, kind: 'text' as const, text_md: text.repeat(80) }],
    },
    group_evidence: [],
  };
  const options = {
    enabled: true,
    capture: {
      response_md: text.repeat(80),
      latency_ms: 1789,
      reasoning_trace: '学生原始推导。'.repeat(30),
    },
  };
  return { id, request, options, contract };
}
export async function dispatchFrozenJudge(
  database: Db,
  deps: JudgeRunEnqueueDeps,
  now = new Date(),
) {
  const fixture = await frozenJudge(database, now);
  const runId = await dispatchNativeAttempt(
    database,
    fixture.id,
    fixture.request,
    fixture.options,
    deps,
  );
  if (!runId) throw new Error('Frozen native intent was not accepted');
  const state = await readJudgeRunPermanent(database, runId);
  if (state.kind !== 'pending' || !state.delivery)
    throw new Error(`Frozen pending state ${state.kind}`);
  const input = judgeDeliveryInput(state.delivery.reservation);
  return { ...fixture, runId, input, delivery: state.delivery };
}
export async function judgeEvidence(database: Db, runId: string) {
  return (await inspectJudgePendingImport(database, runId)).rows;
}
