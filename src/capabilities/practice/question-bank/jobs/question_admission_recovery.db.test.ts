import { createServer } from 'node:http';
import { agentLoop } from '@earendil-works/pi-agent-core';
import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentRunError } from '@/ai/agent-run-error';
import type { ProviderTransportEvidence, RequestSendState } from '@/ai/task-result';
import { resetTestConfig, setTestConfig } from '@/core/config/store';
import { computePaidEffectIdentity } from '@/core/paid-work/protocol/paid-effect-protocol';
import { taskInputHash } from '@/core/task-input-hash';
import { ai_task_runs, paid_effect, question_solution_prior } from '@/db/schema';
import { readQuestionServing } from '@/kernel/read-models/question-serving';
import * as norm from '@/kernel/records/assessment-normalization';
import { __setPiAdapterForTests } from '@/server/ai/execution-adapter';
import { PiAgentAdapter } from '@/server/ai/pi-agent-adapter';
import { createLoomPiModels } from '@/server/ai/pi-models';
import type { BoundRunTaskTextFn } from '@/server/ai/runner-fn';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { ADJUDICATION_TASK_KIND } from '../server/admission/adjudicate';
import { ADMISSION_FAMILY, admissionJobId } from '../server/admission/enqueue';
import { runAdmissionForQuestion as run } from './question_admission_run';

const bossSends: { name: string; data: unknown; opts: Record<string, unknown> }[] = [];
vi.mock('@/server/boss/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/boss/client')>()),
  getStartedBoss: async () => ({
    send: async (name: string, data: unknown, opts: Record<string, unknown>) => {
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

function passVerdict(seed: Seeded, free: boolean) {
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
      : { decided_key: { kind: 'select', item_ids: [seed.correctItemId] } }),
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
                ? passVerdict(seed, overrides.free === true)
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

describe('question admission provider recovery', () => {
  beforeEach(async () => {
    process.env.ADMISSION_PROVIDER_RETRY_MAX_RETRIES = '1';
    process.env.ADMISSION_PROVIDER_RETRY_BASE_DELAY_MS = '0';
    await resetDb();
    bossSends.length = 0;
    return () => {
      delete process.env.ADMISSION_PROVIDER_RETRY_MAX_RETRIES;
      delete process.env.ADMISSION_PROVIDER_RETRY_BASE_DELAY_MS;
    };
  });
  afterEach(async () => {
    for (const job of ownedJobs.splice(0)) await fixtureBoss?.deleteJob(job.name, job.id);
  });
  afterAll(async () => {
    await fixtureBoss?.stop();
    fixtureBoss = undefined;
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
      )) as { result_json: { result: { verification: { evidence: Record<string, unknown> } } } }[];
      const evidence = batch.result_json.result.verification.evidence;
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
  // @fails-if a @4 wait resumes into the @5 call plan, a @5 run replays @4 stage receipts,
  // an unknown @4 send is followed by any provider call, or a replay pays twice
  it.each([
    { name: '@4 wait is closed and re-enqueued', fixture: 'waiting', requeued: true },
    { name: '@4 delivery that never started is re-enqueued', fixture: 'queued', requeued: true },
    { name: '@4 batch outcome unknown', fixture: 'unknown', requeued: false },
    { name: '@4 wait with an unknown stage send', fixture: 'stage_unknown', requeued: false },
  ])('dual-solve to single-solve: $name', async ({ fixture, requeued }) => {
    const db = testDb();
    const seed = await seedAdmission();
    const v4 = { ...jobData(seed), admission_version: 4 as const };
    const { task, calls } = fakeTaskFactory(seed, {
      failures: new Map([
        [0, { kind: 'bound', status: 500 }],
        [1, { kind: 'bound', status: 500 }],
      ]),
    });
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
    const successorId = String(successor.opts.id);
    const successorData = successor.data as ReturnType<typeof jobData>;
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
    const current = (await stageRows()).filter(
      (row) => (row.input as { policy_id?: string }).policy_id === 'question_admission@5',
    );
    expect(current.map((row) => row.unit)).toEqual(['call:0:attempt:0']);
    const replay = await run(
      db,
      successorData,
      { id: successorId, jobData: successorData },
      { runTask: fresh },
    );
    expect(replay.status).toBe('already_verified');
    expect(freshCalls).toHaveLength(1);
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
  // links and names only
  // @fails-if the wire input leaks knowledge candidates or printed answers, the submit tool
  // hides the prior, a second solve request is sent, or the returned prior is lost
  it('sends one blind solve and freezes the prior it returns', async () => {
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
        prior: PRIOR,
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
  });
});
