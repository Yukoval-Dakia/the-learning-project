import { createServer } from 'node:http';
import { agentLoop } from '@earendil-works/pi-agent-core';
import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentRunError } from '@/ai/agent-run-error';
import type { ProviderTransportEvidence, RequestSendState } from '@/ai/task-result';
import { resetTestConfig, setTestConfig } from '@/core/config/store';
import { canonicalHash } from '@/core/migration/canonical';
import { computePaidEffectIdentity } from '@/core/paid-work/protocol/paid-effect-protocol';
import {
  admitPaidEffectIntent,
  cancelPaidEffectUnsentIntent,
  claimPaidEffectSend,
  markPaidEffectUnknown,
  recordPaidEffectApplication,
  recordPaidEffectResult,
  reservePaidEffect,
  voidPaidEffectWithSuccessor,
} from '@/core/paid-work/server/paid-effect-store';
import {
  DUAL_SOLVE_QUESTION_ADMISSION_PAID_UNIT,
  QUESTION_ADMISSION_PAID_UNIT,
} from '@/core/question-admission-policy';
import { taskInputHash } from '@/core/task-input-hash';
import {
  ai_task_runs,
  event,
  knowledge,
  paid_effect,
  paid_effect_authorization,
  question,
  question_group_lifecycle,
  question_revision,
  question_solution_prior,
} from '@/db/schema';
import { readQuestionServing } from '@/kernel/read-models/question-serving';
import * as norm from '@/kernel/records/assessment-normalization';
import { publishQuestionGroup } from '@/kernel/records/assessment-publication';
import { __setPiAdapterForTests } from '@/server/ai/execution-adapter';
import { PiAgentAdapter } from '@/server/ai/pi-agent-adapter';
import { createLoomPiModels } from '@/server/ai/pi-models';
import type { BoundRunTaskTextFn } from '@/server/ai/runner-fn';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { ADJUDICATION_TASK_KIND } from '../server/admission/adjudicate';
import { definitionFromContract } from '../server/admission/definition-from-contract';
import {
  ADMISSION_FAMILY,
  admissionJobId,
  enqueuePublishedQuestionAdmission,
} from '../server/admission/enqueue';
import { FrozenAdmissionInput } from '../server/admission/receipt';
import { solverParts, solverUnits } from '../server/admission/solve';
import { runAdmissionForQuestion as run } from './question_admission_run';

const bossSends: { name: string; data: unknown; opts: Record<string, unknown> }[] = [];
let bossSendError: Error | undefined;
vi.mock('@/server/boss/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/boss/client')>()),
  getStartedBoss: async () => ({
    send: async (name: string, data: unknown, opts: Record<string, unknown>) => {
      if (bossSendError) throw bossSendError;
      bossSends.push({ name, data, opts });
      return 'wake-job-id';
    },
  }),
}));

const RAW =
  '{"id":"q","kind":"choice","prompt_md":"哪项是受控变量？","reference_md":"B","rubric_json":null,"choices_md":["坡度","水量","流速"],"judge_kind_override":null,"structured":null,"source":"web_sourced"}';

const request = (
  send_state: RequestSendState,
  http_status?: number,
): {
  seq: number;
  loop: 'root';
  fetch_invoked_at: string;
  send_state: RequestSendState;
  http_status?: number;
} => ({
  seq: 0,
  loop: 'root',
  fetch_invoked_at: new Date().toISOString(),
  send_state,
  ...(http_status !== undefined ? { http_status } : {}),
});

const transport = (
  send_state: ProviderTransportEvidence['send_state'],
  requests: ReturnType<typeof request>[],
  byState?: Partial<Record<RequestSendState, number>>,
): ProviderTransportEvidence => ({
  v: 1,
  budget: { task_timeout_ms: 60_000 },
  lane: 'undici_agent',
  send_state,
  totals: {
    requests: requests.length,
    dispatches: requests.length,
    by_state: {
      not_sent: 0,
      sent_without_response: 0,
      response_received: 0,
      unknown: 0,
      in_flight: 0,
      ...byState,
    },
  },
  requests,
  requests_seen: requests.length,
  requests_dropped: 0,
  captured_at: new Date().toISOString(),
});

async function insertRun(input: {
  kind?: string;
  payload: unknown;
  outcome: 'failure' | 'success';
  transport?: ProviderTransportEvidence;
  errorMessage?: string;
}): Promise<string> {
  const id = createId();
  await testDb()
    .insert(ai_task_runs)
    .values({
      id,
      task_kind: input.kind ?? 'QuestionAdmissionSolveTask',
      provider: 'custom:opendesign',
      model: 'deepseek-v4.1-flash',
      input_hash: taskInputHash(input.payload),
      status: input.outcome,
      usage_json: {
        inputTokens: 0,
        outputTokens: 0,
        ...(input.transport ? { transport: input.transport } : {}),
      },
      ...(input.outcome === 'failure'
        ? {
            cost_usd: 0,
            cost_basis: 'estimated',
            cost_ref: 'unbilled-provider-rejection:test',
          }
        : { cost_usd: 0.0001, cost_basis: 'reported', cost_ref: 'pricebook:test' }),
      ...(input.errorMessage ? { error_message: input.errorMessage } : {}),
      started_at: new Date(),
      finished_at: new Date(),
    });
  return id;
}

interface Seeded {
  groupId: string;
  revisionId: string;
  digest: string;
  publishEventId: string;
  unitId: string;
  correctItemId: string;
  wrongItemId: string;
}

/** One publication's full provenance chain: question+revision+lifecycle plus
 * the publish event the purpose binding anchors to. */
async function seedAdmission(
  opts: { compositeUnit?: boolean; row?: Partial<norm.NormalizableQuestionRow> } = {},
): Promise<Seeded> {
  const db = testDb();
  const contract = norm.normalizeQuestionRowToContract({
    ...(JSON.parse(RAW) as norm.NormalizableQuestionRow),
    ...opts.row,
  });
  contract.response_spec.slots[0].placement = { row: 0, col: 0, label: '1' };
  // A scored unit spanning more than one slot has no deterministic upgrade lane.
  if (opts.compositeUnit) {
    const refs = contract.scoring_basis.units[0].slot_refs;
    contract.scoring_basis.units[0].slot_refs = [...refs, ...refs];
  }
  const digest = norm.publishedContractSeal({
    structure: contract.structure,
    response_spec: contract.response_spec,
    scoring_basis: contract.scoring_basis,
    execution_plan: contract.execution_plan,
  }).canonical;
  const unit = contract.scoring_basis.units[0];
  const slot = contract.response_spec.slots[0];
  const options = slot.kind === 'single_choice' ? slot.options : [];
  const q = (layer: object) => JSON.stringify(layer).replaceAll("'", "''");
  await db.$client.unsafe(
    `insert into question (id,kind,prompt_md,source,created_at,updated_at) values ('q','choice','x','web_sourced',now(),now());
     insert into question_revision (revision_id,group_id,revision_ordinal,integrity_digest,structure,response_spec,scoring_basis,execution_plan,availability,published_at) values ('r','q',1,'${digest}','${q(contract.structure)}'::jsonb,'${q(contract.response_spec)}'::jsonb,'${q(contract.scoring_basis)}'::jsonb,'${q(contract.execution_plan)}'::jsonb,'general_pool',now());
     insert into question_group_lifecycle (group_id,current_revision_id,availability,scoring_admission_state,scoring_admission_withheld_reason,claim_policy,created_at,updated_at) values ('q','r','general_pool','withheld','unverified_rules','unbounded',now(),now());`,
  );
  const publishEventId = `pub-${createId()}`;
  await db.$client.unsafe(
    `insert into event (id,session_id,actor_kind,actor_ref,action,subject_kind,subject_id,outcome,payload,caused_by_event_id,task_run_id,cost_micro_usd,created_at,ingest_at)
     values ('${publishEventId}',null,'system','quiz_gen:persist','experimental:assessment_publish','question','q','success','{"group_id":"q","revision_id":"r","integrity_digest":"${digest}","admission":"withheld"}'::jsonb,null,null,null,now(),now())`,
  );
  return {
    groupId: 'q',
    revisionId: 'r',
    digest,
    publishEventId,
    unitId: unit.scoring_unit_id,
    // reference 'B' is the second option.
    correctItemId: options[1]?.option_id ?? '',
    wrongItemId: options[0]?.option_id ?? '',
  };
}

let fixtureBoss: PgBoss | undefined;
const ownedJobs: Array<{ name: string; id: string }> = [];

async function ensureBoss(): Promise<PgBoss> {
  if (!fixtureBoss) {
    const url = new URL(z.url().parse(process.env.TEST_DATABASE_URL));
    if (
      !/^\/test_fork_\d+$/.test(url.pathname) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
      throw new Error('Disposable fork DB required');
    fixtureBoss = new PgBoss({
      connectionString: url.toString(),
      max: 2,
      supervise: false,
      schedule: false,
    });
    fixtureBoss.on('error', () => {});
    await fixtureBoss.start();
  }
  return fixtureBoss;
}

/** The live pgboss.job row the delivery fence locks; a purpose binding only
 * exists for a delivery that could have initiated spend — recovery wakes own
 * none. Rows land through a real fixture install: hand-built pgboss objects
 * abort pg-boss's own install script and poison the fork for other files. */
async function insertDelivery(
  seed: Seeded,
  deliveryId: string,
  jobData: object,
  options: { binding?: boolean } = {},
) {
  const boss = await ensureBoss();
  await boss.createQueue(ADMISSION_FAMILY);
  const jobId = await boss.send(ADMISSION_FAMILY, jobData, { id: deliveryId, retryLimit: 0 });
  if (jobId !== deliveryId) throw new Error('Fixture job was not enqueued');
  ownedJobs.push({ name: ADMISSION_FAMILY, id: jobId });
  const [job] = await boss.fetch(ADMISSION_FAMILY, { includeMetadata: true });
  if (job?.id !== deliveryId || job.state !== 'active')
    throw new Error('Fixture must fetch the exact job into active state');
  if (options.binding === false) return;
  await testDb().$client.unsafe(
    `insert into event (id,session_id,actor_kind,actor_ref,action,subject_kind,subject_id,outcome,payload,caused_by_event_id,task_run_id,cost_micro_usd,created_at,ingest_at)
     values ('question-admission-purpose:${deliveryId}',null,'system','practice:question_admission','experimental:question_admission_purpose','question','${seed.groupId}','success','${JSON.stringify(
       {
         version: 1,
         job_id: deliveryId,
         source_event_id: seed.publishEventId,
         usage_source_event_id: null,
         question_id: seed.groupId,
         revision_id: seed.revisionId,
         revision_digest: seed.digest,
         derivation_policy: 'answer_only',
       },
     )}'::jsonb,null,null,null,now(),now())`,
  );
}

function jobData(seed: Seeded, extra: object = {}) {
  return {
    admission_version: 5 as const,
    question_id: seed.groupId,
    revision_id: seed.revisionId,
    expected_revision_digest: seed.digest,
    expected_admission_generation: 0,
    dispatch_generation: 0,
    source_event_id: seed.publishEventId,
    ...extra,
  };
}

const PRIOR = {
  methods: [
    {
      core_idea_md: '只改变一个条件，其余保持不变',
      key_step_md: '找出实验中唯一被改变的量',
      steps: [{ step_md: '列出每组实验改变的量', prerequisite_idx: 0 }],
    },
  ],
  prerequisites: [{ name_md: '控制变量法' }],
  difficulty: { b_logit: -0.5, sd_logit: 0.8, basis_md: '一步判断' },
};

function solveOutput(unitId: string, itemId: string) {
  return {
    units: [
      {
        scoring_unit_id: unitId,
        status: 'solved',
        answer: { kind: 'select', item_ids: [itemId] },
        prior: PRIOR,
      },
    ],
  };
}

function freeSolveOutput(unitId: string) {
  return {
    units: [
      {
        scoring_unit_id: unitId,
        status: 'solved',
        answer: { kind: 'free', rubric_md: '说明坡度改变时其余条件保持不变。' },
        prior: PRIOR,
      },
    ],
  };
}

function passVerdict(seed: Seeded, free: boolean, wrongKey = false) {
  return {
    scoring_unit_id: seed.unitId,
    verdict: 'pass',
    reason_md: 'fixture adjudication',
    evidence_errors: [],
    ...(free
      ? {
          decided_key: { kind: 'free', rubric_md: '指出坡度改变、其余条件不变。' },
          ai_grading_sufficient: true,
        }
      : {
          decided_key: {
            kind: 'select',
            item_ids: [wrongKey ? seed.wrongItemId : seed.correctItemId],
          },
        }),
  };
}

function repairVerdict(unitId: string) {
  return {
    scoring_unit_id: unitId,
    verdict: 'return_for_repair',
    reason_md: 'fixture adjudication',
    evidence_errors: [],
    repair: {
      repair_target: 'reference_answer',
      broken_part: 'reference',
      defect: 'ambiguity',
      fix_hint_md: 'fixture',
    },
  };
}

type Failure =
  | { readonly kind: 'bound'; readonly status: number }
  | {
      readonly kind: 'transport';
      readonly state: 'not_sent' | 'unknown' | 'sent_without_response';
      readonly subtype?: string;
    }
  | { readonly kind: 'validation' };

interface FakeTask {
  task: BoundRunTaskTextFn;
  calls: { kind: string; payload: unknown }[];
}

function fakeTaskFactory(
  seed: Seeded,
  overrides: {
    failures?: Map<number, Failure>;
    successAnswers?: Map<number, string>;
    free?: boolean;
    adjudication?: 'repair' | 'pass' | 'fail';
    adjudicationWrongKey?: boolean;
  } = {},
): FakeTask {
  const failures = overrides.failures ?? new Map();
  const successAnswers = overrides.successAnswers ?? new Map();
  const calls: { kind: string; payload: unknown }[] = [];
  const task: BoundRunTaskTextFn = async (kind, payload, ctx) => {
    const index = calls.filter((call) => call.kind === kind).length;
    calls.push({ kind, payload });
    const runId = `probe-${calls.length}`;
    await ctx?.beforeProviderQuery?.({
      taskRunId: runId,
      provider: 'custom:opendesign',
      model: 'deepseek-v4.1-flash',
    });
    const failure =
      kind === ADJUDICATION_TASK_KIND
        ? overrides.adjudication === 'fail'
          ? ({ kind: 'validation' } as const)
          : undefined
        : failures.get(index);
    if (failure) {
      if (failure.kind === 'bound') {
        const taskRunId = await insertRun({
          kind,
          payload,
          outcome: 'failure',
          transport: transport('response_received', [request('response_received', failure.status)]),
        });
        throw new AgentRunError({
          kind,
          taskRunId,
          subtype: 'api_error_result',
          apiErrorStatus: failure.status,
          errors: [`provider ${failure.status}`],
        });
      }
      if (failure.kind === 'transport') {
        const taskRunId = await insertRun({
          kind,
          payload,
          outcome: 'failure',
          transport: transport(failure.state, [request(failure.state)]),
        });
        throw new AgentRunError({
          kind,
          taskRunId,
          subtype: (failure.subtype ?? 'error_during_execution') as
            | 'error_during_execution'
            | 'budget_timeout',
          errors: ['connection dropped'],
        });
      }
      const taskRunId = await insertRun({ kind, payload, outcome: 'failure' });
      throw new AgentRunError({
        kind,
        taskRunId,
        subtype: 'error_max_structured_output_retries',
        errors: ['could not produce output'],
      });
    }
    const taskRunId = await insertRun({ kind, payload, outcome: 'success' });
    const answer = successAnswers.get(index) ?? seed.correctItemId;
    const output =
      kind === ADJUDICATION_TASK_KIND
        ? {
            per_unit: [
              overrides.adjudication === 'pass'
                ? passVerdict(seed, overrides.free === true, overrides.adjudicationWrongKey)
                : repairVerdict(seed.unitId),
            ],
          }
        : overrides.free
          ? freeSolveOutput(seed.unitId)
          : solveOutput(seed.unitId, answer);
    return {
      text: JSON.stringify(output),
      structured_output: output,
      task_run_id: taskRunId,
      cost_usd: 0.0001,
    };
  };
  return { task, calls };
}

async function stageRows() {
  return testDb()
    .select({
      unit: paid_effect.unit,
      state: paid_effect.state,
      input: paid_effect.input_json,
      input_digest: paid_effect.input_digest,
      result: paid_effect.result_json,
    })
    .from(paid_effect)
    .where(eq(paid_effect.family, 'question_admission_stage'));
}

/**
 * Rewrite a waiting @5 batch into the exact shape the dual-solve code left behind: the
 * @4 unit and policy with its frozen solver2 field, and stage rows without policy_id.
 */
async function downgradeToDualSolveWait(state: 'waiting' | 'unknown', stageUnknown = false) {
  const db = testDb();
  const rows = (await db.$client.unsafe(
    `select family, entity_id, entity_revision, unit, input_digest, input_json from paid_effect`,
  )) as {
    family: string;
    entity_id: string;
    entity_revision: string;
    unit: string;
    input_digest: string;
    input_json: Record<string, unknown>;
  }[];
  for (const row of rows) {
    const batch = row.family === ADMISSION_FAMILY;
    const { policy_id: _policy, ...stageInput } = row.input_json;
    const input = batch
      ? { ...row.input_json, policy_id: 'question_admission@4', solver2: null }
      : stageInput;
    const unit = batch ? 'admission@4' : row.unit;
    const identity = computePaidEffectIdentity({
      family: row.family,
      entityId: row.entity_id,
      entityRevision: row.entity_revision,
      unit,
      input,
    });
    await db.$client.unsafe(
      `update paid_effect set unit = $1, input_json = $2::jsonb, input_digest = $3
        where family = $4 and entity_id = $5 and entity_revision = $6 and unit = $7 and input_digest = $8`,
      [
        unit,
        JSON.stringify(input),
        identity.inputDigest,
        row.family,
        row.entity_id,
        row.entity_revision,
        row.unit,
        row.input_digest,
      ],
    );
  }
  if (state === 'unknown')
    await db.$client.unsafe(
      `update paid_effect set state = 'unknown', result_json = null, result_recorded_at = null,
         unresolved_reason = 'fixture' where family = '${ADMISSION_FAMILY}'`,
    );
  if (stageUnknown)
    await db.$client.unsafe(
      `update paid_effect set state = 'unknown', result_json = null, result_recorded_at = null,
         applied_at = null, application_json = null, unresolved_reason = 'fixture'
        where family = 'question_admission_stage' and result_json->>'kind' = 'waiting'`,
    );
}

interface FrozenPaidEffect {
  family: string;
  entity_id: string;
  entity_revision: string;
  unit: string;
  input_json: Record<string, unknown>;
  input_digest: string;
}

async function frozenV4Rows() {
  const rows = (await testDb().$client.unsafe(
    `select family, entity_id, entity_revision, unit, input_json, input_digest from paid_effect
     where unit = 'admission@4'
        or (family = 'question_admission_stage' and input_json->>'call_index' = '2')
     order by family, unit, input_digest`,
  )) as FrozenPaidEffect[];
  return rows.map((row) => ({
    ...row,
    identity: computePaidEffectIdentity({
      family: row.family,
      entityId: row.entity_id,
      entityRevision: row.entity_revision,
      unit: row.unit,
      input: row.input_json,
    }).inputDigest,
  }));
}

async function seedCancelledLegacyAuthorization(seed: Seeded, successorDeliveryId: string) {
  const db = testDb();
  await insertDelivery(seed, successorDeliveryId, {
    ...jobData(seed),
    admission_version: 4 as const,
  });
  const unknownDeliveryId = admissionJobId(
    seed.groupId,
    seed.revisionId,
    `${seed.digest}:legacy-unknown`,
    0,
  );
  await insertDelivery(seed, unknownDeliveryId, {
    ...jobData(seed),
    admission_version: 4 as const,
  });
  const sourceId = admissionJobId(seed.groupId, seed.revisionId, `${seed.digest}:legacy-auth`, 0);
  const sourceData = jobData(seed);
  await insertDelivery(seed, sourceId, sourceData);
  const { task } = fakeTaskFactory(seed, {
    failures: new Map([
      [0, { kind: 'bound', status: 500 }],
      [1, { kind: 'bound', status: 500 }],
    ]),
  });
  const sourceRun = await run(
    db,
    sourceData,
    { id: sourceId, jobData: sourceData },
    { runTask: task },
  );
  expect(sourceRun.status).toBe('waiting');

  const [currentRow] = await db
    .select()
    .from(paid_effect)
    .where(
      and(
        eq(paid_effect.family, ADMISSION_FAMILY),
        eq(paid_effect.entity_id, seed.groupId),
        eq(paid_effect.entity_revision, seed.digest),
        eq(paid_effect.unit, QUESTION_ADMISSION_PAID_UNIT),
      ),
    )
    .limit(1);
  if (!currentRow) throw new Error('current @5 input row missing');
  await db.delete(paid_effect).where(eq(paid_effect.entity_id, seed.groupId));

  const currentInput = FrozenAdmissionInput.parse(currentRow.input_json);
  const legacyInput = FrozenAdmissionInput.parse({
    ...currentInput,
    policy_id: 'question_admission@4',
    solver2: null,
  });
  const voidInput = FrozenAdmissionInput.parse({
    ...legacyInput,
    admission_generation: legacyInput.admission_generation + 1,
  });
  const voidIdentity = computePaidEffectIdentity({
    family: ADMISSION_FAMILY,
    entityId: seed.groupId,
    entityRevision: seed.digest,
    unit: DUAL_SOLVE_QUESTION_ADMISSION_PAID_UNIT,
    input: voidInput,
  });
  const cancelledInput = FrozenAdmissionInput.parse({
    ...legacyInput,
    admission_generation: legacyInput.admission_generation + 2,
  });
  const cancelledIdentity = computePaidEffectIdentity({
    family: ADMISSION_FAMILY,
    entityId: seed.groupId,
    entityRevision: seed.digest,
    unit: DUAL_SOLVE_QUESTION_ADMISSION_PAID_UNIT,
    input: cancelledInput,
  });
  const now = new Date();
  await db.transaction(async (tx) => {
    const admitted = await admitPaidEffectIntent(tx, {
      family: ADMISSION_FAMILY,
      entityId: seed.groupId,
      entityRevision: seed.digest,
      unit: DUAL_SOLVE_QUESTION_ADMISSION_PAID_UNIT,
      input: cancelledInput,
    });
    if (admitted.kind !== 'admitted')
      throw new Error('separate cancelled legacy intent was not new');
    await cancelPaidEffectUnsentIntent(tx, cancelledIdentity, {
      expectedFence: 0,
      cancellation: {
        requestId: 'legacy-sealed-cancel',
        reason: 'sealed legacy history',
        operator: 'fixture',
        basis: 'legacy policy compatibility fixture',
      },
    });
  });
  await db.insert(paid_effect).values({
    family: ADMISSION_FAMILY,
    entity_id: seed.groupId,
    entity_revision: seed.digest,
    unit: DUAL_SOLVE_QUESTION_ADMISSION_PAID_UNIT,
    input_digest: voidIdentity.inputDigest,
    input_json: voidInput,
    state: 'unknown',
    fence: 1,
    delivery_id: unknownDeliveryId,
    delivery_backend: 'pg-boss',
    unresolved_reason: 'legacy unknown',
    created_at: now,
    updated_at: now,
  });
  await db.transaction(async (tx) => {
    await voidPaidEffectWithSuccessor(tx, voidIdentity, {
      expectedFence: 1,
      authorization: {
        authorizationId: 'legacy-auth',
        reason: 'legacy policy successor',
        operator: 'fixture',
        basis: 'legacy policy compatibility fixture',
        successorInput: {
          family: ADMISSION_FAMILY,
          entityId: seed.groupId,
          entityRevision: seed.digest,
          unit: DUAL_SOLVE_QUESTION_ADMISSION_PAID_UNIT,
          input: legacyInput,
        },
        successorDelivery: { backend: 'pg-boss', deliveryId: successorDeliveryId },
      },
    });
  });
}

/** Reserve the exact @4 adjudication fence the superseded plan would have frozen. */
async function reserveLegacyPlaceholderAdjudication(seed: Seeded) {
  const contract = norm.normalizeQuestionRowToContract({
    ...(JSON.parse(RAW) as norm.NormalizableQuestionRow),
    reference_md: null,
    judge_kind_override: 'exact',
  });
  const currentDefinition = definitionFromContract(contract);
  const historicalDefinition = {
    ...currentDefinition,
    units: currentDefinition.units.map((unit) => ({
      ...unit,
      printed_rule_md: unit.rule_statement_md,
    })),
  };
  const parts = await solverParts(testDb(), historicalDefinition);
  const units = solverUnits(historicalDefinition, { exposePrinted: true });
  if (!('printed_rule_md' in units[0])) throw new Error('historical placeholder was not printed');
  const payload = {
    parts,
    units,
    figure_state: 'none_referenced' as const,
    markings: [],
    solves: [
      solveOutput(seed.unitId, seed.correctItemId),
      solveOutput(seed.unitId, seed.wrongItemId),
    ],
    author_evidence: currentDefinition.original_units,
    source_answers: currentDefinition.source_answers,
  };
  const input = {
    kind: ADJUDICATION_TASK_KIND,
    call_index: 2,
    attempt: 0,
    payload_digest: canonicalHash(payload),
    payload,
    configuration: {
      task: {
        provider: 'custom:opendesign',
        model: 'deepseek-v4.1-flash',
        override_global_pin: true,
      },
      override: null,
    },
    recovery_confirmation: null,
  };
  const identity = computePaidEffectIdentity({
    family: 'question_admission_stage',
    entityId: seed.groupId,
    entityRevision: seed.digest,
    unit: 'call:2:attempt:0',
    input,
  });
  const reservation = await reservePaidEffect(
    testDb(),
    {
      family: 'question_admission_stage',
      entityId: seed.groupId,
      entityRevision: seed.digest,
      unit: 'call:2:attempt:0',
      input,
    },
    {
      backend: 'pg-boss',
      deliveryId: 'legacy-v4-adjudication',
      generation: 0,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    },
  );
  if (reservation.kind !== 'winner') throw new Error('historical adjudication reservation lost');
  await testDb().transaction(async (tx) => {
    await recordPaidEffectResult(
      tx,
      identity,
      'legacy-v4-adjudication',
      {
        kind: 'waiting',
        recovery: {
          reason: 'provider',
          retry_at: '2020-01-01T00:00:00.000Z',
          evidence_ref: 'legacy-adjudication',
        },
      },
      { fence: reservation.fence },
    );
    await recordPaidEffectApplication(tx, identity, { kind: 'recorded' });
  });
  return { inputDigest: identity.inputDigest, payloadDigest: input.payload_digest };
}

async function deniedEvents(groupId: string) {
  return (await testDb().$client.unsafe(
    `select id from event where action = 'experimental:question_admission_purpose_denied' and subject_id = '${groupId}'`,
  )) as unknown[];
}

async function servingAdmission(groupId: string) {
  const serving = await readQuestionServing(testDb(), [groupId]);
  return serving.byId.get(groupId)?.admission;
}

/** Deliver the deterministic wake the coordinator scheduled: the same frozen
 * jobData, a fresh job id, and no purpose binding — exactly what the real
 * recovery delivery looks like to the purpose gate. */
async function deliverWake(
  seed: Seeded,
  data: ReturnType<typeof jobData>,
  task: BoundRunTaskTextFn,
) {
  const wakeId = admissionJobId(seed.groupId, seed.revisionId, `${seed.digest}:wake`, 0);
  const wakeData = { ...data, recovery_confirmed: false };
  await insertDelivery(seed, wakeId, wakeData, { binding: false });
  await testDb().$client.unsafe(
    `update paid_effect set result_json = jsonb_set(result_json, '{recovery,retry_at}', '"2020-01-01T00:00:00.000Z"')
     where family = 'question_admission_stage' and result_json->>'kind' = 'waiting'`,
  );
  return run(testDb(), wakeData, { id: wakeId, jobData: wakeData }, { runTask: task });
}

afterAll(async () => {
  await fixtureBoss?.stop();
});

describe('question admission provider recovery', () => {
  beforeEach(async () => {
    process.env.ADMISSION_PROVIDER_RETRY_MAX_RETRIES = '1';
    process.env.ADMISSION_PROVIDER_RETRY_BASE_DELAY_MS = '0';
    await resetDb();
    bossSends.length = 0;
    bossSendError = undefined;
    return () => {
      delete process.env.ADMISSION_PROVIDER_RETRY_MAX_RETRIES;
      delete process.env.ADMISSION_PROVIDER_RETRY_BASE_DELAY_MS;
    };
  });
  afterEach(async () => {
    for (const job of ownedJobs.splice(0)) await fixtureBoss?.deleteJob(job.name, job.id);
  });

  // @invariant concurrency: a provably unbilled provider rejection waits on a
  // durable receipt and replays under the same paid identity — the wake is
  // scheduled through pg-boss, writes no purpose denial, and completes the
  // admission without a second paid send for the same content
  // @fails-if a bound 5xx lands a terminal receipt, the recovered run
  // double-pays, a recovery delivery writes a purpose_denied event, or the
  // serving read stops saying pending while the wake is still armed
  it('a bound provider 500 waits and the scheduled wake completes the same paid effect', async () => {
    const db = testDb();
    const seed = await seedAdmission();
    const d1 = admissionJobId(seed.groupId, seed.revisionId, seed.digest, 0);
    const data = jobData(seed);
    await insertDelivery(seed, d1, data);
    const { task } = fakeTaskFactory(seed, {
      failures: new Map([
        [0, { kind: 'bound', status: 500 }],
        [1, { kind: 'bound', status: 500 }],
      ]),
    });

    const first = await run(db, data, { id: d1, jobData: data }, { runTask: task });
    expect(first.status).toBe('waiting');
    const stages = await stageRows();
    const waiting = stages.find(
      (row) => (row.result as { kind?: string } | null)?.kind === 'waiting',
    );
    const waitingRecovery = (waiting?.result as { recovery?: { reason: string } } | undefined)
      ?.recovery;
    expect(waitingRecovery?.reason).toBe('provider');
    const wake = bossSends.find((send) => send.name === 'question_admission_run');
    expect(wake).toBeDefined();
    const wakeData = wake?.data as { recovery_confirmed?: boolean } | undefined;
    expect(wakeData?.recovery_confirmed).toBe(false);
    expect((await servingAdmission(seed.groupId))?.status).toBe('pending');
    expect((await servingAdmission(seed.groupId))?.wait?.reason).toBe('provider');

    const second = await deliverWake(seed, data, task);
    expect(second.status).toBe('admitted');
    expect(await deniedEvents(seed.groupId)).toHaveLength(0);
    expect((await servingAdmission(seed.groupId))?.status).toBe('admitted');
    // The recovered send replayed call 0's chain as its next attempt; no
    // fresh paid call index was minted for the same lane.
    const units = (await stageRows()).map((row) => row.unit);
    expect(units).toContain('call:0:attempt:2');
    expect(new Set(units).size).toBe(units.length);
  });

  // @invariant concurrency: transport-proven not_sent waits on the same durable
  // fence — the burst ladder owns the wake cadence and the due resend replays
  // the paid chain instead of buying a new effect
  // @fails-if a not_sent verdict lands terminal, or the resend creates a new
  // paid effect instead of replaying the chain
  it('a transport-proven not_sent failure waits and the due wake resends', async () => {
    const db = testDb();
    const seed = await seedAdmission();
    const d1 = admissionJobId(seed.groupId, seed.revisionId, seed.digest, 0);
    const data = jobData(seed);
    await insertDelivery(seed, d1, data);
    const { task } = fakeTaskFactory(seed, {
      failures: new Map([
        [0, { kind: 'transport', state: 'not_sent' }],
        // A budget-timeout rejection carries the same provably-unsent evidence.
        [1, { kind: 'transport', state: 'not_sent', subtype: 'budget_timeout' }],
      ]),
    });

    const first = await run(db, data, { id: d1, jobData: data }, { runTask: task });
    expect(first.status).toBe('waiting');
    const waiting = (await stageRows()).find(
      (row) => (row.result as { kind?: string } | null)?.kind === 'waiting',
    );
    const waitingRecovery = (waiting?.result as { recovery?: { reason: string } } | undefined)
      ?.recovery;
    expect(waitingRecovery?.reason).toBe('not_sent');

    const second = await deliverWake(seed, data, task);
    expect(second.status).toBe('admitted');
    expect(await deniedEvents(seed.groupId)).toHaveLength(0);
  });

  // @invariant concurrency: a bound 429 parks on the quota wait — the durable
  // receipt carries the quota reason to the read model and the due wake
  // replays the paid chain after the congestion clears
  // @fails-if a bound 429 lands terminal, or the wake re-mints a paid call
  it('a bound provider 429 waits on the quota lane and the due wake resends', async () => {
    const db = testDb();
    const seed = await seedAdmission();
    const d1 = admissionJobId(seed.groupId, seed.revisionId, seed.digest, 0);
    const data = jobData(seed);
    await insertDelivery(seed, d1, data);
    const { task } = fakeTaskFactory(seed, {
      failures: new Map([
        [0, { kind: 'bound', status: 429 }],
        [1, { kind: 'bound', status: 429 }],
      ]),
    });

    const first = await run(db, data, { id: d1, jobData: data }, { runTask: task });
    expect(first.status).toBe('waiting');
    const waiting = (await stageRows()).find(
      (row) => (row.result as { kind?: string } | null)?.kind === 'waiting',
    );
    const waitingRecovery = (waiting?.result as { recovery?: { reason: string } } | undefined)
      ?.recovery;
    expect(waitingRecovery?.reason).toBe('quota');
    expect((await servingAdmission(seed.groupId))?.wait?.reason).toBe('quota');

    const second = await deliverWake(seed, data, task);
    expect(second.status).toBe('admitted');
    expect(await deniedEvents(seed.groupId)).toHaveLength(0);
  });

  // @invariant concurrency: a bound 401 is a complete pre-billing refusal on
  // the paid lane — it parks on the provider wait clock until the credential
  // is renewed instead of landing terminal, and the due wake resends under
  // the same paid identity
  // @fails-if a bound 401 lands a terminal receipt, or the resend mints a new
  // paid call
  it('a bound provider 401 waits on the provider lane and the due wake resends', async () => {
    const db = testDb();
    const seed = await seedAdmission();
    const d1 = admissionJobId(seed.groupId, seed.revisionId, seed.digest, 0);
    const data = jobData(seed);
    await insertDelivery(seed, d1, data);
    const { task } = fakeTaskFactory(seed, {
      failures: new Map([[0, { kind: 'bound', status: 401 }]]),
    });

    const first = await run(db, data, { id: d1, jobData: data }, { runTask: task });
    expect(first.status).toBe('waiting');
    const waiting = (await stageRows()).find(
      (row) => (row.result as { kind?: string } | null)?.kind === 'waiting',
    );
    const waitingRecovery = (waiting?.result as { recovery?: { reason: string } } | undefined)
      ?.recovery;
    expect(waitingRecovery?.reason).toBe('provider');
    expect((await servingAdmission(seed.groupId))?.wait?.reason).toBe('provider');
    expect((await servingAdmission(seed.groupId))?.wait?.recovery_action).toBe('wait_for_retry');

    const second = await deliverWake(seed, data, task);
    expect(second.status).toBe('admitted');
    expect(await deniedEvents(seed.groupId)).toHaveLength(0);
  });

  // @invariant data: a scored unit the converter cannot upgrade (a composite
  // cross-slot unit) is a terminal content failure — the admission resolves
  // before any provider call, so no wait receipt is written, no wake is
  // armed, and no paid call is made
  // @fails-if a content-terminal question arms a wait or spends a provider call
  it('a content validation failure lands terminal failed with no wait armed', async () => {
    const db = testDb();
    const seed = await seedAdmission({ compositeUnit: true });
    const d1 = admissionJobId(seed.groupId, seed.revisionId, seed.digest, 0);
    const data = jobData(seed);
    await insertDelivery(seed, d1, data);
    const { task, calls } = fakeTaskFactory(seed);

    const first = await run(db, data, { id: d1, jobData: data }, { runTask: task });
    expect(first.status).toBe('withheld');
    expect(calls).toHaveLength(0);
    expect(
      (await stageRows()).some(
        (row) => (row.result as { kind?: string } | null)?.kind === 'waiting',
      ),
    ).toBe(false);
    expect(bossSends.some((send) => send.name === 'question_admission_run')).toBe(false);
    expect((await servingAdmission(seed.groupId))?.status).toBe('failed');
    expect((await servingAdmission(seed.groupId))?.wait ?? null).toBeNull();
  });

  // @invariant data: an outcome the transport cannot prove never resends — a
  // resent uncertain call can double-bill, so the paid effect stays unknown,
  // a redelivery holds, and the read model reports outcome_unconfirmed
  // @fails-if an unknown attempt is resent, or the learner-facing read claims
  // the admission is still checking
  it('an unprovable send outcome marks unknown and never resends', async () => {
    const db = testDb();
    const seed = await seedAdmission();
    const d1 = admissionJobId(seed.groupId, seed.revisionId, seed.digest, 0);
    const data = jobData(seed);
    await insertDelivery(seed, d1, data);
    const { task, calls } = fakeTaskFactory(seed, {
      failures: new Map([[0, { kind: 'transport', state: 'unknown' }]]),
    });

    // The uncertain outcome is fenced before any resend: the stage marks its
    // paid effect unknown and the original error escapes the delivery.
    await expect(run(db, data, { id: d1, jobData: data }, { runTask: task })).rejects.toThrow();
    const sends = calls.length;
    expect((await stageRows()).some((row) => row.state === 'unknown')).toBe(true);
    expect((await servingAdmission(seed.groupId))?.status).toBe('undecided');
    expect((await servingAdmission(seed.groupId))?.cause).toBe('outcome_unconfirmed');

    const retryId = admissionJobId(seed.groupId, seed.revisionId, `${seed.digest}:retry`, 0);
    await insertDelivery(seed, retryId, data, { binding: false });
    const second = await run(db, data, { id: retryId, jobData: data }, { runTask: task });
    expect(second.status).toBe('pending');
    expect(calls.length).toBe(sends);
  });

  // @invariant concurrency: a spent bounded wait drops to the outage tail —
  // the durable receipt still arms a wake on the slow cadence and every resend
  // re-passes the unbilled gate, so a long outage costs no terminal state and
  // no unbounded spend
  // @fails-if the spent ladder writes a terminal exhausted receipt, or the
  // tail wait stops arming a wake
  it('a spent provider wait ladder drops to the outage tail instead of a terminal receipt', async () => {
    const db = testDb();
    const seed = await seedAdmission();
    const d1 = admissionJobId(seed.groupId, seed.revisionId, seed.digest, 0);
    const data = jobData(seed);
    await insertDelivery(seed, d1, data);
    const { task } = fakeTaskFactory(seed, {
      failures: new Map([
        [0, { kind: 'bound', status: 500 }],
        [1, { kind: 'bound', status: 500 }],
        [2, { kind: 'bound', status: 500 }],
      ]),
    });
    await run(db, data, { id: d1, jobData: data }, { runTask: task });

    // The ladder is spent: the latest wait already holds provider_waits 8.
    await testDb().$client.unsafe(
      `update paid_effect set result_json = jsonb_set(result_json, '{provider_waits}', '8')
       where family = 'question_admission_stage' and result_json->>'kind' = 'waiting'`,
    );
    const tail = await deliverWake(seed, data, task);
    expect(tail.status).toBe('waiting');
    const tailReceipt = (await stageRows())
      .map(
        (row) =>
          row.result as {
            kind?: string;
            recovery?: { reason: string; retry_at: string };
            provider_waits?: number;
            outage_waits?: number;
          } | null,
      )
      .find((row) => row?.kind === 'waiting' && (row.outage_waits ?? 0) > 0);
    expect(tailReceipt).toBeDefined();
    expect(tailReceipt?.provider_waits).toBe(9);
    expect(tailReceipt?.outage_waits).toBe(1);
    const retryAtMs = Date.parse(tailReceipt?.recovery?.retry_at ?? '');
    expect(retryAtMs - Date.now()).toBeGreaterThan(3 * 60 * 60_000);
    expect((await servingAdmission(seed.groupId))?.status).toBe('pending');
  });

  // @invariant grading: one blind solve, then the frozen gate decides — only an author key
  // that accepts the blind answer settles a unit without the adjudicator; no author key, a
  // disagreeing author key, free units, a cited missing figure, a printed rubric and a
  // printed answer that did not parse all adjudicate, a failed or repairing adjudication
  // never admits, the evidence names who adjudicated, and only a blind key that is the
  // published key may seed a difficulty anchor
  // @fails-if a question costs more than one blind solve, a key-less unit admits without
  // adjudication, a placeholder reaches the adjudicator as a printed rule, an adjudicator
  // error admits, or an overridden blind solve writes a difficulty anchor
  it.each([
    {
      name: 'author key accepts the blind answer',
      row: {},
      adjudications: 0,
      status: 'admitted',
      keyStatus: 'matched',
    },
    {
      name: 'author accepts the blind answer, then adjudication replaces the key',
      row: { prompt_md: '如图，哪项是受控变量？' },
      adjudication: 'pass',
      adjudicationWrongKey: true,
      adjudications: 1,
      status: 'admitted',
      keyStatus: 'overridden',
    },
    {
      name: 'author key rejects the blind answer',
      row: {},
      wrongAnswer: true,
      adjudication: 'pass',
      adjudications: 1,
      status: 'admitted',
      keyStatus: 'overridden',
    },
    {
      name: 'no author key (placeholder), adjudicator confirms the blind key',
      row: { reference_md: null },
      adjudication: 'pass',
      adjudications: 1,
      printed: false,
      status: 'admitted',
      keyStatus: 'matched',
    },
    {
      name: 'no author key (placeholder), adjudicator returns for repair',
      row: { reference_md: null },
      adjudications: 1,
      printed: false,
      status: 'withheld',
    },
    {
      name: 'no author key (placeholder), adjudicator fails',
      row: { reference_md: null },
      adjudication: 'fail',
      adjudications: 1,
      printed: false,
      status: 'withheld',
    },
    {
      name: 'placeholder free unit',
      row: { kind: 'short_answer', reference_md: null, choices_md: null },
      free: true,
      adjudication: 'pass',
      adjudications: 1,
      printed: false,
      status: 'withheld',
    },
    {
      name: 'printed rubric free unit',
      row: {
        kind: 'short_answer',
        reference_md: null,
        choices_md: null,
        rubric_json: { criteria: [{ id: 'c1', description: '指出控制变量', points: 2 }] },
      },
      free: true,
      adjudications: 1,
      printed: true,
      status: 'withheld',
    },
    {
      name: 'printed answer that is not an option letter',
      row: { reference_md: '答案见课本第 12 页' },
      adjudications: 1,
      printed: true,
      status: 'withheld',
    },
    {
      name: 'author key agrees but the prompt cites a missing figure',
      row: { prompt_md: '如图，哪项是受控变量？' },
      adjudication: 'pass',
      adjudications: 1,
      status: 'admitted',
      keyStatus: 'matched',
    },
  ])('single blind solve gate: $name', async (c) => {
    setTestConfig({
      [`task.${ADJUDICATION_TASK_KIND}.provider`]: 'custom:opendesign',
      [`task.${ADJUDICATION_TASK_KIND}.model`]: 'deepseek-v4.1-flash',
      [`task.${ADJUDICATION_TASK_KIND}.override_global_pin`]: true,
    });
    try {
      const seed = await seedAdmission({ row: c.row as Partial<norm.NormalizableQuestionRow> });
      const d1 = admissionJobId(seed.groupId, seed.revisionId, seed.digest, 0);
      const data = jobData(seed);
      await insertDelivery(seed, d1, data);
      const { task, calls } = fakeTaskFactory(seed, {
        free: c.free,
        adjudication: c.adjudication as 'pass' | 'fail' | undefined,
        adjudicationWrongKey: c.adjudicationWrongKey,
        successAnswers: c.wrongAnswer ? new Map([[0, seed.wrongItemId]]) : undefined,
      });
      const result = await run(testDb(), data, { id: d1, jobData: data }, { runTask: task });
      expect(calls.filter((call) => call.kind === 'QuestionAdmissionSolveTask')).toHaveLength(1);
      const adjudications = calls.filter((call) => call.kind === ADJUDICATION_TASK_KIND);
      expect(adjudications).toHaveLength(c.adjudications);
      for (const call of adjudications) {
        const payload = call.payload as {
          units: Record<string, unknown>[];
          solve: { units: Record<string, unknown>[] };
        };
        if (c.printed !== undefined) expect('printed_rule_md' in payload.units[0]).toBe(c.printed);
        expect(payload.solve.units.every((unit) => !('prior' in unit))).toBe(true);
      }
      expect(result.status).toBe(c.status);
      const [batch] = (await testDb().$client.unsafe(
        `select result_json from paid_effect where family = 'question_admission_run'`,
      )) as {
        result_json: {
          result: {
            verification: { evidence: Record<string, unknown> };
            resolved?: {
              scoring_basis: {
                units: { scoring_unit_id: string; criterion: Record<string, unknown> }[];
              };
            };
            solution_prior?: unknown;
          };
        };
      }[];
      const receiptResult = batch.result_json.result;
      const evidence = receiptResult.verification.evidence;
      if (c.adjudicationWrongKey) {
        const finalUnit = receiptResult.resolved?.scoring_basis.units.find(
          (unit) => unit.scoring_unit_id === seed.unitId,
        );
        expect(finalUnit?.criterion).toMatchObject({
          kind: 'select_key',
          accepted_item_ids: [seed.wrongItemId],
        });
        expect(receiptResult.solution_prior).toBeDefined();
      }
      if (c.adjudications > 0 && c.adjudication !== 'fail') {
        expect(evidence.adjudicator_context).toBe('same_model_as_solver');
        expect(evidence.route_role).toBe('fallback');
      } else expect(evidence.adjudicator_context).toBeUndefined();
      const prior = evidence.solution_prior as { solver_key_status?: string } | undefined;
      expect(prior?.solver_key_status).toBe(c.keyStatus);
      const anchors = (await testDb().$client.unsafe(
        `select 1 from item_calibration where question_id = '${seed.groupId}'`,
      )) as unknown[];
      expect(anchors).toHaveLength(c.keyStatus === 'matched' ? 1 : 0);
    } finally {
      resetTestConfig();
    }
  });

  // @invariant concurrency: moving to the single-solve contract never re-pays an unknown
  // send and never replays dual-solve history — a dual-solve wait is closed and its
  // publication re-enqueued under @5 (one fresh blind solve), a dual-solve delivery that
  // never started is re-enqueued the same way, an unknown dual-solve batch or a wait with
  // an unknown stage send holds without any send, and replaying the @5 delivery pays nothing
  // @fails-if a @4 wait resumes into the @5 call plan, a @5 run replays or rewrites @4
  // stage receipts, an unknown @4 send is followed by any provider call, or a replay pays twice
  it.each([
    { name: '@4 wait is closed and re-enqueued', fixture: 'waiting', requeued: true },
    { name: '@4 delivery that never started is re-enqueued', fixture: 'queued', requeued: true },
    { name: '@4 batch outcome unknown', fixture: 'unknown', requeued: false },
    { name: '@4 wait with an unknown stage send', fixture: 'stage_unknown', requeued: false },
  ])('dual-solve to single-solve: $name', async ({ fixture, requeued }) => {
    const db = testDb();
    const seed =
      fixture === 'waiting'
        ? await seedAdmission({ row: { reference_md: null, judge_kind_override: 'exact' } })
        : await seedAdmission();
    const v4 = { ...jobData(seed), admission_version: 4 as const };
    const { task, calls } = fakeTaskFactory(seed, {
      failures: new Map([
        [0, { kind: 'bound', status: 500 }],
        [1, { kind: 'bound', status: 500 }],
      ]),
    });
    let legacy: Awaited<ReturnType<typeof reserveLegacyPlaceholderAdjudication>> | null = null;
    let v4Before: Awaited<ReturnType<typeof frozenV4Rows>> = [];
    if (fixture === 'queued') {
      const d1 = admissionJobId(seed.groupId, seed.revisionId, `${seed.digest}:v4`, 0);
      await insertDelivery(seed, d1, v4);
      expect((await run(db, v4, { id: d1, jobData: v4 }, { runTask: task })).status).toBe('stale');
    } else {
      // A real waiting run, rewritten into the dual-solve rows it stands for. Its delivery
      // id is not the @5 publication job id, as the @4 job id never was.
      const d1 = admissionJobId(seed.groupId, seed.revisionId, `${seed.digest}:v4`, 0);
      const data = jobData(seed);
      await insertDelivery(seed, d1, data);
      expect((await run(db, data, { id: d1, jobData: data }, { runTask: task })).status).toBe(
        'waiting',
      );
      await downgradeToDualSolveWait(
        fixture === 'unknown' ? 'unknown' : 'waiting',
        fixture === 'stage_unknown',
      );
      if (fixture === 'waiting') {
        legacy = await reserveLegacyPlaceholderAdjudication(seed);
        v4Before = await frozenV4Rows();
      }
      bossSends.length = 0;
      const wakeId = admissionJobId(seed.groupId, seed.revisionId, `${seed.digest}:wake`, 0);
      const wake = { ...v4, recovery_confirmed: false };
      await insertDelivery(seed, wakeId, wake, { binding: false });
      await testDb().$client.unsafe(
        `update paid_effect set result_json = jsonb_set(result_json, '{recovery,retry_at}', '"2020-01-01T00:00:00.000Z"')
         where family = 'question_admission_stage' and result_json->>'kind' = 'waiting'`,
      );
      const sendsBefore = calls.length;
      const woke = await run(db, wake, { id: wakeId, jobData: wake }, { runTask: task });
      expect(woke.status).toBe(requeued ? 'stale' : 'pending');
      expect(calls.length).toBe(sendsBefore);
      if (legacy != null) {
        expect(await frozenV4Rows()).toEqual(v4Before);
      }
    }
    const successor = bossSends.find(
      (send) => (send.data as { admission_version?: number }).admission_version === 5,
    );
    if (!requeued) {
      expect(successor).toBeUndefined();
      // A fresh @5 publication delivery for the same base still holds.
      const fresh = admissionJobId(seed.groupId, seed.revisionId, `${seed.digest}:fresh`, 0);
      const data = jobData(seed);
      await insertDelivery(seed, fresh, data);
      const sendsBefore = calls.length;
      expect((await run(db, data, { id: fresh, jobData: data }, { runTask: task })).status).toBe(
        'pending',
      );
      expect(calls.length).toBe(sendsBefore);
      return;
    }
    if (!successor) throw new Error('no @5 successor delivery was enqueued');
    if (legacy != null) {
      expect(successor.data).toMatchObject({
        source_event_id: seed.publishEventId,
        admission_version: 5,
      });
    }
    const successorId = String(successor.opts.id);
    const successorData = successor.data as ReturnType<typeof jobData>;
    await insertDelivery(seed, successorId, successorData, { binding: false });
    const { task: fresh, calls: freshCalls } = fakeTaskFactory(
      seed,
      legacy != null ? { adjudication: 'pass' } : {},
    );
    const successorRun = await run(
      db,
      successorData,
      { id: successorId, jobData: successorData },
      { runTask: fresh },
    );
    expect(successorRun.status).toBe(legacy == null ? 'admitted' : 'withheld');
    if (legacy != null) {
      expect(successorRun.per_unit).toEqual([
        {
          scoring_unit_id: seed.unitId,
          status: 'withheld',
          reason: 'admission_provider_query_not_started',
        },
      ]);
    }
    expect(freshCalls.map((call) => call.kind)).toEqual(['QuestionAdmissionSolveTask']);
    const current = (await stageRows()).filter(
      (row) =>
        (row.input as { kind?: string; policy_id?: string }).kind ===
          'QuestionAdmissionSolveTask' &&
        (row.input as { policy_id?: string }).policy_id === 'question_admission@5',
    );
    expect(current.map((row) => row.unit)).toEqual(['call:0:attempt:0']);
    if (legacy != null) {
      const oldCall2 = (await stageRows()).filter(
        (row) => (row.input as { call_index?: number }).call_index === 2,
      );
      expect(oldCall2).toHaveLength(1);
      const historicalCall = oldCall2[0];
      if (!historicalCall) throw new Error('historical @4 adjudication fence disappeared');
      expect(historicalCall.input_digest).toBe(legacy.inputDigest);
      expect((historicalCall.input as { payload_digest?: string }).payload_digest).toBe(
        legacy.payloadDigest,
      );
      expect(await frozenV4Rows()).toEqual(v4Before);
    }
    expect(
      (await stageRows()).filter(
        (row) =>
          (row.input as { kind?: string; policy_id?: string }).kind ===
            'QuestionAdmissionSolveTask' &&
          (row.input as { policy_id?: string }).policy_id === 'question_admission@5',
      ),
    ).toHaveLength(1);
    const replay = await run(
      db,
      successorData,
      { id: successorId, jobData: successorData },
      { runTask: fresh },
    );
    expect(replay.status).toBe('already_verified');
    expect(freshCalls.filter((call) => call.kind === 'QuestionAdmissionSolveTask')).toHaveLength(1);
  });

  // @invariant concurrency: safe @4 history is closed exactly once — an old or wake
  // delivery repairs a lost successor enqueue, while the canonical @5 delivery closes
  // history in-transaction and itself reaches the paid claim
  // @fails-if an applied-stale @4 wait permanently blocks rediscovery, canonical @5
  // re-enqueues itself, or any @4/@5 replay issues another provider call
  it.each([
    { name: 'version 4 recovery delivery', version: 4, canonicalFirst: false },
    { name: 'version 5 wake recovery delivery', version: 5, canonicalFirst: false },
    { name: 'canonical version 5 first encounter', version: 5, canonicalFirst: true },
  ])(
    'closes dual-solve history before the current claim: $name',
    async ({ version, canonicalFirst }) => {
      const db = testDb();
      const seed = await seedAdmission();
      const sourceId = admissionJobId(seed.groupId, seed.revisionId, `${seed.digest}:source`, 0);
      const sourceData = jobData(seed);
      await insertDelivery(seed, sourceId, sourceData);
      const { task, calls } = fakeTaskFactory(seed, {
        failures: new Map([
          [0, { kind: 'bound', status: 500 }],
          [1, { kind: 'bound', status: 500 }],
        ]),
      });
      expect(
        (await run(db, sourceData, { id: sourceId, jobData: sourceData }, { runTask: task }))
          .status,
      ).toBe('waiting');
      await downgradeToDualSolveWait('waiting');
      const stageBefore = await stageRows();

      bossSends.length = 0;
      const wakeId = canonicalFirst
        ? admissionJobId(seed.groupId, seed.revisionId, seed.digest, 0)
        : admissionJobId(seed.groupId, seed.revisionId, `${seed.digest}:lost-enqueue`, 0);
      const wake = {
        ...jobData(seed),
        admission_version: version as 4 | 5,
        recovery_confirmed: false,
      };
      await insertDelivery(seed, wakeId, wake, canonicalFirst ? {} : { binding: false });
      const callsAfterWait = calls.length;
      if (canonicalFirst) {
        const firstRun = await run(db, wake, { id: wakeId, jobData: wake }, { runTask: task });
        expect(firstRun.status).toBe('admitted');
        expect(calls.length).toBe(callsAfterWait + 1);
        expect(bossSends).toHaveLength(0);
        const stagesAfter = await stageRows();
        expect(stagesAfter).toHaveLength(stageBefore.length + 1);
        const replay = await run(db, wake, { id: wakeId, jobData: wake }, { runTask: task });
        expect(replay.status).toBe('already_verified');
        expect(calls.length).toBe(callsAfterWait + 1);
        return;
      }
      bossSendError = new Error('successor enqueue lost');
      await expect(run(db, wake, { id: wakeId, jobData: wake }, { runTask: task })).rejects.toThrow(
        'successor enqueue lost',
      );
      expect(calls.length).toBe(callsAfterWait);
      const [supersededRow] = await db
        .select({ state: paid_effect.state, application: paid_effect.application_json })
        .from(paid_effect)
        .where(eq(paid_effect.unit, 'admission@4'));
      expect(supersededRow?.state).toBe('applied');
      expect(supersededRow?.application).toEqual({
        status: 'stale',
        group_id: seed.groupId,
        superseded_by_policy: 'question_admission@5',
      });

      bossSendError = undefined;
      const rediscovered = await run(db, wake, { id: wakeId, jobData: wake }, { runTask: task });
      expect(rediscovered.status).toBe('stale');
      expect(calls.length).toBe(callsAfterWait);
      const successors = bossSends.filter(
        (send) => (send.data as { admission_version?: number }).admission_version === 5,
      );
      expect(successors).toHaveLength(1);
      const successorId = String(successors[0]?.opts.id);
      const successorData = successors[0]?.data as ReturnType<typeof jobData>;
      await insertDelivery(seed, successorId, successorData, { binding: false });
      const { task: fresh, calls: freshCalls } = fakeTaskFactory(seed);
      const admitted = await run(
        db,
        successorData,
        { id: successorId, jobData: successorData },
        { runTask: fresh },
      );
      expect(admitted.status).toBe('admitted');
      expect(freshCalls.map((call) => call.kind)).toEqual(['QuestionAdmissionSolveTask']);
      const stageBeforeDigests = new Set(stageBefore.map((row) => row.input_digest));
      const stagesAfter = await stageRows();
      expect(stagesAfter.filter((row) => stageBeforeDigests.has(row.input_digest))).toHaveLength(
        stageBefore.length,
      );
      expect(stagesAfter).toHaveLength(stageBefore.length + 1);

      const replay = await run(
        db,
        successorData,
        { id: successorId, jobData: successorData },
        { runTask: fresh },
      );
      expect(replay.status).toBe('already_verified');
      expect(freshCalls).toHaveLength(1);
      expect(
        (await stageRows()).filter(
          (row) => (row.input as { policy_id?: string }).policy_id === 'question_admission@5',
        ),
      ).toHaveLength(1);
    },
  );

  // @invariant concurrency: an original pending @4 authorization translates once to
  // its exact canonical @5 delivery; the mapped effect governs retries and later revisions
  // @fails-if input/source/delivery drift or an unknown send escapes the fence, retries
  // repurchase, old paid evidence changes, or a settled mapping blocks a later revision
  it.each([
    { name: 'exact mapped input claims', allowed: true, drift: 'none' },
    { name: 'mapped wait recovers without repurchase', allowed: true, drift: 'retry' },
    { name: 'subject drift holds', allowed: false, drift: 'subject' },
    { name: 'arbitrary delivery holds', allowed: false, drift: 'delivery' },
    { name: 'different publication holds', allowed: false, drift: 'publication' },
    { name: 'original unknown send holds', allowed: false, drift: 'unknown' },
    { name: 'original sending holds', allowed: false, drift: 'sending' },
    { name: 'purged original delivery holds', allowed: false, drift: 'missing' },
  ])('legacy dual-solve authorization: $name', async ({ allowed, drift }) => {
    const db = testDb();
    const seed = await seedAdmission();
    const boundId = admissionJobId(seed.groupId, seed.revisionId, `${seed.digest}:legacy-bound`, 0);
    await seedCancelledLegacyAuthorization(seed, boundId);
    if (drift === 'subject') {
      const now = new Date();
      await db
        .insert(knowledge)
        .values({
          id: 'k-drift',
          name: 'Node',
          domain: 'math',
          created_at: now,
          updated_at: now,
        })
        .onConflictDoNothing();
      await db
        .update(question)
        .set({ knowledge_ids: ['k-drift'] })
        .where(eq(question.id, seed.groupId));
    }

    bossSends.length = 0;
    const boundData = { ...jobData(seed), admission_version: 4 as const };
    if (drift === 'publication') {
      const [publication] = await db.select().from(event).where(eq(event.id, seed.publishEventId));
      if (!publication) throw new Error('original publication missing');
      const alternateId = `pub-${createId()}`;
      await db.insert(event).values({
        id: alternateId,
        actor_kind: publication.actor_kind,
        actor_ref: publication.actor_ref,
        action: publication.action,
        subject_kind: publication.subject_kind,
        subject_id: publication.subject_id,
        outcome: publication.outcome,
        payload: publication.payload,
        ingest_at: new Date(),
      });
      await enqueuePublishedQuestionAdmission(db, {
        subscriberId: 'practice.question-admission-successor',
        subscriberVersion: 5,
        deliverySeq: '0',
        sourceEventId: alternateId,
      });
    } else {
      const oldRun = await run(db, boundData, { id: boundId, jobData: boundData });
      expect(oldRun.status).toBe('stale');
    }
    const successors = bossSends.filter(
      (send) => (send.data as { admission_version?: number }).admission_version === 5,
    );
    expect(successors).toHaveLength(1);
    const successorId =
      drift === 'delivery'
        ? admissionJobId(seed.groupId, seed.revisionId, `${seed.digest}:unbound`, 0)
        : String(successors[0]?.opts.id);
    expect(successorId).not.toBe(boundId);
    const [authorization] = await db
      .select({ boundDeliveryId: paid_effect_authorization.successor_delivery_id })
      .from(paid_effect_authorization);
    expect(authorization?.boundDeliveryId).toBe(boundId);
    const successorData = successors[0]?.data as ReturnType<typeof jobData>;
    await insertDelivery(seed, successorId, successorData, { binding: drift === 'delivery' });
    if (drift === 'missing') await fixtureBoss?.deleteJob(ADMISSION_FAMILY, boundId);
    if (drift === 'unknown' || drift === 'sending') {
      const [row] = await db
        .select()
        .from(paid_effect)
        .where(
          and(
            eq(paid_effect.unit, DUAL_SOLVE_QUESTION_ADMISSION_PAID_UNIT),
            eq(paid_effect.state, 'pending'),
          ),
        );
      if (!row) throw new Error('original authorized successor missing');
      const identity = computePaidEffectIdentity({
        family: row.family,
        entityId: row.entity_id,
        entityRevision: row.entity_revision,
        unit: row.unit,
        input: row.input_json,
      });
      await db.transaction(async (tx) => {
        const claim = await claimPaidEffectSend(tx, identity, {
          backend: 'pg-boss',
          deliveryId: boundId,
          generation: 0,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        });
        if (claim.kind !== 'claimed') throw new Error('original authorized send did not claim');
        if (drift === 'unknown')
          await markPaidEffectUnknown(tx, identity, boundId, 'unresolved original send', {
            fence: claim.fence,
          });
      });
    }
    const oldRows = () =>
      db
        .select()
        .from(paid_effect)
        .where(eq(paid_effect.unit, DUAL_SOLVE_QUESTION_ADMISSION_PAID_UNIT));
    const oldBefore = await oldRows();
    const authBefore = await db.select().from(paid_effect_authorization);
    const { task, calls } = fakeTaskFactory(
      seed,
      drift === 'retry'
        ? {
            failures: new Map([
              [0, { kind: 'bound', status: 500 }],
              [1, { kind: 'bound', status: 500 }],
            ]),
          }
        : {},
    );
    const claimed = await run(
      db,
      successorData,
      { id: successorId, jobData: successorData },
      { runTask: task },
    );
    expect(claimed.status).toBe(allowed ? (drift === 'retry' ? 'waiting' : 'admitted') : 'pending');
    if (drift === 'retry') {
      expect((await deliverWake(seed, successorData, task)).status).toBe('admitted');
    }
    const expectedCalls = drift === 'retry' ? 3 : 1;
    expect(calls).toHaveLength(allowed ? expectedCalls : 0);
    const current = await db
      .select({ unit: paid_effect.unit })
      .from(paid_effect)
      .where(eq(paid_effect.unit, QUESTION_ADMISSION_PAID_UNIT));
    expect(current).toHaveLength(allowed ? 1 : 0);
    const mappings = () =>
      db
        .select()
        .from(event)
        .where(eq(event.action, 'experimental:paid_question_admission_policy_successor_v1'));
    expect(await mappings()).toHaveLength(allowed ? 1 : 0);
    expect(await oldRows()).toEqual(oldBefore);
    expect(await db.select().from(paid_effect_authorization)).toEqual(authBefore);
    if (!allowed) return;

    const replay = await run(
      db,
      successorData,
      { id: successorId, jobData: successorData },
      { runTask: task },
    );
    expect(replay.status).toBe('already_verified');
    expect(calls).toHaveLength(expectedCalls);
    const settledMappings = await mappings();
    const [settled] = await db
      .select()
      .from(paid_effect)
      .where(eq(paid_effect.unit, QUESTION_ADMISSION_PAID_UNIT));
    expect(settled?.state).toBe('applied');
    const original = oldBefore.find((row) => row.state === 'pending');
    if (!original) throw new Error('original pending authorization missing');
    const retiredClaim = await db.transaction((tx) =>
      claimPaidEffectSend(
        tx,
        {
          family: original.family,
          entityId: original.entity_id,
          entityRevision: original.entity_revision,
          unit: original.unit,
          inputDigest: original.input_digest,
        },
        {
          backend: 'pg-boss',
          deliveryId: boundId,
          generation: 0,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      ),
    );
    expect(retiredClaim.kind).toBe('refused');

    const [lifecycle] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, seed.groupId));
    if (!lifecycle?.current_revision_id) throw new Error('settled lifecycle missing');
    const [revision] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, lifecycle.current_revision_id));
    if (!revision) throw new Error('settled revision missing');
    const structure = structuredClone(revision.structure);
    structure.parts[0].prompt_md += '\n改变坡度后再判断受控变量。';
    const layers = {
      structure,
      response_spec: revision.response_spec,
      scoring_basis: revision.scoring_basis,
      execution_plan: revision.execution_plan,
      ...(revision.presentation ? { presentation: revision.presentation } : {}),
    };
    const published = await publishQuestionGroup(db, {
      group_id: seed.groupId,
      contract: { ...layers, integrity_digest: norm.publishedContractSeal(layers).canonical },
      expectedCurrentRevision: revision.revision_id,
      expectedAdmissionGeneration: lifecycle.scoring_admission_generation,
      availability: 'general_pool',
      admission: { state: 'withheld', reason: 'unverified_rules' },
      actorRef: 'quiz_gen:persist',
      now: new Date(),
    });
    if (published.status !== 'published') throw new Error(`later revision was ${published.status}`);
    const laterSeed = {
      ...seed,
      revisionId: published.revision_id,
      digest: published.revision_digest,
      publishEventId: published.event_id,
    };
    const laterId = admissionJobId(
      seed.groupId,
      laterSeed.revisionId,
      laterSeed.digest,
      published.admission_generation,
    );
    const laterData = jobData(laterSeed, {
      expected_admission_generation: published.admission_generation,
    });
    await insertDelivery(laterSeed, laterId, laterData);
    expect(
      (await run(db, laterData, { id: laterId, jobData: laterData }, { runTask: task })).status,
    ).toBe('admitted');
    expect(calls).toHaveLength(expectedCalls + 1);
    expect(await oldRows()).toEqual(oldBefore);
    expect(await db.select().from(paid_effect_authorization)).toEqual(authBefore);
    expect(await mappings()).toEqual(settledMappings);
  });
});

describe('question admission blind solve through the real runner', () => {
  const requests: Record<string, unknown>[] = [];
  let stopServer: (() => Promise<void>) | undefined;
  beforeEach(async () => {
    await resetDb();
    requests.length = 0;
    vi.stubEnv('OPENCODE_API_KEY', 'offline-invalid-key');
    setTestConfig({
      CLAUDE_CODE_MAX_RETRIES: 0,
      'lane.global.provider': 'opencode-go',
      'lane.global.model': 'deepseek-v4.1-flash',
    });
  });
  afterEach(async () => {
    await stopServer?.();
    for (const job of ownedJobs.splice(0)) await fixtureBoss?.deleteJob(job.name, job.id);
    resetTestConfig();
    __setPiAdapterForTests(undefined);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await fixtureBoss?.stop();
    fixtureBoss = undefined;
  });

  // @invariant grading: the one blind solve the provider actually receives carries no
  // answer and no knowledge candidates, its submit tool declares the prior, and the prior
  // it returns is parsed and frozen on the published revision with step-to-prerequisite
  // links and names only — undeclared fields inside the prior are accepted by the real
  // submit tool and stripped, so they cost no extra turn
  // @fails-if the wire input leaks knowledge candidates or printed answers, the submit tool
  // hides the prior, a second solve request is sent, an undeclared prior field is refused
  // or stored, or the returned prior is lost
  it.each([
    { name: 'declared prior', prior: PRIOR },
    {
      name: 'prior with undeclared fields',
      prior: {
        ...PRIOR,
        methods_note: 'extra',
        methods: [
          { ...PRIOR.methods[0], steps: [{ ...PRIOR.methods[0].steps[0], step_note: 'extra' }] },
        ],
      },
    },
  ])('sends one blind solve and freezes the prior it returns: $name', async ({ prior }) => {
    const seed = await seedAdmission();
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      requests.push(body);
      const tools = body.tools as { function: { name: string } }[];
      const args = JSON.stringify({
        scoring_unit_id: seed.unitId,
        status: 'solved',
        answer: { kind: 'select', item_ids: [seed.correctItemId] },
        equivalent_forms: [],
        typical_wrong: [],
        prior,
      });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: unknown, finish: string | null) =>
        response.write(
          `data: ${JSON.stringify({
            id: 'offline',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta, finish_reason: finish }],
            ...(finish
              ? { usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }
              : {}),
          })}\n\n`,
        );
      chunk(
        {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'submit',
              type: 'function',
              function: { name: tools[0].function.name, arguments: args },
            },
          ],
        },
        null,
      );
      chunk({}, 'tool_calls');
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    stopServer = () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing fixture address');
    const models = await createLoomPiModels();
    const model = models.getModel('opencode-go', 'deepseek-v4.1-flash');
    if (!model) throw new Error('offline protocol model unavailable');
    vi.spyOn(models, 'getModel').mockReturnValue({
      ...model,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    });
    __setPiAdapterForTests(new PiAgentAdapter({ models, agentLoop }));

    const d1 = admissionJobId(seed.groupId, seed.revisionId, seed.digest, 0);
    const data = jobData(seed);
    await insertDelivery(seed, d1, data);
    const result = await run(testDb(), data, { id: d1, jobData: data });

    expect(result.status).toBe('admitted');
    expect(requests).toHaveLength(1);
    const user = (requests[0].messages as { role: string; content: unknown }[]).find(
      (message) => message.role === 'user',
    );
    const wire = JSON.parse(String(user?.content)) as Record<string, unknown>;
    expect(wire.mode).toBe('solve');
    expect(Object.keys(wire).sort()).toEqual(['mode', 'parts', 'units']);
    expect(JSON.stringify(wire)).not.toContain('printed_rule_md');
    const submit = (
      requests[0].tools as { function: { parameters: { properties: Record<string, unknown> } } }[]
    )[0].function.parameters;
    expect(Object.keys(submit.properties)).toContain('prior');
    const stored = await testDb()
      .select({ prior: question_solution_prior.prior })
      .from(question_solution_prior)
      .where(eq(question_solution_prior.revision_id, result.revision_id ?? ''));
    expect(stored).toHaveLength(1);
    expect(stored[0].prior).toMatchObject({
      methods: [{ steps_md: ['列出每组实验改变的量'], step_prerequisites: [0] }],
      prerequisites: [{ name_md: '控制变量法', knowledge_id: null }],
    });
    expect(JSON.stringify(stored[0].prior)).not.toMatch(/methods_note|step_note/);
  });
});

describe('question admission subject freeze', () => {
  // @invariant grading: the subject an admission freezes and sends to the solver is the domain of knowledge_ids[0], else the enrollment subject, else general; a disagreement is recorded in the frozen input, and a revision already frozen keeps its subject when knowledge changes later
  // @fails-if a conflicting enrollment subject overrides the knowledge domain or leaves no mismatch record, an enrollment-only question loses its subject, a consistent pair records a mismatch, or a replay of the same revision re-freezes under a later tag
  it.each([
    {
      name: 'enrollment subject, no knowledge',
      enrolled: 'physics',
      domain: null,
      want: 'physics',
    },
    {
      name: 'knowledge beats a conflicting enrollment subject',
      enrolled: 'physics',
      domain: 'math',
      want: 'math',
      mismatch: true,
    },
    { name: 'enrollment and knowledge agree', enrolled: 'math', domain: 'math', want: 'math' },
    { name: 'no enrollment subject, knowledge', enrolled: null, domain: 'math', want: 'math' },
    { name: 'neither', enrolled: null, domain: null, want: 'general' },
    {
      name: 'a later conflicting tag does not refreeze the same revision',
      enrolled: 'physics',
      domain: null,
      want: 'physics',
      retagTo: 'math',
    },
  ])('$name freezes $want', async ({ enrolled, domain, want, mismatch, retagTo }) => {
    await resetDb();
    const db = testDb();
    const seed = await seedAdmission();
    const now = new Date();
    const tag = async (to: string | null) => {
      if (to) {
        await db
          .insert(knowledge)
          .values({ id: `k-${to}`, name: 'Node', domain: to, created_at: now, updated_at: now })
          .onConflictDoNothing();
      }
      await db
        .update(question)
        .set({
          knowledge_ids: to ? [`k-${to}`] : [],
          metadata: enrolled ? { ingestion_enrollment: { subject_id: enrolled } } : {},
        })
        .where(eq(question.id, seed.groupId));
    };
    await tag(domain);
    const { task } = fakeTaskFactory(seed);
    const sent: Array<string | undefined> = [];
    const observed: BoundRunTaskTextFn = (kind, payload, ctx) => {
      sent.push(ctx?.subjectProfile?.id);
      return task(kind, payload, ctx);
    };
    const deliver = async (suffix: string) => {
      const id = admissionJobId(seed.groupId, seed.revisionId, `${seed.digest}${suffix}`, 0);
      const data = jobData(seed);
      await insertDelivery(seed, id, data);
      await run(db, data, { id, jobData: data }, { runTask: observed });
      for (const job of ownedJobs.splice(0)) await fixtureBoss?.deleteJob(job.name, job.id);
    };

    await deliver('');
    if (retagTo) {
      await tag(retagTo);
      await deliver(':replay');
    }

    const frozen = await db
      .select({ input: paid_effect.input_json })
      .from(paid_effect)
      .where(eq(paid_effect.family, ADMISSION_FAMILY));
    const inputs = frozen.map(
      (row) => row.input as { subject_profile: { id: string }; subject_mismatch?: unknown },
    );
    expect({
      frozen: inputs.map((input) => input.subject_profile.id),
      mismatch: inputs.map((input) => input.subject_mismatch),
      sent: [...new Set(sent)],
    }).toEqual({
      frozen: [want],
      mismatch: [
        mismatch
          ? {
              used: 'knowledge',
              enrollment: {
                subject_id: enrolled,
                source: 'metadata.ingestion_enrollment.subject_id',
              },
              knowledge: { domain, knowledge_id: `k-${domain}`, source: 'knowledge_ids[0]' },
            }
          : undefined,
      ],
      sent: [want],
    });
  });
});
